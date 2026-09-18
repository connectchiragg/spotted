from concurrent.futures import Future, ThreadPoolExecutor
from threading import Barrier, Lock
import json
import time

from app import worker
from app.config import Settings
from app.media import Frame
from app.models import TaggingResult
from app.store import Store


def test_dispatch_does_not_receive_when_all_slots_busy():
    class Cloud:
        calls=0
        def receive(self):
            self.calls+=1
            return [{'Body':'test'}]
    class Executor:
        calls=0
        def submit(self,process,message):
            self.calls+=1
            return Future()
    cloud,executor=Cloud(),Executor(); active={Future(),Future()}
    assert not worker.dispatch_available(cloud,executor,active,lambda _:None)
    assert cloud.calls==0 and executor.calls==0
    next(iter(active)).set_result(None)
    assert worker.dispatch_available(cloud,executor,active,lambda _:None)
    assert len(active)==2 and cloud.calls==1


def test_two_jobs_overlap_tagging_but_decoder_and_uploads_are_bounded(tmp_path,monkeypatch):
    store=Store(str(tmp_path/'jobs.db'))
    jobs=[store.create(str(i)+'.mp4','video/mp4') for i in range(2)]
    for job in jobs: store.uploaded(job['id'])
    lock=Lock(); counts={'decoder':0,'max_decoder':0,'tags':0,'max_tags':0,'embedding':0,'max_embedding':0}
    uploads={job['id']:0 for job in jobs}; max_uploads=dict(uploads)
    tagging_barrier=Barrier(2)
    def extract(*args):
        with lock:
            counts['decoder']+=1;counts['max_decoder']=max(counts['max_decoder'],counts['decoder'])
        time.sleep(.03)
        with lock: counts['decoder']-=1
        return 10,[Frame(float(i),b'jpeg') for i in range(6)]
    monkeypatch.setattr(worker,'extract_frames',extract)
    class Cloud:
        def download(self,job,path): path.write_bytes(b'video')
        def upload_frame(self,job,index,data):
            with lock:
                uploads[job['id']]+=1;max_uploads[job['id']]=max(max_uploads[job['id']],uploads[job['id']])
            time.sleep(.04)
            with lock: uploads[job['id']]-=1
        def acknowledge(self,receipt): pass
    class Tagger:
        model='test'
        def tag_frames(self,frames):
            with lock:
                counts['tags']+=1;counts['max_tags']=max(counts['max_tags'],counts['tags'])
            tagging_barrier.wait(timeout=3)
            with lock: counts['tags']-=1
            return TaggingResult(summary='test',tags=[])
    def duplicate_detector(job):
        with lock:
            counts['embedding']+=1
            counts['max_embedding']=max(counts['max_embedding'],counts['embedding'])
        time.sleep(.04)
        with lock: counts['embedding']-=1
        return None
    settings=Settings()
    with ThreadPoolExecutor(max_workers=2) as executor:
        futures=[executor.submit(worker.process_message,
            {'Body':json.dumps({'request_id':job['id']}),'ReceiptHandle':job['id']},
            store,Cloud(),Tagger(),settings,duplicate_detector) for job in jobs]
        for future in futures: future.result(timeout=5)
    assert counts['max_decoder']==1 and counts['max_tags']==2
    assert counts['max_embedding']==1
    assert all(1 < peak <= 3 for peak in max_uploads.values())
    assert all(store.get(job['id'])['status']=='completed' for job in jobs)
