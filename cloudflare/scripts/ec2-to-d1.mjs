// Convert an export of the EC2 Postgres "jobs" table into D1 SQL.
//
// On the EC2 host (one row_to_json object per line; see docs/cloudflare-port.md):
//   psql -d irl -Atc "SELECT row_to_json(j) FROM jobs j" > framer-jobs.jsonl
// Locally:
//   node scripts/ec2-to-d1.mjs framer-jobs.jsonl > framer-import.sql
//   wrangler d1 execute framer-cf-db --remote --file framer-import.sql
//
// - every request becomes a row in `videos` (same id, so R2 keys videos/<id>/... match S3)
// - completed videos get needs_index=1: their VideoDO recomputes the vectors with
//   Workers AI into Vectorize (EC2 FastEmbed vectors are not portable)
// - queued/processing videos become pending; their VideoDO starts ingestion from
//   the first step. Both happen when the video is first viewed (GET /videos/:id or
//   its SSE stream), or for all of them with scripts/kick-imported.mjs
// - uploads that never finished stay failed
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const quote = (v) =>
  v === null || v === undefined ? 'NULL'
    : typeof v === 'number' ? (Number.isFinite(v) ? String(v) : 'NULL')
      : `'${String(v).replace(/'/g, "''")}'`;
const json = (v) => (v === null || v === undefined ? 'NULL' : quote(typeof v === 'string' ? v : JSON.stringify(v)));

export function toSql(rows) {
  const out = [];
  for (const r of rows) {
    if (!r.id || !r.filename || !r.object_key) throw new Error(`Row without id/filename/object_key: ${JSON.stringify(r).slice(0, 80)}`);
    const restart = r.uploaded === 1 && (r.status === 'pending' || r.status === 'processing');
    const status = restart ? 'pending' : r.status === 'uploading' ? 'failed' : r.status;
    const error = r.status === 'uploading' ? 'Upload interrupted during migration; submit the video again' : r.error;
    const needsIndex = status === 'completed' && r.result ? 1 : 0;
    out.push(`INSERT OR REPLACE INTO videos (id, filename, display_name, object_key, content_type, expected_size, status, uploaded, attempts, error, result, progress, archived_at, created_at, updated_at, needs_index) VALUES (${[
      r.id, r.filename, r.display_name, r.object_key, r.content_type, r.expected_size == null ? null : Number(r.expected_size), status,
      r.uploaded ?? 0, restart ? 0 : r.attempts ?? 0, error,
    ].map(quote).join(', ')}, ${json(r.result)}, NULL, ${quote(r.archived_at)}, ${quote(r.created_at)}, ${quote(r.updated_at)}, ${needsIndex});`);
  }
  return out.join('\n') + '\n';
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const file = process.argv[2];
  if (!file) {
    console.error('Usage: node scripts/ec2-to-d1.mjs framer-jobs.jsonl > framer-import.sql');
    process.exit(2);
  }
  const rows = readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  process.stdout.write(toSql(rows));
  console.error(`converted ${rows.length} rows`);
}
