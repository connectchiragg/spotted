# Framer

**Find the moment.** A video library you can search in plain language, with AI-generated summaries, tags, and playable frame citations.

Live application: **https://framer.haciensus.com** · Portfolio: **https://haciensus.com**

Framer is an independent project. The original assessment videos and records have been removed; the deployed library starts empty.

## What it does

- Choose an optional display name, then upload directly from your browser to private S3 with progress reporting. The original filename is preserved.
- Follow its status through queued, processing, completed, or failed.
- Archive requests to hide them from active history and search; restore them from the Archived filter. Archiving does not erase their data or stop a running job.
- After tagging, description embeddings flag possible duplicates at cosine similarity >= 0.95. This is advisory: it never merges or deletes either video.
- Read the saved summary and tags in the library sidebar.
- Describe an object, scene, or action in ordinary language.
- Get up to three relevant videos with a grounded answer and supporting frame citations.
- Play a result inline from the cited timestamp. Each query is independent.

The public demo is a **shared library**: uploaded videos and their analysis are visible to other visitors. Upload only videos you have permission to share. It has no user accounts or conversation memory; visitors share the library and its archive/restore controls.

## Architecture

```text
Browser ── HTTPS / Cloudflare ── FastAPI + Uvicorn
   │                               │
   └── signed upload ── S3          └── PostgreSQL
                         │             requests + leased queue + pgvector
                         └── Python worker ── FFmpeg frames ── Gemini
                                                │
                                       local BGE embeddings
```

The API and worker are separate systemd services on one AWS EC2 host. PostgreSQL is private to that host. S3 stores original videos; no SQS, managed database, load balancer, or NAT gateway is required.

### Ingestion

1. `POST /videos/uploads` validates filename, type and size and returns a ten-minute signed PUT URL.
2. The browser uploads directly to S3. Video bytes do not pass through the API process.
3. `POST /videos/{id}/complete` verifies the object size/type, then atomically records a pending job and queues it in PostgreSQL.
4. The worker leases a job using `FOR UPDATE SKIP LOCKED`, downloads the original to temporary disk, and compares up to 16 small, seeked thumbnails for pixel changes. It selects strong changes plus one to three coverage frames, keeps at least one second between selected moments, and extracts up to 16 JPEGs at a maximum dimension of 768 pixels. Each probe is capped at two seconds and the scan at 15 seconds; a timeout falls back to evenly spaced samples. Brief events between probes can be missed.
5. Gemini 3.5 Flash returns a summary, tags and detailed descriptions linked to sampled frames, covering visible colors, materials, textures, positions, and foreground/background objects without guessing hidden attributes. The worker saves these before acknowledging the queue message.
6. FastEmbed runs `BAAI/bge-small-en-v1.5` locally and stores 384-dimensional embeddings in pgvector columns.

Lease tokens reject stale updates. Transient provider failures retry up to three attempts. Completion is idempotent. A crash between inference and commit can still repeat an inference call. Systemd restarts failed services.

### Retrieval

Hybrid retrieval combines semantic similarity with keyword evidence and selects a supporting sampled frame. Exact query terms attributed by tags to the same valid frame also qualify, even when the frame caption omits a background object. Results are capped at three and filtered for relevance; no matches is a valid answer. Gemini generates a concise response from retrieved metadata, with validated numbered citations. If answer generation fails, retrieved matches remain available.

Vectors are stored in PostgreSQL, but retrieval currently scans candidates rather than using an approximate-nearest-neighbour index. Relevance thresholds are heuristics, not calibrated confidence scores. Pixel changes are not semantic events: camera movement and lighting can trigger capture, while subtle or brief actions may be missed. The frame budget is bounded, and generated tags can be incorrect.

### Possible duplicates

The worker embeds the summary and each frame description separately, averages and normalizes their vectors, then compares with active completed videos. Caching uses content hashes and a separate embedding namespace. Similarity 0.95 is a heuristic, not 95% confidence or proof of identical footage. Two distinct clips with similar descriptions can match, and identical footage can receive different descriptions. The check runs after tagging, so it does not avoid the initial Gemini call. Filename and display name are excluded.

## Public demo limits and costs

- 400 MB per upload, ten-minute maximum video duration.
- Uploaded videos expire from S3 after seven days; incomplete multipart uploads are aborted after one day. Metadata may remain in request history after the original expires.
- Shared budgets: 10 upload attempts and 100 query attempts per UTC day.
- Counters persist across process restarts in a small local SQLite file. Failed attempts count toward the budget.
- Legacy server-mediated upload endpoints are disabled in public mode.
- AWS provisioning requires an active **FREE** account plan with credits. A daily fail-closed guard stops compute when those conditions cannot be verified or credits fall below its reserve; a fixed expiry is also enforced.
- This is **credit-backed hosting, not a permanently free server**. No paid-plan upgrade is performed. Stopping compute does not delete S3 or disk storage; use the documented cleanup process when retiring the project.
- Gemini API quotas and billing belong to the configured Google project, separately from AWS. The application caps requests but cannot override provider billing settings.

## Run locally

Requires Python, FFmpeg/ffprobe, PostgreSQL 17 with pgvector, an S3 bucket and a Gemini API key. Secrets belong in `.env`, never Git or browser code.

```sh
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
cp .env.example .env
# Configure GEMINI_API_KEY, DATABASE_URL, S3_BUCKET and AWS credentials.
# Verify free-plan eligibility before setting AWS_USAGE_ENABLED=true.
./scripts/start_postgres.sh
.venv/bin/python scripts/prepare_embeddings.py
.venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

In a second terminal:

```sh
.venv/bin/python -m app.worker
```

Open http://127.0.0.1:8000. API documentation is at `/docs`.
The supplied PostgreSQL startup helper uses an isolated cluster under ignored `data/postgres`; its `PG_BIN` can be configured. `.env.example` contains the database connection and public-limit switches. AWS storage must be configured for upload/playback even when the API runs locally.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| POST | `/videos/uploads` | Start a direct upload |
| POST | `/videos/{id}/complete` | Confirm and enqueue |
| GET | `/videos` | Paginated history |
| GET | `/videos/{id}` | Status, name, tags, summary, signed preview |
| POST | `/videos/{id}/archive` | Soft-delete from active history and search |
| POST | `/videos/{id}/restore` | Restore an archived request |
| GET | `/videos/{id}/frames/{index}` | Supporting JPEG |
| POST | `/query` | Natural-language query `{ "q": "someone cleaning a grill" }` |
| GET | `/search?q=...` | Retrieval without generated answer |
| GET | `/videos?tags=kitchen&tags=bedroom` | Legacy exact OR tag matching |
| GET | `/health` | API process health |

## Verification

```sh
.venv/bin/python -m pytest -q
# Optional isolated-schema database integration tests:
TEST_POSTGRES_DSN=postgresql://YOUR_USER@127.0.0.1:54329/irl \
  .venv/bin/python -m pytest -q tests/test_postgres.py
```

Latest verification includes PostgreSQL integration, pixel-change sampling and frame-linked tag retrieval tests. A synthetic public upload completed tagging and was retrieved with a frame citation; a real browser played it inline. Generated query answers used the documented retrieval fallback during this check. The synthetic uploads were removed afterward.

Tests cover real FFmpeg media decoding, upload validation, signed-upload constraints, durable queue races, retries, stale claims, PostgreSQL vectors, retrieval, answer citations and concurrent daily-budget enforcement. Provider unit tests use substitutes; they do not establish tagging accuracy.

MP4, MOV, MKV, AVI and WebM decoding are tested. Browser playback depends on the actual codec; unsupported playback offers an original-file link. Signed preview URLs request one-day validity but temporary AWS credentials can expire earlier.

## Deployment

Framer deployment scripts and systemd units are under `scripts/` and `deploy/`. Private resource manifests and SSH keys stay in ignored `data/framer-deploy/`. Cloudflare's fixed-origin HTTPS proxy is configured in `deploy/cloudflare/wrangler.jsonc`.

Deployment uses a fresh database, not an assessment snapshot. Keep the API and worker pointed at the same database. Do not stop a working local worker for a remote cutover until the remote services are verified.

## Next improvements

Authentication and per-user libraries, calibrated retrieval evaluation, denser scene sampling, an ANN index, database backups, per-job resource limits, and observability beyond process health. The tagging-provider interface allows model replacement; the experimental local CLIP adapter is available but is not the default because its evaluated labels were less reliable.

### Citation frames
Ingestion uploads the already-extracted JPEG frames to the video's private S3
prefix while Gemini tagging runs concurrently. No GIFs or resized intermediate
videos are generated. Search cards show stored still frames and link to the
original video at the cited timestamp. Completed legacy videos with prepared
assets remain compatible. Cards keep consistent sizing and subtle hover zoom.

### Processing progress
The worker persists claim-token guarded stages, progress and rough ETA estimates.
The UI polls every three seconds and updates countdowns between polls; no manual
refresh is required. Percentages represent pipeline stages, not bytes decoded.
Queue/download estimates may be unknown; longer-than-estimated work is shown
explicitly. A request reaches 100% only after tags and citation frames are saved.

### Bounded worker concurrency
Run one worker process: it handles at most two jobs, with one shared download/
decoding lane and up to three parallel JPEG uploads per job. Gemini calls overlap
uploads and the next video's decoding. Duplicate detection and embedding indexing
share a single worker-side lock. These are per-process limits; starting additional
worker processes multiplies them.

The default Gemini request timeout is 30 seconds. A transient inference failure
gets one retry with 1–2 seconds of jitter, reusing the extracted images; it does
not restart download/extraction. Quota, credential and malformed-output failures
are not retried. Set `GEMINI_TIMEOUT_SECONDS=30` in the deployed environment too:
an existing environment value overrides the default. Transport timeouts are not
an end-to-end ingestion deadline. Logs report decoder wait, download, extraction,
frame upload, model attempts, duplicate checks and indexing times.
