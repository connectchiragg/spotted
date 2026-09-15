import logging
import tempfile
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Query, UploadFile

from app.cloud import CLOUD_ERRORS, Cloud
from app.config import Settings
from app.store import Store

router = APIRouter()
log = logging.getLogger(__name__)


def settings_dependency():
    return Settings()


def store_dependency(settings: Settings = Depends(settings_dependency)):
    return Store(settings.database_path)


def cloud_dependency(settings: Settings = Depends(settings_dependency)):
    if not settings.aws_usage_enabled:
        raise HTTPException(503, 'AWS usage is paused until free-tier eligibility is verified')
    try:
        return Cloud(settings)
    except (RuntimeError, *CLOUD_ERRORS) as exc:
        raise HTTPException(503, 'AWS is not configured; check credentials, S3_BUCKET and SQS_QUEUE_URL') from exc


def read_cloud_dependency(settings: Settings = Depends(settings_dependency)):
    if not settings.aws_usage_enabled or not settings.s3_bucket or not settings.sqs_queue_url:
        return None
    try:
        return Cloud(settings)
    except CLOUD_ERRORS:
        return None


def present(job, cloud):
    result = {key: job[key] for key in ('id','filename','status','created_at','updated_at','error','attempts','result')}
    result.update(download_url=None, download_url_expires_at=None)
    if job['uploaded']:
        if cloud is None:
            result['download_error'] = 'Preview link temporarily unavailable'
            return result
        try:
            result['download_url'], result['download_url_expires_at'] = cloud.url(job)
        except CLOUD_ERRORS:
            result['download_error'] = 'Preview link temporarily unavailable'
    return result


@router.post('/videos', status_code=202)
def upload_video(file: UploadFile, settings: Settings = Depends(settings_dependency),
                 store: Store = Depends(store_dependency), cloud: Cloud = Depends(cloud_dependency)):
    job = None
    try:
        with tempfile.TemporaryDirectory(prefix='instawork-upload-') as directory:
            path = Path(directory) / 'upload'
            size = 0
            with path.open('wb') as target:
                while chunk := file.file.read(1024 * 1024):
                    size += len(chunk)
                    if size > settings.max_upload_mb * 1024 * 1024:
                        raise HTTPException(413, 'Video exceeds upload size limit')
                    target.write(chunk)
            if size == 0:
                raise HTTPException(422, 'Video file is empty')
            # Validate actual media in the worker; filenames never become local paths.
            content_type = file.content_type if (file.content_type or '').startswith('video/') else 'application/octet-stream'
            job = store.create(file.filename or 'video', content_type)
            cloud.upload(path, job)
            store.uploaded(job['id'])
            try:
                cloud.publish(job['id'])
                store.published(job['id'])
            except CLOUD_ERRORS:
                # Durable pending row lets the worker reconcile a failed enqueue.
                log.warning('Queue send deferred for %s', job['id'])
            return present(store.get(job['id']), cloud)
    except CLOUD_ERRORS as exc:
        if job:
            store.upload_failed(job['id'], 'Video upload to S3 failed; submit again')
        raise HTTPException(502, {'message': 'S3 upload failed', 'request_id': job['id'] if job else None}) from exc
    finally:
        file.file.close()


@router.get('/videos')
def history(limit: int = Query(50, ge=1, le=100), offset: int = Query(0, ge=0),
            tags: list[str] | None = Query(None, max_length=20, description='Exact tag labels, OR matched. Repeat this parameter for multiple tags.'),
            store: Store = Depends(store_dependency), cloud: Cloud = Depends(read_cloud_dependency)):
    """Request history, or completed videos matching ANY supplied tag.

    Labels are case-insensitive and whitespace-normalized. No substring,
    synonym or summary matching. Without tags, returns requests in every state.
    """
    normalized = None
    if tags is not None:
        normalized = list(dict.fromkeys(' '.join(tag.lower().split()) for tag in tags))
        if any(not tag or len(tag) > 80 for tag in normalized):
            raise HTTPException(422, 'Each tag must contain between 1 and 80 characters')
    return {'items': [present(job, cloud) for job in store.list(limit, offset, normalized)],
            'limit': limit, 'offset': offset}


@router.get('/videos/{request_id}')
def status(request_id: str, store: Store = Depends(store_dependency), cloud: Cloud = Depends(read_cloud_dependency)):
    job = store.get(request_id)
    if job is None:
        raise HTTPException(404, 'Request not found')
    return present(job, cloud)
