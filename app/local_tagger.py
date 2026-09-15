"""Offline CLIP candidate tagging. Similarities are not calibrated probabilities.

Vocabulary spans reviewed samples plus distractors; no filename-specific labels.
Single-frame action matches are suggestions, not verified temporal events.
"""
import io
import threading

import numpy as np
from PIL import Image

from app.models import FrameDescription, Tag, TaggingResult

# These are explicit product vocabulary choices, not an exhaustive ontology.
VOCABULARY = {
    'environment': ['bedroom', 'kitchen', 'industrial workshop', 'construction site',
                    'office', 'street', 'forest', 'beach', 'restaurant', 'warehouse'],
    'object': ['bed', 'pillow', 'blanket', 'bed sheet', 'sink', 'faucet', 'metal rack',
               'cleaning brush', 'soap', 'bucket', 'bowl', 'machinery', 'trough',
               'hoe', 'wooden pole', 'construction material', 'car', 'computer',
               'food', 'chair', 'dog', 'bicycle', 'book', 'plant'],
    'action': ['making a bed', 'folding bedding', 'arranging pillows', 'scrubbing',
               'washing dishes', 'washing hands', 'mixing construction material',
               'carrying a bucket', 'operating machinery', 'sorting items',
               'cooking food', 'driving', 'typing', 'running', 'reading'],
}


def unit(vectors):
    values = np.asarray(vectors, dtype=np.float32)
    return values / np.maximum(np.linalg.norm(values, axis=-1, keepdims=True), 1e-12)


class LocalClipTagger:
    model = 'Qdrant/clip-ViT-B-32'
    prompt_version = 'clip-v1'

    def __init__(self, settings):
        from fastembed import ImageEmbedding, TextEmbedding
        cache = getattr(settings, 'image_model_cache', 'data/models')
        self.vision = ImageEmbedding(model_name=self.model+'-vision', cache_dir=cache,
                                     threads=2, local_files_only=True)
        text = TextEmbedding(model_name=self.model+'-text', cache_dir=cache,
                             threads=2, local_files_only=True)
        self.candidates = [(category, label) for category, labels in VOCABULARY.items() for label in labels]
        prompts = [f'A photo of {label}.' if category != 'action' else f'A person {label}.'
                   for category, label in self.candidates]
        self.text_vectors = unit(list(text.embed(prompts)))
        self.lock = threading.Lock()

    def tag_frames(self, frames):
        if not 1 <= len(frames) <= 32:
            raise ValueError('Between one and 32 frames are required')
        with self.lock:
            images = [Image.open(io.BytesIO(frame.data)).convert('RGB') for frame in frames]
            try:
                vectors = unit(list(self.vision.embed(images, batch_size=8)))
            finally:
                for image in images:
                    image.close()
        return self.result_from_scores(vectors @ self.text_vectors.T)

    def result_from_scores(self, scores):
        scores = np.asarray(scores)
        if scores.ndim != 2 or scores.shape[1] != len(self.candidates) or not np.isfinite(scores).all():
            raise ValueError('Invalid CLIP similarity output')
        evidence = {}
        descriptions = []
        # Initial uncalibrated thresholds; no softmax that forces a winning label.
        thresholds = {'environment': .25, 'object': .25, 'action': .27}
        limits = {'environment': 2, 'object': 4, 'action': 2}
        for frame_index, row in enumerate(scores):
            labels = []
            for category in VOCABULARY:
                eligible = [i for i, (kind, _) in enumerate(self.candidates)
                            if kind == category and row[i] >= thresholds[category]]
                for i in sorted(eligible, key=lambda i: row[i], reverse=True)[:limits[category]]:
                    evidence.setdefault(i, []).append(frame_index)
                    labels.append(self.candidates[i][1])
            descriptions.append(FrameDescription(frame_index=frame_index,
                description='Local CLIP candidate labels: '+(', '.join(labels) if labels else 'no labels above threshold')+'.'))
        tags = [Tag(category=self.candidates[i][0], label=self.candidates[i][1], frame_indices=indices)
                for i, indices in evidence.items()][:40]
        summary = 'Local CLIP candidate tags: '+(', '.join(tag.label for tag in tags) if tags else 'none above threshold')+'. Action labels are visual suggestions from sampled still images.'
        return TaggingResult(summary=summary,tags=tags,frame_descriptions=descriptions)
