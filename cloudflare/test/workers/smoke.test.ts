import { env } from 'cloudflare:test';
import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

const worker = (exports as any).default as Fetcher;

describe('Worker entrypoint in workerd (D1 and VideoDO only: no R2, Vectorize or AI)', () => {
  it('serves health', async () => {
    const res = await worker.fetch('https://spotted.test/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('serves the UI from static assets', async () => {
    const res = await worker.fetch('https://spotted.test/');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('citationVisual');
  });

  it('lists history from D1, reports missing bindings as 503 and unknown routes as 404', async () => {
    const res = await worker.fetch('https://spotted.test/videos');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [], limit: 50, offset: 0 });
    const upload = await worker.fetch('https://spotted.test/videos/uploads', { method: 'POST',
      body: JSON.stringify({ filename: 'a.mp4', content_type: 'video/mp4', size_bytes: 1 }) });
    expect(upload.status).toBe(503);
    expect((await worker.fetch('https://spotted.test/search?q=x')).status).toBe(503);
    expect((await worker.fetch('https://spotted.test/nope')).status).toBe(404);
  });

  it('listing history expires uploads that were never confirmed (no background sweeper)', async () => {
    const db: D1Database = env.DB;
    await db.prepare(`INSERT INTO videos (id, filename, object_key, content_type, status, created_at, updated_at)
      VALUES ('old', 'a.mp4', 'videos/old/source', 'video/mp4', 'uploading', '2000-01-01T00:00:00+00:00', '2000-01-01T00:00:00+00:00')`).run();
    expect((await worker.fetch('https://spotted.test/videos')).status).toBe(200);
    expect(await db.prepare("SELECT status FROM videos WHERE id='old'").first()).toEqual({ status: 'failed' });
  });
});
