import json
import subprocess
import time
from concurrent.futures import ThreadPoolExecutor

import pytest
from botocore.exceptions import EndpointConnectionError
from fastapi.testclient import TestClient

from app.cloud import publish_pending
from app.config import Settings
from app.jobs_api import cloud_dependency, read_cloud_dependency, settings_dependency, store_dependency
from app.main import app
from app.models import Tag, TaggingResult
from app.store import Store
from app.tagger import TaggerError
from app.worker import process_message


class FakeCloud:
    def __init__(self):
        self.objects = {}
        self.messages = []
        self.deleted = []
        self.fail_publish = False
        self.fail_upload = False

    def upload(self, path, job):
        if self.fail_upload:
            raise EndpointConnectionError(endpoint_url='https://s3.invalid')
        self.objects[job['object_key']] = path.read_bytes()

    def download(self, job, path):
        path.write_bytes(self.objects[job['object_key']])

    def publish(self, request_id):
        if self.fail_publish:
            raise EndpointConnectionError(endpoint_url='https://sqs.invalid')
        self.messages.append({'Body': json.dumps({'request_id': request_id}), 'ReceiptHandle': request_id})

    def acknowledge(self, receipt):
        self.deleted.append(receipt)

    def url(self, job):
        return f"https://example.test/{job['id']}?X-Amz-Expires=86400", '2026-09-16T00:00:00+00:00'


class TestTagger:
    __test__ = False
    model = 'fake-test-model'
    calls = 0

    def tag_frames(self, frames):
        self.calls += 1
        assert frames[0].data.startswith(b'\xff\xd8')
        return TaggingResult(summary='Red test image', tags=[Tag(label='red',category='object',frame_indices=[0])])


@pytest.fixture
def setup(tmp_path):
    settings = Settings(api_key='fake',database_path=str(tmp_path/'jobs.db'),max_frames=2)
    store,cloud = Store(settings.database_path),FakeCloud()
    app.dependency_overrides[settings_dependency] = lambda: settings
    app.dependency_overrides[store_dependency] = lambda: store
    app.dependency_overrides[cloud_dependency] = lambda: cloud
    app.dependency_overrides[read_cloud_dependency] = lambda: cloud
    path = tmp_path/'clip.mp4'
    subprocess.run(['ffmpeg','-v','error','-f','lavfi','-i','color=c=red:s=64x64:d=1',
                    '-c:v','mpeg4',str(path)],check=True)
    with TestClient(app) as client:
        yield client,store,cloud,settings,path.read_bytes()
    app.dependency_overrides.clear()


def upload(setup, data=None):
    client,_,_,_,video=setup
    return client.post('/videos',files={'file':('sample.mp4',video if data is None else data,'video/mp4')})


def test_upload_worker_status_history_and_duplicate(setup):
    client,store,cloud,settings,_=setup
    response=upload(setup)
    assert response.status_code==202,response.text
    job=response.json()
    assert job['status']=='pending' and '86400' in job['download_url']
    assert job['result'] is None
    tagger=TestTagger()
    message=cloud.messages[0]
    process_message(message,store,cloud,tagger,settings)
    process_message(message,store,cloud,tagger,settings)
    done=client.get('/videos/'+job['id']).json()
    assert done['status']=='completed'
    assert done['result']['tags'][0]['label']=='red'
    assert done['attempts']==1 and tagger.calls==1
    assert client.get('/videos').json()['items'][0]['id']==job['id']
    assert Store(settings.database_path).get(job['id'])['status']=='completed'


def test_enqueue_outage_recovered_from_database(setup):
    _,store,cloud,_,_=setup
    cloud.fail_publish=True
    response=upload(setup)
    assert response.status_code==202
    assert len(store.unpublished())==1
    cloud.fail_publish=False
    publish_pending(store,cloud)
    assert len(cloud.messages)==1 and store.unpublished()==[]


def test_s3_failure_visible_in_history(setup):
    client,_,cloud,_,_=setup
    cloud.fail_upload=True
    assert upload(setup).status_code==502
    job=client.get('/videos').json()['items'][0]
    assert job['status']=='failed' and job['download_url'] is None


def test_corrupt_video_fails_worker_with_preview_link(setup):
    client,store,cloud,settings,_=setup
    job=upload(setup,b'not video').json()
    process_message(cloud.messages[0],store,cloud,TestTagger(),settings)
    failed=client.get('/videos/'+job['id']).json()
    assert failed['status']=='failed' and failed['error']
    assert failed['download_url']
    assert cloud.deleted


def test_atomic_claim_and_stale_completion(setup):
    _,store,_,settings,_=setup
    job=upload(setup).json()
    with ThreadPoolExecutor(2) as pool:
        claims=list(pool.map(lambda _:store.claim(job['id'],600),range(2)))
    assert sum(c is not None for c in claims)==1
    old_token=next(c for c in claims if c)
    with store.connect() as db:
        db.execute('UPDATE jobs SET lease_until=? WHERE id=?',(time.time()-1,job['id']))
    new_token=store.claim(job['id'],600)
    assert new_token and not store.finish(job['id'],old_token,{'summary':'stale'})
    assert store.finish(job['id'],new_token,{'summary':'current'})


def test_transient_retry_stops_after_three_attempts(setup):
    _,store,cloud,settings,_=setup
    job=upload(setup).json()
    class TimeoutTagger:
        def tag_frames(self,frames):
            raise TaggerError('Gemini request timed out',504)
    for attempt in range(3):
        process_message(cloud.messages[-1],store,cloud,TimeoutTagger(),settings)
        if attempt<2:
            assert store.get(job['id'])['status']=='pending'
            publish_pending(store,cloud)
    assert store.get(job['id'])['status']=='failed'
    assert store.get(job['id'])['attempts']==3


def test_delayed_publish_cannot_hide_new_retry(setup):
    _,store,_,_,_=setup
    job=upload(setup).json()
    token=store.claim(job['id'],600)
    store.processing_failed(job['id'],token,'retry',True)
    store.published(job['id'],attempts=0)
    assert len(store.unpublished())==1


def test_unknown_status_and_input_limits(setup):
    client,_,_,_,_=setup
    assert client.get('/videos/no-such-id').status_code==404
    assert client.get('/videos?limit=101').status_code==422
    assert upload(setup,b'').status_code==422


def seed_result(store, filename, labels):
    job=store.create(filename,'video/mp4')
    store.uploaded(job['id'])
    token=store.claim(job['id'],600)
    store.finish(job['id'],token,{'summary':'A kitchen in the summary only',
        'tags':[{'label':label,'category':'object','frame_indices':[0]} for label in labels]})
    return job['id']


def test_search_exact_or_normalized_and_deduplicated(setup):
    client,store,_,_,_=setup
    kitchen=seed_result(store,'a.mp4',['kitchen','sink'])
    bedroom=seed_result(store,'b.mp4',['bedroom'])
    seed_result(store,'c.mp4',['kitchenette'])
    store.create('pending.mp4','video/mp4')
    response=client.get('/videos',params=[('tags',' KITCHEN '),('tags','bedroom'),('tags','sink'),('tags','kitchen')])
    assert response.status_code==200,response.text
    items=response.json()['items']
    assert {i['id'] for i in items}=={kitchen,bedroom} and len(items)==2
    assert all(i['status']=='completed' for i in items)
    assert len(client.get('/videos').json()['items'])==4


def test_search_no_substrings_wildcards_or_summary_match(setup):
    client,store,_,_,_=setup
    seed_result(store,'a.mp4',['grill grate'])
    for value in ['grill','kitchen','%',"' OR 1=1 --"]:
        assert client.get('/videos',params={'tags':value}).json()['items']==[]
    assert len(client.get('/videos',params={'tags':'  Grill   GRATE '}).json()['items'])==1


def test_search_paginates_matches_not_all_jobs(setup):
    client,store,_,_,_=setup
    first=seed_result(store,'first.mp4',['kitchen'])
    second=seed_result(store,'second.mp4',['kitchen'])
    seed_result(store,'other.mp4',['bedroom'])
    response=client.get('/videos',params={'tags':'kitchen','limit':1,'offset':1})
    assert [i['id'] for i in response.json()['items']]==[first]
    assert client.get('/videos',params={'tags':'kitchen','limit':1}).json()['items'][0]['id']==second


@pytest.mark.parametrize('tags', [[''],['   '],['x'*81],['kitchen']*21])
def test_search_rejects_invalid_tags(setup,tags):
    client,*_=setup
    assert client.get('/videos',params=[('tags',tag) for tag in tags]).status_code==422
