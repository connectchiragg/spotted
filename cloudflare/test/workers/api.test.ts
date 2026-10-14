/** API tests inside workerd against a local Miniflare D1 (uploads, budgets, expiry). */
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { handle, reserve } from '../../src/api';
import * as store from '../../src/store';
import { appDeps, fakeBucket, settings } from '../helpers';

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
