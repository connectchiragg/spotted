/** The EC2 export converter produces SQL that D1 accepts and the queue can consume. */
import { env } from 'cloudflare:test';
import { expect, it } from 'vitest';
// @ts-expect-error plain ESM script without type declarations
import { toSql } from '../../scripts/ec2-to-d1.mjs';
import * as queue from '../../src/queue';

it('imports EC2 rows into videos and queues re-embedding / re-ingestion', async () => {
  const db: D1Database = env.DB;
  await db.batch(['jobs', 'videos', 'step_results'].map((t) => db.prepare(`DELETE FROM ${t}`)));
  const base = { object_key: 'videos/x/source', content_type: 'video/mp4', created_at: '2026-09-01T00:00:00+00:00', updated_at: '2026-09-01T00:00:00+00:00', uploaded: 1, attempts: 1 };
  const sql: string = toSql([
    { ...base, id: 'done', filename: "it's.mp4", status: 'completed', result: { summary: 's', tags: [] }, expected_size: '123' },
    { ...base, id: 'mid', filename: 'b.mp4', status: 'processing', result: null },
    { ...base, id: 'lost', filename: 'c.mp4', status: 'uploading', uploaded: 0, result: null },
  ], 500);
  await db.batch(sql.trim().split('\n').map((s) => db.prepare(s)));
  const videos = (await db.prepare('SELECT id, filename, status, expected_size, json_extract(result, "$.summary") AS summary FROM videos ORDER BY id').all()).results;
  expect(videos).toEqual([
    { id: 'done', filename: "it's.mp4", status: 'completed', expected_size: 123, summary: 's' },
    { id: 'lost', filename: 'c.mp4', status: 'failed', expected_size: null, summary: null },
    { id: 'mid', filename: 'b.mp4', status: 'pending', expected_size: null, summary: null },
  ]);
  const first = await queue.claim(db, 500);
  const second = await queue.claim(db, 500);
  expect([first?.kind, second?.kind]).toEqual(['reindex', 'ingest.upload']);
});
