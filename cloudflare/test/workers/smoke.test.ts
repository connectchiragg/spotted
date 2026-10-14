import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

const worker = (exports as any).default as Fetcher;

describe('Worker in workerd (smoke environment, no data bindings)', () => {
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

  it('reports missing data bindings as 503 and unknown routes as 404', async () => {
    expect((await worker.fetch('https://framer.test/videos')).status).toBe(503);
    expect((await worker.fetch('https://framer.test/nope')).status).toBe(404);
  });

  it('enforces public-demo guards before touching storage', async () => {
    const res = await worker.fetch('https://framer.test/videos/tag', { method: 'POST' });
    expect(res.status).toBe(403);
  });
});
