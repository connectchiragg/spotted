import tempfile
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException, UploadFile

from app.config import Settings
from app.media import MediaError, extract_frames
from app.models import VideoResponse
from app.tagger import GeminiTagger, PROMPT_VERSION, Tagger, TaggerError

app = FastAPI(title='Instawork Video Tagger', version='0.1.0')


def get_settings() -> Settings:
    return Settings()


def get_tagger(settings: Settings = Depends(get_settings)) -> Tagger:
    if not settings.api_key:
        raise HTTPException(503, 'Set GEMINI_API_KEY in .env and restart the server')
    return GeminiTagger(settings)


@app.get('/health')
def health():
    return {'status': 'ok'}


@app.post('/videos/tag', response_model=VideoResponse)
def tag_video(
    file: UploadFile,
    settings: Settings = Depends(get_settings),
    tagger: Tagger = Depends(get_tagger),
):
    """Upload a video and wait for extracted-image tagging. No files are retained.

    frame_indices in each tag refer to the zero-based sampled_timestamps array.
    """
    try:
        with tempfile.TemporaryDirectory(prefix='instawork-') as directory:
            path = Path(directory) / 'upload.video'
            size = 0
            with path.open('wb') as destination:
                while chunk := file.file.read(1024 * 1024):
                    size += len(chunk)
                    if size > settings.max_upload_mb * 1024 * 1024:
                        raise HTTPException(413, f'Video exceeds {settings.max_upload_mb} MB')
                    destination.write(chunk)
            if size == 0:
                raise HTTPException(422, 'Video file is empty')
            duration, frames = extract_frames(path, settings.max_frames, settings.max_video_seconds)
            result = tagger.tag_frames(frames)
            return VideoResponse(
                filename=file.filename or 'video', duration_seconds=duration,
                sampled_timestamps=[frame.timestamp for frame in frames],
                model=tagger.model, prompt_version=PROMPT_VERSION,
                summary=result.summary, tags=result.tags,
            )
    except MediaError as exc:
        raise HTTPException(422, str(exc)) from exc
    except TaggerError as exc:
        raise HTTPException(exc.status_code, str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(503, str(exc)) from exc
    finally:
        file.file.close()
