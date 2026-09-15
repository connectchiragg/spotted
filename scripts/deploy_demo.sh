#!/usr/bin/env bash
# Transfer application and filtered secrets; never starts the remote worker.
set -euo pipefail
HOST=${1:?Usage: deploy_demo.sh HOST SSH_KEY}
KEY=${2:?Usage: deploy_demo.sh HOST SSH_KEY}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
DEPLOY_TMP=$(mktemp -d)
trap 'rm -rf "$DEPLOY_TMP"' EXIT
chmod 700 "$DEPLOY_TMP"
cd "$ROOT"
tar --exclude='__pycache__' --exclude='*.pyc' -czf "$DEPLOY_TMP/app.tar.gz" app scripts deploy requirements.txt
.venv/bin/python - "$DEPLOY_TMP/demo.env" <<'PY'
import sys
from pathlib import Path
from dotenv import dotenv_values
values=dotenv_values('.env')
keys=['GEMINI_API_KEY','GEMINI_MODEL','AWS_REGION','S3_BUCKET','MAX_UPLOAD_MB','MAX_VIDEO_SECONDS',
      'MAX_FRAMES','GEMINI_TIMEOUT_SECONDS','EMBEDDING_MODEL','SEARCH_MIN_SIMILARITY']
selected={k:values[k] for k in keys if values.get(k) is not None}
selected.update(AWS_PROFILE='',AWS_USAGE_ENABLED='true',TAGGING_PROVIDER='gemini',
                DATABASE_URL='postgresql:///irl?host=/var/run/postgresql',
                DATABASE_BACKEND='postgres',EMBEDDING_CACHE='data/models')
p=Path(sys.argv[1]); p.write_text(''.join(f"{k}='{v}'\n" for k,v in selected.items())); p.chmod(0o600)
PY
SSH=(ssh -i "$KEY" -o StrictHostKeyChecking=accept-new "ubuntu@$HOST")
"${SSH[@]}" 'mkdir -p /home/ubuntu/instawork && chmod 700 /home/ubuntu/instawork'
scp -i "$KEY" -o StrictHostKeyChecking=accept-new "$DEPLOY_TMP/app.tar.gz" "$DEPLOY_TMP/demo.env" "ubuntu@$HOST:/home/ubuntu/instawork/"
"${SSH[@]}" 'cd /home/ubuntu/instawork && tar xzf app.tar.gz && mv demo.env .env && chmod 600 .env && rm app.tar.gz && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt && .venv/bin/python deploy/prepare_search_model.py && sudo cp deploy/irl-api.service deploy/irl-worker.service /etc/systemd/system/ && sudo systemctl daemon-reload'
printf '%s\n' 'Prepared remote app. Services not started. Restore the stopped local database snapshot before enabling worker.'
