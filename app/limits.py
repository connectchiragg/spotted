"""Durable, account-wide request budgets for the public portfolio demo."""
import os
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from starlette.concurrency import run_in_threadpool
from starlette.responses import JSONResponse


def reserve(path, operation, limit, day=None):
    day = day or datetime.now(timezone.utc).date().isoformat()
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(path, timeout=5) as db:
        db.execute('CREATE TABLE IF NOT EXISTS usage (day TEXT, operation TEXT, count INTEGER NOT NULL, PRIMARY KEY(day,operation))')
        row = db.execute('''INSERT INTO usage VALUES (?, ?, 1)
            ON CONFLICT(day,operation) DO UPDATE SET count=count+1 WHERE count < ?
            RETURNING count''', (day, operation, limit)).fetchone() if limit > 0 else None
        return row is not None


async def public_budget(request, call_next):
    if os.getenv('PUBLIC_DEMO_LIMITS', 'false').lower() != 'true':
        return await call_next(request)
    path = request.url.path.rstrip('/')
    if request.method == 'POST' and path in ('/videos', '/videos/tag'):
        return JSONResponse({'detail': 'Use the direct upload flow in the Spotted interface.'}, status_code=403)
    if request.method == 'POST' and path == '/videos/uploads' and not os.getenv('GEMINI_API_KEY'):
        return JSONResponse({'detail': 'Video analysis is being configured. Please try uploading later.'}, status_code=503)
    operation = 'upload' if path == '/videos/uploads' else 'query' if path == '/query' else None
    if request.method == 'POST' and operation:
        # Public JSON endpoints never need a video-sized request body.
        try:
            length = int(request.headers.get('content-length', '0'))
        except ValueError:
            return JSONResponse({'detail': 'Invalid request size'}, status_code=400)
        if length > 16384:
            return JSONResponse({'detail': 'Request is too large'}, status_code=413)
        limit = int(os.getenv('DAILY_UPLOAD_LIMIT' if operation == 'upload' else 'DAILY_QUERY_LIMIT', '10' if operation == 'upload' else '100'))
        try:
            allowed = await run_in_threadpool(reserve, os.getenv('USAGE_DATABASE_PATH', 'data/usage.db'), operation, limit)
        except (sqlite3.Error, OSError):
            return JSONResponse({'detail': 'Usage checks are temporarily unavailable. Please try again later.'}, status_code=503)
        if not allowed:
            return JSONResponse({'detail': f'The shared demo has reached its daily {operation} limit. Please return after midnight UTC.'}, status_code=429)
    return await call_next(request)
