-- Many users: Spotted signs people in with Google itself (Cloudflare Access is no longer in front).
--
-- users          one row per person; id 'owner' for every OWNER_EMAILS address (the original
--                library; email = the owner address that signed in last), 'g:<Google sub>' otherwise
-- sessions       sign-in sessions; only the SHA-256 of the cookie token is stored
-- videos.user_id whose video it is; every existing video is the owner's
-- google_auth    now one Google connection per user (was a single row, id = 1)
-- picker_sessions.user_id   whose Photos picker session it is
-- oauth_states.purpose      'login' (sign in) or 'connect' (Google Photos/Drive), and for whom
-- Drive sync (drive_sync, id = 1) stays the owner's alone.

CREATE TABLE users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    name TEXT,
    picture TEXT,
    role TEXT NOT NULL,                        -- owner | guest
    created_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL
);

CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    email TEXT NOT NULL,                       -- the address that signed in (owners share one user)
    created_at INTEGER NOT NULL,               -- epoch seconds
    expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions (user_id);

ALTER TABLE videos ADD COLUMN user_id TEXT NOT NULL DEFAULT 'owner';
CREATE INDEX videos_user_created ON videos (user_id, created_at DESC, id DESC);
-- The same Photos item or Drive file may be in two people's libraries.
DROP INDEX videos_source;
CREATE UNIQUE INDEX videos_source ON videos (user_id, source, source_id) WHERE source_id IS NOT NULL;
DROP INDEX videos_idempotency_key;
CREATE UNIQUE INDEX videos_idempotency_key ON videos (user_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE google_auth_v2 (
    user_id TEXT PRIMARY KEY,
    refresh_token_enc TEXT NOT NULL,
    scopes TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'connected',  -- connected | reconnect_needed
    error TEXT,
    connected_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
INSERT INTO google_auth_v2 (user_id, refresh_token_enc, scopes, status, error, connected_at, updated_at)
    SELECT 'owner', refresh_token_enc, scopes, status, error, connected_at, updated_at FROM google_auth;
DROP TABLE google_auth;
ALTER TABLE google_auth_v2 RENAME TO google_auth;

ALTER TABLE picker_sessions ADD COLUMN user_id TEXT NOT NULL DEFAULT 'owner';
CREATE INDEX picker_sessions_user ON picker_sessions (user_id, created_at DESC);

ALTER TABLE oauth_states ADD COLUMN purpose TEXT NOT NULL DEFAULT 'connect';
ALTER TABLE oauth_states ADD COLUMN user_id TEXT;
ALTER TABLE oauth_states ADD COLUMN next TEXT;
