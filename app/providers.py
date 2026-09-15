from functools import lru_cache
import threading

from app.config import Settings
from app.tagger import GeminiTagger, TaggerError


_initialization_lock = threading.Lock()


@lru_cache(maxsize=2)
def _cached_tagger(settings: Settings):
    if settings.tagging_provider == 'local_clip':
        from app.local_tagger import LocalClipTagger
        try:
            return LocalClipTagger(settings)
        except Exception as exc:
            raise TaggerError('Local image model unavailable; run scripts/prepare_image_model.py',503) from exc
    if not settings.api_key:
        raise TaggerError('Set GEMINI_API_KEY in .env and restart the server',503)
    return GeminiTagger(settings)


def create_tagger(settings: Settings):
    # lru_cache alone can construct duplicates on simultaneous cold requests.
    with _initialization_lock:
        return _cached_tagger(settings)


create_tagger.cache_clear = _cached_tagger.cache_clear
