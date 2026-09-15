import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError
from app.jobs_api import UploadIntent,store_dependency,read_cloud_dependency
from app.main import app
from app.store import Store


def test_display_name_persistence_and_archive_restore(tmp_path):
    path=str(tmp_path/'archive.db'); store=Store(path)
    job=store.create('original.mp4','video/mp4',10,display_name='Kitchen demo')
    assert Store(path).get(job['id'])['display_name']=='Kitchen demo'
    store.uploaded(job['id']); token=store.claim(job['id'],600)
    assert store.archive(job['id'])
    first=store.get(job['id'])['archived_at']
    assert store.archive(job['id']) and store.get(job['id'])['archived_at']==first
    assert store.finish(job['id'],token,{'summary':'demo','tags':[{'label':'kitchen'}]})
    assert store.get(job['id'])['archived_at']==first
    assert store.completed()==[] and store.list(tags=['kitchen'])==[]
    assert store.list(tags=['kitchen'],include_archived=True)[0]['id']==job['id']
    assert store.restore(job['id']) and store.restore(job['id'])
    assert store.completed()[0]['id']==job['id']
    assert not store.archive('missing') and not store.restore('missing')


def test_archive_endpoints_and_history(tmp_path):
    store=Store(str(tmp_path/'api.db')); job=store.create('clip.mp4','video/mp4')
    app.dependency_overrides[store_dependency]=lambda:store
    app.dependency_overrides[read_cloud_dependency]=lambda:None
    try:
        with TestClient(app) as client:
            assert client.post('/videos/'+job['id']+'/archive').json()['archived_at']
            assert client.get('/videos').json()['items']==[]
            assert len(client.get('/videos?include_archived=true').json()['items'])==1
            assert client.post('/videos/'+job['id']+'/restore').json()['archived_at'] is None
            assert client.post('/videos/missing/archive').status_code==404
            assert client.post('/videos/missing/restore').status_code==404
    finally: app.dependency_overrides.clear()


@pytest.mark.parametrize('name',['','   ','bad\nname','bad\x7fname','bad\x85name','x'*256])
def test_invalid_display_name(name):
    with pytest.raises(ValidationError):
        UploadIntent(filename='clip.mp4',size_bytes=10,display_name=name)


def test_optional_display_name_trimmed():
    assert UploadIntent(filename='clip.mp4',size_bytes=10).display_name is None
    assert UploadIntent(filename='clip.mp4',size_bytes=10,display_name=' My clip ').display_name=='My clip'
