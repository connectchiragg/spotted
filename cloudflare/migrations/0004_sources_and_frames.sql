-- Phase 2: Google Photos / Drive sources and the frame + transcript pipeline.
--
-- videos.source          upload | photos | drive
-- videos.source_id       Photos media item id or Drive file id (NULL for uploads); with
--                        source it is unique, so importing the same item twice is a no-op
-- videos.source_meta     JSON needed to fetch it (Photos baseUrl + picker session, Drive
--                        modifiedTime, the source's size and duration when known)
-- videos.duration_seconds  from the MP4 header (or the source metadata)
-- status gains 'skipped' (over 100 MB or 10 minutes; never copied to R2)
--
-- google_auth      the single owner connection; the refresh token is AES-GCM encrypted
--                  (TOKEN_ENC_KEY secret) and never leaves the Worker
-- oauth_states     one-time CSRF states for the consent redirect (10-minute lifetime)
-- picker_sessions  Google Photos picker sessions being polled by the LibraryDO
-- drive_sync       the chosen Drive folder and the changes.list page token

ALTER TABLE videos ADD COLUMN source TEXT NOT NULL DEFAULT 'upload';
ALTER TABLE videos ADD COLUMN source_id TEXT;
ALTER TABLE videos ADD COLUMN source_meta TEXT;
ALTER TABLE videos ADD COLUMN duration_seconds REAL;
CREATE UNIQUE INDEX videos_source ON videos (source, source_id) WHERE source_id IS NOT NULL;

CREATE TABLE google_auth (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    refresh_token_enc TEXT NOT NULL,
    scopes TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'connected',   -- connected | reconnect_needed
    error TEXT,
    connected_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE oauth_states (
    state TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL
);

CREATE TABLE picker_sessions (
    id TEXT PRIMARY KEY,
    picker_uri TEXT NOT NULL,
    status TEXT NOT NULL,                       -- waiting | imported | expired | failed
    error TEXT,
    imported INTEGER NOT NULL DEFAULT 0,
    skipped INTEGER NOT NULL DEFAULT 0,
    expire_time TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE drive_sync (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    folder_id TEXT NOT NULL,
    folder_name TEXT,
    page_token TEXT,
    initial_done INTEGER NOT NULL DEFAULT 0,
    last_sync_at TEXT,
    error TEXT,
    updated_at TEXT NOT NULL
);
