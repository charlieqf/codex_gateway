#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-https://gw.instmarket.com.au}"
COMPOSE_PROJECT="${COMPOSE_PROJECT:-codex_gateway_test}"
COMPOSE_FILE="${COMPOSE_FILE:-compose.azure.yml}"
GATEWAY_SERVICE="${GATEWAY_SERVICE:-gateway}"
GATEWAY_DB="${GATEWAY_DB:-/var/lib/codex-gateway/gateway.db}"
MODEL_TIMEOUT_SECONDS="${MODEL_TIMEOUT_SECONDS:-300}"
SMOKE_MODELS="${SMOKE_MODELS:-expert pro standard}"

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

tmp_dir="$(mktemp -d)"
token=""
prefix=""
user_id="native-tools-smoke-$(date +%s)"

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
    --label public-native-tools-smoke \
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

curl -fsS --max-time 30 \
  -D "$tmp_dir/models.headers" \
  -o "$tmp_dir/models.json" \
  -H "Authorization: Bearer $token" \
  "$BASE_URL/v1/models"

node - "$tmp_dir/models.json" <<'NODE'
const fs = require("node:fs");
const payload = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const ids = payload.data.map((model) => model.id).sort();
for (const required of ["max", "expert", "pro", "standard"]) {
  if (!ids.includes(required)) {
    console.error(`models_missing=${required} ids=${ids.join(",")}`);
    process.exit(1);
  }
}
if (ids.includes("medcode")) {
  console.error(`models_unexpected_legacy_id ids=${ids.join(",")}`);
  process.exit(1);
}
console.log(`models=ok ids=${ids.join(",")}`);
NODE

curl -fsS --max-time 30 \
  -D "$tmp_dir/legacy-model.headers" \
  -o "$tmp_dir/legacy-model.json" \
  -H "Authorization: Bearer $token" \
  "$BASE_URL/v1/models/medcode"

node - "$tmp_dir/legacy-model.json" <<'NODE'
const fs = require("node:fs");
const payload = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (payload.id !== "medcode") {
  console.error(`legacy_model_bad_id=${payload.id}`);
  process.exit(1);
}
console.log("legacy_model_alias=ok");
NODE

run_model() {
  local model="$1"
  local body="$tmp_dir/$model-request.json"
  local headers="$tmp_dir/$model.headers"
  local out="$tmp_dir/$model.sse"

  cat > "$body" <<JSON
{
  "model": "$model",
  "stream": true,
  "messages": [
    {
      "role": "user",
      "content": "帮我写一个html代码的案例，主题是统计学 t 检验方向的，必须要有互动 点击跳转互动 画动画 加超链接这些功能"
    },
    {
      "role": "assistant",
      "content": "我来帮你写一个统计学方向的互动HTML页面，包含点击跳转、动画、超链接等功能。"
    },
    {
      "role": "user",
      "content": "嗯，给我成品就行"
    }
  ],
  "tool_choice": "auto",
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "write_file",
        "description": "Write a complete file to the user's workspace.",
        "parameters": {
          "type": "object",
          "properties": {
            "path": { "type": "string" },
            "content": { "type": "string" }
          },
          "required": ["path", "content"],
          "additionalProperties": false
        }
      }
    }
  ]
}
JSON

  local http_code
  http_code="$(
    curl -sS -N --max-time "$MODEL_TIMEOUT_SECONDS" \
      -D "$headers" \
      -o "$out" \
      -w '%{http_code}' \
      -H "Authorization: Bearer $token" \
      -H "Content-Type: application/json" \
      --data-binary @"$body" \
      "$BASE_URL/v1/chat/completions"
  )"
  local request_id
  request_id="$(request_id_from_headers "$headers")"

  node - "$model" "$http_code" "$request_id" "$out" <<'NODE'
const fs = require("node:fs");
const [model, httpCode, requestId, file] = process.argv.slice(2);
const raw = fs.readFileSync(file, "utf8");
if (httpCode !== "200") {
  console.error(`native_tools=${model} http_${httpCode} request_id=${requestId || "missing"} body_preview=${raw.replace(/\s+/g, " ").slice(0, 220)}`);
  process.exit(1);
}

let done = false;
let finishReason = null;
let content = "";
const calls = new Map();

for (const line of raw.split(/\r?\n/)) {
  if (!line.startsWith("data:")) continue;
  const data = line.slice(5).trim();
  if (!data) continue;
  if (data === "[DONE]") {
    done = true;
    continue;
  }
  const chunk = JSON.parse(data);
  const choice = chunk.choices?.[0];
  if (!choice) continue;
  if (choice.finish_reason) finishReason = choice.finish_reason;
  const delta = choice.delta || {};
  if (typeof delta.content === "string") content += delta.content;
  for (const call of delta.tool_calls || []) {
    const index = call.index ?? 0;
    const existing = calls.get(index) || { id: "", type: "", name: "", args: "" };
    if (call.id) existing.id += call.id;
    if (call.type) existing.type = call.type;
    if (call.function?.name) existing.name += call.function.name;
    if (call.function?.arguments) existing.args += call.function.arguments;
    calls.set(index, existing);
  }
}

if (!done) {
  console.error(`native_tools=${model} missing_done request_id=${requestId || "missing"} finish_reason=${finishReason || "null"} content_chars=${content.length}`);
  process.exit(1);
}

const first = [...calls.values()][0];
if (finishReason !== "tool_calls" || !first) {
  console.error(`native_tools=${model} no_tool_call request_id=${requestId || "missing"} finish_reason=${finishReason || "null"} content_preview=${content.replace(/\s+/g, " ").slice(0, 180)}`);
  process.exit(1);
}
if (first.name !== "write_file") {
  console.error(`native_tools=${model} wrong_tool request_id=${requestId || "missing"} tool=${first.name}`);
  process.exit(1);
}

let args;
try {
  args = JSON.parse(first.args);
} catch {
  console.error(`native_tools=${model} bad_tool_args request_id=${requestId || "missing"} args_chars=${first.args.length}`);
  process.exit(1);
}
const contentArg = typeof args.content === "string" ? args.content : "";
const pathArg = typeof args.path === "string" ? args.path : "";
const htmlOk = /<html[\s>]/i.test(contentArg) || /<!doctype html/i.test(contentArg);
const interactionOk = /(addEventListener|onclick|href=|@keyframes|animation|canvas|button)/i.test(contentArg);
const topicOk = /(t[\s-]*test|t[\s-]*检验|p[\s-]*value|p值|均值|样本)/i.test(contentArg);
if (!pathArg || !htmlOk || !interactionOk || !topicOk) {
  console.error(`native_tools=${model} weak_output request_id=${requestId || "missing"} path_ok=${Boolean(pathArg)} html_ok=${htmlOk} interaction_ok=${interactionOk} topic_ok=${topicOk} content_chars=${contentArg.length}`);
  process.exit(1);
}

console.log(`native_tools=${model} ok request_id=${requestId || "missing"} finish_reason=${finishReason} tool=${first.name} path=${pathArg} content_chars=${contentArg.length}`);
NODE
}

for model in $SMOKE_MODELS; do
  run_model "$model"
done
