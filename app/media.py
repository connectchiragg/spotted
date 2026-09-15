import json
import math
import subprocess
from dataclasses import dataclass
from pathlib import Path


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

    count = min(max_frames, max(1, math.ceil(duration / 5)))
    frames = []
    # Evenly spaced bin centers avoid an often-empty opening or end frame.
    for i in range(count):
        timestamp = round(duration * (i + 0.5) / count, 3)
        data = run_media([
            'ffmpeg', '-nostdin', '-v', 'error', '-threads', '1',
            '-protocol_whitelist', 'file,pipe', '-ss', str(timestamp), '-i', str(path),
            '-map', '0:v:0', '-frames:v', '1', '-vf',
            "scale=768:768:force_original_aspect_ratio=decrease",
            '-threads', '1', '-f', 'image2pipe', '-vcodec', 'mjpeg', '-q:v', '3', 'pipe:1',
        ], timeout=10)
        if not data:
            raise MediaError(f'Could not extract frame at {timestamp} seconds')
        frames.append(Frame(timestamp=timestamp, data=data))
    return duration, frames
