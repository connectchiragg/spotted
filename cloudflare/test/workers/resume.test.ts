/**
 * Idempotent, resumable ingestion inside workerd against a local Miniflare D1:
 * reclaimed jobs resume from step_results instead of repeating Gemini calls,
 * stale holders change nothing, and the lease heartbeat extends or aborts.
 */
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { handle, reserve } from '../../src/api';
import { geminiFileName } from '../../src/gemini';
import { drain, getStep, IngestDeps, runJob } from '../../src/ingest';
import * as queue from '../../src/queue';
import * as store from '../../src/store';
import { appDeps, defaultTagging, fakeBucket, fakeEmbedder, fakeGemini, FakeGeminiOptions, fakeVectorize, settings } from '../helpers';

const db: D1Database = env.DB;

beforeEach(async () => {
  await db.batch(['jobs', 'videos', 'usage_counters', 'step_results', 'usage_events'].map((t) => db.prepare(`DELETE FROM ${t}`)));
});

/** A D1 handle whose batch() throws: the worker "dies" at its fenced commit, after the external call. */
function crashingDb(real: D1Database): D1Database {
  return new Proxy(real, {
    get(target, key) {
      if (key === 'batch') return async () => { throw new Error('worker killed'); };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** Wait `ms`, or reject as soon as the request is aborted (like a real in-flight fetch). */
const hold = (ms: number) => (signal?: AbortSignal | null) => new Promise<void>((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); });
});

async function setup(opts: FakeGeminiOptions = {}) {
  const video = await store.createVideo(db, { filename: 'clip.mp4', contentType: 'video/mp4', size: 100 });
  expect(await store.markUploadedAndEnqueue(db, video.id)).toBe(true);
  const fake = fakeGemini(opts);
  const deps: IngestDeps = { db, bucket: fakeBucket({ [video.object_key]: { size: 100, contentType: 'video/mp4' } }),
    index: fakeVectorize().index, gemini: fake.gemini, embedder: fakeEmbedder(), settings };
  return { video, fake, deps };
}

/** Make queued jobs due, then run at most `maxSteps` steps. */
async function steps(deps: IngestDeps, maxSteps: number) {
  await db.prepare("UPDATE jobs SET run_after = 0 WHERE status='queued'").run();
  return drain(deps, { maxSteps });
}

/** Run upload and await_file, leaving the ingest.tag job due. */
async function toTagJob(opts: FakeGeminiOptions) {
  const ctx = await setup(opts);
  await steps(ctx.deps, 1);
  await steps(ctx.deps, 1);
  await db.prepare("UPDATE jobs SET run_after = 0 WHERE status='queued'").run();
  return ctx;
}

/** The lease of every running job expires (the crashed worker never comes back). */
const expireLeases = () => db.prepare("UPDATE jobs SET locked_until = 0 WHERE status='running'").run();
const jobCount = async (kind: string) => (await db.prepare('SELECT count(*) AS n FROM jobs WHERE kind=?1').bind(kind).first<any>()).n;

describe('resume after a crash', () => {
  it('a crash after the Gemini upload: the reclaimed job reuses the recorded file and never uploads again', async () => {
    const { video, fake, deps } = await setup();
    await expect(steps({ ...deps, db: crashingDb(db) }, 1)).rejects.toThrow('worker killed');
    expect(fake.counts.uploads).toBe(1);
    expect(await getStep(db, video.id, 'upload')).toMatchObject({ name: geminiFileName(video.id) });
    expect(await db.prepare("SELECT status FROM jobs WHERE kind='ingest.upload'").first()).toEqual({ status: 'running' });

    await expireLeases();
    const outcomes = [...await steps(deps, 6), ...await steps(deps, 6)];
    expect(outcomes).toEqual(['ingest.upload:uploaded', 'ingest.await_file:active', 'ingest.tag:tagged', 'ingest.index:completed']);
    expect(fake.counts.uploads).toBe(1);
    expect(fake.log.filter((l) => l.startsWith('POST /upload'))).toHaveLength(1);
    expect((await store.getVideo(db, video.id))!.status).toBe('completed');
  });

  it('a crash after the upload whose record was lost: the file is found by its deterministic name', async () => {
    const { video, fake, deps } = await setup();
    await expect(steps({ ...deps, db: crashingDb(db) }, 1)).rejects.toThrow('worker killed');
    await db.prepare('DELETE FROM step_results').run(); // e.g. the worker died before recording
    await expireLeases();
    expect(await steps(deps, 1)).toEqual(['ingest.upload:uploaded']);
    expect(fake.counts.uploads).toBe(1);
    expect(await getStep(db, video.id, 'upload')).toMatchObject({ name: geminiFileName(video.id) });
  });

  it('an expired recorded file is uploaded again under the same name', async () => {
    const { video, fake, deps } = await setup();
    await expect(steps({ ...deps, db: crashingDb(db) }, 1)).rejects.toThrow('worker killed');
    fake.files.clear(); // Gemini expired it (48 h)
    await expireLeases();
    expect(await steps(deps, 1)).toEqual(['ingest.upload:uploaded']);
    expect(fake.counts.uploads).toBe(2);
    expect([...fake.files.keys()]).toEqual([geminiFileName(video.id)]);
  });

  it('a crash after generateContent: the reclaimed job skips the call and continues to index', async () => {
    const { video, fake, deps } = await setup();
    expect(await steps(deps, 1)).toEqual(['ingest.upload:uploaded']);
    expect(await steps(deps, 1)).toEqual(['ingest.await_file:active']);
    await expect(steps({ ...deps, db: crashingDb(db) }, 1)).rejects.toThrow('worker killed');
    expect(fake.counts.generate).toBe(1);
    expect(await getStep(db, video.id, 'tag')).toMatchObject({ summary: defaultTagging.summary, usage: { totalTokenCount: 1700 } });
    expect(await jobCount('ingest.index')).toBe(0);

    await expireLeases();
    expect(await steps(deps, 6)).toEqual(['ingest.tag:tagged', 'ingest.index:completed']);
    expect(fake.counts.generate).toBe(1);
    const done = (await store.getVideo(db, video.id))!;
    expect(done).toMatchObject({ status: 'completed' });
    expect(done.result).toMatchObject({ summary: defaultTagging.summary, sampled_timestamps: [2, 12.5], usage: { totalTokenCount: 1700 } });
  });
});

describe('stale and new holders', () => {
  it('a stale holder finishing late changes nothing; the new holder\'s result wins', async () => {
    const { video, deps } = await toTagJob({ tagGate: hold(150), tagging: { ...defaultTagging, summary: 'Stale holder result.' } });
    const stale = (await queue.claim(db, queue.nowSeconds(), 'stale'))!;
    expect(stale.kind).toBe('ingest.tag');
    const staleRun = runJob(deps, stale); // generateContent held open for 150 ms

    await expireLeases();
    const fresh = (await queue.claim(db, queue.nowSeconds(), 'fresh'))!;
    expect(fresh).toMatchObject({ id: stale.id, lease_token: 'fresh', attempts: 2 });
    const freshDeps = { ...deps, gemini: fakeGemini().gemini };
    expect(await runJob(freshDeps, fresh)).toBe('tagged');

    expect(await staleRun).toBe('lease-lost');
    expect(await jobCount('ingest.index')).toBe(1);
    expect((await getStep<any>(db, video.id, 'tag')).summary).toBe(defaultTagging.summary); // first writer (fresh) kept
    expect(await steps(freshDeps, 1)).toEqual(['ingest.index:completed']);
    expect((await store.getVideo(db, video.id))!.result.summary).toBe(defaultTagging.summary);
  });

  it('two consumers claiming at once: exactly one wins the job', async () => {
    const { deps } = await setup();
    const [a, b] = await Promise.all([drain(deps, { maxSteps: 1 }), drain(deps, { maxSteps: 1 })]);
    expect([...a, ...b]).toEqual(['ingest.upload:uploaded']);
    expect(await jobCount('ingest.await_file')).toBe(1);
  });
});

describe('lease heartbeat', () => {
  it('extends locked_until while a long call runs, so a healthy worker keeps its lease', async () => {
    const { deps } = await toTagJob({ tagGate: hold(200) });
    const job = (await queue.claim(db))!;
    const now = queue.nowSeconds();
    await db.prepare('UPDATE jobs SET locked_until=?1 WHERE id=?2').bind(now + 1, job.id).run(); // nearly expired
    const run = runJob({ ...deps, heartbeatMs: 30 }, job);
    await new Promise((r) => setTimeout(r, 100));
    const during = await db.prepare('SELECT locked_until, lease_token FROM jobs WHERE id=?1').bind(job.id).first<any>();
    expect(during.lease_token).toBe(job.lease_token);
    expect(during.locked_until).toBeGreaterThanOrEqual(now + queue.LEASE_SECONDS);
    expect(await queue.claim(db, now + 2, 'thief')).toBeNull(); // would have been reclaimable without the heartbeat
    expect(await run).toBe('tagged');
  });

  it('a heartbeat that finds the lease lost aborts the call and writes nothing', async () => {
    const { video, fake, deps } = await toTagJob({ tagGate: hold(5000) });
    const job = (await queue.claim(db))!;
    const run = runJob({ ...deps, heartbeatMs: 30 }, job);
    await new Promise((r) => setTimeout(r, 10));
    await expireLeases();
    const thief = (await queue.claim(db, queue.nowSeconds(), 'thief'))!;
    expect(thief.id).toBe(job.id);
    const started = Date.now();
    expect(await run).toBe('lease-lost');
    expect(Date.now() - started).toBeLessThan(1000); // aborted, not waited out
    expect(fake.counts.generate).toBe(1);
    expect(await getStep(db, video.id, 'tag')).toBeNull();
    expect(await jobCount('ingest.index')).toBe(0);
    expect(await db.prepare('SELECT status, lease_token FROM jobs WHERE id=?1').bind(job.id).first()).toEqual({ status: 'running', lease_token: 'thief' });
    expect((await store.getVideo(db, video.id))!.status).toBe('processing');
  });

  it('heartbeat is fenced by lease_token and never shortens a lease', async () => {
    await queue.enqueueStmt(db, 'test', {}, 1000, 1000).run();
    const job = (await queue.claim(db, 1000, 'mine'))!;
    expect(await queue.heartbeat(db, job, 1100)).toBe(true);
    expect(job.locked_until).toBe(1400);
    expect(await queue.heartbeat(db, job, 1050)).toBe(true);
    expect(job.locked_until).toBe(1400);
    const thief = (await queue.claim(db, 1401, 'thief'))!;
    expect(await queue.heartbeat(db, job, 1402)).toBe(false);
    expect(await db.prepare('SELECT locked_until, lease_token FROM jobs WHERE id=?1').bind(thief.id).first()).toEqual({ locked_until: 1701, lease_token: 'thief' });
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
