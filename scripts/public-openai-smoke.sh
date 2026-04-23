#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-https://gw.instmarket.com.au}"
COMPOSE_PROJECT="${COMPOSE_PROJECT:-codex_gateway_test}"
COMPOSE_FILE="${COMPOSE_FILE:-compose.azure.yml}"
GATEWAY_SERVICE="${GATEWAY_SERVICE:-gateway}"
GATEWAY_DB="${GATEWAY_DB:-/var/lib/codex-gateway/gateway.db}"
HTTP_TIMEOUT_SECONDS="${HTTP_TIMEOUT_SECONDS:-20}"
MODEL_TIMEOUT_SECONDS="${MODEL_TIMEOUT_SECONDS:-180}"

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

assert_json() {
  local file="$1"
  local script="$2"
  node -e "const fs = require('fs'); const x = JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); $script" "$file"
}

request_id_from_headers() {
  local headers_file="$1"
  awk 'tolower($1) == "x-request-id:" { print $2 }' "$headers_file" | tr -d '\r' | tail -n 1
}

require_request_id() {
  local name="$1"
  local headers_file="$2"
  local request_id
  request_id="$(request_id_from_headers "$headers_file")"
  if [ -z "$request_id" ]; then
    echo "error=missing_x_request_id step=$name" >&2
    return 1
  fi
  echo "$name=request_id:$request_id"
}

tmp_dir="$(mktemp -d)"
token=""
prefix=""
user_id="openai-public-smoke-$(date +%s)"

cleanup() {
  rm -rf "$tmp_dir"
  if [ -n "$prefix" ]; then
    admin revoke "$prefix" >/dev/null 2>&1 || true
  fi
  if [ -n "$user_id" ]; then
    admin disable-user "$user_id" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

issue_json="$(
  admin issue \
    --user "$user_id" \
    --user-label "$user_id" \
    --label public-openai-smoke \
    --scope code \
    --expires-days 1 \
    --rpm 10 \
    --rpd 50 \
    --concurrent 1
)"
token="$(printf '%s' "$issue_json" | json_field 'x.token')"
prefix="$(printf '%s' "$issue_json" | json_field 'x.credential.prefix')"

echo "temp_user=$user_id"
echo "temp_prefix=$prefix"

curl -fsS --max-time "$HTTP_TIMEOUT_SECONDS" \
  -D "$tmp_dir/health.headers" \
  -o "$tmp_dir/health.json" \
  "$BASE_URL/gateway/health"
assert_json "$tmp_dir/health.json" 'if (x.state !== "ready" || x.auth_mode !== "credential") process.exit(1);'
require_request_id "health" "$tmp_dir/health.headers" >/dev/null
echo "health=ok"

unauth_status="$(
  curl -sS --max-time "$HTTP_TIMEOUT_SECONDS" \
    -D "$tmp_dir/unauth.headers" \
    -o "$tmp_dir/unauth.json" \
    -w "%{http_code}" \
    "$BASE_URL/v1/models"
)"
if [ "$unauth_status" != "401" ]; then
  echo "error=unexpected_unauth_status status=$unauth_status" >&2
  exit 1
fi
assert_json "$tmp_dir/unauth.json" 'if (x.error?.type !== "authentication_error") process.exit(1);'
require_request_id "unauth_v1_models" "$tmp_dir/unauth.headers" >/dev/null
echo "unauth_v1_models=ok"

bad_model_status="$(
  curl -sS --max-time "$HTTP_TIMEOUT_SECONDS" \
    -D "$tmp_dir/bad-model.headers" \
    -o "$tmp_dir/bad-model.json" \
    -w "%{http_code}" \
    -H "Authorization: Bearer $token" \
    -H "Content-Type: application/json" \
    --data '{"model":"gpt-4","messages":[{"role":"user","content":"hello"}]}' \
    "$BASE_URL/v1/chat/completions"
)"
if [ "$bad_model_status" != "404" ]; then
  echo "error=unexpected_bad_model_status status=$bad_model_status" >&2
  exit 1
fi
assert_json "$tmp_dir/bad-model.json" 'if (x.error?.code !== "model_not_found" || x.error?.type !== "invalid_request_error") process.exit(1);'
require_request_id "bad_model" "$tmp_dir/bad-model.headers" >/dev/null
echo "bad_model=ok"

curl -fsS --max-time "$HTTP_TIMEOUT_SECONDS" \
  -D "$tmp_dir/models.headers" \
  -o "$tmp_dir/models.json" \
  -H "Authorization: Bearer $token" \
  "$BASE_URL/v1/models"
assert_json "$tmp_dir/models.json" 'const m = x.data?.[0]; if (m?.id !== "medcode" || m?.context_window !== 272000) process.exit(1);'
models_request_id="$(require_request_id "models" "$tmp_dir/models.headers")"
echo "models=ok ${models_request_id}"

curl -fsS --max-time "$MODEL_TIMEOUT_SECONDS" \
  -D "$tmp_dir/chat.headers" \
  -o "$tmp_dir/chat.json" \
  -H "Authorization: Bearer $token" \
  -H "Content-Type: application/json" \
  --data '{"model":"medcode","messages":[{"role":"user","content":"Reply with exactly: medcode-chat-ok"}]}' \
  "$BASE_URL/v1/chat/completions"
assert_json "$tmp_dir/chat.json" 'const c = x.choices?.[0]?.message?.content?.trim(); if (c !== "medcode-chat-ok") { console.error(c); process.exit(1); }'
chat_request_id="$(require_request_id "chat" "$tmp_dir/chat.headers")"
chat_usage="$(node -e 'const fs = require("fs"); const x = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); process.stdout.write(x.usage ? "present" : "null");' "$tmp_dir/chat.json")"
echo "chat=ok usage=$chat_usage ${chat_request_id}"

curl -fsS --max-time "$MODEL_TIMEOUT_SECONDS" \
  -D "$tmp_dir/tool-history.headers" \
  -o "$tmp_dir/tool-history.json" \
  -H "Authorization: Bearer $token" \
  -H "Content-Type: application/json" \
  --data '{"model":"medcode","messages":[{"role":"user","content":"List files."},{"role":"assistant","content":null,"tool_calls":[{"id":"call_smoke","type":"function","function":{"name":"bash","arguments":"{\"command\":\"ls\"}"}}]},{"role":"tool","tool_call_id":"call_smoke","content":"package.json\nsrc"},{"role":"user","content":"Reply with exactly: medcode-tool-history-ok"}]}' \
  "$BASE_URL/v1/chat/completions"
assert_json "$tmp_dir/tool-history.json" 'const c = x.choices?.[0]?.message?.content?.trim(); if (c !== "medcode-tool-history-ok") { console.error(c); process.exit(1); }'
tool_request_id="$(require_request_id "tool_history" "$tmp_dir/tool-history.headers")"
tool_usage="$(node -e 'const fs = require("fs"); const x = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); process.stdout.write(x.usage ? "present" : "null");' "$tmp_dir/tool-history.json")"
echo "tool_history=ok usage=$tool_usage ${tool_request_id}"

curl -N -sS --max-time "$MODEL_TIMEOUT_SECONDS" \
  -D "$tmp_dir/stream.headers" \
  -o "$tmp_dir/stream.sse" \
  -H "Authorization: Bearer $token" \
  -H "Content-Type: application/json" \
  --data '{"model":"medcode","stream":true,"messages":[{"role":"user","content":"Reply with exactly: medcode-stream-ok"}]}' \
  "$BASE_URL/v1/chat/completions"
node -e '
const fs = require("fs");
const s = fs.readFileSync(process.argv[1], "utf8");
const frames = s.split("\n\n").map((f) => f.trim()).filter(Boolean);
let text = "";
let done = false;
for (const frame of frames) {
  if (!frame.startsWith("data: ")) continue;
  const data = frame.slice(6);
  if (data === "[DONE]") {
    done = true;
    continue;
  }
  const x = JSON.parse(data);
  text += x.choices?.[0]?.delta?.content ?? "";
}
if (text.trim() !== "medcode-stream-ok" || !done) {
  console.error(text);
  process.exit(1);
}
' "$tmp_dir/stream.sse"
stream_request_id="$(require_request_id "stream" "$tmp_dir/stream.headers")"
echo "stream=ok ${stream_request_id}"

cleanup
trap - EXIT
echo "cleanup=ok"
