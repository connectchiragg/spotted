"""Deterministic retrieval checks; no embedding downloads or model requests."""
import json
import math

from app.retrieval import citation, document, hybrid_search, index_jobs, tokens, normalize_query
from app.store import Store


class FakeEmbedder:
    def __init__(self, vectors=None, model='test-model'):
        self.model = model
        self.vectors = vectors or {}
        self.passage_calls = []

    def passages(self, texts):
        self.passage_calls.append(list(texts))
        return [self.vectors.get(text, [1.0, 0.0]) for text in texts]

    def query(self, text):
        return [1.0, 0.0]


def result(summary, label='cleaning'):
    return {'summary': summary, 'sampled_timestamps': [1.5, 4.5],
            'frame_descriptions':[{'frame_index':0,'description':'An empty room'},
                                  {'frame_index':1,'description':summary}],
            'tags': [{'label': label, 'category': 'action', 'frame_indices': [1]}]}


def completed_job(store, summary, label='cleaning'):
    job = store.create('sample.mp4', 'video/mp4')
    store.uploaded(job['id'])
    token = store.claim(job['id'], 60)
    assert store.finish(job['id'], token, result(summary, label))
    return store.get(job['id'])


def test_semantic_top_three_are_selected_before_keyword_reranking(tmp_path):
    store = Store(str(tmp_path / 'jobs.db'))
    jobs = [completed_job(store, 'first', 'unrelated'),
            completed_job(store, 'second', 'cooking'),
            completed_job(store, 'third', 'unrelated'),
            completed_job(store, 'fourth', 'cooking')]
    similarities = [.95, .85, .80, .79]
    embedder = FakeEmbedder({document(job): [score, math.sqrt(1-score**2)]
                             for job, score in zip(jobs, similarities)})

    found = hybrid_search(store, embedder, 'cooking')

    # Fourth item would outrank some results after keyword weighting, but must
    # remain excluded because semantic candidate generation happens first.
    # The third candidate is pruned as substantially weaker after reranking.
    assert [job['id'] for job, _ in found] == [jobs[1]['id'], jobs[0]['id']]
    assert found[0][1]['semantic_score'] == .85
    assert found[0][1]['keyword_score'] == 1.0
    assert found[0][1]['score'] == .8875


def test_cached_vectors_survive_store_reopening_without_reembedding(tmp_path):
    path = str(tmp_path / 'jobs.db')
    store = Store(path)
    completed_job(store, 'A worker cleans a grill')
    first = FakeEmbedder()
    hybrid_search(store, first, 'grill')
    assert len(first.passage_calls) == 2

    reopened = Store(path)
    fresh_embedder = FakeEmbedder()
    hybrid_search(reopened, fresh_embedder, 'cleaning')
    assert fresh_embedder.passage_calls == []


def test_changed_content_and_changed_model_reindex(tmp_path):
    store = Store(str(tmp_path / 'jobs.db'))
    changed = completed_job(store, 'Original description')
    unchanged = completed_job(store, 'Unchanged description')
    embedder = FakeEmbedder()
    index_jobs(store, embedder, store.completed())
    with store.connect() as db:
        db.execute('UPDATE jobs SET result=? WHERE id=?',
                   (json.dumps(result('Revised description')), changed['id']))

    index_jobs(store, embedder, store.completed())
    assert len(embedder.passage_calls) == 2
    assert embedder.passage_calls[1] == [document(store.get(changed['id']))]

    other_model = FakeEmbedder(model='another-model')
    index_jobs(store, other_model, store.completed())
    assert set(other_model.passage_calls[0]) == {
        document(store.get(changed['id'])), document(unchanged)}
    assert len(store.embeddings('test-model')) == 2
    assert len(store.embeddings('another-model')) == 2


def test_citation_prefers_query_match_and_skips_invalid_indices():
    job = {'id': 'example', 'result': result('Cleaning')}
    job['result']['tags'] = [
        {'label': 'sink', 'category': 'object', 'frame_indices': [0]},
        {'label': 'scrubbing', 'category': 'action', 'frame_indices': [-1, 9, '1', 1]},
    ]
    found = citation(job, tokens('scrubbing'))
    assert found['label'] == 'scrubbing'
    assert found['frame_index'] == 1
    assert found['timestamp_seconds'] == 4.5
    assert found['image_url'] == '/videos/example/frames/1'


def test_citation_falls_back_to_valid_other_tag_then_none():
    job = {'id': 'example', 'result': result('Cleaning')}
    job['result']['tags'] = [
        {'label': 'scrubbing', 'category': 'action', 'frame_indices': [-1, 99]},
        {'label': 'sink', 'category': 'object', 'frame_indices': [0]},
    ]
    assert citation(job, tokens('scrubbing'))['label'] == 'sink'
    job['result']['sampled_timestamps'] = []
    assert citation(job, tokens('scrubbing')) is None


def test_unrelated_results_and_missing_evidence_are_excluded(tmp_path):
    store = Store(str(tmp_path / 'jobs.db'))
    job = completed_job(store, 'A worker tidies pillows', 'pillow')
    embedder = FakeEmbedder({document(job):[.4, math.sqrt(1-.4**2)]})
    assert hybrid_search(store,embedder,'driving a car') == []
    # A relevant video description alone cannot establish a supporting moment.
    embedder = FakeEmbedder(model='no-evidence')
    with store.connect() as db:
        body = job['result']; body['frame_descriptions'] = []
        body['tags'][0]['frame_indices'] = []
        db.execute('UPDATE jobs SET result=? WHERE id=?',(json.dumps(body),job['id']))
    assert hybrid_search(store,embedder,'pillow') == []


def test_query_selects_action_frame_instead_of_first_object_presence(tmp_path):
    store = Store(str(tmp_path / 'jobs.db'))
    job = completed_job(store,'A person arranges pillows','pillow')
    body = job['result']
    body['frame_descriptions'] = [
        {'frame_index':0,'description':'Pillows lie on an empty bed'},
        {'frame_index':1,'description':'A person straightens and arranges pillows'}]
    with store.connect() as db:
        db.execute('UPDATE jobs SET result=? WHERE id=?',(json.dumps(body),job['id']))
    embedder = FakeEmbedder({'Pillows lie on an empty bed':[.65, math.sqrt(1-.65**2)],
                            'A person straightens and arranges pillows':[.95, math.sqrt(1-.95**2)]})
    found = hybrid_search(store,embedder,'tidy up pillow')
    assert len(found) == 1
    assert found[0][1]['citation']['timestamp_seconds'] == 4.5
    assert found[0][1]['citation']['description'] == 'A person straightens and arranges pillows'
    # The frame index is persistent and unchanged queries do not reembed it.
    calls = len(embedder.passage_calls)
    hybrid_search(store,embedder,'tidy up pillow')
    assert len(embedder.passage_calls) == calls


def test_explicit_grill_evidence_survives_semantic_cutoff(tmp_path):
    store=Store(str(tmp_path/'jobs.db'))
    grill=completed_job(store,'A metal grill grate in a sink','grill grate')
    pillow=completed_job(store,'Pillows on a bed','pillow')
    near=[.593,math.sqrt(1-.593**2)]
    embedder=FakeEmbedder({document(grill):near,'A metal grill grate in a sink':near,
                          document(pillow):near,'Pillows on a bed':near,'An empty room':near})
    found=hybrid_search(store,embedder,'grill')
    assert [job['id'] for job,_ in found]==[grill['id']]
    assert found[0][1]['frame_score']==.593
    assert 'grill' in found[0][1]['citation']['description']
    # Whole-token match does not turn into substring or partial-query matching.
    assert hybrid_search(store,embedder,'grilled')==[]
    assert hybrid_search(store,embedder,'dog grill')==[]


def test_conversational_wrapper_and_plural_tokens():
    assert normalize_query('I want to see a construction worker in action') == 'a construction worker'
    assert normalize_query('Can you show me workers sorting cocoons?') == 'workers sorting cocoons?'
    assert tokens('pillows') == tokens('pillow')
    assert tokens('grilled') != tokens('grill')


def test_joint_evidence_accepts_strong_frame_with_borderline_video(tmp_path):
    store = Store(str(tmp_path / 'joint.db'))
    job = completed_job(store, 'A worker mixes building material', 'mixing')
    vector = lambda score: [score, math.sqrt(1-score**2)]
    embedder = FakeEmbedder({document(job): vector(.59),
                            'A worker mixes building material': vector(.68),
                            'An empty room': vector(.2)})
    found = hybrid_search(store, embedder, 'construction worker')
    assert [item[0]['id'] for item in found] == [job['id']]
    assert found[0][1]['citation']['frame_index'] == 1


def test_high_video_score_cannot_rescue_unsupported_frame(tmp_path):
    store = Store(str(tmp_path / 'unsupported.db'))
    job = completed_job(store, 'A worker mixes material', 'mixing')
    vector = lambda score: [score, math.sqrt(1-score**2)]
    embedder = FakeEmbedder({document(job): vector(.9),
                            'A worker mixes material': vector(.4),
                            'An empty room': vector(.2)})
    assert hybrid_search(store, embedder, 'construction') == []


def test_tagged_object_is_found_when_caption_omits_it(tmp_path):
    store = Store(str(tmp_path / 'objects.db'))
    job = completed_job(store, 'A cat looks out of a window', 'pillow')
    unrelated = completed_job(store, 'Workers sort cocoons', 'cocoon')
    weak = [.2, math.sqrt(1-.2**2)]
    embedder = FakeEmbedder({document(job): weak, document(unrelated): weak,
                            'A cat looks out of a window': weak,
                            'Workers sort cocoons': weak, 'An empty room': weak})
    found = hybrid_search(store, embedder, 'I want to see pillow')
    assert [item[0]['id'] for item in found] == [job['id']]
    assert found[0][1]['citation']['frame_index'] == 1
    assert found[0][1]['citation']['label'] == 'pillow'
    assert hybrid_search(store, embedder, 'washing pillow') == []


def test_tag_evidence_does_not_combine_different_frames():
    from app.retrieval import tagged_frame_citation
    job = {'id': 'example', 'result': result('Room')}
    job['result']['tags'] = [
        {'label': 'pillow', 'frame_indices': [0]},
        {'label': 'washing', 'frame_indices': [1]},
        {'label': 'dog', 'frame_indices': [-1, 99, '0', True]},
    ]
    assert tagged_frame_citation(job, tokens('washing pillow')) is None
    assert tagged_frame_citation(job, tokens('dog')) is None
