import json
import math
import logging
import os
import time
import subprocess
from dataclasses import dataclass
from pathlib import Path


logger = logging.getLogger(__name__)
SCENE_SCAN_TIMEOUT = 15
MAX_SCAN_PROBES = 16
SCAN_PROBE_TIMEOUT = 2
MIN_FRAME_GAP = 1.0


class MediaError(Exception):
    pass


@dataclass(frozen=True)
class Frame:
    timestamp: float
    data: bytes


def run_media(command: list[str], timeout: float) -> bytes:
    try:
        return subprocess.run(command, capture_output=True, check=True, timeout=timeout).stdout
    except FileNotFoundError as exc:
        raise RuntimeError('FFmpeg and ffprobe must be installed') from exc
    except subprocess.TimeoutExpired as exc:
        raise MediaError('Video decoding exceeded the time limit') from exc
    except subprocess.CalledProcessError as exc:
        raise MediaError('Video is invalid or could not be decoded') from exc


def _even_timestamps(duration: float, max_frames: int) -> list[float]:
    count = min(max_frames, max(1, math.ceil(duration / 5)))
    return [round(duration * (i + .5) / count, 3) for i in range(count)]


def _scene_changes(path: Path, duration: float, threshold: float) -> list[tuple[float, float]]:
    # Sparse input seeking avoids decoding every frame of a high-resolution video.
    # These thumbnails only choose timestamps; final evidence images are extracted
    # separately at those timestamps. Short events between probes can be missed.
    started = time.monotonic()
    step = max(.5, duration / MAX_SCAN_PROBES)
    probe_times = [round(i * step, 3) for i in range(min(MAX_SCAN_PROBES, max(1, math.ceil(duration / step))))]
    changes = []
    previous = None
    for timestamp in probe_times:
        remaining = SCENE_SCAN_TIMEOUT - (time.monotonic() - started)
        if remaining <= 0:
            cause = subprocess.TimeoutExpired('sparse scene scan', SCENE_SCAN_TIMEOUT)
            raise MediaError('Scene scan exceeded its time budget') from cause
        pixels = run_media([
            'ffmpeg', '-nostdin', '-v', 'error', '-threads', '1',
            '-filter_threads', '1', '-protocol_whitelist', 'file,pipe',
            '-ss', str(timestamp), '-i', str(path), '-map', '0:v:0',
            '-frames:v', '1', '-vf', 'scale=64:64', '-pix_fmt', 'gray',
            '-an', '-threads', '1', '-f', 'rawvideo', 'pipe:1',
        ], timeout=min(SCAN_PROBE_TIMEOUT, remaining))
        if len(pixels) != 64 * 64:
            raise MediaError('Could not extract a scene probe')
        if previous is not None:
            score = sum(abs(a - b) for a, b in zip(previous, pixels)) * 100 / (255 * len(pixels))
            if score >= threshold:
                changes.append((timestamp, score))
        previous = pixels
    return changes


def sampling_timestamps(path: Path, duration: float, max_frames: int) -> list[float]:
    if max_frames < 1:
        raise ValueError('max_frames must be positive')
    threshold = float(os.getenv('FRAME_SCENE_THRESHOLD', '8'))
    if not math.isfinite(threshold) or not 0 < threshold <= 100:
        raise ValueError('FRAME_SCENE_THRESHOLD must be between 0 and 100')
    try:
        changes = _scene_changes(path, duration, threshold)
    except MediaError as exc:
        if not isinstance(exc.__cause__, subprocess.TimeoutExpired):
            raise
        logger.warning('Scene scan timed out after %s seconds; using uniform frame sampling',
                       SCENE_SCAN_TIMEOUT)
        return _even_timestamps(duration, max_frames)

    # Reserve a small coverage budget. Calm videos therefore need only 1–3
    # images; abrupt changes consume the remaining budget in score order.
    baseline_count = min(max_frames, 3, max(1, math.ceil(duration / 30)))
    baseline = [duration * (i + .5) / baseline_count for i in range(baseline_count)]
    selected = []
    ranked = sorted(changes, key=lambda item: (-item[1], item[0]))
    scene_budget = max_frames - baseline_count if max_frames > 1 else 1
    for timestamp, _ in ranked:
        if len(selected) >= scene_budget:
            break
        if all(abs(timestamp - other) >= MIN_FRAME_GAP for other in selected):
            selected.append(timestamp)
    for timestamp in baseline:
        if len(selected) < max_frames and all(abs(timestamp - other) >= MIN_FRAME_GAP for other in selected):
            selected.append(timestamp)
    # Baselines near a selected change leave room for another distinct change.
    for timestamp, _ in ranked:
        if len(selected) >= max_frames:
            break
        if all(abs(timestamp - other) >= MIN_FRAME_GAP for other in selected):
            selected.append(timestamp)
    if not selected:
        selected = [duration / 2]
    return sorted(round(timestamp, 3) for timestamp in selected)


def extract_frames(path: Path, max_frames: int, max_duration: float) -> tuple[float, list[Frame]]:
    # Restrict protocols so uploaded containers cannot fetch network resources.
    metadata = run_media([
        'ffprobe', '-v', 'error', '-protocol_whitelist', 'file,pipe',
        '-select_streams', 'v:0', '-show_entries', 'stream=codec_type:format=duration',
        '-of', 'json', str(path),
    ], timeout=15)
    try:
        probe = json.loads(metadata)
        duration = float(probe['format']['duration'])
        if not probe.get('streams') or not math.isfinite(duration) or duration <= 0:
            raise ValueError()
    except (ValueError, KeyError, TypeError) as exc:
        raise MediaError('File must contain a video stream with a valid duration') from exc
    if duration > max_duration:
        raise MediaError(f'Video exceeds the {max_duration:g}-second duration limit')

    frames = []
    for timestamp in sampling_timestamps(path, duration, max_frames):
        data = run_media([
            'ffmpeg', '-nostdin', '-v', 'error', '-threads', '1',
            '-filter_threads', '1', '-protocol_whitelist', 'file,pipe', '-ss', str(timestamp), '-i', str(path),
            '-map', '0:v:0', '-frames:v', '1', '-vf',
            "scale=768:768:force_original_aspect_ratio=decrease",
            '-threads', '1', '-f', 'image2pipe', '-vcodec', 'mjpeg', '-q:v', '3', 'pipe:1',
        ], timeout=10)
        if not data:
            raise MediaError(f'Could not extract frame at {timestamp} seconds')
        frames.append(Frame(timestamp=timestamp, data=data))
    return duration, frames
