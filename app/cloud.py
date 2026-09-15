import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import boto3
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError

from app.config import Settings

CLOUD_ERRORS = (BotoCoreError, ClientError)


class Cloud:
    def __init__(self, settings: Settings):
        if not settings.aws_usage_enabled:
            raise RuntimeError('AWS usage is disabled until free-tier eligibility is verified')
        if not settings.s3_bucket or not settings.sqs_queue_url:
            raise RuntimeError('Configure S3_BUCKET and SQS_QUEUE_URL before using queued ingestion')
        self.settings = settings
        session = boto3.Session(profile_name=settings.aws_profile, region_name=settings.aws_region)
        config = Config(signature_version='s3v4', s3={'addressing_style': 'virtual'},
                        connect_timeout=5, read_timeout=30,
                        retries={'max_attempts': 1})
        # Sign the regional hostname directly: S3 redirects invalidate a signed Host.
        self.s3 = session.client('s3', config=config,
                                 endpoint_url=f'https://s3.{settings.aws_region}.amazonaws.com')
        self.sqs = session.client('sqs', config=Config(connect_timeout=5, read_timeout=30,
                                                    retries={'max_attempts': 1}))

    def upload(self, path: Path, job: dict):
        with path.open('rb') as source:
            self.s3.put_object(Bucket=self.settings.s3_bucket, Key=job['object_key'], Body=source,
                               ContentType=job['content_type'], ServerSideEncryption='AES256')

    def download(self, job: dict, path: Path):
        self.s3.download_file(self.settings.s3_bucket, job['object_key'], str(path))

    def publish(self, request_id: str):
        self.sqs.send_message(QueueUrl=self.settings.sqs_queue_url,
                              MessageBody=json.dumps({'request_id': request_id}))

    def receive(self):
        return self.sqs.receive_message(QueueUrl=self.settings.sqs_queue_url, MaxNumberOfMessages=1,
            WaitTimeSeconds=10, VisibilityTimeout=self.settings.lease_seconds).get('Messages', [])

    def acknowledge(self, receipt: str):
        self.sqs.delete_message(QueueUrl=self.settings.sqs_queue_url, ReceiptHandle=receipt)

    def url(self, job: dict):
        url = self.s3.generate_presigned_url('get_object', Params={
            'Bucket': self.settings.s3_bucket, 'Key': job['object_key'],
            'ResponseContentDisposition': 'inline',
        }, ExpiresIn=86400)
        return url, (datetime.now(timezone.utc) + timedelta(days=1)).isoformat()


def publish_pending(store, cloud):
    for item in store.unpublished():
        cloud.publish(item['id'])
        store.published(item['id'], item['attempts'])
