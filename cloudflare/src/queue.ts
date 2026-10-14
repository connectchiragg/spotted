/**
 * D1 work queue (owner-approved design). Correctness relies on D1 serialising
 * writes: the claim is ONE atomic UPDATE ... RETURNING, work happens outside any
 * lock, and every later write is fenced by the lease_token the claim returned.
 *
 * Statements are returned unexecuted so callers can put them in a db.batch()
 * (a single D1 transaction) together with fenced updates to the videos table.
 * Order inside a batch: fenced side effects FIRST, then complete/fail (which
 * clears lease_token), so all of them see the same lease.
 */
export const LEASE_SECONDS = 300;
export const MAX_ATTEMPTS = 5;

export interface QueueJob {
  id: number;
  kind: string;
  payload: Record<string, any>;
  status: string;
  run_after: number;
  locked_until: number | null;
  lease_token: string | null;
  attempts: number;
  last_error: string | null;
}

export const nowSeconds = () => Math.floor(Date.now() / 1000);

function decode(row: any): QueueJob {
  return { ...row, payload: JSON.parse(row.payload) };
}

export function enqueueStmt(db: D1Database, kind: string, payload: unknown, runAfter: number, now = nowSeconds()) {
  return db.prepare(
    `INSERT INTO jobs (kind, payload, status, run_after, attempts, created_at, updated_at)
     VALUES (?1, ?2, 'queued', ?3, 0, ?4, ?4)`,
  ).bind(kind, JSON.stringify(payload), runAfter, now);
}

/** 1. Claim: one atomic statement; picks due queued jobs or running jobs whose lease expired. */
export async function claim(db: D1Database, now = nowSeconds(), token: string = crypto.randomUUID()): Promise<QueueJob | null> {
  const row = await db.prepare(
    `UPDATE jobs SET status='running', lease_token=?1, locked_until=?2+${LEASE_SECONDS}, attempts=attempts+1, updated_at=?2
     WHERE id=(SELECT id FROM jobs
               WHERE (status='queued' AND run_after<=?2) OR (status='running' AND locked_until<?2)
               ORDER BY run_after, id LIMIT 1)
     RETURNING *`,
  ).bind(token, now).first();
  return row ? decode(row) : null;
}

/** 3. Complete. 0 rows changed means the lease was lost (fencing token); nothing is overwritten. */
export function completeStmt(db: D1Database, job: QueueJob, now = nowSeconds()) {
  return db.prepare(`UPDATE jobs SET status='done', lease_token=NULL, updated_at=?1 WHERE id=?2 AND lease_token=?3`)
    .bind(now, job.id, job.lease_token);
}

/** 4. Fail: retry with quadratic backoff (30 s * attempts^2); dead after 5 attempts. */
export function failStmt(db: D1Database, job: QueueJob, error: string, now = nowSeconds()) {
  return db.prepare(
    `UPDATE jobs SET status=CASE WHEN attempts>=${MAX_ATTEMPTS} THEN 'dead' ELSE 'queued' END,
       run_after=?1+30*attempts*attempts, lease_token=NULL, last_error=?2, updated_at=?1
     WHERE id=?3 AND lease_token=?4`,
  ).bind(now, error, job.id, job.lease_token);
}

/** Permanent errors (invalid video, quota, credentials) dead-letter immediately. */
export function deadStmt(db: D1Database, job: QueueJob, error: string, now = nowSeconds()) {
  return db.prepare(`UPDATE jobs SET status='dead', lease_token=NULL, last_error=?1, updated_at=?2 WHERE id=?3 AND lease_token=?4`)
    .bind(error, now, job.id, job.lease_token);
}

/** SQL fragment + binds that make any statement conditional on still holding the lease. */
export const LEASE_HELD = 'EXISTS (SELECT 1 FROM jobs WHERE id=? AND lease_token=?)';
export const leaseBinds = (job: QueueJob) => [job.id, job.lease_token];

/** Enqueue the next step only if the current lease is still held (put before completeStmt). */
export function enqueueNextStmt(db: D1Database, job: QueueJob, kind: string, payload: unknown, runAfter: number, now = nowSeconds()) {
  return db.prepare(
    `INSERT INTO jobs (kind, payload, status, run_after, attempts, created_at, updated_at)
     SELECT ?, ?, 'queued', ?, 0, ?, ? WHERE ${LEASE_HELD}`,
  ).bind(kind, JSON.stringify(payload), runAfter, now, now, ...leaseBinds(job));
}

/** Run a batch whose LAST statement is the fenced complete/fail; returns whether the lease held. */
export async function commit(db: D1Database, statements: D1PreparedStatement[]): Promise<boolean> {
  const results = await db.batch(statements);
  return (results.at(-1)?.meta.changes ?? 0) === 1;
}

/** Housekeeping: finished queue rows are kept a week for debugging, then deleted. */
export async function purgeFinished(db: D1Database, now = nowSeconds()) {
  await db.prepare(`DELETE FROM jobs WHERE status IN ('done','dead') AND updated_at < ?1`).bind(now - 7 * 86400).run();
}
