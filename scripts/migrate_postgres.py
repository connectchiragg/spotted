"""One-way idempotent SQLite snapshot import. Stop API/worker before running."""
import argparse
import json
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from psycopg.types.json import Jsonb
from app.postgres_store import PostgresStore


def migrate(source, dsn):
    store=PostgresStore(dsn)
    source=Path(source).resolve()
    with sqlite3.connect(f'file:{source}?mode=ro',uri=True) as disk:
        snapshot=sqlite3.connect(':memory:')
        disk.backup(snapshot)
    snapshot.row_factory=sqlite3.Row
    counts={}
    try:
        with store.connect() as db:
            fields=['id','filename','object_key','content_type','status','created_at','updated_at',
                    'error','result','uploaded','queued','attempts','lease_until','claim_token','expected_size']
            count=0
            for row in snapshot.execute('SELECT * FROM jobs'):
                item=dict(row)
                if item['result']: item['result']=Jsonb(json.loads(item['result']))
                # No source process remains alive at migration time. Recover its in-flight claim.
                if item['status']=='processing':
                    item.update(status='pending',claim_token=None,lease_until=None)
                values=[item.get(key) for key in fields]
                count+=db.execute(f"INSERT INTO jobs({','.join(fields)}) VALUES({','.join(['%s']*len(fields))}) ON CONFLICT DO NOTHING",values).rowcount
            counts['jobs_inserted']=count
            existing_tables={r[0] for r in snapshot.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            for table,columns in [('embeddings',['job_id','model','text_hash','vector']),
                                  ('frame_embeddings',['job_id','frame_index','model','text_hash','vector'])]:
                count=0
                if table in existing_tables:
                    for row in snapshot.execute(f'SELECT * FROM {table}'):
                        values=[row[key] for key in columns]
                        placeholders=['%s']*(len(columns)-1)+['%s::vector']
                        count+=db.execute(f"INSERT INTO {table}({','.join(columns)}) VALUES({','.join(placeholders)}) ON CONFLICT DO NOTHING",values).rowcount
                counts[table+'_inserted']=count
            db.execute("INSERT INTO work_queue(request_id) SELECT id FROM jobs WHERE uploaded=1 AND status='pending' ON CONFLICT DO NOTHING")
            db.execute("UPDATE jobs SET queued=1 WHERE uploaded=1 AND status='pending'")
        return counts
    finally:
        snapshot.close()


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source',default='data/spotted.db')
    parser.add_argument('--dsn',required=True)
    args=parser.parse_args()
    print(json.dumps(migrate(args.source,args.dsn)))
