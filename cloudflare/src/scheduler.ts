/**
 * FramerScheduler: the queue's alarm clock (owner decision: no cron, no Queues).
 *
 * One global, SQLite-backed Durable Object (idFromName('scheduler')); SQLite-backed
 * classes are the ones available on Workers Free
 * (https://developers.cloudflare.com/durable-objects/platform/pricing/).
 * D1 stays the queue and the source of truth: leases, fencing, idempotency and
 * resumable steps are unchanged. This object stores nothing but its one alarm.
 *
 *   wake(atMs)  set the alarm to min(current alarm, atMs); "now" for immediate work.
 *               Called when the API creates a job and when a step enqueues its next
 *               step or schedules a retry. Duplicate or early wakes are harmless:
 *               the alarm finds nothing due and claims nothing.
 *   alarm()     runDueJobs (housekeeping + bounded drain), then sets the next alarm
 *               to the earliest of: a queued job's run_after, a running job's
 *               locked_until (lease reclaim), an unconfirmed upload's 15-min expiry.
 *               Nothing pending -> no alarm -> zero idle work.
 *
 * Alarms are at-least-once and retried on throw (exponential backoff from 2 s, up
 * to 6 retries; https://developers.cloudflare.com/durable-objects/api/alarms/);
 * the handler never throws, it always reschedules from D1 instead.
 */
import { DurableObject } from 'cloudflare:workers';
import { Env } from './env';
import { IngestDeps } from './ingest';
import { runDueJobs } from './consumer';
import { nextDueMs } from './schedule';

export class FramerScheduler extends DurableObject<Env> {
  /** Tests inject fake ingestion dependencies here (via runInDurableObject). */
  depsOverride: ((self: FramerScheduler) => IngestDeps) | null = null;
  /** Outcomes of the last alarm (tests and logs). */
  lastOutcomes: string[] = [];
  alarmRuns = 0;
  /** Every outcome since the object started (bounded; tests and debugging). */
  outcomeLog: string[] = [];

  async wake(atMs: number): Promise<number> {
    const target = Math.max(Math.floor(atMs), Date.now());
    const current = await this.ctx.storage.getAlarm();
    if (current !== null && current <= target) return current;
    await this.ctx.storage.setAlarm(target);
    return target;
  }

  async alarm(): Promise<void> {
    let configured = true;
    try {
      const result = await runDueJobs(this.env, this.ctx, { deps: this.depsOverride?.(this) ?? undefined, waker: this });
      this.lastOutcomes = result.outcomes;
      this.outcomeLog = [...this.outcomeLog, ...result.outcomes].slice(-100);
      configured = result.configured;
    } catch (error) {
      console.error('scheduler alarm failed', (error as Error)?.message);
    }
    this.alarmRuns++;
    if (!configured) {
      // Missing bindings/secrets: don't spin. The next API wake retries.
      console.warn('scheduler: ingestion not configured; no alarm set');
      return;
    }
    try {
      const next = this.env.DB ? await nextDueMs(this.env.DB) : null;
      if (next !== null) await this.wake(next);
    } catch (error) {
      // D1 unreachable: try again shortly rather than losing the schedule.
      console.error('scheduler reschedule failed', (error as Error)?.message);
      await this.wake(Date.now() + 30_000);
    }
  }

  /** Test/debug helper. */
  async alarmAt(): Promise<number | null> {
    return this.ctx.storage.getAlarm();
  }
}
