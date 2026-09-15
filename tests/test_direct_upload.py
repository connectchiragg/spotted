import pytest
from botocore.exceptions import ClientError
from test_jobs import setup


def prepare(setup):
    client,store,cloud,settings,video=setup
    cloud.direct_upload=lambda job,size:{'url':'https://s3.example/upload','method':'PUT','headers':{'Content-Type':job['content_type']},'expires_in':600}
    response=client.post('/videos/uploads',json={'filename':'video.mp4','content_type':'video/mp4','size_bytes':len(video)})
    return response


def test_direct_upload_verification_and_idempotent_completion(setup):
    client,store,cloud,_,video=setup
    response=prepare(setup)
    assert response.status_code==201
    job=response.json()['request']
    assert job['status']=='uploading' and job['download_url'] is None
    assert not cloud.objects and not cloud.messages
    cloud.upload_metadata=lambda job:{'ContentLength':len(video),'ContentType':'video/mp4'}
    response=client.post('/videos/'+job['id']+'/complete')
    assert response.status_code==202 and response.json()['status']=='pending'
    assert len(cloud.messages)==1
    assert client.post('/videos/'+job['id']+'/complete').status_code==202
    assert len(cloud.messages)==1


def test_missing_object_does_not_enqueue_and_confirmation_can_retry(setup):
    client,store,cloud,_,video=setup
    job=prepare(setup).json()['request']
    def missing(_):
        raise ClientError({'Error':{'Code':'404'}},'HeadObject')
    cloud.upload_metadata=missing
    assert client.post('/videos/'+job['id']+'/complete').status_code==409
    assert store.get(job['id'])['status']=='uploading' and not cloud.messages
    cloud.upload_metadata=lambda job:{'ContentLength':len(video),'ContentType':'video/mp4'}
    assert client.post('/videos/'+job['id']+'/complete').status_code==202


@pytest.mark.parametrize('size_delta,content_type',[(1,'video/mp4'),(0,'text/plain')])
def test_wrong_metadata_rejected_without_queue(setup,size_delta,content_type):
    client,store,cloud,_,video=setup
    job=prepare(setup).json()['request']
    cloud.upload_metadata=lambda job:{'ContentLength':len(video)+size_delta,'ContentType':content_type}
    assert client.post('/videos/'+job['id']+'/complete').status_code==422
    assert store.get(job['id'])['status']=='failed' and not cloud.messages


def test_direct_upload_outbox_recovery(setup):
    from app.cloud import publish_pending
    client,store,cloud,_,video=setup
    job=prepare(setup).json()['request']
    cloud.upload_metadata=lambda job:{'ContentLength':len(video),'ContentType':'video/mp4'}
    cloud.fail_publish=True
    assert client.post('/videos/'+job['id']+'/complete').status_code==202
    assert store.unpublished()[0]['id']==job['id']
    cloud.fail_publish=False
    publish_pending(store,cloud)
    assert len(cloud.messages)==1


def test_intent_limits_and_unknown_request(setup):
    client,store,cloud,settings,video=setup
    maximum=settings.max_upload_mb*1024*1024
    for size in [0,-1,'10',True,maximum+1]:
        r=client.post('/videos/uploads',json={'filename':'video.mp4','size_bytes':size})
        assert r.status_code in (413,422)
    prepare(setup)
    assert client.post('/videos/uploads',json={'filename':'maximum.mp4','size_bytes':maximum}).status_code==201
    assert client.post('/videos/unknown/complete').status_code==404
