from app.store import Store
from app.jobs_api import present


def test_progress_token_guard_persistence_and_terminal_present(tmp_path):
    path=str(tmp_path/'progress.db'); store=Store(path)
    job=store.create('clip.mp4','video/mp4')
    assert present(job,None)['progress']['stage']=='Uploading'
    store.uploaded(job['id'])
    assert present(store.get(job['id']),None)['progress']['stage']=='Queued'
    token=store.claim(job['id'],600)
    assert not store.set_progress(job['id'],'stale','Extracting',20,5)
    assert store.set_progress(job['id'],token,'Extracting',20,5)
    saved=Store(path).get(job['id'])
    assert saved['progress']['percent']==20 and saved['progress']['eta_seconds']==5
    store.processing_failed(job['id'],token,'oops',False)
    progress=present(store.get(job['id']),None)['progress']
    assert progress['stage']=='Failed' and progress['percent']==20 and progress['eta_seconds'] is None
    assert not store.set_progress(job['id'],token,'Too late',99)


def test_completed_progress_is_100(tmp_path):
    store=Store(str(tmp_path/'done.db')); job=store.create('clip.mp4','video/mp4')
    store.uploaded(job['id']); token=store.claim(job['id'],600)
    store.set_progress(job['id'],token,'Saving',95)
    store.finish(job['id'],token,{'summary':'done','tags':[]})
    progress=present(store.get(job['id']),None)['progress']
    assert progress['stage']=='Completed' and progress['percent']==100 and progress['eta_seconds']==0
