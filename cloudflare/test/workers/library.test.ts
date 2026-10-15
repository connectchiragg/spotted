/** LibraryDO in workerd with Miniflare D1: Photos picker polling and Drive folder sync. */
import { env, runDurableObjectAlarm } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { DriveFile, Google, PickedItem } from '../../src/google';
import { LibraryDO } from '../../src/library';
import { settings } from '../helpers';

const db: D1Database = env.DB;
const lib = (env.LIBRARY as DurableObjectNamespace).get((env.LIBRARY as DurableObjectNamespace).idFromName('library')) as any;

beforeEach(async () => {
  await db.batch(['videos', 'picker_sessions', 'drive_sync', 'google_auth'].map((t) => db.prepare(`DELETE FROM ${t}`)));
});

/** The alarm may already be running (Miniflare fires due alarms itself): run it, then wait for `check`. */
async function settle(check: () => Promise<boolean>) {
  await runDurableObjectAlarm(lib);
  for (let i = 0; i < 100 && !(await check()); i++) await new Promise((r) => setTimeout(r, 20));
}
const count = async (sql: string) => (await db.prepare(sql).first<any>()).n as number;

const item = (id: string, type = 'VIDEO'): PickedItem => ({ id, type, mediaFile: { baseUrl: `https://photos.test/${id}`, mimeType: type === 'VIDEO' ? 'video/mp4' : 'image/jpeg', filename: `${id}.mp4` } });

function fakeGoogle(over: Partial<Record<keyof Google, any>> = {}) {
  const calls: string[] = [];
  const g = {
    getPickerSession: async (id: string) => (calls.push(`get ${id}`), { id, pickerUri: 'https://photos.google.com/picker/x', mediaItemsSet: true }),
    listPickedItems: async () => [item('v1'), item('p1', 'PHOTO'), item('big'), item('v2')],
    photoVideoSize: async (url: string) => (url.endsWith('big') ? 150_000_000 : 5_000_000),
    driveStartPageToken: async () => 'token-1',
    listDriveVideos: async (): Promise<DriveFile[]> => [{ id: 'd1', name: 'a.mp4', mimeType: 'video/mp4', size: '1000', modifiedTime: '2026-09-01T00:00:00Z', parents: ['F'] },
      { id: 'd2', name: 'huge.mp4', mimeType: 'video/mp4', size: '200000000', modifiedTime: '2026-09-01T00:00:00Z', parents: ['F'] }],
    driveChanges: async () => ({ files: [{ id: 'd1', name: 'a.mp4', mimeType: 'video/mp4', size: '1200', modifiedTime: '2026-10-01T00:00:00Z', parents: ['F'] },
      { id: 'd3', name: 'b.mp4', mimeType: 'video/mp4', size: '1000', modifiedTime: '2026-10-01T00:00:00Z', parents: ['F'] },
      { id: 'x9', name: 'elsewhere.mp4', mimeType: 'video/mp4', size: '1000', modifiedTime: '2026-10-01T00:00:00Z', parents: ['OTHER'] }], removed: [], next: 'token-2' }),
    ...over,
  };
  return { google: g as unknown as Google, calls };
}

describe('LibraryDO', () => {
  it('imports the picked videos once, skips photos and videos over 100 MB', async () => {
    const { google } = fakeGoogle();
    LibraryDO.testDeps = () => ({ db, google, videos: null, settings });
    await db.prepare("INSERT INTO picker_sessions (id, picker_uri, status, created_at, updated_at) VALUES ('s1', 'u', 'waiting', 'now', 'now')").run();
    await lib.poke();
    await settle(async () => (await count("SELECT count(*) AS n FROM picker_sessions WHERE id='s1' AND status='imported'")) === 1);
    const rows = (await db.prepare("SELECT source_id, status, error FROM videos WHERE source='photos' ORDER BY source_id").all()).results;
    expect(rows).toEqual([
      { source_id: 'big', status: 'skipped', error: 'Skipped: over 100 MB' },
      { source_id: 'v1', status: 'pending', error: null },
      { source_id: 'v2', status: 'pending', error: null },
    ]);
    expect(await db.prepare("SELECT status, imported, skipped FROM picker_sessions WHERE id='s1'").first()).toEqual({ status: 'imported', imported: 2, skipped: 1 });
    // The same items picked again: no duplicates.
    await db.prepare("INSERT INTO picker_sessions (id, picker_uri, status, created_at, updated_at) VALUES ('s2', 'u', 'waiting', 'now', 'now')").run();
    await lib.poke();
    await settle(async () => (await count("SELECT count(*) AS n FROM picker_sessions WHERE id='s2' AND status='imported'")) === 1);
    expect(await count("SELECT count(*) AS n FROM videos WHERE source='photos'")).toBe(3);
  });

  it('keeps polling a session until items are set, at Google\'s interval', async () => {
    const { google } = fakeGoogle({ getPickerSession: async (id: string) => ({ id, pickerUri: 'u', mediaItemsSet: false, pollingConfig: { pollInterval: '7s' } }) });
    LibraryDO.testDeps = () => ({ db, google, videos: null, settings });
    await db.prepare("INSERT INTO picker_sessions (id, picker_uri, status, created_at, updated_at) VALUES ('s3', 'u', 'waiting', 'now', 'now')").run();
    const before = Date.now();
    await lib.poke();
    await settle(async () => true);
    await new Promise((r) => setTimeout(r, 100));
    const { runInDurableObject } = await import('cloudflare:test');
    const alarm = await runInDurableObject<LibraryDO, number | null>(lib, (_o, s) => s.storage.getAlarm());
    expect(alarm! - before).toBeGreaterThanOrEqual(6000);
    expect(alarm! - before).toBeLessThan(9000);
    expect((await db.prepare("SELECT status FROM picker_sessions WHERE id='s3'").first<any>()).status).toBe('waiting');
  });

  it('syncs a Drive folder: initial listing, then changes (new and modified files in the folder only)', async () => {
    const { google } = fakeGoogle();
    LibraryDO.testDeps = () => ({ db, google, videos: null, settings });
    await db.prepare("INSERT INTO drive_sync (id, folder_id, folder_name, updated_at) VALUES (1, 'F', 'Videos', 'now')").run();
    await lib.poke();
    await settle(async () => (await count('SELECT count(*) AS n FROM drive_sync WHERE initial_done=1')) === 1);
    let rows = (await db.prepare("SELECT source_id, status FROM videos WHERE source='drive' ORDER BY source_id").all()).results;
    expect(rows).toEqual([{ source_id: 'd1', status: 'pending' }, { source_id: 'd2', status: 'skipped' }]);
    expect(await db.prepare('SELECT page_token, initial_done FROM drive_sync').first()).toEqual({ page_token: 'token-1', initial_done: 1 });
    await db.prepare("UPDATE videos SET status='completed' WHERE source_id='d1'").run();
    await lib.poke(); // makes the next sync due now
    await settle(async () => (await count("SELECT count(*) AS n FROM drive_sync WHERE page_token='token-2'")) === 1);
    rows = (await db.prepare("SELECT source_id, status, expected_size FROM videos WHERE source='drive' ORDER BY source_id").all()).results;
    expect(rows).toEqual([{ source_id: 'd1', status: 'pending', expected_size: 1200 }, { source_id: 'd2', status: 'skipped', expected_size: 200000000 },
      { source_id: 'd3', status: 'pending', expected_size: 1000 }]);
    expect((await db.prepare('SELECT page_token FROM drive_sync').first<any>()).page_token).toBe('token-2');
    LibraryDO.testDeps = null;
  });
});
