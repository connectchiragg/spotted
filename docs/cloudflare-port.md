# Framer on Cloudflare (free tier)

This branch (`cloudflare-port`) moves Framer off its AWS EC2 server. A Worker in
[`cloudflare/`](../cloudflare) runs it on Cloudflare's free tier. The Python app
in `app/` is unchanged and its tests still pass.

Status on 2026-10-14:
- **Created (free):** the D1 database `framer-cf-db`, migrated, and the Vectorize index `framer-cf-vectors`.
- **Deployed:** the `framer-cf-smoke` Worker at https://framer-cf-smoke.connect-chirag-g.workers.dev. It runs against real D1, Vectorize and Workers AI.
- **Blocked on the owner:** uploads and ingestion. They need R2, which must be enabled in the dashboard (see the owner steps).
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
| Background worker (systemd) | **Cron trigger** `* * * * *` draining the D1 queue | 5 crons per account; 10 ms CPU; 15 min wall clock per run (I/O waits don't count as CPU) | [limits](https://developers.cloudflare.com/workers/platform/limits/), [cron triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/) |
| Postgres metadata | **D1** `framer-cf-db` (tables `videos`, `usage_counters`) | 10 DBs; 500 MB per DB; 5M rows read and 100k rows written per day; 50 queries per invocation | [D1 limits](https://developers.cloudflare.com/d1/platform/limits/), [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) |
| Postgres `work_queue` + SKIP LOCKED | **D1 `jobs` table with leases** (owner's design, §2.1) | same as D1 | — |
| pgvector | **Vectorize** `framer-cf-vectors` (384 dims, cosine; metadata indexes `kind` and `video_id`) | 5M stored dimensions (≈13k vectors, ≈700 videos at 18 vectors each); 30M queried dimensions/month; topK ≤ 100 | [Vectorize pricing](https://developers.cloudflare.com/vectorize/platform/pricing/), [limits](https://developers.cloudflare.com/vectorize/platform/limits/) |
| FastEmbed in-process | **Workers AI** `@cf/baai/bge-small-en-v1.5` (384 dims; others: bge-base 768, bge-large 1024, bge-m3, embeddinggemma-300m, qwen3-embedding-0.6b, plamo-embedding-1b) | 10,000 neurons/day; bge-small costs 1,841 neurons per M tokens, so about 5 neurons per video | [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/), [models](https://developers.cloudflare.com/workers-ai/models/) |
| S3 (videos, frames) | **R2** `framer-cf-videos`: presigned PUT/GET over the S3 API; lifecycle 7 days | 10 GB-month; 1M Class A and 10M Class B ops per month; free egress; single PUT up to 5 GiB | [R2 pricing](https://developers.cloudflare.com/r2/pricing/), [presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/) |
| FFmpeg frame extraction | **Not possible on Workers.** Gemini analyses the **whole video** via its Files API and returns timestamped "moments" (§3) | Gemini Files API: 2 GB per file on the free tier, files kept 48 h; ~100 tokens/s at low media resolution | [Gemini video understanding](https://ai.google.dev/gemini-api/docs/video-understanding) |
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

**Consumer.** `cloudflare/src/index.ts` `runCron` does three things on every cron tick:
- expires unconfirmed uploads after 15 minutes;
- purges `done`/`dead` rows older than 7 days;
- claims and processes jobs until none are due, `QUEUE_STEPS_PER_TICK` (6) steps have run, or 10 minutes have passed.

Workers expose no CPU clock, so the CPU budget is enforced as a step count. A typical video completes within 2–3 cron ticks: `upload`, then `await_file`, then `tag` and `index` in the same tick.

## 3. Feasibility and risks

- **Ingestion on Workers.** Workers cannot run FFmpeg or any native binary, so this port changes how videos are analysed:
  - The Worker streams the R2 object into Gemini's resumable Files API upload. It uses `FixedLengthStream` and never buffers, which matters with 128 MB of memory.
  - Gemini samples the video itself (1 fps by default; this port asks for low media resolution). It returns 1–16 timestamped **moments**. These map onto the existing `sampled_timestamps`, `frame_descriptions` and tag `frame_indices`, so retrieval and the UI are unchanged.
  - **What is lost:** stored JPEG citation frames. The UI now shows the video itself paused at the cited time (`citationVisual` in `cloudflare/public/index.html`). Migrated EC2 videos still use their JPEGs while those exist in R2.
  - **Formats:** MKV is not accepted by Gemini and fails with a clear error. MP4, MOV, WebM, AVI, MPEG, WMV, FLV and 3GP work.
  - **Unverified:**
    - **CPU time** of streaming 400 MB through a Worker. Body pass-through should be native and not count as JS CPU.
    - **Gemini timing.** Whether a `gemini-3.5-flash` call on a 10-minute video finishes within the 300 s lease.
    - **Fallback** if either fails: limit the upload size, or run ingestion off-Worker (e.g. a GitHub Actions job) against the same D1 queue through D1's HTTP API.
- **10 ms CPU** per invocation on Workers Free.
  - Each step is mostly network wait, and the ranking runs on at most 50 candidates. A step that is killed for CPU is retried through its lease and dead-letters after 5 attempts.
  - Observability is enabled so `cpuTime` can be checked after cutover.
- **Embeddings change.** All stored vectors must be recomputed:
  - Workers AI vectors are not interchangeable with the FastEmbed vectors on EC2. They also live in a different store (Vectorize, not pgvector).
  - The importer queues a `reindex` job for every completed video.
  - The thresholds (`SEARCH_MIN_SIMILARITY=0.60`, duplicate 0.95) were tuned on FastEmbed and should be re-checked on real queries.
- **Candidate set.** Search ranks the 50 nearest videos plus any video whose tag labels contain a query word, rather than every video. Frame scores come from one top-100 Vectorize query; a frame outside it scores 0.
- **Free-tier ceilings.**
  - The UI polls `/videos` every 3 s. Each open tab costs 1,200 requests/hour and up to ~60k D1 rows read/hour, so the daily request and D1 read limits allow roughly **80 tab-hours per day**. Raising the poll interval is the simplest fix if needed.
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
3. The cron then re-embeds completed videos (`reindex` jobs) and restarts unfinished ones.
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
4. **Deploy:** `cd cloudflare && npm ci && npm test && npm run deploy`. The D1 migration is already applied; `npm run db:migrate` is idempotent.
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
  - `src/queue.ts`: the lease queue.
  - `src/ingest.ts`: the job chain and consumer.
  - `src/gemini.ts`, `src/vectors.ts`, `src/retrieval.ts`, `src/store.ts`.
  - `migrations/`.
  - `scripts/ec2-to-d1.mjs`.
- **Wrangler environments:**
  - top-level (`framer-cf-api`): the production config;
  - `smoke`: no R2, no cron;
  - `test`: local only.
