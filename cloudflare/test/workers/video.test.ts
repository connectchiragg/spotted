/**
 * VideoDO (actor per video) in workerd with the shared Miniflare D1: the step
 * machine, resume after eviction at every step without repeated side effects,
 * alarm backoff and dead-lettering, start() idempotency, the D1 record and SSE.
 * Fake dependencies are registered per video id in VideoDO.testDeps.
 */
import { env, evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { exports } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { geminiFileName } from '../../src/gemini';
import * as store from '../../src/store';
import { EvictionError, IngestState, MAX_ATTEMPTS, MAX_QUOTA_WINDOW_MS, VideoDO } from '../../src/video';
import { handle } from '../../src/api';
import { appDeps, defaultTagging, fakeBucket, fakeEmbedder, fakeGemini, FakeGeminiOptions, fakeVectorize, settings } from '../helpers';

const db: D1Database = env.DB;
const ns = env.VIDEO as DurableObjectNamespace;
const worker = (exports as any).default as Fetcher;

beforeEach(async () => {
  await db.batch(['videos', 'usage_counters', 'usage_events'].map((t) => db.prepare(`DELETE FROM ${t}`)));
});

async function setup(opts: FakeGeminiOptions = {}, filename = 'clip.mp4', contentType = 'video/mp4') {
  const video = await store.createVideo(db, { filename, contentType, size: 100 });
  expect(await store.markUploaded(db, video.id)).toBe(true);
  const fake = fakeGemini(opts);
  const vectors = fakeVectorize();
  VideoDO.testDeps.set(video.id, () => ({ db, bucket: fakeBucket({ [video.object_key]: { size: 100, contentType } }),
    index: vectors.index, gemini: fake.gemini, embedder: fakeEmbedder(), settings }));
  const stub = ns.get(ns.idFromName(video.id)) as any;
  const state = (): Promise<IngestState | null> => stub.getState();
  const alarmAt = () => runInDurableObject<VideoDO, number | null>(stub, (_o, s) => s.storage.getAlarm());
  /** Fire the alarm (if Miniflare hasn't already) until the state is terminal or `until` holds. */
  const drive = async (until: (s: IngestState) => boolean = () => false, max = 40) => {
    for (let i = 0; i < max; i++) {
      const s = await state();
      if (s && (s.step === 'done' || s.step === 'failed' || until(s))) return s;
      try {
        await runDurableObjectAlarm(stub);
      } catch (error) {
        if (!(error instanceof EvictionError) && !String(error).includes('evicted')) throw error;
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    return state();
  };
  /** Make a pending backoff due now (instead of waiting minutes). */
  const skipWait = () => runInDurableObject<VideoDO, void>(stub, async (_o, s) => {
    const st = await s.storage.get<IngestState>('state');
    await s.storage.put('state', { ...st!, next_retry_at: null });
    await s.storage.setAlarm(Date.now());
  });
  return { video, fake, vectors, stub, state, alarmAt, drive, skipWait };
}

describe('VideoDO: ingestion run by the per-video actor', () => {
  it('runs upload -> await_file -> tag -> index; start() is idempotent; the D1 record matches', async () => {
    const t = await setup({ states: ['PROCESSING', 'ACTIVE'] });
    const starts = await Promise.all([t.stub.start(t.video.id), t.stub.start(t.video.id), t.stub.start(t.video.id)]);
    expect(new Set(starts.map((s: IngestState) => s.version)).size).toBe(1);
    // The PROCESSING poll sets a 5 s alarm; make it due.
    const waiting = await t.drive((s) => s.step === 'await_file' && s.polls > 0);
    if (waiting?.step === 'await_file') await t.skipWait();
    const done = (await t.drive())!;
    expect(done.step).toBe('done');
    expect(t.fake.counts).toEqual({ uploads: 1, generate: 1 });
    expect(done.keys).toEqual({ upload: `${t.video.id}:upload`, tag: `${t.video.id}:tag`, index: `${t.video.id}:index` });
    expect(await t.stub.start(t.video.id)).toMatchObject({ step: 'done', version: done.version }); // idempotent after done too
    const row = (await store.getVideo(db, t.video.id))!;
    expect(row).toMatchObject({ status: 'completed', error: null, progress: null, state_version: done.version });
    expect(row.result).toMatchObject({ summary: defaultTagging.summary, sampled_timestamps: [2, 12.5], usage: { totalTokenCount: 1700 } });
    expect([...t.vectors.store.keys()].sort()).toEqual([`d:${t.video.id}`, `f:${t.video.id}:0`, `f:${t.video.id}:1`, `v:${t.video.id}`]);
    expect(t.fake.log.at(-1)).toBe(`DELETE /v1beta/${geminiFileName(t.video.id)}`);
    expect(await t.alarmAt()).toBeNull(); // nothing pending: no alarm
  });

  for (const point of ['upload:returned', 'upload:recorded', 'await_file:recorded', 'tag:recorded', 'tag:committed', 'index:recorded']) {
    it(`resumes after an eviction at ${point} without repeating a side effect`, async () => {
      const t = await setup();
      let crashed = false;
      VideoDO.testHooks.set(t.video.id, (p) => {
        if (p === point && !crashed) { crashed = true; throw new EvictionError(`evicted at ${p}`); }
      });
      await t.stub.start(t.video.id);
      await t.drive((s) => crashed && s.step !== 'done');
      expect(crashed).toBe(true);
      await evictDurableObject(t.stub); // memory gone; only durable state survives
      await t.stub.start(t.video.id); // e.g. the safety-net nudge; re-arms the alarm if needed
      const done = (await t.drive())!;
      expect(done.step).toBe('done');
      expect(t.fake.counts).toEqual({ uploads: 1, generate: 1 });
      expect((await store.getVideo(db, t.video.id))!).toMatchObject({ status: 'completed', state_version: done.version });
      VideoDO.testHooks.delete(t.video.id);
    });
  }

  it('backs off through its alarm (30 s * attempts^2) and fails after MAX_ATTEMPTS', async () => {
    const t = await setup({ uploadStatus: 503 });
    await t.stub.start(t.video.id);
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const before = Date.now();
      const s = (await t.drive((x) => x.attempts === attempt && x.next_retry_at !== null))!;
      if (attempt < MAX_ATTEMPTS) {
        expect(s).toMatchObject({ step: 'upload', attempts: attempt, last_error: 'Gemini is temporarily unavailable; retry later' });
        const delay = s.next_retry_at! - before;
        expect(delay).toBeGreaterThanOrEqual(30_000 * attempt * attempt - 1000);
        expect(delay).toBeLessThanOrEqual(30_000 * attempt * attempt + 1000);
        expect(await t.alarmAt()).toBe(s.next_retry_at);
        expect((await store.getVideo(db, t.video.id))!).toMatchObject({ status: 'pending', error: 'Gemini is temporarily unavailable; retry later' });
        await t.skipWait();
      } else {
        expect(s.step).toBe('failed');
      }
    }
    expect((await store.getVideo(db, t.video.id))!).toMatchObject({ status: 'failed', error: 'Gemini is temporarily unavailable; retry later' });
    expect(await t.alarmAt()).toBeNull();
    expect(t.fake.counts.uploads).toBe(0);
  });

  it('waits out a Gemini 429 for its RetryInfo delay', async () => {
    const t = await setup({ tagStatus: 429 });
    await t.stub.start(t.video.id);
    const before = Date.now();
    const s = (await t.drive((x) => x.step === 'tag' && x.next_retry_at !== null))!;
    expect(s.next_retry_at! - before).toBeGreaterThanOrEqual(119_000);
    expect(s.next_retry_at! - before).toBeLessThanOrEqual(121_000);
    expect(await t.alarmAt()).toBe(s.next_retry_at);
  });

  it('a quota 429 waits without using up failure attempts; the D1 row keeps the step percent', async () => {
    const t = await setup({ tagStatus: 429 });
    await t.stub.start(t.video.id);
    for (let wait = 1; wait <= MAX_ATTEMPTS + 2; wait++) {
      const s = (await t.drive((x) => x.step === 'tag' && x.next_retry_at !== null))!;
      expect(s).toMatchObject({ step: 'tag', attempts: 0, quota_waits: wait, quota_model: settings.geminiModel });
      if (wait === 1) {
        const row = (await store.getVideo(db, t.video.id))!;
        expect(row.status).toBe('pending');
        expect(row.progress).toMatchObject({ stage: 'Waiting to retry', percent: 55 });
        const api = await worker.fetch(`https://framer.test/videos/${t.video.id}`);
        expect((await api.json<any>()).progress).toMatchObject({ stage: 'Waiting to retry', percent: 55 });
      }
      await t.skipWait();
    }
    expect(t.fake.counts.generate).toBe(MAX_ATTEMPTS + 2); // one call per wait, none skipped or repeated
    expect((await t.state())!.step).toBe('tag'); // still waiting, not failed
  });

  it('gives up on quota only after MAX_QUOTA_WINDOW_MS (48 h) of waiting', async () => {
    const t = await setup({ tagStatus: 429 });
    await t.stub.start(t.video.id);
    await t.drive((x) => x.step === 'tag' && x.next_retry_at !== null);
    await runInDurableObject<VideoDO, void>(t.stub, async (_o, s) => {
      const st = await s.storage.get<IngestState>('state');
      await s.storage.put('state', { ...st!, quota_since: Date.now() - MAX_QUOTA_WINDOW_MS - 1000 });
    });
    await t.skipWait();
    const s = (await t.drive())!;
    expect(s.step).toBe('failed');
    expect((await store.getVideo(db, t.video.id))!).toMatchObject({ status: 'failed', error: expect.stringMatching(/quota stayed exhausted/) });
  });

  it('a quota wait recorded for another model is voided by start(): the video retries now', async () => {
    const t = await setup({ tagStatus: 429 });
    await t.stub.start(t.video.id);
    const waiting = (await t.drive((x) => x.step === 'tag' && x.next_retry_at !== null))!;
    expect(waiting.next_retry_at! - Date.now()).toBeGreaterThan(100_000);
    // Same model: start() keeps the wait.
    expect((await t.stub.start(t.video.id)).next_retry_at).toBe(waiting.next_retry_at);
    // A state written before quota_model existed (legacy) or for another model: the wait is void.
    await runInDurableObject<VideoDO, void>(t.stub, async (_o, s) => {
      const st = await s.storage.get<IngestState>('state');
      const { quota_model: _drop, ...legacy } = st!;
      await s.storage.put('state', legacy);
    });
    const resumed = await t.stub.start(t.video.id);
    expect(resumed.next_retry_at).toBeNull();
    expect((await t.alarmAt())! - Date.now()).toBeLessThan(2000);
  });

  it('admin purge removes the video everywhere and stops its actor for good', async () => {
    const t = await setup({ tagStatus: 429 });
    await t.stub.start(t.video.id);
    await t.drive((x) => x.step === 'tag' && x.next_retry_at !== null); // Gemini file uploaded, waiting on quota
    expect(t.fake.files.size).toBe(1);
    const objects = { [t.video.object_key]: { size: 100, contentType: 'video/mp4' }, [`videos/${t.video.id}/frames/0.jpg`]: { size: 1, contentType: 'image/jpeg' },
      'videos/other/source': { size: 1, contentType: 'video/mp4' } };
    await t.vectors.index.upsert([{ id: `v:${t.video.id}`, values: [1], metadata: {} }, { id: `f:${t.video.id}:3`, values: [1], metadata: {} }, { id: 'v:other', values: [1], metadata: {} }] as any);
    const app = appDeps(db, { videos: ns, adminToken: 'admin-token-123', bucket: fakeBucket(objects), index: t.vectors.index });
    const del = (auth?: string, method = 'DELETE') => handle(new Request(`https://x/admin/videos/${t.video.id}`, { method, headers: auth ? { Authorization: auth } : {} }), app);
    expect((await del()).status).toBe(404);
    expect((await del('Bearer wrong')).status).toBe(404);
    expect((await del('Bearer admin-token-123', 'GET')).status).toBe(404);
    const disabled = await handle(new Request(`https://x/admin/videos/${t.video.id}`, { method: 'DELETE', headers: { Authorization: 'Bearer admin-token-123' } }), appDeps(db));
    expect(disabled.status).toBe(404); // no ADMIN_TOKEN configured: the route does not exist
    const res = await del('Bearer admin-token-123');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ d1_row_deleted: true, actor_purged: true, gemini_files_deleted: [geminiFileName(t.video.id)],
      r2_objects_deleted: [t.video.object_key, `videos/${t.video.id}/frames/0.jpg`] });
    expect(await store.getVideo(db, t.video.id)).toBeNull();
    expect(t.fake.files.size).toBe(0);
    expect(Object.keys(objects)).toEqual(['videos/other/source']);
    expect([...t.vectors.store.keys()]).toEqual(['v:other']);
    expect(await t.state()).toBeNull();
    expect(await t.alarmAt()).toBeNull();
    await expect(t.stub.start(t.video.id)).rejects.toThrow(/deleted/);
    await runDurableObjectAlarm(t.stub); // nothing left to run
    expect(await t.state()).toBeNull();
    expect((await del('Bearer admin-token-123')).status).toBe(200); // idempotent
  });

  it('an actor whose D1 row was deleted out of band purges itself at its next alarm', async () => {
    const t = await setup({ tagStatus: 429 });
    await t.stub.start(t.video.id);
    await t.drive((x) => x.step === 'tag' && x.next_retry_at !== null);
    await db.prepare('DELETE FROM videos WHERE id=?1').bind(t.video.id).run();
    await runDurableObjectAlarm(t.stub); // the pending quota-wait alarm fires
    expect(await t.state()).toBeNull();
    expect(await t.alarmAt()).toBeNull();
    expect(t.fake.files.size).toBe(0);
    await expect(t.stub.start(t.video.id)).rejects.toThrow(/deleted/);
  });

  it('a permanent error fails at once', async () => {
    const t = await setup({}, 'a.mkv', 'video/x-matroska');
    await t.stub.start(t.video.id);
    expect((await t.drive())!).toMatchObject({ step: 'failed', attempts: 1 });
    expect((await store.getVideo(db, t.video.id))!.error).toMatch(/Unsupported video format/);
  });
});

// ------------------------------------------------------------------ SSE

interface SseEvent { id?: string; event?: string; data?: any; comment?: string }

function parse(text: string): SseEvent[] {
  return text.split('\n\n').filter(Boolean).map((block) => {
    const e: SseEvent = {};
    for (const line of block.split('\n')) {
      if (line.startsWith(':')) e.comment = line.slice(1).trim();
      else {
        const i = line.indexOf(': ');
        const [k, v] = [line.slice(0, i), line.slice(i + 2)];
        if (k === 'data') e.data = JSON.parse(v);
        else (e as any)[k] = v;
      }
    }
    return e;
  });
}

async function connect(videoId: string, lastEventId?: string) {
  const res = await worker.fetch(`https://framer.test/videos/${videoId}/events`, { headers: lastEventId ? { 'Last-Event-ID': lastEventId } : {} });
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toContain('text/event-stream');
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let closed = false;
  let pending: Promise<ReadableStreamReadResult<Uint8Array>> | null = null;
  return {
    get text() { return text; },
    get closed() { return closed; },
    events: () => parse(text).filter((e) => e.event),
    async until(predicate: (events: SseEvent[]) => boolean, ms = 2000) {
      const deadline = Date.now() + ms;
      while (!closed && !predicate(parse(text).filter((e) => e.event))) {
        pending ??= reader.read();
        const result = await Promise.race([pending, new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), Math.max(0, deadline - Date.now())))]);
        if (result === 'timeout') break;
        pending = null;
        if (result.done) closed = true;
        else text += decoder.decode(result.value, { stream: true });
      }
      return parse(text).filter((e) => e.event);
    },
    cancel: () => reader.cancel(),
  };
}

describe('VideoDO: SSE from the same actor', () => {
  it('snapshot on connect, broadcast to every viewer, close on done', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const t = await setup({ tagGate: () => gate }); // generateContent is held until both viewers are in
    // Connecting also nudges: start() of a pending video (idempotent).
    const [a, b] = [await connect(t.video.id), await connect(t.video.id)];
    for (const s of [a, b]) await s.until((e) => e.some((x) => x.event === 'step' && x.data.completed === 'await_file'));
    release();
    for (const s of [a, b]) {
      const events = await s.until(() => false, 1500);
      expect(s.text.startsWith('retry: 3000\n\n')).toBe(true);
      expect(s.closed).toBe(true);
      const kinds = events.map((e) => e.event);
      expect(kinds[0]).toBe('status');
      expect(kinds.at(-1)).toBe('done');
      expect(events.filter((e) => e.event === 'step').map((e) => e.data.completed)).toContain('tag');
      const ids = events.map((e) => Number(e.id));
      expect(ids).toEqual([...ids].sort((x, y) => x - y)); // ids are state versions, increasing
      expect(events.at(-1)!.data).toMatchObject({ status: 'completed', step: 'done' });
    }
    // A finished video answers with its snapshot and closes.
    const after = await connect(t.video.id);
    await after.until(() => false, 1000);
    expect(after.closed).toBe(true);
    expect(after.events().map((e) => e.event)).toEqual(['status', 'done']);
  });

  it('resumes with Last-Event-ID by replaying the missed transitions', async () => {
    const t = await setup({ tagStatus: 503 }); // stops at tag, retrying
    await t.stub.start(t.video.id);
    const s1 = (await t.drive((x) => x.step === 'tag' && x.next_retry_at !== null))!;
    const all = await connect(t.video.id, '0');
    const replay = await all.until((e) => e.some((x) => x.event === 'status' && x.id === String(s1.version) && x.data.retry_at));
    const replayed = replay.filter((e) => e.event === 'step').map((e) => e.data.completed);
    expect(replayed).toEqual(['upload', 'await_file']);
    await all.cancel();
    const firstStep = replay.find((e) => e.event === 'step')!;
    const resumed = await connect(t.video.id, firstStep.id);
    const later = await resumed.until((e) => e.some((x) => x.id === String(s1.version)));
    expect(later.filter((e) => e.event === 'step').map((e) => e.data.completed)).toEqual(['await_file']);
    await resumed.cancel();
  });

  it('heartbeats, caps the stream lifetime, and releases a disconnected viewer', async () => {
    const t = await setup({ tagStatus: 503 });
    await t.stub.start(t.video.id);
    await t.drive((x) => x.step === 'tag' && x.next_retry_at !== null);
    const started = Date.now();
    const s = await connect(t.video.id);
    await s.until(() => false, 6000);
    expect(s.text).toContain(': ping\n\n');
    expect(s.closed).toBe(true); // capped at SSE_MAX_STREAM_MS (4 s in the test env)
    expect(Date.now() - started).toBeGreaterThanOrEqual(3500);

    const gone = await connect(t.video.id);
    await gone.until((e) => e.length > 0);
    expect(await t.stub.clientCount()).toBe(1);
    await gone.cancel();
    let count = 1;
    for (let i = 0; i < 40 && count; i++) {
      await new Promise((r) => setTimeout(r, 25));
      count = await t.stub.clientCount();
    }
    expect(count).toBe(0);
  }, 12000);
});
