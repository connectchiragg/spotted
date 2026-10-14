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
 */
import { Settings } from './env';
import { Gemini, geminiMimeType, parseDuration, PROMPT_VERSION, TaggerError } from './gemini';
import * as queue from './queue';
import { QueueJob } from './queue';
import { getVideo, nowIso, Video } from './store';
import { duplicateCandidates, Embedder, indexResult } from './vectors';

export interface IngestDeps {
  db: D1Database;
  bucket: R2Bucket;
  index: VectorizeIndex;
  gemini: Gemini;
  embedder: Embedder;
  settings: Settings;
}

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
  return queue.commit(deps.db, [
    queue.enqueueNextStmt(deps.db, job, kind, payload, now + delaySeconds, now),
    videoUpdate(deps, job, payload.video_id, `status='processing', error=NULL, progress=?, updated_at=?`, [progressJson(progress), nowIso()]),
    queue.completeStmt(deps.db, job, now),
  ]);
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
    let message = 'Unexpected processing failure';
    let permanent = false;
    if (error instanceof TaggerError) { message = error.message; permanent = !error.retryable; }
    else if (error instanceof PermanentError) { message = error.message; permanent = true; }
    else console.error('ingest step failed', job.id, job.kind, (error as Error)?.message);
    const dead = permanent || job.attempts >= queue.MAX_ATTEMPTS;
    const held = await queue.commit(deps.db, [
      videoUpdate(deps, job, videoId, `status=?, error=?, updated_at=?`, [dead ? 'failed' : 'pending', message, nowIso()]),
      permanent ? queue.deadStmt(deps.db, job, message) : queue.failStmt(deps.db, job, message),
    ]);
    if (held && dead && job.payload.file_name) await deps.gemini.deleteFile(job.payload.file_name);
    return held ? (dead ? 'dead' : 'retry') : 'lease-lost';
  }
}

async function upload(deps: IngestDeps, job: QueueJob, video: Video) {
  const mimeType = geminiMimeType(video.content_type, video.filename);
  if (!mimeType) throw new PermanentError('Unsupported video format for analysis; use MP4, MOV, WebM, AVI, MPEG, WMV, FLV or 3GP');
  const object = await deps.bucket.get(video.object_key);
  if (!object) throw new PermanentError('Uploaded video is missing from storage');
  if (object.size > deps.settings.maxUploadBytes) {
    await object.body.cancel();
    throw new PermanentError('Stored video exceeds upload limit');
  }
  const file = await deps.gemini.uploadFile(object.body, object.size, mimeType, `framer-${video.id}`);
  const held = await next(deps, job, 'ingest.await_file', { video_id: video.id, file_name: file.name, polls: 0 },
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
  const result = await deps.gemini.tagVideo({ name: p.file_name, uri: p.file_uri, mimeType: p.mime_type, state: 'ACTIVE' }, p.duration, deps.settings.maxFrames);
  const held = await next(deps, job, 'ingest.index', { video_id: p.video_id, file_name: p.file_name, duration: p.duration, result },
    { stage: 'Indexing for search', percent: 90, eta_seconds: 10 });
  return held ? 'tagged' : 'lease-lost';
}

async function indexStep(deps: IngestDeps, job: QueueJob, video: Video) {
  const p = job.payload;
  const output: Record<string, any> = {
    summary: p.result.summary,
    tags: p.result.tags,
    frame_descriptions: p.result.frame_descriptions,
    duration_seconds: p.duration,
    sampled_timestamps: p.result.sampled_timestamps,
    model: deps.settings.geminiModel,
    prompt_version: PROMPT_VERSION,
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
