import json
import sqlite3
import time
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


class Store:
    def __init__(self, path: str):
        self.path = path
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as db:
            db.execute('PRAGMA journal_mode=WAL')
            db.execute('''CREATE TABLE IF NOT EXISTS jobs (
                id TEXT PRIMARY KEY, filename TEXT NOT NULL, object_key TEXT NOT NULL,
                content_type TEXT NOT NULL, status TEXT NOT NULL,
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
                error TEXT, result TEXT, uploaded INTEGER NOT NULL DEFAULT 0,
                queued INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0,
                lease_until REAL, claim_token TEXT
            )''')
            db.execute('CREATE INDEX IF NOT EXISTS jobs_created ON jobs(created_at DESC)')

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=10)
        db.row_factory = sqlite3.Row
        try:
            with db:
                yield db
        finally:
            db.close()

    def create(self, filename: str, content_type: str) -> dict:
        request_id = str(uuid.uuid4())
        timestamp = now()
        with self.connect() as db:
            db.execute('''INSERT INTO jobs
                (id,filename,object_key,content_type,status,created_at,updated_at)
                VALUES (?,?,?,?,'uploading',?,?)''',
                (request_id, filename, f'videos/{request_id}/source', content_type, timestamp, timestamp))
        return self.get(request_id)

    @staticmethod
    def decode(row):
        if row is None:
            return None
        item = dict(row)
        item['result'] = json.loads(item['result']) if item['result'] else None
        return item

    def get(self, request_id: str):
        with self.connect() as db:
            return self.decode(db.execute('SELECT * FROM jobs WHERE id=?', (request_id,)).fetchone())

    def list(self, limit=50, offset=0, tags: list[str] | None = None):
        conditions = ''
        parameters = []
        if tags:
            placeholders = ','.join('?' for _ in tags)
            # EXISTS prevents duplicate videos when multiple requested tags match.
            # Filtering happens before pagination; values are always parameters.
            conditions = f"""WHERE status='completed' AND EXISTS (
                SELECT 1 FROM json_each(jobs.result, '$.tags') AS tag
                WHERE json_extract(tag.value, '$.label') IN ({placeholders})
            )"""
            parameters.extend(tags)
        with self.connect() as db:
            return [self.decode(r) for r in db.execute(
                f'SELECT * FROM jobs {conditions} ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?',
                (*parameters, limit, offset))]

    def uploaded(self, request_id: str):
        with self.connect() as db:
            db.execute("UPDATE jobs SET uploaded=1,status='pending',updated_at=? WHERE id=? AND status='uploading'",
                       (now(), request_id))

    def upload_failed(self, request_id: str, message: str):
        with self.connect() as db:
            db.execute("UPDATE jobs SET status='failed',error=?,updated_at=? WHERE id=? AND status='uploading'",
                       (message, now(), request_id))

    def unpublished(self):
        # The pending row is a tiny durable outbox: failed sends are retried by the worker.
        with self.connect() as db:
            return [dict(r) for r in db.execute(
                "SELECT id,attempts FROM jobs WHERE status='pending' AND queued=0 ORDER BY created_at LIMIT 50")]

    def published(self, request_id: str, attempts: int = 0):
        with self.connect() as db:
            db.execute("UPDATE jobs SET queued=1 WHERE id=? AND status='pending' AND attempts=?", (request_id, attempts))

    def claim(self, request_id: str, lease_seconds: int):
        token = str(uuid.uuid4())
        with self.connect() as db:
            result = db.execute('''UPDATE jobs SET status='processing', attempts=attempts+1,
                lease_until=?,claim_token=?,updated_at=?,error=NULL
                WHERE id=? AND (status='pending' OR (status='processing' AND lease_until<?))''',
                (time.time() + lease_seconds, token, now(), request_id, time.time()))
            return token if result.rowcount else None

    def finish(self, request_id: str, token: str, result: dict):
        with self.connect() as db:
            return db.execute('''UPDATE jobs SET status='completed',result=?,error=NULL,
                lease_until=NULL,claim_token=NULL,updated_at=?
                WHERE id=? AND status='processing' AND claim_token=?''',
                (json.dumps(result), now(), request_id, token)).rowcount == 1

    def processing_failed(self, request_id: str, token: str, message: str, retry: bool):
        with self.connect() as db:
            return db.execute('''UPDATE jobs SET status=?,error=?,queued=0,
                lease_until=NULL,claim_token=NULL,updated_at=?
                WHERE id=? AND status='processing' AND claim_token=?''',
                ('pending' if retry else 'failed', message, now(), request_id, token)).rowcount == 1

    def expire_uploads(self, age_seconds=900):
        cutoff = datetime.fromtimestamp(time.time() - age_seconds, timezone.utc).isoformat()
        with self.connect() as db:
            db.execute("""UPDATE jobs SET status='failed',error='Upload interrupted; submit the video again',
                updated_at=? WHERE status='uploading' AND updated_at<?""", (now(), cutoff))
