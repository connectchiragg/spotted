import sys
from types import SimpleNamespace

import pytest

from app.config import Settings
from app.providers import create_tagger
from app.tagger import GeminiTagger, TaggerError


def test_gemini_requires_key_without_fallback():
    with pytest.raises(TaggerError):
        create_tagger(Settings(tagging_provider='gemini',api_key=''))
    assert isinstance(create_tagger(Settings(tagging_provider='gemini',api_key='test')),GeminiTagger)


def test_local_provider_does_not_require_gemini_key(monkeypatch):
    class FakeLocal:
        def __init__(self,settings):
            self.settings=settings
    monkeypatch.setitem(sys.modules,'app.local_tagger',SimpleNamespace(LocalClipTagger=FakeLocal))
    settings=Settings(tagging_provider='local_clip',api_key='',image_model_cache='test-cache')
    create_tagger.cache_clear()
    try:
        first=create_tagger(settings)
        assert isinstance(first,FakeLocal)
        assert create_tagger(settings) is first
    finally:
        create_tagger.cache_clear()


def test_unknown_provider_rejected():
    with pytest.raises(ValueError):
        Settings(tagging_provider='unknown')
