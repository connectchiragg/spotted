/**
 * VideoDO: one Durable Object per video (`VIDEO.idFromName(video_id)`, SQLite-backed,
 * available on Workers Free). The "actor per video" pattern (owner decision):
 *
 *   - it OWNS the video's ingestion state machine in its own durable storage;
 *   - it RUNS the steps itself from its alarm:
 *       fetch      Google Photos / Drive source -> R2 (multipart; skipped if >= 100 MB)
 *       probe      duration from the MP4/MOV header (skipped if > 10 min)
 *       select     Media Transformations spritesheets -> pixel-deviation frame choice
 *       frames     the chosen frames at up to 1024 px -> R2 (also the thumbnails)
 *       transcribe Workers AI Whisper (the video directly, or 60 s M4A chunks); the first
 *                  SOUND_MAX_S of audio is kept in R2 for the summarize call's sound tags
 *       describe   Gemini on batches of frames -> one paragraph per frame
 *       summarize  Gemini on the paragraphs + transcript + that audio -> summary, tags, vocabulary
 *                  labels and sound tags (src/labels.ts)
 *       index      bge-m3 vectors (summary, transcript windows, frames) -> Vectorize
 *   - it PUSHES status to the video's viewers over hibernatable WebSockets
 *     (GET /videos/:id/ws), so an idle viewer costs no DO duration.
 *
 * A Durable Object is a single-threaded actor and alarms never overlap, so the object is
 * the lock: no lease queue, no scheduler, no cron.
 *
 * Rule: write durably before every side effect, record each external result before moving
 * on. Each try persists attempts + 1 first (so a crash loop still stops at MAX_ATTEMPTS)
 * and the side effect's idempotency key; each result is persisted the moment it returns,
 * per frame / per audio chunk / per describe batch, so a resumed step continues where it
 * stopped. The only window left is a crash between a response arriving and the write after
 * it: one repeated provider call is possible in that instant.
 *
 * Order of every commit: DO storage (the record) -> D1 `videos` row (what the API, search
 * and other readers use; guarded by state_version) -> WebSocket broadcast (a relay).
 */
import { DurableObject } from 'cloudflare:workers';
import { videoState } from './api';
import { Env, settings, Settings } from './env';
import { changeScores, Candidate, mp4Duration, Pick, selectFrames, spriteTiles, spriteWindows, tileTime } from './frames';
import { FrameDescription, Gemini, PROMPT_VERSION, Segment, Tag, TaggerError, TokenUsage } from './gemini';
import { d1TokenStore, Google, GoogleError } from './google';
import { MediaError, mediaBinding, MediaPort, Transcriber, workersAiWhisper } from './media';
import { getVideo, nowIso, Video } from './store';
import { duplicateCandidates, Embedder, indexResult, thumbKey, transcriptWindows, workersAiEmbedder } from './vectors';

export const MAX_ATTEMPTS = 5;
const MAX_QUOTA_WAIT_S = 2 * 3600; // honour RetryInfo, but re-check at least every 2 h
const QUOTA_FALLBACK_S = 15 * 60; // a 429 without RetryInfo: 15 min x waits, capped at MAX_QUOTA_WAIT_S
/**
 * Quota waits (429) do not use up MAX_ATTEMPTS; a video gives up once it has waited on quota
 * for this long. Gemini's per-day quota resets at midnight Pacific time, and Workers AI's
 * neurons at 00:00 UTC, so 48 h always spans a reset.
 */
export const MAX_QUOTA_WINDOW_MS = 48 * 3600_000;
const KEEP_EVENTS = 200;
const AUDIO_CHUNK_S = 60;
/** Seconds of soundtrack (from the start) Gemini hears for sound tags: one M4A, ~1,920 audio tokens. */
export const SOUND_MAX_S = 60;
/** Where that M4A is kept until summarize (under videos/, so the 7-day lifecycle removes it). */
export const soundKey = (videoId: string) => `videos/${videoId}/sound.m4a`;
const SPRITE_W = 64;
const SPRITE_H = 36;
const PART_BYTES = 10 * 1024 * 1024; // R2 multipart part size (min 5 MiB except the last)
const PROGRESS_BYTES = 4 * 1024 * 1024; // copy progress is reported at most every 4 MiB

export type Step = 'fetch' | 'probe' | 'select' | 'frames' | 'transcribe' | 'describe' | 'summarize' | 'index' | 'done' | 'failed' | 'skipped';
export type EventType = 'status' | 'step' | 'progress' | 'done' | 'failed' | 'skipped';
const TERMINAL: Step[] = ['done', 'failed', 'skipped'];

const STAGE: Record<Step, [string, number]> = {
  fetch: ['Copying from Google', 10], probe: ['Reading the video', 20], select: ['Finding scene changes', 30],
  frames: ['Extracting key frames', 40], transcribe: ['Transcribing speech', 55], describe: ['Describing frames', 70],
  summarize: ['Summarising', 85], index: ['Indexing for search', 95], done: ['Completed', 100], failed: ['Failed', 0], skipped: ['Skipped', 0],
};

export interface IngestState {
  video_id: string;
  version: number;
  step: Step;
  attempts: number; // attempts of the current step (persisted BEFORE each try)
  next_retry_at: number | null; // epoch ms
  /** The provider model whose quota (429) the current wait is for; a model change voids it. */
  quota_model?: string | null;
  /** Quota (429) waits so far, and when the first one started (epoch ms). Not failure attempts. */
  quota_waits?: number;
  quota_since?: number | null;
  last_error: string | null;
  /** Idempotency keys of side effects, written before the side effect: '<video_id>:<step>[:<n>]'. */
  keys: Record<string, string>;
  bytes: number | null;
  duration: number | null;
  candidates: number;
  picks: Pick[] | null;
  frames_done: number[];
  audio_chunks_done: number;
  transcribed: boolean;
  described: number; // frames described so far
  summarized: boolean;
  /** The SOUND_MAX_S M4A for sound tags: stored in R2, or none (no audio track). Absent on older states. */
  sound?: 'stored' | 'none';
  usage: { gemini_calls: number; prompt_tokens: number; output_tokens: number };
  indexed: { possible_duplicate: unknown } | null;
  /** bytes_done/bytes_total only while copying a Google source into R2 (bytes_total null if unknown). */
  progress: { stage: string; percent: number; eta_seconds: number | null; bytes_done?: number; bytes_total?: number | null } | null;
  started_at: string;
  updated_at: string;
}

export interface VideoDeps {
  db: D1Database;
  bucket: R2Bucket;
  index: VectorizeIndex;
  media: MediaPort;
  transcriber: Transcriber;
  gemini: Gemini;
  embedder: Embedder;
  google: Google | null;
  settings: Settings;
}

export class PermanentError extends Error {}
/** Over a size or duration limit: the video is marked skipped, not failed. */
export class SkipError extends Error {}
/** Thrown by test hooks to simulate an eviction: escapes the step's error handling. */
export class EvictionError extends Error {}
/** The video was purged by an admin: a step still in flight stops without writing. */
export class PurgedError extends Error {}

const backoffMs = (attempts: number) => 30_000 * attempts * attempts; // 30 s, 2 min, 4.5 min, 8 min

interface Attachment { video_id: string; subscribed: boolean }

export class VideoDO extends DurableObject<Env> {
  /** Test seams (module-level so they survive an eviction inside one isolate). */
  static testDeps = new Map<string, () => VideoDeps>();
  static testHooks = new Map<string, (point: string) => void>();

  private running = false;
  private purged = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS events (
      version INTEGER PRIMARY KEY, type TEXT NOT NULL, data TEXT NOT NULL)`);
    // Heartbeats are answered by the runtime without waking (or billing) the object.
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  // ------------------------------------------------------------ public RPC

  /**
   * Start ingestion. Idempotent: an existing state is returned unchanged (its alarm re-armed
   * if work is pending). `notBefore` (epoch ms) staggers bulk imports.
   */
  async start(videoId: string, notBefore = 0): Promise<IngestState> {
    if (await this.isPurged()) throw new PurgedError('Video was deleted');
    let state = await this.load();
    if (!state) {
      const ts = nowIso();
      const db = VideoDO.testDeps.get(videoId)?.().db ?? this.env.DB;
      const video = db ? await getVideo(db, videoId) : null;
      state = {
        video_id: videoId, version: 0, step: video?.source && video.source !== 'upload' ? 'fetch' : 'probe', attempts: 0,
        next_retry_at: notBefore > Date.now() ? notBefore : null, last_error: null, keys: {}, bytes: null, duration: null,
        candidates: 0, picks: null, frames_done: [], audio_chunks_done: 0, transcribed: false, described: 0, summarized: false,
        usage: { gemini_calls: 0, prompt_tokens: 0, output_tokens: 0 }, indexed: null,
        progress: { stage: 'Queued', percent: 5, eta_seconds: null }, started_at: ts, updated_at: ts,
      };
      state = await this.commit(state, 'status', {});
      await this.ctx.storage.setAlarm(Math.max(Date.now(), notBefore));
      return state;
    }
    if (state.video_id !== videoId) throw new Error('Video id does not match this object');
    if (!this.terminal(state) && this.staleQuotaWait(state)) {
      state = await this.save({ ...state, next_retry_at: null, quota_model: null });
      await this.ctx.storage.setAlarm(Date.now());
      return state;
    }
    if (!this.terminal(state) && (await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Math.max(Date.now(), state.next_retry_at ?? 0)); // lost alarm: re-arm
    }
    return state;
  }

  /**
   * Forget all progress and run again (a Drive file that changed, or a failed Photos pick picked
   * again). Keeps open sockets. The stored copy and its sound clip are deleted first: fetch reuses
   * an existing object, so keeping it would re-analyse the old bytes.
   */
  async restart(videoId: string, notBefore = 0): Promise<IngestState> {
    if (await this.isPurged()) throw new PurgedError('Video was deleted');
    await this.ctx.storage.deleteAlarm();
    const upload = await this.ctx.storage.get<{ key: string; uploadId: string }>('mpu');
    const bucket = VideoDO.testDeps.get(videoId)?.().bucket ?? this.env.VIDEOS;
    if (upload && bucket) await bucket.resumeMultipartUpload(upload.key, upload.uploadId).abort().catch(() => {});
    const db = VideoDO.testDeps.get(videoId)?.().db ?? this.env.DB;
    const video = db ? await getVideo(db, videoId) : null;
    if (bucket && video?.source && video.source !== 'upload') await bucket.delete([video.object_key, soundKey(videoId)]);
    await this.ctx.storage.delete(['state', 'transcript', 'descriptions', 'summary', 'mpu']);
    const old = this.ctx.storage.sql.exec('SELECT MAX(version) AS v FROM events').one().v as number | null;
    const state = await this.start(videoId, notBefore);
    if (old) await this.ctx.storage.put('state', { ...state, version: old + 1 }); // keep versions increasing for viewers
    return (await this.load())!;
  }

  private currentModel(videoId: string): string | null {
    const injected = VideoDO.testDeps.get(videoId);
    if (injected) return injected().settings.geminiModel;
    try { return settings(this.env).geminiModel; } catch { return null; }
  }

  /** A quota wait recorded for a different model than the configured one. */
  private staleQuotaWait(state: IngestState): boolean {
    if (!state.next_retry_at || state.next_retry_at <= Date.now() || !state.quota_model) return false;
    const model = this.currentModel(state.video_id);
    return Boolean(model) && state.quota_model.startsWith('gemini') && state.quota_model !== model;
  }

  /**
   * Admin purge: cancel the alarm, close sockets, delete ALL of this object's storage, and
   * keep only a tombstone so a step still awaiting a provider cannot write again and
   * start() refuses to revive the video. Idempotent.
   */
  async purge(_videoId: string): Promise<{ gemini_files_deleted: string[] }> {
    this.purged = true;
    await this.ctx.storage.deleteAlarm();
    for (const ws of this.ctx.getWebSockets()) try { ws.close(1000, 'deleted'); } catch { /* already closed */ }
    const upload = await this.ctx.storage.get<{ key: string; uploadId: string }>('mpu');
    if (upload && this.env.VIDEOS) await this.env.VIDEOS.resumeMultipartUpload(upload.key, upload.uploadId).abort().catch(() => {});
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.put('purged', nowIso());
    return { gemini_files_deleted: [] }; // frames go to Gemini inline; there are no Gemini files
  }

  /** Purge if this actor holds state but its D1 row is gone (deleted out of band). */
  async purgeIfOrphan(videoId: string): Promise<boolean> {
    if (await this.isPurged()) return false;
    const state = await this.load();
    if (!state || state.video_id !== videoId || !(await this.orphaned(videoId))) return false;
    await this.purge(videoId);
    return true;
  }

  private async orphaned(videoId: string): Promise<boolean> {
    const db = VideoDO.testDeps.get(videoId)?.().db ?? this.env.DB;
    if (!db) return false;
    try {
      return (await getVideo(db, videoId)) === null;
    } catch {
      return false; // D1 unavailable: never purge on doubt
    }
  }

  private async isPurged(): Promise<boolean> {
    if (!this.purged && (await this.ctx.storage.get('purged')) !== undefined) this.purged = true;
    return this.purged;
  }

  /** Re-embed an already-analysed video from its D1 result (index migration backfill). */
  async reindex(videoId: string): Promise<boolean> {
    const deps = this.deps(videoId);
    if (!deps) return false;
    const video = await getVideo(deps.db, videoId);
    if (!video || video.status !== 'completed' || !video.result) return false;
    await indexResult(deps.index, deps.embedder, video, video.result);
    await deps.db.prepare('UPDATE videos SET needs_index=0 WHERE id=?1').bind(videoId).run();
    return true;
  }

  async getState(): Promise<IngestState | null> {
    return this.load();
  }

  // ------------------------------------------------------------ alarm: the executor

  async alarm(): Promise<void> {
    if (this.running) return; // alarms never overlap; defensive only
    this.running = true;
    try {
      if (await this.isPurged()) return;
      let state = await this.load();
      if (state && await this.orphaned(state.video_id)) {
        await this.purge(state.video_id);
        console.log('VideoDO: purged orphaned actor', state.video_id);
        return;
      }
      while (state && !this.terminal(state)) {
        if (state.next_retry_at && state.next_retry_at > Date.now() && !this.staleQuotaWait(state)) {
          await this.ctx.storage.setAlarm(state.next_retry_at);
          return;
        }
        const deps = this.deps(state.video_id);
        if (!deps) {
          console.warn('VideoDO: ingestion bindings or GEMINI_API_KEY missing; retrying in 10 min', state.video_id);
          await this.ctx.storage.setAlarm(Date.now() + 600_000);
          return;
        }
        const next = await this.runStep(deps, state);
        if (next === 'wait') return; // the step set its own alarm
        state = next;
      }
    } catch (error) {
      if (error instanceof PurgedError) return; // deleted mid-step: nothing left to do
      throw error; // EvictionError (tests) and real crashes: the runtime retries the alarm
    } finally {
      this.running = false;
    }
  }

  /** Run one step with attempt accounting; returns the new state, or 'wait' if an alarm was set. */
  private async runStep(deps: VideoDeps, state: IngestState): Promise<IngestState | 'wait'> {
    // Durable BEFORE the side effect: this try counts even if the object is evicted mid-call.
    state = await this.save({ ...state, attempts: state.attempts + 1, next_retry_at: null, quota_model: null });
    if (state.attempts > MAX_ATTEMPTS) return this.finish(deps, state, 'failed', state.last_error ?? 'Processing exceeded the retry limit');
    try {
      switch (state.step) {
        case 'fetch': return await this.fetchSource(deps, state);
        case 'probe': return await this.probe(deps, state);
        case 'select': return await this.select(deps, state);
        case 'frames': return await this.frames(deps, state);
        case 'transcribe': return await this.transcribe(deps, state);
        case 'describe': return await this.describe(deps, state);
        case 'summarize': return await this.summarize(deps, state);
        case 'index': return await this.index(deps, state);
        default: throw new PermanentError(`Unknown step ${state.step}`);
      }
    } catch (error) {
      if (error instanceof EvictionError || error instanceof PurgedError) throw error;
      state = (await this.load()) ?? state; // keep per-item progress saved before the error
      if (error instanceof SkipError) return this.finish(deps, state, 'skipped', error.message);
      const { message, permanent, quota, retryAfter, model } = describeError(error, state, deps);
      if (quota) {
        // A rate/quota limit is not a failure: refund this try (it was counted before the call so
        // a crash loop still stops) and wait, bounded by total time on quota rather than attempts.
        const since = state.quota_since ?? Date.now();
        if (Date.now() - since >= MAX_QUOTA_WINDOW_MS) return this.finish(deps, state, 'failed', 'Provider quota stayed exhausted for 48 hours; import the video again later');
        const waits = (state.quota_waits ?? 0) + 1;
        state = { ...state, attempts: Math.max(0, state.attempts - 1), quota_waits: waits, quota_since: since };
        const delay = Math.min(retryAfter ?? Math.min(QUOTA_FALLBACK_S * waits, MAX_QUOTA_WAIT_S), MAX_QUOTA_WAIT_S) * 1000;
        return this.scheduleRetry(deps, state, message, delay, model);
      }
      if (permanent || state.attempts >= MAX_ATTEMPTS) return this.finish(deps, state, 'failed', message);
      return this.scheduleRetry(deps, state, message, backoffMs(state.attempts), null);
    }
  }

  private async scheduleRetry(deps: VideoDeps, state: IngestState, message: string, delay: number, quotaModel: string | null): Promise<'wait'> {
    const retryAt = Date.now() + delay;
    await this.commit({ ...state, next_retry_at: retryAt, last_error: message, quota_model: quotaModel,
      progress: { stage: 'Waiting to retry', percent: state.progress?.percent ?? 0, eta_seconds: Math.round(delay / 1000) } },
    'status', { retry_at: new Date(retryAt).toISOString() }, deps);
    await this.ctx.storage.setAlarm(retryAt);
    return 'wait';
  }

  private hook(state: IngestState, point: string) {
    VideoDO.testHooks.get(state.video_id)?.(point);
  }

  private key(state: IngestState, name: string): Promise<IngestState> {
    return state.keys[name] ? Promise.resolve(state) : this.save({ ...state, keys: { ...state.keys, [name]: `${state.video_id}:${name}` } });
  }

  /** Move to the next step (a visible transition). */
  private advance(deps: VideoDeps, state: IngestState, done: Step, next: Step, extra: Partial<IngestState> = {}): Promise<IngestState> {
    const [stage, percent] = STAGE[next];
    return this.commit({ ...state, ...extra, step: next, attempts: 0, last_error: null, quota_waits: 0, quota_since: null,
      progress: { stage, percent, eta_seconds: null } }, 'step', { completed: done }, deps);
  }

  private async video(deps: VideoDeps, state: IngestState): Promise<Video> {
    const video = await getVideo(deps.db, state.video_id);
    if (!video) throw new PermanentError('Video record is missing');
    return video;
  }

  // ------------------------------------------------------------ steps

  /** Google Photos / Drive -> R2, streamed through a multipart upload (never buffered whole). */
  private async fetchSource(deps: VideoDeps, state: IngestState): Promise<IngestState> {
    const video = await this.video(deps, state);
    const max = deps.settings.maxSourceBytes;
    const existing = await deps.bucket.head(video.object_key);
    if (existing) {
      if (existing.size >= max) throw new SkipError(overLimit(max));
      return this.fetched(deps, state, video, existing.size);
    }
    if (!deps.google) throw new PermanentError('Google is not configured');
    state = await this.key(state, 'fetch');
    const meta = video.source_meta ?? {};
    let response: Response;
    if (video.source === 'photos') {
      let baseUrl: string = meta.base_url;
      if (!baseUrl || (meta.base_url_expires_at && Date.parse(meta.base_url_expires_at) < Date.now())) {
        // Picker baseUrls live 60 minutes; the session can hand out fresh ones while it lasts.
        // A definitive answer (session expired or gone) means "pick again"; a transient error retries.
        const items = await deps.google.listPickedItems(meta.session_id).catch((error) => {
          if (error instanceof GoogleError && !error.retryable) return [];
          throw error;
        });
        baseUrl = items.find((i) => i.id === video.source_id)?.mediaFile.baseUrl ?? '';
        if (!baseUrl) throw new PermanentError('The Google Photos link expired; pick the video again');
      }
      response = await deps.google.downloadPhotoVideo(baseUrl);
    } else if (video.source === 'drive') {
      response = await deps.google.downloadDriveFile(video.source_id!);
    } else {
      throw new PermanentError('Uploaded video is missing from storage');
    }
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared >= max) {
      await response.body?.cancel();
      throw new SkipError(overLimit(max));
    }
    // Byte progress while copying (the "upload" the owner sees): at most one visible event per
    // PROGRESS_BYTES and second, i.e. a handful of D1 writes for a <100 MB video.
    const expected = Number.isFinite(declared) && declared > 0 ? declared : Number(video.expected_size) || null;
    let reported = 0;
    let reportedAt = 0;
    const onBytes = async (done: number) => {
      if (done - reported < PROGRESS_BYTES || Date.now() - reportedAt < 1000) return;
      reported = done;
      reportedAt = Date.now();
      const fraction = expected ? Math.min(1, done / expected) : null;
      state = await this.commit({ ...state, progress: { stage: STAGE.fetch[0], percent: STAGE.fetch[1] + (fraction === null ? 0 : Math.round(9 * fraction)),
        eta_seconds: null, bytes_done: done, bytes_total: expected } }, 'progress', {}, deps);
    };
    const size = await this.streamToR2(deps, state, video.object_key, response.body!, video.content_type || 'video/mp4', max, onBytes);
    this.hook(state, 'fetch:stored');
    return this.fetched(deps, state, video, size);
  }

  private async fetched(deps: VideoDeps, state: IngestState, video: Video, size: number): Promise<IngestState> {
    await deps.db.prepare("UPDATE videos SET uploaded=1, expected_size=?2 WHERE id=?1").bind(video.id, size).run();
    return this.advance(deps, { ...state, bytes: size }, 'fetch', 'probe');
  }

  /** Multipart upload in 10 MiB parts; aborts (and skips the video) past the size limit. */
  private async streamToR2(deps: VideoDeps, state: IngestState, key: string, body: ReadableStream<Uint8Array>, contentType: string, max: number,
    onBytes: (done: number) => Promise<void> = async () => {}): Promise<number> {
    const upload = await deps.bucket.createMultipartUpload(key, { httpMetadata: { contentType } });
    await this.ctx.storage.put('mpu', { key, uploadId: upload.uploadId });
    const parts: R2UploadedPart[] = [];
    let buffer = new Uint8Array(PART_BYTES);
    let filled = 0;
    let total = 0;
    const flush = async () => {
      if (!filled) return;
      parts.push(await upload.uploadPart(parts.length + 1, buffer.slice(0, filled)));
      filled = 0;
    };
    try {
      const reader = body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total >= max) {
          await reader.cancel();
          throw new SkipError(overLimit(max));
        }
        let offset = 0;
        while (offset < value.length) {
          const n = Math.min(value.length - offset, PART_BYTES - filled);
          buffer.set(value.subarray(offset, offset + n), filled);
          filled += n;
          offset += n;
          if (filled === PART_BYTES) {
            await flush();
            buffer = new Uint8Array(PART_BYTES);
          }
        }
        await onBytes(total);
      }
      await flush();
      if (!total) throw new PermanentError('The source file is empty');
      await upload.complete(parts);
      await this.ctx.storage.delete('mpu');
      return total;
    } catch (error) {
      await upload.abort().catch(() => {});
      await this.ctx.storage.delete('mpu');
      throw error;
    }
  }

  /** Duration from the MP4/MOV header (the moov box sits at the start or the end). */
  private async probe(deps: VideoDeps, state: IngestState): Promise<IngestState> {
    const video = await this.video(deps, state);
    const head = await deps.bucket.head(video.object_key);
    if (!head) throw new PermanentError('Stored video is missing');
    if (head.size >= deps.settings.maxSourceBytes) throw new SkipError(overLimit(deps.settings.maxSourceBytes));
    const read = async (range: R2Range) => {
      const o = await deps.bucket.get(video.object_key, { range });
      return o ? new Uint8Array(await o.arrayBuffer()) : new Uint8Array();
    };
    const window = 2 * 1024 * 1024;
    let duration = mp4Duration(await read({ offset: 0, length: Math.min(head.size, 512 * 1024) }));
    if (duration === null && head.size > 512 * 1024) duration = mp4Duration(await read({ suffix: Math.min(head.size, window) }));
    if (duration === null) {
      const hint = Number(video.source_meta?.duration_ms) / 1000;
      if (hint > 0) duration = hint;
    }
    if (duration === null || !(duration > 0)) throw new PermanentError('Could not read the video duration; use MP4 or MOV');
    if (duration > deps.settings.maxVideoSeconds) throw new SkipError(`Video is longer than ${Math.round(deps.settings.maxVideoSeconds / 60)} minutes; skipped`);
    await deps.db.prepare('UPDATE videos SET duration_seconds=?2 WHERE id=?1').bind(video.id, duration).run();
    return this.advance(deps, { ...state, bytes: head.size, duration }, 'probe', 'select');
  }

  /** Spritesheets of tiny tiles -> mean absolute difference between consecutive tiles -> picks. */
  private async select(deps: VideoDeps, state: IngestState): Promise<IngestState> {
    const video = await this.video(deps, state);
    state = await this.key(state, 'select');
    const candidates: Candidate[] = [];
    let previous: Float32Array | null = null;
    for (const w of spriteWindows(state.duration!, deps.settings.candidateInterval)) {
      const sheet = await deps.media.spritesheet(video.object_key, { ...w, width: SPRITE_W, height: SPRITE_H });
      const tiles = spriteTiles(sheet, w.count);
      changeScores(tiles, previous).forEach((score, k) => candidates.push({ t: tileTime(w, k), score }));
      previous = tiles[tiles.length - 1];
    }
    const picks = selectFrames(candidates, { maxFrames: deps.settings.maxFrames, minGap: deps.settings.minFrameGap, threshold: deps.settings.changeThreshold,
      maxGap: deps.settings.maxFrameGap, end: state.duration! })
      .map((p) => ({ ...p, t: Math.min(p.t, Math.max(0, state.duration! - 0.1)) }));
    if (!picks.length) throw new PermanentError('No frames could be read from the video');
    return this.advance(deps, { ...state, picks, candidates: candidates.length }, 'select', 'frames');
  }

  private async frames(deps: VideoDeps, state: IngestState): Promise<IngestState> {
    const video = await this.video(deps, state);
    for (const pick of state.picks!) {
      if (state.frames_done.includes(pick.index)) continue;
      state = await this.key(state, `frame:${pick.index}`);
      const jpeg = await deps.media.frame(video.object_key, { time: pick.t, maxSide: deps.settings.frameMaxSide });
      await deps.bucket.put(thumbKey(video.id, pick.index), jpeg, { httpMetadata: { contentType: 'image/jpeg' } });
      state = await this.save({ ...state, frames_done: [...state.frames_done, pick.index],
        progress: { stage: STAGE.frames[0], percent: 40 + Math.round((10 * (state.frames_done.length + 1)) / state.picks!.length), eta_seconds: null } });
      this.hook(state, 'frames:one');
    }
    return this.advance(deps, state, 'frames', 'transcribe');
  }

  /** Whisper on the video itself when small, else on 60 s M4A chunks (each recorded). */
  private async transcribe(deps: VideoDeps, state: IngestState): Promise<IngestState> {
    const video = await this.video(deps, state);
    let segments = (await this.ctx.storage.get<Segment[]>('transcript')) ?? [];
    if (!state.transcribed) {
      if (state.bytes! <= deps.settings.whisperDirectMaxBytes) {
        state = await this.key(state, 'transcribe');
        const object = await deps.bucket.get(video.object_key);
        if (!object) throw new PermanentError('Stored video is missing');
        segments = await deps.transcriber.transcribe(new Uint8Array(await object.arrayBuffer()), video.content_type?.startsWith('video/') ? video.content_type : 'video/mp4');
        await this.ctx.storage.put('transcript', segments);
      } else {
        const chunks = Math.ceil(state.duration! / AUDIO_CHUNK_S);
        for (let c = state.audio_chunks_done; c < chunks; c++) {
          state = await this.key(state, `transcribe:${c}`);
          const start = c * AUDIO_CHUNK_S;
          let audio: Uint8Array;
          try {
            audio = await deps.media.audio(video.object_key, { time: start, duration: Math.min(AUDIO_CHUNK_S, state.duration! - start) });
          } catch (error) {
            // 9412 on a video whose frames decoded fine: it has no audio track.
            if (error instanceof MediaError && /9412/.test(error.message)) break;
            throw error;
          }
          if (c === 0 && !state.sound) state = await this.keepSound(deps, state, audio);
          const part = (await deps.transcriber.transcribe(audio, 'audio/mp4')).map((s) => ({ ...s, start: s.start + start, end: s.end + start }));
          segments = [...segments, ...part];
          await this.ctx.storage.put('transcript', segments);
          state = await this.save({ ...state, audio_chunks_done: c + 1 });
        }
      }
      state = await this.save({ ...state, transcribed: true });
      this.hook(state, 'transcribe:recorded');
    }
    if (!state.sound) {
      // Small videos went to Whisper whole: cut the sound-tag audio now (one Media call).
      state = await this.key(state, 'sound');
      try {
        state = await this.keepSound(deps, state, await deps.media.audio(video.object_key, { time: 0, duration: Math.min(SOUND_MAX_S, state.duration!) }));
      } catch (error) {
        if (!(error instanceof MediaError && /9412/.test(error.message))) throw error;
        state = await this.save({ ...state, sound: 'none' }); // no audio track
      }
    }
    return this.advance(deps, state, 'transcribe', 'describe');
  }

  /** Record the sound-tag audio in R2 before anything else uses it. */
  private async keepSound(deps: VideoDeps, state: IngestState, audio: Uint8Array): Promise<IngestState> {
    await deps.bucket.put(soundKey(state.video_id), audio, { httpMetadata: { contentType: 'audio/mp4' } });
    return this.save({ ...state, sound: 'stored' });
  }

  /** Gemini on batches of frames; each batch's paragraphs are recorded before the next call. */
  private async describe(deps: VideoDeps, state: IngestState): Promise<IngestState> {
    const video = await this.video(deps, state);
    const picks = state.picks!;
    const transcript = (await this.ctx.storage.get<Segment[]>('transcript')) ?? [];
    let descriptions = (await this.ctx.storage.get<FrameDescription[]>('descriptions')) ?? [];
    while (state.described < picks.length) {
      const batch = picks.slice(state.described, state.described + deps.settings.describeBatch);
      state = await this.key(state, `describe:${state.described}`);
      const inputs = await Promise.all(batch.map(async (p) => {
        const o = await deps.bucket.get(thumbKey(video.id, p.index));
        if (!o) throw new PermanentError('A stored frame is missing');
        return { index: p.index, t: p.t, jpeg: new Uint8Array(await o.arrayBuffer()), transcript: speechNear(transcript, p.t) };
      }));
      const { descriptions: got, usage } = await deps.gemini.describeFrames(inputs, descriptions.at(-1)?.description ?? null);
      descriptions = [...descriptions, ...got];
      await this.ctx.storage.put('descriptions', descriptions); // the paid-for result, before moving on
      state = await this.save({ ...state, described: descriptions.length, usage: addUsage(state.usage, usage),
        progress: { stage: STAGE.describe[0], percent: 70 + Math.round((15 * descriptions.length) / picks.length), eta_seconds: null } });
      this.hook(state, 'describe:batch');
    }
    return this.advance(deps, state, 'describe', 'summarize');
  }

  private async summarize(deps: VideoDeps, state: IngestState): Promise<IngestState> {
    if (!state.summarized) {
      state = await this.key(state, 'summarize');
      const descriptions = (await this.ctx.storage.get<FrameDescription[]>('descriptions')) ?? [];
      const transcript = (await this.ctx.storage.get<Segment[]>('transcript')) ?? [];
      const times = new Map(state.picks!.map((p) => [p.index, p.t]));
      // The soundtrack is optional: a state from before sound tags, or an expired object, sends none.
      const sound = state.sound === 'stored' ? await deps.bucket.get(soundKey(state.video_id)) : null;
      const audio = sound ? new Uint8Array(await sound.arrayBuffer()) : null;
      const out = await deps.gemini.summarize(descriptions.map((d) => ({ ...d, t: times.get(d.frame_index) ?? 0 })), transcript, state.duration!, audio);
      await this.ctx.storage.put('summary', { summary: out.summary, tags: out.tags, labels: out.labels, sounds: out.sounds });
      state = await this.save({ ...state, summarized: true, usage: addUsage(state.usage, out.usage) });
      this.hook(state, 'summarize:recorded');
    }
    return this.advance(deps, state, 'summarize', 'index');
  }

  /** Index: idempotent by construction (Vectorize upserts deterministic ids). */
  private async index(deps: VideoDeps, state: IngestState): Promise<IngestState> {
    const video = await this.video(deps, state);
    state = await this.key(state, 'index');
    if (!state.indexed) {
      const result = await this.resultOf(deps, state);
      const vector = await indexResult(deps.index, deps.embedder, video, result);
      const possible_duplicate = await this.duplicate(deps, video.id, vector);
      state = await this.save({ ...state, indexed: { possible_duplicate } });
      this.hook(state, 'index:recorded');
    }
    return this.finish(deps, state, 'done', null);
  }

  /** The D1 result: the shape the UI and search read. */
  private async resultOf(deps: VideoDeps, state: IngestState): Promise<Record<string, any>> {
    const descriptions = (await this.ctx.storage.get<FrameDescription[]>('descriptions')) ?? [];
    const transcript = (await this.ctx.storage.get<Segment[]>('transcript')) ?? [];
    const summary = (await this.ctx.storage.get<{ summary: string; tags: Tag[]; labels?: string[]; sounds?: string[] }>('summary')) ?? { summary: '', tags: [] };
    const picks = state.picks ?? [];
    return {
      summary: summary.summary, tags: summary.tags, labels: summary.labels ?? [], sounds: summary.sounds ?? [], frame_descriptions: descriptions,
      sampled_timestamps: picks.map((p) => p.t), frame_scores: picks.map((p) => p.score), thumbs: state.frames_done.slice().sort((a, b) => a - b),
      transcript: transcript.slice(0, 2000), transcript_windows: transcriptWindows(transcript, state.duration ?? 0),
      duration_seconds: state.duration, candidates_scanned: state.candidates,
      model: deps.settings.geminiModel, transcription_model: deps.transcriber.model, embedding_model: deps.embedder.model,
      prompt_version: PROMPT_VERSION, usage: state.usage,
      ...(state.indexed ? { possible_duplicate: state.indexed.possible_duplicate } : {}),
    };
  }

  private async duplicate(deps: VideoDeps, videoId: string, vector: number[]) {
    try {
      for (const candidate of await duplicateCandidates(deps.index, vector, videoId, deps.settings.duplicateThreshold)) {
        const other = await getVideo(deps.db, candidate.id);
        if (other && other.status === 'completed' && !other.archived_at) {
          return { request_id: other.id, filename: other.filename, display_name: other.display_name, similarity: Math.round(candidate.similarity * 1e4) / 1e4 };
        }
      }
    } catch (error) {
      console.warn('duplicate check deferred', videoId, (error as Error)?.message); // advisory only
    }
    return null;
  }

  /** Terminal transition: done, failed or skipped. */
  private async finish(deps: VideoDeps, state: IngestState, step: 'done' | 'failed' | 'skipped', message: string | null): Promise<IngestState> {
    const [stage, percent] = STAGE[step];
    return this.commit({ ...state, step, attempts: 0, last_error: message, next_retry_at: null,
      progress: { stage, percent: step === 'done' ? 100 : state.progress?.percent ?? percent, eta_seconds: step === 'done' ? 0 : null } },
    step, {}, deps);
  }

  // ------------------------------------------------------------ durable state

  private terminal(state: IngestState) {
    return TERMINAL.includes(state.step);
  }

  private async load(): Promise<IngestState | null> {
    return (await this.ctx.storage.get<IngestState>('state')) ?? null;
  }

  /** Durable write without a visible transition (attempt counters, keys, recorded results). */
  private async save(state: IngestState): Promise<IngestState> {
    if (this.purged) throw new PurgedError('Video was deleted');
    const next = { ...state, version: state.version + 1, updated_at: nowIso() };
    await this.ctx.storage.put('state', next);
    return next;
  }

  /** A visible transition: DO storage, then the D1 record, then the WebSocket broadcast. */
  private async commit(state: IngestState, type: EventType, extra: Record<string, unknown>, deps?: VideoDeps): Promise<IngestState> {
    const next = await this.save(state);
    const db = deps?.db ?? this.env.DB;
    if (db) await this.syncD1(db, next, deps);
    const data = { ...(await this.snapshotOf(next, db ?? null)), ...extra };
    this.ctx.storage.sql.exec('INSERT OR REPLACE INTO events (version, type, data) VALUES (?1, ?2, ?3)', next.version, type, JSON.stringify(data));
    this.ctx.storage.sql.exec('DELETE FROM events WHERE version <= ?1', next.version - KEEP_EVENTS);
    this.broadcast({ type: 'event', seq: next.version, event: type, data }, TERMINAL.includes(next.step));
    return next;
  }

  /** Mirror the state into D1 `videos`; a write carrying an older state_version never lands. */
  private async syncD1(db: D1Database, state: IngestState, deps?: VideoDeps) {
    const status = state.step === 'done' ? 'completed' : state.step === 'failed' ? 'failed' : state.step === 'skipped' ? 'skipped'
      : state.next_retry_at || state.version <= 1 ? 'pending' : 'processing';
    const result = state.step === 'done' && deps ? JSON.stringify(await this.resultOf(deps, state)) : null;
    await db.prepare(
      `UPDATE videos SET status=?1, error=?2, attempts=MAX(attempts, ?3), progress=?4, result=COALESCE(?5, result),
         state_version=?6, updated_at=?7 WHERE id=?8 AND state_version < ?6`,
    ).bind(status, state.step === 'done' ? null : state.last_error, state.attempts,
      TERMINAL.includes(state.step) ? null : JSON.stringify({ ...state.progress, updated_at: state.updated_at }),
      result, state.version, state.updated_at, state.video_id).run();
  }

  private async snapshotOf(state: IngestState | null, db: D1Database | null, videoId?: string): Promise<Record<string, any>> {
    const id = state?.video_id ?? videoId;
    const video = db && id ? await getVideo(db, id) : null;
    const base = video ? videoState(video) : {};
    if (!state) return base;
    return { ...base, version: state.version, step: state.step, retry_at: state.next_retry_at ? new Date(state.next_retry_at).toISOString() : null };
  }

  // ------------------------------------------------------------ WebSockets (hibernatable)

  /**
   * GET /videos/:id/ws, forwarded by the API Worker (which checked the video exists and set
   * x-video-id). The socket is accepted with ctx.acceptWebSocket (hibernation API): while no
   * message arrives the object can be evicted from memory and is not billed for duration.
   * Protocol: the client sends {"type":"subscribe","last_seq":N}; the object replays stored
   * events after N, then a status snapshot, then pushes live events. Finished videos get
   * their final event and the socket closes. "ping" is answered "pong" by the runtime.
   */
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return new Response('Expected a WebSocket upgrade', { status: 426 });
    const videoId = request.headers.get('x-video-id') ?? '';
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ video_id: videoId, subscribed: false } satisfies Attachment);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    let msg: any;
    try { msg = JSON.parse(typeof message === 'string' ? message : new TextDecoder().decode(message)); } catch { return; }
    if (msg?.type !== 'subscribe') return;
    const attachment = ws.deserializeAttachment() as Attachment;
    const last = Number.isInteger(msg.last_seq) && msg.last_seq >= 0 ? msg.last_seq : null;
    const state = await this.load();
    const version = state?.version ?? 0;
    if (last !== null && last < version) {
      for (const row of this.ctx.storage.sql.exec('SELECT version, type, data FROM events WHERE version > ?1 ORDER BY version', last)) {
        ws.send(JSON.stringify({ type: 'event', seq: row.version, event: row.type, data: JSON.parse(String(row.data)), replay: true }));
      }
    }
    const snapshot = await this.snapshotOf(state, this.env.DB ?? null, attachment.video_id);
    ws.send(JSON.stringify({ type: 'event', seq: version, event: 'status', data: snapshot }));
    const status = snapshot.status;
    if (status === 'completed' || status === 'failed' || status === 'skipped') {
      ws.send(JSON.stringify({ type: 'event', seq: version, event: status === 'completed' ? 'done' : status, data: snapshot }));
      ws.close(1000, 'finished');
      return;
    }
    ws.serializeAttachment({ ...attachment, subscribed: true } satisfies Attachment);
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    try { ws.close(code === 1005 ? 1000 : code, 'closing'); } catch { /* already closed */ }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    try { ws.close(1011, 'error'); } catch { /* already closed */ }
  }

  private broadcast(payload: Record<string, unknown>, close: boolean) {
    const text = JSON.stringify(payload);
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() as Attachment | null;
      if (!a?.subscribed) continue;
      try {
        ws.send(text);
        if (close) ws.close(1000, 'finished');
      } catch { /* a closing socket */ }
    }
  }

  async socketCount(): Promise<number> {
    return this.ctx.getWebSockets().length;
  }

  // ------------------------------------------------------------ dependencies

  private deps(videoId: string): VideoDeps | null {
    const injected = VideoDO.testDeps.get(videoId);
    if (injected) return injected();
    const env = this.env;
    if (!env.DB || !env.VIDEOS || !env.VECTORIZE || !env.AI || !env.MEDIA || !env.GEMINI_API_KEY) return null;
    const config = settings(env);
    return {
      db: env.DB, bucket: env.VIDEOS, index: env.VECTORIZE, media: mediaBinding(env.MEDIA, env.VIDEOS),
      transcriber: workersAiWhisper(env.AI, config.whisperModel), gemini: new Gemini(env.GEMINI_API_KEY, config.geminiModel),
      embedder: workersAiEmbedder(env.AI, config.embeddingModel), google: googleClient(env), settings: config,
    };
  }
}

export function googleClient(env: Env): Google | null {
  if (!env.DB || !env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.TOKEN_ENC_KEY) return null;
  const origin = env.PUBLIC_ORIGIN || 'https://framer.haciensus.com';
  return new Google({ clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET, encKey: env.TOKEN_ENC_KEY,
    redirectUri: `${origin}/oauth/google/callback` }, d1TokenStore(env.DB));
}

const overLimit = (max: number) => `Skipped: over ${Math.round(max / 1e6)} MB (the frame extractor's input limit)`;

function speechNear(segments: Segment[], t: number): string {
  return segments.filter((s) => s.end >= t - 5 && s.start <= t + 5).map((s) => s.text).join(' ').slice(0, 400);
}

function addUsage(total: IngestState['usage'], usage: TokenUsage | null): IngestState['usage'] {
  return { gemini_calls: total.gemini_calls + 1, prompt_tokens: total.prompt_tokens + (usage?.promptTokenCount ?? 0),
    output_tokens: total.output_tokens + (usage?.candidatesTokenCount ?? 0) };
}

/** Classify any step error: permanent or retryable, and whether it is a provider quota (429). */
function describeError(error: unknown, state: IngestState, deps: VideoDeps) {
  if (error instanceof TaggerError) {
    return { message: error.message, permanent: !error.retryable, quota: error.quota, retryAfter: error.retryAfterSeconds, model: deps.settings.geminiModel };
  }
  if (error instanceof GoogleError) {
    return { message: error.message, permanent: !error.retryable, quota: error.quota, retryAfter: error.retryAfterSeconds, model: 'google' };
  }
  if (error instanceof MediaError) {
    const quota = Boolean((error as any).quota);
    return { message: error.message, permanent: !error.retryable, quota, retryAfter: null, model: quota ? deps.settings.whisperModel : null };
  }
  if (error instanceof PermanentError) return { message: error.message, permanent: true, quota: false, retryAfter: null, model: null };
  console.error('VideoDO step failed', state.video_id, state.step, (error as Error)?.message);
  return { message: 'Unexpected processing failure', permanent: false, quota: false, retryAfter: null, model: null };
}
