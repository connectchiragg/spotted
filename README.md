# Spotted

**Find the moment.** Search your videos in plain language, such as "wildlife", "goal celebration" or "ambulance", and get the clip, the moment and the frame that proves it.

Live at **https://framer.haciensus.com** (private, behind Cloudflare Access; the domain and the `framer-cf-*` resources keep the original name) · Portfolio: **https://haciensus.com**

Spotted is an independent project, formerly called Framer. It runs entirely on Cloudflare's free tier.

## What it does

- **Bring videos in:**
  - Pick videos in **Google Photos** (Google's own picker; Spotted only sees what you pick);
  - watch a **Google Drive** folder (checked hourly);
  - or **upload** a file.
  - Videos under 100 MB and 10 minutes are accepted; larger ones are skipped and say so.
- **Watch it work:** each video shows live progress, from "19 MB of 41 MB copied from Google" through the analysis steps to ready, over a WebSocket.
- **Search:** results come with:
  - a short answer that cites its sources as [1], [2];
  - up to three videos;
  - for each, the cited moment's frame, timestamp and the passage that matched;
  - an "Open at 0:12" link.
- **Browse:** every video gets a readable title (e.g. "Crocodile · lakeshore"), a summary, tags and a transcript.

## How it works

```text
Google Photos / Drive / upload
        │
        ▼
  VideoDO (one Durable Object per video, alarm-driven steps, each result saved before the next)
    fetch → R2                    streamed multipart copy, 100 MB cap
    probe                         duration from the MP4 header
    select + frames               Media Transformations spritesheets → up to 16 changed frames
    transcribe                    Workers AI whisper-large-v3-turbo
    describe + summarize          Gemini 3.1 Flash Lite: a paragraph per frame, a summary, tags,
                                  labels from a fixed hierarchy, sound tags (first 60 s of audio)
    index                         Workers AI bge-m3 → Vectorize (summary, speech windows, frames)
        │
        ▼
  Search: bge-m3 nearest 100 → group by video → bge-reranker-base (each passage with its video's
          context) + label hierarchy → up to 3 videos → Gemini answer with validated [n] citations
```

| Piece | Cloudflare service |
|---|---|
| API and UI (one HTML file, no build step) | Worker `framer-cf-api` |
| Per-video pipeline and live status | Durable Object `VideoDO` (hibernatable WebSockets) |
| Google Photos sessions, Drive sync | Durable Object `LibraryDO` |
| Videos, results, Google connection | D1 `framer-cf-db` |
| Vectors (1024-d) | Vectorize `framer-cf-m3` |
| Originals (kept 7 days), frames, audio | R2 `framer-cf-videos` |
| Speech, embeddings, reranking | Workers AI |
| Sign-in | Cloudflare Access (Google) |

### Search quality

Search combines three signals, because no single one was reliable on real footage:

1. **Labels.** Gemini picks labels from a fixed vocabulary of about 150 visual labels and 30 sound tags; our code adds every parent, e.g. crocodile → reptile → animal, plus "wildlife".
   - Broad words like "wildlife" or "animals" match these stored labels directly.
   - A conflicting sibling label blocks a match: a clip labelled "soccer" can't match "basketball".
2. **Reranker.** A cross-encoder scores each passage. Every frame passage carries its video's context ("Setting: soccer stadium. Video: …"), so a frame of players hugging doesn't match "birthday party".
3. **Vector similarity** to the best match, which vetoes reranker-only outliers.

The thresholds were tuned on the owner's real videos against about 65 labelled queries. The method and before/after numbers are in [docs/cloudflare-port.md §10.7](docs/cloudflare-port.md).

## Develop

```sh
cd cloudflare
npm ci
npm test          # unit tests + workerd tests (Miniflare D1, Durable Objects)
npm run typecheck
npx wrangler dev  # local; AI, Vectorize and Media need a Cloudflare login
```

- **Code** (in `cloudflare/src/`):
  - `api.ts`: routes;
  - `video.ts`: the pipeline;
  - `library.ts`, `google.ts`: Google Photos and Drive;
  - `retrieval.ts`, `labels.ts`, `vectors.ts`: search;
  - `gemini.ts`: prompts and validation.
- **UI:** `cloudflare/public/index.html`.
- **Deploy:** `cd cloudflare && npm run deploy`. The custom domain and Access are configured in the Cloudflare dashboard, not in `wrangler.jsonc`.
- **Secrets** (`wrangler secret put`, never committed): `GEMINI_API_KEY`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `ADMIN_TOKEN`, `TOKEN_ENC_KEY`, `GOOGLE_CLIENT_SECRET`.
- **Operations:** deleting a video (`DELETE /admin/videos/:id`), owner setup steps, the free-tier budget and incident notes are all in [docs/cloudflare-port.md](docs/cloudflare-port.md).

## Limits

- **Size and quotas:**
  - 100 MB and 10 minutes per video;
  - 10 uploads and 100 searches per UTC day.
- **Google:**
  - Gemini's free tier allows 15 requests/minute and 500/day (about 2–3 per video). Imports start 20 s apart, and a quota hit waits instead of failing.
  - The Google OAuth app is in Testing mode, so the Google connection must be renewed every 7 days. The UI asks.
- **Storage:** originals are deleted after 7 days (frames, results and search remain), so playback of older videos stops.
- **Search:**
  - Labels and descriptions are generated and can be wrong.
  - Thresholds are tuned on a small library.
  - Broad queries are capped at 3 results.
- **Drive:** checked hourly. Files removed from the folder are archived in Spotted (hidden, not deleted), and changed files are analysed again.

## History

Spotted (originally named Framer) started as a FastAPI + PostgreSQL/pgvector + FFmpeg app on AWS EC2. That version is still in `app/`, `scripts/` and `deploy/`, with its tests in `tests/`. Its instance is stopped. The move to Cloudflare, with its design decisions, is documented in [docs/cloudflare-port.md](docs/cloudflare-port.md).
