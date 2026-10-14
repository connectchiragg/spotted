/**
 * Ingestion as a queue-driven state machine. Each claimed step does a small
 * amount of CPU work and mostly waits on network I/O, which keeps every Worker
 * invocation inside the Free plan's 10 ms CPU limit (I/O wait is not CPU time).
 *
 *   upload      stream R2 object -> Gemini Files API (resumable upload)
 *   await_file  poll the Gemini file until ACTIVE; enforce the duration limit
 *   tag         one generateContent call on the whole video -> summary, tags, moments
 *   index       Workers AI embeddings + advisory duplicate check, then complete
 */
import { Db } from './db';
import { Settings } from './env';
import { Embedder, indexResult, possibleDuplicate } from './embeddings';
import { Gemini, geminiMimeType, parseDuration, PROMPT_VERSION, TaggerError } from './gemini';
import * as queue from './queue';
import { getJob } from './store';

export interface IngestDeps {
  db: Db;
  bucket: R2Bucket;
  gemini: Gemini;
  embedder: Embedder;
  settings: Settings;
}

export class PermanentError extends Error {}
const MAX_POLLS = 120; // 120 x 5 s = 10 min of Gemini-side processing at most.

export async function runStep(deps: IngestDeps, claimed: queue.Claimed): Promise<string> {
  const { db } = deps;
  const job = await getJob(db, claimed.request_id);
  if (!job || job.status === 'completed' || job.status === 'failed') {
    await queue.discard(db, claimed);
    return 'discarded';
  }
  try {
    switch (claimed.stage) {
      case 'upload': return await upload(deps, claimed, job);
      case 'await_file': return await awaitFile(deps, claimed);
      case 'tag': return await tag(deps, claimed);
      case 'index': return await index(deps, claimed, job);
      default: throw new PermanentError(`Unknown ingestion stage ${claimed.stage}`);
    }
  } catch (error) {
    let message = 'Unexpected processing failure';
    let retryable = true;
    if (error instanceof TaggerError) { message = error.message; retryable = error.retryable; }
    else if (error instanceof PermanentError) { message = error.message; retryable = false; }
    else console.error('ingest step failed', claimed.request_id, claimed.stage, (error as Error)?.message);
    const outcome = await queue.fail(db, claimed, message, retryable);
    if (outcome === 'failed' && claimed.state.file_name) await deps.gemini.deleteFile(claimed.state.file_name);
    return `failed:${outcome}`;
  }
}

async function upload(deps: IngestDeps, claimed: queue.Claimed, job: any) {
  const mimeType = geminiMimeType(job.content_type, job.filename);
  if (!mimeType) {
    throw new PermanentError('Unsupported video format for analysis; use MP4, MOV, WebM, AVI, MPEG, WMV, FLV or 3GP');
  }
  const object = await deps.bucket.get(job.object_key);
  if (!object) throw new PermanentError('Uploaded video is missing from storage');
  if (object.size > deps.settings.maxUploadBytes) {
    await object.body.cancel();
    throw new PermanentError('Stored video exceeds upload limit');
  }
  const file = await deps.gemini.uploadFile(object.body, object.size, mimeType, `framer-${job.id}`);
  await queue.advance(deps.db, claimed, 'await_file', { file_name: file.name, polls: 0 },
    { stage: 'Video sent for analysis', percent: 30, eta_seconds: 90 }, 5);
  return 'uploaded';
}

async function awaitFile(deps: IngestDeps, claimed: queue.Claimed) {
  const state = claimed.state;
  const file = await deps.gemini.getFile(state.file_name);
  if (file.state === 'FAILED') throw new PermanentError('Video is invalid or could not be decoded');
  if (file.state !== 'ACTIVE') {
    if ((state.polls ?? 0) >= MAX_POLLS) throw new PermanentError('Video processing by the model timed out');
    await queue.defer(deps.db, claimed, { ...state, polls: (state.polls ?? 0) + 1 }, 5,
      { stage: 'Model is preparing the video', percent: 40, eta_seconds: 60 });
    return 'waiting';
  }
  const duration = parseDuration(file.videoMetadata?.videoDuration);
  if (duration === null || duration <= 0) throw new PermanentError('File must contain a video stream with a valid duration');
  if (duration > deps.settings.maxVideoSeconds) {
    throw new PermanentError(`Video exceeds the ${deps.settings.maxVideoSeconds}-second duration limit`);
  }
  await queue.advance(deps.db, claimed, 'tag', { ...state, file_uri: file.uri, mime_type: file.mimeType, duration },
    { stage: 'Tagging key moments', percent: 55, eta_seconds: 45 });
  return 'active';
}

async function tag(deps: IngestDeps, claimed: queue.Claimed) {
  const state = claimed.state;
  const result = await deps.gemini.tagVideo({ name: state.file_name, uri: state.file_uri, mimeType: state.mime_type, state: 'ACTIVE' },
    state.duration, deps.settings.maxFrames);
  await queue.advance(deps.db, claimed, 'index', { ...state, result },
    { stage: 'Indexing for search', percent: 90, eta_seconds: 10 });
  return 'tagged';
}

async function index(deps: IngestDeps, claimed: queue.Claimed, job: any) {
  const state = claimed.state;
  const output: Record<string, any> = {
    summary: state.result.summary,
    tags: state.result.tags,
    frame_descriptions: state.result.frame_descriptions,
    duration_seconds: state.duration,
    sampled_timestamps: state.result.sampled_timestamps,
    model: deps.settings.geminiModel,
    prompt_version: PROMPT_VERSION,
    // No JPEGs are stored for Worker-ingested videos; citations seek the video instead.
    frame_indices: [],
  };
  const vector = await indexResult(deps.db, deps.embedder, job.id, output);
  try {
    output.possible_duplicate = await possibleDuplicate(deps.db, deps.embedder.model, job.id, vector, deps.settings.duplicateThreshold);
  } catch (error) {
    // Advisory metadata must not fail an otherwise tagged video.
    console.warn('duplicate check deferred', job.id, (error as Error)?.message);
  }
  const committed = await queue.complete(deps.db, claimed, output);
  if (committed && state.file_name) await deps.gemini.deleteFile(state.file_name);
  return committed ? 'completed' : 'stale';
}

/**
 * Drain due work: called by the cron trigger (all stages) and opportunistically
 * from the request path (short stages only, under ctx.waitUntil).
 */
export async function drain(deps: IngestDeps, opts: { maxSteps: number; stages?: queue.Stage[] | null; deadlineMs?: number }) {
  const outcomes: string[] = [];
  const started = Date.now();
  for (let i = 0; i < opts.maxSteps; i++) {
    if (opts.deadlineMs && Date.now() - started > opts.deadlineMs) break;
    const claimed = await queue.claim(deps.db, opts.stages ?? null);
    if (!claimed) break;
    outcomes.push(`${claimed.stage}:${await runStep(deps, claimed)}`);
  }
  return outcomes;
}
