#!/usr/bin/env bash
# Isolated assessment database; does not use brew services or Homebrew clusters.
set -euo pipefail
repo_dir="$(cd "$(dirname "$0")/.." && pwd)"
pg_bin="${IRL_PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}"
pg_data="$repo_dir/data/postgres"
pg_socket="$repo_dir/data/pgsocket"
pg_port=54329
if [[ "${1:-start}" == stop ]]; then
  "$pg_bin/pg_ctl" -D "$pg_data" -m fast -w stop
  exit 0
fi
mkdir -p "$pg_data" "$pg_socket"
chmod 700 "$pg_data" "$pg_socket"
if [[ ! -f "$pg_data/PG_VERSION" ]]; then
  "$pg_bin/initdb" -D "$pg_data" --encoding=UTF8 --locale=C --auth-local=trust --auth-host=trust
  cat > "$pg_data/pg_hba.conf" <<'HBA'
# Assessment instance accepts only Unix socket and IPv4 loopback connections.
local all all trust
host all all 127.0.0.1/32 trust
HBA
fi
if ! "$pg_bin/pg_ctl" -D "$pg_data" status >/dev/null 2>&1; then
  "$pg_bin/pg_ctl" -D "$pg_data" -l "$repo_dir/data/postgres.log" \
    -o "-h 127.0.0.1 -p $pg_port -k $pg_socket" -w start
fi
if [[ "$("$pg_bin/psql" -h "$pg_socket" -p "$pg_port" -d postgres -Atqc "SELECT 1 FROM pg_database WHERE datname='irl'")" != 1 ]]; then
  "$pg_bin/createdb" -h "$pg_socket" -p "$pg_port" irl
fi
"$pg_bin/psql" -h "$pg_socket" -p "$pg_port" -d irl -v ON_ERROR_STOP=1 -c 'CREATE EXTENSION IF NOT EXISTS vector;'
printf 'Database ready: postgresql://%s@127.0.0.1:%s/irl\n' "$(id -un)" "$pg_port"
