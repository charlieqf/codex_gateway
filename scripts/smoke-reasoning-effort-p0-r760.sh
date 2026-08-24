#!/bin/sh
set -eu

base_url=${BASE_URL:-https://gw.instmarket.com.au}
gateway_container=codex_gateway_r760-gateway-1
timestamp=$(date -u +%Y%m%dT%H%M%SZ)
smoke_user=reasoning-p0-smoke-$timestamp
tmp=$(mktemp -d /data/codex-gateway-r760/reasoning-p0-smoke.XXXXXX)
chmod 0700 "$tmp"
prefix=
stage=initialize

admin() {
  docker exec "$gateway_container" node \
    /app/apps/admin-cli/dist/index.js \
    --db /var/lib/codex-gateway/gateway.db \
    "$@"
}

cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  set +e
  if [ -n "$prefix" ]; then
    admin revoke "$prefix" > "$tmp/cleanup-revoke.json" 2>/dev/null
  fi
  admin disable-user "$smoke_user" > "$tmp/cleanup-user.json" 2>/dev/null
  case "$tmp" in
    /data/codex-gateway-r760/reasoning-p0-smoke.*) rm -rf -- "$tmp" ;;
    *) echo "Refusing to remove unexpected smoke path: $tmp" >&2 ;;
  esac
  if [ "$status" -ne 0 ]; then
    echo "failed_stage=$stage" >&2
  fi
  exit "$status"
}
trap cleanup EXIT HUP INT TERM

stage=public_health
curl -fsS --max-time 30 "$base_url/gateway/health" > "$tmp/health.json"
jq -e '.state == "ready" and .phase == "r760-loopback"' "$tmp/health.json" >/dev/null

stage=issue_key
admin issue \
  --user "$smoke_user" \
  --user-label "Reasoning P0 production smoke" \
  --label "Reasoning P0 production smoke" \
  --scope code \
  --credential-class service \
  --expires-days 1 \
  --rpm 60 \
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
prefix=$(jq -er .credential.prefix "$tmp/issue.json")
auth_header="Authorization: Bearer $token"

stage=models
curl -fsS --max-time 30 -H "$auth_header" "$base_url/v1/models" > "$tmp/models.json"
jq -e '[.data[].id] | sort == ["goldencode", "goldencode-local"]' "$tmp/models.json" >/dev/null

chat_request() {
  effort=$1
  output=$2
  headers=$3
  jq -n --arg effort "$effort" '{
    model: "goldencode",
    messages: [{role:"user",content:"Reply exactly OK."}],
    stream: false,
    reasoning_effort: $effort,
    max_tokens: 256
  }' > "$tmp/request-$effort.json"
  curl -sS --max-time 900 -D "$headers" -o "$output" -w '%{http_code}' \
    -H "$auth_header" -H 'Content-Type: application/json' \
    --data-binary @"$tmp/request-$effort.json" "$base_url/v1/chat/completions"
}

request_id_from_headers() {
  awk 'BEGIN { IGNORECASE=1 } /^x-request-id:/ { gsub("\r", "", $2); print $2 }' "$1" | tail -1
}

for effort in none medium max; do
  stage=chat_$effort
  status=$(chat_request "$effort" "$tmp/response-$effort.json" "$tmp/headers-$effort.txt")
  test "$status" = 200
  jq -e '.model == "goldencode" and (.choices[0].message.content | type == "string" and length > 0)' \
    "$tmp/response-$effort.json" >/dev/null
  request_id_from_headers "$tmp/headers-$effort.txt" > "$tmp/request-id-$effort.txt"
  test -s "$tmp/request-id-$effort.txt"
done

stage=unsupported
unsupported_status=$(chat_request xhigh "$tmp/response-xhigh.json" "$tmp/headers-xhigh.txt")
test "$unsupported_status" = 400
unsupported_request_id=$(request_id_from_headers "$tmp/headers-xhigh.txt")
test -n "$unsupported_request_id"
jq -e --arg request_id "$unsupported_request_id" '
  .error.code == "unsupported_reasoning_effort"
  and .error.type == "invalid_request_error"
  and .error.param == "reasoning_effort"
  and .error.requested_value == "xhigh"
  and .error.supported_values == ["low", "high", "max"]
  and .error.retryable == false
  and .error.recommended_action == "use_supported_reasoning_effort"
  and .error.recovery_owner == "client"
  and .error.request_id == $request_id
' "$tmp/response-xhigh.json" >/dev/null
printf '%s\n' "$unsupported_request_id" > "$tmp/request-id-xhigh.txt"

stage=responses_medium_sse
jq -n '{
  model: "goldencode",
  instructions: "Reply concisely.",
  input: [{type:"message",role:"user",content:[{type:"input_text",text:"Reply exactly OK."}]}],
  reasoning: {effort:"medium"},
  stream: true,
  max_output_tokens: 256
}' > "$tmp/responses-medium.json"
responses_status=$(curl -sS --max-time 900 -D "$tmp/responses-medium.headers" \
  -o "$tmp/responses-medium.sse" -w '%{http_code}' \
  -H "$auth_header" -H 'Content-Type: application/json' \
  --data-binary @"$tmp/responses-medium.json" "$base_url/v1/responses")
test "$responses_status" = 200
grep -q '"type":"response.completed"' "$tmp/responses-medium.sse"
responses_request_id=$(request_id_from_headers "$tmp/responses-medium.headers")
test -n "$responses_request_id"
printf '%s\n' "$responses_request_id" > "$tmp/request-id-responses-medium.txt"

stage=local_model_regression
jq -n '{
  model: "goldencode-local",
  messages: [{role:"user",content:"Reply exactly LOCAL_OK."}],
  stream: false,
  reasoning_effort: "low",
  max_tokens: 32
}' > "$tmp/local.json"
test "$(curl -sS --max-time 900 -o "$tmp/local.response.json" -w '%{http_code}' \
  -H "$auth_header" -H 'Content-Type: application/json' \
  --data-binary @"$tmp/local.json" "$base_url/v1/chat/completions")" = 200
jq -e '.model == "goldencode-local" and (.choices[0].message.content | type == "string" and length > 0)' \
  "$tmp/local.response.json" >/dev/null

stage=event_audit
for effort in none medium max xhigh; do
  request_id=$(cat "$tmp/request-id-$effort.txt")
  admin events --request-id "$request_id" --limit 5 > "$tmp/events-$effort.json"
done
admin events --request-id "$responses_request_id" --limit 5 > "$tmp/events-responses-medium.json"

jq -e '.events | any(
  .public_model_id == "goldencode"
  and .requested_reasoning_effort == "none"
  and .effective_reasoning_effort == "low"
  and .reasoning_effort == "low"
  and .reasoning_effort_source == "legacy_normalization"
  and .reasoning_effort_normalized == true
  and .reasoning_effort_normalization_reason == "legacy_alias"
  and .status == "ok"
)' "$tmp/events-none.json" >/dev/null
jq -e '.events | any(
  .requested_reasoning_effort == "medium"
  and .effective_reasoning_effort == "high"
  and .reasoning_effort_source == "legacy_normalization"
  and .reasoning_effort_normalized == true
  and .status == "ok"
)' "$tmp/events-medium.json" >/dev/null
jq -e '.events | any(
  .requested_reasoning_effort == "max"
  and .effective_reasoning_effort == "max"
  and .reasoning_effort_source == "request"
  and .reasoning_effort_normalized == false
  and .status == "ok"
)' "$tmp/events-max.json" >/dev/null
jq -e '.events | any(
  .requested_reasoning_effort == "xhigh"
  and .effective_reasoning_effort == null
  and .reasoning_effort_source == "request"
  and .reasoning_effort_normalized == false
  and .provider == null
  and .upstream_account_id == null
  and .error_code == "unsupported_reasoning_effort"
  and .status == "error"
)' "$tmp/events-xhigh.json" >/dev/null
jq -e '.events | any(
  .requested_reasoning_effort == "medium"
  and .effective_reasoning_effort == "high"
  and .reasoning_effort_source == "legacy_normalization"
  and .status == "ok"
)' "$tmp/events-responses-medium.json" >/dev/null

stage=cleanup_key
admin revoke "$prefix" > "$tmp/revoke.json"
prefix=
test "$(curl -sS --max-time 30 -o "$tmp/revoked.json" -w '%{http_code}' \
  -H "$auth_header" "$base_url/v1/models")" = 401

stage=log_secret_scan
if docker logs "$gateway_container" 2>&1 | grep -Fq "$token"; then
  exit 1
fi
if docker logs "$gateway_container" 2>&1 | grep -Fq 'Reply exactly OK.'; then
  exit 1
fi

echo "base_url=$base_url"
echo "models=goldencode,goldencode-local"
echo "chat=none-200->low,medium-200->high,max-200,xhigh-400-nonretry"
echo "responses=medium-sse-completed->high"
echo "goldencode_local=low-200"
echo "temporary_key=revoke-401"
echo "log_secret_scan=clean"
echo "request_ids=none:$(cat "$tmp/request-id-none.txt"),medium:$(cat "$tmp/request-id-medium.txt"),max:$(cat "$tmp/request-id-max.txt"),xhigh:$unsupported_request_id,responses-medium:$responses_request_id"
stage=complete
