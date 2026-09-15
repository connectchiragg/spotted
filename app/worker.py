from concurrent.futures import ThreadPoolExecutor
import json
import logging
import tempfile
import time
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
            store.set_progress(request_id, token, "Downloading video", 5)
            cloud.download(job, path)
            if path.stat().st_size > settings.max_upload_mb * 1024 * 1024:
                raise MediaError('Stored video exceeds upload limit')
            store.set_progress(request_id, token, "Selecting evidence frames", 15)
            duration, frames = extract_frames(path, settings.max_frames, settings.max_video_seconds)
            # Upload the already extracted JPEGs while Gemini analyzes them.
            store.set_progress(request_id, token, "Tagging and saving citation frames", 35, 60)
            with ThreadPoolExecutor(max_workers=1) as executor:
                tagging = executor.submit(tagger.tag_frames, frames)
                for index, frame in enumerate(frames):
                    cloud.upload_frame(job, index, frame.data)
                    store.set_progress(request_id, token, "Saving citation frames", 40 + int(35 * (index + 1) / len(frames)), 45)
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
                    output['possible_duplicate'] = duplicate_detector(job | {'result': output})
                except Exception:
                    # Advisory metadata must not fail an otherwise tagged video.
                    log.exception('Description duplicate check deferred for %s', request_id)
            committed = store.finish(request_id, token, output)
            log.info('Request %s completed=%s', request_id, committed)
    except (MediaError, TaggerError, *CLOUD_ERRORS) as exc:
        transient = isinstance(exc, CLOUD_ERRORS) or isinstance(exc, TaggerError) and exc.status_code in (503, 504)
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


def main():
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
    settings = Settings()
    store, cloud, tagger = get_store(settings), Cloud(settings), create_tagger(settings)
    log.info('Worker polling %s', 'PostgreSQL' if settings.database_url else 'SQS')
    while True:
        try:
            store.expire_uploads()
            publish_pending(store, cloud)
            messages = cloud.receive()
            if not messages and settings.database_url:
                time.sleep(1)
            for message in messages:
                process_message(message, store, cloud, tagger, settings,
                    duplicate_detector=lambda job: possible_duplicate(store,
                        load_embedder(settings.embedding_model, settings.embedding_cache),
                        job, settings.duplicate_similarity_threshold))
                # Indexing can be recovered on search; never undo successful tagging.
                try:
                    index_jobs(store, load_embedder(settings.embedding_model, settings.embedding_cache), store.completed())
                    index_frames(store, load_embedder(settings.embedding_model, settings.embedding_cache), store.completed())
                except Exception:
                    log.exception('Local embedding index deferred; search will retry')
        except CLOUD_ERRORS as exc:
            log.error('AWS operation failed (%s); retrying in five seconds', type(exc).__name__)
            time.sleep(5)


if __name__ == '__main__':
    main()
