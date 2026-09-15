"""Advisory description similarity; never merges or deletes videos."""
import hashlib
import json
import math

from app.retrieval import cosine


def description_parts(job):
    result = job['result']
    return [result['summary']] + [frame['description'] for frame in result.get('frame_descriptions', [])]


def description_vector(store, embedder, job, existing):
    parts = description_parts(job)
    digest = hashlib.sha256(json.dumps(parts, ensure_ascii=False).encode()).hexdigest()
    cached = existing.get(job['id'])
    if cached and cached['text_hash'] == digest:
        return cached['vector']
    # Embed each frame separately so a long video's later descriptions are not
    # silently truncated by the model's per-input context window.
    vectors = embedder.passages(parts)
    if len(vectors) != len(parts) or not vectors or not vectors[0]:
        raise ValueError('Missing description embeddings')
    dimension = len(vectors[0])
    if any(len(v) != dimension or not all(math.isfinite(x) for x in v) for v in vectors):
        raise ValueError('Invalid description embedding')
    mean = [sum(v[i] for v in vectors) / len(vectors) for i in range(dimension)]
    norm = math.sqrt(sum(x*x for x in mean))
    vector = [x/norm for x in mean] if norm else mean
    store.save_embedding(job['id'], 'description:' + embedder.model, digest, vector)
    return vector


def possible_duplicate(store, embedder, job, threshold=.95):
    existing = store.embeddings('description:' + embedder.model)
    vector = description_vector(store, embedder, job, existing)
    matches = []
    for candidate in store.completed():
        if candidate['id'] == job['id']:
            continue
        other = description_vector(store, embedder, candidate, existing)
        similarity = cosine(vector, other)
        if similarity >= threshold:
            matches.append((similarity, candidate))
    if not matches:
        return None
    similarity, match = max(matches, key=lambda item: (item[0], item[1]['id']))
    return {'request_id': match['id'], 'filename': match['filename'],
            'display_name': match.get('display_name'), 'similarity': round(similarity, 4)}
