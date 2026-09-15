# Instawork video tagger

Synchronous prototype: upload a video, extract representative JPEG frames with
FFmpeg, analyze the images with Gemini, and return structured tags and evidence.

## Run locally

Requires Python 3.11+ and FFmpeg/ffprobe on PATH (on macOS: `brew install ffmpeg`).

```sh
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
cp .env.example .env
# Set GEMINI_API_KEY and an available GEMINI_MODEL in .env.
.venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000
```

Open http://127.0.0.1:8000/docs and try `POST /videos/tag`, or:

```sh
curl --fail-with-body -X POST http://127.0.0.1:8000/videos/tag \
  -F 'file=@/Users/omen/Downloads/assignment_videos/1.mp4'
```

The request waits until inference completes. Response fields include a summary,
tags (`label`, `category`, `frame_indices`), sampled timestamps, model and prompt
version. Each zero-based frame index refers to the `sampled_timestamps` array.
Files and extracted images are deleted after the request, including on failure.
Only extracted images are sent to Gemini. No audio is analyzed.

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
They do not measure Gemini accuracy or prove live provider access.

### Executed verification (September 15, 2026)

- 8 automated tests passed on Python 3.14.3; dependency deprecation warnings only.
- All four supplied MP4s passed through the upload endpoint with actual FFmpeg
  and Gemini 3.6 Flash inference at eight sampled frames each:
  1.mp4: 16.44s; 2.mp4: 19.71s; 3.mp4: 12.65s; 4.mp4: 14.87s.
- These were in-process HTTP endpoint tests using FastAPI TestClient with real
  inference. The running localhost server also passed health and invalid-upload
  HTTP checks. Saved responses are local under ignored `artifacts/`.
- Earlier provider requests timed out, including a 16-frame request. These
  successful measurements are observations, not a latency or availability SLA.
- Main scene/activity tags match the independent candidate reference. Specialist
  material labels and precise evidence indices require further human review.

## Current scope and limits

This slice has no database, search, authentication or background jobs. It runs
locally and holds the HTTP request open during processing. Multipart parsing
spools uploads before the endpoint's size check; public hosting would require a
request-body limit at the proxy/server boundary and concurrency controls.
For production: durable queue/workers, object storage, persistent tags, retries,
idempotency, cost controls, authentication and model-quality evaluation.

## Decisions

- User selected synchronous ingestion first; persistence and search are deferred.
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
