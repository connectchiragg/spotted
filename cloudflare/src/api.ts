/**
 * HTTP API: the same routes and response shapes as the FastAPI app (app/*.py),
 * so the existing UI works unchanged apart from citation thumbnails.
 */
import { Settings } from './env';
import { Gemini, validateAnswer } from './gemini';
import { hybridSearch, normalizeQuery } from './retrieval';
import { Presigner } from './storage';
import * as store from './store';
import { Video as Job } from './store';
import { Embedder } from './vectors';
import { hasDueJobs, Waker } from './schedule';
import type { Notifier } from './notify';

export interface AppDeps {
  db: D1Database | null;
  bucket: R2Bucket | null;
  index: VectorizeIndex | null;
  presigner: Presigner | null;
  gemini: Gemini | null;
  embedder: Embedder | null;
  settings: Settings;
  geminiConfigured: boolean;
  assets?: Fetcher;
  /** FramerScheduler stub; null when the binding is absent (tests, smoke). */
  scheduler?: Waker | null;
  /** VideoEvents namespace (SSE) and the publisher for committed state changes. */
  events?: DurableObjectNamespace | null;
  notify?: Notifier;
  waitUntil(promise: Promise<unknown>): void;
}

export class HttpError extends Error {
  constructor(public status: number, public detail: unknown) {
    super(typeof detail === 'string' ? detail : 'error');
  }
}

const SECURITY_HEADERS = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' };
export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { ...SECURITY_HEADERS, ...headers } });

const DOWNLOAD_TTL = 86400;

function need<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) throw new HttpError(503, message);
  return value;
}

// ---------------------------------------------------------------- presentation

export function progressOf(job: Job): Record<string, any> {
  let progress: Record<string, any> = { ...(job.progress ?? {}) };
  if (job.status === 'completed') progress = { ...progress, stage: 'Completed', percent: 100, eta_seconds: 0, updated_at: job.updated_at };
  else if (job.status === 'failed') progress = { ...progress, stage: 'Failed', percent: progress.percent ?? 0, eta_seconds: null, updated_at: job.updated_at };
  else if (job.status === 'pending' || job.status === 'uploading') {
    progress = { stage: job.status === 'pending' ? 'Queued' : 'Uploading', percent: 0, eta_seconds: null, updated_at: job.updated_at };
  } else if (!Object.keys(progress).length) progress = { stage: 'Processing', percent: 0, eta_seconds: null, updated_at: job.updated_at };
  return progress;
}

/** The status fields of a video, as pushed in SSE events (no presigned URLs, no result body). */
export function videoState(job: Job): Record<string, any> {
  return {
    id: job.id, filename: job.filename, display_name: job.display_name ?? null, status: job.status, error: job.error,
    attempts: job.attempts, created_at: job.created_at, updated_at: job.updated_at, archived_at: job.archived_at ?? null,
    possible_duplicate: job.result?.possible_duplicate ?? null, progress: progressOf(job),
  };
}

export async function present(job: Job, presigner: Presigner | null): Promise<Record<string, any>> {
  const result: Record<string, any> = {};
  for (const k of ['id', 'filename', 'status', 'created_at', 'updated_at', 'error', 'attempts', 'result']) result[k] = job[k];
  result.display_name = job.display_name ?? null;
  result.archived_at = job.archived_at ?? null;
  result.possible_duplicate = job.result?.possible_duplicate ?? null;
  result.progress = progressOf(job);
  result.download_url = null;
  result.download_url_expires_at = null;
  if (job.uploaded) {
    if (!presigner) {
      result.download_error = 'Preview link temporarily unavailable';
    } else {
      result.download_url = await presigner.getUrl(job.object_key, DOWNLOAD_TTL);
      result.download_url_expires_at = new Date(Date.now() + DOWNLOAD_TTL * 1000).toISOString().replace('Z', '+00:00');
    }
  }
  return result;
}

// ---------------------------------------------------------------- validation

export interface UploadIntent { display_name: string | null; filename: string; content_type: string; size_bytes: number }

export function validateUploadIntent(body: any): UploadIntent {
  const errors: string[] = [];
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(422, 'Expected a JSON object');
  let display: string | null = null;
  if (body.display_name !== undefined && body.display_name !== null) {
    if (typeof body.display_name !== 'string' || body.display_name.length > 255) errors.push('display_name: at most 255 characters');
    // eslint-disable-next-line no-control-regex
    else if (!body.display_name.trim() || /[\u0000-\u001f\u007f-\u009f]/.test(body.display_name)) {
      errors.push('display_name: Name must not be blank or contain control characters');
    } else display = body.display_name.trim();
  }
  const filename = body.filename;
  // eslint-disable-next-line no-control-regex
  if (typeof filename !== 'string' || filename.length < 1 || filename.length > 255 || !filename.trim() || /[\u0000-\u001f]/.test(filename)) {
    errors.push('filename: Filename must not be blank or contain control characters');
  }
  const contentType = body.content_type ?? 'application/octet-stream';
  if (typeof contentType !== 'string' || contentType.length > 100 ||
      (contentType !== 'application/octet-stream' && !/^video\/[A-Za-z0-9.+-]+$/.test(contentType))) {
    errors.push('content_type: Expected a video content type');
  }
  const size = body.size_bytes;
  if (typeof size !== 'number' || !Number.isInteger(size) || size <= 0) errors.push('size_bytes: must be a positive integer');
  if (errors.length) throw new HttpError(422, errors.map((msg) => ({ msg })));
  return { display_name: display, filename, content_type: contentType, size_bytes: size };
}

async function readJson(request: Request): Promise<any> {
  try {
    return await request.json();
  } catch {
    throw new HttpError(422, 'Request body must be JSON');
  }
}

// ---------------------------------------------------------------- usage guard

/** Optional client `Idempotency-Key` header (printable ASCII, 8-128 chars). */
export function idempotencyKey(request: Request): string | null {
  const key = request.headers.get('idempotency-key');
  if (key === null) return null;
  if (!/^[\x21-\x7e]{8,128}$/.test(key)) throw new HttpError(422, 'Idempotency-Key must be 8-128 printable ASCII characters');
  return key;
}

/**
 * Reserve one unit of a daily budget. With `key`, the unit is counted at most
 * once per key: a retry with the same key is allowed again without counting.
 * One D1 transaction: count only if the key is new and under the limit, record
 * the key only if that count happened, then report whether the key is recorded.
 */
export async function reserve(db: D1Database, operation: string, limit: number, day = new Date().toISOString().slice(0, 10), key: string | null = null): Promise<boolean> {
  if (!key) {
    if (limit <= 0) return false;
    const row = await db.prepare(
      `INSERT INTO usage_counters (day, operation, count) VALUES (?1, ?2, 1)
       ON CONFLICT (day, operation) DO UPDATE SET count = count + 1 WHERE count < ?3
       RETURNING count`,
    ).bind(day, operation, limit).first();
    return row !== null;
  }
  const eventKey = `${operation}:${key}`;
  const results = await db.batch([
    db.prepare(
      `INSERT INTO usage_counters (day, operation, count)
       SELECT ?1, ?2, 1 WHERE ?3 > 0 AND NOT EXISTS (SELECT 1 FROM usage_events WHERE idempotency_key=?4)
       ON CONFLICT (day, operation) DO UPDATE SET count = count + 1 WHERE count < ?3`,
    ).bind(day, operation, limit, eventKey),
    db.prepare(
      `INSERT INTO usage_events (idempotency_key, day, operation, created_at)
       SELECT ?1, ?2, ?3, ?4 WHERE changes() = 1`,
    ).bind(eventKey, day, operation, Math.floor(Date.now() / 1000)),
    db.prepare('SELECT 1 AS counted FROM usage_events WHERE idempotency_key=?1').bind(eventKey),
  ]);
  return results[2].results.length === 1;
}

/** Port of app/limits.py public_budget. Returns a response to short-circuit, or null. */
export async function publicBudget(request: Request, path: string, deps: AppDeps): Promise<Response | null> {
  if (!deps.settings.publicLimits) return null;
  if (request.method === 'POST' && (path === '/videos' || path === '/videos/tag')) {
    return json({ detail: 'Use the direct upload flow in the Framer interface.' }, 403);
  }
  if (request.method === 'POST' && path === '/videos/uploads' && !deps.geminiConfigured) {
    return json({ detail: 'Video analysis is being configured. Please try uploading later.' }, 503);
  }
  // /search is budgeted too: unlike EC2's local model, each search spends Workers AI neurons.
  const operation = request.method === 'POST' && path === '/videos/uploads' ? 'upload'
    : (request.method === 'POST' && path === '/query') || (request.method === 'GET' && path === '/search') ? 'query' : null;
  if (!operation) return null;
  const length = Number(request.headers.get('content-length') ?? '0');
  if (!Number.isFinite(length)) return json({ detail: 'Invalid request size' }, 400);
  if (length > 16384) return json({ detail: 'Request is too large' }, 413);
  const limit = operation === 'upload' ? deps.settings.dailyUploadLimit : deps.settings.dailyQueryLimit;
  let allowed: boolean;
  const key = idempotencyKey(request);
  try {
    allowed = await reserve(need(deps.db, 'Database is not configured'), operation, limit, undefined, key);
  } catch {
    return json({ detail: 'Usage checks are temporarily unavailable. Please try again later.' }, 503);
  }
  if (!allowed) {
    return json({ detail: `The shared demo has reached its daily ${operation} limit. Please return after midnight UTC.` }, 429);
  }
  return null;
}

// ---------------------------------------------------------------- handlers

async function createUpload(request: Request, deps: AppDeps) {
  const db = need(deps.db, 'Database is not configured');
  const presigner = need(deps.presigner, 'Storage is not configured; set the R2 API token secrets');
  const body = validateUploadIntent(await readJson(request));
  if (body.size_bytes > deps.settings.maxUploadBytes) throw new HttpError(413, 'Video exceeds upload size limit');
  const key = idempotencyKey(request);
  // A retried request with the same Idempotency-Key gets the same upload request, not a second one.
  const existing = key ? await store.getVideoByIdempotencyKey(db, key) : null;
  if (existing && existing.status !== 'uploading') return json({ request: await present(existing, presigner), upload: null }, 200);
  const job = existing ?? await store.createVideo(db, { filename: body.filename, contentType: body.content_type, size: body.size_bytes, displayName: body.display_name, idempotencyKey: key });
  let url: string;
  try {
    url = await presigner.putUrl(job.object_key, job.content_type, 600);
  } catch {
    await store.uploadFailed(db, job.id, 'Could not prepare direct upload; submit again');
    throw new HttpError(503, 'Could not prepare direct upload');
  }
  // The scheduler expires the request if it is never confirmed (no cron sweeps it).
  if (!existing) await wakeScheduler(deps, Date.now() + (store.UPLOAD_EXPIRY_SECONDS + 1) * 1000);
  return json({
    request: await present(job, presigner),
    upload: { url, method: 'PUT', headers: { 'Content-Type': job.content_type }, expires_in: 600 },
  }, 201);
}

// ---------------------------------------------------------------- SSE

const VIDEO_EVENTS = /^\/videos\/([^/]+)\/events$/;

/**
 * GET /videos/:id/events: text/event-stream of the video's ingestion progress.
 * The snapshot comes from D1; the stream itself is held by the video's
 * VideoEvents Durable Object (src/events.ts), which pushes committed changes.
 * Connecting (or reconnecting) also runs the lost-wake-up safety net.
 */
async function videoEvents(request: Request, id: string, deps: AppDeps) {
  const db = need(deps.db, 'Database is not configured');
  const events = need(deps.events, 'Live updates are not configured');
  let video = await store.getVideo(db, id);
  if (!video) throw new HttpError(404, 'Request not found');
  if (await nudge(deps, video) === 'confirmed') video = (await store.getVideo(db, id))!;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const last = request.headers.get('last-event-id');
  if (last) headers['Last-Event-ID'] = last;
  // The DO request is cancelled with the client's request, which closes its writer.
  return events.get(events.idFromName(id)).fetch('https://video-events/connect', {
    method: 'POST', headers, body: JSON.stringify(videoState(video)), signal: request.signal,
  });
}

// ---------------------------------------------------------------- scheduler wake-ups

/** Wake the FramerScheduler alarm at `atMs` (advisory: failures are logged, never surfaced). */
export async function wakeScheduler(deps: AppDeps, atMs: number): Promise<boolean> {
  if (!deps.scheduler) return false;
  try {
    await deps.scheduler.wake(atMs);
    return true;
  } catch (error) {
    console.warn('scheduler wake failed', (error as Error)?.message);
    return false;
  }
}

const NUDGE_INTERVAL_MS = 10_000;
const lastNudge = new Map<string, number>();

/**
 * Safety net for a lost wake-up, run when a client looks at one video (status
 * read or SSE connect): at most one D1 check and one wake per request, and per
 * video at most one wake every 10 s per isolate, so reconnect storms cannot loop.
 *  - uploading, but the object is in R2: the browser never confirmed; confirm now.
 *  - due or expired-lease jobs: wake the scheduler now.
 */
export async function nudge(deps: AppDeps, video: Job): Promise<'confirmed' | 'woken' | null> {
  if (!deps.db) return null;
  const now = Date.now();
  if ((lastNudge.get(video.id) ?? 0) > now - NUDGE_INTERVAL_MS) return null;
  if (lastNudge.size > 1000) lastNudge.clear();
  lastNudge.set(video.id, now);
  try {
    if (video.status === 'uploading') {
      if (!deps.bucket || !(await deps.bucket.head(video.object_key))) return null;
      await completeUpload(video.id, deps); // verifies size and type, enqueues once, wakes
      return 'confirmed';
    }
    if ((video.status === 'pending' || video.status === 'processing') && await hasDueJobs(deps.db, video.id)) {
      return (await wakeScheduler(deps, now)) ? 'woken' : null;
    }
  } catch (error) {
    if (!(error instanceof HttpError)) console.warn('nudge failed', video.id, (error as Error)?.message);
  }
  return null;
}

async function completeUpload(id: string, deps: AppDeps) {
  const db = need(deps.db, 'Database is not configured');
  const bucket = need(deps.bucket, 'Storage is not configured');
  const job = await store.getVideo(db, id);
  if (!job) throw new HttpError(404, 'Upload request not found');
  if (job.uploaded) return json(await present(job, deps.presigner), 202); // Confirmation retry never starts a new job.
  if (job.status !== 'uploading' || job.expected_size === null) throw new HttpError(409, 'This request cannot be completed; start a new upload');
  let head: R2Object | null;
  try {
    head = await bucket.head(job.object_key);
  } catch {
    throw new HttpError(502, 'Could not verify the upload; retry confirmation');
  }
  if (!head) throw new HttpError(409, 'Video has not reached storage yet; retry confirmation');
  if (head.size !== job.expected_size || head.size > deps.settings.maxUploadBytes) {
    await store.uploadFailed(db, job.id, 'Stored video size does not match upload request');
    throw new HttpError(422, 'Stored video size does not match upload request');
  }
  if ((head.httpMetadata?.contentType ?? '') !== job.content_type) {
    await store.uploadFailed(db, job.id, 'Stored video content type does not match upload request');
    throw new HttpError(422, 'Stored video content type does not match upload request');
  }
  if (await store.markUploadedAndEnqueue(db, job.id)) {
    await deps.notify?.(job.id, 'status');
    await wakeScheduler(deps, Date.now());
  }
  const latest = (await store.getVideo(db, job.id))!;
  if (!latest.uploaded) throw new HttpError(409, 'Upload expired; start a new upload');
  return json(await present(latest, deps.presigner), 202);
}

function intParam(url: URL, name: string, fallback: number, min: number, max: number) {
  const raw = url.searchParams.get(name);
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) throw new HttpError(422, `${name} must be an integer between ${min} and ${max}`);
  return value;
}

async function history(url: URL, deps: AppDeps) {
  const db = need(deps.db, 'Database is not configured');
  const limit = intParam(url, 'limit', 50, 1, 100);
  const offset = intParam(url, 'offset', 0, 0, Number.MAX_SAFE_INTEGER);
  const includeArchived = ['true', '1', 'yes', 'on'].includes((url.searchParams.get('include_archived') ?? '').toLowerCase());
  const rawTags = url.searchParams.getAll('tags');
  let tags: string[] | null = null;
  if (rawTags.length) {
    if (rawTags.length > 20) throw new HttpError(422, 'At most 20 tags');
    tags = [...new Set(rawTags.map((t) => t.toLowerCase().trim().split(/\s+/).filter(Boolean).join(' ')))];
    if (tags.some((t) => !t || t.length > 80)) throw new HttpError(422, 'Each tag must contain between 1 and 80 characters');
  }
  const jobs = await store.listVideos(db, { limit, offset, tags, includeArchived });
  return json({ items: await Promise.all(jobs.map((j) => present(j, deps.presigner))), limit, offset });
}

async function frame(id: string, index: number, deps: AppDeps) {
  const db = need(deps.db, 'Database is not configured');
  const job = await store.getVideo(db, id);
  if (!job || job.status !== 'completed' || job.archived_at) throw new HttpError(404, 'Completed video not found');
  const timestamps: number[] = job.result?.sampled_timestamps ?? [];
  if (!(index >= 0 && index < timestamps.length)) throw new HttpError(404, 'Sampled frame not found');
  const stored: number[] = job.result.frame_indices ?? job.result.preview_indices ?? [];
  if (!stored.includes(index)) {
    // Worker-ingested videos keep no JPEGs (no FFmpeg on Workers); the UI seeks the video instead.
    throw new HttpError(404, 'No stored image for this moment; open the video at the cited time');
  }
  const presigner = need(deps.presigner, 'Storage is not configured');
  const url = await presigner.getUrl(`videos/${job.id}/frames/${index}.jpg`, DOWNLOAD_TTL);
  return new Response(null, { status: 307, headers: { Location: url, 'Cache-Control': 'private, no-store' } });
}

function readQuery(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 500) throw new HttpError(422, 'Query must contain between 1 and 500 characters');
  const q = value.split(/\s+/).filter(Boolean).join(' ');
  if (!q) throw new HttpError(422, 'Query must not be blank');
  return q;
}

async function retrieve(q: string, deps: AppDeps) {
  const db = need(deps.db, 'Database is not configured');
  const index = need(deps.index, 'Search index is not configured');
  const embedder = need(deps.embedder, 'Embedding model unavailable');
  try {
    const normalized = normalizeQuery(q);
    const [vector] = await embedder.embed([normalized]);
    return await hybridSearch({ db, index }, vector, normalized, deps.settings.searchMinSimilarity);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    console.warn('search failed', (error as Error)?.message);
    throw new HttpError(503, 'Search index could not be queried');
  }
}

async function search(url: URL, deps: AppDeps) {
  const q = readQuery(url.searchParams.get('q'));
  const ranked = await retrieve(q, deps);
  return json({ query: q, embedding_model: deps.embedder!.model, min_similarity: deps.settings.searchMinSimilarity,
    items: await Promise.all(ranked.map(async (r) => ({ ...(await present(r.job, deps.presigner)), retrieval: r.retrieval }))) });
}

async function queryVideos(request: Request, deps: AppDeps) {
  const body = await readJson(request);
  const q = readQuery(body?.q);
  const ranked = await retrieve(q, deps);
  const items = await Promise.all(ranked.map(async (r) => ({ ...(await present(r.job, deps.presigner)), retrieval: r.retrieval })));
  const response: Record<string, any> = { query: q, embedding_model: deps.embedder!.model, min_similarity: deps.settings.searchMinSimilarity,
    items, answer: 'No matching videos were found in the indexed collection.', answer_source: 'retrieval', answer_warning: null };
  if (!items.length) return json(response);
  const candidates = ranked.map((r, i) => {
    const evidence = r.retrieval.citation ?? {};
    return { number: i + 1, id: r.job.id, summary: r.job.result.summary, tags: r.job.result.tags.map((t: any) => t.label),
      selected_frame: { description: evidence.description ?? evidence.label, timestamp_seconds: evidence.timestamp_seconds } };
  });
  response.answer = `Found ${items.length} matching video(s). Review the tags and sampled-frame evidence below.`;
  try {
    response.answer = validateAnswer(await need(deps.gemini, 'no model').answer(q, candidates), items.length);
    response.answer_source = 'gemini';
  } catch {
    // Generation is optional; never discard usable retrieval or leak provider errors.
    response.answer_warning = 'Answer generation was unavailable; showing retrieved matches.';
  }
  return json(response);
}

// ---------------------------------------------------------------- router

const VIDEO = /^\/videos\/([^/]+)$/;
const VIDEO_ACTION = /^\/videos\/([^/]+)\/(complete|archive|restore)$/;
const FRAME = /^\/videos\/([^/]+)\/frames\/(\d+)$/;

export async function handle(request: Request, deps: AppDeps): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname;
  const method = request.method;
  try {
    if ((method === 'GET' || method === 'HEAD') && path === '/health') return json({ status: 'ok' });
    if ((method === 'GET' || method === 'HEAD') && path === '/') {
      // Asset html_handling maps '/' to index.html (requesting /index.html would redirect to '/').
      if (deps.assets) return deps.assets.fetch(request);
      throw new HttpError(404, 'Not found');
    }
    const limited = await publicBudget(request, path, deps);
    if (limited) return limited;

    if (method === 'POST' && path === '/videos/uploads') return await createUpload(request, deps);
    if (method === 'POST' && (path === '/videos' || path === '/videos/tag')) {
      throw new HttpError(410, 'Server-mediated upload is not available on this deployment; use the direct upload flow.');
    }
    if (method === 'GET' && path === '/videos') return await history(url, deps);
    if (method === 'GET' && path === '/search') return await search(url, deps);
    if (method === 'POST' && path === '/query') return await queryVideos(request, deps);
    let m = FRAME.exec(path);
    if (m && method === 'GET') return await frame(decodeURIComponent(m[1]), Number(m[2]), deps);
    m = VIDEO_ACTION.exec(path);
    if (m && method === 'POST') {
      const id = decodeURIComponent(m[1]);
      if (m[2] === 'complete') return await completeUpload(id, deps);
      const db = need(deps.db, 'Database is not configured');
      const ok = m[2] === 'archive' ? await store.archiveVideo(db, id) : await store.restoreVideo(db, id);
      if (!ok) throw new HttpError(404, 'Request not found');
      return json(await present((await store.getVideo(db, id))!, deps.presigner));
    }
    m = VIDEO_EVENTS.exec(path);
    if (m && method === 'GET') return await videoEvents(request, decodeURIComponent(m[1]), deps);
    m = VIDEO.exec(path);
    if (m && method === 'GET' && m[1] !== 'uploads') {
      const db = need(deps.db, 'Database is not configured');
      let job = await store.getVideo(db, decodeURIComponent(m[1]));
      if (!job) throw new HttpError(404, 'Request not found');
      if (await nudge(deps, job) === 'confirmed') job = (await store.getVideo(db, job.id))!;
      return json(await present(job, deps.presigner));
    }
    throw new HttpError(404, 'Not found');
  } catch (error) {
    if (error instanceof HttpError) return json({ detail: error.detail }, error.status);
    console.error('unhandled', method, path, (error as Error)?.message);
    return json({ detail: 'Internal server error' }, 500);
  }
}
