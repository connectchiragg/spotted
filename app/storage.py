from functools import lru_cache

from app.store import Store


@lru_cache(maxsize=4)
def _store(database_url, database_path):
    if database_url:
        from app.postgres_store import PostgresStore
        return PostgresStore(database_url)
    return Store(database_path)


def get_store(settings):
    return _store(settings.database_url, settings.database_path)
