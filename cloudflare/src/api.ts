/**
 * HTTP API: the FastAPI app's routes and response shapes (app/*.py), plus Google sources
 * (OAuth, Photos picker, Drive folder), WebSocket status and thumbnails.
 */
import { libraryStub, videoStub } from './actor';
import { Settings } from './env';
import { Gemini, validateAnswer } from './gemini';
import { authUrl, encryptSecret, exchangeCode, Google, GoogleConfig, GoogleError } from './google';
import { normalizeQuery, Reranker, search as rankedSearch, thresholdsOf } from './retrieval';
import { Presigner } from './storage';
import * as store from './store';
import { Video as Job } from './store';
import { Embedder, thumbKey, vectorIdsOf } from './vectors';

export interface AppDeps {
  db: D1Database | null;
  bucket: R2Bucket | null;
  index: VectorizeIndex | null;
  presigner: Presigner | null;
  gemini: Gemini | null;
  embedder: Embedder | null;
  reranker?: Reranker | null;
  settings: Settings;
  geminiConfigured: boolean;
  assets?: Fetcher;
  /** VideoDO namespace: one actor per video runs ingestion and serves its WebSocket. */
  videos?: DurableObjectNamespace | null;
  /** LibraryDO namespace: Google Photos sessions and Drive sync. */
  library?: DurableObjectNamespace | null;
  /** Google OAuth config (client id/secret, encryption key) and client; null until configured. */
  googleConfig?: GoogleConfig | null;
  google?: Google | null;
  /** ADMIN_TOKEN secret; null disables the admin routes (they answer 404). */
  adminToken?: string | null;
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
  else if (job.status === 'skipped') progress = { stage: 'Skipped', percent: 0, eta_seconds: null, updated_at: job.updated_at };
  else if (job.status === 'pending' || job.status === 'uploading') {
    const stage = job.status === 'uploading' ? 'Uploading' : job.error ? 'Waiting to retry' : 'Queued';
    // A pending video waiting to retry keeps the percent of the step it reached (e.g. 55 at tag).
    const percent = job.status === 'pending' && typeof progress.percent === 'number' ? progress.percent : 0;
    progress = { stage, percent, eta_seconds: progress.eta_seconds ?? null, updated_at: job.updated_at };
  } else if (!Object.keys(progress).length) progress = { stage: 'Processing', percent: 0, eta_seconds: null, updated_at: job.updated_at };
  return progress;
}

/** The status fields of a video, as pushed in SSE events (no presigned URLs, no result body). */
export function videoState(job: Job): Record<string, any> {
  return {
    id: job.id, filename: job.filename, display_name: job.display_name ?? null, status: job.status, error: job.error, source: job.source ?? 'upload',
    attempts: job.attempts, created_at: job.created_at, updated_at: job.updated_at, archived_at: job.archived_at ?? null,
    possible_duplicate: job.result?.possible_duplicate ?? null, progress: progressOf(job),
  };
}

export async function present(job: Job, presigner: Presigner | null): Promise<Record<string, any>> {
  const result: Record<string, any> = {};
  for (const k of ['id', 'filename', 'status', 'created_at', 'updated_at', 'error', 'attempts', 'result']) result[k] = job[k];
  result.source = job.source ?? 'upload';
  result.duration_seconds = job.duration_seconds ?? null;
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
    db.prepare('DELETE FROM usage_events WHERE created_at < ?1').bind(Math.floor(Date.now() / 1000) - 2 * 86400),
  ]);
  return results[2].results.length === 1;
}

/** Port of app/limits.py public_budget. Returns a response to short-circuit, or null. */
export async function publicBudget(request: Request, path: string, deps: AppDeps): Promise<Response | null> {
  if (!deps.settings.publicLimits) return null;
  if (request.method === 'POST' && (path === '/videos' || path === '/videos/tag')) {
    return json({ detail: 'Use the direct upload flow in the Spotted interface.' }, 403);
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
  if (body.size_bytes >= deps.settings.maxSourceBytes) throw new HttpError(413, `Videos over ${Math.round(deps.settings.maxSourceBytes / 1e6)} MB are skipped`);
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
  return json({
    request: await present(job, presigner),
    upload: { url, method: 'PUT', headers: { 'Content-Type': job.content_type }, expires_in: 600 },
  }, 201);
}

// ---------------------------------------------------------------- WebSocket status and the per-video actor

const VIDEO_WS = /^\/videos\/([^/]+)\/ws$/;

/**
 * GET /videos/:id/ws (Upgrade: websocket): the video's status stream, served by its VideoDO
 * with the hibernation API (src/video.ts). Same-origin, so the browser sends the Access
 * cookie with the upgrade. Connecting also runs the lost-alarm safety net.
 */
async function videoSocket(request: Request, id: string, deps: AppDeps) {
  if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') throw new HttpError(426, 'Expected a WebSocket upgrade');
  // The upgrade is a GET, so the non-GET same-origin guard misses it; browsers always send Origin here.
  if (!sameOrigin(request, new URL(request.url))) throw new HttpError(403, 'Cross-origin request refused');
  const db = need(deps.db, 'Database is not configured');
  const videos = need(deps.videos, 'Live updates are not configured');
  const video = await store.getVideo(db, id);
  if (!video) throw new HttpError(404, 'Request not found');
  await nudge(deps, video);
  const forwarded = new Request(request, { headers: new Headers(request.headers) });
  forwarded.headers.set('x-video-id', id);
  return videoStub(videos, id).fetch(forwarded);
}

/** Start (or resume) the video's actor. start() is idempotent; failures are logged, the nudge retries. */
export async function startActor(deps: AppDeps, id: string): Promise<boolean> {
  if (!deps.videos) return false;
  try {
    await videoStub(deps.videos, id).start(id);
    return true;
  } catch (error) {
    console.warn('VideoDO start failed', id, (error as Error)?.message);
    return false;
  }
}

const NUDGE_INTERVAL_MS = 10_000;
const lastNudge = new Map<string, number>();

/**
 * Safety net, run when a client looks at one video (status read or SSE connect).
 * At most one action per request, and per video at most one every 10 s per isolate:
 *  - uploading, but the object is in R2: the browser never confirmed; confirm now
 *    (which starts the actor);
 *  - pending/processing: start() the actor, which is idempotent and re-arms a lost alarm;
 *  - completed but imported without vectors (needs_index): re-embed it.
 */
export async function nudge(deps: AppDeps, video: Job): Promise<'confirmed' | 'started' | 'reindexed' | null> {
  if (!deps.db || !deps.videos) return null;
  const now = Date.now();
  if ((lastNudge.get(video.id) ?? 0) > now - NUDGE_INTERVAL_MS) return null;
  if (lastNudge.size > 1000) lastNudge.clear();
  lastNudge.set(video.id, now);
  try {
    if (video.status === 'uploading') {
      if (!deps.bucket || !(await deps.bucket.head(video.object_key))) return null;
      await completeUpload(video.id, deps); // verifies size and type, then starts the actor
      return 'confirmed';
    }
    if (video.status === 'pending' || video.status === 'processing') return (await startActor(deps, video.id)) ? 'started' : null;
    if (video.status === 'completed' && video.needs_index) {
      return (await videoStub(deps.videos, video.id).reindex(video.id)) ? 'reindexed' : null;
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
  if (job.uploaded) {
    // A confirmation retry never starts a second ingestion: start() is idempotent.
    if (job.status === 'pending' || job.status === 'processing') await startActor(deps, job.id);
    return json(await present(job, deps.presigner), 202);
  }
  if (job.status !== 'uploading' || job.expected_size === null) throw new HttpError(409, 'This request cannot be completed; start a new upload');
  let head: R2Object | null;
  try {
    head = await bucket.head(job.object_key);
  } catch {
    throw new HttpError(502, 'Could not verify the upload; retry confirmation');
  }
  if (!head) throw new HttpError(409, 'Video has not reached storage yet; retry confirmation');
  if (head.size !== job.expected_size || head.size >= deps.settings.maxSourceBytes) {
    await store.uploadFailed(db, job.id, 'Stored video size does not match upload request');
    throw new HttpError(422, 'Stored video size does not match upload request');
  }
  if ((head.httpMetadata?.contentType ?? '') !== job.content_type) {
    await store.uploadFailed(db, job.id, 'Stored video content type does not match upload request');
    throw new HttpError(422, 'Stored video content type does not match upload request');
  }
  if (await store.markUploaded(db, job.id)) await startActor(deps, job.id);
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
  await store.expireUploads(db); // lazily: there is no background sweeper
  const jobs = await store.listVideos(db, { limit, offset, tags, includeArchived });
  return json({ items: await Promise.all(jobs.map((j) => present(j, deps.presigner))), limit, offset });
}

/** GET /videos/:id/thumbs/:i: a selected frame's JPEG, streamed from R2 (same-origin, behind Access). */
async function thumb(id: string, index: number, deps: AppDeps) {
  const db = need(deps.db, 'Database is not configured');
  const bucket = need(deps.bucket, 'Storage is not configured');
  const job = await store.getVideo(db, id);
  if (!job || job.archived_at || !(job.result?.thumbs ?? []).includes(index)) throw new HttpError(404, 'Frame not found');
  const object = await bucket.get(thumbKey(job.id, index));
  if (!object) throw new HttpError(404, 'Frame not found');
  return new Response(object.body, { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff' } });
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
  const reranker = need(deps.reranker, 'Reranking model unavailable');
  try {
    const normalized = normalizeQuery(q);
    const [vector] = await embedder.embed([normalized]);
    return await rankedSearch({ db, index, reranker }, vector, normalized, thresholdsOf(deps.settings));
  } catch (error) {
    if (error instanceof HttpError) throw error;
    console.warn('search failed', (error as Error)?.message);
    throw new HttpError(503, 'Search index could not be queried');
  }
}

async function search(url: URL, deps: AppDeps) {
  const q = readQuery(url.searchParams.get('q'));
  const ranked = await retrieve(q, deps);
  return json({ query: q, embedding_model: deps.embedder!.model, rerank_model: deps.reranker!.model, min_score: deps.settings.searchMinScore,
    items: await Promise.all(ranked.map(async (r) => ({ ...(await present(r.job, deps.presigner)), retrieval: r.retrieval }))) });
}

async function queryVideos(request: Request, deps: AppDeps) {
  const body = await readJson(request);
  const q = readQuery(body?.q);
  const ranked = await retrieve(q, deps);
  const items = await Promise.all(ranked.map(async (r) => ({ ...(await present(r.job, deps.presigner)), retrieval: r.retrieval })));
  const response: Record<string, any> = { query: q, embedding_model: deps.embedder!.model, rerank_model: deps.reranker!.model, min_score: deps.settings.searchMinScore,
    items, answer: 'No matching videos were found in the indexed collection.', answer_source: 'retrieval', answer_warning: null };
  if (!items.length) return json(response);
  const candidates = ranked.map((r, i) => {
    const evidence = r.retrieval.citation ?? {};
    return { number: i + 1, title: r.job.display_name ?? r.job.filename, summary: r.job.result.summary, tags: (r.job.result.tags ?? []).map((t: any) => t.label),
      evidence: { kind: evidence.kind, at: clock(evidence.timestamp_seconds), text: String(evidence.description ?? '').slice(0, 1500) } };
  });
  response.answer = `Found ${items.length} matching video(s). Review the evidence below.`;
  try {
    const gemini = need(deps.gemini, 'no model');
    const { value, usage } = await gemini.answer(q, candidates);
    response.answer = validateAnswer(value, items.length);
    response.answer_source = 'gemini';
    response.answer_model = gemini.modelName;
    if (usage) response.answer_usage = { prompt_tokens: usage.promptTokenCount ?? null, output_tokens: usage.candidatesTokenCount ?? null,
      thought_tokens: usage.thoughtsTokenCount ?? null, total_tokens: usage.totalTokenCount ?? null };
  } catch {
    // Generation is optional; never discard usable retrieval or leak provider errors.
    response.answer_warning = 'Answer generation was unavailable; showing retrieved matches.';
  }
  return json(response);
}

// ---------------------------------------------------------------- admin

/** Constant-time comparison of a bearer token (both sides hashed first, so lengths match). */
export async function tokenMatches(header: string | null, expected: string): Promise<boolean> {
  const presented = /^Bearer (.+)$/.exec(header ?? '')?.[1];
  if (!presented) return false;
  const digest = async (s: string) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
  const [a, b] = await Promise.all([digest(presented), digest(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** Vector ids a video can own (vectors.ts): summary, transcript windows and frames. */
export const vectorIds = (id: string) => vectorIdsOf(id);

const clock = (t: unknown) => {
  const s = Math.max(0, Math.round(Number(t) || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

// ---------------------------------------------------------------- Google sources

/** One-time state for the consent redirect (CSRF), valid 10 minutes. */
async function googleStart(deps: AppDeps) {
  const db = need(deps.db, 'Database is not configured');
  const cfg = need(deps.googleConfig, 'Google sign-in is not configured yet (GOOGLE_CLIENT_SECRET / TOKEN_ENC_KEY)');
  const state = [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, '0')).join('');
  const now = Math.floor(Date.now() / 1000);
  await db.batch([
    db.prepare('DELETE FROM oauth_states WHERE created_at < ?1').bind(now - 600),
    db.prepare('INSERT INTO oauth_states (state, created_at) VALUES (?1, ?2)').bind(state, now),
  ]);
  return new Response(null, { status: 302, headers: { Location: authUrl(cfg, state), 'Cache-Control': 'no-store' } });
}

async function googleCallback(url: URL, deps: AppDeps) {
  const db = need(deps.db, 'Database is not configured');
  const cfg = need(deps.googleConfig, 'Google sign-in is not configured yet');
  const back = (status: string) => new Response(null, { status: 302, headers: { Location: `/?google=${status}`, 'Cache-Control': 'no-store' } });
  const state = url.searchParams.get('state') ?? '';
  const used = await db.prepare('DELETE FROM oauth_states WHERE state=?1 AND created_at >= ?2 RETURNING state')
    .bind(state, Math.floor(Date.now() / 1000) - 600).first();
  if (!used) return back('expired');
  if (url.searchParams.get('error')) return back('denied');
  const code = url.searchParams.get('code');
  if (!code) return back('error');
  try {
    const { refreshToken, scope } = await exchangeCode(cfg, code);
    const sealed = await encryptSecret(refreshToken, cfg.encKey);
    const ts = store.nowIso();
    await db.prepare(`INSERT INTO google_auth (id, refresh_token_enc, scopes, status, error, connected_at, updated_at) VALUES (1, ?1, ?2, 'connected', NULL, ?3, ?3)
      ON CONFLICT (id) DO UPDATE SET refresh_token_enc=excluded.refresh_token_enc, scopes=excluded.scopes, status='connected', error=NULL, updated_at=excluded.updated_at`)
      .bind(sealed, scope, ts).run();
    if (deps.library) await libraryStub(deps.library).poke(); // resume a Drive sync stopped by an expired token
    return back('connected');
  } catch (error) {
    console.warn('google connect failed', (error as Error)?.message);
    return back('error');
  }
}

async function googleStatus(deps: AppDeps) {
  const db = need(deps.db, 'Database is not configured');
  const auth = await db.prepare('SELECT status, error, scopes, connected_at, updated_at FROM google_auth WHERE id=1').first<any>();
  const drive = await db.prepare('SELECT folder_id, folder_name, initial_done, last_sync_at, error FROM drive_sync WHERE id=1').first<any>();
  const { results: sessions } = await db.prepare('SELECT id, status, error, imported, skipped, created_at, updated_at FROM picker_sessions ORDER BY created_at DESC LIMIT 5').all();
  return json({
    configured: Boolean(deps.googleConfig), connection: auth ? auth.status : 'disconnected', error: auth?.error ?? null,
    scopes: auth?.scopes ? String(auth.scopes).split(' ') : [], connected_at: auth?.connected_at ?? null,
    drive: drive ?? null, picker_sessions: sessions, max_source_mb: Math.round(deps.settings.maxSourceBytes / 1e6),
    drive_poll_minutes: deps.settings.drivePollMinutes,
  });
}

function googleError(error: unknown): never {
  if (error instanceof GoogleError) throw new HttpError(error.status === 401 || error.status === 409 ? 409 : 502, error.message);
  throw error;
}

/** POST /photos/sessions: a Google Photos picker session; the LibraryDO polls it until items are picked. */
async function createPickerSession(deps: AppDeps) {
  const db = need(deps.db, 'Database is not configured');
  const google = need(deps.google, 'Google is not configured');
  const session = await google.createPickerSession().catch(googleError);
  const ts = store.nowIso();
  await db.prepare(`INSERT INTO picker_sessions (id, picker_uri, status, expire_time, created_at, updated_at) VALUES (?1, ?2, 'waiting', ?3, ?4, ?4)`)
    .bind(session.id, session.pickerUri, session.expireTime ?? null, ts).run();
  if (deps.library) await libraryStub(deps.library).poke();
  return json({ id: session.id, picker_uri: `${session.pickerUri.replace(/\/$/, '')}/autoclose`, status: 'waiting' }, 201);
}

/**
 * GET /photos/sessions/:id, or /photos/sessions/latest (the newest session, or null): the
 * session's status (waiting | importing | imported | expired | failed), its counts, and the
 * ids of the videos it created, so the UI can follow each one's own pipeline progress.
 */
async function pickerSession(id: string | null, deps: AppDeps) {
  const db = need(deps.db, 'Database is not configured');
  const columns = 'SELECT id, status, error, imported, skipped, created_at, updated_at FROM picker_sessions';
  const row = await (id === null ? db.prepare(`${columns} ORDER BY created_at DESC LIMIT 1`) : db.prepare(`${columns} WHERE id=?1`).bind(id))
    .first<Record<string, unknown>>();
  if (!row) {
    if (id === null) return json(null);
    throw new HttpError(404, 'Picker session not found');
  }
  const { results } = await db.prepare(
    "SELECT id FROM videos WHERE source='photos' AND json_extract(source_meta, '$.session_id')=?1 ORDER BY created_at, id",
  ).bind(row.id).all<{ id: string }>();
  return json({ ...row, video_ids: results.map((r) => r.id) });
}

/**
 * GET /me: who is signed in, for the header. Cloudflare Access sets
 * Cf-Access-Authenticated-User-Email on every request it lets through. The header is trusted
 * without verifying Cf-Access-Jwt-Assertion: workers_dev and preview_urls are off and the
 * Worker has no other route, so every request reaches it through Access, and the identity is
 * only displayed (no decision depends on it). Without Access (wrangler dev) it answers
 * {email: null}. The display name, if any, comes from /cdn-cgi/access/get-identity in the browser.
 */
function me(request: Request) {
  const email = request.headers.get('cf-access-authenticated-user-email')?.trim() || null;
  return json({ email, signed_in: email !== null, source: email ? 'access' : 'none', logout_url: email ? '/cdn-cgi/access/logout' : null });
}

/** PUT /drive/folder {"folder": "<id or URL>"}: sync this folder (replaces any previous one). */
async function setDriveFolder(request: Request, deps: AppDeps) {
  const db = need(deps.db, 'Database is not configured');
  const google = need(deps.google, 'Google is not configured');
  const body = await readJson(request);
  const raw = typeof body?.folder === 'string' ? body.folder.trim() : '';
  const id = /\/folders\/([A-Za-z0-9_-]{10,})/.exec(raw)?.[1] ?? (/^[A-Za-z0-9_-]{10,}$/.test(raw) ? raw : null);
  if (!id) throw new HttpError(422, 'Paste a Drive folder link or folder id');
  const folder = await google.driveFolder(id).catch(googleError);
  if (folder.mimeType !== 'application/vnd.google-apps.folder') throw new HttpError(422, 'That Drive item is not a folder');
  const ts = store.nowIso();
  await db.prepare(`INSERT INTO drive_sync (id, folder_id, folder_name, page_token, initial_done, last_sync_at, error, updated_at) VALUES (1, ?1, ?2, NULL, 0, NULL, NULL, ?3)
    ON CONFLICT (id) DO UPDATE SET folder_id=excluded.folder_id, folder_name=excluded.folder_name, page_token=NULL, initial_done=0, error=NULL, updated_at=excluded.updated_at`)
    .bind(folder.id, folder.name, ts).run();
  if (deps.library) await libraryStub(deps.library).poke();
  return json({ folder_id: folder.id, folder_name: folder.name, status: 'syncing' });
}

/** Non-GET requests must come from this origin (no cross-site form posts riding the Access cookie). */
function sameOrigin(request: Request, url: URL): boolean {
  const origin = request.headers.get('origin');
  return origin === null || origin === url.origin;
}

/**
 * DELETE /admin/videos/:id (Authorization: Bearer ADMIN_TOKEN): remove a video completely.
 * Order: the D1 row first (so no reader or safety-net nudge can revive it), then the actor
 * (alarm, streams, Gemini file, all DO storage; a tombstone stops in-flight steps), then
 * Vectorize vectors and every R2 object under videos/<id>/ and thumbs/<id>/. Idempotent: re-run after a failure.
 */
async function purgeVideo(id: string, deps: AppDeps) {
  const db = need(deps.db, 'Database is not configured');
  const row = await store.getVideo(db, id);
  await db.prepare('DELETE FROM videos WHERE id=?1').bind(id).run();
  const actor = deps.videos ? await videoStub(deps.videos, id).purge(id) : null;
  if (deps.index) await deps.index.deleteByIds(vectorIds(id));
  const deletedObjects: string[] = [];
  if (deps.bucket) {
    for (const prefix of [`videos/${id}/`, `thumbs/${id}/`]) {
      let cursor: string | undefined;
      do {
        const page = await deps.bucket.list({ prefix, cursor });
        const keys = page.objects.map((o) => o.key);
        if (keys.length) await deps.bucket.delete(keys);
        deletedObjects.push(...keys);
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
    }
  }
  return json({ id, d1_row_deleted: Boolean(row), r2_objects_deleted: deletedObjects, vectors_deleted: Boolean(deps.index),
    gemini_files_deleted: actor?.gemini_files_deleted ?? [], actor_purged: Boolean(actor) });
}

// ---------------------------------------------------------------- router

const VIDEO = /^\/videos\/([^/]+)$/;
const ADMIN_VIDEO = /^\/admin\/videos\/([^/]+)$/;
const VIDEO_ACTION = /^\/videos\/([^/]+)\/(complete|archive|restore)$/;
const THUMB = /^\/videos\/([^/]+)\/(?:thumbs|frames)\/(\d+)$/;
const PICKER_SESSION = /^\/photos\/sessions\/([^/]+)$/;

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
    const admin = ADMIN_VIDEO.exec(path);
    if (admin) {
      // Without ADMIN_TOKEN, or with a wrong token, the route does not exist.
      if (!deps.adminToken || method !== 'DELETE' || !(await tokenMatches(request.headers.get('authorization'), deps.adminToken))) {
        throw new HttpError(404, 'Not found');
      }
      return await purgeVideo(decodeURIComponent(admin[1]), deps);
    }
    if (method !== 'GET' && method !== 'HEAD' && !sameOrigin(request, url)) throw new HttpError(403, 'Cross-origin request refused');
    if (method === 'GET' && path === '/me') return me(request);
    if (method === 'GET' && path === '/oauth/google/start') return await googleStart(deps);
    if (method === 'GET' && path === '/oauth/google/callback') return await googleCallback(url, deps);
    if (method === 'GET' && path === '/google/status') return await googleStatus(deps);
    if (method === 'POST' && path === '/photos/sessions') return await createPickerSession(deps);
    const session = PICKER_SESSION.exec(path);
    if (session && method === 'GET') return await pickerSession(session[1] === 'latest' ? null : decodeURIComponent(session[1]), deps);
    if (method === 'PUT' && path === '/drive/folder') return await setDriveFolder(request, deps);
    if (method === 'POST' && path === '/drive/sync') {
      if (deps.library) await libraryStub(deps.library).poke();
      return json({ status: 'syncing' }, 202);
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
    let m = THUMB.exec(path);
    if (m && method === 'GET') return await thumb(decodeURIComponent(m[1]), Number(m[2]), deps);
    m = VIDEO_ACTION.exec(path);
    if (m && method === 'POST') {
      const id = decodeURIComponent(m[1]);
      if (m[2] === 'complete') return await completeUpload(id, deps);
      const db = need(deps.db, 'Database is not configured');
      const ok = m[2] === 'archive' ? await store.archiveVideo(db, id) : await store.restoreVideo(db, id);
      if (!ok) throw new HttpError(404, 'Request not found');
      return json(await present((await store.getVideo(db, id))!, deps.presigner));
    }
    m = VIDEO_WS.exec(path);
    if (m && method === 'GET') return await videoSocket(request, decodeURIComponent(m[1]), deps);
    m = VIDEO.exec(path);
    if (m && method === 'GET' && m[1] !== 'uploads') {
      const db = need(deps.db, 'Database is not configured');
      const id = decodeURIComponent(m[1]);
      let job = await store.getVideo(db, id);
      if (!job) {
        // Safety net for out-of-band deletes: an actor left behind by a deleted row cleans itself up.
        if (deps.videos && /^[0-9a-f-]{36}$/.test(id)) {
          await videoStub(deps.videos, id).purgeIfOrphan(id).catch((e: Error) => console.warn('orphan purge failed', id, e?.message));
        }
        throw new HttpError(404, 'Request not found');
      }
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
