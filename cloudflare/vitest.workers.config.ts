import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

// Runs inside workerd (the real Workers runtime) against the bindings-free
// "smoke" environment: proves the bundle loads and the routes behave there.
export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.jsonc', environment: 'smoke' } })],
  test: { include: ['test/workers/**/*.test.ts'] },
});
