-- Run ONCE after restoring EC2 data (docs/cloudflare-port.md, step "Migrate data").
-- Videos that were queued or mid-processing on EC2 restart from the first
-- Cloudflare ingestion stage. Completed and failed videos are untouched.
-- Idempotent: rows already queued are skipped.

UPDATE jobs
SET status = 'pending', claim_token = NULL, lease_until = NULL, queued = 1,
    progress = NULL, updated_at = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"+00:00"')
WHERE uploaded = 1 AND status IN ('pending', 'processing');

INSERT INTO ingest_queue (request_id)
SELECT id FROM jobs WHERE uploaded = 1 AND status = 'pending'
ON CONFLICT (request_id) DO NOTHING;

INSERT INTO schema_migrations (version) VALUES ('0002_requeue_migrated_jobs') ON CONFLICT DO NOTHING;
