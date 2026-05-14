#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-https://gw.instmarket.com.au}"
COMPOSE_PROJECT="${COMPOSE_PROJECT:-codex_gateway_test}"
COMPOSE_FILE="${COMPOSE_FILE:-compose.azure.yml}"
GATEWAY_SERVICE="${GATEWAY_SERVICE:-gateway}"
GATEWAY_DB="${GATEWAY_DB:-/var/lib/codex-gateway/gateway.db}"
TARGET_ACCOUNT="${TARGET_ACCOUNT:-codex-pro-1}"
PLAN_ID="${PLAN_ID:-plan_paid_monthly_v1}"
HTTP_TIMEOUT_SECONDS="${HTTP_TIMEOUT_SECONDS:-240}"

if ! command -v node >/dev/null 2>&1 && [ -x "$HOME/.local/codex-gateway-node/bin/node" ]; then
  export PATH="$HOME/.local/codex-gateway-node/bin:$PATH"
fi

if ! command -v node >/dev/null 2>&1; then
  echo "error=node_not_found" >&2
  exit 1
fi

if [ ! -f "$COMPOSE_FILE" ]; then
  echo "error=compose_file_not_found path=$COMPOSE_FILE" >&2
  exit 1
fi

if [ -n "${COMPOSE_COMMAND:-}" ]; then
  read -r -a COMPOSE_BIN <<< "$COMPOSE_COMMAND"
else
  COMPOSE_BIN=(sudo docker compose)
fi

compose() {
  "${COMPOSE_BIN[@]}" -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" "$@"
}

admin() {
  compose exec -T "$GATEWAY_SERVICE" node apps/admin-cli/dist/index.js --db "$GATEWAY_DB" "$@" < /dev/null
}

json_field() {
  local expression="$1"
  node -e "let s=''; process.stdin.on('data', d => s += d); process.stdin.on('end', () => { const x = JSON.parse(s); const value = $expression; if (value === undefined || value === null) process.exit(2); process.stdout.write(String(value)); });"
}

request_id_from_headers() {
  local headers_file="$1"
  awk 'tolower($1) == "x-request-id:" { print $2 }' "$headers_file" | tr -d '\r' | tail -n 1
}

choose_account() {
  local credential_id="$1"
  node - "$credential_id" <<'NODE'
const crypto = require("crypto");
const credentialId = process.argv[2];
const accounts = ["sub_openai_codex_dev", "codex-pro-1"];
let best = accounts[0];
let bestScore = "";
for (const account of accounts) {
  const score = crypto
    .createHash("sha256")
    .update(credentialId)
    .update(Buffer.from([0]))
    .update(account)
    .digest("hex");
  if (score > bestScore) {
    best = account;
    bestScore = score;
  }
}
process.stdout.write(best);
NODE
}

tmp_dir="$(mktemp -d)"
selected_user=""
selected_prefix=""
selected_token=""
issued_users=()
issued_prefixes=()

cleanup() {
  rm -rf "$tmp_dir"
  for prefix in "${issued_prefixes[@]}"; do
    [ -n "$prefix" ] && admin revoke "$prefix" >/dev/null 2>&1 || true
  done
  for user_id in "${issued_users[@]}"; do
    [ -n "$user_id" ] && admin disable-user "$user_id" >/dev/null 2>&1 || true
  done
}
trap cleanup EXIT

for attempt in $(seq 1 12); do
  user_id="image-plus-smoke-$(date +%s)-$attempt"
  issue_json="$(
    admin issue \
      --user "$user_id" \
      --user-label "$user_id" \
      --label image-plus-smoke \
      --scope code \
      --expires-days 1 \
      --rpm 3 \
      --rpd 10 \
      --concurrent 1
  )"
  token="$(printf '%s' "$issue_json" | json_field 'x.token')"
  prefix="$(printf '%s' "$issue_json" | json_field 'x.credential.prefix')"
  credential_id="$(printf '%s' "$issue_json" | json_field 'x.credential.id')"
  issued_users+=("$user_id")
  issued_prefixes+=("$prefix")

  account="$(choose_account "$credential_id")"
  if [ "$account" = "$TARGET_ACCOUNT" ]; then
    selected_user="$user_id"
    selected_prefix="$prefix"
    selected_token="$token"
    break
  fi
done

if [ -z "$selected_token" ]; then
  echo "error=could_not_select_target_account target=$TARGET_ACCOUNT" >&2
  exit 1
fi

echo "image_temp_user=$selected_user"
echo "image_temp_prefix=$selected_prefix"
echo "image_expected_account=$TARGET_ACCOUNT"

admin entitlement grant \
  --user "$selected_user" \
  --plan "$PLAN_ID" \
  --period one_off \
  --duration 1h \
  --replace >/dev/null

image_status="$(
  curl -sS --max-time "$HTTP_TIMEOUT_SECONDS" \
  -D "$tmp_dir/image.headers" \
  -o "$tmp_dir/image.json" \
  -w "%{http_code}" \
  -H "Authorization: Bearer $selected_token" \
  -H "Content-Type: application/json" \
  --data '{"model":"medcode-image-default","prompt":"Create a simple medical app test image: a blue circle on a white background, flat icon style.","size":"1024x1024","quality":"auto","output_format":"png","metadata":{"client":"p4c-plus-image-smoke"}}' \
  "$BASE_URL/gateway/images/generations"
)"

if [ "$image_status" != "200" ]; then
  echo "image_http_status=$image_status"
  node -e '
const fs = require("fs");
const x = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const err = x.error || {};
console.log("image_error_code=" + (err.code || "null"));
console.log("image_error_message=" + (err.message || "null"));
' "$tmp_dir/image.json"
  exit 1
fi

node -e '
const fs = require("fs");
const x = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (!String(x.id || "").startsWith("imgreq_")) process.exit(1);
const item = x.data && x.data[0];
if (!item || typeof item.b64_json !== "string" || item.b64_json.length < 100 || item.mime_type !== "image/png") {
  process.exit(1);
}
process.stdout.write("image_response=ok bytes_b64=" + item.b64_json.length + " usage=" + (x.usage ? "present" : "null") + "\n");
' "$tmp_dir/image.json"

request_id="$(request_id_from_headers "$tmp_dir/image.headers")"
if [ -z "$request_id" ]; then
  echo "error=missing_image_request_id" >&2
  exit 1
fi

sleep 1
event_json="$(
  compose exec -T "$GATEWAY_SERVICE" node --experimental-sqlite -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync("/var/lib/codex-gateway/gateway.db", { readonly: true });
const requestId = process.argv[1];
const row = db.prepare("select request_id, upstream_account_id, provider, status, error_code from request_events where request_id = ?").get(requestId);
if (!row) process.exit(2);
process.stdout.write(JSON.stringify(row));
' "$request_id"
)"

echo "image_request_id=$request_id"
echo "image_event=$event_json"
node -e 'const row = JSON.parse(process.argv[1]); if (row.upstream_account_id !== process.argv[2] || row.status !== "ok") process.exit(1);' "$event_json" "$TARGET_ACCOUNT"
echo "image_target_smoke=ok"

cleanup
trap - EXIT
echo "cleanup=ok"
