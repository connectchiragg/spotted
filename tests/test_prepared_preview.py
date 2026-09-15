import pytest
from fastapi import HTTPException
from app.search_api import animated_citation
from app.cloud import Cloud
from app.config import Settings


class Store:
    def __init__(self,job): self.job=job
    def get(self,request_id): return self.job


class CloudFake:
    def __init__(self): self.calls=[]
    def preview_url(self,job,index):
        self.calls.append(index)
        return 'https://example.test/prepared.gif'
    def download(self,*args): raise AssertionError('Search must not download video')


def job():
    return {'id':'example','status':'completed','archived_at':None,
            'result':{'sampled_timestamps':[1,2],'preview_indices':[1]}}


def test_prepared_animation_redirects_without_processing():
    cloud=CloudFake()
    response=animated_citation('example',1,Store(job()),Settings(),cloud)
    assert response.status_code==307
    assert response.headers['location']=='https://example.test/prepared.gif'
    assert cloud.calls==[1]


@pytest.mark.parametrize('index',[-1,0,2])
def test_missing_or_invalid_animation_returns_404(index):
    cloud=CloudFake()
    with pytest.raises(HTTPException) as error:
        animated_citation('example',index,Store(job()),Settings(),cloud)
    assert error.value.status_code==404 and cloud.calls==[]


@pytest.mark.parametrize('state',['archived','pending','missing'])
def test_animation_rejects_unavailable_request(state):
    item=job()
    if state=='archived': item['archived_at']='today'
    if state=='pending': item['status']='pending'
    if state=='missing': item=None
    with pytest.raises(HTTPException) as error:
        animated_citation('example',1,Store(item),Settings(),CloudFake())
    assert error.value.status_code==404


def test_preview_upload_stays_in_video_prefix():
    class S3:
        def put_object(self,**kwargs): self.call=kwargs
    cloud=Cloud.__new__(Cloud);cloud.s3=S3();cloud.settings=Settings(s3_bucket='test-bucket')
    assert cloud.upload_preview({'id':'abc'},3,b'GIF89a')=='videos/abc/previews/3.gif'
    assert cloud.s3.call['ContentType']=='image/gif'
    assert cloud.s3.call['ServerSideEncryption']=='AES256'
    assert cloud.s3.call['Body']==b'GIF89a'


def test_prepared_still_redirects_without_video_download():
    from app.search_api import frame_citation
    class FrameCloud(CloudFake):
        def frame_url(self,job,index): return 'https://example.test/prepared.jpg'
    response=frame_citation('example',1,Store(job()),Settings(),FrameCloud())
    assert response.status_code==307
    assert response.headers['location']=='https://example.test/prepared.jpg'


def test_frame_upload_stays_in_video_prefix():
    class S3:
        def put_object(self,**kwargs): self.call=kwargs
    cloud=Cloud.__new__(Cloud);cloud.s3=S3();cloud.settings=Settings(s3_bucket='test-bucket')
    assert cloud.upload_frame({'id':'abc'},3,b'jpeg')=='videos/abc/frames/3.jpg'
    assert cloud.s3.call['ContentType']=='image/jpeg'
    assert cloud.s3.call['ServerSideEncryption']=='AES256'
