"""Postgres state, pgvector embeddings and a leased durable work queue."""
import json
import time
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb


def now():
    return datetime.now(timezone.utc).isoformat()


class PostgresStore:
    def __init__(self, dsn):
        self.dsn = dsn
        with self.connect() as db:
            db.execute('CREATE EXTENSION IF NOT EXISTS vector')
            db.execute('''CREATE TABLE IF NOT EXISTS jobs (
                id TEXT PRIMARY KEY, filename TEXT NOT NULL, object_key TEXT NOT NULL,
                content_type TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL, error TEXT, result JSONB, uploaded INTEGER NOT NULL DEFAULT 0,
                queued INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0,
                lease_until DOUBLE PRECISION, claim_token TEXT, expected_size BIGINT)''')
            db.execute('ALTER TABLE jobs ADD COLUMN IF NOT EXISTS display_name TEXT')
            db.execute('ALTER TABLE jobs ADD COLUMN IF NOT EXISTS archived_at TEXT')
            db.execute('ALTER TABLE jobs ADD COLUMN IF NOT EXISTS progress JSONB')
            db.execute('CREATE INDEX IF NOT EXISTS jobs_created ON jobs(created_at DESC)')
            db.execute('''CREATE TABLE IF NOT EXISTS embeddings (
                job_id TEXT REFERENCES jobs(id), model TEXT, text_hash TEXT NOT NULL,
                vector vector NOT NULL, PRIMARY KEY(job_id,model))''')
            db.execute('''CREATE TABLE IF NOT EXISTS frame_embeddings (
                job_id TEXT REFERENCES jobs(id), frame_index INTEGER, model TEXT,
                text_hash TEXT NOT NULL, vector vector NOT NULL, PRIMARY KEY(job_id,frame_index,model))''')
            db.execute('''CREATE TABLE IF NOT EXISTS work_queue (
                request_id TEXT PRIMARY KEY REFERENCES jobs(id), receipt TEXT,
                visible_at TIMESTAMPTZ NOT NULL DEFAULT now())''')
            db.execute('CREATE INDEX IF NOT EXISTS queue_visible ON work_queue(visible_at)')

    @contextmanager
    def connect(self):
        with psycopg.connect(self.dsn, row_factory=dict_row, connect_timeout=5) as db:
            yield db

    @staticmethod
    def decode(row):
        return dict(row) if row is not None else None

    def create(self, filename, content_type, expected_size=None, display_name=None):
        request_id, timestamp = str(uuid.uuid4()), now()
        with self.connect() as db:
            db.execute('''INSERT INTO jobs
                (id,filename,object_key,content_type,status,created_at,updated_at,expected_size,display_name)
                VALUES(%s,%s,%s,%s,'uploading',%s,%s,%s,%s)''',
                (request_id,filename,f'videos/{request_id}/source',content_type,timestamp,timestamp,expected_size,display_name))
        return self.get(request_id)

    def get(self, request_id):
        with self.connect() as db:
            return db.execute('SELECT * FROM jobs WHERE id=%s',(request_id,)).fetchone()

    def list(self, limit=50, offset=0, tags=None, include_archived=False):
        where, params = ('' if include_archived else 'WHERE archived_at IS NULL'), []
        if tags:
            where += (" AND " if where else "WHERE ") + "status='completed' AND EXISTS (SELECT 1 FROM jsonb_array_elements(result->'tags') t WHERE t->>'label'=ANY(%s))"
            params.append(tags)
        with self.connect() as db:
            return db.execute(f'SELECT * FROM jobs {where} ORDER BY created_at DESC,id DESC LIMIT %s OFFSET %s',
                              (*params,limit,offset)).fetchall()

    def archive(self, request_id):
        with self.connect() as db:
            return db.execute('UPDATE jobs SET archived_at=COALESCE(archived_at,%s) WHERE id=%s',(now(),request_id)).rowcount == 1

    def restore(self, request_id):
        with self.connect() as db:
            return db.execute('UPDATE jobs SET archived_at=NULL WHERE id=%s',(request_id,)).rowcount == 1

    def uploaded(self, request_id):
        with self.connect() as db:
            changed = db.execute("UPDATE jobs SET uploaded=1,queued=1,status='pending',updated_at=%s WHERE id=%s AND status='uploading'",
                                 (now(),request_id)).rowcount == 1
            if changed:
                db.execute('INSERT INTO work_queue(request_id) VALUES(%s) ON CONFLICT DO NOTHING',(request_id,))
            return changed

    def upload_failed(self, request_id, message):
        with self.connect() as db:
            db.execute("UPDATE jobs SET status='failed',error=%s,updated_at=%s WHERE id=%s AND status='uploading'",(message,now(),request_id))

    def unpublished(self):
        with self.connect() as db:
            return db.execute("SELECT id,attempts FROM jobs WHERE status='pending' AND queued=0 ORDER BY created_at LIMIT 50").fetchall()

    def published(self, request_id, attempts=0):
        with self.connect() as db:
            db.execute("UPDATE jobs SET queued=1 WHERE id=%s AND status='pending' AND attempts=%s",(request_id,attempts))

    def publish(self, request_id):
        with self.connect() as db:
            db.execute('''INSERT INTO work_queue(request_id)
                SELECT id FROM jobs WHERE id=%s AND uploaded=1 AND status IN ('pending','processing')
                ON CONFLICT DO NOTHING''',(request_id,))
            db.execute("UPDATE jobs SET queued=1 WHERE id=%s AND status='pending'",(request_id,))

    def receive(self, lease_seconds=600):
        receipt = str(uuid.uuid4())
        with self.connect() as db:
            row = db.execute('''WITH available AS (
                SELECT request_id FROM work_queue WHERE visible_at<=now()
                ORDER BY visible_at,request_id FOR UPDATE SKIP LOCKED LIMIT 1)
                UPDATE work_queue q SET receipt=%s,visible_at=now()+%s * interval '1 second'
                FROM available a WHERE q.request_id=a.request_id RETURNING q.request_id''',
                (receipt,lease_seconds)).fetchone()
            return [{'Body':json.dumps({'request_id':row['request_id']}),'ReceiptHandle':receipt}] if row else []

    def acknowledge(self, receipt):
        with self.connect() as db:
            db.execute('DELETE FROM work_queue WHERE receipt=%s',(receipt,))

    def claim(self, request_id, lease_seconds):
        token = str(uuid.uuid4())
        with self.connect() as db:
            changed = db.execute('''UPDATE jobs SET status='processing',attempts=attempts+1,
                lease_until=%s,claim_token=%s,updated_at=%s,error=NULL WHERE id=%s
                AND (status='pending' OR (status='processing' AND lease_until<%s))''',
                (time.time()+lease_seconds,token,now(),request_id,time.time())).rowcount
            return token if changed else None

    def set_progress(self, request_id, claim_token, stage, percent, eta_seconds=None):
        if not isinstance(stage,str) or not stage.strip() or not 0 <= percent <= 100:
            raise ValueError('Progress requires a stage and percentage between 0 and 100')
        if eta_seconds is not None and eta_seconds < 0:
            raise ValueError('ETA must not be negative')
        timestamp=now()
        progress={'stage':stage,'percent':percent,'eta_seconds':eta_seconds,'updated_at':timestamp}
        with self.connect() as db:
            return db.execute("UPDATE jobs SET progress=%s,updated_at=%s WHERE id=%s AND status='processing' AND claim_token=%s",
                              (Jsonb(progress),timestamp,request_id,claim_token)).rowcount == 1

    def finish(self, request_id, token, result):
        with self.connect() as db:
            return db.execute('''UPDATE jobs SET status='completed',result=%s,error=NULL,
                lease_until=NULL,claim_token=NULL,updated_at=%s
                WHERE id=%s AND status='processing' AND claim_token=%s''',
                (Jsonb(result),now(),request_id,token)).rowcount == 1

    def processing_failed(self, request_id, token, message, retry):
        with self.connect() as db:
            changed = db.execute('''UPDATE jobs SET status=%s,error=%s,queued=%s,
                lease_until=NULL,claim_token=NULL,updated_at=%s
                WHERE id=%s AND status='processing' AND claim_token=%s''',
                ('pending' if retry else 'failed',message,1 if retry else 0,now(),request_id,token)).rowcount == 1
            if changed and retry:
                # Old delivery acknowledgement must not delete the retry.
                db.execute('''INSERT INTO work_queue(request_id) VALUES(%s)
                    ON CONFLICT(request_id) DO UPDATE SET receipt=NULL,visible_at=now()''',(request_id,))
            return changed

    def expire_uploads(self, age_seconds=900):
        cutoff=datetime.fromtimestamp(time.time()-age_seconds,timezone.utc).isoformat()
        with self.connect() as db:
            db.execute("""UPDATE jobs SET status='failed',error='Upload interrupted; submit the video again',
                updated_at=%s WHERE status='uploading' AND updated_at<%s""",(now(),cutoff))

    def completed(self):
        with self.connect() as db:
            return db.execute("SELECT * FROM jobs WHERE status='completed' AND archived_at IS NULL ORDER BY created_at DESC,id DESC").fetchall()

    def embeddings(self, model):
        with self.connect() as db:
            return {r['job_id']:{'text_hash':r['text_hash'],'vector':json.loads(r['vector'])}
                    for r in db.execute('SELECT job_id,text_hash,vector::text FROM embeddings WHERE model=%s',(model,))}

    def save_embedding(self, job_id, model, text_hash, vector):
        with self.connect() as db:
            db.execute('''INSERT INTO embeddings VALUES(%s,%s,%s,%s::vector)
                ON CONFLICT(job_id,model) DO UPDATE SET text_hash=excluded.text_hash,vector=excluded.vector''',
                (job_id,model,text_hash,json.dumps(vector)))

    def frame_embeddings(self, model):
        with self.connect() as db:
            return {(r['job_id'],r['frame_index']):{'text_hash':r['text_hash'],'vector':json.loads(r['vector'])}
                    for r in db.execute('SELECT job_id,frame_index,text_hash,vector::text FROM frame_embeddings WHERE model=%s',(model,))}

    def save_frame_embedding(self, job_id, frame_index, model, text_hash, vector):
        with self.connect() as db:
            db.execute('''INSERT INTO frame_embeddings VALUES(%s,%s,%s,%s,%s::vector)
                ON CONFLICT(job_id,frame_index,model) DO UPDATE SET text_hash=excluded.text_hash,vector=excluded.vector''',
                (job_id,frame_index,model,text_hash,json.dumps(vector)))

    def cosine_scores(self, model, queryvector):
        with self.connect() as db:
            return {r['job_id']:float(r['score']) for r in db.execute(
                'SELECT job_id,1-(vector <=> %s::vector) AS score FROM embeddings WHERE model=%s',
                (json.dumps(queryvector),model))}

    def frame_cosine_scores(self, model, queryvector):
        with self.connect() as db:
            return {(r['job_id'],r['frame_index']):float(r['score']) for r in db.execute(
                'SELECT job_id,frame_index,1-(vector <=> %s::vector) AS score FROM frame_embeddings WHERE model=%s',
                (json.dumps(queryvector),model))}


PgStore = PostgresStore
