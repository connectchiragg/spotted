/**
 * Postgres-table job queue claimed with FOR UPDATE SKIP LOCKED.
 *
 * Every operation is a single SQL statement (data-modifying CTEs), so it is
 * atomic under Hyperdrive's transaction-mode pooling without BEGIN/COMMIT.
 * Writes after a claim are fenced by lock_token: a consumer whose visibility
 * timeout expired (and whose row was re-claimed) can no longer change anything.
 */
import { Db, nowIso } from './db';

export type Stage = 'upload' | 'await_file' | 'tag' | 'index';

/** Visibility timeout per stage, in seconds. */
export const LEASES: Record<Stage, number> = { upload: 900, await_file: 120, tag: 600, index: 300 };

export interface Claimed {
  request_id: string;
  stage: Stage;
  state: Record<string, any>;
  attempts: number;
  max_attempts: number;
  lock_token: string;
}

export interface Progress {
  stage: string;
  percent: number;
  eta_seconds: number | null;
}

function progressJson(p: Progress | null): string | null {
  return p ? JSON.stringify({ ...p, updated_at: nowIso() }) : null;
}

/**
 * Claim the next due row. Rows are due when run_after has passed, they are not
 * locked (or their lock expired: the previous consumer crashed or timed out) and
 * the current stage still has attempts left. The job row moves to 'processing'.
 */
export async function claim(db: Db, stages: Stage[] | null = null): Promise<Claimed | null> {
  const token = crypto.randomUUID();
  const rows = await db.query<Claimed>(
    `WITH next AS (
       SELECT request_id FROM ingest_queue
       WHERE run_after <= now()
         AND (locked_until IS NULL OR locked_until < now())
         AND attempts < max_attempts
         AND ($2::text::jsonb IS NULL OR stage IN (SELECT jsonb_array_elements_text($2::text::jsonb)))
       ORDER BY run_after, request_id
       FOR UPDATE SKIP LOCKED
       LIMIT 1),
     claimed AS (
       UPDATE ingest_queue q
       SET lock_token=$1, locked_until=now() + make_interval(secs => q.lease_seconds),
           attempts=q.attempts + 1, updated_at=now()
       FROM next WHERE q.request_id = next.request_id
       RETURNING q.request_id, q.stage, q.state, q.attempts, q.max_attempts, q.lock_token, q.lease_seconds),
     job AS (
       UPDATE jobs j
       SET status='processing', claim_token=claimed.lock_token,
           attempts=GREATEST(j.attempts, claimed.attempts),
           lease_until=extract(epoch from now()) + claimed.lease_seconds, updated_at=$3
       FROM claimed WHERE j.id = claimed.request_id AND j.status IN ('pending','processing')
       RETURNING j.id)
     SELECT request_id, stage, state, attempts, max_attempts, lock_token FROM claimed`,
    [token, stages ? JSON.stringify(stages) : null, nowIso()],
  );
  const row = rows[0];
  if (!row) return null;
  if (typeof row.state === 'string') row.state = JSON.parse(row.state);
  return row;
}

/** Stage succeeded: move to the next stage with a fresh attempt budget. */
export async function advance(
  db: Db, claimed: Claimed, next: Stage, state: Record<string, any>, progress: Progress, delaySeconds = 0,
): Promise<boolean> {
  const rows = await db.query(
    `WITH q AS (
       UPDATE ingest_queue SET stage=$3, state=$4::text::jsonb, attempts=0, lease_seconds=$5,
         lock_token=NULL, locked_until=NULL, last_error=NULL,
         run_after=now() + make_interval(secs => $6), updated_at=now()
       WHERE request_id=$1 AND lock_token=$2 RETURNING request_id)
     UPDATE jobs SET progress=$7::text::jsonb, updated_at=$8, error=NULL FROM q WHERE jobs.id=q.request_id RETURNING jobs.id`,
    [claimed.request_id, claimed.lock_token, next, JSON.stringify(state), LEASES[next], delaySeconds, progressJson(progress), nowIso()],
  );
  return rows.length === 1;
}

/** Not ready yet (e.g. Gemini still processing): release without consuming an attempt. */
export async function defer(db: Db, claimed: Claimed, state: Record<string, any>, delaySeconds: number, progress: Progress | null = null): Promise<boolean> {
  const rows = await db.query(
    `WITH q AS (
       UPDATE ingest_queue SET attempts=GREATEST(attempts - 1, 0), state=$3::text::jsonb,
         lock_token=NULL, locked_until=NULL, run_after=now() + make_interval(secs => $4), updated_at=now()
       WHERE request_id=$1 AND lock_token=$2 RETURNING request_id)
     UPDATE jobs SET progress=COALESCE($5::text::jsonb, jobs.progress), updated_at=$6 FROM q WHERE jobs.id=q.request_id RETURNING jobs.id`,
    [claimed.request_id, claimed.lock_token, JSON.stringify(state), delaySeconds, progressJson(progress), nowIso()],
  );
  return rows.length === 1;
}

/** Exponential backoff for transient failures: 30 s, 60 s, 120 s ... capped at 10 min. */
export function backoffSeconds(attempts: number): number {
  return Math.min(600, 30 * 2 ** Math.max(0, attempts - 1));
}

/**
 * Stage failed. Retryable failures with attempts left are released with backoff
 * and last_error recorded; otherwise the job fails terminally and leaves the queue.
 */
export async function fail(db: Db, claimed: Claimed, message: string, retryable: boolean): Promise<'retry' | 'failed' | 'stale'> {
  if (retryable && claimed.attempts < claimed.max_attempts) {
    const rows = await db.query(
      `WITH q AS (
         UPDATE ingest_queue SET lock_token=NULL, locked_until=NULL, last_error=$3,
           run_after=now() + make_interval(secs => $4), updated_at=now()
         WHERE request_id=$1 AND lock_token=$2 RETURNING request_id)
       UPDATE jobs SET status='pending', error=$3, claim_token=NULL, lease_until=NULL, updated_at=$5
       FROM q WHERE jobs.id=q.request_id RETURNING jobs.id`,
      [claimed.request_id, claimed.lock_token, message, backoffSeconds(claimed.attempts), nowIso()],
    );
    return rows.length ? 'retry' : 'stale';
  }
  const rows = await db.query(
    `WITH q AS (DELETE FROM ingest_queue WHERE request_id=$1 AND lock_token=$2 RETURNING request_id)
     UPDATE jobs SET status='failed', error=$3, claim_token=NULL, lease_until=NULL, updated_at=$4
     FROM q WHERE jobs.id=q.request_id RETURNING jobs.id`,
    [claimed.request_id, claimed.lock_token, message, nowIso()],
  );
  return rows.length ? 'failed' : 'stale';
}

/** Final stage succeeded: persist the result and remove the queue row atomically. */
export async function complete(db: Db, claimed: Claimed, result: Record<string, any>): Promise<boolean> {
  const rows = await db.query(
    `WITH q AS (DELETE FROM ingest_queue WHERE request_id=$1 AND lock_token=$2 RETURNING request_id)
     UPDATE jobs SET status='completed', result=$3::text::jsonb, error=NULL, claim_token=NULL, lease_until=NULL,
       progress=NULL, updated_at=$4
     FROM q WHERE jobs.id=q.request_id AND jobs.status='processing' RETURNING jobs.id`,
    [claimed.request_id, claimed.lock_token, JSON.stringify(result), nowIso()],
  );
  return rows.length === 1;
}

/** Drop a queue row whose job no longer needs work (already terminal or deleted). */
export async function discard(db: Db, claimed: Claimed): Promise<void> {
  await db.query('DELETE FROM ingest_queue WHERE request_id=$1 AND lock_token=$2', [claimed.request_id, claimed.lock_token]);
}

/**
 * Dead-letter sweep: rows that used every attempt and are no longer locked
 * (the last consumer crashed mid-attempt) fail the job with the last error.
 */
export async function sweepExhausted(db: Db): Promise<number> {
  const rows = await db.query(
    `WITH q AS (
       DELETE FROM ingest_queue
       WHERE attempts >= max_attempts AND (locked_until IS NULL OR locked_until < now())
       RETURNING request_id, last_error)
     UPDATE jobs SET status='failed',
       error=COALESCE(q.last_error, 'Processing exceeded three attempts'),
       claim_token=NULL, lease_until=NULL, updated_at=$1
     FROM q WHERE jobs.id=q.request_id AND jobs.status NOT IN ('completed','failed') RETURNING jobs.id`,
    [nowIso()],
  );
  return rows.length;
}

export async function hasDueWork(db: Db, stages: Stage[]): Promise<boolean> {
  const rows = await db.query(
    `SELECT 1 FROM ingest_queue WHERE run_after <= now() AND (locked_until IS NULL OR locked_until < now())
     AND attempts < max_attempts AND stage IN (SELECT jsonb_array_elements_text($1::text::jsonb)) LIMIT 1`,
    [JSON.stringify(stages)],
  );
  return rows.length > 0;
}
