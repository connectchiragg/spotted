/**
 * Integration tests against real Postgres + pgvector (isolated schema per file).
 * Run with: TEST_POSTGRES_DSN=postgresql://USER@127.0.0.1:54329/irl npm test
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { handle, reserve } from '../src/api';
import { ClosableDb } from '../src/db';
import { drain } from '../src/ingest';
import * as queue from '../src/queue';
import * as store from '../src/store';
import { appDeps, DSN, fakeBucket, fakeEmbedder, fakeGemini, FakeGeminiOptions, isolatedDb, settings } from './helpers';

const suite = DSN ? describe : describe.skip;

suite('Postgres queue and API', () => {
  let db: ClosableDb;
  let drop: () => Promise<void>;
  beforeAll(async () => ({ db, drop } = await isolatedDb()));
  afterAll(async () => drop?.());
  beforeEach(async () => {
    await db.query('TRUNCATE ingest_queue, embeddings, frame_embeddings, usage_counters, jobs CASCADE');
  });

  async function queuedJob(name = 'clip.mp4') {
    const job = await store.createJob(db, { filename: name, contentType: 'video/mp4', size: 100 });
    expect(await store.markUploadedAndEnqueue(db, job.id)).toBe(true);
    return job;
  }

  function ingest(opts: FakeGeminiOptions = {}, objects?: Record<string, { size: number; contentType: string }>) {
    const fake = fakeGemini(opts);
    return { deps: { db, bucket: fakeBucket(objects ?? {}), gemini: fake.gemini, embedder: fakeEmbedder(), settings }, log: fake.log };
  }

  it('enqueues exactly once per upload', async () => {
    const job = await queuedJob();
    expect(await store.markUploadedAndEnqueue(db, job.id)).toBe(false);
    expect(await db.query('SELECT * FROM ingest_queue')).toHaveLength(1);
    expect((await store.getJob(db, job.id))!.status).toBe('pending');
  });

  it('SKIP LOCKED gives a due row to exactly one of many concurrent consumers', async () => {
    await queuedJob();
    const claims = await Promise.all(Array.from({ length: 6 }, () => queue.claim(db)));
    expect(claims.filter(Boolean)).toHaveLength(1);
    const job = await db.query('SELECT status, attempts, claim_token FROM jobs');
    expect(job[0]).toMatchObject({ status: 'processing', attempts: 1, claim_token: claims.find(Boolean)!.lock_token });
  });

  it('re-delivers after the visibility timeout and fences the stale consumer', async () => {
    await queuedJob();
    const first = (await queue.claim(db))!;
    expect(await queue.claim(db)).toBeNull();
    await db.query("UPDATE ingest_queue SET locked_until = now() - interval '1 second'"); // consumer crashed
    const second = (await queue.claim(db))!;
    expect(second.attempts).toBe(2);
    expect(await queue.advance(db, first, 'tag', {}, { stage: 'x', percent: 1, eta_seconds: null })).toBe(false);
    expect(await queue.complete(db, first, { summary: 'stale' })).toBe(false);
    expect(await queue.advance(db, second, 'await_file', { file_name: 'f' }, { stage: 'Sent', percent: 30, eta_seconds: null })).toBe(true);
    const row = (await db.query('SELECT stage, attempts, lock_token FROM ingest_queue'))[0];
    expect(row).toEqual({ stage: 'await_file', attempts: 0, lock_token: null });
  });

  it('retries transient failures with backoff and last_error, then fails terminally', async () => {
    const job = await queuedJob();
    for (let attempt = 1; attempt <= 3; attempt++) {
      await db.query('UPDATE ingest_queue SET run_after = now()');
      const claimed = (await queue.claim(db))!;
      expect(claimed.attempts).toBe(attempt);
      const outcome = await queue.fail(db, claimed, `boom ${attempt}`, true);
      expect(outcome).toBe(attempt < 3 ? 'retry' : 'failed');
      if (attempt < 3) {
        const row = (await db.query("SELECT last_error, run_after > now() + interval '20 seconds' AS later FROM ingest_queue"))[0];
        expect(row).toEqual({ last_error: `boom ${attempt}`, later: true });
        expect(await queue.claim(db)).toBeNull(); // backoff not yet elapsed
      }
    }
    expect(await store.getJob(db, job.id)).toMatchObject({ status: 'failed', error: 'boom 3' });
    expect(await db.query('SELECT 1 FROM ingest_queue')).toHaveLength(0);
  });

  it('sweeps rows whose last attempt crashed', async () => {
    const job = await queuedJob();
    await db.query("UPDATE ingest_queue SET attempts = 3, last_error = 'worker died', locked_until = now() - interval '1 second'");
    expect(await queue.sweepExhausted(db)).toBe(1);
    expect(await store.getJob(db, job.id)).toMatchObject({ status: 'failed', error: 'worker died' });
  });

  it('defer does not consume attempts', async () => {
    await queuedJob();
    const claimed = (await queue.claim(db))!;
    await queue.defer(db, claimed, { polls: 1 }, 0);
    const again = (await queue.claim(db))!;
    expect(again.attempts).toBe(1);
    expect(again.state).toEqual({ polls: 1 });
  });

  it('runs the full ingestion state machine and serves search and query', async () => {
    const job = await queuedJob('towel.mp4');
    const { deps, log } = ingest({ states: ['PROCESSING', 'ACTIVE'], answer: { answer: 'Someone folds a towel [1].', citations: [1] } },
      { [job.object_key]: { size: 100, contentType: 'video/mp4' } });
    const outcomes: string[] = [];
    for (let i = 0; i < 8 && !outcomes.includes('index:completed'); i++) {
      await db.query('UPDATE ingest_queue SET run_after = now()');
      outcomes.push(...(await drain(deps, { maxSteps: 1 })));
    }
    expect(outcomes).toEqual(['upload:uploaded', 'await_file:waiting', 'await_file:active', 'tag:tagged', 'index:completed']);
    expect(log.at(-1)).toBe('DELETE /v1beta/files/abc');
    const done = (await store.getJob(db, job.id))!;
    expect(done.status).toBe('completed');
    expect(done.result).toMatchObject({ duration_seconds: 20, sampled_timestamps: [2, 12.5], frame_indices: [], model: 'gemini-test' });
    expect(await db.query('SELECT model FROM embeddings ORDER BY model')).toEqual([{ model: '@cf/test-embed' }, { model: 'description:@cf/test-embed' }]);
    expect(await db.query('SELECT count(*)::int AS n FROM frame_embeddings')).toEqual([{ n: 2 }]);
    // JSON is stored as real JSONB objects, not double-encoded strings.
    expect(await db.query('SELECT jsonb_typeof(result) AS t FROM jobs WHERE id = $1', [job.id])).toEqual([{ t: 'object' }]);

    const app = appDeps(db, { gemini: deps.gemini });
    const search = await (await handle(new Request('https://x/search?q=folding%20towel'), app)).json() as any;
    expect(search.items.map((i: any) => i.id), JSON.stringify(search)).toEqual([job.id]);
    expect(search.items[0].retrieval.citation).toMatchObject({ timestamp_seconds: 12.5, image_url: null });
    expect(search.items[0].download_url).toContain(job.object_key);
    const answer = await (await handle(new Request('https://x/query', { method: 'POST', body: JSON.stringify({ q: 'show me folding a towel' }) }), app)).json() as any;
    expect(answer).toMatchObject({ answer: 'Someone folds a towel [1].', answer_source: 'gemini' });
    const none = await (await handle(new Request('https://x/query', { method: 'POST', body: JSON.stringify({ q: 'volcano eruption' }) }), app)).json() as any;
    expect(none.items).toEqual([]);
    const tagged = await (await handle(new Request('https://x/videos?tags=Towel'), app)).json() as any;
    expect(tagged.items).toHaveLength(1);

    // Second similar video is flagged as a possible duplicate (advisory only).
    const twin = await queuedJob('towel-copy.mp4');
    const second = ingest({}, { [twin.object_key]: { size: 100, contentType: 'video/mp4' } });
    for (let i = 0; i < 6; i++) {
      await db.query('UPDATE ingest_queue SET run_after = now()');
      await drain(second.deps, { maxSteps: 1 });
    }
    expect((await store.getJob(db, twin.id))!.result.possible_duplicate).toMatchObject({ request_id: job.id, similarity: 1 });
  });

  it('fails permanently on over-long video and unsupported formats', async () => {
    const job = await queuedJob();
    const { deps } = ingest({ duration: '601s' }, { [job.object_key]: { size: 100, contentType: 'video/mp4' } });
    for (let i = 0; i < 3; i++) {
      await db.query('UPDATE ingest_queue SET run_after = now()');
      await drain(deps, { maxSteps: 1 });
    }
    expect(await store.getJob(db, job.id)).toMatchObject({ status: 'failed', error: 'Video exceeds the 600-second duration limit' });
    const mkv = await store.createJob(db, { filename: 'a.mkv', contentType: 'video/x-matroska', size: 1 });
    await store.markUploadedAndEnqueue(db, mkv.id);
    await drain(deps, { maxSteps: 1 });
    expect((await store.getJob(db, mkv.id))!.error).toMatch(/Unsupported video format/);
  });

  it('upload API: presigned PUT, verified completion, idempotent confirm', async () => {
    const objects: Record<string, { size: number; contentType: string }> = {};
    const app = appDeps(db, { bucket: fakeBucket(objects) });
    const created = await handle(new Request('https://x/videos/uploads', { method: 'POST',
      body: JSON.stringify({ filename: 'trip.mov', content_type: 'video/quicktime', size_bytes: 500, display_name: 'Trip' }) }), app);
    expect(created.status).toBe(201);
    const body = await created.json() as any;
    expect(body.upload).toMatchObject({ method: 'PUT', headers: { 'Content-Type': 'video/quicktime' }, expires_in: 600 });
    const id = body.request.id;
    expect((await handle(new Request(`https://x/videos/${id}/complete`, { method: 'POST' }), app)).status).toBe(409);
    objects[`videos/${id}/source`] = { size: 500, contentType: 'video/quicktime' };
    const done = await handle(new Request(`https://x/videos/${id}/complete`, { method: 'POST' }), app);
    expect(done.status).toBe(202);
    expect(await done.json()).toMatchObject({ status: 'pending', progress: { stage: 'Queued' } });
    expect((await handle(new Request(`https://x/videos/${id}/complete`, { method: 'POST' }), app)).status).toBe(202);
    expect(await db.query('SELECT count(*)::int AS n FROM ingest_queue')).toEqual([{ n: 1 }]);
    const archived = await (await handle(new Request(`https://x/videos/${id}/archive`, { method: 'POST' }), app)).json() as any;
    expect(archived.archived_at).toBeTruthy();
    expect((await (await handle(new Request('https://x/videos'), app)).json() as any).items).toHaveLength(0);
    await handle(new Request(`https://x/videos/${id}/restore`, { method: 'POST' }), app);
    expect((await (await handle(new Request('https://x/videos'), app)).json() as any).items).toHaveLength(1);
  });

  it('rejects a stored object whose size does not match', async () => {
    const objects: Record<string, { size: number; contentType: string }> = {};
    const app = appDeps(db, { bucket: fakeBucket(objects) });
    const body = await (await handle(new Request('https://x/videos/uploads', { method: 'POST',
      body: JSON.stringify({ filename: 'a.mp4', content_type: 'video/mp4', size_bytes: 10 }) }), app)).json() as any;
    objects[`videos/${body.request.id}/source`] = { size: 11, contentType: 'video/mp4' };
    expect((await handle(new Request(`https://x/videos/${body.request.id}/complete`, { method: 'POST' }), app)).status).toBe(422);
    expect((await store.getJob(db, body.request.id))!.status).toBe('failed');
  });

  it('daily budgets are atomic under concurrency', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => reserve(db, 'upload', 3, '2026-10-14')));
    expect(results.filter(Boolean)).toHaveLength(3);
    const app = appDeps(db, { settings: { ...settings, publicLimits: true, dailyQueryLimit: 0 } });
    const res = await handle(new Request('https://x/query', { method: 'POST', body: '{"q":"x"}' }), app);
    expect(res.status).toBe(429);
  });

  it('expires uploads that were never confirmed', async () => {
    const job = await store.createJob(db, { filename: 'a.mp4', contentType: 'video/mp4', size: 1 });
    await db.query("UPDATE jobs SET updated_at = '2000-01-01T00:00:00+00:00' WHERE id = $1", [job.id]);
    expect(await store.expireUploads(db)).toBe(1);
    expect((await store.getJob(db, job.id))!.status).toBe('failed');
  });
});
