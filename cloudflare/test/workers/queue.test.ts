/** D1 queue and ingestion tests inside workerd against a local Miniflare D1. */
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { handle, reserve } from '../../src/api';
import { drain } from '../../src/ingest';
import * as queue from '../../src/queue';
import * as store from '../../src/store';
import { appDeps, fakeBucket, fakeEmbedder, fakeGemini, FakeGeminiOptions, fakeVectorize, settings } from '../helpers';

const db: D1Database = env.DB;

beforeEach(async () => {
  await db.batch(['jobs', 'videos', 'usage_counters'].map((t) => db.prepare(`DELETE FROM ${t}`)));
});

const enqueue = (kind = 'test', runAfter = 1000) => queue.enqueueStmt(db, kind, { n: 1 }, runAfter, runAfter).run();
const row = (id: number) => db.prepare('SELECT * FROM jobs WHERE id=?1').bind(id).first<any>();

describe('D1 lease queue (owner-approved statements)', () => {
  it('double claim: only one consumer wins', async () => {
    await enqueue();
    const [a, b] = await Promise.all([queue.claim(db, 1000, 'token-a'), queue.claim(db, 1000, 'token-b')]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    const winner = (a ?? b)!;
    expect(winner).toMatchObject({ status: 'running', attempts: 1, locked_until: 1300, payload: { n: 1 } });
    expect(await queue.claim(db, 1001, 'token-c')).toBeNull();
  });

  it('respects run_after', async () => {
    await enqueue('test', 2000);
    expect(await queue.claim(db, 1999)).toBeNull();
    expect(await queue.claim(db, 2000)).not.toBeNull();
  });

  it('reclaims an expired lease and increments attempts', async () => {
    await enqueue();
    const first = (await queue.claim(db, 1000, 'first'))!;
    expect(await queue.claim(db, 1299, 'second')).toBeNull(); // lease still held at 1299
    const second = (await queue.claim(db, 1301, 'second'))!;
    expect(second).toMatchObject({ id: first.id, attempts: 2, lease_token: 'second', locked_until: 1601 });
  });

  it('rejects completion with a stale lease token (fencing)', async () => {
    await enqueue();
    const stale = (await queue.claim(db, 1000, 'stale'))!;
    const fresh = (await queue.claim(db, 1301, 'fresh'))!;
    expect(await queue.commit(db, [queue.completeStmt(db, stale, 1302)])).toBe(false);
    expect(await queue.commit(db, [queue.failStmt(db, stale, 'late', 1302)])).toBe(false);
    expect((await row(stale.id)).status).toBe('running');
    expect(await queue.commit(db, [queue.completeStmt(db, fresh, 1303)])).toBe(true);
    expect(await row(fresh.id)).toMatchObject({ status: 'done', lease_token: null });
  });

  it('stale consumers cannot enqueue follow-up work or touch the video', async () => {
    await enqueue();
    const stale = (await queue.claim(db, 1000, 'stale'))!;
    await queue.claim(db, 1301, 'fresh');
    await queue.commit(db, [queue.enqueueNextStmt(db, stale, 'next', {}, 1302, 1302), queue.completeStmt(db, stale, 1302)]);
    expect((await db.prepare("SELECT count(*) AS n FROM jobs WHERE kind='next'").first<any>()).n).toBe(0);
  });

  it('backs off quadratically and dead-letters after five attempts', async () => {
    await enqueue();
    let now = 1000;
    const delays: number[] = [];
    for (let attempt = 1; attempt <= 5; attempt++) {
      const job = (await queue.claim(db, now, `t${attempt}`))!;
      expect(job.attempts).toBe(attempt);
      expect(await queue.commit(db, [queue.failStmt(db, job, `boom ${attempt}`, now)])).toBe(true);
      const after = await row(job.id);
      delays.push(after.run_after - now);
      expect(after.last_error).toBe(`boom ${attempt}`);
      if (attempt < 5) {
        expect(after.status).toBe('queued');
        expect(await queue.claim(db, after.run_after - 1)).toBeNull(); // backoff not yet elapsed
        now = after.run_after;
      } else {
        expect(after.status).toBe('dead');
      }
    }
    expect(delays).toEqual([30, 120, 270, 480, 750]);
    expect(await queue.claim(db, now + 10_000)).toBeNull(); // dead jobs are never claimed
  });
});

describe('ingestion chain and API on D1', () => {
  function ingestDeps(opts: FakeGeminiOptions = {}, objects: Record<string, { size: number; contentType: string }> = {}, index = fakeVectorize().index) {
    const fake = fakeGemini(opts);
    return { deps: { db, bucket: fakeBucket(objects), index, gemini: fake.gemini, embedder: fakeEmbedder(), settings }, log: fake.log };
  }

  async function queuedVideo(name = 'clip.mp4', contentType = 'video/mp4') {
    const video = await store.createVideo(db, { filename: name, contentType, size: 100 });
    expect(await store.markUploadedAndEnqueue(db, video.id)).toBe(true);
    return video;
  }

  /** Run cron ticks, making delayed jobs due between ticks. */
  async function ticks(deps: any, count: number) {
    const outcomes: string[] = [];
    for (let i = 0; i < count; i++) {
      await db.prepare("UPDATE jobs SET run_after = 0 WHERE status='queued'").run();
      outcomes.push(...(await drain(deps, { maxSteps: 6 })));
    }
    return outcomes;
  }

  it('enqueues exactly once per confirmed upload', async () => {
    const video = await queuedVideo();
    expect(await store.markUploadedAndEnqueue(db, video.id)).toBe(false);
    const jobs = await db.prepare('SELECT kind, payload FROM jobs').all<any>();
    expect(jobs.results).toEqual([{ kind: 'ingest.upload', payload: JSON.stringify({ video_id: video.id }) }]);
  });

  it('runs upload -> await_file -> tag -> index, then serves search and query', async () => {
    const vectors = fakeVectorize();
    const video = await queuedVideo('towel.mp4');
    const { deps, log } = ingestDeps({ states: ['PROCESSING', 'ACTIVE'], answer: { answer: 'Someone folds a towel [1].', citations: [1] } },
      { [video.object_key]: { size: 100, contentType: 'video/mp4' } }, vectors.index);
    const outcomes = await ticks(deps, 3);
    expect(outcomes).toEqual(['ingest.upload:uploaded', 'ingest.await_file:waiting', 'ingest.await_file:active',
      'ingest.tag:tagged', 'ingest.index:completed']);
    expect(log.at(-1)).toBe('DELETE /v1beta/files/abc');
    const done = (await store.getVideo(db, video.id))!;
    expect(done.status).toBe('completed');
    expect(done.result).toMatchObject({ duration_seconds: 20, sampled_timestamps: [2, 12.5], frame_indices: [], model: 'gemini-test' });
    expect([...vectors.store.keys()].sort()).toEqual([`d:${video.id}`, `f:${video.id}:0`, `f:${video.id}:1`, `v:${video.id}`]);
    expect((await db.prepare("SELECT count(*) AS n FROM jobs WHERE status != 'done'").first<any>()).n).toBe(0);

    const app = appDeps(db, { index: vectors.index, gemini: deps.gemini });
    const search = await (await handle(new Request('https://x/search?q=folding%20towel'), app)).json<any>();
    expect(search.items.map((i: any) => i.id)).toEqual([video.id]);
    expect(search.items[0].retrieval.citation).toMatchObject({ timestamp_seconds: 12.5, image_url: null });
    const answer = await (await handle(new Request('https://x/query', { method: 'POST', body: JSON.stringify({ q: 'show me folding a towel' }) }), app)).json<any>();
    expect(answer).toMatchObject({ answer: 'Someone folds a towel [1].', answer_source: 'gemini' });
    const none = await (await handle(new Request('https://x/query', { method: 'POST', body: JSON.stringify({ q: 'volcano eruption' }) }), app)).json<any>();
    expect(none.items).toEqual([]);
    expect((await (await handle(new Request('https://x/videos?tags=Towel'), app)).json<any>()).items).toHaveLength(1);

    // A similar second video is flagged as a possible duplicate (advisory only).
    const twin = await queuedVideo('towel-copy.mp4');
    await ticks(ingestDeps({}, { [twin.object_key]: { size: 100, contentType: 'video/mp4' } }, vectors.index).deps, 2);
    expect((await store.getVideo(db, twin.id))!.result.possible_duplicate).toMatchObject({ request_id: video.id, similarity: 1 });
  });

  it('transient model failures retry; permanent ones fail the video immediately', async () => {
    const video = await queuedVideo();
    const objects = { [video.object_key]: { size: 100, contentType: 'video/mp4' } };
    const outage = ingestDeps({ tagStatus: 503 }, objects).deps;
    const outcomes = await ticks(outage, 2);
    expect(outcomes).toContain('ingest.tag:retry');
    expect((await store.getVideo(db, video.id))!).toMatchObject({ status: 'pending', error: 'Gemini is temporarily unavailable; retry later' });
    const quota = ingestDeps({ tagStatus: 429 }, objects).deps;
    expect(await ticks(quota, 1)).toEqual(['ingest.tag:dead']);
    expect((await store.getVideo(db, video.id))!).toMatchObject({ status: 'failed', error: expect.stringMatching(/quota/) });
  });

  it('rejects over-long videos and unsupported formats', async () => {
    const video = await queuedVideo();
    await ticks(ingestDeps({ duration: '601s' }, { [video.object_key]: { size: 100, contentType: 'video/mp4' } }).deps, 2);
    expect(await store.getVideo(db, video.id)).toMatchObject({ status: 'failed', error: 'Video exceeds the 600-second duration limit' });
    const mkv = await queuedVideo('a.mkv', 'video/x-matroska');
    await ticks(ingestDeps().deps, 1);
    expect((await store.getVideo(db, mkv.id))!.error).toMatch(/Unsupported video format/);
  });

  it('a job reclaimed after too many crashes is dead-lettered', async () => {
    const video = await queuedVideo();
    await db.prepare("UPDATE jobs SET status='running', attempts=5, locked_until=0, last_error='worker died'").run();
    expect(await ticks(ingestDeps().deps, 1)).toEqual(['ingest.upload:dead']);
    expect(await store.getVideo(db, video.id)).toMatchObject({ status: 'failed', error: 'worker died' });
  });

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
    expect((await db.prepare('SELECT count(*) AS n FROM jobs').first<any>()).n).toBe(1);
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
