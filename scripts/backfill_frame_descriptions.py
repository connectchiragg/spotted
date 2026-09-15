"""Backfill missing frame descriptions without replacing reviewed tags or summary."""
import json
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.cloud import Cloud
from app.config import Settings
from app.media import extract_frames
from app.store import Store
from app.tagger import GeminiTagger, PROMPT_VERSION


def main():
    settings = Settings(max_frames=8)
    store = Store(settings.database_path)
    cloud = Cloud(settings)
    tagger = GeminiTagger(settings)
    report = []
    for job in store.completed():
        if job['result'].get('frame_descriptions'):
            continue
        started = time.monotonic()
        entry = {'id': job['id'], 'filename': job['filename']}
        try:
            with store.connect() as db:
                original = db.execute("SELECT result FROM jobs WHERE id=? AND status='completed'",
                                      (job['id'],)).fetchone()
            if original is None:
                continue
            original_json = original['result']
            original_result = json.loads(original_json)
            with tempfile.TemporaryDirectory(prefix='instawork-description-') as directory:
                source = Path(directory) / 'video.mp4'
                cloud.download(job, source)
                _, frames = extract_frames(source, settings.max_frames, settings.max_video_seconds)
                if [frame.timestamp for frame in frames] != original_result['sampled_timestamps']:
                    raise ValueError('Original sampling timestamps differ; left unchanged')
                analyzed = tagger.tag_frames(frames)
            if not analyzed.frame_descriptions:
                raise ValueError('Model omitted frame descriptions; left unchanged')
            original_result['frame_descriptions'] = [item.model_dump() for item in analyzed.frame_descriptions]
            original_result['frame_description_model'] = tagger.model
            original_result['frame_description_prompt_version'] = PROMPT_VERSION
            with store.connect() as db:
                updated = db.execute("UPDATE jobs SET result=? WHERE id=? AND status='completed' AND result=?",
                                     (json.dumps(original_result), job['id'], original_json)).rowcount
            entry.update(status='updated' if updated else 'skipped_concurrent_change',
                         frame_count=len(analyzed.frame_descriptions))
        except Exception as exc:
            # Do not write SDK request/exception text that might contain credentials.
            entry.update(status='failed', error_type=type(exc).__name__)
        entry['elapsed_seconds'] = round(time.monotonic() - started, 2)
        report.append(entry)
        print(json.dumps(entry), flush=True)
    output = Path('artifacts/frame-description-backfill.json')
    output.parent.mkdir(exist_ok=True)
    output.write_text(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
