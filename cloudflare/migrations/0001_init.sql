-- Framer on Cloudflare: one Postgres database (reached through Hyperdrive) holds
-- request metadata, the ingestion queue and pgvector embeddings.
--
-- The jobs/embeddings/frame_embeddings tables match the EC2 schema created by
-- app/postgres_store.py, so a data-only pg_dump from EC2 restores directly.
-- Every statement is idempotent; re-running this file is safe.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    filename TEXT NOT NULL,
    object_key TEXT NOT NULL,
    content_type TEXT NOT NULL,
    status TEXT NOT NULL,                 -- uploading | pending | processing | completed | failed
    created_at TEXT NOT NULL,             -- ISO-8601 UTC, as on EC2
    updated_at TEXT NOT NULL,
    error TEXT,
    result JSONB,
    uploaded INTEGER NOT NULL DEFAULT 0,
    queued INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0,
    lease_until DOUBLE PRECISION,
    claim_token TEXT,
    expected_size BIGINT
);
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS display_name TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS archived_at TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS progress JSONB;
CREATE INDEX IF NOT EXISTS jobs_created ON jobs (created_at DESC);

-- model is part of the key: Workers AI vectors ('@cf/baai/bge-small-en-v1.5')
-- live beside migrated EC2 vectors ('BAAI/bge-small-en-v1.5') and never mix.
-- Duplicate-detection vectors use the model key 'description:<model>'.
CREATE TABLE IF NOT EXISTS embeddings (
    job_id TEXT REFERENCES jobs (id),
    model TEXT,
    text_hash TEXT NOT NULL,
    vector vector NOT NULL,
    PRIMARY KEY (job_id, model)
);
CREATE TABLE IF NOT EXISTS frame_embeddings (
    job_id TEXT REFERENCES jobs (id),
    frame_index INTEGER,
    model TEXT,
    text_hash TEXT NOT NULL,
    vector vector NOT NULL,
    PRIMARY KEY (job_id, frame_index, model)
);

-- Ingestion queue. One row per video being ingested; the row is deleted when
-- the job reaches a terminal state. Claimed with FOR UPDATE SKIP LOCKED.
--   stage          step of the ingestion state machine (upload -> await_file -> tag -> index)
--   state          JSON payload carried between steps (Gemini file name, tagging result)
--   attempts       attempts of the CURRENT stage; reset to 0 when a stage succeeds
--   locked_until   visibility timeout; a crashed consumer's row becomes claimable after it
--   lock_token     fences stale consumers: every write requires the token it claimed with
--   run_after      earliest time the row may be claimed (backoff and polling delays)
CREATE TABLE IF NOT EXISTS ingest_queue (
    request_id TEXT PRIMARY KEY REFERENCES jobs (id) ON DELETE CASCADE,
    stage TEXT NOT NULL DEFAULT 'upload',
    state JSONB NOT NULL DEFAULT '{}'::jsonb,
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 3,
    lease_seconds INTEGER NOT NULL DEFAULT 900,
    locked_until TIMESTAMPTZ,
    lock_token TEXT,
    run_after TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ingest_queue_due ON ingest_queue (run_after, request_id);

-- Shared public-demo budgets (replaces the EC2 host's local SQLite usage.db).
CREATE TABLE IF NOT EXISTS usage_counters (
    day DATE NOT NULL,
    operation TEXT NOT NULL,
    count INTEGER NOT NULL,
    PRIMARY KEY (day, operation)
);

CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO schema_migrations (version) VALUES ('0001_init') ON CONFLICT DO NOTHING;
