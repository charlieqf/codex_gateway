#!/bin/sh
set -eu

base_url=${BASE_URL:-http://127.0.0.1:18787}
gateway_image=${GATEWAY_IMAGE:-codex_gateway_r760-gateway:release-531f8d1-local}
gateway_env=/opt/codex-gateway-r760/shared/config/gateway.container.env
gateway_container=codex_gateway_r760-gateway-1
timestamp=$(date -u +%Y%m%dT%H%M%SZ)
smoke_user=goldencode-local-smoke-$timestamp
limit_user=goldencode-local-limit-$timestamp
tmp=$(mktemp -d /data/llm-runtime/qwen-api/smoke.XXXXXX)
chmod 0700 "$tmp"
smoke_prefix=
limit_prefix=
stage=initialize

admin() {
  docker run --rm \
    --volumes-from "$gateway_container" \
    --env-file "$gateway_env" \
    --entrypoint node \
    "$gateway_image" \
    /app/apps/admin-cli/dist/index.js \
    --db /var/lib/codex-gateway/gateway.db \
    "$@"
}

cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  set +e
  if [ -n "$smoke_prefix" ]; then
    admin revoke "$smoke_prefix" > "$tmp/cleanup-smoke-revoke.json" 2>/dev/null
  fi
  if [ -n "$limit_prefix" ]; then
    admin revoke "$limit_prefix" > "$tmp/cleanup-limit-revoke.json" 2>/dev/null
  fi
  admin disable-user "$smoke_user" > "$tmp/cleanup-smoke-user.json" 2>/dev/null
  admin disable-user "$limit_user" > "$tmp/cleanup-limit-user.json" 2>/dev/null
  case "$tmp" in
    /data/llm-runtime/qwen-api/smoke.*) rm -rf -- "$tmp" ;;
    *) echo "Refusing to remove unexpected smoke path: $tmp" >&2 ;;
  esac
  if [ "$status" -ne 0 ]; then
    echo "failed_stage=$stage" >&2
  fi
  exit "$status"
}
trap cleanup EXIT HUP INT TERM

stage=unauthorized
test "$(curl -sS -o "$tmp/no-auth.json" -w '%{http_code}' --max-time 15 "$base_url/v1/models")" = 401
test "$(curl -sS -o "$tmp/wrong-auth.json" -w '%{http_code}' --max-time 15 \
  -H 'Authorization: Bearer cgu_live_invalid' "$base_url/v1/models")" = 401

stage=issue_smoke_key
admin issue \
  --user "$smoke_user" \
  --user-label "GoldenCode Local smoke" \
  --label "GoldenCode Local smoke" \
  --scope code \
  --credential-class service \
  --expires-days 1 \
  --rpm 30 \
  --rpd 100 \
  --concurrent 2 \
  --tokens-per-minute 300000 \
  --tokens-per-day 1000000 \
  --tokens-per-month 10000000 \
  --max-prompt-tokens 24576 \
  --max-total-tokens 32768 \
  --reserve-tokens 8192 \
  --missing-usage-charge reserve \
  --allowed-public-models goldencode,goldencode-local \
  --no-entitlement-check > "$tmp/issue.json"
chmod 0600 "$tmp/issue.json"
token=$(jq -er .token "$tmp/issue.json")
smoke_prefix=$(jq -er .credential.prefix "$tmp/issue.json")
auth_header="Authorization: Bearer $token"

stage=models
curl -fsS --max-time 30 -H "$auth_header" "$base_url/v1/models" > "$tmp/models.json"
jq -e '[.data[].id] | sort == ["goldencode", "goldencode-local"]' "$tmp/models.json" >/dev/null

cat > "$tmp/local.json" <<'JSON'
{"model":"goldencode-local","messages":[{"role":"user","content":"Reply with a short confirmation that local inference works."}],"stream":false,"reasoning_effort":"low","max_tokens":64}
JSON
stage=local_chat
local_status=$(curl -sS --max-time 900 -D "$tmp/local.headers" -o "$tmp/local.response.json" -w '%{http_code}' \
  -H "$auth_header" -H 'Content-Type: application/json' --data-binary @"$tmp/local.json" \
  "$base_url/v1/chat/completions")
test "$local_status" = 200
jq -e '.model == "goldencode-local" and (.choices[0].message.content | type == "string" and length > 0) and .usage.total_tokens > 0' \
  "$tmp/local.response.json" >/dev/null
request_id=$(awk 'BEGIN { IGNORECASE=1 } /^x-request-id:/ { gsub("\\r", "", $2); print $2 }' "$tmp/local.headers" | tail -1)
test -n "$request_id"

cat > "$tmp/goldencode.json" <<'JSON'
{"model":"goldencode","messages":[{"role":"user","content":"Reply with one short sentence confirming the existing model works."}],"stream":false,"reasoning_effort":"low","max_tokens":64}
JSON
stage=goldencode_chat
test "$(curl -sS --max-time 900 -o "$tmp/goldencode.response.json" -w '%{http_code}' \
  -H "$auth_header" -H 'Content-Type: application/json' --data-binary @"$tmp/goldencode.json" \
  "$base_url/v1/chat/completions")" = 200
jq -e '.model == "goldencode" and (.choices[0].message.content | type == "string" and length > 0)' \
  "$tmp/goldencode.response.json" >/dev/null

cat > "$tmp/invalid-model.json" <<'JSON'
{"model":"not-a-model","messages":[{"role":"user","content":"test"}],"stream":false}
JSON
stage=invalid_model
test "$(curl -sS --max-time 30 -o "$tmp/invalid-model.response.json" -w '%{http_code}' \
  -H "$auth_header" -H 'Content-Type: application/json' --data-binary @"$tmp/invalid-model.json" \
  "$base_url/v1/chat/completions")" = 404
jq -e '.error.code == "model_not_found"' "$tmp/invalid-model.response.json" >/dev/null

cat > "$tmp/stream.json" <<'JSON'
{"model":"goldencode-local","messages":[{"role":"user","content":"Count from one to three."}],"stream":true,"max_tokens":64}
JSON
stage=stream
curl -fsSN --max-time 900 -H "$auth_header" -H 'Content-Type: application/json' \
  --data-binary @"$tmp/stream.json" "$base_url/v1/chat/completions" > "$tmp/stream.response.txt"
grep -q '^data: \[DONE\]' "$tmp/stream.response.txt"
grep -q '"usage"' "$tmp/stream.response.txt"

cat > "$tmp/tool-required.json" <<'JSON'
{"model":"goldencode-local","messages":[{"role":"system","content":"Use the required tool."},{"role":"user","content":"What is the Sydney temperature?"}],"tools":[{"type":"function","function":{"name":"get_weather","description":"Get weather","parameters":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}}}],"tool_choice":"required","stream":false,"max_tokens":128}
JSON
stage=tool_required
test "$(curl -sS --max-time 900 -o "$tmp/tool-required.response.json" -w '%{http_code}' \
  -H "$auth_header" -H 'Content-Type: application/json' --data-binary @"$tmp/tool-required.json" \
  "$base_url/v1/chat/completions")" = 200
jq -e '.choices[0].finish_reason == "tool_calls" and .choices[0].message.tool_calls[0].function.name == "get_weather"' \
  "$tmp/tool-required.response.json" >/dev/null
tool_call_id=$(jq -er '.choices[0].message.tool_calls[0].id' "$tmp/tool-required.response.json")
tool_arguments=$(jq -er '.choices[0].message.tool_calls[0].function.arguments' "$tmp/tool-required.response.json")

stage=tool_named
jq '.tool_choice = {type: "function", function: {name: "get_weather"}}' \
  "$tmp/tool-required.json" > "$tmp/tool-named.json"
test "$(curl -sS --max-time 900 -o "$tmp/tool-named.response.json" -w '%{http_code}' \
  -H "$auth_header" -H 'Content-Type: application/json' --data-binary @"$tmp/tool-named.json" \
  "$base_url/v1/chat/completions")" = 200
jq -e '.choices[0].finish_reason == "tool_calls" and .choices[0].message.tool_calls[0].function.name == "get_weather"' \
  "$tmp/tool-named.response.json" >/dev/null

stage=tool_none
jq '.tool_choice = "none" | .messages = [{role: "user", content: "Answer with the word NO_TOOL and do not call a tool."}]' \
  "$tmp/tool-required.json" > "$tmp/tool-none.json"
test "$(curl -sS --max-time 900 -o "$tmp/tool-none.response.json" -w '%{http_code}' \
  -H "$auth_header" -H 'Content-Type: application/json' --data-binary @"$tmp/tool-none.json" \
  "$base_url/v1/chat/completions")" = 200
jq -e '(.choices[0].message.tool_calls // []) | length == 0' "$tmp/tool-none.response.json" >/dev/null

stage=tool_followup
jq -n --arg id "$tool_call_id" --arg arguments "$tool_arguments" '{
  model: "goldencode-local",
  messages: [
    {role: "user", content: "What is the Sydney temperature?"},
    {role: "assistant", content: null, tool_calls: [{id: $id, type: "function", function: {name: "get_weather", arguments: $arguments}}]},
    {role: "tool", tool_call_id: $id, content: "21 degrees Celsius"}
  ],
  stream: false,
  max_tokens: 128
}' > "$tmp/tool-followup.json"
test "$(curl -sS --max-time 900 -o "$tmp/tool-followup.response.json" -w '%{http_code}' \
  -H "$auth_header" -H 'Content-Type: application/json' --data-binary @"$tmp/tool-followup.json" \
  "$base_url/v1/chat/completions")" = 200
jq -e '.choices[0].message.content | type == "string" and contains("21")' "$tmp/tool-followup.response.json" >/dev/null

stage=event_attribution
admin events --request-id "$request_id" --limit 5 > "$tmp/events.json"
jq -e '.events | any(.public_model_id == "goldencode-local" and .upstream_runtime == "local_openai" and .provider == "local-openai" and .status == "ok")' \
  "$tmp/events.json" >/dev/null

stage=issue_limit_key
admin issue \
  --user "$limit_user" \
  --user-label "GoldenCode Local rate smoke" \
  --label "GoldenCode Local rate smoke" \
  --scope code \
  --expires-days 1 \
  --rpm 1 \
  --rpd 100 \
  --concurrent 1 \
  --allowed-public-models goldencode-local \
  --no-entitlement-check > "$tmp/limit-issue.json"
limit_token=$(jq -er .token "$tmp/limit-issue.json")
limit_prefix=$(jq -er .credential.prefix "$tmp/limit-issue.json")
stage=rate_limit
test "$(curl -sS --max-time 900 -o "$tmp/limit-first.json" -w '%{http_code}' \
  -H "Authorization: Bearer $limit_token" -H 'Content-Type: application/json' \
  --data-binary @"$tmp/local.json" "$base_url/v1/chat/completions")" = 200
test "$(curl -sS --max-time 30 -o "$tmp/limit-second.json" -w '%{http_code}' \
  -H "Authorization: Bearer $limit_token" -H 'Content-Type: application/json' \
  --data-binary @"$tmp/local.json" "$base_url/v1/chat/completions")" = 429

stage=revoke
admin revoke "$smoke_prefix" > "$tmp/revoke.json"
smoke_prefix=
test "$(curl -sS --max-time 30 -o "$tmp/revoked.json" -w '%{http_code}' \
  -H "$auth_header" "$base_url/v1/models")" = 401

stage=log_scan
if docker logs "$gateway_container" 2>&1 | grep -Fq "$token"; then
  exit 1
fi
if docker logs "$gateway_container" 2>&1 | grep -Fq 'Reply with a short confirmation that local inference works.'; then
  exit 1
fi

echo "request_id=$request_id"
echo "models=goldencode,goldencode-local"
echo "auth=401/401/revoke-401"
echo "chat=goldencode-200,goldencode-local-200,sse-done,tools-required-named-none-followup-200"
echo "rate_limit=429"
echo "log_secret_scan=clean"
stage=complete
