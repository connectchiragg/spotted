"""Prepare evidence animations once in the ingestion worker."""
from pathlib import Path

from app.media import MediaError, run_media


def prepare_previews(source, timestamps, duration, folder, upload, progress=None):
    """Decode the original once; the resized intermediate is temporary only."""
    proxy = Path(folder) / 'preview-source.mp4'
    run_media([
        'ffmpeg', '-nostdin', '-v', 'error', '-threads', '1',
        '-skip_frame', 'noref', '-filter_threads', '1',
        '-protocol_whitelist', 'file,pipe', '-i', str(source),
        '-t', str(duration), '-map', '0:v:0', '-an',
        '-vf', 'fps=8,scale=480:480:force_original_aspect_ratio=decrease:force_divisible_by=2',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '20',
        '-pix_fmt', 'yuv420p', '-threads', '1', '-y', str(proxy),
    ], timeout=max(120, duration * 6))
    if progress:
        progress(0, len(timestamps))
    indices = []
    for index, timestamp in enumerate(timestamps):
        data = run_media([
            'ffmpeg', '-nostdin', '-v', 'error', '-threads', '1',
            '-filter_complex_threads', '1', '-protocol_whitelist', 'file,pipe',
            '-ss', str(timestamp), '-i', str(proxy), '-t', '5', '-an',
            '-filter_complex', '[0:v]split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer',
            '-threads', '1', '-loop', '0', '-f', 'gif', 'pipe:1',
        ], timeout=30)
        if not data.startswith((b'GIF87a', b'GIF89a')):
            raise MediaError('No animation decoded')
        upload(index, data)
        indices.append(index)
        if progress:
            progress(len(indices), len(timestamps))
    return indices
