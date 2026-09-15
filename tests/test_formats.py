"""Actual container/codec decoding with local FFmpeg; inference/cloud are fake."""
import json
import subprocess

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.jobs_api import cloud_dependency, settings_dependency, store_dependency
from app.main import app, get_settings, get_tagger
from app.media import MediaError, extract_frames
from app.models import TaggingResult
from app.store import Store

FORMATS = [('mp4', 'libx264', 'h264', 'video/mp4'),
           ('mov', 'libx264', 'h264', 'video/quicktime'),
           ('mkv', 'mpeg4', 'mpeg4', 'video/x-matroska'),
           ('avi', 'mpeg4', 'mpeg4', 'video/x-msvideo'),
           ('webm', 'libvpx', 'vp8', 'video/webm')]


class ImageTagger:
    model = 'offline-test'

    def tag_frames(self, frames):
        assert frames and all(frame.data.startswith(b'\xff\xd8') for frame in frames)
        return TaggingResult(summary='Generated color frames.', tags=[])


class IntentCloud:
    def direct_upload(self, job, size):
        return {'url': 'https://example.invalid/upload', 'headers': {'Content-Type': job['content_type']}}


@pytest.fixture
def client(tmp_path):
    settings = Settings(api_key='unused', max_frames=2, database_path=str(tmp_path/'jobs.db'))
    store = Store(settings.database_path)
    overrides = {get_settings: lambda: settings, get_tagger: lambda: ImageTagger(),
                 settings_dependency: lambda: settings, store_dependency: lambda: store,
                 cloud_dependency: lambda: IntentCloud()}
    previous = app.dependency_overrides.copy()
    app.dependency_overrides.update(overrides)
    with TestClient(app) as test_client:
        yield test_client
    app.dependency_overrides.clear()
    app.dependency_overrides.update(previous)


def make_video(path, codec):
    subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=64x64:r=10:d=1',
                    '-an', '-c:v', codec, '-pix_fmt', 'yuv420p', '-y', str(path)], check=True)
    return path.read_bytes()


@pytest.mark.parametrize('extension,encoder,codec,mime', FORMATS)
def test_real_container_decode_sync_upload_and_direct_intent(tmp_path, client, extension, encoder, codec, mime):
    path = tmp_path/f'clip.{extension}'
    content = make_video(path, encoder)
    streams = json.loads(subprocess.check_output(['ffprobe', '-v', 'error', '-show_streams', '-of', 'json', str(path)]))
    assert streams['streams'][0]['codec_name'] == codec
    duration, frames = extract_frames(path, 2, 10)
    assert .9 <= duration <= 1.1
    assert frames and frames[0].data.startswith(b'\xff\xd8')
    response = client.post('/videos/tag', files={'file': (path.name, content, mime)})
    assert response.status_code == 200, response.text
    assert response.json()['model'] == 'offline-test'
    intent = client.post('/videos/uploads', json={'filename': path.name, 'content_type': mime, 'size_bytes': len(content)})
    assert intent.status_code == 201, intent.text
    assert intent.json()['upload']['headers']['Content-Type'] == mime


def test_real_video_with_wrong_extension_and_generic_type_still_decodes(tmp_path, client):
    source = tmp_path/'source.mp4'
    content = make_video(source, 'libx264')
    disguised = tmp_path/'actually-a-video.txt'
    disguised.write_bytes(content)
    assert extract_frames(disguised, 2, 10)[1]
    response = client.post('/videos/tag', files={'file': ('../../misleading.txt', content, 'application/octet-stream')})
    assert response.status_code == 200, response.text


@pytest.mark.parametrize('kind', ['garbage', 'audio_only'])
def test_mp4_filename_cannot_make_nonvideo_valid(tmp_path, client, kind):
    path = tmp_path/'bad.mp4'
    if kind == 'audio_only':
        subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'sine=duration=0.2',
                        '-c:a', 'aac', '-vn', '-y', str(path)], check=True)
    else:
        path.write_bytes(b'not a video container')
    with pytest.raises(MediaError):
        extract_frames(path, 2, 10)
    response = client.post('/videos/tag', files={'file': ('bad.mp4', path.read_bytes(), 'video/mp4')})
    assert response.status_code == 422, response.text
