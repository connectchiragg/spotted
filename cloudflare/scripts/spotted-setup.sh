#!/usr/bin/env bash
# Finish moving the app to Spotted: https://spotted.haciensus.com on the spotted-api Worker.
#
# Run it yourself from cloudflare/:  bash scripts/spotted-setup.sh
# (The data is already copied: D1 spotted-db, R2 spotted-videos, Vectorize spotted-vectors; the
# spotted-api Worker is deployed without a domain. The old site keeps working until cleanup.)
#
# What it does, in this order (each step asks first, and is skipped if already done):
#   1. Cloudflare Access: creates a new Access application "Spotted" for spotted.haciensus.com with
#      the same sign-in rules as the current site's (reusable policies by reference, app-specific ones
#      copied rule for rule). The existing application is not modified.
#   2. Google OAuth: opens the Google Cloud console and waits while you add the redirect URI
#      (Google has no API for this).
#   3. Secrets for spotted-api, never printed: GEMINI_API_KEY, ADMIN_TOKEN and TOKEN_ENC_KEY come
#      from ../.env (the encryption key is checked by decrypting the stored Google token locally;
#      if it does not match, a new one is generated and you reconnect Google once); you paste the
#      Google client secret and a new R2 token for the spotted-videos bucket.
#   4. Worker custom domain: attaches spotted.haciensus.com to spotted-api, then checks from outside
#      that it redirects to the Access login. If it does not, the domain is detached again at once.
#
# Needs: curl, python3, node, openssl, and `npx wrangler` logged in.
# Step 1 needs a Cloudflare API token with "Access: Apps and Policies - Edit" on the account
# (dashboard: My Profile -> API Tokens). Pass it as CLOUDFLARE_ACCESS_TOKEN or paste it when
# asked; it is never printed or saved.
set -euo pipefail

ACCOUNT_ID=0187f7c38bf35a8abcc4e9f9abfa213e
ZONE=haciensus.com
OLD=framer.haciensus.com      # the current site: its Access rules are copied
NEW=spotted.haciensus.com
WORKER=spotted-api
BUCKET=spotted-videos
DB=spotted-db
ENV_FILE=../.env
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
echo "  Leave the existing URI for now (cleanup removes the old site). Then Save. (Optional: OAuth consent screen -> app name \"Spotted\".)"
command -v open > /dev/null && open "$GOOGLE_CONSOLE" || echo "  Open: $GOOGLE_CONSOLE"
read -r -p "  Press Enter when it is saved (or Ctrl-C to stop here)... " _

# ---------------------------------------------------------------- 3. Secrets for spotted-api
bold "3/4  Secrets for $WORKER (values are never printed)"
envget() { [[ -f "$ENV_FILE" ]] && grep -E "^$1=" "$ENV_FILE" | tail -1 | cut -d= -f2- | sed -e 's/^["'"'"']//' -e 's/["'"'"']$//' || true; }
put_secret() {  # name value
  printf '%s' "$2" | npx wrangler secret put "$1" --name "$WORKER" > /dev/null 2>&1 && ok "$1 set." || die "Could not set $1."
}
SECRETS=$(npx wrangler secret list --name "$WORKER" 2>/dev/null || echo '[]')
has() { grep -q "\"$1\"" <<< "$SECRETS"; }
if ask "Set the secrets for $WORKER now? (existing ones are kept unless you choose to replace them)"; then
  # Gemini: the key already in ../.env.
  if has GEMINI_API_KEY; then ok "GEMINI_API_KEY already set."; else
    v=$(envget GEMINI_API_KEY); [[ -n "$v" ]] || { read -r -s -p "  Gemini API key (hidden): " v; echo; }
    put_secret GEMINI_API_KEY "$v"; fi
  # Admin token: reuse, renamed to SPOTTED_ADMIN_TOKEN in ../.env.
  if has ADMIN_TOKEN; then ok "ADMIN_TOKEN already set."; else
    v=$(envget SPOTTED_ADMIN_TOKEN); [[ -n "$v" ]] || v=$(envget FRAMER_ADMIN_TOKEN); [[ -n "$v" ]] || v=$(openssl rand -hex 32)
    put_secret ADMIN_TOKEN "$v"; fi
  # Token encryption key: reuse only if it decrypts the Google token stored in the database.
  if has TOKEN_ENC_KEY; then ok "TOKEN_ENC_KEY already set."; else
    k=$(envget SPOTTED_TOKEN_ENC_KEY); [[ -n "$k" ]] || k=$(envget FRAMER_TOKEN_ENC_KEY)
    sealed=$(npx wrangler d1 execute "$DB" --remote --json --command "SELECT refresh_token_enc FROM google_auth WHERE id=1" 2>/dev/null \
      | python3 -c 'import json,sys; r=json.load(sys.stdin)[0]["results"]; print(r[0]["refresh_token_enc"] if r else "")')
    if [[ -n "$k" && -n "$sealed" ]] && TOKEN_KEY="$k" SEALED="$sealed" node -e '
      const hex = (s) => Uint8Array.from(s.match(/../g).map((b) => parseInt(b, 16)));
      const [v, iv, ct] = process.env.SEALED.split(".");
      crypto.subtle.importKey("raw", hex(process.env.TOKEN_KEY), "AES-GCM", false, ["decrypt"])
        .then((key) => crypto.subtle.decrypt({ name: "AES-GCM", iv: Buffer.from(iv, "base64"), additionalData: new TextEncoder().encode("google-refresh-token") }, key, Buffer.from(ct, "base64")))
        .then(() => process.exit(0), () => process.exit(1));' 2>/dev/null; then
      put_secret TOKEN_ENC_KEY "$k"
      npx wrangler d1 execute "$DB" --remote --command "UPDATE google_auth SET status='connected', error=NULL WHERE id=1" > /dev/null 2>&1 \
        && ok "The key decrypts the stored Google connection: Google stays connected."
    else
      warn "No matching key in $ENV_FILE: generating a new one (Spotted will ask you to reconnect Google once)."
      k=$(openssl rand -hex 32); put_secret TOKEN_ENC_KEY "$k"
    fi
    if [[ -f "$ENV_FILE" ]] && ! grep -q '^SPOTTED_TOKEN_ENC_KEY=' "$ENV_FILE"; then printf 'SPOTTED_TOKEN_ENC_KEY=%s\n' "$k" >> "$ENV_FILE"; fi
  fi
  # Rename the old keys in ../.env (values unchanged).
  if [[ -f "$ENV_FILE" ]]; then
    sed -i.bak -e 's/^FRAMER_ADMIN_TOKEN=/SPOTTED_ADMIN_TOKEN=/' -e '/^FRAMER_TOKEN_ENC_KEY=/d' "$ENV_FILE" && rm -f "$ENV_FILE.bak"
    ok "$ENV_FILE: FRAMER_* keys renamed/removed (SPOTTED_ADMIN_TOKEN, SPOTTED_TOKEN_ENC_KEY)."
  fi
  # Google client secret: from the OAuth client page opened in step 2.
  if has GOOGLE_CLIENT_SECRET; then ok "GOOGLE_CLIENT_SECRET already set."; else
    echo "  Google client secret: on the OAuth client page, copy the client secret (or \"Add secret\" to make a new one)."
    read -r -s -p "  Google client secret (hidden): " v; echo; [[ -n "$v" ]] || die "No Google client secret given."
    put_secret GOOGLE_CLIENT_SECRET "$v"; fi
  # R2 token for the new bucket (presigned upload and playback links).
  if has R2_ACCESS_KEY_ID && has R2_SECRET_ACCESS_KEY; then ok "R2 keys already set."; else
    echo "  R2 token: dashboard -> R2 -> Manage API tokens -> Create API token:"
    echo "    permissions \"Object Read & Write\", apply to the bucket \"$BUCKET\" only. Copy the S3 credentials."
    command -v open > /dev/null && open "https://dash.cloudflare.com/$ACCOUNT_ID/r2/api-tokens" || true
    read -r -s -p "  R2 Access Key ID (hidden): " v; echo; [[ -n "$v" ]] || die "No R2 access key id given."
    put_secret R2_ACCESS_KEY_ID "$v"
    read -r -s -p "  R2 Secret Access Key (hidden): " v; echo; [[ -n "$v" ]] || die "No R2 secret given."
    put_secret R2_SECRET_ACCESS_KEY "$v"; fi
  unset v k sealed
else
  warn "Skipped; $WORKER cannot reach Gemini, Google or R2 links until its secrets are set."
fi

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
    bold "Done. Open https://$NEW and sign in. Then tell Claude, which checks search, Google and uploads before cleanup."
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
