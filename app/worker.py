from concurrent.futures import ThreadPoolExecutor, as_completed, wait, FIRST_COMPLETED
import json
import logging
import random
import tempfile
import time
from threading import BoundedSemaphore, Lock
from pathlib import Path

from app.cloud import CLOUD_ERRORS, Cloud, publish_pending
from app.config import Settings
from app.media import MediaError, extract_frames
from app.store import Store
from app.tagger import GeminiTagger, PROMPT_VERSION, TaggerError
from app.retrieval import index_jobs, index_frames, load_embedder
from app.providers import create_tagger
from app.storage import get_store
from app.duplicates import possible_duplicate

log = logging.getLogger(__name__)
DECODER_SLOT = BoundedSemaphore(1)
EMBEDDING_SLOT = Lock()
MAX_ACTIVE_JOBS = 2
MAX_FRAME_UPLOADS = 3


def tag_with_retry(tagger, frames, store, request_id, token, timeout):
    # Keep the same extracted images; never restart ingestion for model outages.
    for attempt in range(2):
        started = time.monotonic()
        try:
            result = tagger.tag_frames(frames)
            log.info('Request %s tagging attempt=%s elapsed=%.2fs', request_id, attempt + 1, time.monotonic() - started)
            return result
        except TaggerError as exc:
            log.warning('Request %s tagging attempt=%s elapsed=%.2fs status=%s', request_id, attempt + 1, time.monotonic() - started, exc.status_code)
            if attempt or not exc.retryable:
                raise
            store.set_progress(request_id, token, 'Model unavailable; retrying saved frames once', 80, timeout)
            time.sleep(random.uniform(1, 2))


def process_message(message, store, cloud, tagger, settings, duplicate_detector=None):
    receipt = message['ReceiptHandle']
    try:
        request_id = json.loads(message['Body'])['request_id']
        if not isinstance(request_id, str):
            raise ValueError()
    except (ValueError, KeyError, TypeError):
        log.warning('Discarding malformed queue message')
        cloud.acknowledge(receipt)
        return
    job = store.get(request_id)
    if not job or job['status'] in ('completed', 'failed'):
        cloud.acknowledge(receipt)
        return
    if not job['uploaded']:
        return
    token = store.claim(request_id, settings.lease_seconds)
    if token is None:
        return  # A concurrent worker owns this request; leave delivery for redelivery.
    job = store.get(request_id)
    try:
        if job['attempts'] > 3:
            raise MediaError('Processing exceeded three attempts')
        with tempfile.TemporaryDirectory(prefix='instawork-worker-') as directory:
            path = Path(directory) / 'source.video'
            store.set_progress(request_id, token, "Waiting for decoder", 2)
            waited = time.monotonic()
            with DECODER_SLOT:
                log.info('Request %s decoder_wait=%.2fs', request_id, time.monotonic()-waited)
                started = time.monotonic()
                store.set_progress(request_id, token, "Downloading video", 5)
                cloud.download(job, path)
                log.info('Request %s download=%.2fs', request_id, time.monotonic()-started)
                if path.stat().st_size > settings.max_upload_mb * 1024 * 1024:
                    raise MediaError('Stored video exceeds upload limit')
                started = time.monotonic()
                store.set_progress(request_id, token, "Selecting evidence frames", 15)
                duration, frames = extract_frames(path, settings.max_frames, settings.max_video_seconds)
                log.info('Request %s extraction=%.2fs frames=%s', request_id, time.monotonic()-started,len(frames))
            # Network uploads overlap model inference; decoder capacity is already released.
            store.set_progress(request_id, token, "Tagging and saving citation frames", 35, 60)
            with ThreadPoolExecutor(max_workers=1) as tagging_executor, ThreadPoolExecutor(max_workers=MAX_FRAME_UPLOADS) as upload_executor:
                tagging = tagging_executor.submit(tag_with_retry, tagger, frames, store, request_id, token, settings.gemini_timeout_seconds)
                started = time.monotonic()
                uploads = [upload_executor.submit(cloud.upload_frame,job,index,frame.data)
                           for index,frame in enumerate(frames)]
                for count, uploaded in enumerate(as_completed(uploads),1):
                    uploaded.result()
                    store.set_progress(request_id, token, "Saving citation frames", 40 + int(35 * count / len(frames)), 45)
                log.info('Request %s frame_uploads=%.2fs frames=%s',request_id,time.monotonic()-started,len(frames))
                if not tagging.done():
                    store.set_progress(request_id, token, "Waiting for video tags", 80, 30)
                result = tagging.result()
            output = result.model_dump() | {
                'duration_seconds': duration, 'sampled_timestamps': [f.timestamp for f in frames],
                'model': tagger.model, 'prompt_version': getattr(tagger,'prompt_version',PROMPT_VERSION),
                'frame_indices': list(range(len(frames))),
            }
            store.set_progress(request_id, token, "Finalizing results", 96, 5)
            if duplicate_detector is not None:
                try:
                    started = time.monotonic()
                    with EMBEDDING_SLOT:
                        output['possible_duplicate'] = duplicate_detector(job | {'result': output})
                    log.info('Request %s duplicate_check=%.2fs',request_id,time.monotonic()-started)
                except Exception:
                    # Advisory metadata must not fail an otherwise tagged video.
                    log.exception('Description duplicate check deferred for %s', request_id)
            committed = store.finish(request_id, token, output)
            log.info('Request %s completed=%s', request_id, committed)
    except (MediaError, TaggerError, *CLOUD_ERRORS) as exc:
        transient = isinstance(exc, CLOUD_ERRORS)
        message_text = str(exc) if isinstance(exc, (MediaError, TaggerError)) else 'AWS download failed'
        committed = store.processing_failed(request_id, token, message_text,
                                             retry=transient and job['attempts'] < 3)
        log.warning('Request %s failed (%s)', request_id, type(exc).__name__)
    except Exception:
        log.exception('Unexpected ingestion failure for %s', request_id)
        committed = store.processing_failed(request_id, token, 'Unexpected processing failure', retry=False)
    # Persist the outcome BEFORE deleting the queue message. Redelivery after a
    # crash here observes the terminal state and never repeats completed inference.
    if committed:
        cloud.acknowledge(receipt)


def dispatch_available(cloud, executor, active, process):
    """Poll only with a free job slot. Cloud.receive returns at most one delivery."""
    for future in list(active):
        if future.done():
            active.remove(future)
            try:
                future.result()
            except Exception:
                log.exception('Worker task failed outside processing; delivery lease will expire')
    if len(active) >= MAX_ACTIVE_JOBS:
        return False
    messages = cloud.receive()
    if len(messages) > 1:
        raise RuntimeError('Worker queue receive must return at most one message')
    for message in messages:
        active.add(executor.submit(process, message))
    return bool(messages)


def main():
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
    settings = Settings()
    store, cloud, tagger = get_store(settings), Cloud(settings), create_tagger(settings)
    log.info('Worker polling %s with %s jobs, one decoder, %s uploads per job',
             'PostgreSQL' if settings.database_url else 'SQS',MAX_ACTIVE_JOBS,MAX_FRAME_UPLOADS)

    def process(message):
        process_message(message, store, cloud, tagger, settings,
            duplicate_detector=lambda job: possible_duplicate(store,
                load_embedder(settings.embedding_model, settings.embedding_cache),
                job, settings.duplicate_similarity_threshold))
        # All worker-side ONNX indexing shares one lane, including duplicate checks.
        try:
            started=time.monotonic()
            with EMBEDDING_SLOT:
                embedder=load_embedder(settings.embedding_model,settings.embedding_cache)
                jobs=store.completed()
                index_jobs(store,embedder,jobs)
                index_frames(store,embedder,jobs)
            log.info('Post-job indexing=%.2fs',time.monotonic()-started)
        except Exception:
            log.exception('Local embedding index deferred; search will retry')

    with ThreadPoolExecutor(max_workers=MAX_ACTIVE_JOBS) as executor:
        active=set()
        while True:
            try:
                if len(active) >= MAX_ACTIVE_JOBS:
                    wait(active,return_when=FIRST_COMPLETED,timeout=1)
                    if not any(future.done() for future in active):
                        continue
                store.expire_uploads()
                publish_pending(store, cloud)
                if not dispatch_available(cloud,executor,active,process) and settings.database_url:
                    time.sleep(.25)
            except CLOUD_ERRORS as exc:
                log.error('AWS operation failed (%s); retrying in five seconds',type(exc).__name__)
                time.sleep(5)


if __name__ == '__main__':
    main()
