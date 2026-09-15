from types import SimpleNamespace
from unittest.mock import Mock

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.config import Settings
from app.jobs_api import read_cloud_dependency, settings_dependency, store_dependency
from app.query_api import answerer_dependency, router
from app.search_api import embedder_dependency


@pytest.fixture
def setup(monkeypatch):
    app = FastAPI()
    app.include_router(router)
    answerer = Mock()
    answerer.answer.return_value = {'answer': 'A person adjusts a pillow [1].', 'citations': [1]}
    search = Mock(return_value=[])
    monkeypatch.setattr('app.query_api.hybrid_search', search)
    app.dependency_overrides.update({store_dependency: lambda: object(),
        read_cloud_dependency: lambda: None, settings_dependency: lambda: Settings(api_key='unused'),
        embedder_dependency: lambda: SimpleNamespace(model='fake'), answerer_dependency: lambda: answerer})
    with TestClient(app) as client:
        yield client, search, answerer


def match():
    return ({'id': 'one', 'filename': 'clip.mp4', 'status': 'completed', 'created_at': 'now',
             'updated_at': 'now', 'error': None, 'attempts': 1, 'uploaded': False,
             'result': {'summary': 'Tidying a bed', 'tags': [{'label': 'pillow'}]}},
            {'score': .8, 'citation': {'description': 'A person adjusts a pillow.',
                                    'timestamp_seconds': 9.3}})


def test_no_matches_skips_generation(setup):
    client, _, answerer = setup
    response = client.post('/query', json={'q': '  pillow  '})
    assert response.status_code == 200
    assert response.json()['query'] == 'pillow'
    assert response.json()['items'] == []
    assert response.json()['answer_source'] == 'retrieval'
    answerer.answer.assert_not_called()


def test_grounded_answer_preserves_items_and_passes_only_evidence(setup):
    client, search, answerer = setup
    search.return_value = [match()]
    response = client.post('/query', json={'q': 'tidy pillow'})
    body = response.json()
    assert response.status_code == 200
    assert body['answer_source'] == 'gemini'
    assert body['answer'] == 'A person adjusts a pillow [1].'
    assert body['items'][0]['retrieval']['citation']['timestamp_seconds'] == 9.3
    candidate = answerer.answer.call_args.args[1][0]
    assert candidate['number'] == 1
    assert candidate['tags'] == ['pillow']
    assert 'download_url' not in candidate


def test_timeout_returns_matches_with_safe_warning(setup):
    client, search, answerer = setup
    search.return_value = [match()]
    answerer.answer.side_effect = httpx.ReadTimeout('sensitive provider request')
    response = client.post('/query', json={'q': 'pillow'})
    assert response.status_code == 200
    body = response.json()
    assert len(body['items']) == 1
    assert body['answer_source'] == 'retrieval'
    assert body['answer_warning']
    assert 'sensitive' not in response.text


@pytest.mark.parametrize('answer,citations', [('Claim [2]', [2]), ('Claim [1]', [2]),
    ('Claim without evidence', [1]), ('Claim [1] and [bogus]', [1]), ('Claim [1]', [True])])
def test_invalid_references_fall_back(setup, answer, citations):
    client, search, answerer = setup
    search.return_value = [match()]
    answerer.answer.return_value = {'answer': answer, 'citations': citations}
    response = client.post('/query', json={'q': 'pillow'})
    assert response.status_code == 200
    assert response.json()['answer_source'] == 'retrieval'
    assert response.json()['answer_warning']


def test_blank_query_rejected_without_generation(setup):
    client, _, answerer = setup
    assert client.post('/query', json={'q': ' \n '}).status_code == 422
    answerer.answer.assert_not_called()


def test_query_is_stateless_even_if_old_client_sends_history(setup):
    client, search, answerer = setup
    search.return_value = [match()]
    response = client.post('/query', json={'q': 'pillow',
        'history': [{'role': 'user', 'content': 'grill'}]})
    assert response.status_code == 200
    assert search.call_args.args[2] == 'pillow'
    assert answerer.answer.call_args.args[0] == 'pillow'
    answerer.resolve.assert_not_called()
    assert 'resolved_query' not in response.json()
