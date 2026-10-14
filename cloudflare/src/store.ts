/** Framer video requests in D1 (the EC2 Postgres "jobs" table, renamed "videos"). */
export const nowSeconds = () => Math.floor(Date.now() / 1000);

export interface Video {
  id: string;
  filename: string;
  display_name: string | null;
  object_key: string;
  content_type: string;
  expected_size: number | null;
  status: string;
  uploaded: number;
  attempts: number;
  error: string | null;
  result: any;
  progress: any;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
  [key: string]: any;
}

export function nowIso(): string {
  // Same format as Python's datetime.now(timezone.utc).isoformat().
  return new Date().toISOString().replace('Z', '+00:00');
}

export function decode(row: any): Video | null {
  if (!row) return null;
  return { ...row, result: row.result ? JSON.parse(row.result) : null, progress: row.progress ? JSON.parse(row.progress) : null };
}

export async function createVideo(db: D1Database, input: { filename: string; contentType: string; size: number; displayName?: string | null; idempotencyKey?: string | null }): Promise<Video> {
  const id = crypto.randomUUID();
  const ts = nowIso();
  const key = input.idempotencyKey ?? null;
  // With a key, a concurrent duplicate request loses the unique index race and gets the winner's row.
  const row = await db.prepare(
    `INSERT INTO videos (id, filename, display_name, object_key, content_type, expected_size, status, created_at, updated_at, idempotency_key)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'uploading', ?7, ?7, ?8)
     ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING RETURNING *`,
  ).bind(id, input.filename, input.displayName ?? null, `videos/${id}/source`, input.contentType, input.size, ts, key).first();
  if (!row && key) return (await getVideoByIdempotencyKey(db, key))!;
  return decode(row)!;
}

export async function getVideoByIdempotencyKey(db: D1Database, key: string): Promise<Video | null> {
  return decode(await db.prepare('SELECT * FROM videos WHERE idempotency_key=?1').bind(key).first());
}

export async function getVideo(db: D1Database, id: string): Promise<Video | null> {
  return decode(await db.prepare('SELECT * FROM videos WHERE id=?1').bind(id).first());
}

export async function getVideos(db: D1Database, ids: string[]): Promise<Video[]> {
  if (!ids.length) return [];
  const { results } = await db.prepare(`SELECT * FROM videos WHERE id IN (SELECT value FROM json_each(?1))`).bind(JSON.stringify(ids)).all();
  return results.map((r) => decode(r)!);
}

export async function listVideos(db: D1Database, opts: { limit: number; offset: number; tags?: string[] | null; includeArchived?: boolean }): Promise<Video[]> {
  const where: string[] = [];
  const binds: unknown[] = [];
  if (!opts.includeArchived) where.push('archived_at IS NULL');
  if (opts.tags?.length) {
    binds.push(JSON.stringify(opts.tags));
    where.push(`status='completed' AND EXISTS (SELECT 1 FROM json_each(videos.result, '$.tags') t
                WHERE json_extract(t.value, '$.label') IN (SELECT value FROM json_each(?${binds.length})))`);
  }
  binds.push(opts.limit, opts.offset);
  const { results } = await db.prepare(
    `SELECT * FROM videos ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY created_at DESC, id DESC LIMIT ?${binds.length - 1} OFFSET ?${binds.length}`,
  ).bind(...binds).all();
  return results.map((r) => decode(r)!);
}

export async function archiveVideo(db: D1Database, id: string): Promise<boolean> {
  return (await db.prepare('UPDATE videos SET archived_at=COALESCE(archived_at, ?2) WHERE id=?1').bind(id, nowIso()).run()).meta.changes === 1;
}

export async function restoreVideo(db: D1Database, id: string): Promise<boolean> {
  return (await db.prepare('UPDATE videos SET archived_at=NULL WHERE id=?1').bind(id).run()).meta.changes === 1;
}

/** Mark the upload verified (uploading -> pending). True only for the call that made the change. */
export async function markUploaded(db: D1Database, id: string): Promise<boolean> {
  const res = await db.prepare(`UPDATE videos SET uploaded=1, status='pending', updated_at=?2 WHERE id=?1 AND status='uploading'`)
    .bind(id, nowIso()).run();
  return res.meta.changes === 1;
}

export async function uploadFailed(db: D1Database, id: string, message: string): Promise<void> {
  await db.prepare(`UPDATE videos SET status='failed', error=?2, updated_at=?3 WHERE id=?1 AND status='uploading'`).bind(id, message, nowIso()).run();
}

/** Uploads never confirmed within 15 minutes fail, as on EC2. */
export const UPLOAD_EXPIRY_SECONDS = 900;
export async function expireUploads(db: D1Database, ageSeconds = UPLOAD_EXPIRY_SECONDS): Promise<number> {
  const cutoff = new Date(Date.now() - ageSeconds * 1000).toISOString().replace('Z', '+00:00');
  const res = await db.prepare(
    `UPDATE videos SET status='failed', error='Upload interrupted; submit the video again', updated_at=?1
     WHERE status='uploading' AND updated_at < ?2`,
  ).bind(nowIso(), cutoff).run();
  return res.meta.changes;
}

