-- Idempotency for external side effects and resumable ingestion steps.
--
-- step_results  one durable record per (video_id, step) for every external call
--               whose result must not be repeated: the Gemini file upload
--               ('upload': name, uri) and the generateContent analysis ('tag':
--               the validated result plus token usage). A reclaimed job reads
--               this first and resumes instead of calling Gemini again.
--               idempotency_key is '<video_id>:<step>'.
-- usage_events  one row per counted budget request (idempotency key), so a
--               retried request with the same key is never counted twice.
-- videos.idempotency_key  optional client Idempotency-Key for POST /videos/uploads.

CREATE TABLE step_results (
    video_id TEXT NOT NULL,
    step TEXT NOT NULL,                       -- upload | tag
    idempotency_key TEXT NOT NULL UNIQUE,     -- '<video_id>:<step>'
    result TEXT NOT NULL,                     -- JSON
    job_id INTEGER,                           -- the job that performed the call (debugging)
    created_at INTEGER NOT NULL,              -- epoch seconds
    PRIMARY KEY (video_id, step)
);

CREATE TABLE usage_events (
    idempotency_key TEXT PRIMARY KEY,         -- '<operation>:<client key>'
    day TEXT NOT NULL,
    operation TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

ALTER TABLE videos ADD COLUMN idempotency_key TEXT;
CREATE UNIQUE INDEX videos_idempotency_key ON videos (idempotency_key) WHERE idempotency_key IS NOT NULL;
