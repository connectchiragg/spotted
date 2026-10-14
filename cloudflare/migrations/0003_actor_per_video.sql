-- Actor per video (owner decision): each video's ingestion state machine, its
-- idempotency keys and recorded Gemini results live in that video's VideoDO
-- (Durable Object storage). The D1 lease queue and D1 step records are no
-- longer used; they remain in git history (migrations 0001-0002).
--
-- videos.state_version  the VideoDO state version last mirrored into this row;
--                       a mirror write with an older version never lands.
-- videos.needs_index    1 for completed videos imported from EC2 whose vectors
--                       must be recomputed (the VideoDO re-embeds them).

DROP TABLE IF EXISTS jobs;
DROP TABLE IF EXISTS step_results;
ALTER TABLE videos ADD COLUMN state_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE videos ADD COLUMN needs_index INTEGER NOT NULL DEFAULT 0;
