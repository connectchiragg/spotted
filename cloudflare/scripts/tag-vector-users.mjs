// Give every existing Vectorize entry the user_id of its video (migration 0005: one library per user).
// Search filters on user_id, so run this after creating the metadata index and before deploying:
//   npx wrangler vectorize create-metadata-index spotted-vectors --propertyName=user_id --type=string
//   node scripts/tag-vector-users.mjs           # dry run: counts only
//   node scripts/tag-vector-users.mjs --write   # re-upserts with user_id (values unchanged)
// Idempotent. Uses your wrangler login through remote bindings; prints only counts.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getPlatformProxy } from 'wrangler';

const write = process.argv.includes('--write');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tag-vectors-'));
const config = path.join(dir, 'wrangler.json');
fs.writeFileSync(config, JSON.stringify({ name: 'tag-vectors', compatibility_date: '2026-08-15', account_id: '0187f7c38bf35a8abcc4e9f9abfa213e',
  d1_databases: [{ binding: 'DB', database_name: 'spotted-db', database_id: '43256075-1f4b-4d4e-b239-7e7a12df0848', remote: true }],
  vectorize: [{ binding: 'V', index_name: 'spotted-vectors', remote: true }] }));
const { env, dispose } = await getPlatformProxy({ configPath: config });
// Same ids as src/vectors.ts vectorIdsOf: summary, 40 transcript windows, 40 frames.
const idsOf = (v) => [`s:${v}`, ...Array.from({ length: 40 }, (_, n) => `t:${v}:${n}`), ...Array.from({ length: 40 }, (_, i) => `f:${v}:${i}`)];
const hasUserColumn = (await env.DB.prepare("SELECT 1 FROM pragma_table_info('videos') WHERE name='user_id'").first()) !== null;
let videos = 0, found = 0, tagged = 0;
try {
  const { results } = await env.DB.prepare(`SELECT id${hasUserColumn ? ', user_id' : ''} FROM videos`).all();
  for (const row of results) {
    videos++;
    const userId = row.user_id ?? 'owner'; // before 0005, every video is the owner's
    const ids = idsOf(row.id);
    for (let i = 0; i < ids.length; i += 20) {
      const vectors = await env.V.getByIds(ids.slice(i, i + 20));
      found += vectors.length;
      const stale = vectors.filter((v) => v.metadata?.user_id !== userId);
      if (write && stale.length) await env.V.upsert(stale.map((v) => ({ id: v.id, values: Array.from(v.values), metadata: { ...v.metadata, user_id: userId } })));
      tagged += stale.length;
    }
  }
  console.log(`  ${videos} videos, ${found} vectors, ${tagged} ${write ? 'tagged' : 'to tag (dry run; pass --write)'}`);
} finally {
  await dispose();
  fs.rmSync(dir, { recursive: true, force: true });
}
