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
            if 'expected_size' not in {row['name'] for row in db.execute('PRAGMA table_info(jobs)')}:
                db.execute('ALTER TABLE jobs ADD COLUMN expected_size INTEGER')
            columns = {row['name'] for row in db.execute('PRAGMA table_info(jobs)')}
            for column in ('display_name','archived_at'):
                if column not in columns:
                    db.execute(f'ALTER TABLE jobs ADD COLUMN {column} TEXT')
            db.execute('''CREATE TABLE IF NOT EXISTS embeddings (
                job_id TEXT NOT NULL, model TEXT NOT NULL, text_hash TEXT NOT NULL,
                vector TEXT NOT NULL, PRIMARY KEY(job_id,model)
            )''')
            db.execute('''CREATE TABLE IF NOT EXISTS frame_embeddings (
                job_id TEXT NOT NULL, frame_index INTEGER NOT NULL,
                model TEXT NOT NULL, text_hash TEXT NOT NULL, vector TEXT NOT NULL,
                PRIMARY KEY(job_id,frame_index,model)
            )''')

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=10)
        db.row_factory = sqlite3.Row
        try:
            with db:
                yield db
        finally:
            db.close()

    def create(self, filename: str, content_type: str, expected_size: int | None = None, display_name: str | None = None) -> dict:
        request_id = str(uuid.uuid4())
        timestamp = now()
        with self.connect() as db:
            db.execute('''INSERT INTO jobs
                (id,filename,object_key,content_type,status,created_at,updated_at,expected_size,display_name)
                VALUES (?,?,?,?,'uploading',?,?,?,?)''',
                (request_id, filename, f'videos/{request_id}/source', content_type, timestamp, timestamp,expected_size,display_name))
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

    def list(self, limit=50, offset=0, tags: list[str] | None = None, include_archived=False):
        conditions = '' if include_archived else 'WHERE archived_at IS NULL'
        parameters = []
        if tags:
            placeholders = ','.join('?' for _ in tags)
            # EXISTS prevents duplicate videos when multiple requested tags match.
            # Filtering happens before pagination; values are always parameters.
            conditions += (" AND " if conditions else "WHERE ") + f"""status='completed' AND EXISTS (
                SELECT 1 FROM json_each(jobs.result, '$.tags') AS tag
                WHERE json_extract(tag.value, '$.label') IN ({placeholders})
            )"""
            parameters.extend(tags)
        with self.connect() as db:
            return [self.decode(r) for r in db.execute(
                f'SELECT * FROM jobs {conditions} ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?',
                (*parameters, limit, offset))]

    def archive(self, request_id):
        with self.connect() as db:
            return db.execute('UPDATE jobs SET archived_at=COALESCE(archived_at,?) WHERE id=?',(now(),request_id)).rowcount == 1

    def restore(self, request_id):
        with self.connect() as db:
            return db.execute('UPDATE jobs SET archived_at=NULL WHERE id=?',(request_id,)).rowcount == 1

    def uploaded(self, request_id: str):
        with self.connect() as db:
            return db.execute("UPDATE jobs SET uploaded=1,status='pending',updated_at=? WHERE id=? AND status='uploading'",
                       (now(), request_id)).rowcount == 1

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

    def completed(self):
        with self.connect() as db:
            return [self.decode(row) for row in db.execute(
                "SELECT * FROM jobs WHERE status='completed' AND archived_at IS NULL ORDER BY created_at DESC,id DESC")]

    def embeddings(self, model):
        with self.connect() as db:
            return {r['job_id']: {'text_hash':r['text_hash'],'vector':json.loads(r['vector'])}
                    for r in db.execute('SELECT * FROM embeddings WHERE model=?',(model,))}

    def save_embedding(self, job_id, model, text_hash, vector):
        with self.connect() as db:
            db.execute('''INSERT INTO embeddings(job_id,model,text_hash,vector) VALUES(?,?,?,?)
                ON CONFLICT(job_id,model) DO UPDATE SET text_hash=excluded.text_hash,vector=excluded.vector''',
                (job_id,model,text_hash,json.dumps(vector)))

    def frame_embeddings(self, model):
        with self.connect() as db:
            return {(r['job_id'],r['frame_index']): {'text_hash':r['text_hash'],'vector':json.loads(r['vector'])}
                    for r in db.execute('SELECT * FROM frame_embeddings WHERE model=?',(model,))}

    def save_frame_embedding(self, job_id, frame_index, model, text_hash, vector):
        with self.connect() as db:
            db.execute('''INSERT INTO frame_embeddings VALUES(?,?,?,?,?)
                ON CONFLICT(job_id,frame_index,model) DO UPDATE SET
                text_hash=excluded.text_hash,vector=excluded.vector''',
                (job_id,frame_index,model,text_hash,json.dumps(vector)))
