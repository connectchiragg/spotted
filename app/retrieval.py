import hashlib
import math
import re
import threading
from functools import lru_cache

from app.config import Settings

STOPWORDS = set('a an the and or of in on at to for is are was were with me show find video videos someone person people doing'.split())


def tokens(text):
    return set(re.findall(r'\w+', text.lower())) - STOPWORDS


def full_keyword_match(query_tokens, text):
    return bool(query_tokens) and query_tokens <= tokens(text)


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


def index_frames(store, embedder, jobs):
    existing = store.frame_embeddings(embedder.model)
    missing = []
    for job in jobs:
        for frame in job['result'].get('frame_descriptions', []):
            index, text = frame['frame_index'], frame['description']
            digest = hashlib.sha256(text.encode()).hexdigest()
            key = (job['id'], index)
            if key not in existing or existing[key]['text_hash'] != digest:
                missing.append((key, text, digest))
    if missing:
        vectors = embedder.passages([text for _, text, _ in missing])
        if len(vectors) != len(missing):
            raise ValueError('Unexpected frame embedding count')
        for ((job_id, index), _, digest), vector in zip(missing, vectors):
            if not vector or not all(math.isfinite(v) for v in vector):
                raise ValueError('Invalid frame embedding')
            store.save_frame_embedding(job_id,index,embedder.model,digest,vector)
            existing[(job_id,index)] = {'text_hash':digest,'vector':vector}
    return existing


def frame_citation(job, query_vector, query_tokens, vectors):
    timestamps = job['result'].get('sampled_timestamps', [])
    candidates = []
    for frame in job['result'].get('frame_descriptions', []):
        index = frame['frame_index']
        if not 0 <= index < len(timestamps):
            continue
        semantic = cosine(query_vector, vectors[(job['id'],index)]['vector'])
        lexical = len(tokens(frame['description']) & query_tokens) / max(1,len(query_tokens))
        candidates.append((.85*semantic+.15*lexical,semantic,index,frame['description']))
    if not candidates:
        return None, 0.0
    _, semantic, index, description = max(candidates,key=lambda c:(c[0],-c[2]))
    return {'frame_index':index,'timestamp_seconds':timestamps[index],
            'label':description,'description':description,
            'source':'model-described sampled frame',
            'image_url':f"/videos/{job['id']}/frames/{index}"}, semantic


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


def hybrid_search(store, embedder, query, min_similarity=0.60):
    jobs = store.completed()
    if not jobs:
        return []
    vectors = index_jobs(store, embedder, jobs)
    frame_vectors = index_frames(store, embedder, jobs)
    query_vector = embedder.query(query)
    query_tokens = tokens(query)
    candidates = []
    for job in jobs:
        semantic = max(0.0, min(1.0, cosine(query_vector, vectors[job['id']]['vector'])))
        tag_text = ' '.join(tag['label'] for tag in job['result']['tags'])
        if semantic < min_similarity and not full_keyword_match(query_tokens,tag_text):
            continue
        lexical = len(query_tokens & tokens(document(job))) / max(1, len(query_tokens))
        evidence, frame_score = frame_citation(job,query_vector,query_tokens,frame_vectors)
        # Results without a relevant sampled moment cannot support click-to-play.
        if evidence is None or (frame_score < min_similarity and
                               not full_keyword_match(query_tokens,evidence['description'])):
            continue
        candidates.append((job, semantic, lexical, evidence, frame_score))
    # Start with the three nearest embeddings, then rerank with lexical coverage.
    nearest = sorted(candidates, key=lambda item:(item[1],item[0]['id']), reverse=True)[:3]
    ranked = sorted(nearest, key=lambda item:(0.75*item[1]+0.25*item[2],item[0]['id']), reverse=True)
    return [(job, {'score':round(.75*semantic+.25*lexical,4),
                   'semantic_score':round(semantic,4),'keyword_score':round(lexical,4),
                   'frame_score':round(frame_score,4),'citation':evidence})
            for job,semantic,lexical,evidence,frame_score in ranked]
