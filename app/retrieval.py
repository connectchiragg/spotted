import hashlib
import math
import re
import threading
from functools import lru_cache

from app.config import Settings

STOPWORDS = set('a an the and or of in on at to for is are was were with me show find video videos someone person people doing'.split())


def tokens(text):
    return set(re.findall(r'\w+', text.lower())) - STOPWORDS


class LocalEmbedder:
    def __init__(self, model, cache):
        from fastembed import TextEmbedding
        self.model = model
        self.engine = TextEmbedding(model_name=model, cache_dir=cache, threads=2, local_files_only=True)
        self.lock = threading.Lock()

    def passages(self, texts):
        with self.lock:
            return [v.tolist() for v in self.engine.passage_embed(texts)]

    def query(self, text):
        with self.lock:
            return next(iter(self.engine.query_embed(text))).tolist()


@lru_cache(maxsize=2)
def load_embedder(model, cache):
    return LocalEmbedder(model, cache)


def document(job):
    result = job['result']
    labels = ', '.join(tag['label'] for tag in result['tags'])
    return f"Tags: {labels}. Summary: {result['summary']}"


def index_jobs(store, embedder, jobs):
    existing = store.embeddings(embedder.model)
    missing = []
    for job in jobs:
        text = document(job)
        digest = hashlib.sha256(text.encode()).hexdigest()
        if job['id'] not in existing or existing[job['id']]['text_hash'] != digest:
            missing.append((job['id'], text, digest))
    if missing:
        vectors = embedder.passages([item[1] for item in missing])
        if len(vectors) != len(missing):
            raise ValueError('Embedding model returned an unexpected number of vectors')
        for (job_id, _, digest), vector in zip(missing, vectors):
            if not vector or not all(math.isfinite(v) for v in vector):
                raise ValueError('Embedding model returned an invalid vector')
            store.save_embedding(job_id, embedder.model, digest, vector)
            existing[job_id] = {'text_hash':digest,'vector':vector}
    return existing


def cosine(left, right):
    if len(left) != len(right):
        raise ValueError('Embedding dimensions do not match; rebuild the index')
    norm = math.sqrt(sum(v*v for v in left)*sum(v*v for v in right))
    return sum(a*b for a,b in zip(left,right))/norm if norm else 0.0


def citation(job, query_tokens):
    result = job['result']
    timestamps = result.get('sampled_timestamps', [])
    tags = sorted(result['tags'], key=lambda tag:(len(tokens(tag['label']) & query_tokens),
                                                  tag['category']=='action'), reverse=True)
    for tag in tags:
        for index in tag.get('frame_indices', []):
            if isinstance(index,int) and 0 <= index < len(timestamps):
                return {'frame_index':index,'timestamp_seconds':timestamps[index],
                        'label':tag['label'],'source':'model-attributed sampled frame',
                        'image_url':f"/videos/{job['id']}/frames/{index}"}
    return None


def hybrid_search(store, embedder, query):
    jobs = store.completed()
    if not jobs:
        return []
    vectors = index_jobs(store, embedder, jobs)
    query_vector = embedder.query(query)
    query_tokens = tokens(query)
    candidates = []
    for job in jobs:
        semantic = max(0.0, min(1.0, cosine(query_vector, vectors[job['id']]['vector'])))
        lexical = len(query_tokens & tokens(document(job))) / max(1, len(query_tokens))
        candidates.append((job, semantic, lexical))
    # Start with the three nearest embeddings, then rerank with lexical coverage.
    nearest = sorted(candidates, key=lambda item:(item[1],item[0]['id']), reverse=True)[:3]
    ranked = sorted(nearest, key=lambda item:(0.75*item[1]+0.25*item[2],item[0]['id']), reverse=True)
    return [(job, {'score':round(.75*semantic+.25*lexical,4),
                   'semantic_score':round(semantic,4),'keyword_score':round(lexical,4),
                   'citation':citation(job,query_tokens)}) for job,semantic,lexical in ranked]
