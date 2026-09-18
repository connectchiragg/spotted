import pytest
from app.worker import tag_with_retry
from app.tagger import TaggerError

class Store:
    def set_progress(self,*args): pass

@pytest.mark.parametrize('error',[
    TaggerError('quota',503,retryable=False),
    TaggerError('credentials',503,retryable=False),
    TaggerError('malformed'),
])
def test_permanent_failure_not_retried(error):
    class Tagger:
        calls=0
        def tag_frames(self,frames):
            self.calls+=1
            raise error
    tagger=Tagger()
    with pytest.raises(TaggerError): tag_with_retry(tagger,[],Store(),'id','token',30)
    assert tagger.calls==1


def test_transient_retry_has_backoff_and_reuses_input(monkeypatch):
    delays=[];frames=[object()];seen=[]
    monkeypatch.setattr('app.worker.time.sleep',delays.append)
    class Tagger:
        def tag_frames(self,value):
            seen.append(value)
            if len(seen)==1: raise TaggerError('unavailable',503)
            return 'success'
    assert tag_with_retry(Tagger(),frames,Store(),'id','token',30)=='success'
    assert all(value is frames for value in seen)
    assert len(delays)==1 and 1<=delays[0]<=2
