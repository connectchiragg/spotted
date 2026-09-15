# Two-hour demo deployment

One EC2 host runs API, worker, and PostgreSQL with pgvector. S3 retains original videos.

1. Provision Ubuntu with Python venv, FFmpeg, PostgreSQL, pgvector and an instance role limited to the assessment bucket.
2. Create PostgreSQL role `ubuntu` and database `irl` owned by it; enable `vector`. Unix socket peer authentication avoids a stored database password.
3. Run `scripts/deploy_demo.sh HOST SSH_KEY`. It sends a filtered local environment over SSH, installs models and systemd units, and starts no services.
4. Stop local API and worker. Dump local PostgreSQL and restore on remote host before allowing uploads. Do not run workers against diverging database copies.
5. Verify environment, then explicitly start `irl-api` and `irl-worker` services after restoration.
6. Public demo has no user accounts; limit its lifetime and remove public access when finished.

Never commit `.env`, SSH keys, database dumps or model caches. A PostgreSQL 17 dump restored to 16 needs compatibility review; prefer matching major versions, or initialize schema from the app and restore data only.
