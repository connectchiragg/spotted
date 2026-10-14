import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

// Runs inside workerd with a local Miniflare D1 database (wrangler env "test"),
// migrated from migrations/ before the tests: queue claims, leases, fencing,
// backoff, dead-lettering and the ingestion chain run against real D1 SQL.
export default defineConfig(async () => {
  const migrations = await readD1Migrations('./migrations');
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.jsonc', environment: 'test' },
        miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
      }),
    ],
    test: { include: ['test/workers/**/*.test.ts'], setupFiles: ['./test/workers/apply-migrations.ts'] },
  };
});
