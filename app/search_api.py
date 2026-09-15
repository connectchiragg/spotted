import tempfile
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import FileResponse

from app.cloud import CLOUD_ERRORS
from app.config import Settings
from app.jobs_api import cloud_dependency, present, read_cloud_dependency, settings_dependency, store_dependency
from app.media import MediaError, run_media
from app.retrieval import hybrid_search, load_embedder
from app.store import Store

router = APIRouter()


def embedder_dependency(settings: Settings = Depends(settings_dependency)):
    try:
        return load_embedder(settings.embedding_model, settings.embedding_cache)
    except Exception as exc:
        raise HTTPException(503, 'Local embedding model unavailable; run scripts/prepare_embeddings.py') from exc


@router.get('/search')
def search(q: str = Query(...,min_length=1,max_length=500),
           store: Store = Depends(store_dependency), cloud=Depends(read_cloud_dependency),
           settings: Settings = Depends(settings_dependency),
           embedder=Depends(embedder_dependency)):
    """Embed a natural-language query locally; rerank its three nearest videos.

    Hybrid score = 75% cosine similarity + 25% keyword coverage. Scores are not
    confidence probabilities. Citations point to model-attributed evidence.
    """
    query = ' '.join(q.split())
    if not query:
        raise HTTPException(422,'Query must not be blank')
    try:
        ranked = hybrid_search(store,embedder,query,settings.search_min_similarity)
    except (ValueError, RuntimeError) as exc:
        raise HTTPException(503,'Local search index could not be built or queried') from exc
    return {'query':query,'embedding_model':embedder.model,'min_similarity':settings.search_min_similarity,
            'items':[present(job,cloud) | {'retrieval':retrieval} for job,retrieval in ranked]}


@router.get('/videos/{request_id}/frames/{frame_index}')
def frame_citation(request_id: str, frame_index: int,
                   store: Store = Depends(store_dependency), settings: Settings = Depends(settings_dependency),
                   cloud=Depends(cloud_dependency)):
    job=store.get(request_id)
    if not job or job['status']!='completed':
        raise HTTPException(404,'Completed video not found')
    timestamps=job['result'].get('sampled_timestamps',[])
    if not 0<=frame_index<len(timestamps):
        raise HTTPException(404,'Sampled frame not found')
    cache=Path(settings.database_path).parent/'citations'/job['id']
    cache.mkdir(parents=True,exist_ok=True)
    output=cache/f'{frame_index}.jpg'
    if not output.exists():
        try:
            with tempfile.TemporaryDirectory(prefix='irl-citation-') as folder:
                source=Path(folder)/'source.video'
                cloud.download(job,source)
                data=run_media(['ffmpeg','-nostdin','-v','error','-protocol_whitelist','file,pipe',
                    '-ss',str(timestamps[frame_index]),'-i',str(source),'-map','0:v:0','-frames:v','1',
                    '-vf','scale=768:768:force_original_aspect_ratio=decrease',
                    '-f','image2pipe','-vcodec','mjpeg','-q:v','3','pipe:1'],10)
                if not data:
                    raise MediaError('No frame decoded')
                with tempfile.NamedTemporaryFile(dir=cache,delete=False) as temp:
                    temp.write(data)
                    temp_path=Path(temp.name)
                temp_path.replace(output)
        except (MediaError,*CLOUD_ERRORS) as exc:
            raise HTTPException(502,'Citation frame could not be loaded') from exc
    return FileResponse(output,media_type='image/jpeg',headers={'Cache-Control':'private, max-age=86400'})
