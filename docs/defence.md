# IRL — engineering defence

## Problem and user need

Make recorded work videos discoverable by scenes, objects and actions. A user
uploads a video, sees processing status, searches in natural language and plays
the sampled moment supporting a result.

## Acceptance criteria

- Upload originals privately without routing video bytes through the API.
- Track uploading, pending, processing, completed and failed requests.
- Extract bounded image samples and generate validated tags and frame descriptions.
- Retrieve up to three qualifying videos with timestamped, playable evidence.
- Preserve request history separately from search.
- Run locally with repeatable setup and behaviour tests.

## Architecture and data flow

Browser -> FastAPI/Uvicorn (Python) -> signed upload intent in PostgreSQL.
Browser -> private S3 using a ten-minute signed PUT.
Browser -> completion API -> S3 metadata verification -> pending record -> PostgreSQL queue ID.
Python worker -> atomic claim/lease -> original on temporary disk -> FFmpeg frames
-> Gemini -> persisted results -> queue acknowledgement -> local embedding index.
Search -> local BGE query embedding -> pgvector video/frame vectors -> semantic and
keyword qualification -> hybrid ranking -> timestamped JPEG citation and S3 video.

The signed PUT binds size, content type, encryption and a no-overwrite condition.
Local-only S3 CORS enables browser uploads without making the bucket public.
Temporary AWS credential expiry can shorten the requested one-day preview URL.

## Decisions and trade-offs

- Start with a complete synchronous vertical slice, then separate API/worker via SQS.
- Keep originals. Whole-video compression increased one sample's size and added
  processing time; resizing only the sampled images is sufficient for model input.
- Retain Gemini after a measured local CLIP trial produced visible false tags.
  Local CLIP remains an explicit experimental adapter. A larger local VLM was not
  verified on this 8 GB Mac within the requested evaluation window.
- Eight resized frames limit inference work but can miss brief actions. Additional
  frame descriptions improve timestamp selection without establishing ground truth.
- Local text embeddings avoid a search embedding API. PostgreSQL and linear scans
  maximize prototype simplicity; they are not the production-scale index.
- Short-query exact evidence can qualify below the cosine cutoff. The original
  cutoff rejected "grill" despite explicit tags and frame text; a regression now
  preserves that match while rejecting unrelated candidates.
- Chunked/incremental tagging was discussed and deliberately deferred. Whole-video
  download is an implementation choice, not a requirement for generating tags.

## Human decisions and AI work

The user selected Gemini, asynchronous S3/SQS ingestion, direct browser uploads,
original retention, natural-language search, inline playback and the IRL name.
The user challenged memory assumptions and stopped unnecessary full-video
compression and streaming expansion. AI implemented adapters, APIs, UI and tests,
ran verification and surfaced quality and integration failures. Claims here are
limited to observed behaviour; no production scale or general accuracy is claimed.

## Mistakes and weaknesses caught

- Global S3 hostname caused a redirect and invalid signatures; sign regionally.
- An exact "grill" match fell below a semantic evidence cutoff; lexical evidence
  now participates in qualification instead of only ranking.
- A correct video-level handwashing tag cited sponge handling. Bounds validation
  cannot establish visual correctness; model evidence needs human evaluation.
- A transient Gemini 503 was incorrectly mapped to a terminal error. Transient
  500/502/503 now use the existing maximum-three-attempt worker policy.
- CLIP was fast but false-positive cooking labels made it unsuitable as default.
- The independent candidate reference itself initially confused a hoe with a shovel.

## Validation

89 automated tests passed in the final local build, including real PostgreSQL integration tests. They cover
real FFmpeg decoding, API validation, lease ownership, duplicate delivery,
outbox recovery, provider errors, retrieval/evidence, signed upload conditions
and direct-upload completion. MP4/H264, MOV/H264, MKV/MPEG4, AVI/MPEG4 and
WebM/VP8 were exercised. Provider and AWS unit tests use substitutes.

Separately observed live: real Gemini tagging, browser-to-S3 upload with local
CORS, overwrite rejection, previews, timestamp seeking and inline playback.
"pillow" retrieves only the bedroom video; "grill" retrieves the cleaning video.
Unrelated dog searches returned no matches. These examples are not an accuracy
benchmark. One real inference failed on service unavailability; a subsequent
user upload completed. No failed record was silently rewritten.

## Known limitations and production priorities

- No authentication: bound to localhost. Public deployment requires user isolation,
  authorisation, abuse controls and quotas before release.
- The demo co-locates PostgreSQL and processes on one host. Separate managed database
  operations and shared artifact storage are production deployment work.
- Linear vector scans and heuristic thresholds need an indexed vector store and
  a labelled relevance evaluation including hard negatives.
- Sparse-frame action descriptions can hallucinate or miss events; measure tag
  precision/recall and timestamp correctness separately.
- No hard process memory cap or source resolution bound. Profile Python plus
  FFmpeg child processes; enforce memory, input and temporary-disk limits.
- One job per ingestion worker, but API sync endpoints can overlap in threads.
  Extra model-bearing processes generally duplicate model memory.
- Direct upload is one PUT, not resumable multipart. Abandoned uploaded objects
  need lifecycle/reconciliation. URL issuance/confirmation requires idempotency
  and monitoring beyond the current scoped implementation.
- PostgreSQL now commits upload completion and queue insertion atomically. Claim
  tokens protect retries; a crash after inference before commit can still repeat charges.
- Production needs lease heartbeats, a dead-letter policy, metrics and cost budgets.
  Account free-plan eligibility was checked; that does not make operation free at scale.

## Scale discussion

One million video-hours per 30-day month is about 1,389 hours of video arriving
per wall-clock hour. At one sampled frame every five seconds, that would be
720 million frames/month, about 278 frames/second on average. This is an example
sampling policy, not the current eight-frames-per-clip configuration. Clip counts
and duration distribution are required to estimate the current policy's workload.
Benchmark end-to-end throughput and peak memory, then size worker replicas from
queue latency targets and costs. Scale API replicas separately from ingestion.

## Two-minute walkthrough

1. Explain the user need and the smallest complete workflow.
2. Upload a video; show that the browser sends its bytes to S3 and receives a request ID.
3. Show request states and explain the queue, lease and failure recovery.
4. Search "pillow" or "grill" and play a supporting frame inline.
5. Show the tagging adapter, bounded extraction and retrieval qualification code.
6. Show tests and one caught mistake, then explain what changes for production.

## Likely interviewer questions

**Why not stream the entire pipeline?** Downloading to temporary disk already
avoids whole-video RAM usage and supports MP4 seeking. Incremental batches are
possible, but add partial states, retries, merging and per-call prompt overhead.

**Why Gemini?** It produced better observed tags than our tested local CLIP baseline.
The provider boundary supports switching after quality/latency/cost evaluation.

**Why separate frame descriptions?** An object tag says where an object appears;
a frame description can distinguish interaction from mere presence. It remains
model evidence, not verified proof.

**Why not a vector database immediately?** The prototype has a handful of videos.
PostgreSQL plus vectors is inspectable and sufficient; linear scan is explicitly a
scaling limit rather than a claim of production architecture.

**Can one Uvicorn process serve multiple uploads?** Yes. Sync endpoints use a thread
pool. Direct S3 upload removes video transfer from that API process altogether.

**What if the same SQS message arrives twice?** Atomic claims prevent concurrent
ownership; terminal records are acknowledged without repeating completed work.
A crash before persisting inference can still cause another model call.

**Are the tags accurate?** Core scenes were recognisable in reviewed examples,
but citation and specialist-material errors were found. We have no defensible
general accuracy percentage from four videos.

## Final scope updates

The user requested PostgreSQL with pgvector and a durable SQL queue, replacing
active SQLite/SQS usage. Conversation memory and CI/CD were subsequently canceled;
queries are independent, with Gemini-generated grounded answers and inline results.
The request sidebar includes manual refresh and persisted summary/tags/preview.
The public demo is explicitly open to anyone with its URL. Temporary EC2 resources
were specifically approved under the active AWS FREE plan, along with secure SSH
transfer of the Gemini key and database snapshot. Automatic termination is scheduled
for three hours; no paid-plan upgrade was performed.
