import { env } from 'cloudflare:test';
import { exports } from 'cloudflare:workers';
import { runCron } from '../../src/index';
import { describe, expect, it } from 'vitest';

const worker = (exports as any).default as Fetcher;

describe('Worker entrypoint in workerd (D1 only: no R2, Vectorize or AI)', () => {
  it('serves health', async () => {
    const res = await worker.fetch('https://framer.test/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('serves the UI from static assets', async () => {
    const res = await worker.fetch('https://framer.test/');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('citationVisual');
  });

  it('lists history from D1, reports missing bindings as 503 and unknown routes as 404', async () => {
    const res = await worker.fetch('https://framer.test/videos');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [], limit: 50, offset: 0 });
    const upload = await worker.fetch('https://framer.test/videos/uploads', { method: 'POST',
      body: JSON.stringify({ filename: 'a.mp4', content_type: 'video/mp4', size_bytes: 1 }) });
    expect(upload.status).toBe(503);
    expect((await worker.fetch('https://framer.test/search?q=x')).status).toBe(503);
    expect((await worker.fetch('https://framer.test/nope')).status).toBe(404);
  });

  it('the cron handler runs housekeeping even without the ingestion bindings', async () => {
    const db: D1Database = env.DB;
    await db.prepare(`INSERT INTO videos (id, filename, object_key, content_type, status, created_at, updated_at)
      VALUES ('old', 'a.mp4', 'videos/old/source', 'video/mp4', 'uploading', '2000-01-01T00:00:00+00:00', '2000-01-01T00:00:00+00:00')`).run();
    expect(await runCron(env as any, { waitUntil: () => {} } as unknown as ExecutionContext)).toEqual([]);
    expect(await db.prepare("SELECT status FROM videos WHERE id='old'").first()).toEqual({ status: 'failed' });
  });
});
