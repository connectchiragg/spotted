/**
 * Scheduling queries and the FramerScheduler stub, free of the Durable Object
 * class itself so Node-run code (and tests) can import them.
 */
import { Env } from './env';
import { UPLOAD_EXPIRY_SECONDS } from './store';

export interface Waker {
  wake(atMs: number): Promise<unknown>;
}

/** Earliest time (ms) at which the scheduler has work, or null if nothing is pending. */
export async function nextDueMs(db: D1Database): Promise<number | null> {
  const row = await db.prepare(
    `SELECT MIN(t) AS t FROM (
       SELECT MIN(run_after) AS t FROM jobs WHERE status='queued'
       UNION ALL SELECT MIN(locked_until) + 1 FROM jobs WHERE status='running'
       UNION ALL SELECT MIN(CAST(strftime('%s', updated_at) AS INTEGER)) + ?1 + 1 FROM videos WHERE status='uploading')`,
  ).bind(UPLOAD_EXPIRY_SECONDS).first<{ t: number | null }>();
  return row?.t == null ? null : row.t * 1000;
}

/** Due work for one video (or any video): queued and due, or running with an expired lease. */
export async function hasDueJobs(db: D1Database, videoId?: string, nowS = Math.floor(Date.now() / 1000)): Promise<boolean> {
  const row = await db.prepare(
    `SELECT 1 AS due FROM jobs
     WHERE ((status='queued' AND run_after<=?1) OR (status='running' AND locked_until<?1))
       AND (?2 IS NULL OR json_extract(payload, '$.video_id')=?2) LIMIT 1`,
  ).bind(nowS, videoId ?? null).first();
  return row !== null;
}

export function schedulerStub(env: Env): Waker | null {
  if (!env.SCHEDULER) return null;
  return env.SCHEDULER.get(env.SCHEDULER.idFromName('scheduler')) as unknown as Waker;
}

