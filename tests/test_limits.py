from concurrent.futures import ThreadPoolExecutor

from fastapi.testclient import TestClient
from app.limits import reserve
from app.main import app


def test_budget_is_atomic_and_survives_reopen(tmp_path):
    path = str(tmp_path / 'usage.db')
    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(lambda _: reserve(path, 'upload', 5, '2026-09-15'), range(20)))
    assert sum(results) == 5
    assert not reserve(path, 'upload', 5, '2026-09-15')
    assert reserve(path, 'upload', 5, '2026-09-16')
    assert reserve(path, 'query', 5, '2026-09-15')


def test_public_budget_cannot_be_bypassed_by_legacy_endpoints(monkeypatch):
    monkeypatch.setenv('PUBLIC_DEMO_LIMITS', 'true')
    client = TestClient(app)
    assert client.post('/videos/tag').status_code == 403
    assert client.post('/videos/').status_code == 403


def test_zero_budget_blocks_before_provider(monkeypatch, tmp_path):
    monkeypatch.setenv('PUBLIC_DEMO_LIMITS', 'true')
    monkeypatch.setenv('DAILY_QUERY_LIMIT', '0')
    monkeypatch.setenv('USAGE_DATABASE_PATH', str(tmp_path / 'usage.db'))
    response = TestClient(app).post('/query', json={'q': 'pillow'})
    assert response.status_code == 429
