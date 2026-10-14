/**
 * SSE through the real Worker entrypoint and the VideoEvents Durable Object
 * (test env: ping every 100 ms, streams capped at 4 s), with ingestion steps
 * publishing after their fenced D1 commits.
 */
import { env } from 'cloudflare:test';
import { exports } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { drain, IngestDeps, runJob } from '../../src/ingest';
import { videoNotifier } from '../../src/notify';
import * as queue from '../../src/queue';
import * as store from '../../src/store';
import { defaultTagging, fakeBucket, fakeEmbedder, fakeGemini, FakeGeminiOptions, fakeVectorize, settings } from '../helpers';

const db: D1Database = env.DB;
const worker = (exports as any).default as Fetcher;

beforeEach(async () => {
  await db.batch(['jobs', 'videos', 'usage_counters', 'step_results', 'usage_events'].map((t) => db.prepare(`DELETE FROM ${t}`)));
});

interface SseEvent { id?: string; event?: string; data?: any; comment?: string; retry?: string }

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

/** Open the stream and read it incrementally. */
async function connect(videoId: string, lastEventId?: string) {
  const res = await worker.fetch(`https://framer.test/videos/${videoId}/events`, { headers: lastEventId ? { 'Last-Event-ID': lastEventId } : {} });
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toContain('text/event-stream');
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let closed = false;
  let pending: Promise<ReadableStreamReadResult<Uint8Array>> | null = null;
  const stream = {
    get text() { return text; },
    get closed() { return closed; },
    events: () => parse(text).filter((e) => e.event),
    /** Read until `predicate(events)` holds, the stream closes, or `ms` pass. */
    async until(predicate: (events: SseEvent[]) => boolean, ms = 2000) {
      const deadline = Date.now() + ms;
      while (!closed && !predicate(parse(text))) {
        pending ??= reader.read();
        const result = await Promise.race([pending, new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), Math.max(0, deadline - Date.now())))]);
        if (result === 'timeout') break;
        pending = null;
        if (result.done) closed = true;
        else text += decoder.decode(result.value, { stream: true });
      }
      return parse(text);
    },
    cancel: () => reader.cancel(),
  };
  return stream;
}

async function queuedVideo(objects: Record<string, { size: number; contentType: string }>) {
  const video = await store.createVideo(db, { filename: 'clip.mp4', contentType: 'video/mp4', size: 100 });
  objects[video.object_key] = { size: 100, contentType: 'video/mp4' };
  expect(await store.markUploadedAndEnqueue(db, video.id)).toBe(true);
  return video;
}

function ingest(objects: Record<string, { size: number; contentType: string }>, opts: FakeGeminiOptions = {}): IngestDeps {
  return { db, bucket: fakeBucket(objects), index: fakeVectorize().index, gemini: fakeGemini(opts).gemini, embedder: fakeEmbedder(),
    settings, notify: videoNotifier(env.VIDEO_EVENTS, db) };
}

async function step(deps: IngestDeps) {
  await db.prepare("UPDATE jobs SET run_after = 0 WHERE status='queued'").run();
  return drain(deps, { maxSteps: 1 });
}

const named = (events: SseEvent[], name: string) => events.filter((e) => e.event === name);

describe('GET /videos/:id/events (SSE)', () => {
  it('sends a retry hint and the D1 snapshot on connect', async () => {
    const video = await queuedVideo({});
    const s = await connect(video.id);
    await s.until((e) => e.some((x) => x.event === 'status'));
    expect(s.text.startsWith('retry: 3000\n\n')).toBe(true);
    expect(s.events()[0]).toMatchObject({ id: '0', event: 'status', data: { id: video.id, status: 'pending', progress: { stage: 'Queued' } } });
    await s.cancel();
  });

  it('pushes an event to every connected client after a step commits', async () => {
    const objects = {};
    const video = await queuedVideo(objects);
    const [a, b] = [await connect(video.id), await connect(video.id)];
    await a.until((e) => e.some((x) => x.event === 'status'));
    await b.until((e) => e.some((x) => x.event === 'status'));
    expect(await step(ingest(objects))).toEqual(['ingest.upload:uploaded']);
    for (const s of [a, b]) {
      const events = await s.until((e) => named(e, 'step').length > 0);
      expect(named(events, 'step')[0]).toMatchObject({ id: '1', data: { status: 'processing', step: 'ingest.upload', next_step: 'ingest.await_file',
        progress: { stage: 'Video sent for analysis' } } });
    }
    await a.cancel();
    await b.cancel();
  });

  it('a write whose fence failed publishes nothing; only the current holder\'s commit does', async () => {
    const objects = {};
    const video = await queuedVideo(objects);
    const deps = ingest(objects);
    await step(deps);
    await step(deps);
    await db.prepare("UPDATE jobs SET run_after = 0 WHERE status='queued'").run();
    const s = await connect(video.id);
    await s.until((e) => e.some((x) => x.event === 'status'));

    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const staleDeps = ingest(objects, { tagGate: () => gate, tagging: { ...defaultTagging, summary: 'Stale.' } });
    const stale = (await queue.claim(db, queue.nowSeconds(), 'stale'))!;
    const staleRun = runJob(staleDeps, stale);
    await db.prepare("UPDATE jobs SET locked_until = 0 WHERE status='running'").run();
    const fresh = (await queue.claim(db, queue.nowSeconds(), 'fresh'))!;
    expect(await runJob(deps, fresh)).toBe('tagged');
    release();
    expect(await staleRun).toBe('lease-lost');

    const events = await s.until(() => false, 400); // collect everything for a while
    expect(named(events, 'step').map((e) => e.data.step)).toEqual(['ingest.tag']);
    await s.cancel();
  });

  it('closes the stream on done, and a finished video closes right after its snapshot', async () => {
    const objects = {};
    const video = await queuedVideo(objects);
    const deps = ingest(objects);
    const s = await connect(video.id);
    await s.until((e) => e.some((x) => x.event === 'status'));
    for (let i = 0; i < 4; i++) await step(deps);
    const events = await s.until(() => false, 1500);
    expect(s.closed).toBe(true);
    expect(events.filter((e) => e.event).map((e) => e.event)).toEqual(['status', 'step', 'step', 'step', 'done']);
    expect(named(events, 'done')[0].data).toMatchObject({ status: 'completed', progress: { stage: 'Completed', percent: 100 } });

    const after = await connect(video.id);
    await after.until(() => false, 1000);
    expect(after.closed).toBe(true);
    expect(after.events().map((e) => e.event)).toEqual(['status', 'done']);
  });

  it('resumes with Last-Event-ID by replaying missed events before the snapshot', async () => {
    const objects = {};
    const video = await queuedVideo(objects);
    const deps = ingest(objects);
    await step(deps); // event 1: upload done
    await step(deps); // event 2: await_file done
    const s = await connect(video.id, '1');
    const events = await s.until((e) => e.some((x) => x.event === 'status'));
    expect(events.filter((e) => e.event).map((e) => [e.id, e.event, e.data.step])).toEqual([['2', 'step', 'ingest.await_file'], ['2', 'status', undefined]]);
    await s.cancel();
  });

  it('sends `: ping` heartbeats while the stream is open', async () => {
    const video = await queuedVideo({});
    const s = await connect(video.id);
    await s.until((e) => e.some((x) => x.comment === 'ping'), 1500);
    expect(s.text).toContain(': ping\n\n');
    await s.cancel();
  });

  it('caps the stream lifetime so EventSource reconnects (retry hint first)', async () => {
    const video = await queuedVideo({});
    const started = Date.now();
    const s = await connect(video.id);
    await s.until(() => false, 6000);
    expect(s.closed).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(3500);
    expect(s.text.startsWith('retry: 3000')).toBe(true);
  }, 10000);

  it('a client disconnect releases its writer', async () => {
    const video = await queuedVideo({});
    const stub = env.VIDEO_EVENTS.get(env.VIDEO_EVENTS.idFromName(video.id));
    const s = await connect(video.id);
    await s.until((e) => e.some((x) => x.event === 'status'));
    expect(await stub.clientCount()).toBe(1);
    await s.cancel();
    let count = 1;
    const t0 = Date.now();
    for (let i = 0; i < 200 && count; i++) {
      await new Promise((r) => setTimeout(r, 25));
      count = await stub.clientCount();
    }
    expect(Date.now() - t0).toBeLessThan(1000); // via request.signal, not the backlog cap
    expect(count).toBe(0);
  }, 12000);
});
