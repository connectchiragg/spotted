"""Provider statuses cross the real adapter boundary without network requests."""
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from google.genai import errors

from app.config import Settings
from app.media import Frame
from app.tagger import GeminiTagger, TaggerError


@pytest.mark.parametrize('provider_status,expected_status', [
    (500, 503), (502, 503), (503, 503), (504, 504),
    (429, 503), (401, 503), (403, 503), (404, 503), (400, 502),
])
def test_gemini_error_status_mapping(monkeypatch, provider_status, expected_status):
    generate = MagicMock(side_effect=errors.APIError(
        provider_status, {'error': {'code': provider_status, 'message': 'provider failure'}}))
    client = MagicMock()
    client.__enter__.return_value = SimpleNamespace(models=SimpleNamespace(generate_content=generate))
    monkeypatch.setattr('app.tagger.genai.Client', MagicMock(return_value=client))

    with pytest.raises(TaggerError) as caught:
        GeminiTagger(Settings(api_key='unused-test-key')).tag_frames([Frame(0.5, b'image')])

    assert caught.value.status_code == expected_status
    # Adapter performs no hidden retry; the worker owns the bounded retry policy.
    assert generate.call_count == 1
    if provider_status in (500, 502, 503):
        assert 'temporarily unavailable' in str(caught.value)
