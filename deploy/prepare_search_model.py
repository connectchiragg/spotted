"""Fetch only the search encoder before restoring the database."""
from fastembed import TextEmbedding
TextEmbedding(model_name='BAAI/bge-small-en-v1.5',cache_dir='data/models',threads=2)
print('Search model downloaded')
