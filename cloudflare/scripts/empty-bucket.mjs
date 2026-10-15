// Delete every object in an R2 bucket so the bucket itself can be deleted (used by
// scripts/spotted-cleanup.sh). Usage: node scripts/empty-bucket.mjs <bucket-name>
// Uses your wrangler login through a remote binding; prints only counts.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getPlatformProxy } from 'wrangler';

const bucket = process.argv[2];
if (!bucket || !/^[a-z0-9-]{3,63}$/.test(bucket)) { console.error('Usage: node scripts/empty-bucket.mjs <bucket-name>'); process.exit(2); }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'empty-bucket-'));
const config = path.join(dir, 'wrangler.json');
fs.writeFileSync(config, JSON.stringify({ name: 'empty-bucket', compatibility_date: '2026-08-15', account_id: '0187f7c38bf35a8abcc4e9f9abfa213e',
  r2_buckets: [{ binding: 'B', bucket_name: bucket, remote: true }] }));
const { env, dispose } = await getPlatformProxy({ configPath: config });
let deleted = 0;
try {
  for (;;) {
    const page = await env.B.list({ limit: 1000 });
    if (!page.objects.length) break;
    await env.B.delete(page.objects.map((o) => o.key));
    deleted += page.objects.length;
  }
  console.log(`  emptied ${bucket}: ${deleted} objects deleted`);
} finally {
  await dispose();
  fs.rmSync(dir, { recursive: true, force: true });
}
