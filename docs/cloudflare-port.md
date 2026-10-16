# Spotted on Cloudflare (free tier)

This branch (`cloudflare-port`) moves Spotted off its original AWS EC2 server. A Worker in
[`cloudflare/`](../cloudflare) runs it on Cloudflare's free tier. The Python app
in `app/` is unchanged and its tests still pass.

Status on 2026-10-16:
- **Renamed and migrated (2026-10-16):** the product is Spotted, on its own resources (`spotted-api`, `spotted-db`, `spotted-vectors`, `spotted-videos`) at `spotted.haciensus.com`. The data was copied and verified, the original resources were retired, and the one-time migration scripts were removed afterwards (they are in git history).
- **Live:** https://spotted.haciensus.com is served by the Worker `spotted-api`, open to anyone who signs in with Google (since migration 0005; it was behind Cloudflare Access before). The custom domain is attached as a Workers custom domain.
- **Resources (free tier):**
  - D1 `spotted-db` (migrations 0001–0004);
  - Vectorize `spotted-vectors` (1024 d);
  - R2 `spotted-videos`;
  - Workers AI, Media Transformations;
  - Durable Objects `VideoDO` (one per video) and `LibraryDO` (Google Photos and Drive).
- **Phase 2** (§10): Google Photos and Drive sources, frames + Whisper + Gemini descriptions, labels and sound tags, and the reranked search, tuned on the owner's library.
- **EC2:** the instance is stopped. The Python app in `app/` is kept as history; its tests still pass.
- **Superseded designs:** §1–§9 describe the first port (Gemini on the whole video, a 384-d index, SSE). §10 supersedes them where they differ.

## 1. What the original app did (EC2)

A shared video library you can search in plain language:

1. **Upload.**
   - `POST /videos/uploads` validates the request and returns a presigned S3 PUT URL (400 MB max).
   - The browser uploads directly to S3.
   - `POST /videos/{id}/complete` checks the object's size and type, then queues the job in Postgres.
2. **Ingest.** The `spotted-worker` service does this work:
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
| FastAPI + Uvicorn | **Worker** `spotted-api` (TypeScript), UI served as static assets | 100k requests/day; **10 ms CPU** per request or cron run; 128 MB memory; 50 subrequests (1,000 to Cloudflare services); 100 MB request body | [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [pricing](https://developers.cloudflare.com/workers/platform/pricing/) |
| Background worker (systemd) + `work_queue` | **Durable Object `VideoDO`**, one per video (SQLite-backed): runs that video's steps from its own alarm | DOs on Free: SQLite backend only; 100k requests/day (alarms count); 13,000 GB-s/day duration; 30 s CPU per invocation; alarm handler 15 min wall time; 100k rows written/day (each storage write and `setAlarm` is one) | [DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/), [DO limits](https://developers.cloudflare.com/durable-objects/platform/limits/), [alarms](https://developers.cloudflare.com/durable-objects/api/alarms/) |
| 3 s status polling | **SSE** `GET /videos/:id/events`, served by the same `VideoDO` | an open stream keeps its DO awake: 13,000 GB-s/day ÷ 128 MB ≈ 28.9 stream-hours/day across all videos | same as above |
| Postgres metadata | **D1** `spotted-db` (tables `videos`, `usage_counters`, `usage_events`): the record other code reads | 10 DBs; 500 MB per DB; 5M rows read and 100k rows written per day; 50 queries per invocation | [D1 limits](https://developers.cloudflare.com/d1/platform/limits/), [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) |
| pgvector | **Vectorize**, first a 384-d index, now `spotted-vectors` (1024 d, §10) (384 dims at first, cosine; metadata indexes `kind` and `video_id`) | 5M stored dimensions (≈13k vectors, ≈700 videos at 18 vectors each); 30M queried dimensions/month; topK ≤ 100 | [Vectorize pricing](https://developers.cloudflare.com/vectorize/platform/pricing/), [limits](https://developers.cloudflare.com/vectorize/platform/limits/) |
| FastEmbed in-process | **Workers AI** `@cf/baai/bge-small-en-v1.5` (384 dims; others: bge-base 768, bge-large 1024, bge-m3, embeddinggemma-300m, qwen3-embedding-0.6b, plamo-embedding-1b) | 10,000 neurons/day; bge-small costs 1,841 neurons per M tokens, so about 5 neurons per video | [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/), [models](https://developers.cloudflare.com/workers-ai/models/) |
| S3 (videos, frames) | **R2** `spotted-videos`: presigned PUT/GET over the S3 API; lifecycle 7 days | 10 GB-month; 1M Class A and 10M Class B ops per month; free egress; single PUT up to 5 GiB | [R2 pricing](https://developers.cloudflare.com/r2/pricing/), [presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/) |
| FFmpeg frame extraction | **Not possible on Workers.** Gemini samples ~16 frames of the video itself (`videoMetadata.fps`, §3.1) via its Files API and returns timestamped "moments" | Gemini Files API: 2 GB per file on the free tier, files kept 48 h; ~100 tokens/s at low media resolution | [Gemini video understanding](https://ai.google.dev/gemini-api/docs/video-understanding) |
| SQLite usage.db and the AWS free-plan timers | D1 `usage_counters`. Workers Free has hard limits that fail rather than bill, so the EC2 timers are unnecessary | — | — |

**Why D1 + Vectorize.** The owner first asked me to evaluate Postgres via Hyperdrive. Neon Free scales to zero after 5 idle minutes and gives 100 CU-hours per month, so a per-minute cron that touched Postgres would keep it awake past that budget. It also needed an external account. The owner then chose D1 + Vectorize; everything stays inside the Cloudflare account. The Postgres variant is in this branch's history (commits `f695474` and `3d98de4`) for reference.

**Note for the owner: Cloudflare Queues are now on the Free plan** (10,000 operations/day, 24 h retention, [Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/)), so "Queues are paid" is out of date. The owner chose the actor-per-video design below instead.

### 2.1 Actor per video (owner decision)

**`VideoDO`** (`cloudflare/src/video.ts`) is one SQLite-backed Durable Object per video (`VIDEO.idFromName(video_id)`). Durable Objects are on Workers Free with the SQLite backend ([DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)). The object:
- **owns** the video's ingestion state machine in its own storage:
  - the current step (`upload → await_file → tag → index → done | failed`);
  - attempts and `next_retry_at`;
  - the last error;
  - the per-step idempotency keys (`<video_id>:<step>`);
  - the recorded external results: the Gemini file name and URI, the parsed tagging result with token usage, and the index result (duplicate check).
- **runs** the steps itself from its own alarm: upload to Gemini → poll until `ACTIVE` (every 5 s) → `generateContent` with fps-capped sampling (§3.1) → Workers AI embeddings → Vectorize upsert → delete the Gemini file.
- **streams** the video's status to viewers over SSE (§2.2).

**Single executor.** A Durable Object is a single-threaded actor, and its alarms never overlap, so the object is the lock. No lease queue, fencing token, scheduler or cron is needed. Those were removed:
- D1 migration `0003` drops `jobs` and `step_results`;
- DO migration `v3` deleted the earlier scheduler and `VideoEvents` classes (the renamed Worker starts with `VideoDO` and `LibraryDO` only).

**Rule: write durably before every side effect, and record each external result before moving on.**
- Each try persists `attempts + 1` before running, so a crash loop still stops at 5 attempts.
- Each side effect persists its idempotency key first.
- Each external result is persisted the moment it returns.
- After an eviction or crash, the alarm (at-least-once, retried by the runtime) or the next `start()` resumes from the recorded step and skips recorded side effects.
- **The remaining window** is a crash between an HTTP response arriving and the storage write that follows it.
  - For the Gemini upload, the deterministic file name closes it: a GET by name, or a 409 on re-upload, returns the existing file (§3.3).
  - For `generateContent`, one repeated call is possible in that instant.

**Retries.**
- Transient errors back off by `30 s × attempts²` through the alarm. After 5 attempts the video fails, and its Gemini file is deleted.
- **Quota is not failure.** A Gemini `429` (rate or daily quota) waits for its `RetryInfo` delay (15 min × waits if none is given), re-checking at least every 2 h. It does **not** use up the 5 attempts: the try is refunded and counted in `quota_waits` instead. The video gives up only after **48 h** on quota (`MAX_QUOTA_WINDOW_MS`), which always spans a daily reset (Gemini resets requests-per-day at midnight Pacific time, [rate limits](https://ai.google.dev/gemini-api/docs/rate-limits)). Before this fix, five 2 h quota waits (~8 h) failed a video and deleted its Gemini file.
- **A quota wait belongs to a model.** The wait records `quota_model`. If `GEMINI_MODEL` changes, `start()` (which the `GET /videos/:id` and SSE safety net call) and the alarm treat the old wait as void and retry at once on the new model. States written before this field existed count as void if their last error was a quota error.
- Waiting for Gemini to process a file is not a failed attempt; it polls at most 120 times.

**Order of every visible transition.**
1. The DO storage (the record).
2. The D1 `videos` row: status, progress, error, attempts, and the result when done. API, search, history and duplicate readers use it. It is written with `state_version`, so a late write never overwrites a newer one.
3. The SSE broadcast, which lives only in memory as a relay.

**Starting.**
- The browser PUTs to R2, then calls `POST /videos/:id/complete`. The API verifies the object, marks the row `pending`, and calls `VideoDO.start(id)`, which is idempotent: it returns the existing state, and re-arms the alarm if work is pending and none is set.
- **Safety net.** `GET /videos/:id` and SSE (re)connects nudge the video, at most once per 10 s per video per isolate:
  - `uploading` with the object already in R2 (the browser never confirmed): confirm it now;
  - `pending` or `processing`: `start()`, which restores a lost alarm (alarm retries give up after 6 failures);
  - `completed` with `needs_index` (an EC2 import): re-embed it.
- Unconfirmed uploads expire lazily, when the history is listed, after 15 minutes. There is no background sweeper.

**Model and free-tier quota.** `GEMINI_MODEL` is `gemini-3.1-flash-lite` (GA id from `models.list`; a `-preview` id also exists), for both tagging and `/query` answers. On the key's project (AI Studio rate-limit page, 2026-10-15) its free tier is **15 RPM and 500 RPD**; `gemini-3.8-flash`/`3.6-flash` allow 20 RPD and `gemini-3-flash` 20 RPD, which is what blocked uploads. Each video costs 1 `generateContent` (Files API calls are not generation requests) and each `/query` 1 more, so the public budgets (10 uploads + 100 queries a day, at most 5 tries per video) stay under ~160 requests/day, a third of the 500 RPD. A burst above 15 RPM gets a 429: ingestion waits it out, and `/query` falls back to the retrieval-only answer. `/query` reports `answer_model` and `answer_usage` (token counts).

`countTokens` on the owner's 105 s video with `gemini-3.1-flash-lite` and `MEDIA_RESOLUTION_LOW`: 1 fps = 7,455 video + 3,360 audio tokens; `videoMetadata.fps` 0.1523 (16 frames) = 1,136 video + 3,360 audio. The model honours `fps` (≈71 tokens per frame).

**Global Gemini concurrency.** No cross-video limiter was added.
- The public budgets cap ingestion at 10 uploads/day, so at most a handful of actors call Gemini at once.
- Rate and quota errors (`429`) are waited out per actor using Gemini's own `RetryInfo`.
- A limiter (a D1 permit counter or a tiny limiter DO) would add a coordination point to every step, for a load the budgets already bound.
- Revisit if `DAILY_UPLOAD_LIMIT` is raised.

**Free-plan usage per video:**
- about 15 DO storage writes, 1–3 alarms, ~8 D1 writes and ~15 D1 reads;
- one `generateContent`;
- three Gemini file calls plus 1–20 polls;
- one Workers AI call.

### 2.2 Live progress: Server-Sent Events from the same actor (owner decision)

`GET /videos/:id/events` returns `text/event-stream`. The API Worker reads the D1 row, runs the safety-net nudge, and forwards the request to `VideoDO.fetch`, with the D1 row as the snapshot for videos the actor has not started (uploading or imported).

**On connect.**
- The stream starts with `retry: 3000`.
- If `Last-Event-ID` is sent, every stored transition after it is replayed.
- Then comes the snapshot, as event `status`, taken from durable state and the D1 row.
- A finished video also gets `done`/`failed`, and its stream closes at once.

**Broadcast.**
- After each committed transition, the actor pushes the event to every open stream. The event `id` is the state version.
- The events are:
  - `step`: a step finished;
  - `progress`: still waiting on Gemini;
  - `status`: started, or a retry scheduled (with `retry_at`);
  - `done` and `failed`.
- The last 200 events are kept in the actor's SQLite storage for resume.

**Hygiene.**
- `: ping` every 15 s.
- All streams close on `done`/`failed`.
- Each stream is capped at **5 minutes**, after which `EventSource` reconnects with `Last-Event-ID`.
- Client disconnects are detected through `request.signal` (compat flag `enable_request_signal`).
- Writes are never awaited, so a slow reader cannot block a step, and a reader 32 chunks behind is dropped.
- The writer `Set` is memory only; DO storage and D1 are the record.

> **Superseded (Phase 2, §10.5):** status now travels over hibernatable WebSockets (`GET /videos/:id/ws`); the SSE route, its 5-minute cap and heartbeat are gone. The text below describes the earlier SSE design.

**UI** (`cloudflare/public/index.html`).
- One `EventSource` per active video (at most 5 per tab). Events update the history in place, and `done`/`failed` close the stream and refresh once.
- The history list refreshes every 60 s (it was every 3 s).
- If `EventSource` is missing or errors 5 times in a row, the UI falls back to 3 s polling.

**Free-plan sizing** ([DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)).
- **Duration.** DO duration is wall-clock time while the object is active, charged at 128 MB. That is 13,000 GB-s/day ÷ 0.125 GB = **104,000 object-seconds ≈ 28.9 hours/day**. An open stream keeps the object active, because hibernation applies only to WebSockets. Streams on one video share its object's duration, and ingestion itself (mostly waiting on Gemini) also counts.
- **Typical use.** With 10 uploads/day, a few minutes each, this is well under 1 hour/day. A viewer of a stuck video costs 12 reconnects/hour.
- **Requests.** Each connection is one Worker request plus one DO request (100,000/day each).
- **Worker side.** Workers Free charges CPU, not wall time ([Workers limits](https://developers.cloudflare.com/workers/platform/limits/)). The Worker only forwards the stream.

**CPU.** The Workers limits page gives 10 ms CPU per invocation on Free, while the DO limits page gives 30 s per invocation, including alarms ([DO limits](https://developers.cloudflare.com/durable-objects/platform/limits/)). Measured on the earlier scheduler build, a step that included a Gemini call used 7–10 ms of CPU.

## 3. Feasibility and risks

- **Ingestion on Workers.** Workers cannot run FFmpeg or any native binary, so this port changes how videos are analysed:
  - The Worker streams the R2 object into Gemini's resumable Files API upload. It uses `FixedLengthStream` and never buffers, which matters with 128 MB of memory.
  - Gemini samples the video itself, about 16 frames spread over its duration (§3.1), at low media resolution. It returns 1–16 timestamped **moments**. These map onto the existing `sampled_timestamps`, `frame_descriptions` and tag `frame_indices`, so retrieval and the UI are unchanged.
  - **What is lost:** stored JPEG citation frames. The UI now shows the video itself paused at the cited time (`citationVisual` in `cloudflare/public/index.html`). Migrated EC2 videos still use their JPEGs while those exist in R2.
  - **Formats:** MKV is not accepted by Gemini and fails with a clear error. MP4, MOV, WebM, AVI, MPEG, WMV, FLV and 3GP work.
  - **Unverified:**
    - **CPU time** of streaming 400 MB through a Worker. Body pass-through should be native and not count as JS CPU.
    - **Gemini timing.** Whether a `gemini-3.5-flash` call on a 10-minute video finishes within the alarm's 15-minute wall-time limit (very likely, but unmeasured).
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

**Owner requirement.** Never repeat an external side effect for the same request. A reclaimed or resumed job continues from the last durable state.

**Records in the `VideoDO` (§2.1).** Each step's idempotency key is persisted before the call, and each result is persisted right after it.

**Gemini upload.**
- It uses a deterministic file id, `files/<prefix>-<uuid hex>` (≤ 40 chars of `[a-z0-9-]`, [File.name](https://ai.google.dev/api/files)), and display name `<prefix>-<video_id>`.
- Before uploading, the step reuses, in order:
  1. the recorded file;
  2. the deterministic name (GET);
  3. the display name (list).
  It reuses any of these if the file is `ACTIVE` or `PROCESSING`.
- A second upload under the same name gets 409 `ALREADY_EXISTS`, verified live, and the client returns the existing file.
- An expired or deleted file (Gemini keeps files 48 h) sends the actor back to `upload`, under the same name.

**`generateContent`.** If a tagging result is recorded, the call is skipped.

**Index.** It is idempotent by construction: Vectorize upserts deterministic ids, and the Gemini delete tolerates 404.

**Budgets.**
- `usage_events` counts each `Idempotency-Key` once, in one D1 transaction with the counter.
- `POST /videos/uploads` with a key already used returns the same upload request; the UI sends a fresh key per upload.

**Tests** (`test/workers/video.test.ts`). Evicting the object at six points shows Gemini upload and `generate` called exactly once each:
- after the upload returned, before it was recorded;
- after the upload was recorded;
- after `await_file`;
- after the tag result was recorded;
- after the tag transition;
- after indexing.

### 3.4 Other risks

- **10 ms CPU** per invocation on Workers Free.
  - Each step is mostly network wait, and the ranking runs on at most 50 candidates. A step that is killed for CPU is retried by the actor's alarm, and fails after 5 attempts.
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
   `psql -d irl -Atc "SELECT row_to_json(j) FROM jobs j" > jobs.jsonl`
3. Copy `jobs.jsonl` to this machine, then **stop the instance again**.

**Import:**
1. `cd cloudflare && node scripts/ec2-to-d1.mjs jobs.jsonl > import.sql`
2. `wrangler d1 execute spotted-db --remote --file import.sql`
3. Imported videos are started lazily. Run `node scripts/kick-imported.mjs <base-url> jobs.jsonl`, which visits each video once:
   - `pending` videos have their `VideoDO` start ingestion;
   - `completed` ones (`needs_index`) are re-embedded.
4. Delete the `.jsonl`/`.sql` files afterwards: they contain user metadata.

**Objects:**
- Copy the S3 bucket (its name is in the ignored `data/spotted-deploy/manifest.json`) into R2 `spotted-videos` with the same keys, e.g. with `rclone copy s3:<bucket> r2:spotted-videos`.
- An R2 API token is needed for that copy; S3 egress is AWS-billed beyond its free allowance.
- Because of the 7-day S3 lifecycle, only recent videos still have their originals. Older entries keep their metadata and become searchable after re-embedding, but cannot play.

**Cutover:**
1. Remove the custom domain from the old EC2 proxy Worker (since deleted).
2. Attach the custom domain to the Worker (a Workers custom domain for `spotted.haciensus.com`).
3. Run `npm run deploy`.
4. Rollback is the reverse, plus restarting EC2.

## 5. Owner steps, in order

1. **Enable R2:** Dashboard → R2 → complete the R2 subscription checkout ($0 plan). This may ask for a payment method; I can't verify whether it does. Then:
   - `wrangler r2 bucket create spotted-videos`
   - `wrangler r2 bucket cors set spotted-videos --file r2-cors.json`
   - `wrangler r2 bucket lifecycle add spotted-videos expire-originals videos/ --expire-days 7`
   - `wrangler r2 bucket lifecycle add spotted-videos abort-uploads "" --abort-multipart-days 1`
2. **R2 API token** (Dashboard → R2 → Manage API tokens; Object Read & Write, this bucket only). Then:
   - `wrangler secret put R2_ACCESS_KEY_ID`
   - `wrangler secret put R2_SECRET_ACCESS_KEY`
3. **Gemini key:** `wrangler secret put GEMINI_API_KEY`, with the same key as the EC2 `.env`. Never commit it.
4. **Deploy:** `cd cloudflare && npm ci && npm test && npm run deploy`. Migrations 0001–0002 are already applied; `npm run db:migrate` is idempotent. *(Done 2026-10-15, including the Gemini secret.)*
5. **Smoke test** the Worker (then on its workers.dev URL, since disabled):
   - upload a short MP4;
   - watch it reach Completed;
   - search for it.
6. **Migrate data:** see §4. This needs a temporary EC2 start; stop it again afterwards.
7. **Cut over** the domain (§4). Then retire EC2 resources with the existing cleanup process. Do this only after the owner confirms.
8. **Optional:** delete the smoke-test Worker (done).

## 6. Development

```sh
cd cloudflare
npm ci
npm test            # Node unit tests + workerd tests with Miniflare D1
npm run typecheck
```

- **Layout:**
  - `src/api.ts`: routes, matching FastAPI's shapes.
  - `src/video.ts`: the `VideoDO` actor (ingestion state machine, alarm executor, SSE).
  - `src/actor.ts`: its typed stub. `src/deps.ts`: dependency wiring for the API Worker.
  - `src/gemini.ts`, `src/vectors.ts`, `src/retrieval.ts`, `src/store.ts`.
  - `migrations/`.
  - `scripts/ec2-to-d1.mjs`.
- **Wrangler environments:**
  - top-level (`spotted-api`): the production config;
  - `smoke`: no R2, no Durable Object bindings (to be deleted after cutover);
  - `test`: local only.

## 7. Live verification (2026-10-15)

The first runs used the intermediate designs: first the cron with the D1 queue, then the scheduler DO with SSE.


Run without a browser against the first deployed Worker, with a 5 s, 45 KB synthetic MP4 (ffmpeg colour clip plus `say` audio).

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

## 8. Operations: sign-in, users, admin purge and deleting videos

- **Sign-in** (`src/auth.ts`, migration 0005). `GET /auth/login` sends people to Google (scopes `openid email profile`); Google returns to the same `/oauth/google/callback` as the Photos connection, and the stored one-time state says which flow it is. The ID token comes straight from Google's token endpoint, and its issuer, audience, expiry and verified email are checked. The session is a `__Host-spotted` cookie (HttpOnly, Secure, SameSite=Lax, 30 days) whose SHA-256 alone is stored in D1 `sessions`; `POST /auth/logout` ends it. Every route except `/`, `/privacy`, `/health`, `/me`, `/auth/*` and the OAuth callback answers 401 without a session.
- **Users and limits.** Addresses in `OWNER_EMAILS` sign in as the user `owner`: the original library, Google Drive sync and no limits. Everyone else is `g:<Google sub>`, a guest with Google Photos and uploads, 20 videos, 500 MB and 30 searches a day (`GUEST_*` vars), plus a shared daily ceiling for all guests. Every video, picker session and Google connection carries its `user_id`; routes read and change only the signed-in user's rows, and Vectorize queries filter on the `user_id` metadata index (existing vectors were tagged with `scripts/tag-vector-users.mjs`). `GET /me` returns the user and, for guests, their usage. The `Cf-Access-*` headers are no longer read.
- **Deleting a video completely:** `DELETE /admin/videos/:id` with `Authorization: Bearer $SPOTTED_ADMIN_TOKEN` (Worker secret `ADMIN_TOKEN`; the value is in the ignored `.env` at the repo root).
  - What it removes, in order:
    1. the D1 row;
    2. the actor: its alarm, streams, Gemini file and all its storage, leaving a tombstone so an in-flight step cannot write again;
    3. its Vectorize vectors;
    4. every R2 object under `videos/<id>/`.
  - Without the secret, or with a wrong token, the route answers 404. Behind Access it needs an Access session or a service token too.
- **Out-of-band deletes.** If a row is deleted directly (`wrangler d1 execute ... DELETE FROM videos ...`), the actor purges itself:
  - at its next alarm;
  - or when a signed-in client requests `GET /videos/<id>`, which then answers 404.
  - An actor that never held state is never written to.
- **2026-10-15:** all videos were dummies and were deleted on the owner's instruction:
  - D1 rows, R2 objects and Gemini files were deleted with wrangler and the Gemini API;
  - Vectorize was already empty;
  - the two actors purge at their pending alarms (~22:06 and ~22:21 UTC).

## 9. Incident: the ghost per-minute cron (2026-10-14/15)

- **Symptom.** The API Worker received `cron: "* * * * *"` scheduled events every minute. Each failed with "Handler does not export a scheduled() function", although the dashboard, `GET .../workers/scripts/<worker>/schedules` and `wrangler deployments` showed no cron.
- **Timeline (UTC, from the GraphQL `workersInvocationsScheduled` dataset):**
  - 19:07: the first per-minute run succeeds. The code then exported `scheduled()`, and `crons: ["* * * * *"]` was deployed by commit `f695474`/`72d22bb`.
  - 19:15: commit `7a607a4` deploys `crons: []` and removes `scheduled()`. The schedules API returns `[]`.
  - 19:16 onwards: every minute ends in `scriptThrewException`, always on the newest deployed version.
- **Resolution:**
  - The per-minute events stopped by themselves: the last was **21:59:14 UTC**, from GraphQL `workersInvocationsScheduled`, with none since. A `wrangler tail` window from 04:42:49 to 04:49:29 UTC on 2026-10-15 (6 min 40 s) showed zero events, and GraphQL shows zero scheduled invocations from 22:00 to 04:49.
  - Cloudflare marked the incident resolved at 01:29 UTC: "Workers Cron Trigger backlogs have cleared … Some schedule redeploys may be required for a small fraction of Workers who were impacted".
  - Our `crons: []` redeploys (the last before the stop was 20:49) were most likely applied once that backlog drained; the Phase 2 deploy (04:3x) re-sent `[]`.
  - No `scheduled()` handler was added.
- **Attempts that did not stop it:** two redeploys with `crons: []`, `wrangler triggers deploy`, `PUT schedules []`, a dashboard add/save/delete/save, a `PUT` of a different (yearly) cron (still per-minute 16+ min later, beyond the documented 15-minute propagation), and further full deploys.
- **Root cause (evidence-based, Cloudflare-side).** Cloudflare's control plane held the correct, empty schedule from 19:15, but its cron dispatcher kept the per-minute schedule created at 19:07 for 2 h 45 min. Schedule changes did not reach the dispatcher during the incident. This matches the open Cloudflare status incident "Cloudflare Workers - Cron Trigger Activation Issues" ([npjny9agana8](https://www.cloudflarestatus.com/incidents/npjny9agana8), opened 2026-10-14 05:36 UTC, resolved 2026-10-15 01:29 UTC): "Customers who have recently created or modified a Cron Trigger schedule may find that the schedule is not executing as expected". It is the third such incident in three days. Our cron was created and removed inside that window.
- **Not the cause:**
  - no other environment or script has a cron (all 5 scripts in the account return `[]`; the legacy `services/.../environments/production/schedules` is `[]` too);
  - no gradual deployment (100% on one version);
  - not a Durable Object alarm: events carry `event.cron` and `executionModel: "stateless"`, while DO alarms have no `cron` and run in the DO.
- **Prevention.**
  - Don't add a cron just to try something. Treat cron changes as infrastructure changes and check [cloudflarestatus.com](https://www.cloudflarestatus.com) for open Workers incidents first.
  - Keep `"triggers": { "crons": [] }` in the config permanently (wrangler only removes crons when the list is explicitly empty), and keep at least one deploy between removing `scheduled()` and removing the cron.
  - Verify a cron change with the GraphQL `workersInvocationsScheduled` dataset, not `wrangler tail` alone: tail is sampled and missed 2 of 3 cron events in one window.

## 10. Phase 2: Google Photos and Drive, frames, transcripts and bge-m3 (branch `phase2-photos-drive`)

Everything runs on Cloudflare's free tier. Gemini no longer receives the video file: the Worker
extracts frames itself, Workers AI transcribes the speech, and Gemini describes images.

### 10.1 Sources

- **Google OAuth** (`src/google.ts`, routes `GET /oauth/google/start` and `GET /oauth/google/callback`, behind Access).
  - Client: the "Spotted" OAuth client in the GCP project. `GOOGLE_CLIENT_ID` is a var and `GOOGLE_CLIENT_SECRET` a secret (set by the owner). Redirect URI `https://spotted.haciensus.com/oauth/google/callback`.
  - Scopes `photospicker.mediaitems.readonly` and `drive.readonly`, with `access_type=offline` and `prompt=consent`; a one-time `state` (D1 `oauth_states`, 10 minutes) guards against CSRF.
  - The refresh token is sealed with AES-GCM (secret `TOKEN_ENC_KEY`, associated data `google-refresh-token`) in D1 `google_auth`. No route returns it and it is never logged.
  - The OAuth app is in Testing mode, so refresh tokens **expire after 7 days**. `invalid_grant` sets `google_auth.status = reconnect_needed`, the UI shows "Reconnect Google", and Drive polling pauses until then.
- **Google Photos** (primary). Since March 2025 the Library API cannot read a user's library, so Spotted uses the [Picker API](https://developers.google.com/photos/picker):
  1. `POST /photos/sessions` creates a session; the UI opens `pickerUri + /autoclose`.
  2. The **LibraryDO** alarm polls `sessions.get` at Google's `pollInterval` until `mediaItemsSet`.
  3. It marks the session `importing`, runs `mediaItems.list` and creates one video per picked VIDEO, with `(source, source_id)` unique, so a re-pick is a no-op.
  4. The VideoDO downloads `baseUrl + "=dv"` with the bearer token, reporting byte progress (`progress.bytes_done` / `bytes_total`, at most one event per 4 MiB and second) while it streams into R2. baseUrls live 60 minutes; an expired one is refreshed from the session while it lasts, and otherwise the video fails with "pick the video again".
  - **Import progress in the UI.** `GET /photos/sessions/:id` and `GET /photos/sessions/latest` (the newest session, or `null`) return the session's status (`waiting` → `importing` → `imported`, or `expired`/`failed`), its counts and `video_ids`, the videos it created. The sidebar shows an indeterminate bar while the picker is open, then one row per picked video with its own pipeline progress (copy with MB → probe → frames → transcribe → describe → summarize → index) from the per-video WebSockets, and an overall bar. A reload resumes the latest session if it is active or recent.
- **Google Drive** (secondary).
  - `PUT /drive/folder {"folder": "<link or id>"}` sets the folder.
  - The first LibraryDO run takes `changes.getStartPageToken`, then lists the folder (videos modified in the last 24 months).
  - Every hour (`DRIVE_POLL_MINUTES` = 60, owner decision) it reads `changes.list` from the stored token: new files in the folder become videos, and modified ones are re-processed (`VideoDO.restart`).
  - There is **no push web hook**, so nothing has to bypass Access (owner decision).
- **Size rule.** Media Transformations accepts inputs **under 100 MB** (and up to 10 minutes). Larger sources are recorded as `skipped` ("Skipped — over 100 MB") and never copied: Drive gives `size`, Photos is checked with HEAD/Range `Content-Length`, and the download stops at 100 MB if a source lied. Videos over 10 minutes are `skipped` after the duration probe. The UI says "Videos over 100 MB are skipped." next to the import button.
- **Uploads** still work (MP4/MOV under 100 MB) and enter the same pipeline at `probe`.
- **Stagger.** Imports start `IMPORT_STAGGER_S` (20 s) apart, so a large pick doesn't burst the Gemini 15 RPM limit.

### 10.2 Pipeline (VideoDO steps, each result recorded before the next call)

| Step | What | Provider | Recorded |
|---|---|---|---|
| `fetch` | Photos/Drive into R2 `videos/<id>/source`, streamed through a multipart upload (10 MiB parts) | Google | object in R2 (an existing object is reused) |
| `probe` | duration from the MP4/MOV `mvhd` box (first 512 KB, else last 2 MB), else the source metadata | R2 range reads | `duration` |
| `select` | spritesheets of 64×36 tiles, 1 per second, ≤ 60 s each; grayscale mean absolute difference between consecutive tiles; keep the first frame, changes ≥ `CHANGE_THRESHOLD` (12) at least 2 s apart, top changes spread across time over the cap; then split gaps > 8 s for coverage; cap `MAX_FRAMES` = 16 | Media binding + `jpeg-js` in the DO | `picks` (t, score) |
| `frames` | each pick at ≤ 1024 px into R2 `thumbs/<id>/<i>.jpg` (outside the 7-day `videos/` lifecycle) | Media binding | per frame |
| `transcribe` | ≤ 10 MB: the whole video to Whisper as base64; otherwise 60 s M4A chunks from the Media binding; no audio track gives an empty transcript. Then the first `SOUND_MAX_S` (60 s) of audio as M4A is kept in R2 `videos/<id>/sound.m4a` for sound tags (the > 10 MB path reuses chunk 0; ≤ 10 MB makes one Media audio call; `9412` = no audio track → `sound: none`) | Workers AI `whisper-large-v3-turbo`, Media binding | per chunk; `sound` after the R2 put |
| `describe` | 8 frames per call, inline JPEG + timestamp + nearby speech, giving one 80-180-word paragraph per frame (scene, objects, people and actions, quoted on-screen text, framing, change since the previous frame) | Gemini 3.1 Flash Lite | per batch |
| `summarize` | one call: narrative paragraph + tags (environment, object, action, speech) + `labels` picked from the fixed vocabulary in `src/labels.ts` + `sounds` heard in the inline M4A (prompt `cf-frames-v4-labels`). Labels and sounds are validated against the vocabulary (synonyms folded, unknown names dropped); ancestors are added by our code (`expandLabels`), never by the model | Gemini 3.1 Flash Lite | summary, tags, labels, sounds |
| `index` | bge-m3 vectors: `s:<id>` summary + tags + labels and sounds with ancestors + transcript head, `t:<id>:<n>` 45 s transcript windows every 30 s, `f:<id>:<i>` frame paragraphs, each with `{video_id, kind, t_start, t_end, source, source_id, thumb_key}` | Workers AI `bge-m3`, Vectorize `spotted-vectors` | upsert (idempotent) |

**Verified live on this account (2026-10-15).**
- Spritesheets stack tiles vertically (15 × 64×36 → 64×540 JPEG).
- A seek past the end fails with 9401; a video without audio fails `mode=audio` with 9412.
- Whisper takes an MP4 *video* only as base64 (a stream gets `8001 Invalid input`), and an M4A also as a stream; a video without audio gives `3030`.
- bge-m3 returns 1024 dims, and the reranker returns `[{id, score}]`.

**Rules kept.**
- Write durably before every side effect.
- A 429 (Gemini, or the Workers AI neuron allocation) is a quota wait that refunds the attempt, gives up after 48 h, and is voided when `GEMINI_MODEL` changes.
- Other errors retry with 30 s × attempts² backoff, up to 5 attempts.
- Media `9401`–`9409` errors are permanent.

### 10.3 Search and `/query`

1. Lowercase the query (after stripping "show me …"), embed it with bge-m3 and take the 100 nearest vectors of any kind.
2. Group them by video (top 10 videos, 4 passages each) and load the passage texts from the D1 result.
3. Rerank every passage with `@cf/baai/bge-reranker-base`. Frame and speech passages go in behind their video's context, "Setting: <environment tags>. Video: <first summary sentence>", so a single frame is never judged without knowing what the video is. A video scores its best passage and is kept if
   - its best bge-m3 cosine is within `SEARCH_VECTOR_MARGIN` (0.07) of the best video's, **and**
   - its rerank score is ≥ `SEARCH_MIN_SCORE` (0.02), **or** ≥ `SEARCH_SOFT_MIN_SCORE` (0.008) with a cosine ≥ `SEARCH_MIN_SIMILARITY` (0.53);

   then ≥ 25% of the best video's score, at most 3 results. `retrieval.matched_by` says which rule accepted it (see §10.7).

   **Labels** (`src/labels.ts`, `labelVerdict` in `src/retrieval.ts`) come first. The query is mapped to vocabulary labels by exact name or synonym after lowercasing (longest phrase first, plural "s" folded: "football" → soccer, "animals" → animal, "cheering crowd" → cheering + crowd). Each video's stored labels and sounds are expanded with their ancestors. Then:
   - **hit**: the video carries every query label → kept even below the rerank floors and ranked before reranker-only videos (`matched_by: label`). "wildlife" keeps the boar at rerank 0.0052.
   - **conflict**: the video lacks a query label but carries a mutually exclusive sibling of it (same `group`: specific sports, animal classes, mammal/bird/reptile kinds, occasions) → never accepted on the reranker alone. "basketball" vs soccer (rerank 0.052), "bird" vs reptile/mammal (0.019).
   - **none**: the query names no label, or the video neither has nor contradicts it → the rerank + cosine rule above.

   The vocabulary is 154 visual labels + 30 sound tags, hand-written for home and phone footage (animals, sports, events, places, vehicles, nature, people activities, abstract roots such as wildlife, nature, celebration, sport). No embedding of the query against label names: every label query in the measured set matched lexically, and a fuzzy match would turn near-misses into vetoes.
4. The citation is that passage's kind and time (a frame or speech window instead of the summary when it scores ≥ 50% of the best), with the nearest frame's thumbnail (`GET /videos/:id/thumbs/:i`, streamed from R2 behind Access).
5. `/query` sends the cited passages (with `m:ss`) to Flash Lite, which must cite `[n]` inline. It reports `answer_model` and `answer_usage`.

The thresholds were retuned on the owner's real library on 2026-10-15 (§10.7). Retune them again once the library is larger: the fit is on 5 videos.

### 10.4 Free-tier budget for ~200 short videos (≈60 s, ≤16 frames)

| Resource | Free limit | Per video | 200 videos |
|---|---|---|---|
| Gemini 3.1 Flash Lite | 15 RPM, 500 RPD | 1–2 describe calls + 1 summary (measured on a 30 s clip with 6 frames: 2 calls, ~8k prompt + ~1.2k output tokens). Labels and sound tags add **no call**: the summary call carries the vocabulary (~1,800 characters, ~0.5k tokens) and ≤ 60 s of audio (32 tokens/s, ≤ 1,920); measured summary calls on the 5 owner clips: 1.5–2.4k prompt + 0.3–0.6k output tokens | 400–600 requests → **1–2 days** of RPD; quota waits absorb the overflow |
| Workers AI neurons | 10,000/day | Whisper 46.6/audio-min ≈ 47; bge-m3 1,075/M tokens ≈ 5; reranker ≈ 0 | ≈ 10.4k → **~2 days** (Whisper dominates) |
| Vectorize | 5M stored dims (≈4,880 vectors at 1024 d); 30M queried dims/month | ~1 + 2 + ≤16 ≈ 19 vectors | ≈ 3,800 vectors = 3.9M dims (fits; MAX_FRAMES=40 would not) |
| Media binding | open beta, "not billed for now" | 1 spritesheet/min + ≤16 frames + 1 audio call of ≤ 60 s for sound tags (≤ 10 MB videos; > 10 MB reuse their first Whisper chunk) (+ 1 audio op/second for > 10 MB) | if billed like URL MT (5,000 free ops/month; audio 1 op per output second) → ~3,400–15,000 ops: would exceed the free 5,000 |
| R2 | 10 GB-month | original (deleted after 7 days) + ~16 × 60 KB thumbnails | well under 10 GB |
| DO / D1 | 100k requests/day, 13,000 GB-s/day; 100k rows written/day | ~40 storage writes, ~60 D1 writes | small |

### 10.5 Live status over hibernatable WebSockets

- **Route.** `GET /videos/:id/ws` (`Upgrade: websocket`). The API Worker checks the row, runs the safety-net nudge, and forwards to the video's VideoDO.
- **Server side.**
  - The VideoDO accepts with `ctx.acceptWebSocket` (hibernation API; never `ws.accept()`) and stores `{video_id, subscribed}` with `serializeAttachment`.
  - `setWebSocketAutoResponse('ping' → 'pong')` answers heartbeats without waking the object.
  - Each committed transition is broadcast to `ctx.getWebSockets()`; the final event (`done`, `failed` or `skipped`) is sent and the socket closed with 1000.
- **Protocol.**
  1. The client sends `{"type":"subscribe","last_seq":N}`.
  2. The object replays stored events after N (`replay: true`) from its SQLite `events` table (last 200).
  3. It sends a `status` snapshot, then live events `{"type":"event","seq","event","data"}`.
  4. A finished video gets its final event and an immediate close.
- **Client.** It reconnects with exponential backoff (1–30 s, jitter) and resubscribes with its last seq. After 6 failures it falls back to 3 s polling. EventSource is gone.
- **Access.** The upgrade is same-origin, so the browser sends the Access cookie. NOT yet verified through Access; verify in the owner's signed-in browser (DevTools → Network → WS should show 101).
- **DO duration, reasoned estimate (not measured: no production traffic yet).**
  - With SSE, an open stream kept the object active for its whole lifetime (128 MB): one tab watching 5 active videos for an hour was 5 object-hours = 2,250 GB-s, about 17% of the 13,000 GB-s/day free.
  - With hibernation, an idle socket costs nothing. The object is billed only while it handles a subscribe, a broadcast or an alarm step, i.e. ingestion itself, roughly 30–70 s per video ≈ 4–9 GB-s, plus milliseconds per event. Idle viewers drop from ~450 GB-s per video-hour to ≈ 0.
  - How to measure: the GraphQL `durableObjectsPeriodicGroups` dataset (`activeTime`, `duration`) before and after.

### 10.6 Owner steps and status

1. `cd cloudflare && npx wrangler secret put GOOGLE_CLIENT_SECRET` (owner).
2. Open https://spotted.haciensus.com (Access), click **Connect Google**, and consent with a test user.
3. **Import from Google Photos**: pick a few short videos, then Done. Or paste a Drive folder link.
4. Every 7 days (Testing-mode tokens): **Reconnect Google** when the UI asks.
5. Optional cleanup:
   - the old 384-d index and the smoke-test Worker have been removed.

**Done.** D1 migration 0004 applied remotely, Vectorize index (now `spotted-vectors`) created (1024 d, cosine, metadata indexes `kind` and `video_id`), secret `TOKEN_ENC_KEY` set, Worker deployed.

**Verified with `wrangler dev`** (the local runtime against the real AI, Media, R2 and Vectorize) on a 30 s test clip:
- it completed in 32–72 s;
- search found the blue screen at 0:20 (rerank 0.97);
- `/query` answered "The screen transitions to a solid blue field after twenty seconds [1]";
- the WebSocket replayed and then closed with 1000.

**Not verified:** the Google flows (they need the client secret and a consent), WebSockets through Access, and the deployed Worker end to end (Access blocks unauthenticated tests).

### 10.7 Incident: "wildlife" found nothing (2026-10-15)

**Symptom.** The owner imported 5 Google Photos videos (12:55 UTC); `/query` "wildlife" answered "No matching videos were found".

**Evidence, in pipeline order.**
1. **Ingestion.** All 5 are `completed`, with no error or skip (5–18 s each, well under 100 MB / 10 min, no quota waits). They are an AEK–LASK goal, a crocodile entering a lake, a wild boar foraging by water, a blue-team goal celebration at sunset, and an ISL match at 3-2.
2. **Vectors.** The index held 35 vectors, exactly the expected 5 summaries + 1 transcript window + 29 frames; mutations are processed up to 12:56:56. Metadata indexes `kind` and `video_id` exist (search uses no filter; only the duplicate check filters on `kind`). Every vector is returned when queried by its own values.
3. **Content.** The crocodile and boar summaries and frames describe the animals ("a grey-brown crocodile", "a brownish-gray wild boar … foraging", "natural, undisturbed behavior"), but none uses the word "wildlife".
4. **Query path** (same models, index and passage texts as the Worker; scratch script with `getPlatformProxy` remote bindings):

   | query | step | boar | crocodile | best soccer clip |
   |---|---|---|---|---|
   | wildlife | bge-m3 cosine | 0.587 | 0.535 | 0.422 |
   | wildlife | rerank | 0.0137 | 0.0289 | 0.0003 |
   | Wildlife | bge-m3 cosine | 0.531 | 0.470 | 0.350 |
   | Wildlife | rerank | 0.0047 | 0.0115 | 0.0013 |

   Vectorize ranked both wildlife clips first, and the reranker ranked them first by about 30×. They dropped out only at the absolute `SEARCH_MIN_SCORE` 0.02. Capitalised "Wildlife" (as typed in the search box) put both under it, so the answer was empty. Lowercase "wildlife" kept only the crocodile.

**Root cause.** The single absolute cutoff on bge-reranker-base scores. The cross-encoder gives broad category words low scores against specific frame descriptions (0.005–0.03 for "wildlife", "nature" and "animals"), and it is case-sensitive. The model, pooling, index binding and namespace were all correct, and 0.02 had only been tuned on synthetic clips. The same cutoff also let wrong videos in: the UI's own example "Tidying pillows on a bed" returned the boar (0.072) and two soccer clips.

**Fix** (`src/retrieval.ts`):
- Lowercase the query for both models.
- Accept a video on a strong rerank score, or on a weaker one (≥ 0.008) backed by a high bge-m3 cosine (≥ 0.53).
- Veto any video whose cosine is more than 0.07 below the best video's, so a reranker-only match cannot win.

Regression tests in `test/unit.test.ts` use the measured scores.

**Tuning.** I labelled 48 queries derived from the videos, then grid-searched the four thresholds. The set has 25 that must find named videos (such as "crocodile", "ambulance", "Nivia", "van Mieghem" and "3-2"), 19 that must find nothing (such as "car", "dog", "office meeting" and "basketball"), and 4 where some videos are acceptable but none is required ("crowd", "trees", "referee", "beach"). The labels and the `getPlatformProxy` scripts are not in the repo.

| rule | missed videos | wrong videos |
|---|---|---|
| old: rerank ≥ 0.02 (queries as typed: 13 misses) | 3 | 9 |
| new | 0 | 8 |

The remaining errors are all confident reranker mistakes that no threshold separates ("birthday party" → goal celebrations 0.21, "basketball" → soccer 0.99, "bird" → crocodile 0.043). Margins are thin, for example "dog" → boar has a cosine of 0.514 against the 0.53 floor, so retune on a larger library.

**Not changed, and why.**
- **No lexical fallback.** No failure was lexical: proper nouns and numbers ("Nivia", "van Mieghem", "AEK", "3-2") were found by the reranker once the query is lowercased, and "wildlife" never occurs literally, so keyword matching would not have helped.
- **`DUPLICATE_SIMILARITY_THRESHOLD` stays 0.97.** Distinct real clips reach a summary cosine of 0.766 (two soccer clips), and a reworded summary of the same clip scores 0.774. Summary vectors cannot tell a re-import from a similar clip at any threshold, so 0.97 only flags near-identical text. The check is advisory, and exact re-imports are already blocked by `(source, source_id)`. A content hash or a frame hash would be the real fix.
- Vectorize once returned 19 of 35 vectors for a query (approximate search); a rerun returned all 35. Both wildlife clips were in the 19.

**Follow-up the same day: context in front of every passage.**
- **The problem:** "birthday party" returned both goal clips, because the AEK frame says "players … embracing and shouting in celebration" without ever naming the sport (rerank 0.21).
- **What Apple Photos does:** compared on the same clips (read with `osxphotos` from the owner's library), every stored segment caption restates the setting, e.g. "a group of men in soccer uniforms standing on a soccer field and hugging each other". The labels form a chain (Football → Team Sport → Ball Games → Sport), and the boar is "Pig" plus "Wildlife". Photos found "wildlife", ignored the football clips for "birthday party", and missed "ambulance".
- **The fix:**
  - the reranker now sees "Setting: … Video: …" in front of each frame and speech passage (`rerankText`; no re-index needed, since passages are read from D1);
  - the describe prompt (`cf-frames-v3`) asks every new paragraph to open with the setting and activity.
- **Result on the 48 queries,** same thresholds: misses 0 → 0, wrong videos 8 → 4.
  - "birthday party" 0.21 → 0.0007 (no results);
  - "basketball" 0.99 → 0.06 (still wrong: it passes 0.02);
  - "ambulance" 0.085 → 0.181.
- **Thresholds:** raising `SEARCH_MIN_SCORE` to 0.05 would leave 2 wrong but puts "animals" → crocodile (0.053) on the edge, so it stays 0.02.
- **Citations:** the prefix made summaries win citations ("goal celebration" cited 0:00 instead of 0:12), so a frame or speech window is cited when it scores ≥ 50% of the best passage.

**Follow-up: label hierarchy and sound tags (2026-10-15, prompt `cf-frames-v4-labels`).**
- **Why:** Apple Photos stores fixed labels as chains (Football → Team Sport → Ball Games → Sport; Pig → Mammal → Animal + Wildlife) and non-speech sound tags (Cheering, Applause). Broad words then match stored labels, and a "Football" item cannot match "basketball". Here, 4 of the 5 clips had no speech, so audio contributed nothing.
- **Sound tags, options checked:** the Workers AI catalog (`wrangler ai models`) has ASR (Whisper, Deepgram nova-3/flux), TTS and a turn detector, but no audio classifier. `@cf/cloudflare/clef-omni` takes audio, but it would be a second model call per video with unknown quality. Gemini Flash Lite hears audio natively, so the first 60 s of audio go inline into the existing summarize call: no new call, ≤ 1,920 audio tokens.
- **Labels:** Gemini picks from the vocabulary in the same call; `validateLabels` keeps only vocabulary names, and `expandLabels` adds the ancestors at index and search time.
- **Backfill of the 5 owner videos (no deletes):** one scratch script re-ran only the summarize call (5 Gemini calls; tuning the prompt took 10 more), using each video's stored frame paragraphs and transcript and its audio track. The Media binding cannot be chained through `getPlatformProxy`, so the 60 s M4A was a stream copy (`ffmpeg -c:a copy`) of the R2 original. The script recorded each result locally before the next call, then wrote `summary`, `tags`, `labels`, `sounds` and a `relabel` note into the D1 result, and re-embedded with the repo's `indexResult` (upsert only). The pre-backfill rows were kept locally.
- **Result:** the 48 queries plus 18 new ones were run through `search()` on live data, before (old code, old data) and after (new code, backfilled data), with the same thresholds.

  | query | before | after |
  |---|---|---|
  | wildlife | crocodile, boar | crocodile, boar (both `label`; boar rerank 0.0052) |
  | basketball | AEK, blue, ISL (wrong) | — |
  | bird | crocodile (wrong) | — |
  | birthday party | — | — |
  | ambulance | blue @ frame 0:10 | blue @ frame 0:10 |
  | sunset / goal celebration | blue @ 0:16 / AEK @ 0:12, blue @ 0:02 | same moments |
  | cheering crowd / cheering | AEK only (blue missed) | AEK, blue, ISL |
  | reptile / pig / mammal / commentator | — (missed) | crocodile / boar / boar / AEK |
  | sport | 3 soccer clips | 3 soccer clips (`label`) |
  | tennis | AEK, blue (wrong) | — |
  | van Mieghem | AEK | — (see below) |
  | Razvan Marin | AEK | AEK |
  | **48 original: missed / wrong** | **0 / 4** | **1 / 0** |
  | **18 new: missed / wrong** | **6 / 2** | **0 / 0** |

- **The one miss is a mislabelled query.** "van Mieghem" never occurs in the AEK clip: the shirt reads "R. MARIN" (frame at 20:43 match time) and Whisper heard "Raz van Marijn". The old summary had hallucinated "van Mieghem". With the audio, the new summary says "Razvan Marin", and that query finds the clip.
- **Model variance.** Labels differ between runs (an earlier prompt gave the blue-team clip "car" instead of "ambulance" and no "soccer"). The prompt now asks for the most specific label per named thing, with its frames. The stored labels are from a single run, so recheck as the library grows.


### 10.8 Web UI (`public/index.html`)

One file, no build step, no external scripts; the API is unchanged.

- **Shell.** A sticky header with the brand, the search field (`/` focuses it) and the account chip. The main column holds the home view or the results. The library sits in a right sidebar at 1024 px and wider, and becomes a drawer (the header's **Library** button, with a count and a dot while anything is processing) below 1024 px.
- **Home.** The editorial headline, then search suggestions derived from the library's own labels: up to 3 that several videos share, then one distinctive label per video. With no videos, a 3-step first-run panel (connect Google or import, upload, search) replaces them.
- **Results.** The query as the heading, with the match count and `answer_model` as metadata. The Gemini answer turns `[n]` into buttons that scroll to card *n* and highlight it. Each card shows the evidence frame with its time and kind, the derived title, the file name, the cited passage, the summary, the tags, and **Open at m:ss**. Loading shows skeletons; no matches, network, timeout, expired sign-in and 429 quota each have their own state with a retry.
- **Titles.** Derived in the browser from data already in the response; nothing is stored and no model is called. In order: the title typed at upload; the most specific vocabulary label plus a second label or the setting, plus a notable vehicle or animal (for example "Crocodile · lake" or "Soccer · goal celebration · ambulance"); the first object and environment tags; the first clause of the summary; a non-random file name; and finally the camera type and date read from the file name ("WhatsApp video · Oct 1, 2025"). The file name stays visible as secondary metadata.
- **Detail sheet.** A dialog on the right, used for library rows and result cards. It shows the player, or key frames once the 7-day original is gone, then the facts, the live progress or the failure reason, the summary, key frames, tags and the transcript (frames and transcript lines seek the player). There is no retry endpoint: a failed Photos video offers **Pick it again in Google Photos**, and a failed upload offers **Upload again**. Archive and restore are in the footer.
- **Account.** The initials come from the display name when there is one, otherwise from the first letter of the email. The chip waits up to 0.8 s for `/cdn-cgi/access/get-identity`, and the last name seen is cached in `localStorage`, so the initials don't flip between loads.
- **Accessibility.** The page has landmarks, a skip link and visible focus. The sheet and drawer trap focus and return it when closed; Esc closes the menu, then the sheet, then the drawer. Search status and import progress are announced through `aria-live`, and `prefers-reduced-motion` is respected.

**Follow-up (2026-10-16): labels from tags.**
- **The problem:** of the owner's 3 new videos (all cats), Gemini labelled one only `animal` and `home`, although its tags included `('object', 'cat')`, so "cats" found it only through the reranker.
- **The fix:** `validateSummary` now also turns object and environment tags that name a vocabulary label into labels.
- **Backfill:** the 8 existing videos were updated from their stored tags with no Gemini calls, and the changed ones re-embedded. The backup is in the session scratchpad (`videos-backup-before-tagfill.json`).
- **Added labels:** cat and living room (the 37 s cat clip), pet, athlete, night, crowd, outdoor.
- **Remaining effect of the 3-result cap:** "animals" now has 5 label hits, so the boar drops out.

**Review fixes (2026-10-16).**
- **Drive:**
  - A changed file is downloaded again: `VideoDO.restart` deletes the stored copy and its sound clip, because fetch reuses an existing object.
  - A change that arrives while the video is processing is marked `refresh_pending` and applied at the next sync, instead of being dropped.
  - Files removed, trashed or moved out of the folder are archived (hidden, nothing deleted).
- **Photos:** a transient Google error while refreshing an expired download link now retries, instead of failing the video with "pick it again".
- **Search:**
  - Archived or unfinished videos no longer use up the 10 candidate slots.
  - Videos carrying every query label are also looked up in D1 (`labelMatches`, up to 10 more), so label hits don't depend on the nearest-vector cut.
- **WebSocket:** upgrades must come from the same origin.
- **UI:** generated titles are cached per render.

