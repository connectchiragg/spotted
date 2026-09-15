from app.duplicates import possible_duplicate
from app.store import Store
from test_retrieval import FakeEmbedder, completed_job


def test_similar_descriptions_flag_without_deleting_or_merging(tmp_path):
    store = Store(str(tmp_path / 'jobs.db'))
    first = completed_job(store, 'A cat on a ledge')
    second = completed_job(store, 'A cat on a ledge')
    found = possible_duplicate(store, FakeEmbedder(), second)
    assert found['request_id'] == first['id']
    assert found['similarity'] == 1
    assert len(store.completed()) == 2
    assert store.get(first['id'])['status'] == 'completed'
    assert store.get(second['id'])['status'] == 'completed'


def test_below_threshold_and_self_are_not_duplicates(tmp_path):
    store = Store(str(tmp_path / 'jobs.db'))
    first = completed_job(store, 'A cat on a ledge')
    embedder = FakeEmbedder()
    assert possible_duplicate(store, embedder, first) is None
    second = completed_job(store, 'A car drives down a street')
    # Both mean vectors include the shared "empty room" frame; still unrelated.
    embedder = FakeEmbedder({'A cat on a ledge': [1, 0],
                            'A car drives down a street': [0, 1],
                            'An empty room': [0, 0]}, model='distinct')
    assert possible_duplicate(store, embedder, second) is None
    assert len(store.completed()) == 2


def test_cached_description_vectors_avoid_repeat_inference(tmp_path):
    store = Store(str(tmp_path / 'jobs.db'))
    completed_job(store, 'First description')
    second = completed_job(store, 'Second description')
    embedder = FakeEmbedder()
    possible_duplicate(store, embedder, second)
    count = len(embedder.passage_calls)
    possible_duplicate(store, embedder, second)
    assert len(embedder.passage_calls) == count
