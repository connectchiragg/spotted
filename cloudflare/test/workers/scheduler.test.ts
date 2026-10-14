/**
 * FramerScheduler Durable Object (the queue's alarm clock) in workerd, with the
 * shared Miniflare D1 as the queue. Fake ingestion deps are injected into the
 * object instance; each test uses its own object so alarms don't interfere.
 */
import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { handle } from '../../src/api';
import { IngestDeps } from '../../src/ingest';
import * as queue from '../../src/queue';
import { nextDueMs } from '../../src/schedule';
import type { FramerScheduler } from '../../src/scheduler';
import * as store from '../../src/store';
import { appDeps, fakeBucket, fakeEmbedder, fakeGemini, FakeGeminiOptions, fakeVectorize, settings } from '../helpers';

const db: D1Database = env.DB;
let n = 0;

beforeEach(async () => {
  await db.batch(['jobs', 'videos', 'usage_counters', 'step_results', 'usage_events'].map((t) => db.prepare(`DELETE FROM ${t}`)));
});

async function scheduler(opts: FakeGeminiOptions = {}, objects: Record<string, { size: number; contentType: string }> = {}) {
  const ns = env.SCHEDULER as DurableObjectNamespace;
  const stub = ns.get(ns.idFromName(`scheduler-test-${++n}-${Date.now()}`));
  const fake = fakeGemini(opts);
  await runInDurableObject<FramerScheduler, void>(stub, (instance) => {
    instance.depsOverride = (self): IngestDeps => ({ db, bucket: fakeBucket(objects), index: fakeVectorize().index,
      gemini: fake.gemini, embedder: fakeEmbedder(), settings, waker: self });
  });
  const inside = <R>(fn: (o: FramerScheduler) => R | Promise<R>) => runInDurableObject<FramerScheduler, R>(stub, fn);
  /** Wake and fire the alarm now; returns every outcome since the last fire (Miniflare may also fire alarms itself). */
  const fire = async () => {
    const before = await inside((o) => o.alarmRuns);
    await inside((o) => o.wake(Date.now())); // an (early) wake-up, then fire it
    await runDurableObjectAlarm(stub);
    for (let i = 0; i < 100 && (await inside((o) => o.alarmRuns)) === before; i++) await new Promise((r) => setTimeout(r, 20));
    return inside((o) => o.outcomeLog.splice(0));
  };
  const alarmAt = () => inside((o) => o.alarmAt());
  return { stub, fake, fire, alarmAt, inside };
}

async function uploadedVideo(objects: Record<string, { size: number; contentType: string }>) {
  const video = await store.createVideo(db, { filename: 'clip.mp4', contentType: 'video/mp4', size: 100 });
  objects[video.object_key] = { size: 100, contentType: 'video/mp4' };
  return video;
}

describe('FramerScheduler (Durable Object alarm instead of cron)', () => {
  it('job creation wakes the scheduler, which processes immediately', async () => {
    const objects: Record<string, { size: number; contentType: string }> = {};
    const s = await scheduler({}, objects);
    const video = await uploadedVideo(objects);
    const before = Date.now();
    const app = appDeps(db, { bucket: fakeBucket(objects), scheduler: s.stub as any });
    expect((await handle(new Request(`https://x/videos/${video.id}/complete`, { method: 'POST' }), app)).status).toBe(202);
    const woken = await s.alarmAt();
    // Either still pending at ~now, or Miniflare already fired it.
    if (woken !== null) expect(woken).toBeLessThanOrEqual(Date.now() + 1000);
    expect(await s.fire()).toContain('ingest.upload:uploaded');
    expect(before).toBeLessThanOrEqual(Date.now());
    // The next step (await_file, 5 s later) set the following alarm from D1.
    const next = (await db.prepare("SELECT run_after FROM jobs WHERE kind='ingest.await_file'").first<any>()).run_after;
    expect(await s.alarmAt()).toBe(next * 1000);
  });

  it('a retry with backoff sets the alarm to the job\'s run_after', async () => {
    const objects: Record<string, { size: number; contentType: string }> = {};
    const s = await scheduler({ uploadStatus: 503 }, objects);
    const video = await uploadedVideo(objects);
    await store.markUploadedAndEnqueue(db, video.id);
    await s.inside((o) => o.wake(Date.now()));
    expect(await s.fire()).toEqual(['ingest.upload:retry']);
    const job = await db.prepare('SELECT status, run_after, attempts FROM jobs').first<any>();
    expect(job).toMatchObject({ status: 'queued', attempts: 1 });
    expect(job.run_after - queue.nowSeconds()).toBeGreaterThanOrEqual(29);
    expect(await s.alarmAt()).toBe(job.run_after * 1000);
  });

  it('an expired lease is reclaimed when the alarm fires at locked_until', async () => {
    const objects: Record<string, { size: number; contentType: string }> = {};
    const s = await scheduler({}, objects);
    const video = await uploadedVideo(objects);
    await store.markUploadedAndEnqueue(db, video.id);
    const crashed = (await queue.claim(db, queue.nowSeconds(), 'crashed-worker'))!; // then the worker died
    expect(await s.fire()).toEqual([]); // lease still held: nothing to claim
    expect(await s.alarmAt()).toBe((crashed.locked_until! + 1) * 1000);
    await db.prepare('UPDATE jobs SET locked_until=?1 WHERE id=?2').bind(queue.nowSeconds() - 1, crashed.id).run(); // time passes
    expect(await s.fire()).toContain('ingest.upload:uploaded');
    expect(await db.prepare('SELECT status, attempts FROM jobs WHERE id=?1').bind(crashed.id).first()).toEqual({ status: 'done', attempts: 2 });
  });

  it('no pending jobs means no alarm', async () => {
    const s = await scheduler();
    expect(await nextDueMs(db)).toBeNull();
    await s.inside((o) => o.wake(Date.now()));
    expect(await s.fire()).toEqual([]);
    expect(await s.alarmAt()).toBeNull();
  });

  it('duplicate and early wake-ups claim nothing and are harmless', async () => {
    const objects: Record<string, { size: number; contentType: string }> = {};
    const s = await scheduler({}, objects);
    const video = await uploadedVideo(objects);
    await store.markUploadedAndEnqueue(db, video.id);
    const later = queue.nowSeconds() + 100;
    await db.prepare('UPDATE jobs SET run_after=?1').bind(later).run();
    await s.inside(async (o) => { await o.wake(Date.now()); await o.wake(Date.now()); await o.wake(Date.now() + 5000); });
    expect(await s.fire()).toEqual([]);
    expect(await s.alarmAt()).toBe(later * 1000);
    expect(await db.prepare('SELECT status, attempts FROM jobs').first()).toEqual({ status: 'queued', attempts: 0 });
    // A later wake never postpones an earlier alarm.
    expect(await s.inside((o) => o.wake(later * 1000 + 60_000))).toBe(later * 1000);
  });

  it('an unconfirmed upload schedules its own expiry', async () => {
    await uploadedVideo({});
    const due = await nextDueMs(db);
    expect(due! - Date.now()).toBeGreaterThan((store.UPLOAD_EXPIRY_SECONDS - 5) * 1000);
  });
});
