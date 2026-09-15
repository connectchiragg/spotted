"""Download both compatible CLIP encoders once; tagging then runs offline."""
from fastembed import ImageEmbedding, TextEmbedding

if __name__ == '__main__':
    for cls, model in [(ImageEmbedding, 'Qdrant/clip-ViT-B-32-vision'),
                       (TextEmbedding, 'Qdrant/clip-ViT-B-32-text')]:
        cls(model_name=model, cache_dir='data/models', threads=2)
        print('Ready:', model)
