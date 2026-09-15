from urllib.parse import parse_qs, urlsplit

import boto3

from app.cloud import Cloud
from app.config import Settings


def test_video_url_signs_regional_host_without_redirect(monkeypatch):
    session = boto3.Session(aws_access_key_id='testing', aws_secret_access_key='testing',
                            region_name='ap-south-1')
    monkeypatch.setattr('app.cloud.boto3.Session', lambda **kwargs: session)
    cloud = Cloud(Settings(aws_usage_enabled=True, s3_bucket='example-video-bucket',
                           sqs_queue_url='https://sqs.ap-south-1.amazonaws.com/123/test'))
    url, _ = cloud.url({'object_key': 'videos/example.mp4'})
    parsed = urlsplit(url)
    assert parsed.hostname == 'example-video-bucket.s3.ap-south-1.amazonaws.com'
    query = parse_qs(parsed.query)
    assert query['X-Amz-Expires'] == ['86400']
    assert query['response-content-disposition'] == ['inline']
