/** API tests inside workerd against a local Miniflare D1 (uploads, budgets, expiry). */
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { handle, reserve } from '../../src/api';
import { search } from '../../src/retrieval';
import * as store from '../../src/store';
import { appDeps, fakeBucket, fakeReranker, fakeVectorize, settings } from '../helpers';

const db: D1Database = env.DB;

beforeEach(async () => {
  await db.batch(['videos', 'usage_counters', 'usage_events'].map((t) => db.prepare(`DELETE FROM ${t}`)));
});


describe('upload, budget and expiry API on D1', () => {
  it('upload API: presigned PUT, verified completion, idempotent confirm, archive', async () => {
    const objects: Record<string, { size: number; contentType: string }> = {};
    const app = appDeps(db, { bucket: fakeBucket(objects) });
    const created = await handle(new Request('https://x/videos/uploads', { method: 'POST',
      body: JSON.stringify({ filename: 'trip.mov', content_type: 'video/quicktime', size_bytes: 500, display_name: 'Trip' }) }), app);
    expect(created.status).toBe(201);
    const body = await created.json<any>();
    expect(body.upload).toMatchObject({ method: 'PUT', headers: { 'Content-Type': 'video/quicktime' }, expires_in: 600 });
    const id = body.request.id;
    expect((await handle(new Request(`https://x/videos/${id}/complete`, { method: 'POST' }), app)).status).toBe(409);
    objects[`videos/${id}/source`] = { size: 500, contentType: 'video/quicktime' };
    const done = await handle(new Request(`https://x/videos/${id}/complete`, { method: 'POST' }), app);
    expect(done.status).toBe(202);
    expect(await done.json()).toMatchObject({ status: 'pending', progress: { stage: 'Queued' }, display_name: 'Trip' });
    expect((await handle(new Request(`https://x/videos/${id}/complete`, { method: 'POST' }), app)).status).toBe(202);
    expect((await store.getVideo(db, id))!).toMatchObject({ status: 'pending', uploaded: 1 });
    expect((await (await handle(new Request(`https://x/videos/${id}/archive`, { method: 'POST' }), app)).json<any>()).archived_at).toBeTruthy();
    expect((await (await handle(new Request('https://x/videos'), app)).json<any>()).items).toHaveLength(0);
    await handle(new Request(`https://x/videos/${id}/restore`, { method: 'POST' }), app);
    expect((await (await handle(new Request('https://x/videos'), app)).json<any>()).items).toHaveLength(1);
  });

  it('rejects a stored object whose size does not match', async () => {
    const objects: Record<string, { size: number; contentType: string }> = {};
    const app = appDeps(db, { bucket: fakeBucket(objects) });
    const body = await (await handle(new Request('https://x/videos/uploads', { method: 'POST',
      body: JSON.stringify({ filename: 'a.mp4', content_type: 'video/mp4', size_bytes: 10 }) }), app)).json<any>();
    objects[`videos/${body.request.id}/source`] = { size: 11, contentType: 'video/mp4' };
    expect((await handle(new Request(`https://x/videos/${body.request.id}/complete`, { method: 'POST' }), app)).status).toBe(422);
    expect((await store.getVideo(db, body.request.id))!.status).toBe('failed');
  });

  it('daily budgets stop at the limit', async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => reserve(db, 'upload', 3, '2026-10-14')));
    expect(results.filter(Boolean)).toHaveLength(3);
    const app = appDeps(db, { settings: { ...settings, publicLimits: true, dailyQueryLimit: 0 } });
    expect((await handle(new Request('https://x/query', { method: 'POST', body: '{"q":"x"}' }), app)).status).toBe(429);
    expect((await handle(new Request('https://x/search?q=x'), app)).status).toBe(429);
  });

  it('expires uploads that were never confirmed', async () => {
    const video = await store.createVideo(db, { filename: 'a.mp4', contentType: 'video/mp4', size: 1 });
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
    const post = () => handle(new Request('https://x/videos/uploads', { method: 'POST', headers: { 'Idempotency-Key': 'upload-0001' },
      body: JSON.stringify({ filename: 'a.mp4', content_type: 'video/mp4', size_bytes: 10 }) }), app);
    const first = await (await post()).json<any>();
    const second = await (await post()).json<any>();
    expect(second.request.id).toBe(first.request.id);
    expect(second.upload.url).toContain(first.request.id);
    expect((await db.prepare('SELECT count(*) AS n FROM videos').first<any>()).n).toBe(1);
    expect(await db.prepare("SELECT count FROM usage_counters WHERE operation='upload'").first()).toEqual({ count: 1 });
    const bad = await handle(new Request('https://x/videos/uploads', { method: 'POST', headers: { 'Idempotency-Key': 'x' }, body: '{}' }), app);
    expect(bad.status).toBe(422);
  });
});

describe('identity and Photos import status', () => {
  it('GET /me reads the Access email header, and answers signed_in:false without Access', async () => {
    const app = appDeps(db);
    const signed = await handle(new Request('https://x/me', { headers: { 'Cf-Access-Authenticated-User-Email': 'owner@example.com' } }), app);
    expect(await signed.json()).toEqual({ email: 'owner@example.com', signed_in: true, source: 'access', logout_url: '/cdn-cgi/access/logout' });
    expect(await (await handle(new Request('https://x/me'), app)).json()).toEqual({ email: null, signed_in: false, source: 'none', logout_url: null });
  });

  it('picker session status lists the videos it created; /latest is the newest session or null', async () => {
    await db.prepare('DELETE FROM picker_sessions').run();
    const app = appDeps(db);
    expect(await (await handle(new Request('https://x/photos/sessions/latest'), app)).json()).toBeNull();
    await db.prepare("INSERT INTO picker_sessions (id, picker_uri, status, imported, created_at, updated_at) VALUES ('old', 'u', 'imported', 0, '2026-10-01', '2026-10-01'), ('s9', 'u', 'importing', 0, '2026-10-02', '2026-10-02')").run();
    const { video } = await store.upsertSourceVideo(db, { source: 'photos', sourceId: 'm1', filename: 'a.mp4', contentType: 'video/mp4', size: 10,
      meta: { session_id: 's9' }, status: 'pending' });
    await store.upsertSourceVideo(db, { source: 'photos', sourceId: 'm2', filename: 'b.mp4', contentType: 'video/mp4', size: 10, meta: { session_id: 'old' }, status: 'pending' });
    expect(await (await handle(new Request('https://x/photos/sessions/latest'), app)).json()).toMatchObject({ id: 's9', status: 'importing', video_ids: [video.id] });
    expect(await (await handle(new Request('https://x/photos/sessions/s9'), app)).json()).toMatchObject({ id: 's9', video_ids: [video.id] });
    expect((await handle(new Request('https://x/photos/sessions/nope'), app)).status).toBe(404);
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
    for (let i = 10; i < 22; i++) { await add(`arch${i}`, summary('A crocodile in a lake.'), true); await index.upsert([{ id: `s:arch${i}`, values: [1, 0], metadata: {} }]); }
    await add('live01', summary('A crocodile in a lake.'));
    await index.upsert([{ id: 's:live01', values: [0.9, 0.1], metadata: {} }]); // ranks after all 12 archived ones
    const ranked = await search({ db, index, reranker: fakeReranker() }, [1, 0], 'crocodile', T);
    expect(ranked.map((r) => r.job.id)).toEqual(['live01']);
  });

  it('finds label hits even when their vectors are not among the nearest', async () => {
    const { index } = fakeVectorize();
    for (let i = 10; i < 22; i++) { await add(`ball${i}`, summary('A soccer match.', ['soccer'])); await index.upsert([{ id: `s:ball${i}`, values: [1, 0], metadata: {} }]); }
    await add('croc01', summary('A crocodile slides into a lake.', ['crocodile'])); // no vectors at all
    const ranked = await search({ db, index, reranker: fakeReranker() }, [1, 0], 'animals', T);
    expect(ranked.map((r) => [r.job.id, r.retrieval.matched_by])).toEqual([['croc01', 'label']]);
  });
});
