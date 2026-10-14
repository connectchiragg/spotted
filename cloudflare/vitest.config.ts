import { defineConfig } from 'vitest/config';

// Node-run unit and Postgres integration tests. Runtime smoke tests inside
// workerd live in test/workers and use vitest.workers.config.ts.
export default defineConfig({
  test: {
    include: ['test/*.test.ts'],
    testTimeout: 20000,
  },
});
