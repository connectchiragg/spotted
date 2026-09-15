"""Small on-demand evidence animations; originals stay in object storage."""
import hashlib
import threading
from pathlib import Path
import tempfile

from app.media import MediaError, run_media

# Bound decoding and prevent duplicate generation in this API process.
_preview_lock = threading.Lock()


def evidence_gif(job, frame_index, cloud, cache_root):
    timestamp = job['result']['sampled_timestamps'][frame_index]
    digest = hashlib.sha256(f"{job['object_key']}:{timestamp}:gif-v1".encode()).hexdigest()
    cache = Path(cache_root) / 'previews'
    cache.mkdir(parents=True, exist_ok=True)
    output = cache / f'{digest}.gif'
    with _preview_lock:
        if output.exists():
            return output
        # Keep the derived cache bounded. Videos are downloaded to disk, not RAM.
        entries = sorted(cache.glob('*.gif'), key=lambda p: p.stat().st_mtime)
        while len(entries) >= 128:
            entries.pop(0).unlink(missing_ok=True)
        with tempfile.TemporaryDirectory(prefix='framer-preview-') as folder:
            source = Path(folder) / 'source.video'
            cloud.download(job, source)
            data = run_media([
                'ffmpeg', '-nostdin', '-v', 'error', '-threads', '1',
                '-filter_threads', '1', '-protocol_whitelist', 'file,pipe',
                '-ss', str(timestamp), '-i', str(source), '-t', '5',
                '-map', '0:v:0', '-an', '-vf',
                'fps=6,scale=320:320:force_original_aspect_ratio=decrease:flags=bilinear',
                '-threads', '1', '-loop', '0', '-f', 'gif', 'pipe:1',
            ], timeout=30)
            if not data.startswith((b'GIF87a', b'GIF89a')):
                raise MediaError('No animation decoded')
            with tempfile.NamedTemporaryFile(dir=cache, delete=False) as temp:
                temp.write(data)
                temporary = Path(temp.name)
            temporary.replace(output)
    return output
