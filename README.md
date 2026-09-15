# IRL — Instawork Robotics Lab

A local-first video discovery prototype: upload originals directly to private S3,
track processing, ask natural-language questions and play supporting moments.
Python/FastAPI + Uvicorn serve the API, a separate Python worker processes videos,
and PostgreSQL stores requests, the durable work queue and pgvector embeddings.
The UI is plain HTML/CSS/JavaScript with a main query conversation and request sidebar.

## Run locally

Requires Python 3.11+, FFmpeg/ffprobe, PostgreSQL 17 and pgvector.
The assessment was tested on Python 3.14.3, PostgreSQL 17.11 and pgvector 0.8.6.

```sh
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
cp .env.example .env
# Set GEMINI_API_KEY, S3_BUCKET and a valid AWS profile.
# Verify the AWS free plan before setting AWS_USAGE_ENABLED=true.
./scripts/start_postgres.sh
# DATABASE_URL=postgresql://YOUR_LOCAL_USER@127.0.0.1:54329/irl
.venv/bin/python scripts/prepare_embeddings.py
.venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000 --no-access-log
```

In another terminal:

```sh
.venv/bin/python -m app.worker
```

Open http://127.0.0.1:8000/ or API docs at http://127.0.0.1:8000/docs.
The start script keeps an isolated database cluster in ignored data/postgres;
`./scripts/start_postgres.sh stop` stops it. It does not modify other databases.
The PostgreSQL runtime must be installed separately; see the script's PG_BIN setting.

Existing SQLite assessment records can be migrated once, preserving IDs, results,
vectors and frame descriptions. Stop API/worker writes first:

```sh
.venv/bin/python scripts/migrate_postgres.py --source data/instawork.db \
  --dsn postgresql://YOUR_LOCAL_USER@127.0.0.1:54329/irl
```

The source database is retained. Without DATABASE_URL the legacy SQLite/SQS
backend remains available for compatibility; the running assessment uses PostgreSQL.

## Upload and processing

1. UI sends filename/type/byte size to `POST /videos/uploads`.
2. API creates an uploading record and returns a ten-minute signed S3 PUT.
3. Browser sends its File directly to S3 with progress reporting.
4. UI calls `POST /videos/{id}/complete`; API verifies actual size/type.
5. PostgreSQL atomically marks pending and enqueues the request ID.
6. Worker leases a queue row using `FOR UPDATE SKIP LOCKED`, then atomically
   claims the request. It downloads the original to temporary disk.
7. FFmpeg extracts up to eight JPEGs at evenly spaced timestamps, fit within 768px.
8. Gemini returns tags, summary and a factual description for each sampled frame.
9. Worker saves completed results before acknowledging the leased queue message;
   local BGE embeddings are persisted in pgvector columns.

The signed PUT binds size, content type, AES256 encryption and `If-None-Match: *`
to prevent overwrites. AWS credentials are never sent to the browser. S3 CORS
permits localhost:8000 and the approved `https://irl.haciensus.com` origin.
Repeated completion is idempotent. Failed confirmation can be retried in the UI
without reupload. Media decoding checks actual content rather than filename.

Requests expose uploading, pending, processing, completed or failed state.
Transient provider 500/502/503/504 failures use a maximum-three-attempt policy.
Claim tokens prevent stale workers overwriting a newer result. Retry queue
rescheduling invalidates the old receipt, so an old acknowledgement cannot remove
new work. A crash after inference before commit can still repeat an inference call.

Original videos remain in S3. No whole-video transcoding is performed. Temporary
worker files are removed. An abandoned upload can leave an orphaned S3 object;
lifecycle cleanup remains production work. SQS is no longer polled when DATABASE_URL
is configured; existing legacy AWS resources are not automatically deleted.

## Query, evidence and history

- `GET /videos?limit=50&offset=0`: request history; `GET /videos/{id}`: saved details.
- `GET /search?q=...`: local natural-language retrieval, without a generation call.
- `POST /query` with `{ "q": "show me someone cleaning a grill" }`: retrieval
  followed by a grounded Gemini answer citing numbered result cards.
- Queries are independent: each submission replaces the previous answer/results.
  Conversation context and CI/CD were explicitly deferred.
- `GET /videos/{id}/frames/{index}`: cached JPEG citation extracted from the original.
- Legacy exact OR API: `GET /videos?tags=kitchen&tags=bedroom`.
- Legacy server-mediated `POST /videos` and diagnostic `POST /videos/tag` remain.

Video tags/summary and each sampled-frame description are embedded locally using
BAAI/bge-small-en-v1.5 via FastEmbed (384 dimensions). Model assets download once;
embedding inference is offline. Model identifiers and content hashes control
reindexing. PostgreSQL stores vectors and computes cosine similarity; current
retrieval still scans candidates rather than using an approximate nearest-neighbour
index. It is not yet a production-scale vector query.

Search combines semantic relevance with keyword evidence and returns up to three
qualifying videos. No relevant matches returns an empty list. Thresholds/weights
are heuristics, not calibrated confidence. Gemini answers use only retrieved
metadata; invalid citations or provider failure preserve matches with a clear
fallback message. No context-resolution calls are made. Summaries
and captions can still be wrong; valid JSON does not establish visual truth.

Play buttons render video inside the result card at the supporting timestamp.
Request details and polling remain independent. A manual Refresh button updates
history without clearing the conversation. Saved request details contain the
summary, tags and original-video preview.

## Limits and compatibility

- Upload: 100 MB; duration: 10 minutes; up to 8 sampled frames by default.
- ffprobe: 15 seconds; each extracted frame: 10 seconds; Gemini tagging: 90 seconds.
- Query answer generation: 20 seconds.
- Browser upload: 120 seconds; uncompleted request expires after 15 minutes.
- Presigned preview URLs request one-day validity; temporary AWS credentials can
  expire sooner. Refreshing a request obtains a new link.
- Tested containers/codecs: MP4/H264, MOV/H264, MKV/MPEG4, AVI/MPEG4 and WebM/VP8.
  Browser playback support is separate from ingestion; unsupported previews offer
  the original file. Browser MIME values outside video/* use application/octet-stream.
- Sparse sampling can miss brief actions. Eight frames are not full video coverage.
- Source-resolution and hard worker memory limits are not implemented. Original
  bytes stay on disk, but FFmpeg decoding, frames, SDK buffers and embedding models
  still consume RAM. Extra worker processes generally duplicate model memory.

## Model choice

Gemini remains the selected default. `TAGGING_PROVIDER=local_clip` enables the
experimental offline CLIP adapter after `scripts/prepare_image_model.py` downloads
its matching vision/text encoders. There is no silent fallback. Both adapters
implement the same Tagger contract and record model/prompt version.

CLIP sampled-image inference on four videos took 1.24/.71/.71/.70 seconds, excluding
FFmpeg, with 1.93s initialization. It produced false cooking/brush tags and missed
workshop labels. These observed errors make it unsuitable as the current default.
A larger local VLM was not verified within the requested evaluation window.

## Verification

```sh
.venv/bin/python -m pytest -q
TEST_POSTGRES_DSN=postgresql://YOUR_LOCAL_USER@127.0.0.1:54329/irl \
  .venv/bin/python -m pytest -q
```

89 tests passed including four isolated-schema PostgreSQL integration tests. Tests cover real FFmpeg formats, validation, signed
upload constraints, queue races, retries, stale claims, migration, pgvector scores,
retrieval and grounded-answer validation. Model/AWS unit tests use substitutes.

Separately observed live: all four original videos tagged; direct browser S3 upload
with local CORS; no-overwrite rejection; preview/range loading; inline timestamp
playback; PostgreSQL migration; grounded Gemini answer with a grill citation.
A transient provider failure and several retrieval quality errors were found and
recorded rather than reported as perfect accuracy. See docs/defence.md.

## Demo hosting and cleanup

Deployment scripts under deploy/ and scripts/deploy_demo.sh prepare separate
systemd API/worker services on a temporary Ubuntu EC2 host, with PostgreSQL private
to that host. Cloudflare Worker/static configuration is under deploy/cloudflare.
No Docker is required. The public demo intentionally has no user login, as requested;
production requires authentication, quotas, rate limits and ownership checks.

scripts/provision_demo.py defaults to a dry run and refuses provisioning unless
AWS reports an active FREE plan with remaining credits. Explicitly approved demo
resources are recorded in ignored data/deploy/manifest.json. No paid-plan upgrade
is performed. Instance shutdown is configured to terminate it automatically.

`scripts/cleanup_demo.py` cleans only manifest-recorded temporary compute/identity
resources; it never deletes the existing video bucket. Stop local services separately.
Credit-backed compute is time-limited, not permanently free hosting. The user controls
final shutdown; confirm the actual instance termination schedule and cleanup results.
