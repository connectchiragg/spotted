"""Integration checks use an isolated schema; run with TEST_POSTGRES_DSN."""
import json
import os
import uuid
from concurrent.futures import ThreadPoolExecutor

import pytest
import psycopg
from psycopg import sql
from app.postgres_store import PostgresStore


@pytest.fixture
def pg():
    dsn=os.getenv('TEST_POSTGRES_DSN')
    if not dsn: pytest.skip('Set TEST_POSTGRES_DSN for PostgreSQL integration tests')
    schema='test_'+uuid.uuid4().hex
    with psycopg.connect(dsn,autocommit=True) as db:
        db.execute('CREATE EXTENSION IF NOT EXISTS vector')
        db.execute(sql.SQL('CREATE SCHEMA {}').format(sql.Identifier(schema)))
    isolated=psycopg.conninfo.make_conninfo(dsn,options=f'-c search_path={schema},public')
    try: yield PostgresStore(isolated)
    finally:
        with psycopg.connect(dsn,autocommit=True) as db:
            db.execute(sql.SQL('DROP SCHEMA {} CASCADE').format(sql.Identifier(schema)))


def test_upload_queue_claim_retry_and_stale_ack(pg):
    job=pg.create('clip.mp4','video/mp4',123)
    assert pg.uploaded(job['id'])
    assert not pg.uploaded(job['id'])
    pg.publish(job['id'])
    with ThreadPoolExecutor(2) as pool:
        batches=list(pool.map(lambda _:pg.receive(),range(2)))
    deliveries=[m for batch in batches for m in batch]
    assert len(deliveries)==1
    first=deliveries[0]
    token=pg.claim(job['id'],600)
    assert token and pg.claim(job['id'],600) is None
    assert pg.processing_failed(job['id'],token,'temporary',retry=True)
    pg.acknowledge(first['ReceiptHandle'])
    second=pg.receive()[0]
    assert second['ReceiptHandle']!=first['ReceiptHandle']
    token2=pg.claim(job['id'],600)
    assert not pg.finish(job['id'],token,{'summary':'stale'})
    assert pg.finish(job['id'],token2,{'summary':'done','tags':[{'label':'bed'}]})
    pg.acknowledge(second['ReceiptHandle'])
    assert pg.receive()==[]
    assert pg.list(tags=['bed'])[0]['id']==job['id']
    assert pg.list(tags=['other'])==[]


def test_vector_and_frame_cosine_in_database(pg):
    job=pg.create('clip.mp4','video/mp4')
    pg.save_embedding(job['id'],'model','hash',[1.,0.,0.])
    pg.save_frame_embedding(job['id'],2,'model','hash',[0.,1.,0.])
    assert pg.cosine_scores('model',[1.,0.,0.])[job['id']]==pytest.approx(1)
    assert pg.frame_cosine_scores('model',[1.,0.,0.])[(job['id'],2)]==pytest.approx(0)
    assert pg.embeddings('model')[job['id']]['vector']==[1.,0.,0.]
    assert pg.frame_embeddings('model')[(job['id'],2)]['vector']==[0.,1.,0.]


def test_expired_receipt_cannot_delete_new_delivery(pg):
    job=pg.create('clip.mp4','video/mp4'); pg.uploaded(job['id'])
    first=pg.receive(0)[0]; second=pg.receive()[0]
    pg.acknowledge(first['ReceiptHandle'])
    with pg.connect() as db:
        row=db.execute('SELECT receipt FROM work_queue').fetchone()
    assert row['receipt']==second['ReceiptHandle']


def test_sqlite_migration_preserves_records_and_is_idempotent(pg,tmp_path):
    from app.store import Store
    from scripts.migrate_postgres import migrate
    path=tmp_path/'source.db'; source=Store(str(path))
    job=source.create('original.mp4','video/mp4',456)
    source.uploaded(job['id']); token=source.claim(job['id'],600)
    result={'summary':'bed','tags':[{'label':'bed'}], 'model':'original-model'}
    source.finish(job['id'],token,result)
    source.save_embedding(job['id'],'model','hash',[1.,0.,0.])
    source.save_frame_embedding(job['id'],0,'model','hash',[0.,1.,0.])
    first=migrate(path,pg.dsn); second=migrate(path,pg.dsn)
    assert first['jobs_inserted']==1 and second['jobs_inserted']==0
    assert pg.get(job['id'])['result']==result
    assert pg.get(job['id'])['expected_size']==456
    assert pg.embeddings('model')[job['id']]['vector']==[1.,0.,0.]
    assert source.get(job['id'])['result']==result
