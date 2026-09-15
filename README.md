# Instawork video tagger

Local API and worker services with private AWS S3 storage, an SQS queue, SQLite
request history, and Gemini image tagging. The browser UI shows upload progress,
processing state, video previews, summaries and tags. Exact OR tag search is
available through the API.

## Run locally

Requires Python 3.11+ and FFmpeg/ffprobe on PATH (on macOS: `brew install ffmpeg`).

```sh
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
cp .env.example .env
# Set GEMINI_API_KEY and an available GEMINI_MODEL in .env.
# Configure a valid default AWS profile and verify free-plan eligibility/allowance.
# Only then set AWS_USAGE_ENABLED=true in .env and provision:
.venv/bin/python scripts/provision_aws.py
.venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000
```

In a second terminal, run the worker from the same project directory:

```sh
.venv/bin/python -m app.worker
```

Open http://127.0.0.1:8000/ for the UI or http://127.0.0.1:8000/docs for API docs.

```sh
curl --fail-with-body -X POST http://127.0.0.1:8000/videos \
  -F 'file=@/Users/omen/Downloads/assignment_videos/1.mp4'
curl http://127.0.0.1:8000/videos
curl http://127.0.0.1:8000/videos/REQUEST_ID
```

`POST /videos` waits for S3 storage, then returns HTTP 202 with the request ID,
status and private presigned preview/download URL. Analysis runs in the worker.
`GET /videos` supports bounded `limit`/`offset` pagination and returns all states.
`GET /videos/{id}` returns current state and the result when complete.
For exact OR tag search, repeat the `tags` query parameter:

```sh
curl 'http://127.0.0.1:8000/videos?tags=kitchen&tags=bedroom&limit=20&offset=0'
```

Only completed requests matching **any** requested tag are returned, once each.
Search ignores case, trims/collapses whitespace, and does not match substrings,
synonyms or summary text. Empty labels, labels longer than 80 characters, and
more than 20 query tags return 422. No tags means unfiltered request history.
Filtering is parameterized SQL and happens before pagination. This first draft
uses SQLite JSON tag arrays; a dedicated indexed tag table is the next scaling
step. Search does not call AWS or Gemini; presigned URLs are computed locally.
The UI polls every three seconds and shows the latest 50 requests.

Each read generates a URL requesting 86,400-second validity. A URL signed with
shorter-lived temporary AWS credentials expires when those credentials expire;
reopening status/history gets a fresh link. Failed decoding requests retain their
S3 object and preview link. An S3 upload failure has no video link.

### Data flow and recovery

1. API saves an `uploading` request in SQLite and puts the video in private S3.
2. API changes it to `pending` and sends only `request_id` to SQS.
3. Unpublished pending rows act as a durable outbox. The worker republishes them
   if the API crashes or SQS send fails. Duplicate sends are safe.
4. Worker atomically claims the request as `processing`, with a lease/token.
5. Worker downloads the video, extracts up to eight JPEGs, calls Gemini and
   commits `completed` with tags, timestamps and model information.
6. Worker acknowledges SQS only after persisting the outcome. Completed/failed
   redeliveries are acknowledged without calling Gemini again.
7. Transient AWS/Gemini quota/timeouts retry up to three claims. Invalid videos
   and nontransient errors become `failed`. Expired claims can be reclaimed;
   stale workers cannot overwrite a newer claim's result. Interrupted uploads
   become failed after 15 minutes while the worker is running.

SQLite uses WAL and short transactions; API and worker must use the same local
`DATABASE_PATH`. SQS visibility and the DB lease default to ten minutes and grow
with configured processing bounds. A crashed worker can therefore delay retry
until visibility expires. This is at-least-once processing, not exactly-once
inference: a crash after inference but before commit can repeat the API call.

Only extracted images are sent to Gemini. No audio is analyzed. Worker temporary
files are removed; originals persist in S3 and metadata/results persist in SQLite.
`frame_indices` are zero-based references to the result's `sampled_timestamps`.

The original synchronous `POST /videos/tag` remains available for diagnosis. It
returns tags immediately and does not add to history or retain uploaded media.

## Model switching

Change `GEMINI_MODEL` in `.env` and restart. A different provider implements
`Tagger.tag_frames` and is wired through `get_tagger`; the upload, media extraction
and response contracts do not depend on Google's SDK. Prompt version is recorded
in each response. No automatic provider/model fallback hides a failed request.

## Sampling and limits

- Default: up to 8 frames, distributed over the full video using bin centers.
- Short videos target approximately one frame per five seconds.
- Images fit within 768 by 768 pixels, preserving aspect ratio.
- Default upload limit: 100 MB; duration limit: 10 minutes.
- ffprobe timeout: 15 seconds; each extracted frame: 10 seconds.
- Gemini timeout: 90 seconds; one attempt, with useful quota/timeout errors.
- Tags are normalized and deduplicated; evidence indices are validated.

These are sparse samples, so brief events can be missed. Evidence indices and
well-formed JSON do not establish semantic correctness. Review against the
sample-video reference tags before claiming accuracy.

## Tests

```sh
.venv/bin/python -m pytest -q
```

Tests execute real FFmpeg extraction on a generated clip and replace Gemini with
a test adapter. They cover upload validation, missing credentials, size limits,
provider failure, evidence validation, normalization, cleanup and API docs.
Queued-flow tests use test substitutes for S3, SQS and Gemini, but execute real
FFmpeg. They verify persisted results, status/history, duplicate delivery,
concurrent/stale claims, retry exhaustion, failed S3 upload, and outbox recovery.
They do not establish real AWS access or Gemini accuracy.

### Executed verification (September 15, 2026)

- 23 automated tests passed on Python 3.14.3; dependency deprecation warnings only.
- All four supplied MP4s passed through the original synchronous upload endpoint with actual FFmpeg
  and Gemini 3.6 Flash inference at eight sampled frames each:
  1.mp4: 16.44s; 2.mp4: 19.71s; 3.mp4: 12.65s; 4.mp4: 14.87s.
- These were in-process HTTP endpoint tests using FastAPI TestClient with real
  inference. The running localhost server also passed health and invalid-upload
  HTTP checks. Saved responses are local under ignored `artifacts/`.
- Earlier provider requests timed out, including a 16-frame request. These
  successful measurements are observations, not a latency or availability SLA.
- Main scene/activity tags match the independent candidate reference. Specialist
  material labels and precise evidence indices require further human review.
- Concrete review finding: video 3's `washing hands` tag cites frame 0 (16.715s),
  which shows sponge handling. Handwashing occurs later in the video, but the
  cited evidence is wrong. Index bounds validation cannot establish visual truth.

## Current scope and limits

No search UI, authentication or cloud deployment is included yet. Bind the API to
localhost. Multipart parsing spools uploads before the endpoint's size check;
public hosting needs request-body and concurrency limits at the server boundary.
SQLite and local polling suit one machine, not separately deployed replicas.
For production: a shared database, transactional outbox publisher, worker
heartbeats, queue dead-letter policy, authenticated access, lifecycle retention,
metrics/cost controls and model-quality evaluation. S3 and SQLite changes are
not atomic; interrupted uploads can leave an object requiring reconciliation.
AWS resources persist until explicitly removed; the provisioning script creates
only assessment-named resources in ap-south-1 with encryption and public access
blocked. It writes resource names into the ignored .env, never credentials.

## Decisions

- User first selected synchronous ingestion, then requested S3/SQS with a separate
  worker, persistent status/history and previews. Exact OR search was added next at the user's request.
- User selected Gemini and image sampling, rather than uploading complete videos.
- Reference tags are reviewed independently of model predictions.
- Live provider testing rejected the supplied JSON Schema, while JSON mode
  succeeded. The adapter uses JSON mode plus strict application validation.
- A model-list response did not guarantee inference access: the provider rejected
  Gemini 2.5 Flash for new users and recommended Gemini 3.6 Flash.
- Reduced the default sample count after a 16-frame request hit the inference
  timeout. This trades temporal coverage for synchronous demo latency.
- Independent reference review initially mislabeled a hoe as a shovel; closer
  inspection corrected the reference. Reference annotations also need validation.

## AWS cost boundary

AWS usage is disabled by default (`AWS_USAGE_ENABLED=false`). Provisioning,
uploads and worker polling remain disabled until free-plan eligibility and
remaining allowances have been verified. Read-only local history/search works
while AWS is disabled. Do not enable this flag merely because the workload is
small: budget alerts are not hard spending caps, and free-tier eligibility is
account-specific. No paid-plan upgrade is authorized.
