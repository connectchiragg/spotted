/**
 * LibraryDO: one Durable Object (`LIBRARY.idFromName('library')`) that turns Google sources
 * into videos. Its alarm (no cron) does two jobs:
 *   - Google Photos picker sessions: poll sessions.get at Google's pollInterval until the
 *     owner has picked (mediaItemsSet), then list the picked items and create one video per
 *     picked VIDEO (photos/<media item id>, so a re-pick is a no-op);
 *   - Google Drive: on first run list the chosen folder (videos modified in the last
 *     DRIVE_LOOKBACK_MONTHS), then every DRIVE_POLL_MINUTES read changes.list from the stored
 *     page token: new files in the folder become videos, modified ones are re-processed.
 * Sources at or over MAX_SOURCE_MB are recorded as `skipped` and never downloaded. New videos
 * start staggered by IMPORT_STAGGER_S so a big pick does not burst the Gemini 15 RPM limit.
 */
import { DurableObject } from 'cloudflare:workers';
import { videoStub } from './actor';
import { Env, settings, Settings } from './env';
import { durationMs, DriveFile, Google, GoogleError, PickedItem } from './google';
import { decode as decodeVideo, nowIso, upsertSourceVideo, Video } from './store';
import { googleClient } from './video';

const DEFAULT_POLL_MS = 5_000;
const BASE_URL_TTL_MS = 55 * 60_000; // Picker baseUrls live 60 minutes

export interface LibraryDeps { db: D1Database; google: Google; videos: DurableObjectNamespace | null; settings: Settings }

export class LibraryDO extends DurableObject<Env> {
  static testDeps: (() => LibraryDeps) | null = null;

  private deps(): LibraryDeps | null {
    if (LibraryDO.testDeps) return LibraryDO.testDeps();
    const google = googleClient(this.env);
    if (!this.env.DB || !google) return null;
    return { db: this.env.DB, google, videos: this.env.VIDEO ?? null, settings: settings(this.env) };
  }

  /** Wake the alarm now (a new picker session, a new Drive folder, or a manual sync). */
  async poke(): Promise<void> {
    await this.ctx.storage.put('drive_due', 0);
    await this.ctx.storage.setAlarm(Date.now());
  }

  async alarm(): Promise<void> {
    const deps = this.deps();
    if (!deps) return;
    let next = Infinity;
    try {
      next = Math.min(next, await this.pollPickerSessions(deps));
    } catch (error) {
      console.warn('picker polling failed', (error as Error)?.message);
      next = Math.min(next, Date.now() + 60_000);
    }
    try {
      next = Math.min(next, await this.syncDrive(deps));
    } catch (error) {
      console.warn('drive sync failed', (error as Error)?.message);
      await deps.db.prepare('UPDATE drive_sync SET error=?1, updated_at=?2 WHERE id=1').bind((error as Error)?.message ?? 'Drive sync failed', nowIso()).run();
      if (!(error instanceof GoogleError && error.status === 401)) next = Math.min(next, Date.now() + 15 * 60_000);
    }
    if (Number.isFinite(next)) await this.ctx.storage.setAlarm(Math.max(next, Date.now() + 1000));
  }

  // ------------------------------------------------------------ Google Photos

  /** Returns when to poll again (Infinity if no session is waiting). */
  private async pollPickerSessions(deps: LibraryDeps): Promise<number> {
    const { results } = await deps.db.prepare("SELECT id, expire_time FROM picker_sessions WHERE status IN ('waiting', 'importing')").all<{ id: string; expire_time: string | null }>();
    let next = Infinity;
    for (const row of results) {
      if (row.expire_time && Date.parse(row.expire_time) < Date.now()) {
        await this.sessionStatus(deps, row.id, 'expired', 'The picker session expired before anything was picked');
        continue;
      }
      let session;
      try {
        session = await deps.google.getPickerSession(row.id);
      } catch (error) {
        if (error instanceof GoogleError && !error.retryable) { await this.sessionStatus(deps, row.id, 'failed', error.message); continue; }
        throw error;
      }
      if (!session.mediaItemsSet) {
        next = Math.min(next, Date.now() + durationMs(session.pollingConfig?.pollInterval, DEFAULT_POLL_MS));
        continue;
      }
      // 'importing' while the picked items are listed and their videos created (the UI shows it);
      // a crash here leaves the session 'importing', which the next alarm resumes (upserts are idempotent).
      await this.sessionStatus(deps, row.id, 'importing', null);
      const items = await deps.google.listPickedItems(row.id);
      const counts = await this.importPicked(deps, row.id, items);
      await deps.db.prepare("UPDATE picker_sessions SET status='imported', imported=?2, skipped=?3, updated_at=?4 WHERE id=?1")
        .bind(row.id, counts.imported, counts.skipped, nowIso()).run();
    }
    return next;
  }

  private sessionStatus(deps: LibraryDeps, id: string, status: string, error: string | null) {
    return deps.db.prepare('UPDATE picker_sessions SET status=?2, error=?3, updated_at=?4 WHERE id=?1').bind(id, status, error, nowIso()).run();
  }

  async importPicked(deps: LibraryDeps, sessionId: string, items: PickedItem[]): Promise<{ imported: number; skipped: number }> {
    let imported = 0;
    let skipped = 0;
    for (const item of items) {
      const mime = item.mediaFile?.mimeType ?? '';
      if (item.type !== 'VIDEO' && !mime.startsWith('video/')) continue; // photos are ignored
      const size = await deps.google.photoVideoSize(item.mediaFile.baseUrl).catch(() => null);
      const tooBig = size !== null && size >= deps.settings.maxSourceBytes;
      const { video, created } = await upsertSourceVideo(deps.db, {
        source: 'photos', sourceId: item.id, filename: item.mediaFile.filename || `${item.id}.mp4`, contentType: mime || 'video/mp4', size,
        meta: { session_id: sessionId, base_url: item.mediaFile.baseUrl, base_url_expires_at: new Date(Date.now() + BASE_URL_TTL_MS).toISOString(),
          created_time: item.createTime ?? null, width: item.mediaFile.mediaFileMetadata?.width ?? null, height: item.mediaFile.mediaFileMetadata?.height ?? null },
        status: tooBig ? 'skipped' : 'pending', error: tooBig ? `Skipped: over ${Math.round(deps.settings.maxSourceBytes / 1e6)} MB` : null,
      });
      if (tooBig) { skipped++; continue; }
      if (created) { imported++; await this.startVideo(deps, video); }
      else if (video.status === 'failed') {
        // A re-pick refreshes the 60-minute download link of a video that failed to copy.
        await deps.db.prepare("UPDATE videos SET source_meta=?2, status='pending', error=NULL WHERE id=?1")
          .bind(video.id, JSON.stringify({ ...(video.source_meta ?? {}), session_id: sessionId, base_url: item.mediaFile.baseUrl,
            base_url_expires_at: new Date(Date.now() + BASE_URL_TTL_MS).toISOString() })).run();
        imported++;
        await this.startVideo(deps, video, true);
      }
    }
    return { imported, skipped };
  }

  // ------------------------------------------------------------ Google Drive

  /** Returns when to sync again (Infinity when no folder is set). */
  private async syncDrive(deps: LibraryDeps): Promise<number> {
    const sync = await deps.db.prepare('SELECT * FROM drive_sync WHERE id=1').first<any>();
    if (!sync) return Infinity;
    const interval = deps.settings.drivePollMinutes * 60_000;
    const due = (await this.ctx.storage.get<number>('drive_due')) ?? 0;
    if (due > Date.now()) return due;
    const since = new Date(Date.now() - deps.settings.driveLookbackMonths * 30.44 * 86400_000).toISOString();
    if (!sync.initial_done) {
      const token = await deps.google.driveStartPageToken(); // before listing, so nothing slips between
      for (const file of await deps.google.listDriveVideos(sync.folder_id, since)) await this.importDrive(deps, file, false);
      await deps.db.prepare('UPDATE drive_sync SET page_token=?1, initial_done=1, last_sync_at=?2, error=NULL, updated_at=?2 WHERE id=1').bind(token, nowIso()).run();
    } else {
      const { files, removed, next } = await deps.google.driveChanges(sync.page_token);
      for (const file of files) {
        if (!file.mimeType?.startsWith('video/')) continue;
        if (!file.parents?.includes(sync.folder_id)) { await this.archiveDrive(deps, file.id); continue; } // moved out of the folder
        if (file.modifiedTime && file.modifiedTime < since) continue;
        await this.importDrive(deps, file, true);
      }
      for (const id of removed) await this.archiveDrive(deps, id); // deleted or trashed in Drive
      await this.applyPendingRefreshes(deps);
      await deps.db.prepare('UPDATE drive_sync SET page_token=?1, last_sync_at=?2, error=NULL, updated_at=?2 WHERE id=1').bind(next, nowIso()).run();
    }
    const at = Date.now() + interval;
    await this.ctx.storage.put('drive_due', at);
    return at;
  }

  async importDrive(deps: LibraryDeps, file: DriveFile, fromChanges: boolean): Promise<void> {
    const size = file.size ? Number(file.size) : null;
    const tooBig = size !== null && size >= deps.settings.maxSourceBytes;
    const input = {
      source: 'drive' as const, sourceId: file.id, filename: file.name, contentType: file.mimeType, size,
      meta: { modified_time: file.modifiedTime ?? null, duration_ms: file.videoMediaMetadata?.durationMillis ? Number(file.videoMediaMetadata.durationMillis) : null },
      status: (tooBig ? 'skipped' : 'pending') as 'skipped' | 'pending', error: tooBig ? `Skipped: over ${Math.round(deps.settings.maxSourceBytes / 1e6)} MB` : null,
    };
    const existing = await deps.db.prepare("SELECT source_meta FROM videos WHERE source='drive' AND source_id=?1").bind(file.id).first<{ source_meta: string | null }>();
    const changed = Boolean(fromChanges && existing && JSON.parse(existing.source_meta ?? '{}').modified_time !== (file.modifiedTime ?? null));
    const { video, created } = await upsertSourceVideo(deps.db, input, changed);
    if (tooBig) return;
    if (created) await this.startVideo(deps, video);
    // The file changed in Drive: process it again (deferred to the next sync while it is processing).
    else if (changed && video.status !== 'processing') await this.startVideo(deps, video, true);
  }

  // ------------------------------------------------------------ starting videos

  /** A Drive file left the folder (removed, trashed or moved): archive its video, which hides it but deletes nothing. */
  private async archiveDrive(deps: LibraryDeps, fileId: string): Promise<void> {
    await deps.db.prepare("UPDATE videos SET archived_at=COALESCE(archived_at, ?2) WHERE source='drive' AND source_id=?1").bind(fileId, nowIso()).run();
  }

  /** Changes that arrived while their video was processing (store.upsertSourceVideo): apply them now. */
  private async applyPendingRefreshes(deps: LibraryDeps): Promise<void> {
    const { results } = await deps.db.prepare(
      "SELECT * FROM videos WHERE source='drive' AND status!='processing' AND json_extract(source_meta, '$.refresh_pending')=1",
    ).all();
    for (const row of results) {
      const video = decodeVideo(row)!;
      const { refresh_pending: _, ...meta } = video.source_meta ?? {};
      const { video: fresh } = await upsertSourceVideo(deps.db, { source: 'drive', sourceId: video.source_id!, filename: video.filename,
        contentType: video.content_type, size: video.expected_size, meta, status: 'pending', error: null }, true);
      await this.startVideo(deps, fresh, true);
    }
  }

  private async startVideo(deps: LibraryDeps, video: Video, restart = false): Promise<void> {
    if (!deps.videos) return;
    const next = Math.max(Date.now(), (await this.ctx.storage.get<number>('next_start')) ?? 0);
    await this.ctx.storage.put('next_start', next + deps.settings.importStaggerSeconds * 1000);
    const stub = videoStub(deps.videos, video.id);
    try {
      if (restart) await stub.restart(video.id, next);
      else await stub.start(video.id, next);
    } catch (error) {
      console.warn('could not start video', video.id, (error as Error)?.message); // the GET/WS safety net retries
    }
  }
}
