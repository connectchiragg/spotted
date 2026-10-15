"""Prepare missing evidence assets without re-running tagging or changing originals."""
import io
import json
import tempfile
from pathlib import Path
from PIL import Image
from psycopg.types.json import Jsonb
from app.config import Settings
from app.storage import get_store
from app.cloud import Cloud
from app.previews import prepare_previews


def main():
    settings=Settings();store=get_store(settings);cloud=Cloud(settings)
    for job in store.completed():
        result=job['result'];timestamps=result['sampled_timestamps']
        if result.get('preview_indices')==list(range(len(timestamps))):
            continue
        print('Preparing previews',job['id'],flush=True)
        with tempfile.TemporaryDirectory(prefix='spotted-backfill-') as folder:
            source=Path(folder)/'source.video';cloud.download(job,source)
            def upload(index,data):
                cloud.upload_preview(job,index,data)
                image=Image.open(io.BytesIO(data)).convert('RGB')
                jpeg=io.BytesIO();image.save(jpeg,format='JPEG',quality=85)
                cloud.upload_frame(job,index,jpeg.getvalue())
            indices=prepare_previews(source,timestamps,result['duration_seconds'],folder,upload)
        updated=result|{'preview_indices':indices}
        with store.connect() as db:
            if settings.database_url:
                db.execute('UPDATE jobs SET result=%s WHERE id=%s AND result=%s',
                           (Jsonb(updated),job['id'],Jsonb(result)))
            else:
                db.execute('UPDATE jobs SET result=? WHERE id=? AND result=?',
                           (json.dumps(updated),job['id'],json.dumps(result)))
        print('Prepared',len(indices),'previews',job['id'],flush=True)

if __name__=='__main__': main()
