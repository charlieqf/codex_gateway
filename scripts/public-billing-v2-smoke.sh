#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-https://gw.instmarket.com.au}"
COMPOSE_PROJECT="${COMPOSE_PROJECT:-codex_gateway_test}"
COMPOSE_FILE="${COMPOSE_FILE:-compose.azure.yml}"
GATEWAY_SERVICE="${GATEWAY_SERVICE:-gateway}"
HTTP_TIMEOUT_SECONDS="${HTTP_TIMEOUT_SECONDS:-20}"
RUN_DISABLE_CLEANUP="${RUN_DISABLE_CLEANUP:-1}"

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

container_env() {
  compose exec -T "$GATEWAY_SERVICE" printenv "$1" < /dev/null
}

json_field() {
  local expression="$1"
  node -e "let s=''; process.stdin.on('data', d => s += d); process.stdin.on('end', () => { const x = JSON.parse(s); const value = $expression; if (value === undefined || value === null) process.exit(2); process.stdout.write(String(value)); });"
}

assert_json() {
  local file="$1"
  local script="$2"
  shift 2
  node -e "const fs = require('fs'); const x = JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); $script" "$file" "$@"
}

require_env() {
  local name="$1"
  if ! container_env "$name" >/dev/null 2>&1; then
    echo "error=missing_container_env name=$name" >&2
    exit 1
  fi
}

require_env GATEWAY_BILLING_ADMIN_TOKEN
require_env GATEWAY_API_KEY_ENCRYPTION_SECRET
require_env GATEWAY_UPSTREAM_V2_BASE_URL
require_env GATEWAY_UPSTREAM_V2_TOKEN

tmp_dir="$(mktemp -d)"
billing_token="$(container_env GATEWAY_BILLING_ADMIN_TOKEN)"
provider="codex_gateway_v2_smoke"
external_user_id="v2_smoke_$(date +%s)"
subject_id=""
cleanup_done="0"

disable_subject() {
  if [ "$RUN_DISABLE_CLEANUP" != "1" ] || [ -z "$subject_id" ] || [ "$cleanup_done" = "1" ]; then
    return 0
  fi
  local payload="$tmp_dir/disable.json"
  cat > "$payload" <<JSON
{"reason":"v2_joint_smoke_cleanup"}
JSON
  curl -sS --max-time "$HTTP_TIMEOUT_SECONDS" \
    -o "$tmp_dir/disable-cleanup.json" \
    -H "Authorization: Bearer $billing_token" \
    -H "Content-Type: application/json" \
    -H "Idempotency-Key: $provider:$subject_id:disable_subject:cleanup" \
    --data @"$payload" \
    "$BASE_URL/gateway/admin/billing/v1/subjects/$subject_id/disable" >/dev/null || true
  cleanup_done="1"
}

cleanup() {
  disable_subject
  rm -rf "$tmp_dir"
}
trap cleanup EXIT

cat > "$tmp_dir/create.json" <<JSON
{
  "provider": "$provider",
  "external_user_id": "$external_user_id",
  "display_name": "V2 Smoke",
  "scope_allowlist": ["code"],
  "metadata": {
    "purpose": "v2_joint_smoke"
  }
}
JSON

create_status="$(
  curl -sS --max-time "$HTTP_TIMEOUT_SECONDS" \
    -D "$tmp_dir/create.headers" \
    -o "$tmp_dir/create-result.json" \
    -w "%{http_code}" \
    -H "Authorization: Bearer $billing_token" \
    -H "Content-Type: application/json" \
    -H "Idempotency-Key: $provider:$external_user_id:create_subject" \
    --data @"$tmp_dir/create.json" \
    "$BASE_URL/gateway/admin/billing/v1/subjects"
)"
if [ "$create_status" != "200" ]; then
  node -e 'const fs=require("fs"); const x=JSON.parse(fs.readFileSync(process.argv[1], "utf8")); console.error(`error=create_failed status=${process.argv[2]} code=${x.error?.code ?? "unknown"}`);' "$tmp_dir/create-result.json" "$create_status"
  exit 1
fi

subject_id="$(cat "$tmp_dir/create-result.json" | json_field 'x.subject.id')"
unified_key="$(cat "$tmp_dir/create-result.json" | json_field 'x.credential.key')"
unified_prefix="$(cat "$tmp_dir/create-result.json" | json_field 'x.credential.key_prefix')"
assert_json "$tmp_dir/create-result.json" 'if (x.created !== true || x.idempotent_replay !== false || !x.credential?.key?.startsWith("cgu_live_") || !x.credential?.key_prefix?.startsWith("cgu_live_")) process.exit(1);'
echo "create_subject=ok subject=$subject_id key_prefix=$unified_prefix"

curl -fsS --max-time "$HTTP_TIMEOUT_SECONDS" \
  -D "$tmp_dir/resolve.headers" \
  -o "$tmp_dir/resolve.json" \
  -H "Authorization: Bearer $unified_key" \
  -H "Content-Type: application/json" \
  --data '{}' \
  "$BASE_URL/gateway/unified-keys/resolve"
assert_json "$tmp_dir/resolve.json" 'if (x.valid !== true || x.subject?.id !== process.argv[2] || !x.medevidence?.api_key || !x.medevidence?.key_prefix) process.exit(1);' "$subject_id"
medevidence_prefix="$(cat "$tmp_dir/resolve.json" | json_field 'x.medevidence.key_prefix')"
echo "resolve_unified_key=ok medevidence_key_prefix=$medevidence_prefix"

curl -fsS --max-time "$HTTP_TIMEOUT_SECONDS" \
  -D "$tmp_dir/replay.headers" \
  -o "$tmp_dir/replay.json" \
  -H "Authorization: Bearer $billing_token" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $provider:$external_user_id:create_subject" \
  --data @"$tmp_dir/create.json" \
  "$BASE_URL/gateway/admin/billing/v1/subjects"
assert_json "$tmp_dir/replay.json" 'if (x.idempotent_replay !== true || x.credential?.key !== undefined || x.subject?.id !== process.argv[2]) process.exit(1);' "$subject_id"
echo "gateway_idempotent_replay=ok"

duplicate_status="$(
  curl -sS --max-time "$HTTP_TIMEOUT_SECONDS" \
    -D "$tmp_dir/duplicate.headers" \
    -o "$tmp_dir/duplicate.json" \
    -w "%{http_code}" \
    -H "Authorization: Bearer $billing_token" \
    -H "Content-Type: application/json" \
    -H "Idempotency-Key: $provider:$external_user_id:create_subject:duplicate" \
    --data @"$tmp_dir/create.json" \
    "$BASE_URL/gateway/admin/billing/v1/subjects"
)"
if [ "$duplicate_status" != "409" ]; then
  echo "error=unexpected_duplicate_status status=$duplicate_status" >&2
  exit 1
fi
assert_json "$tmp_dir/duplicate.json" 'if (x.error?.code !== "subject_already_exists") process.exit(1);'
echo "gateway_duplicate_external_user=ok"

if [ "$RUN_DISABLE_CLEANUP" = "1" ]; then
  cat > "$tmp_dir/disable.json" <<JSON
{"reason":"v2_joint_smoke_cleanup"}
JSON
  curl -fsS --max-time "$HTTP_TIMEOUT_SECONDS" \
    -D "$tmp_dir/disable.headers" \
    -o "$tmp_dir/disable.json.out" \
    -H "Authorization: Bearer $billing_token" \
    -H "Content-Type: application/json" \
    -H "Idempotency-Key: $provider:$subject_id:disable_subject:cleanup" \
    --data @"$tmp_dir/disable.json" \
    "$BASE_URL/gateway/admin/billing/v1/subjects/$subject_id/disable"
  assert_json "$tmp_dir/disable.json.out" 'if (x.disabled !== true || x.subject?.state !== "disabled") process.exit(1);'
  cleanup_done="1"
  echo "disable_cleanup=ok"
else
  echo "disable_cleanup=skipped subject=$subject_id"
fi

trap - EXIT
rm -rf "$tmp_dir"
