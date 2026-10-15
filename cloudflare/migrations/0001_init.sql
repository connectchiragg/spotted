-- Spotted on Cloudflare D1 (SQLite). Apply with:
--   wrangler d1 migrations apply spotted-db --remote
--
-- videos         Upload requests and their analysis (was "jobs" on EC2 Postgres)
-- jobs           the work queue, leased with locked_until/lease_token (owner-approved design)
-- usage_counters shared public-demo daily budgets (was a local SQLite file on EC2)
-- Vectors live in Vectorize (index spotted-vectors), not in D1.

CREATE TABLE videos (
    id TEXT PRIMARY KEY,
    filename TEXT NOT NULL,
    display_name TEXT,
    object_key TEXT NOT NULL,
    content_type TEXT NOT NULL,
    expected_size INTEGER,
    status TEXT NOT NULL,                  -- uploading | pending | processing | completed | failed
    uploaded INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    result TEXT,                           -- JSON: summary, tags, frame_descriptions, sampled_timestamps ...
    progress TEXT,                         -- JSON: stage, percent, eta_seconds, updated_at
    archived_at TEXT,
    created_at TEXT NOT NULL,              -- ISO-8601 UTC, as on EC2
    updated_at TEXT NOT NULL
);
CREATE INDEX videos_created ON videos (created_at DESC, id DESC);
CREATE INDEX videos_status ON videos (status);

-- Work queue. Correctness relies on D1 serialising writes: the claim is ONE
-- UPDATE ... WHERE id = (SELECT ... LIMIT 1) RETURNING statement, and every later
-- write is fenced by lease_token. status: queued | running | done | dead.
CREATE TABLE jobs (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL,
    payload TEXT NOT NULL,                 -- JSON
    status TEXT NOT NULL DEFAULT 'queued',
    run_after INTEGER NOT NULL,            -- epoch seconds
    locked_until INTEGER,                  -- epoch seconds; lease (visibility timeout)
    lease_token TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE INDEX jobs_status_run_after ON jobs (status, run_after);

CREATE TABLE usage_counters (
    day TEXT NOT NULL,
    operation TEXT NOT NULL,
    count INTEGER NOT NULL,
    PRIMARY KEY (day, operation)
);
