import logging
import tempfile
import unicodedata
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Query, UploadFile
from pydantic import BaseModel, Field, field_validator
from botocore.exceptions import ClientError

from app.cloud import CLOUD_ERRORS, Cloud
from app.config import Settings
from app.store import Store
from app.storage import get_store

router = APIRouter()
log = logging.getLogger(__name__)


def settings_dependency():
    return Settings()


def store_dependency(settings: Settings = Depends(settings_dependency)):
    return get_store(settings)


def cloud_dependency(settings: Settings = Depends(settings_dependency)):
    if not settings.aws_usage_enabled:
        raise HTTPException(503, 'AWS usage is paused until free-tier eligibility is verified')
    try:
        return Cloud(settings)
    except (RuntimeError, *CLOUD_ERRORS) as exc:
        raise HTTPException(503, 'AWS is not configured; check credentials, S3_BUCKET and SQS_QUEUE_URL') from exc


def read_cloud_dependency(settings: Settings = Depends(settings_dependency)):
    if not settings.aws_usage_enabled or not settings.s3_bucket:
        return None
    try:
        return Cloud(settings)
    except CLOUD_ERRORS:
        return None


def present(job, cloud):
    result = {key: job[key] for key in ('id','filename','status','created_at','updated_at','error','attempts','result')}
    result.update(display_name=job.get('display_name'), archived_at=job.get('archived_at'))
    result['possible_duplicate'] = (job.get('result') or {}).get('possible_duplicate')
    progress = dict(job.get('progress') or {})
    if job['status']=='completed':
        progress.update(stage='Completed',percent=100,eta_seconds=0,updated_at=job['updated_at'])
    elif job['status']=='failed':
        progress.update(stage='Failed',percent=progress.get('percent',0),eta_seconds=None,updated_at=job['updated_at'])
    elif job['status'] in ('pending','uploading'):
        progress = {'stage':'Queued' if job['status']=='pending' else 'Uploading',
                    'percent':0,'eta_seconds':None,'updated_at':job['updated_at']}
    elif not progress:
        progress = {'stage':'Processing','percent':0,'eta_seconds':None,'updated_at':job['updated_at']}
    result['progress'] = progress
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


class UploadIntent(BaseModel):
    display_name: str | None = Field(default=None,max_length=255)
    filename: str = Field(min_length=1,max_length=255)
    content_type: str = Field(default='application/octet-stream',max_length=100)
    size_bytes: int = Field(gt=0,strict=True)

    @field_validator('display_name')
    @classmethod
    def valid_display_name(cls,value):
        if value is None:
            return value
        if not value.strip() or any(unicodedata.category(c)=='Cc' for c in value):
            raise ValueError('Name must not be blank or contain control characters')
        return value.strip()

    @field_validator('filename')
    @classmethod
    def valid_filename(cls,value):
        if not value.strip() or any(ord(c)<32 for c in value):
            raise ValueError('Filename must not be blank or contain control characters')
        return value

    @field_validator('content_type')
    @classmethod
    def valid_type(cls,value):
        import re
        if value!='application/octet-stream' and not re.fullmatch(r'video/[A-Za-z0-9.+-]+',value):
            raise ValueError('Expected a video content type')
        return value


@router.post('/videos/uploads',status_code=201)
def create_upload(body: UploadIntent, settings: Settings = Depends(settings_dependency),
                  store: Store = Depends(store_dependency), cloud: Cloud = Depends(cloud_dependency)):
    if body.size_bytes > settings.max_upload_mb*1024*1024:
        raise HTTPException(413,'Video exceeds upload size limit')
    job=store.create(body.filename,body.content_type,body.size_bytes,display_name=body.display_name)
    try:
        upload=cloud.direct_upload(job,body.size_bytes)
    except CLOUD_ERRORS as exc:
        store.upload_failed(job['id'],'Could not prepare direct upload; submit again')
        raise HTTPException(503,'Could not prepare direct upload') from exc
    return {'request':present(job,cloud),'upload':upload}


@router.post('/videos/{request_id}/complete',status_code=202)
def complete_upload(request_id: str, settings: Settings = Depends(settings_dependency),
                    store: Store = Depends(store_dependency), cloud: Cloud = Depends(cloud_dependency)):
    job=store.get(request_id)
    if job is None:
        raise HTTPException(404,'Upload request not found')
    if job['uploaded']:
        return present(job,cloud)  # Confirmation retry never initiates a new job.
    if job['status']!='uploading' or job['expected_size'] is None:
        raise HTTPException(409,'This request cannot be completed; start a new upload')
    try:
        metadata=cloud.upload_metadata(job)
    except ClientError as exc:
        if str(exc.response.get('Error',{}).get('Code')) in ('404','NoSuchKey','NotFound'):
            raise HTTPException(409,'Video has not reached S3 yet; retry confirmation') from exc
        raise HTTPException(502,'Could not verify S3 upload; retry confirmation') from exc
    except CLOUD_ERRORS as exc:
        raise HTTPException(502,'Could not verify S3 upload; retry confirmation') from exc
    if metadata.get('ContentLength')!=job['expected_size'] or metadata.get('ContentLength',0)>settings.max_upload_mb*1024*1024:
        store.upload_failed(job['id'],'Stored video size does not match upload request')
        raise HTTPException(422,'Stored video size does not match upload request')
    if metadata.get('ContentType')!=job['content_type']:
        store.upload_failed(job['id'],'Stored video content type does not match upload request')
        raise HTTPException(422,'Stored video content type does not match upload request')
    if store.uploaded(job['id']):
        try:
            cloud.publish(job['id'])
            store.published(job['id'])
        except CLOUD_ERRORS:
            log.warning('Queue send deferred for %s',job['id'])
    latest=store.get(job['id'])
    if not latest['uploaded']:
        raise HTTPException(409,'Upload expired; start a new upload')
    return present(latest,cloud)


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
            include_archived: bool = False,
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
    return {'items': [present(job, cloud) for job in store.list(limit, offset, normalized, include_archived=include_archived)],
            'limit': limit, 'offset': offset}


@router.post('/videos/{request_id}/archive')
def archive_video(request_id: str, store: Store = Depends(store_dependency), cloud: Cloud = Depends(read_cloud_dependency)):
    if not store.archive(request_id):
        raise HTTPException(404,'Request not found')
    return present(store.get(request_id),cloud)


@router.post('/videos/{request_id}/restore')
def restore_video(request_id: str, store: Store = Depends(store_dependency), cloud: Cloud = Depends(read_cloud_dependency)):
    if not store.restore(request_id):
        raise HTTPException(404,'Request not found')
    return present(store.get(request_id),cloud)


@router.get('/videos/{request_id}')
def status(request_id: str, store: Store = Depends(store_dependency), cloud: Cloud = Depends(read_cloud_dependency)):
    job = store.get(request_id)
    if job is None:
        raise HTTPException(404, 'Request not found')
    return present(job, cloud)
