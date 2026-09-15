#!/usr/bin/env bash
# Official Ubuntu and PostgreSQL APT repositories; PostgreSQL 17 matches local dump.
set -euo pipefail
sudo apt-get update -qq
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ca-certificates curl python3-venv ffmpeg
sudo install -d /usr/share/postgresql-common/pgdg
sudo curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc
printf '%s\n' 'deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt noble-pgdg main' | sudo tee /etc/apt/sources.list.d/pgdg.list >/dev/null
sudo apt-get update -qq
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq postgresql-17 postgresql-17-pgvector
sudo systemctl enable --now postgresql
if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='ubuntu'" | grep -q 1; then
  sudo -u postgres createuser ubuntu
fi
if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='irl'" | grep -q 1; then
  sudo -u postgres createdb -O ubuntu irl
fi
sudo -u postgres psql -d irl -v ON_ERROR_STOP=1 -c 'CREATE EXTENSION IF NOT EXISTS vector'
