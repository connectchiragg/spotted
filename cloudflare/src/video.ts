/**
 * VideoDO: one Durable Object per video (`VIDEO.idFromName(video_id)`, SQLite-backed,
 * available on Workers Free). The "actor per video" pattern (owner decision):
 *
 *   - it OWNS the video's ingestion state machine in its own durable storage:
 *     current step, per-step idempotency keys and recorded external results
 *     (Gemini file, tagging result + token usage, index status), attempts,
 *     next_retry_at and the last error;
 *   - it RUNS the steps itself from its alarm: upload -> await_file -> tag -> index;
 *   - it STREAMS status over SSE to the video's viewers (GET /videos/:id/events).
 *
 * A Durable Object is a single-threaded actor and alarms never overlap, so the
 * object is the lock: no lease queue, no scheduler, no cron.
 *
 * Rule: write durably before every side effect, record each external result
 * before moving on. Every step starts by persisting its attempt (so a crash loop
 * still exhausts MAX_ATTEMPTS) and the side effect's idempotency key; every
 * external result is persisted the moment it returns. After an eviction or crash
 * the alarm (at-least-once, retried by the runtime) resumes from the recorded
 * step and skips recorded side effects. The only window left is a crash between
 * an HTTP response arriving and the storage write after it: for the Gemini
 * upload, the deterministic file name closes it (409 / GET by name); for
 * generateContent, one repeated call is possible in that instant.
 *
 * Order of every commit: DO storage (the record) -> D1 `videos` row (what the
 * API, search and other readers use; guarded by state_version so a late write
 * never overwrites a newer one) -> SSE broadcast (memory only, a relay).
 */
import { DurableObject } from 'cloudflare:workers';
import { videoState } from './api';
import { Env, settings, Settings } from './env';
import { Gemini, geminiDisplayName, GeminiFile, geminiFileName, geminiMimeType, parseDuration, PROMPT_VERSION, TaggerError, TaggingResult, TokenUsage } from './gemini';
import { getVideo, nowIso, Video } from './store';
import { duplicateCandidates, Embedder, indexResult, workersAiEmbedder } from './vectors';

export const MAX_ATTEMPTS = 5;
const MAX_POLLS = 120; // 120 x 5 s: at most ~10 min waiting for Gemini to process a file
const POLL_MS = 5_000;
const MAX_QUOTA_WAIT_S = 2 * 3600; // honour Gemini's RetryInfo, but re-check at least every 2 h
const QUOTA_FALLBACK_S = 15 * 60; // a 429 without RetryInfo: 15 min x waits, capped at MAX_QUOTA_WAIT_S
/**
 * Quota waits (429) do not use up MAX_ATTEMPTS; instead a video gives up once it has been
 * waiting on quota for this long. Gemini's per-day quota resets at midnight Pacific time,
 * so 48 h always spans at least one reset.
 */
export const MAX_QUOTA_WINDOW_MS = 48 * 3600_000;
const DEFAULT_PING_MS = 15_000;
const DEFAULT_MAX_STREAM_MS = 5 * 60_000;
const RETRY_HINT_MS = 3_000;
const KEEP_EVENTS = 200;
const MAX_BACKLOG = 32;

export type Step = 'upload' | 'await_file' | 'tag' | 'index' | 'done' | 'failed';
export type EventType = 'status' | 'step' | 'progress' | 'done' | 'failed';

export interface IngestState {
  video_id: string;
  version: number;
  step: Step;
  attempts: number; // attempts of the current step (persisted BEFORE each try)
  next_retry_at: number | null; // epoch ms
  /** The Gemini model whose quota (429) the current wait is for; a model change voids that wait. */
  quota_model?: string | null;
  /** Quota (429) waits so far, and when the first one started (epoch ms). Not failure attempts. */
  quota_waits?: number;
  quota_since?: number | null;
  last_error: string | null;
  polls: number;
  /** Idempotency keys of side effects, written before the side effect: '<video_id>:<step>'. */
  keys: Partial<Record<'upload' | 'tag' | 'index', string>>;
  upload: { name: string; uri: string; mime_type: string } | null;
  file: { duration: number } | null;
  tag: (TaggingResult & { usage: TokenUsage | null }) | null;
  indexed: { possible_duplicate: unknown } | null;
  progress: { stage: string; percent: number; eta_seconds: number | null } | null;
  started_at: string;
  updated_at: string;
}

export interface VideoDeps {
  db: D1Database;
  bucket: R2Bucket;
  index: VectorizeIndex;
  gemini: Gemini;
  embedder: Embedder;
  settings: Settings;
}

export class PermanentError extends Error {}
/** Thrown by test hooks to simulate an eviction: escapes the step's error handling. */
export class EvictionError extends Error {}

const live = (file: GeminiFile | null) => Boolean(file && (file.state === 'ACTIVE' || file.state === 'PROCESSING'));
const encoder = new TextEncoder();
const frame = (id: number, type: EventType, data: unknown) => `id: ${id}\nevent: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
const backoffMs = (attempts: number) => 30_000 * attempts * attempts; // 30 s, 2 min, 4.5 min, 8 min

interface Client { writer: WritableStreamDefaultWriter<Uint8Array>; lifetime: ReturnType<typeof setTimeout> }

export class VideoDO extends DurableObject<Env> {
  /** Test seams (module-level so they survive an eviction inside one isolate). */
  static testDeps = new Map<string, () => VideoDeps>();
  static testHooks = new Map<string, (point: string) => void>();

  private clients = new Map<number, Client>();
  private nextClient = 0;
  private ping: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS events (
      version INTEGER PRIMARY KEY, type TEXT NOT NULL, data TEXT NOT NULL)`);
  }

  // ------------------------------------------------------------ public RPC

  /** Start ingestion. Idempotent: an existing state is returned unchanged (its alarm re-armed if work is pending). */
  async start(videoId: string): Promise<IngestState> {
    let state = await this.load();
    if (!state) {
      const ts = nowIso();
      state = {
        video_id: videoId, version: 0, step: 'upload', attempts: 0, next_retry_at: null, last_error: null, polls: 0,
        keys: {}, upload: null, file: null, tag: null, indexed: null,
        progress: { stage: 'Queued', percent: 5, eta_seconds: null }, started_at: ts, updated_at: ts,
      };
      state = await this.commit(state, 'status', {});
      await this.ctx.storage.setAlarm(Date.now());
      return state;
    }
    if (state.video_id !== videoId) throw new Error('Video id does not match this object');
    if (!this.terminal(state) && this.staleQuotaWait(state)) {
      // The wait was for another model's quota (GEMINI_MODEL changed since): retry now on the current one.
      state = await this.save({ ...state, next_retry_at: null, quota_model: null });
      await this.ctx.storage.setAlarm(Date.now());
      return state;
    }
    if (!this.terminal(state) && (await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Math.max(Date.now(), state.next_retry_at ?? 0)); // lost alarm: re-arm
    }
    return state;
  }

  /** The current Gemini model (test deps first), or null if unknown. */
  private currentModel(videoId: string): string | null {
    const injected = VideoDO.testDeps.get(videoId);
    if (injected) return injected().settings.geminiModel;
    try { return settings(this.env).geminiModel; } catch { return null; }
  }

  /**
   * A quota wait recorded for a different model than the configured one. States written
   * before quota_model existed have it undefined: their quota error is treated as stale too.
   */
  private staleQuotaWait(state: IngestState): boolean {
    if (!state.next_retry_at || state.next_retry_at <= Date.now()) return false;
    const model = this.currentModel(state.video_id);
    if (!model) return false;
    if (state.quota_model === undefined) return /quota/i.test(state.last_error ?? '');
    return state.quota_model !== null && state.quota_model !== model;
  }

  /** Re-embed an imported, already-analysed video from its D1 result (migration backfill). */
  async reindex(videoId: string): Promise<boolean> {
    const deps = this.deps(videoId);
    if (!deps) return false;
    const video = await getVideo(deps.db, videoId);
    if (!video || video.status !== 'completed' || !video.result) return false;
    await indexResult(deps.index, deps.embedder, videoId, video.result);
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
      let state = await this.load();
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
      if (error instanceof EvictionError) throw error; // simulated crash: let the runtime retry the alarm
      throw error;
    } finally {
      this.running = false;
    }
  }

  /** Run one step with attempt accounting; returns the new state, or 'wait' if an alarm was set. */
  private async runStep(deps: VideoDeps, state: IngestState): Promise<IngestState | 'wait'> {
    // Durable BEFORE the side effect: this try counts even if the object is evicted mid-call.
    state = await this.save({ ...state, attempts: state.attempts + 1, next_retry_at: null, quota_model: null });
    if (state.attempts > MAX_ATTEMPTS) return this.fail(deps, state, state.last_error ?? 'Processing exceeded the retry limit');
    try {
      switch (state.step) {
        case 'upload': return await this.upload(deps, state);
        case 'await_file': return await this.awaitFile(deps, state);
        case 'tag': return await this.tag(deps, state);
        case 'index': return await this.index(deps, state);
        default: throw new PermanentError(`Unknown step ${state.step}`);
      }
    } catch (error) {
      if (error instanceof EvictionError) throw error;
      let message = 'Unexpected processing failure';
      let permanent = false;
      let retryAfter: number | null = null;
      if (error instanceof TaggerError) { message = error.message; permanent = !error.retryable; retryAfter = error.retryAfterSeconds; }
      else if (error instanceof PermanentError) { message = error.message; permanent = true; }
      else console.error('VideoDO step failed', state.video_id, state.step, (error as Error)?.message);
      const quota = error instanceof TaggerError && error.quota;
      if (quota) {
        // A rate/quota limit is not a failure: refund this try (it was counted before the call so a
        // crash loop still stops) and wait, bounded by total time on quota rather than by attempts.
        const since = state.quota_since ?? Date.now();
        if (Date.now() - since >= MAX_QUOTA_WINDOW_MS) return this.fail(deps, state, 'Gemini quota stayed exhausted for 48 hours; upload the video again later');
        const waits = (state.quota_waits ?? 0) + 1;
        state = { ...state, attempts: Math.max(0, state.attempts - 1), quota_waits: waits, quota_since: since };
        retryAfter ??= Math.min(QUOTA_FALLBACK_S * waits, MAX_QUOTA_WAIT_S);
      } else if (permanent || state.attempts >= MAX_ATTEMPTS) return this.fail(deps, state, message);
      const delay = quota ? Math.min(retryAfter!, MAX_QUOTA_WAIT_S) * 1000 : backoffMs(state.attempts);
      const retryAt = Date.now() + delay;
      await this.commit({ ...state, next_retry_at: retryAt, last_error: message,
        quota_model: quota ? deps.settings.geminiModel : null,
        progress: { stage: 'Waiting to retry', percent: state.progress?.percent ?? 0, eta_seconds: Math.round(delay / 1000) } },
      'status', { retry_at: new Date(retryAt).toISOString() }, deps);
      await this.ctx.storage.setAlarm(retryAt);
      return 'wait';
    }
  }

  private hook(state: IngestState, point: string) {
    VideoDO.testHooks.get(state.video_id)?.(point);
  }

  private async upload(deps: VideoDeps, state: IngestState): Promise<IngestState> {
    const video = await getVideo(deps.db, state.video_id);
    if (!video) throw new PermanentError('Video record is missing');
    const mimeType = geminiMimeType(video.content_type, video.filename);
    if (!mimeType) throw new PermanentError('Unsupported video format for analysis; use MP4, MOV, WebM, AVI, MPEG, WMV, FLV or 3GP');
    const name = geminiFileName(video.id);
    // Idempotency key durable before the side effect.
    state = await this.save({ ...state, keys: { ...state.keys, upload: `${video.id}:upload` } });
    let file = await this.existingUpload(deps, state, video);
    if (!file) {
      const object = await deps.bucket.get(video.object_key);
      if (!object) throw new PermanentError('Uploaded video is missing from storage');
      if (object.size > deps.settings.maxUploadBytes) {
        await object.body.cancel();
        throw new PermanentError('Stored video exceeds upload limit');
      }
      file = await deps.gemini.uploadFile(object.body, object.size, mimeType, geminiDisplayName(video.id), name);
    }
    this.hook(state, 'upload:returned'); // crash here: the deterministic name finds the file
    state = await this.commit({ ...state, upload: { name: file.name, uri: file.uri, mime_type: file.mimeType },
      step: 'await_file', attempts: 0, polls: 0, last_error: null,
      progress: { stage: 'Video sent for analysis', percent: 30, eta_seconds: 90 } }, 'step', { completed: 'upload' }, deps);
    this.hook(state, 'upload:recorded');
    return state;
  }

  /** A usable Gemini file for this video: recorded, by deterministic name, or by display name. */
  private async existingUpload(deps: VideoDeps, state: IngestState, video: Video): Promise<GeminiFile | null> {
    if (state.upload) {
      const file = await deps.gemini.findFile(state.upload.name);
      if (live(file)) return file;
    }
    const byName = await deps.gemini.findFile(geminiFileName(video.id));
    if (live(byName)) return byName;
    if (byName) await deps.gemini.deleteFile(byName.name); // a FAILED copy would block the name
    const byDisplay = await deps.gemini.findByDisplayName(geminiDisplayName(video.id));
    return live(byDisplay) ? byDisplay : null;
  }

  private async awaitFile(deps: VideoDeps, state: IngestState): Promise<IngestState | 'wait'> {
    const file = await deps.gemini.findFile(state.upload!.name);
    if (!file) {
      // Expired or deleted (Gemini keeps files 48 h): go back and upload again.
      return this.commit({ ...state, upload: null, step: 'upload', attempts: 0, last_error: null }, 'progress', {}, deps);
    }
    if (file.state === 'FAILED') throw new PermanentError('Video is invalid or could not be decoded');
    if (file.state !== 'ACTIVE') {
      if (state.polls >= MAX_POLLS) throw new PermanentError('Video processing by the model timed out');
      // Waiting is not a failed attempt.
      await this.commit({ ...state, polls: state.polls + 1, attempts: 0,
        progress: { stage: 'Model is preparing the video', percent: 40, eta_seconds: 60 } }, 'progress', {}, deps);
      await this.ctx.storage.setAlarm(Date.now() + POLL_MS);
      return 'wait';
    }
    const duration = parseDuration(file.videoMetadata?.videoDuration);
    if (duration === null || duration <= 0) throw new PermanentError('File must contain a video stream with a valid duration');
    if (duration > deps.settings.maxVideoSeconds) throw new PermanentError(`Video exceeds the ${deps.settings.maxVideoSeconds}-second duration limit`);
    state = await this.commit({ ...state, file: { duration }, upload: { name: file.name, uri: file.uri, mime_type: file.mimeType },
      step: 'tag', attempts: 0, last_error: null, progress: { stage: 'Tagging key moments', percent: 55, eta_seconds: 45 } },
    'step', { completed: 'await_file' }, deps);
    this.hook(state, 'await_file:recorded');
    return state;
  }

  private async tag(deps: VideoDeps, state: IngestState): Promise<IngestState> {
    if (!state.tag) {
      state = await this.save({ ...state, keys: { ...state.keys, tag: `${state.video_id}:tag` } }); // before the side effect
      const file = { name: state.upload!.name, uri: state.upload!.uri, mimeType: state.upload!.mime_type, state: 'ACTIVE' };
      const { result, usage } = await deps.gemini.tagVideo(file, state.file!.duration, deps.settings.maxFrames);
      // Record the paid-for result the moment it returns, before moving on.
      state = await this.save({ ...state, tag: { ...result, usage } });
      this.hook(state, 'tag:recorded');
    }
    state = await this.commit({ ...state, step: 'index', attempts: 0, last_error: null,
      progress: { stage: 'Indexing for search', percent: 90, eta_seconds: 10 } }, 'step', { completed: 'tag' }, deps);
    this.hook(state, 'tag:committed');
    return state;
  }

  /** Index: idempotent by construction (Vectorize upserts deterministic ids; Gemini delete tolerates 404). */
  private async index(deps: VideoDeps, state: IngestState): Promise<IngestState> {
    const video = await getVideo(deps.db, state.video_id);
    if (!video) throw new PermanentError('Video record is missing');
    state = await this.save({ ...state, keys: { ...state.keys, index: `${state.video_id}:index` } });
    const output = this.resultOf(deps, state);
    if (!state.indexed) {
      const vector = await indexResult(deps.index, deps.embedder, video.id, output);
      const possible_duplicate = await this.duplicate(deps, video.id, vector);
      state = await this.save({ ...state, indexed: { possible_duplicate } });
      this.hook(state, 'index:recorded');
    }
    state = await this.commit({ ...state, step: 'done', attempts: 0, last_error: null, next_retry_at: null,
      progress: { stage: 'Completed', percent: 100, eta_seconds: 0 } }, 'done', {}, deps);
    if (state.upload) await deps.gemini.deleteFile(state.upload.name);
    return state;
  }

  private resultOf(deps: VideoDeps, state: IngestState): Record<string, any> {
    const t = state.tag!;
    return {
      summary: t.summary, tags: t.tags, frame_descriptions: t.frame_descriptions, duration_seconds: state.file!.duration,
      sampled_timestamps: t.sampled_timestamps, model: deps.settings.geminiModel, prompt_version: PROMPT_VERSION,
      frame_indices: [], ...(t.usage ? { usage: t.usage } : {}),
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

  private async fail(deps: VideoDeps, state: IngestState, message: string): Promise<IngestState> {
    state = await this.commit({ ...state, step: 'failed', last_error: message, next_retry_at: null,
      progress: { stage: 'Failed', percent: state.progress?.percent ?? 0, eta_seconds: null } }, 'failed', {}, deps);
    if (state.upload) await deps.gemini.deleteFile(state.upload.name);
    return state;
  }

  // ------------------------------------------------------------ durable state

  private terminal(state: IngestState) {
    return state.step === 'done' || state.step === 'failed';
  }

  private async load(): Promise<IngestState | null> {
    return (await this.ctx.storage.get<IngestState>('state')) ?? null;
  }

  /** Durable write without a visible transition (attempt counters, keys, recorded results). */
  private async save(state: IngestState): Promise<IngestState> {
    const next = { ...state, version: state.version + 1, updated_at: nowIso() };
    await this.ctx.storage.put('state', next);
    return next;
  }

  /** A visible transition: DO storage, then the D1 record, then SSE. */
  private async commit(state: IngestState, type: EventType, extra: Record<string, unknown>, deps?: VideoDeps): Promise<IngestState> {
    const next = await this.save(state);
    const db = deps?.db ?? this.env.DB;
    if (db) await this.syncD1(db, next, deps);
    const data = { ...(await this.snapshotOf(next, db ?? null)), ...extra };
    this.ctx.storage.sql.exec('INSERT OR REPLACE INTO events (version, type, data) VALUES (?1, ?2, ?3)', next.version, type, JSON.stringify(data));
    this.ctx.storage.sql.exec('DELETE FROM events WHERE version <= ?1', next.version - KEEP_EVENTS);
    this.broadcast(frame(next.version, type, data));
    if (type === 'done' || type === 'failed') for (const id of [...this.clients.keys()]) this.drop(id, true);
    return next;
  }

  /** Mirror the state into D1 `videos`; a write carrying an older state_version never lands. */
  private async syncD1(db: D1Database, state: IngestState, deps?: VideoDeps) {
    const status = state.step === 'done' ? 'completed' : state.step === 'failed' ? 'failed'
      : state.next_retry_at || state.version <= 1 ? 'pending' : 'processing';
    const result = state.step === 'done' && deps ? JSON.stringify(this.resultOf(deps, state)) : null;
    await db.prepare(
      `UPDATE videos SET status=?1, error=?2, attempts=MAX(attempts, ?3), progress=?4, result=COALESCE(?5, result),
         state_version=?6, updated_at=?7 WHERE id=?8 AND state_version < ?6`,
    ).bind(status, state.step === 'done' ? null : state.last_error, state.attempts,
      state.step === 'done' ? null : JSON.stringify({ ...state.progress, updated_at: state.updated_at }),
      result, state.version, state.updated_at, state.video_id).run();
  }

  private async snapshotOf(state: IngestState | null, db: D1Database | null, fallback?: Record<string, any>): Promise<Record<string, any>> {
    const video = db && state ? await getVideo(db, state.video_id) : null;
    const base = video ? videoState(video) : fallback ?? {};
    if (!state) return base;
    return { ...base, version: state.version, step: state.step, retry_at: state.next_retry_at ? new Date(state.next_retry_at).toISOString() : null };
  }

  // ------------------------------------------------------------ SSE

  private get pingMs() { return Number(this.env.SSE_PING_MS) || DEFAULT_PING_MS; }
  private get maxStreamMs() { return Number(this.env.SSE_MAX_STREAM_MS) || DEFAULT_MAX_STREAM_MS; }

  /** GET /videos/:id/events, forwarded by the API Worker with the D1 snapshot as body. */
  async fetch(request: Request): Promise<Response> {
    const fallback = await request.json<Record<string, any>>();
    const state = await this.load();
    const lastHeader = request.headers.get('last-event-id');
    const last = lastHeader !== null && /^\d+$/.test(lastHeader) ? Number(lastHeader) : null;
    const version = state?.version ?? 0;
    let out = `retry: ${RETRY_HINT_MS}\n\n`;
    if (last !== null && last < version) {
      for (const row of this.ctx.storage.sql.exec('SELECT version, type, data FROM events WHERE version > ?1 ORDER BY version', last)) {
        out += `id: ${row.version}\nevent: ${row.type}\ndata: ${row.data}\n\n`;
      }
    }
    const snapshot = state ? await this.snapshotOf(state, this.env.DB ?? null, fallback) : fallback;
    out += frame(version, 'status', snapshot);
    const terminal = snapshot.status === 'completed' ? 'done' : snapshot.status === 'failed' ? 'failed' : null;
    if (terminal) out += frame(version, terminal, snapshot);
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    writer.write(encoder.encode(out)).catch(() => {});
    if (terminal) {
      writer.close().catch(() => {}); // finished videos hold no connections
    } else {
      const id = ++this.nextClient;
      this.clients.set(id, { writer, lifetime: setTimeout(() => this.drop(id, true), this.maxStreamMs) });
      writer.closed.catch(() => this.drop(id, false));
      request.signal?.addEventListener('abort', () => this.drop(id, false));
      if (!this.ping) this.ping = setInterval(() => this.broadcast(': ping\n\n'), this.pingMs);
    }
    return new Response(readable, { headers: {
      'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Accel-Buffering': 'no',
    } });
  }

  /** Never awaits writes (a write resolves only when that client reads); stalled clients are dropped. */
  private broadcast(text: string) {
    const bytes = encoder.encode(text);
    for (const [id, c] of this.clients) {
      if ((c.writer.desiredSize ?? 0) < -MAX_BACKLOG) { this.drop(id, false); continue; }
      c.writer.write(bytes).catch(() => this.drop(id, false));
    }
  }

  private drop(id: number, close: boolean) {
    const client = this.clients.get(id);
    if (!client) return;
    this.clients.delete(id);
    clearTimeout(client.lifetime);
    if (close) client.writer.close().catch(() => {});
    else client.writer.abort().catch(() => {});
    if (!this.clients.size && this.ping) { clearInterval(this.ping); this.ping = null; }
  }

  async clientCount(): Promise<number> {
    return this.clients.size;
  }

  // ------------------------------------------------------------ dependencies

  private deps(videoId: string): VideoDeps | null {
    const injected = VideoDO.testDeps.get(videoId);
    if (injected) return injected();
    const env = this.env;
    if (!env.DB || !env.VIDEOS || !env.VECTORIZE || !env.AI || !env.GEMINI_API_KEY) return null;
    const config = settings(env);
    return { db: env.DB, bucket: env.VIDEOS, index: env.VECTORIZE, gemini: new Gemini(env.GEMINI_API_KEY, config.geminiModel),
      embedder: workersAiEmbedder(env.AI, config.embeddingModel), settings: config };
  }
}

