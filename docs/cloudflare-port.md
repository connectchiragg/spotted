# Framer on Cloudflare (free tier)

This branch (`cloudflare-port`) moves Framer off its AWS EC2 server. A Worker in
[`cloudflare/`](../cloudflare) runs it on Cloudflare's free tier. The Python app
in `app/` is unchanged and its tests still pass.

Status on 2026-10-15:
- **Created (free):** the D1 database `framer-cf-db` (migrations 0001–0002 applied), the Vectorize index `framer-cf-vectors`, and the R2 bucket `framer-cf-videos` (by the owner).
- **Deployed:** the API Worker `framer-cf-api` at https://framer-cf-api.connect-chirag-g.workers.dev, with the secrets `GEMINI_API_KEY`, `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`. The `framer-cf-smoke` Worker still exists (optional cleanup in §5). End-to-end results are in §7.
- **No cron.** A Durable Object alarm drives the queue (§2.2). Progress reaches the browser over Server-Sent Events (§2.3).
- **Unchanged:** nothing that points at `framer.haciensus.com`. That domain still belongs to the old `framer` proxy Worker. The EC2 instance is stopped, so the site is currently offline.

## 1. What Framer does today

A shared video library you can search in plain language:

1. **Upload.**
   - `POST /videos/uploads` validates the request and returns a presigned S3 PUT URL (400 MB max).
   - The browser uploads directly to S3.
   - `POST /videos/{id}/complete` checks the object's size and type, then queues the job in Postgres.
2. **Ingest.** The `framer-worker` service does this work:
   - It leases a job with `FOR UPDATE SKIP LOCKED`.
   - It downloads the video and probes it with **FFmpeg**.
   - It picks up to 16 frames by pixel change and extracts them as JPEGs. It uploads the JPEGs to S3 and sends them to **Gemini**, which returns a summary, tags with frame evidence, and a description of each frame.
3. **Index.**
   - **FastEmbed `BAAI/bge-small-en-v1.5`** runs in-process and produces 384-dim vectors. This is the ~450 MB RSS on the API. It embeds the video document, each frame description, and a "description" vector used for the advisory duplicate check (cosine ≥ 0.95).
   - The vectors are stored in **pgvector**.
4. **Search.**
   - `GET /search` and `POST /query` run a hybrid ranking: 75% semantic, 25% keyword, with frame citations, capped at 3 results.
   - `/query` adds a Gemini answer with validated `[n]` citations.
5. **Guards.**
   - **Budgets:** 10 uploads and 100 queries per UTC day, counted in a local SQLite file.
   - **Upload expiry:** unconfirmed uploads fail after 15 minutes.
   - **S3 lifecycle:** objects expire after 7 days.
   - **EC2 safeguards:** systemd timers that check the AWS free plan and stop the instance at the credit expiry.

**Data model (EC2 Postgres):**
- `jobs`: one row per upload request.
  - Status: uploading, pending, processing, completed or failed.
  - `result` JSONB: summary, tags[{label, category, frame_indices}], frame_descriptions, sampled_timestamps, duration, model and possible_duplicate.
  - Also: `progress` JSONB, archived_at and lease columns.
- `embeddings(job_id, model, vector)` and `frame_embeddings(job_id, frame_index, model, vector)`: pgvector.
- `work_queue(request_id, receipt, visible_at)`: the queue.
- **S3 objects:** `videos/<id>/source` (the original) and `videos/<id>/frames/<i>.jpg`.

## 2. Cloudflare architecture

| Today (EC2) | Cloudflare | Free-tier limits that matter | Source |
|---|---|---|---|
| FastAPI + Uvicorn | **Worker** `framer-cf-api` (TypeScript), UI served as static assets | 100k requests/day; **10 ms CPU** per request or cron run; 128 MB memory; 50 subrequests (1,000 to Cloudflare services); 100 MB request body | [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [pricing](https://developers.cloudflare.com/workers/platform/pricing/) |
| Background worker (systemd) | **Durable Object `FramerScheduler`** (one, SQLite-backed): an alarm drains the D1 queue when work is due; no cron | DOs on Free: SQLite backend only; 100k requests/day (alarms count); 13,000 GB-s/day duration; 30 s CPU per invocation; alarm handler 15 min wall time | [DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/), [DO limits](https://developers.cloudflare.com/durable-objects/platform/limits/), [alarms](https://developers.cloudflare.com/durable-objects/api/alarms/) |
| 3 s status polling | **SSE** `GET /videos/:id/events`, held by a per-video Durable Object `VideoEvents` | an open stream keeps its DO awake: 13,000 GB-s/day ÷ 128 MB ≈ 28.9 stream-hours/day across all videos | same as above |
| Postgres metadata | **D1** `framer-cf-db` (tables `videos`, `usage_counters`, `step_results`, `usage_events`) | 10 DBs; 500 MB per DB; 5M rows read and 100k rows written per day; 50 queries per invocation | [D1 limits](https://developers.cloudflare.com/d1/platform/limits/), [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) |
| Postgres `work_queue` + SKIP LOCKED | **D1 `jobs` table with leases** (owner's design, §2.1) | same as D1 | — |
| pgvector | **Vectorize** `framer-cf-vectors` (384 dims, cosine; metadata indexes `kind` and `video_id`) | 5M stored dimensions (≈13k vectors, ≈700 videos at 18 vectors each); 30M queried dimensions/month; topK ≤ 100 | [Vectorize pricing](https://developers.cloudflare.com/vectorize/platform/pricing/), [limits](https://developers.cloudflare.com/vectorize/platform/limits/) |
| FastEmbed in-process | **Workers AI** `@cf/baai/bge-small-en-v1.5` (384 dims; others: bge-base 768, bge-large 1024, bge-m3, embeddinggemma-300m, qwen3-embedding-0.6b, plamo-embedding-1b) | 10,000 neurons/day; bge-small costs 1,841 neurons per M tokens, so about 5 neurons per video | [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/), [models](https://developers.cloudflare.com/workers-ai/models/) |
| S3 (videos, frames) | **R2** `framer-cf-videos`: presigned PUT/GET over the S3 API; lifecycle 7 days | 10 GB-month; 1M Class A and 10M Class B ops per month; free egress; single PUT up to 5 GiB | [R2 pricing](https://developers.cloudflare.com/r2/pricing/), [presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/) |
| FFmpeg frame extraction | **Not possible on Workers.** Gemini samples ~16 frames of the video itself (`videoMetadata.fps`, §3.1) via its Files API and returns timestamped "moments" | Gemini Files API: 2 GB per file on the free tier, files kept 48 h; ~100 tokens/s at low media resolution | [Gemini video understanding](https://ai.google.dev/gemini-api/docs/video-understanding) |
| SQLite usage.db and the AWS free-plan timers | D1 `usage_counters`. Workers Free has hard limits that fail rather than bill, so the EC2 timers are unnecessary | — | — |

**Why D1 + Vectorize.** The owner first asked me to evaluate Postgres via Hyperdrive. Neon Free scales to zero after 5 idle minutes and gives 100 CU-hours per month, so a per-minute cron that touched Postgres would keep it awake past that budget. It also needed an external account. The owner then chose D1 + Vectorize; everything stays inside the Cloudflare account. The Postgres variant is in this branch's history (commits `f695474` and `3d98de4`) for reference.

**Note for the owner: Cloudflare Queues are now on the Free plan** (10,000 operations/day, 24 h retention, [Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/)), so "Queues are paid" is out of date. The D1 lease queue below was kept, as decided.

### 2.1 Queue design (D1, lease-based)

Schema (`cloudflare/migrations/0001_init.sql`):

```sql
CREATE TABLE jobs (
  id INTEGER PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL,     -- JSON
  status TEXT NOT NULL DEFAULT 'queued',                                 -- queued | running | done | dead
  run_after INTEGER NOT NULL, locked_until INTEGER, lease_token TEXT,    -- epoch seconds
  attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX jobs_status_run_after ON jobs (status, run_after);
```

The statements below are in `cloudflare/src/queue.ts`. Correctness relies on D1 serialising writes.

```sql
-- 1. claim (one atomic statement)
UPDATE jobs SET status='running', lease_token=:token, locked_until=:now+300,
       attempts=attempts+1, updated_at=:now
WHERE id=(SELECT id FROM jobs
          WHERE (status='queued' AND run_after<=:now) OR (status='running' AND locked_until<:now)
          ORDER BY run_after, id LIMIT 1)
RETURNING *;
-- 2. the work happens outside any lock
-- 3. complete: 0 rows changed means the lease was lost; nothing is overwritten
UPDATE jobs SET status='done', lease_token=NULL, updated_at=:now WHERE id=:id AND lease_token=:token;
-- 4. fail: quadratic backoff (30, 120, 270, 480 s), dead after 5 attempts
UPDATE jobs SET status=CASE WHEN attempts>=5 THEN 'dead' ELSE 'queued' END,
       run_after=:now+30*attempts*attempts, lease_token=NULL, last_error=:err, updated_at=:now
WHERE id=:id AND lease_token=:token;
```

**Behaviour:**
- **Visibility timeout.** A consumer that crashes or hits a CPU-limit kill leaves the job `running`. Once `locked_until` passes, the claim picks it up again.
- **Retry bound.** That reclaim path never checks `attempts`, so a job that keeps crashing would be retried forever. To stop this, a reclaimed job with `attempts > 5` is dead-lettered as soon as it is claimed.
- **Permanent errors** go straight to `dead` with the same fencing. Examples: an unsupported format, a duration over 10 minutes, a Gemini quota or credential error.

**Ingestion as a job chain.** The kinds are `ingest.upload`, `ingest.await_file`, `ingest.tag`, `ingest.index` and `reindex`.
- **Steps commit atomically.** A step ends with one `db.batch()` (a D1 transaction) that holds three statements. The first enqueues the next job and the second updates the `videos` row; both carry `AND EXISTS (SELECT 1 FROM jobs WHERE id=? AND lease_token=?)`. The third is the fenced complete. A consumer that lost its lease therefore changes nothing.
- **Waits don't consume retries.** While Gemini is still processing a file, the step enqueues a fresh `ingest.await_file` job 5 s later, so waiting uses no retry attempts.

**Consumer.** `runDueJobs(env, ctx)` in `cloudflare/src/consumer.ts` is trigger-agnostic. Each call:
- expires unconfirmed uploads after 15 minutes;
- purges `done`/`dead` rows and step records older than 7 days;
- claims and processes jobs until none are due, `QUEUE_STEPS_PER_TICK` (6) steps have run, or 10 minutes have passed.

Workers expose no CPU clock, so the CPU budget is enforced as a step count.

### 2.2 Scheduler: a Durable Object alarm instead of cron (owner decision)

`FramerScheduler` (`cloudflare/src/scheduler.ts`) is one global, SQLite-backed Durable Object (`idFromName("scheduler")`). It is **only an alarm clock**: D1 remains the queue and the source of truth, and the leases, fencing, idempotency and resumable steps are unchanged. Cloudflare Queues are not used.

- **Free plan.** Durable Objects are on Workers Free with the SQLite storage backend only ([DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)). Alarms count as requests (100,000/day) and each `setAlarm()` is one row written (100,000/day).
- **`wake(atMs)`** sets the alarm to the earlier of the current alarm and `atMs`. It is called when:
  - the API confirms an upload (`now`), and when it creates an upload request (its 15-minute expiry);
  - a step enqueues its next step (`run_after`) or schedules a retry (`now + 30·attempts²`).
- **`alarm()`** runs `runDueJobs`, then queries D1 for the next due time: the earliest queued `run_after`, running `locked_until + 1` (lease reclaim), or unconfirmed-upload expiry. It sets that alarm; **if nothing is pending it sets none**, so an idle site does no work. If more work is due than one invocation may do, the next alarm is "now", and each invocation gets a fresh budget.
- **Failure handling.** The handler never throws: if rescheduling fails it retries in 30 s. Alarms are at-least-once and retried on throw ([alarms](https://developers.cloudflare.com/durable-objects/api/alarms/)). Without the ingestion bindings or `GEMINI_API_KEY` it sets no alarm rather than spinning.
- **Duplicate or early wakes are harmless.** The alarm claims nothing that is not due.
- **Upload completion.** The browser `PUT`s to R2, then calls `POST /videos/:id/complete`. That handler verifies the object, creates the job and wakes the scheduler. The status endpoints never polled R2 before. Now, if a client reads `GET /videos/:id` or opens its SSE stream while the video is still `uploading` and the object is already in R2, the server runs the same verified completion. This covers a browser that died between the PUT and the confirmation.
- **Safety net for a lost wake-up.** `GET /videos/:id` and SSE (re)connects check whether the video has due or expired-lease jobs, and if so call `wake(now)`. Each request makes at most one D1 check and one wake, and each video is nudged at most once per 10 s per isolate, so reconnects cannot loop.
- **Cron removed.** `triggers.crons` is `[]` in `wrangler.jsonc`; an empty list is needed because omitting the key leaves an existing trigger in place. There is no `scheduled()` handler. Verified after deploy: the Worker has no schedules.
- **CPU.** The Workers limits page gives 10 ms CPU per invocation on Free. The DO limits page gives 30 s per invocation, including alarms ([DO limits](https://developers.cloudflare.com/durable-objects/platform/limits/)), and does not single out the Free plan. Each step is mostly network wait either way.

### 2.3 Live progress: Server-Sent Events (owner decision)

`GET /videos/:id/events` returns `text/event-stream`.

**Topology.** The stream is held by one **`VideoEvents` Durable Object per video** (`idFromName(video_id)`, SQLite-backed; `cloudflare/src/events.ts`). It does not live on the scheduler. An open SSE stream keeps its object awake, because hibernation applies only to WebSockets. Streams on the global scheduler would keep the scheduler awake for every viewer of every video. Per-video objects isolate traffic, need no routing table, and stop once their video's streams close.

**Flow.**
1. The API reads the video from D1, runs the safety-net nudge (§2.2), and forwards the snapshot to the video's object.
2. The object answers with the stream:
   - `retry: 3000`;
   - then, if `Last-Event-ID` is sent, every stored event after it (replay);
   - then the snapshot as event `status`.
   - A finished video also gets `done` or `failed`, and its stream closes immediately.
3. After every **committed** fenced change, the writer calls `publish()`, which stores the event (its sequence number is the event `id`) and pushes it to every open stream. A write whose fence failed never publishes, because callers check `commit()`'s result first. The events are:
   - `step`: a step finished;
   - `progress`: still waiting on Gemini;
   - `status`: upload confirmed, or a retry scheduled (with `retry_at`);
   - `failed` and `done`.
4. **Hygiene.**
   - `: ping` every 20 s.
   - All streams close on `done`/`failed`.
   - Each stream is capped at **5 minutes**, after which `EventSource` reconnects with `Last-Event-ID`.
   - Client disconnects are detected through `request.signal` (compat flag `enable_request_signal`). Writes are never awaited, so a slow reader cannot block an ingestion step, and a reader 32 chunks behind is dropped.
   - The event log keeps 200 events and is deleted a day after the last event.
5. **UI** (`cloudflare/public/index.html`).
   - One `EventSource` per active video (at most 5 per tab). Events update the history in place, and `done`/`failed` close the stream and refresh once.
   - The history list refreshes every 60 s (it was every 3 s), so other visitors' uploads still appear.
   - If `EventSource` is missing or errors 5 times in a row, the UI falls back to 3 s polling.

**Free-plan sizing** ([DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)).
- **Duration.** DO duration is wall-clock time while the object is active, charged at 128 MB. That is 13,000 GB-s/day ÷ 0.125 GB = **104,000 object-seconds ≈ 28.9 hours/day**. Streams on the same video share one object's duration.
- **Typical use.** With 10 uploads/day, ingestion of 1–3 minutes, and up to ~15 minutes of retry backoff in the worst case, this is minutes per day. A viewer of a stuck video costs at most 12 reconnects/hour.
- **Requests.** Each connection costs one Worker request plus one DO request (100,000/day each), and each publish is one DO request.
- **Worker side.** Workers Free charges CPU, not wall time ([Workers limits](https://developers.cloudflare.com/workers/platform/limits/)). The Worker only forwards the DO's stream.

## 3. Feasibility and risks

- **Ingestion on Workers.** Workers cannot run FFmpeg or any native binary, so this port changes how videos are analysed:
  - The Worker streams the R2 object into Gemini's resumable Files API upload. It uses `FixedLengthStream` and never buffers, which matters with 128 MB of memory.
  - Gemini samples the video itself, about 16 frames spread over its duration (§3.1), at low media resolution. It returns 1–16 timestamped **moments**. These map onto the existing `sampled_timestamps`, `frame_descriptions` and tag `frame_indices`, so retrieval and the UI are unchanged.
  - **What is lost:** stored JPEG citation frames. The UI now shows the video itself paused at the cited time (`citationVisual` in `cloudflare/public/index.html`). Migrated EC2 videos still use their JPEGs while those exist in R2.
  - **Formats:** MKV is not accepted by Gemini and fails with a clear error. MP4, MOV, WebM, AVI, MPEG, WMV, FLV and 3GP work.
  - **Unverified:**
    - **CPU time** of streaming 400 MB through a Worker. Body pass-through should be native and not count as JS CPU.
    - **Gemini timing.** Whether a `gemini-3.5-flash` call on a 10-minute video finishes within the 300 s lease.
    - **Fallback** if either fails: limit the upload size, or run ingestion off-Worker (e.g. a GitHub Actions job) against the same D1 queue through D1's HTTP API.
### 3.1 Frame sampling and token cost

**Request.** The video part carries `videoMetadata.fps = clamp(MAX_FRAMES / duration, 0.001, 1)`, rounded down to 4 decimals so `duration × fps ≤ MAX_FRAMES`. `generationConfig.mediaResolution` is `MEDIA_RESOLUTION_LOW`. This is `Gemini.tagRequest` in `cloudflare/src/gemini.ts`, and a unit test asserts the shape.

**Field and limits.**
- [`VideoMetadata.fps`](https://ai.google.dev/api/generate-content) has a documented range of (0.0, 24.0] and a default of 1.0. The API rejects 25 with "must be less than or equal to 24". It accepted 0.001.
- The reference marks `VideoMetadata` as deprecated in favour of `GenerateContentRequest.processing_options`, but `processing_options` is not yet listed among the request's fields.
- The [video guide](https://ai.google.dev/gemini-api/docs/video-understanding) now shows the newer Interactions-API `processing: {type: "static", fps}` shape.
- `videoMetadata.fps` works today on `generateContent`. Revisit it when `processing_options` ships.

**Measured** with the free `countTokens` endpoint on `gemini-3.5-flash`, using a 60 s 320×240 test clip:

| Request | Video tokens | Audio tokens | Total |
|---|---|---|---|
| default (1 fps) | 4,080 | 1,920 | 6,005 |
| `mediaResolution` low only | 4,080 | 1,920 | 6,005 |
| fps 0.2666 (16 frames) + low | 1,088 | 1,920 | 3,013 |

Video costs 68 tokens per frame (low is already the default for this model) and audio 32 tokens/s. For a 10-minute video, sampling cuts video tokens from ~40,800 to ~1,088, but audio stays at ~19,200. Clips of 16 s or less are unchanged, because they already sample at most 1 fps.

**Audio.** The decision is to keep it, for now.
- There is no API switch to exclude a video's audio track: the docs only describe audio being tokenised at 32 tokens/s.
- Removing it means re-encoding (dropping the stream), which Workers cannot do.
- Tags describe visible environments, objects and actions, so audio isn't needed for them. Speech can still help the summary.
- If the cost matters, the cheapest real fix is to strip audio before upload, e.g. a remux in the browser (WebCodecs/MediaRecorder) or the media service from §3.2. After sampling, audio is the dominant cost for long videos.

### 3.2 Future design note: frame selection by pixel deviation (not built)

EC2 picked frames by pixel change. Uniform sampling (§3.1) can miss short events and waste frames on static stretches.

**Goal.** Choose frames where the image changes meaningfully: scene and shot-change detection from inter-frame pixel deviation (e.g. histogram or SAD distance over downscaled frames, with a threshold plus minimum spacing, topped up with uniform frames for coverage), then send only those frames, or their timestamps.

**Constraint.** This needs decoding, which Workers can't do natively (no FFmpeg, 128 MB memory, 10 ms CPU on Free). Options:
1. **A WASM decoder in a Worker or DO.** ffmpeg.wasm or a WebCodecs-like WASM build, keyframes only, at low resolution. CPU limits make this marginal on Free: a DO has 30 s per invocation, so it is maybe feasible for short clips, but it needs measuring.
2. **A small media service** (container or serverless function) that reads the R2 object, runs FFmpeg scene detection, and writes JPEGs and timestamps back to R2. This is the most robust option, but it is outside the Cloudflare free tier, or uses Containers, which are paid.
3. **Gemini two-pass.** Pass 1 asks for timestamps of scene or shot changes on a cheap, very low-fps request. Pass 2 calls with `startOffset`/`endOffset` clips, or a higher fps around those timestamps. This needs no decoder, but it costs a second call and trusts the model's timestamps.

**Fit with the existing design.** Each option fits as another resumable step (e.g. `ingest.select_frames`) recorded in `step_results`.

### 3.3 Idempotency and resume

**Owner requirement.** Never repeat an external side effect for the same request. A reclaimed job resumes from the last durable state.

**Step records.** `step_results(video_id, step, idempotency_key = '<video_id>:<step>', result)` (migration `0002`) holds:
- **`upload`**: the Gemini file name and URI.
- **`tag`**: the validated `generateContent` result and its `usageMetadata`. The `index` step reads it from here, not from the job payload.

**When records are written.**
- A record is written as soon as the call returns, before the fenced commit.
- It is **not fenced**. It records an external fact (this file exists; this analysis was paid for), which stays true whoever holds the lease.
- The first writer wins (`ON CONFLICT DO NOTHING`).
- State transitions (next job, video row, completion) stay fenced. A crash between the call and the commit therefore loses nothing: the reclaimed job finds the record and moves straight on.

**Uploads are never repeated.**
- They use a deterministic Gemini file id, `files/framer-<uuid hex>` (≤ 40 chars of `[a-z0-9-]`, [File.name](https://ai.google.dev/api/files)), and display name `framer-<video_id>`.
- On retry the step reuses, in order:
  1. the recorded file;
  2. the deterministic name (GET);
  3. the display name (list).
  It reuses any of these if the file is `ACTIVE` or `PROCESSING`, and uploads only if none exists.
- A second upload under the same name gets 409 `ALREADY_EXISTS`, verified live. The client then returns the existing file.
- An expired or deleted file (Gemini keeps files 48 h) is uploaded again under the same name.

**`generateContent`.** If a `tag` record exists, the call is skipped.

**`index`.** It is idempotent by construction: Vectorize upserts deterministic ids, and the Gemini delete tolerates 404.

**Lease heartbeat** (`queue.withHeartbeat`).
- While an upload or `generateContent` runs, `locked_until` is extended every 60 s, which is a fifth of the 300 s lease. The update is fenced by `lease_token` and never shortens the lease.
- If a heartbeat finds the lease lost, the call is aborted through its `AbortSignal`, nothing is written, and the outcome is `lease-lost`.
- Each beat is one D1 query, so a 5-minute call costs 5 of the 50 queries per invocation.
- A killed Worker stops beating, and its lease lapses within 300 s.

**Budgets.**
- `usage_events` counts each `Idempotency-Key` once, in one D1 transaction with the counter.
- `POST /videos/uploads` with a key already used returns the same upload request; the UI sends a fresh key per upload.

**Tests.** Miniflare tests in `test/workers/resume.test.ts` cover:
- a crash after the upload;
- a lost record;
- an expired file;
- a crash after `generateContent`;
- stale and new holders;
- concurrent claims;
- heartbeat extension and lease loss;
- keyed budgets.

### 3.4 Other risks

- **10 ms CPU** per invocation on Workers Free.
  - Each step is mostly network wait, and the ranking runs on at most 50 candidates. A step that is killed for CPU is retried through its lease and dead-letters after 5 attempts.
  - Observability is enabled so `cpuTime` can be checked after cutover.
- **Embeddings change.** All stored vectors must be recomputed:
  - Workers AI vectors are not interchangeable with the FastEmbed vectors on EC2. They also live in a different store (Vectorize, not pgvector).
  - The importer queues a `reindex` job for every completed video.
  - The thresholds (`SEARCH_MIN_SIMILARITY=0.60`, duplicate 0.95) were tuned on FastEmbed and should be re-checked on real queries.
- **Candidate set.** Search ranks the 50 nearest videos plus any video whose tag labels contain a query word, rather than every video. Frame scores come from one top-100 Vectorize query; a frame outside it scores 0.
- **Free-tier ceilings.**
  - The UI no longer polls every 3 s. It uses SSE for active videos and refreshes the list every 60 s, which is 60 requests and ~3k D1 rows read per tab-hour (it was 1,200 and ~60k). SSE sizing is in §2.3.
  - Vectorize storage fits about 700 videos.
  - `/search` now also counts against the daily query budget, because it spends Workers AI neurons.
- **Plan assumption.** "Zero cost" assumes the Cloudflare account is on **Workers Free**, where limits fail instead of billing. I could not read the account's plan with the current token. If it is on Workers Paid, this usage stays within the included amounts.
- **Gemini billing** stays with the owner's Google project, as on EC2.

## 4. Data migration and cutover

The EC2 instance is **stopped**; don't leave it running. It has no Elastic IP, so its public IP changes on every start.

**Snapshot:**
1. Start the instance temporarily and note its new public IP.
2. On the instance (`ssh ubuntu@<new-ip>`), run:
   `psql -d irl -Atc "SELECT row_to_json(j) FROM jobs j" > framer-jobs.jsonl`
3. Copy `framer-jobs.jsonl` to this machine, then **stop the instance again**.

**Import:**
1. `cd cloudflare && node scripts/ec2-to-d1.mjs framer-jobs.jsonl > framer-import.sql`
2. `wrangler d1 execute framer-cf-db --remote --file framer-import.sql`
3. Imported jobs are not woken automatically, because nothing called the scheduler. Open any imported video (`GET /videos/:id`, or the UI) to trigger the safety-net wake. Alternatively, upload any video: its wake drains everything that is due.
4. Delete the `.jsonl`/`.sql` files afterwards: they contain user metadata.

**Objects:**
- Copy the S3 bucket (its name is in the ignored `data/framer-deploy/manifest.json`) into R2 `framer-cf-videos` with the same keys, e.g. with `rclone copy s3:<bucket> r2:framer-cf-videos`.
- An R2 API token is needed for that copy; S3 egress is AWS-billed beyond its free allowance.
- Because of the 7-day S3 lifecycle, only recent videos still have their originals. Older entries keep their metadata and become searchable after re-embedding, but cannot play.

**Cutover:**
1. Remove the custom domain from the old `framer` proxy Worker (`deploy/cloudflare/wrangler.jsonc`).
2. Add `"routes": [{ "pattern": "framer.haciensus.com", "custom_domain": true }]` to `cloudflare/wrangler.jsonc`.
3. Run `npm run deploy`.
4. Rollback is the reverse, plus restarting EC2.

## 5. Owner steps, in order

1. **Enable R2:** Dashboard → R2 → complete the R2 subscription checkout ($0 plan). This may ask for a payment method; I can't verify whether it does. Then:
   - `wrangler r2 bucket create framer-cf-videos`
   - `wrangler r2 bucket cors set framer-cf-videos --file r2-cors.json`
   - `wrangler r2 bucket lifecycle add framer-cf-videos expire-videos videos/ --expire-days 7`
   - `wrangler r2 bucket lifecycle add framer-cf-videos abort-multipart --abort-multipart-days 1`
2. **R2 API token** (Dashboard → R2 → Manage API tokens; Object Read & Write, this bucket only). Then:
   - `wrangler secret put R2_ACCESS_KEY_ID`
   - `wrangler secret put R2_SECRET_ACCESS_KEY`
3. **Gemini key:** `wrangler secret put GEMINI_API_KEY`, with the same key as the EC2 `.env`. Never commit it.
4. **Deploy:** `cd cloudflare && npm ci && npm test && npm run deploy`. Migrations 0001–0002 are already applied; `npm run db:migrate` is idempotent. *(Done 2026-10-15, including the Gemini secret.)*
5. **Smoke test** `https://framer-cf-api.connect-chirag-g.workers.dev`:
   - upload a short MP4;
   - watch it reach Completed;
   - search for it.
6. **Migrate data:** see §4. This needs a temporary EC2 start; stop it again afterwards.
7. **Cut over** the domain (§4). Then retire EC2 resources with the existing cleanup process. Do this only after the owner confirms.
8. **Optional:** delete the `framer-cf-smoke` Worker with `wrangler delete --env smoke`.

## 6. Development

```sh
cd cloudflare
npm ci
npm test            # Node unit tests + workerd tests with Miniflare D1
npm run typecheck
```

- **Layout:**
  - `src/api.ts`: routes, matching FastAPI's shapes.
  - `src/queue.ts`: the lease queue and heartbeat.
  - `src/ingest.ts`: the job chain, step records and `drain`.
  - `src/consumer.ts`: dependency wiring and `runDueJobs`.
  - `src/scheduler.ts` and `src/schedule.ts`: the `FramerScheduler` Durable Object and its D1 queries.
  - `src/events.ts` and `src/notify.ts`: the `VideoEvents` Durable Object (SSE) and its publisher.
  - `src/gemini.ts`, `src/vectors.ts`, `src/retrieval.ts`, `src/store.ts`.
  - `migrations/`.
  - `scripts/ec2-to-d1.mjs`.
- **Wrangler environments:**
  - top-level (`framer-cf-api`): the production config;
  - `smoke`: no R2, no Durable Object bindings;
  - `test`: local only.

## 7. Live verification (2026-10-15)

Run without a browser against `framer-cf-api`, with a 5 s, 45 KB synthetic MP4 (ffmpeg colour clip plus `say` audio).

**Verified live.**
- **Upload flow.** The presigned upload works. A retried `POST /videos/uploads` with the same `Idempotency-Key` returned the same request. The PUT to R2 returned 200, and `complete` returned 202.
- **Scheduler.** The scheduler Durable Object picked the job up within ~5 s of `complete`, with no cron.
- **Gemini file.** It was uploaded under its deterministic name.
- **Retries.** They followed the backoff exactly: alarms fired at `run_after` (+30 s, +120 s, +270 s, +480 s), and the job was dead-lettered after 5 attempts.
- **Lost-wake-up nudge.** A job queued by the old cron build was picked up after the cron was removed, through the `GET /videos/:id` nudge.
- **SSE.** The stream delivered the following, then closed:
  - `retry` and the snapshot;
  - `step` events (upload, await_file);
  - `status` per retry;
  - `: ping` every 20 s;
  - a reconnect at the 5-minute cap with `Last-Event-ID` (missed event replayed);
  - `failed`.
- **CPU.** The `wrangler tail` CPU times were:
  - scheduler alarms: 7–10 ms CPU each, around 1.5–10 s of wall time (Gemini wait);
  - `VideoEvents.publish`: 0 ms;
  - SSE connect in the API Worker: 4 ms.

**Bug found and fixed.** The Gemini client called the global `fetch` with the wrong receiver ("Illegal invocation"), which failed every Gemini call in workerd. The fix is commit `94f54fe`.
