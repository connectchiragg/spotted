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

log = logging.getLogger(__name__)


def process_message(message, store, cloud, tagger, settings):
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
            cloud.download(job, path)
            if path.stat().st_size > settings.max_upload_mb * 1024 * 1024:
                raise MediaError('Stored video exceeds upload limit')
            duration, frames = extract_frames(path, settings.max_frames, settings.max_video_seconds)
            result = tagger.tag_frames(frames)
            output = result.model_dump() | {
                'duration_seconds': duration, 'sampled_timestamps': [f.timestamp for f in frames],
                'model': tagger.model, 'prompt_version': PROMPT_VERSION,
            }
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
    if not settings.api_key:
        raise RuntimeError('GEMINI_API_KEY must be configured for the worker')
    store, cloud, tagger = Store(settings.database_path), Cloud(settings), GeminiTagger(settings)
    log.info('Worker polling SQS in %s', settings.aws_region)
    while True:
        try:
            store.expire_uploads()
            publish_pending(store, cloud)
            for message in cloud.receive():
                process_message(message, store, cloud, tagger, settings)
        except CLOUD_ERRORS as exc:
            log.error('AWS operation failed (%s); retrying in five seconds', type(exc).__name__)
            time.sleep(5)


if __name__ == '__main__':
    main()
