// Apply SQL migrations in order. Usage:
//   DATABASE_URL='postgresql://...' node scripts/migrate.mjs [0001_init.sql ...]
// With no file arguments, applies only 0001_init.sql (0002 is run once, after data migration).
// DATABASE_URL is read from the environment and never printed.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('Set DATABASE_URL (the direct, non-pooled Postgres URL).');
  process.exit(2);
}
const files = process.argv.slice(2).length ? process.argv.slice(2) : ['0001_init.sql'];
const sql = postgres(url, { max: 1, onnotice: () => {} });
try {
  for (const file of files) {
    const text = readFileSync(fileURLToPath(new URL(`../migrations/${file}`, import.meta.url)), 'utf8');
    await sql.begin((tx) => tx.unsafe(text));
    console.log(`applied ${file}`);
  }
} finally {
  await sql.end();
}
