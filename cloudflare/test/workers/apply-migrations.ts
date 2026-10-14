import { applyD1Migrations, env } from 'cloudflare:test';

await applyD1Migrations((env as any).DB, (env as any).TEST_MIGRATIONS);
