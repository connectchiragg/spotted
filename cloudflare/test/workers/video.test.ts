/**
 * VideoDO (actor per video) in workerd with the shared Miniflare D1: the frame/transcript
 * pipeline, resume after eviction at every step without repeated provider calls, quota
 * waits that do not burn attempts, skips, purge, and the hibernatable WebSocket.
 * Fake dependencies are registered per video id in VideoDO.testDeps.
 */
import { env, evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { exports } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { handle } from '../../src/api';
import { PROMPT_VERSION } from '../../src/gemini';
import { Google, GoogleError } from '../../src/google';
import * as store from '../../src/store';
import { EvictionError, IngestState, MAX_ATTEMPTS, MAX_QUOTA_WINDOW_MS, VideoDO } from '../../src/video';
import { appDeps, fakeBucket, fakeEmbedder, fakeGemini, FakeGeminiOptions, fakeMedia, FakeMediaOptions, fakeMp4, FakeObject, fakeTranscriber, fakeVectorize, settings } from '../helpers';

const db: D1Database = env.DB;
const ns = env.VIDEO as DurableObjectNamespace;
const worker = (exports as any).default as Fetcher;

beforeEach(async () => {
  await db.batch(['videos', 'usage_counters', 'usage_events'].map((t) => db.prepare(`DELETE FROM ${t}`)));
});

interface SetupOptions { gemini?: FakeGeminiOptions; media?: FakeMediaOptions; seconds?: number; size?: number; google?: Partial<Google>; source?: 'photos' | 'drive' }

async function setup(opts: SetupOptions = {}) {
  const objects: Record<string, FakeObject> = {};
  let video: store.Video;
  if (opts.source) {
    ({ video } = await store.upsertSourceVideo(db, { source: opts.source, sourceId: `src-${crypto.randomUUID()}`, filename: 'clip.mp4', contentType: 'video/mp4',
      size: null, meta: { session_id: 's1', base_url: 'https://photos.test/b', base_url_expires_at: new Date(Date.now() + 3600_000).toISOString() }, status: 'pending' }));
  } else {
    video = await store.createVideo(db, { filename: 'clip.mp4', contentType: 'video/mp4', size: opts.size ?? 4096 });
    expect(await store.markUploaded(db, video.id)).toBe(true);
    const bytes = fakeMp4(opts.seconds ?? 30, 4096);
    objects[video.object_key] = { size: opts.size ?? bytes.length, contentType: 'video/mp4', bytes };
  }
  const gemini = fakeGemini(opts.gemini);
  const media = fakeMedia(opts.media);
  const whisper = fakeTranscriber();
  const vectors = fakeVectorize();
  const bucket = fakeBucket(objects);
  VideoDO.testDeps.set(video.id, () => ({ db, bucket, index: vectors.index, media: media.port, transcriber: whisper.transcriber, gemini: gemini.gemini,
    embedder: fakeEmbedder(), google: (opts.google ?? null) as Google | null, settings }));
  const stub = ns.get(ns.idFromName(video.id)) as any;
  const state = (): Promise<IngestState | null> => stub.getState();
  const alarmAt = () => runInDurableObject<VideoDO, number | null>(stub, (_o, s) => s.storage.getAlarm());
  /** Fire the alarm until the state is terminal or `until` holds. */
  const drive = async (until: (s: IngestState) => boolean = () => false, max = 60) => {
    for (let i = 0; i < max; i++) {
      const s = await state();
      if (s && (['done', 'failed', 'skipped'].includes(s.step) || until(s))) return s;
      try {
        await runDurableObjectAlarm(stub);
      } catch (error) {
        if (!(error instanceof EvictionError) && !String(error).includes('evicted')) throw error;
      }
    }
    return state();
  };
  /** Make a pending wait due now (instead of minutes). */
  const skipWait = () => runInDurableObject<VideoDO, void>(stub, async (_o, s) => {
    const st = await s.storage.get<IngestState>('state');
    await s.storage.put('state', { ...st!, next_retry_at: null });
    await s.storage.setAlarm(Date.now());
  });
  const calls = () => ({ sprites: media.counts.sprites, frames: media.counts.frames, whisper: whisper.counts.calls, describe: gemini.counts.describe, summary: gemini.counts.summary });
  return { video, objects, gemini, media, whisper, vectors, stub, state, alarmAt, drive, skipWait, calls };
}

// 30 s video, scene cuts at 0/10/20 s -> 3 picks; describeBatch 2 -> 2 describe calls.
const EXPECTED_CALLS = { sprites: 1, frames: 3, whisper: 1, describe: 2, summary: 1 };

describe('VideoDO: the frame + transcript pipeline', () => {
  it('runs probe -> select -> frames -> transcribe -> describe -> summarize -> index; start() is idempotent', async () => {
    const t = await setup();
    const starts = await Promise.all([t.stub.start(t.video.id), t.stub.start(t.video.id), t.stub.start(t.video.id)]);
    expect(new Set(starts.map((s: IngestState) => s.version)).size).toBe(1);
    const done = (await t.drive())!;
    expect(done.step).toBe('done');
    expect(t.calls()).toEqual(EXPECTED_CALLS);
    expect(done.picks!.map((p) => p.t)).toEqual([0, 10, 20]);
    expect(await t.stub.start(t.video.id)).toMatchObject({ step: 'done', version: done.version });
    const row = (await store.getVideo(db, t.video.id))!;
    expect(row).toMatchObject({ status: 'completed', error: null, progress: null, duration_seconds: 30 });
    expect(row.result).toMatchObject({ summary: expect.stringContaining('blue towel'), sampled_timestamps: [0, 10, 20], thumbs: [0, 1, 2],
      transcript: [{ start: 1, end: 4, text: 'Fold the blue towel neatly.' }], duration_seconds: 30, usage: { gemini_calls: 3 } });
    expect(row.result.frame_descriptions).toHaveLength(3);
    expect(row.result.tags.map((x: any) => x.label)).toContain('towel');
    // Sound tags: the first SOUND_MAX_S of audio is kept in R2 and heard by the summarize call; labels are validated.
    expect(t.media.counts.audio).toBe(1);
    expect(t.objects[`videos/${t.video.id}/sound.m4a`]).toMatchObject({ contentType: 'audio/mp4' });
    const summaryRequest = t.gemini.requests.find((r) => JSON.stringify(r.systemInstruction).includes('summarise'));
    expect(summaryRequest.contents[0].parts.at(-1).inlineData.mimeType).toBe('audio/mp4');
    expect(row.result).toMatchObject({ labels: ['bedroom', 'cleaning'], sounds: ['speech'], prompt_version: PROMPT_VERSION });
    expect(Object.keys(t.objects).filter((k) => k.startsWith('thumbs/')).sort()).toEqual([0, 1, 2].map((i) => `thumbs/${t.video.id}/${i}.jpg`));
    expect([...t.vectors.store.keys()].sort()).toEqual([`f:${t.video.id}:0`, `f:${t.video.id}:1`, `f:${t.video.id}:2`, `s:${t.video.id}`, `t:${t.video.id}:0`]);
    expect(t.vectors.store.get(`f:${t.video.id}:1`)!.metadata).toMatchObject({ kind: 'frame', video_id: t.video.id, t_start: 10, thumb_key: `thumbs/${t.video.id}/1.jpg`, source: 'upload' });
    expect(await t.alarmAt()).toBeNull();
  });

  for (const point of ['frames:one', 'transcribe:recorded', 'describe:batch', 'summarize:recorded', 'index:recorded']) {
    it(`resumes after an eviction at ${point} without repeating a provider call`, async () => {
      const t = await setup();
      let crashed = false;
      VideoDO.testHooks.set(t.video.id, (p) => {
        if (p === point && !crashed) { crashed = true; throw new EvictionError(`evicted at ${p}`); }
      });
      await t.stub.start(t.video.id);
      await t.drive((s) => crashed && s.step !== 'done');
      expect(crashed).toBe(true);
      await evictDurableObject(t.stub); // memory gone; only durable state survives
      await t.stub.start(t.video.id); // e.g. the safety-net nudge
      const done = (await t.drive())!;
      expect(done.step).toBe('done');
      expect(t.calls()).toEqual(EXPECTED_CALLS);
      VideoDO.testHooks.delete(t.video.id);
    });
  }

  it('a quota 429 waits without using up failure attempts; the D1 row keeps the step percent', async () => {
    const t = await setup({ gemini: { describeStatus: 429 } });
    await t.stub.start(t.video.id);
    for (let wait = 1; wait <= MAX_ATTEMPTS + 2; wait++) {
      const s = (await t.drive((x) => x.step === 'describe' && x.next_retry_at !== null))!;
      expect(s).toMatchObject({ step: 'describe', attempts: 0, quota_waits: wait, quota_model: settings.geminiModel });
      expect(s.next_retry_at! - Date.now()).toBeGreaterThan(110_000); // RetryInfo 120 s
      if (wait === 1) {
        const api = await worker.fetch(`https://framer.test/videos/${t.video.id}`);
        expect((await api.json<any>()).progress).toMatchObject({ stage: 'Waiting to retry', percent: 70 });
      }
      await t.skipWait();
    }
    expect(t.gemini.counts.describe).toBe(MAX_ATTEMPTS + 2);
    expect((await t.state())!.step).toBe('describe');
  });

  it('gives up on quota only after MAX_QUOTA_WINDOW_MS (48 h) of waiting', async () => {
    const t = await setup({ gemini: { describeStatus: 429 } });
    await t.stub.start(t.video.id);
    await t.drive((x) => x.next_retry_at !== null);
    await runInDurableObject<VideoDO, void>(t.stub, async (_o, s) => {
      const st = await s.storage.get<IngestState>('state');
      await s.storage.put('state', { ...st!, quota_since: Date.now() - MAX_QUOTA_WINDOW_MS - 1000 });
    });
    await t.skipWait();
    expect((await t.drive())!.step).toBe('failed');
    expect((await store.getVideo(db, t.video.id))!.error).toMatch(/quota stayed exhausted/);
  });

  it('backs off (30 s x attempts^2) on transient errors and fails after MAX_ATTEMPTS', async () => {
    const t = await setup({ gemini: { summaryStatus: 503 } });
    await t.stub.start(t.video.id);
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const before = Date.now();
      const s = (await t.drive((x) => x.attempts === attempt && x.next_retry_at !== null))!;
      if (attempt < MAX_ATTEMPTS) {
        expect(s).toMatchObject({ step: 'summarize', attempts: attempt });
        expect(Math.abs(s.next_retry_at! - before - 30_000 * attempt * attempt)).toBeLessThan(1500);
        await t.skipWait();
      } else expect(s.step).toBe('failed');
    }
    expect((await store.getVideo(db, t.video.id))!).toMatchObject({ status: 'failed', error: 'Gemini is temporarily unavailable; retry later' });
    expect(t.gemini.counts.describe).toBe(2); // the recorded descriptions were never redone
  });

  it('a media error mid-frames resumes at the failed frame', async () => {
    const t = await setup({ media: { failFrame: 2 } });
    await t.stub.start(t.video.id);
    const s = (await t.drive((x) => x.next_retry_at !== null))!;
    expect(s).toMatchObject({ step: 'frames', frames_done: [0] });
    await t.skipWait();
    expect((await t.drive())!.step).toBe('done');
    expect(t.media.counts.frames).toBe(4); // 3 frames + the one failed try
  });

  it('skips videos over 10 minutes or over the size limit, without processing them', async () => {
    const long = await setup({ seconds: 601 });
    await long.stub.start(long.video.id);
    expect((await long.drive())!.step).toBe('skipped');
    expect((await store.getVideo(db, long.video.id))!).toMatchObject({ status: 'skipped', error: expect.stringMatching(/longer than 10 minutes/) });
    expect(long.media.counts.sprites).toBe(0);
    const big = await setup({ size: 100_000_000 });
    await big.stub.start(big.video.id);
    expect((await big.drive())!.step).toBe('skipped');
    expect((await store.getVideo(db, big.video.id))!.error).toMatch(/over 100 MB/);
  });

  it('copies a Google Photos video into R2 (multipart) before processing it', async () => {
    const bytes = fakeMp4(30, 12 * 1024 * 1024); // spans two 10 MiB parts
    const google = { downloadPhotoVideo: async (url: string) => (expect(url).toBe('https://photos.test/b'), new Response(bytes)) } as Partial<Google>;
    const t = await setup({ source: 'photos', google });
    await t.stub.start(t.video.id);
    expect((await t.drive())!.step).toBe('done');
    expect(t.objects[t.video.object_key].size).toBe(bytes.length);
    expect((await store.getVideo(db, t.video.id))!).toMatchObject({ status: 'completed', uploaded: 1, expected_size: bytes.length, source: 'photos' });
    expect(t.vectors.store.get(`s:${t.video.id}`)!.metadata).toMatchObject({ source: 'photos', source_id: t.video.source_id });
    // The copy reported byte progress as a visible 'progress' event (bytes_total from Content-Length).
    const progress = await runInDurableObject<VideoDO, any[]>(t.stub, (_o, s) =>
      s.storage.sql.exec("SELECT data FROM events WHERE type='progress'").toArray().map((r: any) => JSON.parse(r.data).progress));
    expect(progress.length).toBeGreaterThan(0);
    expect(progress[0]).toMatchObject({ stage: 'Copying from Google', bytes_total: null, percent: 10 }); // no Content-Length, no size known
    expect(progress[0].bytes_done).toBeGreaterThanOrEqual(4 * 1024 * 1024);
  });

  it('restart downloads the source again instead of re-analysing the stored copy', async () => {
    const versions = [fakeMp4(30, 6000), fakeMp4(30, 9000)];
    let downloads = 0;
    const google = { downloadPhotoVideo: async () => new Response(versions[downloads++]) } as Partial<Google>;
    const t = await setup({ source: 'photos', google });
    await t.stub.start(t.video.id);
    expect((await t.drive())!.step).toBe('done');
    expect(t.objects[t.video.object_key].size).toBe(6000);
    await t.stub.restart(t.video.id);
    expect((await t.drive())!.step).toBe('done');
    expect(downloads).toBe(2);
    expect(t.objects[t.video.object_key].size).toBe(9000);
  });

  it('a transient error while refreshing an expired Photos link retries instead of failing', async () => {
    let calls = 0;
    const google = {
      listPickedItems: async () => { if (++calls === 1) throw new GoogleError('List picked items: Google is temporarily unavailable', 503, true); return [{ id: 'x', type: 'VIDEO', mediaFile: { baseUrl: 'https://photos.test/b', mimeType: 'video/mp4' } }]; },
      downloadPhotoVideo: async () => new Response(fakeMp4(30, 6000)),
    } as Partial<Google>;
    const t = await setup({ source: 'photos', google });
    await db.prepare("UPDATE videos SET source_id='x', source_meta=json_set(source_meta, '$.base_url_expires_at', '2000-01-01T00:00:00Z') WHERE id=?1").bind(t.video.id).run();
    await t.stub.start(t.video.id);
    expect((await t.drive((st) => Boolean(st.last_error)))!).toMatchObject({ step: 'fetch', last_error: expect.stringContaining('temporarily unavailable') });
    await t.skipWait();
    expect((await t.drive())!.step).toBe('done');
    expect(calls).toBe(2);
  });

  it('copy progress is a fraction of the Content-Length', async () => {
    const bytes = fakeMp4(30, 6 * 1024 * 1024);
    const google = { downloadPhotoVideo: async () => new Response(bytes, { headers: { 'content-length': String(bytes.length) } }) } as Partial<Google>;
    const t = await setup({ source: 'photos', google });
    await t.stub.start(t.video.id);
    expect((await t.drive())!.step).toBe('done');
    const progress = await runInDurableObject<VideoDO, any[]>(t.stub, (_o, s) =>
      s.storage.sql.exec("SELECT data FROM events WHERE type='progress'").toArray().map((r: any) => JSON.parse(r.data).progress));
    expect(progress[0].bytes_total).toBe(bytes.length);
    expect(progress[0].percent).toBe(10 + Math.round((9 * progress[0].bytes_done) / bytes.length));
  });

  it('a Photos download over 100 MB is skipped and nothing is stored', async () => {
    const google = { downloadPhotoVideo: async () => new Response('x', { headers: { 'content-length': '150000000' } }) } as Partial<Google>;
    const t = await setup({ source: 'photos', google });
    await t.stub.start(t.video.id);
    expect((await t.drive())!.step).toBe('skipped');
    expect(t.objects[t.video.object_key]).toBeUndefined();
  });

  it('admin purge removes the video everywhere and stops its actor for good', async () => {
    const t = await setup({ gemini: { describeStatus: 429 } });
    await t.stub.start(t.video.id);
    await t.drive((x) => x.next_retry_at !== null);
    t.objects['videos/other/source'] = { size: 1, contentType: 'video/mp4' };
    await t.vectors.index.upsert([{ id: 'v:other', values: [1], metadata: {} }] as any);
    const app = appDeps(db, { videos: ns, adminToken: 'admin-token-123', bucket: VideoDO.testDeps.get(t.video.id)!().bucket, index: t.vectors.index });
    const del = (auth?: string, method = 'DELETE') => handle(new Request(`https://x/admin/videos/${t.video.id}`, { method, headers: auth ? { Authorization: auth } : {} }), app);
    expect((await del()).status).toBe(404);
    expect((await del('Bearer wrong')).status).toBe(404);
    expect((await del('Bearer admin-token-123', 'GET')).status).toBe(404);
    const res = await del('Bearer admin-token-123');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ d1_row_deleted: true, actor_purged: true });
    expect(await store.getVideo(db, t.video.id)).toBeNull();
    expect(Object.keys(t.objects)).toEqual(['videos/other/source']);
    expect([...t.vectors.store.keys()]).toEqual(['v:other']);
    expect(await t.state()).toBeNull();
    expect(await t.alarmAt()).toBeNull();
    await expect(t.stub.start(t.video.id)).rejects.toThrow(/deleted/);
    expect((await del('Bearer admin-token-123')).status).toBe(200); // idempotent
  });

  it('an actor whose D1 row was deleted out of band purges itself (alarm or GET)', async () => {
    const t = await setup({ gemini: { describeStatus: 429 } });
    await t.stub.start(t.video.id);
    await t.drive((x) => x.next_retry_at !== null);
    await db.prepare('DELETE FROM videos WHERE id=?1').bind(t.video.id).run();
    await runDurableObjectAlarm(t.stub);
    expect(await t.state()).toBeNull();
    const u = await setup();
    await u.stub.start(u.video.id);
    await u.drive();
    await db.prepare('DELETE FROM videos WHERE id=?1').bind(u.video.id).run();
    expect((await worker.fetch(`https://framer.test/videos/${u.video.id}`)).status).toBe(404);
    expect(await u.state()).toBeNull();
  });
});

// ------------------------------------------------------------------ WebSockets

async function open(videoId: string) {
  const res = await worker.fetch(`https://framer.test/videos/${videoId}/ws`, { headers: { Upgrade: 'websocket' } });
  expect(res.status).toBe(101);
  const ws = res.webSocket!;
  const messages: any[] = [];
  let closed = false;
  ws.accept();
  ws.addEventListener('message', (e) => { try { messages.push(JSON.parse(String(e.data))); } catch { /* "pong" */ } });
  ws.addEventListener('close', () => { closed = true; });
  const until = async (predicate: () => boolean, ms = 3000) => {
    const deadline = Date.now() + ms;
    while (!predicate() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    return predicate();
  };
  return { ws, messages, get closed() { return closed; }, until };
}

describe('VideoDO: hibernatable WebSocket status', () => {
  it('subscribe -> snapshot -> live events -> final event and close', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const t = await setup({ gemini: { gate: () => gate } });
    await t.stub.start(t.video.id);
    const a = await open(t.video.id);
    a.ws.send(JSON.stringify({ type: 'subscribe', last_seq: null }));
    await a.until(() => a.messages.length >= 1);
    expect(a.messages[0]).toMatchObject({ type: 'event', event: 'status', data: { id: t.video.id } });
    expect(['pending', 'processing']).toContain(a.messages[0].data.status);
    const running = t.drive(); // holds at the first describe call
    await new Promise((r) => setTimeout(r, 100));
    release();
    await running;
    expect(await a.until(() => a.closed)).toBe(true);
    const events = a.messages.map((m) => m.event);
    expect(events).toContain('step');
    expect(events.at(-1)).toBe('done');
    const seqs = a.messages.map((m) => m.seq);
    expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
    expect(await t.stub.socketCount()).toBe(0);
  });

  it('resumes from last_seq by replaying stored events; a finished video closes at once', async () => {
    const t = await setup({ gemini: { summaryStatus: 503 } });
    await t.stub.start(t.video.id);
    const s = (await t.drive((x) => x.step === 'summarize' && x.next_retry_at !== null))!;
    const b = await open(t.video.id);
    b.ws.send(JSON.stringify({ type: 'subscribe', last_seq: 0 }));
    await b.until(() => b.messages.some((m) => !m.replay));
    const replayed = b.messages.filter((m) => m.replay && m.event === 'step').map((m) => m.data.completed);
    expect(replayed).toEqual(['probe', 'select', 'frames', 'transcribe', 'describe']);
    const firstStep = b.messages.find((m) => m.replay && m.event === 'step');
    const c = await open(t.video.id);
    c.ws.send(JSON.stringify({ type: 'subscribe', last_seq: firstStep.seq }));
    await c.until(() => c.messages.some((m) => !m.replay));
    expect(c.messages.filter((m) => m.replay && m.event === 'step').map((m) => m.data.completed)).toEqual(['select', 'frames', 'transcribe', 'describe']);
    expect(c.messages.at(-1)).toMatchObject({ event: 'status', seq: s.version });
    b.ws.close(1000);
    c.ws.close(1000);

    const done = await setup();
    await done.stub.start(done.video.id);
    await done.drive();
    const d = await open(done.video.id);
    d.ws.send(JSON.stringify({ type: 'subscribe' }));
    expect(await d.until(() => d.closed)).toBe(true);
    expect(d.messages.map((m) => m.event)).toEqual(['status', 'done']);
  });

  it('answers ping with pong without waking the object, and rejects non-upgrade requests', async () => {
    const t = await setup();
    await t.stub.start(t.video.id);
    const e = await open(t.video.id);
    const pongs: string[] = [];
    e.ws.addEventListener('message', (m) => { if (m.data === 'pong') pongs.push('pong'); });
    e.ws.send('ping');
    await e.until(() => pongs.length > 0);
    expect(pongs).toEqual(['pong']);
    expect((await worker.fetch(`https://framer.test/videos/${t.video.id}/ws`)).status).toBe(426);
    e.ws.close(1000);
  });
});
