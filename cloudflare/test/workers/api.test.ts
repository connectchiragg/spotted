/** API tests inside workerd against a local Miniflare D1 (uploads, budgets, expiry). */
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { handle, reserve } from '../../src/api';
import { search } from '../../src/retrieval';
import * as store from '../../src/store';
import { appDeps, authed, fakeBucket, fakeReranker, fakeVectorize, settings, signIn } from '../helpers';

const db: D1Database = env.DB;

let req: (url: string, init?: RequestInit) => Request;

beforeEach(async () => {
  await db.batch(['videos', 'usage_counters', 'usage_events', 'sessions', 'users'].map((t) => db.prepare(`DELETE FROM ${t}`)));
  req = authed(await signIn(db));
});


describe('upload, budget and expiry API on D1', () => {
  it('upload API: presigned PUT, verified completion, idempotent confirm, archive', async () => {
    const objects: Record<string, { size: number; contentType: string }> = {};
    const app = appDeps(db, { bucket: fakeBucket(objects) });
    const created = await handle(req('https://x/videos/uploads', { method: 'POST',
      body: JSON.stringify({ filename: 'trip.mov', content_type: 'video/quicktime', size_bytes: 500, display_name: 'Trip' }) }), app);
    expect(created.status).toBe(201);
    const body = await created.json<any>();
    expect(body.upload).toMatchObject({ method: 'PUT', headers: { 'Content-Type': 'video/quicktime' }, expires_in: 600 });
    const id = body.request.id;
    expect((await handle(req(`https://x/videos/${id}/complete`, { method: 'POST' }), app)).status).toBe(409);
    objects[`videos/${id}/source`] = { size: 500, contentType: 'video/quicktime' };
    const done = await handle(req(`https://x/videos/${id}/complete`, { method: 'POST' }), app);
    expect(done.status).toBe(202);
    expect(await done.json()).toMatchObject({ status: 'pending', progress: { stage: 'Queued' }, display_name: 'Trip' });
    expect((await handle(req(`https://x/videos/${id}/complete`, { method: 'POST' }), app)).status).toBe(202);
    expect((await store.getVideo(db, id))!).toMatchObject({ status: 'pending', uploaded: 1 });
    expect((await (await handle(req(`https://x/videos/${id}/archive`, { method: 'POST' }), app)).json<any>()).archived_at).toBeTruthy();
    expect((await (await handle(req('https://x/videos'), app)).json<any>()).items).toHaveLength(0);
    await handle(req(`https://x/videos/${id}/restore`, { method: 'POST' }), app);
    expect((await (await handle(req('https://x/videos'), app)).json<any>()).items).toHaveLength(1);
  });

  it('rejects a stored object whose size does not match', async () => {
    const objects: Record<string, { size: number; contentType: string }> = {};
    const app = appDeps(db, { bucket: fakeBucket(objects) });
    const body = await (await handle(req('https://x/videos/uploads', { method: 'POST',
      body: JSON.stringify({ filename: 'a.mp4', content_type: 'video/mp4', size_bytes: 10 }) }), app)).json<any>();
    objects[`videos/${body.request.id}/source`] = { size: 11, contentType: 'video/mp4' };
    expect((await handle(req(`https://x/videos/${body.request.id}/complete`, { method: 'POST' }), app)).status).toBe(422);
    expect((await store.getVideo(db, body.request.id))!.status).toBe('failed');
  });

  it('daily budgets stop at the limit', async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => reserve(db, 'upload', 3, '2026-10-14')));
    expect(results.filter(Boolean)).toHaveLength(3);
    const app = appDeps(db, { settings: { ...settings, publicLimits: true, dailyQueryLimit: 0 } });
    const guest = authed(await signIn(db, { id: 'g:1', email: 'guest@example.com' }));
    expect((await handle(guest('https://x/query', { method: 'POST', body: '{"q":"x"}' }), app)).status).toBe(429);
    expect((await handle(guest('https://x/search?q=x'), app)).status).toBe(429);
  });

  it('expires uploads that were never confirmed', async () => {
    const video = await store.createVideo(db, { userId: 'owner', filename: 'a.mp4', contentType: 'video/mp4', size: 1 });
    await db.prepare("UPDATE videos SET updated_at='2000-01-01T00:00:00+00:00' WHERE id=?1").bind(video.id).run();
    expect(await store.expireUploads(db)).toBe(1);
    expect((await store.getVideo(db, video.id))!.status).toBe('failed');
  });
});

describe('budgets count once per idempotency key', () => {
  it('a retried key is allowed without counting again; new keys stop at the limit', async () => {
    const day = '2026-10-15';
    expect(await reserve(db, 'upload', 2, day, 'key-aaaaaaaa')).toBe(true);
    expect(await reserve(db, 'upload', 2, day, 'key-aaaaaaaa')).toBe(true);
    expect(await reserve(db, 'upload', 2, day, 'key-bbbbbbbb')).toBe(true);
    expect(await reserve(db, 'upload', 2, day, 'key-cccccccc')).toBe(false);
    expect(await reserve(db, 'upload', 2, day, 'key-bbbbbbbb')).toBe(true);
    expect(await db.prepare("SELECT count FROM usage_counters WHERE operation='upload'").first()).toEqual({ count: 2 });
  });

  it('POST /videos/uploads with the same Idempotency-Key returns the same request and counts once', async () => {
    const app = appDeps(db, { bucket: fakeBucket({}), settings: { ...settings, publicLimits: true, dailyUploadLimit: 5 } });
    const guest = authed(await signIn(db, { id: 'g:9', email: 'g9@example.com' })); // the owner has no budget
    const post = () => handle(guest('https://x/videos/uploads', { method: 'POST', headers: { 'Idempotency-Key': 'upload-0001' },
      body: JSON.stringify({ filename: 'a.mp4', content_type: 'video/mp4', size_bytes: 10 }) }), app);
    const first = await (await post()).json<any>();
    const second = await (await post()).json<any>();
    expect(second.request.id).toBe(first.request.id);
    expect(second.upload.url).toContain(first.request.id);
    expect((await db.prepare('SELECT count(*) AS n FROM videos').first<any>()).n).toBe(1);
    expect(await db.prepare("SELECT count FROM usage_counters WHERE operation='upload'").first()).toEqual({ count: 1 });
    const bad = await handle(req('https://x/videos/uploads', { method: 'POST', headers: { 'Idempotency-Key': 'x' }, body: '{}' }), app);
    expect(bad.status).toBe(422);
  });
});

describe('identity and Photos import status', () => {
  it('GET /me: the session user (no limits for the owner), a guest with usage, or signed out; the Access header is ignored', async () => {
    const app = appDeps(db);
    expect(await (await handle(req('https://x/me'), app)).json()).toMatchObject({ signed_in: true, user: { id: 'owner', role: 'owner' }, limits: null });
    const guest = authed(await signIn(db, { id: 'g:7', email: 'g7@example.com' }));
    await store.createVideo(db, { userId: 'g:7', filename: 'a.mp4', contentType: 'video/mp4', size: 1000 });
    expect(await (await handle(guest('https://x/me'), app)).json()).toMatchObject({ signed_in: true, user: { id: 'g:7', email: 'g7@example.com', role: 'guest' },
      limits: { videos: { used: 1, max: 20 }, bytes: { used: 1000, max: 500_000_000 }, searches_today: { used: 0, max: 30 } } });
    const spoofed = new Request('https://x/me', { headers: { 'Cf-Access-Authenticated-User-Email': 'owner@example.com' } });
    expect(await (await handle(spoofed, app)).json()).toEqual({ signed_in: false, user: null, limits: null });
    const out = await handle(req('https://x/auth/logout', { method: 'POST' }), app);
    expect([out.status, out.headers.get('set-cookie')]).toEqual([204, '__Host-spotted=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0']);
    expect((await handle(req('https://x/videos'), app)).status).toBe(401); // the session is gone
  });

  it('picker session status lists the videos it created; /latest is the newest session or null', async () => {
    await db.prepare('DELETE FROM picker_sessions').run();
    const app = appDeps(db);
    expect(await (await handle(req('https://x/photos/sessions/latest'), app)).json()).toBeNull();
    await db.prepare("INSERT INTO picker_sessions (id, picker_uri, status, imported, created_at, updated_at) VALUES ('old', 'u', 'imported', 0, '2026-10-01', '2026-10-01'), ('s9', 'u', 'importing', 0, '2026-10-02', '2026-10-02')").run();
    const { video } = await store.upsertSourceVideo(db, { userId: 'owner', source: 'photos', sourceId: 'm1', filename: 'a.mp4', contentType: 'video/mp4', size: 10,
      meta: { session_id: 's9' }, status: 'pending' });
    await store.upsertSourceVideo(db, { userId: 'owner', source: 'photos', sourceId: 'm2', filename: 'b.mp4', contentType: 'video/mp4', size: 10, meta: { session_id: 'old' }, status: 'pending' });
    expect(await (await handle(req('https://x/photos/sessions/latest'), app)).json()).toMatchObject({ id: 's9', status: 'importing', video_ids: [video.id] });
    expect(await (await handle(req('https://x/photos/sessions/s9'), app)).json()).toMatchObject({ id: 's9', video_ids: [video.id] });
    expect((await handle(req('https://x/photos/sessions/nope'), app)).status).toBe(404);
  });
});

describe('search candidates on D1', () => {
  const T = { minScore: 0.02, softMinScore: 0.008, minSimilarity: 0.53, vectorMargin: 0.07 };
  const add = (id: string, result: Record<string, unknown>, archived = false) => db.prepare(
    `INSERT INTO videos (id, filename, object_key, content_type, status, created_at, updated_at, archived_at, result)
     VALUES (?1, ?1, ?2, 'video/mp4', 'completed', ?3, ?3, ?4, ?5)`).bind(id, `videos/${id}/source`, `2026-10-01T00:00:${id.slice(-2)}+00:00`,
    archived ? '2026-10-02T00:00:00+00:00' : null, JSON.stringify(result)).run();
  const summary = (text: string, labels: string[] = []) => ({ summary: text, labels, sampled_timestamps: [0], thumbs: [0] });

  it('archived videos do not use up candidate slots', async () => {
    const { index } = fakeVectorize();
    for (let i = 10; i < 22; i++) { await add(`arch${i}`, summary('A crocodile in a lake.'), true); await index.upsert([{ id: `s:arch${i}`, values: [1, 0], metadata: { user_id: 'owner' } }]); }
    await add('live01', summary('A crocodile in a lake.'));
    await index.upsert([{ id: 's:live01', values: [0.9, 0.1], metadata: { user_id: 'owner' } }]); // ranks after all 12 archived ones
    const ranked = await search({ db, index, reranker: fakeReranker() }, [1, 0], 'crocodile', T);
    expect(ranked.map((r) => r.job.id)).toEqual(['live01']);
  });

  it('finds label hits even when their vectors are not among the nearest', async () => {
    const { index } = fakeVectorize();
    for (let i = 10; i < 22; i++) { await add(`ball${i}`, summary('A soccer match.', ['soccer'])); await index.upsert([{ id: `s:ball${i}`, values: [1, 0], metadata: { user_id: 'owner' } }]); }
    await add('croc01', summary('A crocodile slides into a lake.', ['crocodile'])); // no vectors at all
    const ranked = await search({ db, index, reranker: fakeReranker() }, [1, 0], 'animals', T);
    expect(ranked.map((r) => [r.job.id, r.retrieval.matched_by])).toEqual([['croc01', 'label']]);
  });
});

describe('Google sign-in on more than one domain', () => {
  it('redirects back to the domain the owner started on, if it is one of ours', async () => {
    const googleConfig = { clientId: 'cid', clientSecret: 's', encKey: 'ab'.repeat(32), redirectUri: 'https://spotted.haciensus.com/oauth/google/callback' };
    const app = appDeps(db, { googleConfig, origins: ['https://spotted.haciensus.com', 'https://www.spotted.example'] });
    const start = async (host: string) => new URL((await handle(req(`https://${host}/oauth/google/start`), app)).headers.get('location')!).searchParams.get('redirect_uri');
    expect(await start('www.spotted.example')).toBe('https://www.spotted.example/oauth/google/callback');
    expect(await start('spotted.haciensus.com')).toBe('https://spotted.haciensus.com/oauth/google/callback');
    expect(await start('evil.example')).toBe('https://spotted.haciensus.com/oauth/google/callback'); // not ours: the default
  });
});

describe('uploads and playback through the Worker (no R2 API token)', () => {
  it('uploads, confirms, then streams the original with byte ranges', async () => {
    const objects: Record<string, any> = {};
    const app = appDeps(db, { presigner: null, bucket: fakeBucket(objects) });
    const bytes = new Uint8Array(Array.from({ length: 20 }, (_, i) => i));
    const created = await (await handle(req('https://spotted.test/videos/uploads', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: 'clip.mp4', content_type: 'video/mp4', size_bytes: bytes.length }) }), app)).json() as any;
    const id = created.request.id;
    expect(created.upload).toMatchObject({ url: `/videos/${id}/upload`, method: 'PUT', headers: { 'Content-Type': 'video/mp4' } });
    const put = (body: Uint8Array, type = 'video/mp4') => handle(req(`https://spotted.test/videos/${id}/upload`, { method: 'PUT',
      headers: { 'Content-Type': type, 'Content-Length': String(body.length) }, body }), app);
    expect((await put(bytes.slice(0, 5))).status).toBe(400);          // wrong size
    expect((await put(bytes, 'video/quicktime')).status).toBe(400);   // wrong type
    expect((await put(bytes)).status).toBe(200);
    expect((await handle(req(`https://spotted.test/videos/${id}/complete`, { method: 'POST' }), app)).status).toBe(202);
    expect((await put(bytes)).status).toBe(409);                      // no second upload after completion
    const video = await (await handle(req(`https://spotted.test/videos/${id}`), app)).json() as any;
    expect(video.download_url).toBe(`/videos/${id}/source`);
    const get = (range?: string) => handle(req(`https://spotted.test/videos/${id}/source`, { headers: range ? { Range: range } : {} }), app);
    const whole = await get();
    expect(whole.status).toBe(200);
    expect(whole.headers.get('accept-ranges')).toBe('bytes');
    expect([...new Uint8Array(await whole.arrayBuffer())]).toEqual([...bytes]);
    const part = await get('bytes=2-5');
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe('bytes 2-5/20');
    expect([...new Uint8Array(await part.arrayBuffer())]).toEqual([2, 3, 4, 5]);
    const tail = await get('bytes=-3');
    expect([...new Uint8Array(await tail.arrayBuffer())]).toEqual([17, 18, 19]);
    expect((await get('bytes=50-')).status).toBe(416);
    const head = await handle(req(`https://spotted.test/videos/${id}/source`, { method: 'HEAD' }), app);
    expect([head.status, head.headers.get('content-length')]).toEqual([200, '20']);
  });
});

describe('one library per user', () => {
  it('a user never sees, plays, changes or deletes another user\'s video', async () => {
    const objects: Record<string, any> = {};
    const app = appDeps(db, { presigner: null, bucket: fakeBucket(objects) });
    const mine = await store.createVideo(db, { userId: 'owner', filename: 'mine.mp4', contentType: 'video/mp4', size: 4 });
    objects[mine.object_key] = { size: 4, contentType: 'video/mp4', body: new Uint8Array(4) };
    await store.markUploaded(db, mine.id);
    const other = authed(await signIn(db, { id: 'g:2', email: 'other@example.com' }));
    expect((await (await handle(other('https://x/videos'), app)).json<any>()).items).toEqual([]);
    for (const path of [`/videos/${mine.id}`, `/videos/${mine.id}/source`, `/videos/${mine.id}/thumbs/0`]) {
      expect((await handle(other(`https://x${path}`), app)).status, path).toBe(404);
    }
    expect((await handle(other(`https://x/videos/${mine.id}/archive`, { method: 'POST' }), app)).status).toBe(404);
    expect((await handle(other(`https://x/videos/${mine.id}`, { method: 'DELETE' }), app)).status).toBe(404);
    expect(await store.getVideo(db, mine.id)).not.toBeNull();
    expect((await (await handle(req('https://x/videos'), app)).json<any>()).items.map((v: any) => v.id)).toEqual([mine.id]);
  });

  it('search filters vectors and label hits by user', async () => {
    const { index } = fakeVectorize();
    const add = async (id: string, userId: string) => {
      await db.prepare(`INSERT INTO videos (id, filename, object_key, content_type, status, created_at, updated_at, result, user_id)
        VALUES (?1, ?1, ?2, 'video/mp4', 'completed', '2026-10-01', '2026-10-01', ?3, ?4)`).bind(id, `videos/${id}/source`,
        JSON.stringify({ summary: 'A crocodile in a lake.', labels: ['crocodile'], sampled_timestamps: [0], thumbs: [0] }), userId).run();
      await index.upsert([{ id: `s:${id}`, values: [1, 0], metadata: { user_id: userId, kind: 'summary' } }]);
    };
    await add('owner01', 'owner');
    await add('guest01', 'g:3');
    const T = { minScore: 0.02, softMinScore: 0.008, minSimilarity: 0.53, vectorMargin: 0.07 };
    expect((await search({ db, index, reranker: fakeReranker() }, [1, 0], 'crocodile', T, 'g:3')).map((r) => r.job.id)).toEqual(['guest01']);
    expect((await search({ db, index, reranker: fakeReranker() }, [1, 0], 'animals', T, 'owner')).map((r) => r.job.id)).toEqual(['owner01']);
  });

  it('guests stop at their video and storage limits, and deleting frees them; the owner has none', async () => {
    const app = appDeps(db, { settings: { ...settings, publicLimits: true, guestMaxVideos: 2, guestMaxBytes: 1000 } });
    const guest = authed(await signIn(db, { id: 'g:4', email: 'g4@example.com' }));
    const upload = (as: typeof req, size: number) => handle(as('https://x/videos/uploads', { method: 'POST', body: JSON.stringify({ filename: 'a.mp4', content_type: 'video/mp4', size_bytes: size }) }), app);
    expect((await upload(guest, 2000)).status).toBe(413);
    const first = await (await upload(guest, 400)).json<any>();
    expect((await upload(guest, 400)).status).toBe(201);
    const full = await upload(guest, 10);
    expect([full.status, (await full.json<any>()).detail]).toEqual([429, "You've reached your limit of 2 videos. Delete a video to add more."]);
    expect((await handle(guest('https://x/photos/sessions', { method: 'POST' }), app)).status).toBe(429);
    expect(await (await handle(guest(`https://x/videos/${first.request.id}`, { method: 'DELETE' }), app)).json()).toEqual({ id: first.request.id, deleted: true });
    expect((await upload(guest, 10)).status).toBe(201);
    for (let i = 0; i < 3; i++) expect((await upload(req, 2000)).status).toBe(201); // the owner
  });

  it('guests get their own daily search limit; Drive is the owner\'s', async () => {
    const app = appDeps(db, { settings: { ...settings, publicLimits: true, guestDailySearches: 1 } });
    const guest = authed(await signIn(db, { id: 'g:5', email: 'g5@example.com' }));
    await handle(guest('https://x/search?q=x'), app);
    const second = await handle(guest('https://x/search?q=x'), app);
    expect([second.status, (await second.json<any>()).detail]).toEqual([429, "You've used today's 1 searches. Searches reset at midnight UTC."]);
    expect((await handle(guest('https://x/drive/folder', { method: 'PUT', body: '{"folder":"x"}' }), app)).status).toBe(403);
    expect((await (await handle(guest('https://x/google/status'), app)).json<any>()).drive_available).toBe(false);
    expect((await (await handle(req('https://x/google/status'), app)).json<any>()).drive_available).toBe(true);
  });
});
