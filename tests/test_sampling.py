"""Real FFmpeg sampling checks; generated local media, no model or network."""
import shutil
import subprocess
from pathlib import Path

import pytest

from app import media

pytestmark = pytest.mark.skipif(not shutil.which('ffmpeg'), reason='FFmpeg is required')


def make_video(path: Path, colors: list[str], seconds: float):
    command = ['ffmpeg', '-nostdin', '-v', 'error', '-threads', '1',
               '-filter_threads', '1']
    for color in colors:
        command += ['-f', 'lavfi', '-i', f'color={color}:size=160x90:duration={seconds}:rate=10']
    inputs = ''.join(f'[{i}:v]' for i in range(len(colors)))
    command += ['-filter_complex_threads', '1', '-filter_complex',
                f'{inputs}concat=n={len(colors)}:v=1:a=0',
                '-threads', '1', '-y', str(path)]
    subprocess.run(command, check=True, capture_output=True, timeout=15)


def test_hard_changes_include_frames_after_both_cuts(tmp_path):
    path = tmp_path / 'changes.mp4'
    make_video(path, ['red', 'blue', 'white'], 3)
    duration, frames = media.extract_frames(path, 8, 60)
    times = [frame.timestamp for frame in frames]
    assert duration == pytest.approx(9, abs=.1)
    assert any(3 <= time <= 3.5 for time in times)
    assert any(6 <= time <= 6.5 for time in times)
    assert times == sorted(times)
    assert all(b-a >= 1 for a, b in zip(times, times[1:]))
    assert all(frame.data.startswith(b'\xff\xd8') for frame in frames)


def test_static_video_uses_fewer_frames_and_one_second_keeps_center(tmp_path):
    long = tmp_path / 'static.mp4'
    make_video(long, ['navy'], 20)
    _, frames = media.extract_frames(long, 16, 60)
    assert [frame.timestamp for frame in frames] == [10.0]
    short = tmp_path / 'short.mp4'
    make_video(short, ['navy'], 1)
    _, frames = media.extract_frames(short, 16, 60)
    assert [frame.timestamp for frame in frames] == [.5]


def test_many_changes_respect_budget_and_spacing(tmp_path):
    path = tmp_path / 'many.mp4'
    make_video(path, ['red', 'blue', 'white', 'black', 'yellow'], 2)
    times = media.sampling_timestamps(path, 10, 3)
    assert 1 <= len(times) <= 3
    assert times == sorted(times)
    assert all(b-a >= 1 for a, b in zip(times, times[1:]))
    assert all(0 <= time < 10 for time in times)


def test_scan_timeout_falls_back_with_warning(monkeypatch, caplog):
    commands = []
    def timeout(command, timeout):
        commands.append((command, timeout))
        try:
            raise subprocess.TimeoutExpired(command, timeout)
        except subprocess.TimeoutExpired as cause:
            raise media.MediaError('Video decoding exceeded the time limit') from cause
    monkeypatch.setattr(media, 'run_media', timeout)
    assert media.sampling_timestamps(Path('example.mp4'), 20, 3) == [3.333, 10.0, 16.667]
    assert 'using uniform frame sampling' in caplog.text
    command, limit = commands[0]
    assert 0 < limit <= 2
    assert command[command.index('-filter_threads')+1] == '1'
    assert command[command.index('-protocol_whitelist')+1] == 'file,pipe'


def test_sustained_pixel_difference_is_detected(monkeypatch):
    samples=iter([bytes([0])*4096,bytes([50])*4096,bytes([100])*4096])
    monkeypatch.setattr(media, 'run_media', lambda *args, **kwargs: next(samples))
    changes=media._scene_changes(Path('unused'),1.5,8)
    assert [timestamp for timestamp,_ in changes]==[.5,1.0]


def test_long_video_scan_caps_probe_count_and_seeks_before_input(monkeypatch):
    commands=[]
    def probe(command,timeout):
        commands.append((command,timeout))
        return bytes(4096)
    monkeypatch.setattr(media,'run_media',probe)
    assert media._scene_changes(Path('unused'),600,8)==[]
    assert len(commands)==16
    assert all(command.index('-ss')<command.index('-i') for command,_ in commands)
    assert all(timeout<=2 for _,timeout in commands)


def test_scan_wall_budget_includes_prior_probes(monkeypatch):
    ticks=iter([0,0,16])
    monkeypatch.setattr(media.time,'monotonic',lambda:next(ticks))
    monkeypatch.setattr(media,'run_media',lambda *a,**k:bytes(4096))
    with pytest.raises(media.MediaError) as error:
        media._scene_changes(Path('unused'),600,8)
    assert isinstance(error.value.__cause__,subprocess.TimeoutExpired)
