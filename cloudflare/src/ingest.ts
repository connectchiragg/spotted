/**
 * Ingestion as a chain of queue jobs. Workers cannot run FFmpeg, so the video is
 * analysed by Gemini directly; each step is mostly network wait, which keeps
 * invocations inside the Free plan's 10 ms CPU limit (I/O wait is not CPU time).
 *
 *   ingest.upload      stream the R2 object to the Gemini Files API
 *   ingest.await_file  poll until Gemini has processed it; enforce the duration limit
 *   ingest.tag         one generateContent call -> summary, tags, timestamped moments
 *   ingest.index       Workers AI embeddings -> Vectorize, duplicate check, complete
 *
 * A step finishes by enqueueing the next step and completing itself in ONE D1
 * batch, fenced by its lease_token: a consumer that lost its lease changes nothing.
 *
 * Idempotency and resume. Every external call with a cost or side effect has a
 * durable record in `step_results`, keyed by (video_id, step):
 *   upload  the Gemini file (name, uri). Uploads use a deterministic file name
 *           (geminiFileName), so a lost record is recovered by a GET, then by
 *           listing on the display name; a second upload is never started for a
 *           file that is still PROCESSING or ACTIVE.
 *   tag     the validated generateContent result and its token usage.
 * The record is written as soon as the call returns, BEFORE the fenced commit,
 * and it is NOT fenced: it states a fact about the outside world (this file
 * exists, this analysis was paid for), which stays true whoever holds the lease.
 * First writer wins (ON CONFLICT DO NOTHING). State transitions (next job,
 * video row, job completion) stay fenced. A reclaimed job therefore reads its
 * record and skips straight to the next transition.
 * Long calls run under queue.withHeartbeat, which extends the lease and aborts
 * the call if the lease is lost.
 */
import { Settings } from './env';
import { Gemini, geminiDisplayName, GeminiFile, geminiFileName, geminiMimeType, parseDuration, PROMPT_VERSION, TaggerError } from './gemini';
import * as queue from './queue';
import { QueueJob } from './queue';
import type { Waker } from './schedule';
import { getVideo, nowIso, Video } from './store';
import { duplicateCandidates, Embedder, indexResult } from './vectors';

export interface IngestDeps {
  db: D1Database;
  bucket: R2Bucket;
  index: VectorizeIndex;
  gemini: Gemini;
  embedder: Embedder;
  settings: Settings;
  /** Lease heartbeat period during long calls (tests shorten it). */
  heartbeatMs?: number;
  /** The scheduler's alarm clock: told when a step enqueues work for later. */
  waker?: Waker;
}

/** Ask the scheduler to run at `atMs`; advisory (the alarm also reschedules from D1). */
async function wake(deps: IngestDeps, atMs: number) {
  try {
    await deps.waker?.wake(atMs);
  } catch (error) {
    console.warn('scheduler wake failed', (error as Error)?.message);
  }
}

// ---------------------------------------------------------------- step records

export type Step = 'upload' | 'tag';

export async function getStep<T = any>(db: D1Database, videoId: string, step: Step): Promise<T | null> {
  const row = await db.prepare('SELECT result FROM step_results WHERE video_id=?1 AND step=?2').bind(videoId, step).first<{ result: string }>();
  return row ? JSON.parse(row.result) : null;
}

/** Record an external call's outcome once (first writer wins). Returns the stored record. */
export async function recordStep<T>(db: D1Database, job: QueueJob, videoId: string, step: Step, result: T): Promise<T> {
  await db.prepare(
    `INSERT INTO step_results (video_id, step, idempotency_key, result, job_id, created_at)
     VALUES (?1, ?2, ?1 || ':' || ?2, ?3, ?4, ?5) ON CONFLICT DO NOTHING`,
  ).bind(videoId, step, JSON.stringify(result), job.id, queue.nowSeconds()).run();
  return (await getStep<T>(db, videoId, step))!;
}

/** Drop a record whose external object is gone, so the step can redo it. */
async function forgetStep(db: D1Database, videoId: string, step: Step) {
  await db.prepare('DELETE FROM step_results WHERE video_id=?1 AND step=?2').bind(videoId, step).run();
}

const live = (file: GeminiFile | null) => Boolean(file && (file.state === 'ACTIVE' || file.state === 'PROCESSING'));

export class PermanentError extends Error {}
const MAX_POLLS = 120; // 120 x 5 s: at most ~10 min waiting for Gemini to process a file.

interface Progress { stage: string; percent: number; eta_seconds: number | null }

/** Fenced update of the video row (only applies while `job`'s lease is held). */
function videoUpdate(deps: IngestDeps, job: QueueJob, videoId: string, set: string, binds: unknown[]) {
  return deps.db.prepare(`UPDATE videos SET ${set} WHERE id=? AND ${queue.LEASE_HELD}`).bind(...binds, videoId, ...queue.leaseBinds(job));
}

function progressJson(p: Progress) {
  return JSON.stringify({ ...p, updated_at: nowIso() });
}

/** Enqueue the next step, update progress and complete this job atomically. */
async function next(deps: IngestDeps, job: QueueJob, kind: string, payload: Record<string, any>, progress: Progress, delaySeconds = 0) {
  const now = queue.nowSeconds();
  const held = await queue.commit(deps.db, [
    queue.enqueueNextStmt(deps.db, job, kind, payload, now + delaySeconds, now),
    videoUpdate(deps, job, payload.video_id, `status='processing', error=NULL, progress=?, updated_at=?`, [progressJson(progress), nowIso()]),
    queue.completeStmt(deps.db, job, now),
  ]);
  if (held) await wake(deps, (now + delaySeconds) * 1000);
  return held;
}

export async function runJob(deps: IngestDeps, job: QueueJob): Promise<string> {
  const videoId: string = job.payload.video_id;
  const video = videoId ? await getVideo(deps.db, videoId) : null;
  try {
    if (!video || video.status === 'completed' || video.status === 'failed') {
      await queue.commit(deps.db, [queue.completeStmt(deps.db, job)]);
      return 'skipped';
    }
    // The claim reclaims expired leases regardless of attempts; bound crash loops here.
    if (job.attempts > queue.MAX_ATTEMPTS) throw new PermanentError(job.last_error ?? 'Processing exceeded the retry limit');
    // Mirror the attempt count on the video for the UI.
    await videoUpdate(deps, job, videoId, `attempts=MAX(attempts, ?)`, [job.attempts]).run();
    switch (job.kind) {
      case 'ingest.upload': return await upload(deps, job, video);
      case 'ingest.await_file': return await awaitFile(deps, job);
      case 'ingest.tag': return await tag(deps, job);
      case 'ingest.index': return await indexStep(deps, job, video);
      default: throw new PermanentError(`Unknown job kind ${job.kind}`);
    }
  } catch (error) {
    if (error instanceof queue.LeaseLostError) return 'lease-lost';
    let message = 'Unexpected processing failure';
    let permanent = false;
    if (error instanceof TaggerError) { message = error.message; permanent = !error.retryable; }
    else if (error instanceof PermanentError) { message = error.message; permanent = true; }
    else console.error('ingest step failed', job.id, job.kind, (error as Error)?.message);
    const dead = permanent || job.attempts >= queue.MAX_ATTEMPTS;
    const now = queue.nowSeconds();
    const held = await queue.commit(deps.db, [
      videoUpdate(deps, job, videoId, `status=?, error=?, updated_at=?`, [dead ? 'failed' : 'pending', message, nowIso()]),
      permanent ? queue.deadStmt(deps.db, job, message, now) : queue.failStmt(deps.db, job, message, now),
    ]);
    if (held && !dead) await wake(deps, queue.retryAt(job, now) * 1000);
    if (held && dead && job.payload.file_name) await deps.gemini.deleteFile(job.payload.file_name);
    return held ? (dead ? 'dead' : 'retry') : 'lease-lost';
  }
}

/** An existing Gemini file for this video (recorded, by deterministic name, or by display name), if still usable. */
async function existingUpload(deps: IngestDeps, video: Video): Promise<GeminiFile | null> {
  const recorded = await getStep<{ name: string }>(deps.db, video.id, 'upload');
  if (recorded) {
    const file = await deps.gemini.findFile(recorded.name);
    if (live(file)) return file;
    await forgetStep(deps.db, video.id, 'upload'); // expired, deleted or FAILED: upload again
  }
  const byName = await deps.gemini.findFile(geminiFileName(video.id));
  if (live(byName)) return byName;
  if (byName) await deps.gemini.deleteFile(byName.name); // FAILED copy would block the deterministic name
  const byDisplay = await deps.gemini.findByDisplayName(geminiDisplayName(video.id));
  return live(byDisplay) ? byDisplay : null;
}

async function upload(deps: IngestDeps, job: QueueJob, video: Video) {
  const mimeType = geminiMimeType(video.content_type, video.filename);
  if (!mimeType) throw new PermanentError('Unsupported video format for analysis; use MP4, MOV, WebM, AVI, MPEG, WMV, FLV or 3GP');
  let file = await existingUpload(deps, video);
  if (!file) {
    const object = await deps.bucket.get(video.object_key);
    if (!object) throw new PermanentError('Uploaded video is missing from storage');
    if (object.size > deps.settings.maxUploadBytes) {
      await object.body.cancel();
      throw new PermanentError('Stored video exceeds upload limit');
    }
    file = await queue.withHeartbeat(deps.db, job, (signal) =>
      deps.gemini.uploadFile(object.body, object.size, mimeType, geminiDisplayName(video.id), geminiFileName(video.id), signal), deps.heartbeatMs);
  }
  const recorded = await recordStep(deps.db, job, video.id, 'upload', { name: file.name, uri: file.uri, mime_type: file.mimeType });
  const held = await next(deps, job, 'ingest.await_file', { video_id: video.id, file_name: recorded.name, polls: 0 },
    { stage: 'Video sent for analysis', percent: 30, eta_seconds: 90 }, 5);
  return held ? 'uploaded' : 'lease-lost';
}

async function awaitFile(deps: IngestDeps, job: QueueJob) {
  const payload = job.payload;
  const file = await deps.gemini.getFile(payload.file_name);
  if (file.state === 'FAILED') throw new PermanentError('Video is invalid or could not be decoded');
  if (file.state !== 'ACTIVE') {
    if ((payload.polls ?? 0) >= MAX_POLLS) throw new PermanentError('Video processing by the model timed out');
    // Not ready: a fresh poll job (does not consume this job's retry budget).
    const held = await next(deps, job, 'ingest.await_file', { ...payload, polls: (payload.polls ?? 0) + 1 },
      { stage: 'Model is preparing the video', percent: 40, eta_seconds: 60 }, 5);
    return held ? 'waiting' : 'lease-lost';
  }
  const duration = parseDuration(file.videoMetadata?.videoDuration);
  if (duration === null || duration <= 0) throw new PermanentError('File must contain a video stream with a valid duration');
  if (duration > deps.settings.maxVideoSeconds) throw new PermanentError(`Video exceeds the ${deps.settings.maxVideoSeconds}-second duration limit`);
  const held = await next(deps, job, 'ingest.tag', { video_id: payload.video_id, file_name: file.name, file_uri: file.uri, mime_type: file.mimeType, duration },
    { stage: 'Tagging key moments', percent: 55, eta_seconds: 45 });
  return held ? 'active' : 'lease-lost';
}

async function tag(deps: IngestDeps, job: QueueJob) {
  const p = job.payload;
  // Resume: a previous holder already paid for this analysis.
  if (!(await getStep(deps.db, p.video_id, 'tag'))) {
    const file = { name: p.file_name, uri: p.file_uri, mimeType: p.mime_type, state: 'ACTIVE' };
    const { result, usage } = await queue.withHeartbeat(deps.db, job, (signal) =>
      deps.gemini.tagVideo(file, p.duration, deps.settings.maxFrames, signal), deps.heartbeatMs);
    await recordStep(deps.db, job, p.video_id, 'tag', { ...result, usage });
  }
  const held = await next(deps, job, 'ingest.index', { video_id: p.video_id, file_name: p.file_name, duration: p.duration },
    { stage: 'Indexing for search', percent: 90, eta_seconds: 10 });
  return held ? 'tagged' : 'lease-lost';
}

/**
 * Index. Idempotent by construction: Vectorize upserts use deterministic ids
 * (v:/f:/d:<video id>), and the Gemini delete tolerates a missing file.
 */
async function indexStep(deps: IngestDeps, job: QueueJob, video: Video) {
  const p = job.payload;
  const tagged = (await getStep<any>(deps.db, video.id, 'tag')) ?? p.result; // p.result: jobs queued before step_results
  if (!tagged) throw new PermanentError('Analysis result is missing; upload the video again');
  const output: Record<string, any> = {
    summary: tagged.summary,
    tags: tagged.tags,
    frame_descriptions: tagged.frame_descriptions,
    duration_seconds: p.duration,
    sampled_timestamps: tagged.sampled_timestamps,
    model: deps.settings.geminiModel,
    prompt_version: PROMPT_VERSION,
    ...(tagged.usage ? { usage: tagged.usage } : {}),
    frame_indices: [], // no JPEGs for Worker-ingested videos; citations seek the video instead
  };
  const vector = await indexResult(deps.index, deps.embedder, video.id, output);
  output.possible_duplicate = await duplicate(deps, video.id, vector);
  const held = await queue.commit(deps.db, [
    videoUpdate(deps, job, video.id, `status='completed', result=?, error=NULL, progress=NULL, updated_at=?`, [JSON.stringify(output), nowIso()]),
    queue.completeStmt(deps.db, job),
  ]);
  if (held && p.file_name) await deps.gemini.deleteFile(p.file_name);
  return held ? 'completed' : 'lease-lost';
}

/** Re-embed a completed video (migration backfill or embedding-model change). */
export async function reindex(deps: IngestDeps, job: QueueJob) {
  const video = await getVideo(deps.db, job.payload.video_id);
  if (video?.status === 'completed' && video.result) await indexResult(deps.index, deps.embedder, video.id, video.result);
  return (await queue.commit(deps.db, [queue.completeStmt(deps.db, job)])) ? 'reindexed' : 'lease-lost';
}

async function duplicate(deps: IngestDeps, videoId: string, vector: number[]) {
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

/**
 * Consumer: claim and process jobs until none are due or the budget runs out.
 * Workers expose no CPU clock, so the budget is a step count plus wall time.
 */
export async function drain(deps: IngestDeps, opts: { maxSteps: number; deadlineMs?: number }) {
  const outcomes: string[] = [];
  const started = Date.now();
  for (let i = 0; i < opts.maxSteps; i++) {
    if (opts.deadlineMs && Date.now() - started > opts.deadlineMs) break;
    const job = await queue.claim(deps.db);
    if (!job) break;
    const outcome = job.kind === 'reindex' ? await reindexSafely(deps, job) : await runJob(deps, job);
    outcomes.push(`${job.kind}:${outcome}`);
  }
  return outcomes;
}

async function reindexSafely(deps: IngestDeps, job: QueueJob) {
  try {
    return await reindex(deps, job);
  } catch (error) {
    await queue.commit(deps.db, [queue.failStmt(deps.db, job, (error as Error)?.message ?? 'reindex failed')]);
    return 'retry';
  }
}
