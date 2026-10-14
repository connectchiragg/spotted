// After an EC2 import: visit each imported video once so its VideoDO starts
// (pending) or re-embeds it (completed, needs_index). Uses public endpoints only.
//   node scripts/kick-imported.mjs https://framer-cf-api.<subdomain>.workers.dev framer-jobs.jsonl
import { readFileSync } from 'node:fs';

const [base, file] = process.argv.slice(2);
if (!base || !file) {
  console.error('Usage: node scripts/kick-imported.mjs <base-url> framer-jobs.jsonl');
  process.exit(2);
}
const ids = readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l).id);
for (const id of ids) {
  const res = await fetch(`${base}/videos/${encodeURIComponent(id)}`);
  console.log(id, res.status);
  await new Promise((r) => setTimeout(r, 1500)); // gentle: Workers AI and Gemini free limits
}
