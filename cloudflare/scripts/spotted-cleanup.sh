#!/usr/bin/env bash
# Retire the old site after the move to Spotted. Run it yourself from cloudflare/, ONLY after
# https://spotted.haciensus.com works:  bash scripts/spotted-cleanup.sh
#
# It refuses to start unless spotted.haciensus.com is live behind Access, spotted-api has its four
# secrets, and spotted-db holds everything the old database holds. Then, asking before each step:
#   1. detaches the old domain from the old Worker;
#   2. deletes the old Access application(s) for that domain (never one that covers Spotted);
#   3. deletes the old Workers;
#   4. deletes the old D1 database, Vectorize indexes and R2 bucket. This is permanent: you type
#      a confirmation phrase first.
#   5. lists the Google Cloud console edits that have no API.
# Needs: curl, python3, node, `npx wrangler` logged in, and for step 2 a Cloudflare API token with
# "Access: Apps and Policies - Edit" (CLOUDFLARE_ACCESS_TOKEN or pasted, hidden).
set -euo pipefail

ACCOUNT_ID=0187f7c38bf35a8abcc4e9f9abfa213e
API=https://api.cloudflare.com/client/v4
NEW=spotted.haciensus.com NEW_WORKER=spotted-api NEW_DB=spotted-db NEW_INDEX=spotted-vectors
# The old resources, named only so they can be removed.
OLD_PREFIX=framer
OLD_HOST=$OLD_PREFIX.haciensus.com
OLD_WORKERS=("$OLD_PREFIX-cf-api" "$OLD_PREFIX-cf-smoke" "$OLD_PREFIX")
OLD_DB=$OLD_PREFIX-cf-db
OLD_INDEXES=("$OLD_PREFIX-cf-m3" "$OLD_PREFIX-cf-vectors")
OLD_BUCKET=$OLD_PREFIX-cf-videos

cd "$(dirname "$0")/.."
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
bold() { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die() { printf '  \033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
ask() { local a; read -r -p "  $1 [y/N] " a; [[ "$a" =~ ^[Yy]$ ]]; }
cf() {
  local token=$1 method=$2 path=$3 body=${4:-}
  local out; out=$(curl -sS -X "$method" "$API$path" -H "Authorization: Bearer $token" -H 'Content-Type: application/json' ${body:+--data @"$body"})
  python3 -c 'import json,sys; d=json.loads(sys.argv[1]); sys.exit(0 if d.get("success") else (print("Cloudflare API: " + "; ".join(e.get("message","?") for e in d.get("errors") or []), file=sys.stderr) or 1))' "$out" || return 1
  printf '%s' "$out"
}
d1() { npx wrangler d1 execute "$1" --remote --json --command "$2" 2>/dev/null | python3 -c 'import json,sys; print(json.dumps(json.load(sys.stdin)[0]["results"]))'; }
WTOKEN=$(npx wrangler auth token 2>/dev/null | tail -1) || die "Log in first: npx wrangler login"

# ---------------------------------------------------------------- 0. Is Spotted ready?
bold "0/5  Checking that Spotted is live and complete"
res=$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' --max-time 15 "https://$NEW/health" || true)
[[ "${res%% *}" =~ ^30[1278]$ && "${res#* }" == *cloudflareaccess.com* ]] || die "https://$NEW is not live behind Access yet (run scripts/spotted-setup.sh first)."
ok "https://$NEW is live behind Access."
secrets=$(npx wrangler secret list --name "$NEW_WORKER" 2>/dev/null || echo '[]')
for s in GEMINI_API_KEY GOOGLE_CLIENT_SECRET TOKEN_ENC_KEY ADMIN_TOKEN; do
  grep -q "\"$s\"" <<< "$secrets" || die "$NEW_WORKER is missing the secret $s (run scripts/spotted-setup.sh)."
done
ok "$NEW_WORKER has all four secrets."
if npx wrangler d1 info "$OLD_DB" > /dev/null 2>&1; then
  q="SELECT count(*) n, coalesce(max(updated_at),'') last FROM videos"
  old=$(d1 "$OLD_DB" "$q"); new=$(d1 "$NEW_DB" "$q")
  python3 - "$old" "$new" <<'PY' || die "The old database has videos or changes the new one lacks (the old site was used after the copy). Ask Claude to re-sync before cleanup."
import json, sys
o, n = json.loads(sys.argv[1])[0], json.loads(sys.argv[2])[0]
missing = o["n"] > n["n"] or o["last"] > n["last"]
print(f"  old: {o['n']} videos, last change {o['last'] or '-'}; new: {n['n']} videos, last change {n['last'] or '-'}")
sys.exit(1 if missing else 0)
PY
  ok "Spotted's database has everything the old one has."
fi

# ---------------------------------------------------------------- 1. Old domain
bold "1/5  Detach $OLD_HOST"
cf "$WTOKEN" GET "/accounts/$ACCOUNT_ID/workers/domains" > "$WORK/domains.json" || die "Could not list Worker domains."
DOMAIN_ID=$(python3 -c 'import json,sys; print(next((d["id"] for d in json.load(open(sys.argv[1]))["result"] if d["hostname"]==sys.argv[2]), ""))' "$WORK/domains.json" "$OLD_HOST")
if [[ -z "$DOMAIN_ID" ]]; then ok "$OLD_HOST is not attached to any Worker."
elif ask "Detach $OLD_HOST (the old address stops working)?"; then
  cf "$WTOKEN" DELETE "/accounts/$ACCOUNT_ID/workers/domains/$DOMAIN_ID" > /dev/null && ok "Detached $OLD_HOST." || die "Could not detach $OLD_HOST."
else die "Stopped: the old domain must go before its Access application."; fi

# ---------------------------------------------------------------- 2. Old Access application
bold "2/5  Delete the Access application(s) for $OLD_HOST"
if [[ -z "${CLOUDFLARE_ACCESS_TOKEN:-}" ]]; then
  read -r -s -p "  Cloudflare API token (Access: Apps and Policies - Edit), input hidden: " CLOUDFLARE_ACCESS_TOKEN; echo
fi
cf "$CLOUDFLARE_ACCESS_TOKEN" GET "/accounts/$ACCOUNT_ID/access/apps?per_page=100" > "$WORK/apps.json" || die "Could not list Access applications."
python3 - "$WORK/apps.json" "$OLD_HOST" "$NEW" > "$WORK/old-apps.txt" <<'PY'
import json, sys
apps, old, new = json.load(open(sys.argv[1]))["result"], sys.argv[2], sys.argv[3]
def hosts(a):
    h = [d.get("uri", "") for d in a.get("destinations") or []] + list(a.get("self_hosted_domains") or []) + [a.get("domain") or ""]
    return {x.split("/")[0] for x in h if x}
for a in apps:
    hs = hosts(a)
    if old in hs and new not in hs: print(a["id"], a.get("name", "?"), ",".join(sorted(hs)), sep="\t")
PY
if [[ ! -s "$WORK/old-apps.txt" ]]; then ok "No Access application left for $OLD_HOST."
else
  while IFS=$'\t' read -r id name hs; do
    if ask "Delete Access application \"$name\" ($hs)?"; then
      cf "$CLOUDFLARE_ACCESS_TOKEN" DELETE "/accounts/$ACCOUNT_ID/access/apps/$id" > /dev/null && ok "Deleted \"$name\"." || warn "Could not delete \"$name\"."
    fi
  done < "$WORK/old-apps.txt"
fi

# ---------------------------------------------------------------- 3. Old Workers
bold "3/5  Delete the old Workers: ${OLD_WORKERS[*]}"
cf "$WTOKEN" GET "/accounts/$ACCOUNT_ID/workers/scripts" > "$WORK/scripts.json" || die "Could not list Workers."
for w in "${OLD_WORKERS[@]}"; do
  if ! python3 -c 'import json,sys; sys.exit(0 if any(s["id"]==sys.argv[2] for s in json.load(open(sys.argv[1]))["result"]) else 1)' "$WORK/scripts.json" "$w"; then ok "$w is already gone."; continue; fi
  if ask "Delete Worker $w?"; then npx wrangler delete --name "$w" --force > /dev/null 2>&1 && ok "Deleted $w." || warn "Could not delete $w."; fi
done

# ---------------------------------------------------------------- 4. Old data (permanent)
bold "4/5  Delete the old data: D1 $OLD_DB, Vectorize ${OLD_INDEXES[*]}, R2 $OLD_BUCKET"
echo "  Spotted has its own copies (spotted-db, spotted-vectors, spotted-videos). This cannot be undone."
read -r -p "  Type \"delete $OLD_PREFIX data\" to continue (anything else skips): " phrase
if [[ "$phrase" == "delete $OLD_PREFIX data" ]]; then
  npx wrangler d1 delete "$OLD_DB" -y > /dev/null 2>&1 && ok "Deleted D1 $OLD_DB." || warn "D1 $OLD_DB: already gone or could not delete."
  for i in "${OLD_INDEXES[@]}"; do
    npx wrangler vectorize delete "$i" --force > /dev/null 2>&1 && ok "Deleted Vectorize $i." || warn "Vectorize $i: already gone or could not delete."
  done
  # R2 deletes only empty buckets: remove the objects first (scripts/empty-bucket.mjs).
  if node scripts/empty-bucket.mjs "$OLD_BUCKET" && npx wrangler r2 bucket delete "$OLD_BUCKET" > /dev/null 2>&1; then ok "Deleted R2 $OLD_BUCKET."
  else warn "R2 $OLD_BUCKET: already gone or could not delete."; fi
else
  warn "Skipped; the old data stays (it costs nothing on the free tier)."
fi

# ---------------------------------------------------------------- 5. Google Cloud (no API)
bold "5/5  Google Cloud console (manual, optional)"
echo "  - OAuth client: remove the old redirect URI for $OLD_HOST; rename the client to \"Spotted\"."
echo "  - OAuth consent screen: app name \"Spotted\"."
echo "  - Project settings: display name \"Spotted\" (the project ID cannot be changed)."
bold "Done. Spotted lives at https://$NEW."
