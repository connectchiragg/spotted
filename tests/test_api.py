import subprocess
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import app, get_settings, get_tagger
from app.models import Tag, TaggingResult
from app.tagger import TaggerError, validate_evidence


class FakeTagger:
    model = 'test-model'

    def tag_frames(self, frames):
        assert frames and all(f.data.startswith(b'\xff\xd8') for f in frames)
        return TaggingResult(summary='A red test frame.', tags=[
            Tag(label=' Red surface ', category='object', frame_indices=[0]),
        ])


@pytest.fixture
def client():
    app.dependency_overrides[get_settings] = lambda: Settings(api_key='test', max_frames=2)
    app.dependency_overrides[get_tagger] = lambda: FakeTagger()
    with TestClient(app) as test_client:
        yield test_client
    app.dependency_overrides.clear()


@pytest.fixture
def video(tmp_path):
    path = tmp_path / 'sample.mp4'
    subprocess.run([
        'ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=64x64:d=1',
        '-c:v', 'mpeg4', str(path),
    ], check=True)
    return path.read_bytes()


def test_upload_extract_and_tag(client, video, monkeypatch):
    import app.main as main
    original = main.extract_frames
    captured = []

    def capture(path, *args):
        captured.append(path)
        return original(path, *args)

    monkeypatch.setattr(main, 'extract_frames', capture)
    response = client.post('/videos/tag', files={'file': ('../../sample.mp4', video, 'video/mp4')})
    assert response.status_code == 200, response.text
    result = response.json()
    assert result['tags'][0]['label'] == 'red surface'
    assert result['sampled_timestamps'] == [0.5]
    assert result['model'] == 'test-model'
    assert captured and not captured[0].exists()


@pytest.mark.parametrize('content', [b'', b'not a video'])
def test_bad_upload(client, content):
    assert client.post('/videos/tag', files={'file': ('bad.mp4', content)}).status_code == 422


def test_missing_key(client, video):
    app.dependency_overrides.pop(get_tagger)
    app.dependency_overrides[get_settings] = lambda: Settings(api_key='')
    response = client.post('/videos/tag', files={'file': ('sample.mp4', video)})
    assert response.status_code == 503


def test_upload_limit(client):
    app.dependency_overrides[get_settings] = lambda: Settings(api_key='test', max_upload_mb=1)
    response = client.post('/videos/tag', files={'file': ('large.mp4', b'x' * (1024 * 1024 + 1))})
    assert response.status_code == 413


def test_provider_failure(client, video):
    class FailingTagger:
        model = 'test-model'

        def tag_frames(self, frames):
            raise TaggerError('Gemini request timed out', 504)

    app.dependency_overrides[get_tagger] = lambda: FailingTagger()
    response = client.post('/videos/tag', files={'file': ('sample.mp4', video)})
    assert response.status_code == 504
    assert response.json()['detail'] == 'Gemini request timed out'


def test_merge_duplicate_tags_and_reject_invalid_evidence():
    result = TaggingResult(summary='Boxes.', tags=[
        Tag(label=' BOX ', category='object', frame_indices=[0]),
        Tag(label='box', category='object', frame_indices=[1, 1]),
    ])
    cleaned = validate_evidence(result, 2)
    assert len(cleaned.tags) == 1
    assert cleaned.tags[0].frame_indices == [0, 1]
    with pytest.raises(TaggerError):
        validate_evidence(result, 1)


def test_docs_and_health(client):
    assert client.get('/health').json() == {'status': 'ok'}
    assert client.get('/docs').status_code == 200
    assert '/videos/tag' in client.get('/openapi.json').json()['paths']


def test_frame_descriptions_accept_complete_coverage_and_old_results():
    from app.models import FrameDescription
    result = TaggingResult(summary='A person adjusts a pillow.', tags=[], frame_descriptions=[
        FrameDescription(frame_index=1, description='A pillow rests on the bed.'),
        FrameDescription(frame_index=0, description='A person holds a pillow.'),
    ])
    assert len(validate_evidence(result, 2).frame_descriptions) == 2
    assert validate_evidence(TaggingResult(summary='Old result.', tags=[]), 2).frame_descriptions == []


@pytest.mark.parametrize('indices', [[0], [0, 0], [0, 2]])
def test_frame_descriptions_reject_incomplete_duplicate_or_out_of_bounds(indices):
    from app.models import FrameDescription
    result = TaggingResult(summary='A scene.', tags=[], frame_descriptions=[
        FrameDescription(frame_index=i, description='Visible scene.') for i in indices])
    with pytest.raises(TaggerError):
        validate_evidence(result, 2)


@pytest.mark.parametrize('index,description', [(-1, 'scene'), (True, 'scene'),
                                             ('0', 'scene'), (0, ' '), (0, 'x' * 501)])
def test_frame_description_rejects_invalid_fields(index, description):
    from app.models import FrameDescription
    from pydantic import ValidationError
    with pytest.raises(ValidationError):
        FrameDescription(frame_index=index, description=description)


def test_frame_description_count_is_bounded():
    from pydantic import ValidationError
    with pytest.raises(ValidationError):
        TaggingResult(summary='Scenes.', tags=[], frame_descriptions=[
            {'frame_index': i, 'description': 'A scene.'} for i in range(33)])
