#!/usr/bin/env bash
# Serve Spotted on https://spotted.haciensus.com next to https://framer.haciensus.com.
#
# Run it yourself from cloudflare/:  bash scripts/spotted-subdomain.sh
#
# What it does, in this order (each step asks first, and is skipped if already done):
#   1. Cloudflare Access: creates a new Access application for spotted.haciensus.com with the same
#      sign-in rules as the one protecting framer.haciensus.com (reusable policies by reference,
#      app-specific ones copied rule for rule). The existing application is never modified.
#   2. Google OAuth: opens the Google Cloud console and waits while you add the redirect URI
#      (Google has no API for this).
#   3. R2 CORS: allows browser uploads from the new origin (r2-cors.json).
#   4. Worker custom domain: attaches spotted.haciensus.com to the framer-cf-api Worker, then
#      checks from outside that it redirects to the Access login. If it does not, the domain is
#      detached again at once, so the site is never left public.
#
# Needs: curl, python3, and `npx wrangler` logged in (for steps 3-4).
# Step 1 needs a Cloudflare API token with "Access: Apps and Policies - Edit" on the account
# (dashboard: My Profile -> API Tokens). Pass it as CLOUDFLARE_ACCESS_TOKEN or paste it when
# asked; it is never printed or saved.
set -euo pipefail

ACCOUNT_ID=0187f7c38bf35a8abcc4e9f9abfa213e
ZONE=haciensus.com
OLD=framer.haciensus.com
NEW=spotted.haciensus.com
WORKER=framer-cf-api
BUCKET=framer-cf-videos
API=https://api.cloudflare.com/client/v4
GOOGLE_CONSOLE="https://console.cloud.google.com/apis/credentials?project=framer-511620"

cd "$(dirname "$0")/.."
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
bold() { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die() { printf '  \033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
ask() { local a; read -r -p "  $1 [y/N] " a; [[ "$a" =~ ^[Yy]$ ]]; }
# cf <token> <method> <path> [body-file]  -> response JSON on stdout; dies on API errors
cf() {
  local token=$1 method=$2 path=$3 body=${4:-}
  local out; out=$(curl -sS -X "$method" "$API$path" -H "Authorization: Bearer $token" -H 'Content-Type: application/json' ${body:+--data @"$body"})
  python3 -c 'import json,sys; d=json.loads(sys.argv[1]); sys.exit(0 if d.get("success") else (print("Cloudflare API: " + "; ".join(e.get("message","?") for e in d.get("errors") or []), file=sys.stderr) or 1))' "$out" || return 1
  printf '%s' "$out"
}

# ---------------------------------------------------------------- 1. Cloudflare Access
bold "1/4  Cloudflare Access: protect $NEW with the same rules as $OLD"
if [[ -z "${CLOUDFLARE_ACCESS_TOKEN:-}" ]]; then
  read -r -s -p "  Cloudflare API token (Access: Apps and Policies - Edit), input hidden: " CLOUDFLARE_ACCESS_TOKEN; echo
fi
[[ -n "$CLOUDFLARE_ACCESS_TOKEN" ]] || die "No token given."
cf "$CLOUDFLARE_ACCESS_TOKEN" GET "/accounts/$ACCOUNT_ID/access/apps?per_page=100" > "$WORK/apps.json" || die "Could not list Access applications (check the token's permissions)."
python3 - "$WORK/apps.json" "$OLD" "$NEW" "$WORK/create.json" > "$WORK/app.env" <<'PY' || die "No Access application protects $OLD in this account."
import json, sys
apps, old, new, out = json.load(open(sys.argv[1]))["result"], sys.argv[2], sys.argv[3], sys.argv[4]
def hosts(a):
    h = [d.get("uri", "") for d in a.get("destinations") or [] if d.get("type", "public") == "public"]
    h += list(a.get("self_hosted_domains") or []) + [a.get("domain") or ""]
    return {x.split("/")[0] for x in h if x}
covering = [a for a in apps if new in hosts(a)]
src = next((a for a in apps if old in hosts(a)), None)
if src is None: sys.exit(1)
policies = []
for i, p in enumerate(sorted(src.get("policies") or [], key=lambda p: p.get("precedence", 0))):
    if p.get("reusable"):
        policies.append({"id": p["id"], "precedence": i + 1})
    else:  # app-scoped (legacy) policy: copy its rules
        policies.append({k: p[k] for k in ("name", "decision", "include", "exclude", "require", "session_duration",
                                          "purpose_justification_required", "approval_required", "isolation_required") if k in p} | {"precedence": i + 1})
body = {"name": "Spotted", "type": src.get("type", "self_hosted"), "domain": new, "policies": policies}
for k in ("session_duration", "allowed_idps", "auto_redirect_to_identity", "app_launcher_visible", "same_site_cookie_attribute",
          "http_only_cookie_attribute", "enable_binding_cookie", "skip_interstitial", "options_preflight_bypass"):
    if k in src: body[k] = src[k]
json.dump(body, open(out, "w"))
print(f"SRC_NAME={json.dumps(src.get('name',''))}")
print(f"SRC_RULES={json.dumps(json.dumps([{k: p.get(k) for k in ('decision','include','exclude','require')} for p in sorted(src.get('policies') or [], key=lambda p: p.get('precedence',0))], sort_keys=True))}")
print(f"N_POLICIES={len(policies)}")
print(f"COVERED_BY={json.dumps(', '.join(a.get('name','?') for a in covering))}")
PY
# shellcheck disable=SC1091
source "$WORK/app.env"
ok "$OLD is protected by: $SRC_NAME ($N_POLICIES policies)"
[[ "$N_POLICIES" -gt 0 ]] || die "That application has no policies; refusing to copy it."
if [[ -n "$COVERED_BY" ]]; then
  ok "$NEW is already protected by: $COVERED_BY"
else
  ask "Create Access application \"Spotted\" for $NEW with the same $N_POLICIES policies (\"$SRC_NAME\" is not changed)?" || die "Stopped before changing Access."
  cf "$CLOUDFLARE_ACCESS_TOKEN" POST "/accounts/$ACCOUNT_ID/access/apps" "$WORK/create.json" > "$WORK/created.json" || die "Cloudflare rejected the new application; nothing was changed."
  python3 - "$WORK/created.json" "$NEW" "$SRC_RULES" <<'PY' || die "The new application does not match the original rules. Delete \"Spotted\" in Zero Trust -> Access -> Applications before continuing."
import json, sys
a, new, want = json.load(open(sys.argv[1]))["result"], sys.argv[2], json.loads(sys.argv[3])
got = [{k: p.get(k) for k in ("decision", "include", "exclude", "require")} for p in sorted(a.get("policies") or [], key=lambda p: p.get("precedence", 0))]
assert (a.get("domain") or "").split("/")[0] == new, f"domain is {a.get('domain')}"
assert json.dumps(got, sort_keys=True) == json.dumps(want, sort_keys=True), "policy rules differ"
print(f"  \033[32m✓\033[0m Created \"{a.get('name')}\" for {new} with the same {len(got)} policy rule(s).")
PY
fi

# ---------------------------------------------------------------- 2. Google OAuth redirect URI
bold "2/4  Google OAuth: allow sign-in redirects to $NEW"
echo "  In the Google Cloud console (opening now), open the OAuth client \"Framer app\" and under"
echo "  \"Authorized redirect URIs\" add:"
echo "      https://$NEW/oauth/google/callback"
echo "  Keep the framer.haciensus.com one. Then Save. (Optional: OAuth consent screen -> app name \"Spotted\".)"
command -v open > /dev/null && open "$GOOGLE_CONSOLE" || echo "  Open: $GOOGLE_CONSOLE"
read -r -p "  Press Enter when it is saved (or Ctrl-C to stop here)... " _

# ---------------------------------------------------------------- 3. R2 CORS
bold "3/4  R2: allow browser uploads from https://$NEW"
grep -q "https://$NEW" r2-cors.json || die "r2-cors.json does not list https://$NEW."
if ask "Apply r2-cors.json to the bucket $BUCKET?"; then
  npx wrangler r2 bucket cors set "$BUCKET" --file r2-cors.json --force > /dev/null && ok "CORS updated." || die "Could not update CORS."
else warn "Skipped; uploads from $NEW will fail until CORS allows it."; fi

# ---------------------------------------------------------------- 4. Worker custom domain + check
bold "4/4  Attach $NEW to the Worker $WORKER, and check it is behind Access"
WTOKEN=$(npx wrangler auth token 2>/dev/null | tail -1) || die "Log in first: npx wrangler login"
cf "$WTOKEN" GET "/accounts/$ACCOUNT_ID/workers/domains" > "$WORK/domains.json" || die "Could not list Worker domains."
eval "$(python3 - "$WORK/domains.json" "$OLD" "$NEW" <<'PY'
import json, sys
ds, old, new = json.load(open(sys.argv[1]))["result"], sys.argv[2], sys.argv[3]
o = next((d for d in ds if d["hostname"] == old), None); n = next((d for d in ds if d["hostname"] == new), None)
print(f"ZONE_ID={o['zone_id'] if o else ''}; NEW_DOMAIN_ID={n['id'] if n else ''}; NEW_SERVICE={n['service'] if n else ''}")
PY
)"
[[ -n "$ZONE_ID" ]] || die "Could not find the zone of $OLD."
if [[ -n "$NEW_DOMAIN_ID" ]]; then
  [[ "$NEW_SERVICE" == "$WORKER" ]] || die "$NEW is attached to another Worker ($NEW_SERVICE); not touching it."
  ok "$NEW is already attached to $WORKER."
else
  ask "Attach $NEW to $WORKER now?" || die "Stopped before attaching the domain."
  printf '{"hostname":"%s","service":"%s","environment":"production","zone_id":"%s"}' "$NEW" "$WORKER" "$ZONE_ID" > "$WORK/domain.json"
  cf "$WTOKEN" PUT "/accounts/$ACCOUNT_ID/workers/domains" "$WORK/domain.json" > "$WORK/attached.json" || die "Could not attach the domain."
  NEW_DOMAIN_ID=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["result"]["id"])' "$WORK/attached.json")
  ok "Attached (certificate and DNS may take a minute)."
fi
detach() {
  cf "$WTOKEN" DELETE "/accounts/$ACCOUNT_ID/workers/domains/$NEW_DOMAIN_ID" > /dev/null && warn "Detached $NEW again." || warn "COULD NOT DETACH $NEW: remove it in the dashboard (Workers -> $WORKER -> Domains) now."
}
echo "  Checking https://$NEW from outside (up to 5 minutes)..."
for i in $(seq 1 60); do
  res=$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' --max-time 10 "https://$NEW/health" || true)
  code=${res%% *}; loc=${res#* }
  if [[ "$code" =~ ^30[1278]$ && "$loc" == *cloudflareaccess.com* ]]; then
    ok "Protected: https://$NEW redirects to the Access login."
    bold "Done. Open https://$NEW, sign in, and use Connect Google once there to check the redirect."
    exit 0
  fi
  # 2xx, 4xx or a redirect elsewhere = served without Access. 000 (no TLS/DNS yet) and 5xx (certificate
  # or origin still settling) mean "not ready": keep waiting.
  if [[ "$code" =~ ^(2[0-9][0-9]|3[0-9][0-9]|4[0-9][0-9])$ ]]; then
    warn "https://$NEW answered $code without the Access login: it is NOT protected."
    detach; die "Add $NEW to the Access application (step 1), then run this script again."
  fi
  sleep 5
done
warn "https://$NEW did not answer within 5 minutes (DNS or certificate still pending)."
detach; die "Run the script again in a few minutes; it is safe to repeat."
