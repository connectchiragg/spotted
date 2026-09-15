"""One-time model download and backfill; later queries run offline."""
import sys
from pathlib import Path

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))

from fastembed import TextEmbedding
from app.config import Settings
from app.retrieval import index_jobs, index_frames, load_embedder
from app.store import Store

settings=Settings()
TextEmbedding(model_name=settings.embedding_model,cache_dir=settings.embedding_cache,threads=2)
store=Store(settings.database_path)
jobs=store.completed()
index_jobs(store,load_embedder(settings.embedding_model,settings.embedding_cache),jobs)
index_frames(store,load_embedder(settings.embedding_model,settings.embedding_cache),jobs)
print(f'Local model ready; indexed {len(jobs)} completed videos.')
