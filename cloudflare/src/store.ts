import { Db, Row, nowIso } from './db';

export interface Job extends Row {
  id: string;
  filename: string;
  object_key: string;
  content_type: string;
  status: string;
  created_at: string;
  updated_at: string;
  error: string | null;
  result: any;
  uploaded: number;
  attempts: number;
  expected_size: number | null;
  display_name: string | null;
  archived_at: string | null;
  progress: any;
}

export function decode(row: Row | undefined): Job | null {
  if (!row) return null;
  const job = { ...row } as Job;
  // postgres.js returns BIGINT as string.
  job.expected_size = row.expected_size == null ? null : Number(row.expected_size);
  if (typeof job.result === 'string') job.result = JSON.parse(job.result);
  if (typeof job.progress === 'string') job.progress = JSON.parse(job.progress);
  return job;
}

export async function createJob(db: Db, input: { filename: string; contentType: string; size: number; displayName?: string | null }): Promise<Job> {
  const id = crypto.randomUUID();
  const ts = nowIso();
  const rows = await db.query(
    `INSERT INTO jobs (id,filename,object_key,content_type,status,created_at,updated_at,expected_size,display_name)
     VALUES ($1,$2,$3,$4,'uploading',$5,$5,$6,$7) RETURNING *`,
    [id, input.filename, `videos/${id}/source`, input.contentType, ts, input.size, input.displayName ?? null],
  );
  return decode(rows[0])!;
}

export async function getJob(db: Db, id: string): Promise<Job | null> {
  return decode((await db.query('SELECT * FROM jobs WHERE id=$1', [id]))[0]);
}

export async function listJobs(db: Db, opts: { limit: number; offset: number; tags?: string[] | null; includeArchived?: boolean }): Promise<Job[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (!opts.includeArchived) where.push('archived_at IS NULL');
  if (opts.tags && opts.tags.length) {
    params.push(JSON.stringify(opts.tags));
    where.push(`status='completed' AND EXISTS (SELECT 1 FROM jsonb_array_elements(result->'tags') t
                WHERE t->>'label' IN (SELECT jsonb_array_elements_text($${params.length}::jsonb)))`);
  }
  params.push(opts.limit, opts.offset);
  const rows = await db.query(
    `SELECT * FROM jobs ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY created_at DESC, id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return rows.map((r) => decode(r)!);
}

export async function archiveJob(db: Db, id: string): Promise<boolean> {
  return (await db.query('UPDATE jobs SET archived_at=COALESCE(archived_at,$2) WHERE id=$1 RETURNING id', [id, nowIso()])).length === 1;
}

export async function restoreJob(db: Db, id: string): Promise<boolean> {
  return (await db.query('UPDATE jobs SET archived_at=NULL WHERE id=$1 RETURNING id', [id])).length === 1;
}

/** Mark the upload verified and enqueue it in ONE statement (no lost or duplicate jobs). */
export async function markUploadedAndEnqueue(db: Db, id: string): Promise<boolean> {
  const rows = await db.query(
    `WITH j AS (
       UPDATE jobs SET uploaded=1, queued=1, status='pending', updated_at=$2
       WHERE id=$1 AND status='uploading' RETURNING id)
     INSERT INTO ingest_queue (request_id) SELECT id FROM j
     ON CONFLICT (request_id) DO NOTHING RETURNING request_id`,
    [id, nowIso()],
  );
  return rows.length === 1;
}

export async function uploadFailed(db: Db, id: string, message: string): Promise<void> {
  await db.query(`UPDATE jobs SET status='failed', error=$2, updated_at=$3 WHERE id=$1 AND status='uploading'`, [id, message, nowIso()]);
}

/** Uploads never confirmed within 15 minutes fail, as on EC2. */
export async function expireUploads(db: Db, ageSeconds = 900): Promise<number> {
  const cutoff = new Date(Date.now() - ageSeconds * 1000).toISOString().replace('Z', '+00:00');
  const rows = await db.query(
    `UPDATE jobs SET status='failed', error='Upload interrupted; submit the video again', updated_at=$1
     WHERE status='uploading' AND updated_at < $2 RETURNING id`,
    [nowIso(), cutoff],
  );
  return rows.length;
}
