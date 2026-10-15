"""Create assessment-only private resources; write their names to local .env."""
import json
from pathlib import Path

import boto3
from botocore.config import Config
from dotenv import load_dotenv, set_key
import os


def configure_cors(s3, bucket):
    try:
        rules = s3.get_bucket_cors(Bucket=bucket)['CORSRules']
    except s3.exceptions.ClientError as exc:
        if exc.response['Error']['Code'] != 'NoSuchCORSConfiguration':
            raise
        rules = []
    rule = {
        'ID': 'spotted-local-ui',
        'AllowedOrigins': ['http://127.0.0.1:8000', 'http://localhost:8000', 'https://irl.haciensus.com'],
        'AllowedMethods': ['PUT', 'GET', 'HEAD'],
        'AllowedHeaders': ['content-type', 'content-length', 'if-none-match',
                           'x-amz-server-side-encryption', 'range'],
        'ExposeHeaders': ['ETag'], 'MaxAgeSeconds': 600,
    }
    # Preserve unrelated bucket rules when this setup is rerun.
    rules = [existing for existing in rules if existing.get('ID') != rule['ID']]
    s3.put_bucket_cors(Bucket=bucket, CORSConfiguration={'CORSRules': rules + [rule]})


def main():
    load_dotenv()
    if os.getenv('AWS_USAGE_ENABLED', 'false').lower() != 'true':
        raise SystemExit('AWS creation paused: verify free-tier eligibility before enabling AWS_USAGE_ENABLED')
    region = 'ap-south-1'
    session = boto3.Session(profile_name='default', region_name=region)
    config = Config(connect_timeout=5, read_timeout=20, retries={'max_attempts': 1})
    identity = session.client('sts', config=config).get_caller_identity()
    account = identity['Account']
    bucket = f'spotted-{account}-{region}-98e3'
    queue_name = 'spotted-video-ingestion-98e3'
    s3, sqs = session.client('s3', config=config), session.client('sqs', config=config)
    try:
        s3.create_bucket(Bucket=bucket, CreateBucketConfiguration={'LocationConstraint': region},
                         ObjectOwnership='BucketOwnerEnforced')
    except s3.exceptions.BucketAlreadyOwnedByYou:
        pass
    s3.put_public_access_block(Bucket=bucket, PublicAccessBlockConfiguration={
        'BlockPublicAcls': True, 'IgnorePublicAcls': True,
        'BlockPublicPolicy': True, 'RestrictPublicBuckets': True})
    s3.put_bucket_encryption(Bucket=bucket, ServerSideEncryptionConfiguration={
        'Rules': [{'ApplyServerSideEncryptionByDefault': {'SSEAlgorithm': 'AES256'}}]})
    s3.put_bucket_tagging(Bucket=bucket, Tagging={'TagSet': [{'Key': 'Project', 'Value': 'spotted-assessment'}]})
    configure_cors(s3, bucket)
    queue_url = sqs.create_queue(QueueName=queue_name, Attributes={
        'VisibilityTimeout': '600', 'ReceiveMessageWaitTimeSeconds': '10',
        'MessageRetentionPeriod': '345600', 'SqsManagedSseEnabled': 'true'},
        tags={'Project': 'spotted-assessment'})['QueueUrl']
    env = Path('.env')
    for key, value in {'AWS_PROFILE':'default','AWS_REGION':region,'S3_BUCKET':bucket,'SQS_QUEUE_URL':queue_url}.items():
        set_key(env, key, value)
    print(json.dumps({'account':account,'region':region,'bucket':bucket,'queue_url':queue_url}))


if __name__ == '__main__':
    main()
