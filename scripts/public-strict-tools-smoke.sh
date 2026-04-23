#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-https://gw.instmarket.com.au}"
COMPOSE_PROJECT="${COMPOSE_PROJECT:-codex_gateway_test}"
COMPOSE_FILE="${COMPOSE_FILE:-compose.azure.yml}"
GATEWAY_SERVICE="${GATEWAY_SERVICE:-gateway}"
GATEWAY_DB="${GATEWAY_DB:-/var/lib/codex-gateway/gateway.db}"
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
user_id="strict-tools-smoke-$(date +%s)"

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
    --label public-strict-tools-smoke \
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

cat > "$tmp_dir/strict-tools-request.json" <<'JSON'
{
  "model": "medcode",
  "messages": [
    {
      "role": "user",
      "content": "For this integration smoke, you must call the medevidence tool before answering. Use question exactly: strict-tools-smoke-question"
    }
  ],
  "tool_choice": "required",
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "medevidence",
        "description": "Answer a medical evidence question.",
        "parameters": {
          "type": "object",
          "properties": {
            "question": { "type": "string" }
          },
          "required": ["question"],
          "additionalProperties": false
        }
      }
    }
  ]
}
JSON

curl -fsS --max-time "$MODEL_TIMEOUT_SECONDS" \
  -D "$tmp_dir/strict-tools.headers" \
  -o "$tmp_dir/strict-tools.json" \
  -H "Authorization: Bearer $token" \
  -H "Content-Type: application/json" \
  --data-binary @"$tmp_dir/strict-tools-request.json" \
  "$BASE_URL/v1/chat/completions"

assert_json "$tmp_dir/strict-tools.json" '
const choice = x.choices?.[0];
if (choice?.finish_reason !== "tool_calls") {
  console.error("finish_reason", choice?.finish_reason);
  process.exit(1);
}
const call = choice?.message?.tool_calls?.[0];
if (call?.type !== "function" || call?.function?.name !== "medevidence") {
  console.error(JSON.stringify(call));
  process.exit(1);
}
const args = JSON.parse(call.function.arguments);
if (typeof args.question !== "string" || args.question.length === 0) {
  console.error(call.function.arguments);
  process.exit(1);
}
if ("command" in args) {
  console.error("unexpected command argument");
  process.exit(1);
}
'
strict_request_id="$(require_request_id "strict_tools" "$tmp_dir/strict-tools.headers")"
strict_usage="$(node -e 'const fs = require("fs"); const x = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); process.stdout.write(x.usage ? "present" : "null");' "$tmp_dir/strict-tools.json")"
strict_tool_name="$(node -e 'const fs = require("fs"); const x = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); process.stdout.write(x.choices[0].message.tool_calls[0].function.name);' "$tmp_dir/strict-tools.json")"
echo "strict_tools=ok tool=$strict_tool_name usage=$strict_usage ${strict_request_id}"

cat > "$tmp_dir/strict-tools-named-request.json" <<'JSON'
{
  "model": "medcode",
  "messages": [
    {
      "role": "user",
      "content": "For this integration smoke, call the search_evidence tool. Use query exactly: strict-tools-named-query"
    }
  ],
  "tool_choice": {
    "type": "function",
    "function": {
      "name": "search_evidence"
    }
  },
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "medevidence",
        "description": "Answer a medical evidence question.",
        "parameters": {
          "type": "object",
          "properties": {
            "question": { "type": "string" }
          },
          "required": ["question"],
          "additionalProperties": false
        }
      }
    },
    {
      "type": "function",
      "function": {
        "name": "search_evidence",
        "description": "Search for medical evidence.",
        "parameters": {
          "type": "object",
          "properties": {
            "query": { "type": "string" }
          },
          "required": ["query"],
          "additionalProperties": false
        }
      }
    }
  ]
}
JSON

curl -fsS --max-time "$MODEL_TIMEOUT_SECONDS" \
  -D "$tmp_dir/strict-tools-named.headers" \
  -o "$tmp_dir/strict-tools-named.json" \
  -H "Authorization: Bearer $token" \
  -H "Content-Type: application/json" \
  --data-binary @"$tmp_dir/strict-tools-named-request.json" \
  "$BASE_URL/v1/chat/completions"

assert_json "$tmp_dir/strict-tools-named.json" '
const choice = x.choices?.[0];
if (choice?.finish_reason !== "tool_calls") {
  console.error("finish_reason", choice?.finish_reason);
  process.exit(1);
}
const call = choice?.message?.tool_calls?.[0];
if (call?.function?.name !== "search_evidence") {
  console.error(JSON.stringify(call));
  process.exit(1);
}
const args = JSON.parse(call.function.arguments);
if (typeof args.query !== "string" || args.query.length === 0) {
  console.error(call.function.arguments);
  process.exit(1);
}
if ("command" in args || "question" in args) {
  console.error("unexpected argument shape");
  process.exit(1);
}
'
named_request_id="$(require_request_id "strict_tools_named" "$tmp_dir/strict-tools-named.headers")"
named_usage="$(node -e 'const fs = require("fs"); const x = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); process.stdout.write(x.usage ? "present" : "null");' "$tmp_dir/strict-tools-named.json")"
named_tool_name="$(node -e 'const fs = require("fs"); const x = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); process.stdout.write(x.choices[0].message.tool_calls[0].function.name);' "$tmp_dir/strict-tools-named.json")"
echo "strict_tools_named=ok tool=$named_tool_name usage=$named_usage ${named_request_id}"

cat > "$tmp_dir/strict-tools-none-request.json" <<'JSON'
{
  "model": "medcode",
  "messages": [
    {
      "role": "user",
      "content": "Reply exactly: strict-tools-none-ok. Do not call tools."
    }
  ],
  "tool_choice": "none",
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "medevidence",
        "description": "Answer a medical evidence question.",
        "parameters": {
          "type": "object",
          "properties": {
            "question": { "type": "string" }
          },
          "required": ["question"],
          "additionalProperties": false
        }
      }
    }
  ]
}
JSON

curl -fsS --max-time "$MODEL_TIMEOUT_SECONDS" \
  -D "$tmp_dir/strict-tools-none.headers" \
  -o "$tmp_dir/strict-tools-none.json" \
  -H "Authorization: Bearer $token" \
  -H "Content-Type: application/json" \
  --data-binary @"$tmp_dir/strict-tools-none-request.json" \
  "$BASE_URL/v1/chat/completions"

assert_json "$tmp_dir/strict-tools-none.json" '
const choice = x.choices?.[0];
if (choice?.finish_reason !== "stop") {
  console.error("finish_reason", choice?.finish_reason);
  process.exit(1);
}
if (choice?.message?.tool_calls !== undefined) {
  console.error("unexpected tool_calls");
  process.exit(1);
}
if (!String(choice?.message?.content ?? "").includes("strict-tools-none-ok")) {
  console.error(choice?.message?.content);
  process.exit(1);
}
'
none_request_id="$(require_request_id "strict_tools_none" "$tmp_dir/strict-tools-none.headers")"
none_usage="$(node -e 'const fs = require("fs"); const x = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); process.stdout.write(x.usage ? "present" : "null");' "$tmp_dir/strict-tools-none.json")"
echo "strict_tools_none=ok usage=$none_usage ${none_request_id}"

node - "$tmp_dir/strict-tools.json" "$tmp_dir/strict-tools-followup-request.json" <<'NODE'
const fs = require("fs");
const firstPath = process.argv[2];
const outputPath = process.argv[3];
const first = JSON.parse(fs.readFileSync(firstPath, "utf8"));
const toolCalls = first.choices[0].message.tool_calls;
const body = {
  model: "medcode",
  messages: [
    {
      role: "user",
      content:
        "For this integration smoke, you must call the medevidence tool before answering. Use question exactly: strict-tools-smoke-question",
    },
    {
      role: "assistant",
      content: null,
      tool_calls: toolCalls,
    },
    {
      role: "tool",
      tool_call_id: toolCalls[0].id,
      content: "medevidence observation: strict-tools-result-observation",
    },
    {
      role: "user",
      content:
        "Based only on the tool result, return a final message exactly: strict-tools-result-ok. Do not call tools.",
    },
  ],
  tools: [
    {
      type: "function",
      function: {
        name: "medevidence",
        description: "Answer a medical evidence question.",
        parameters: {
          type: "object",
          properties: {
            question: { type: "string" },
          },
          required: ["question"],
          additionalProperties: false,
        },
      },
    },
  ],
};
fs.writeFileSync(outputPath, JSON.stringify(body));
NODE

curl -fsS --max-time "$MODEL_TIMEOUT_SECONDS" \
  -D "$tmp_dir/strict-tools-followup.headers" \
  -o "$tmp_dir/strict-tools-followup.json" \
  -H "Authorization: Bearer $token" \
  -H "Content-Type: application/json" \
  --data-binary @"$tmp_dir/strict-tools-followup-request.json" \
  "$BASE_URL/v1/chat/completions"

assert_json "$tmp_dir/strict-tools-followup.json" '
const choice = x.choices?.[0];
if (choice?.finish_reason !== "stop") {
  console.error("finish_reason", choice?.finish_reason);
  process.exit(1);
}
if (choice?.message?.content?.trim() !== "strict-tools-result-ok") {
  console.error(choice?.message?.content);
  process.exit(1);
}
if (choice?.message?.tool_calls !== undefined) {
  console.error("unexpected followup tool_calls");
  process.exit(1);
}
'
followup_request_id="$(require_request_id "strict_tools_followup" "$tmp_dir/strict-tools-followup.headers")"
followup_usage="$(node -e 'const fs = require("fs"); const x = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); process.stdout.write(x.usage ? "present" : "null");' "$tmp_dir/strict-tools-followup.json")"
echo "strict_tools_followup=ok usage=$followup_usage ${followup_request_id}"

cleanup
trap - EXIT
echo "cleanup=ok"
