#!/bin/sh
set -eu

base_url=${BASE_URL:-https://goldencode.instmarket.com.au:1443}
gateway_container=codex_gateway_r760-gateway-1
timestamp=$(date -u +%Y%m%dT%H%M%SZ)
smoke_user=goldencode-dual-provider-smoke-$timestamp
tmp=$(mktemp -d /data/codex-gateway-r760/goldencode-dual-provider-smoke.XXXXXX)
chmod 0700 "$tmp"
prefix=
token=
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
    /data/codex-gateway-r760/goldencode-dual-provider-smoke.*) rm -rf -- "$tmp" ;;
    *) echo "Refusing to remove unexpected smoke path: $tmp" >&2 ;;
  esac
  if [ "$status" -ne 0 ]; then
    echo "failed_stage=$stage" >&2
  fi
  exit "$status"
}
trap cleanup EXIT HUP INT TERM

session_for_member() {
  target=$1
  TARGET_MEMBER="$target" docker exec -e TARGET_MEMBER "$gateway_container" node --input-type=module -e '
    import { createHash } from "node:crypto";
    const target = process.env.TARGET_MEMBER;
    const members = ["goldencode-tencent", "goldencode-tiankuan"];
    const score = (key, member) =>
      createHash("sha256").update(key).update("\0").update(member).digest("hex");
    for (let index = 0; index < 1000; index += 1) {
      const session = `dual-provider-${target}-${index}`;
      const key = `client_session:${session}`;
      const selected = members.reduce((best, member) =>
        score(key, member) > score(key, best) ? member : best
      );
      if (selected === target) {
        process.stdout.write(`${session}\n`);
        process.exit(0);
      }
    }
    process.exit(1);
  '
}

request_id_from_headers() {
  awk 'BEGIN { IGNORECASE=1 } /^x-request-id:/ { gsub("\r", "", $2); print $2 }' "$1" | tail -1
}

stage=public_health
curl -fsS --max-time 30 "$base_url/gateway/health" > "$tmp/health.json"
jq -e '.state == "ready" and .phase == "r760-loopback"' "$tmp/health.json" >/dev/null

stage=issue_key
admin issue \
  --user "$smoke_user" \
  --user-label "GoldenCode dual-provider production smoke" \
  --label "GoldenCode dual-provider production smoke" \
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
  --allowed-public-models goldencode \
  --no-entitlement-check > "$tmp/issue.json"
chmod 0600 "$tmp/issue.json"
token=$(jq -er .token "$tmp/issue.json")
prefix=$(jq -er .credential.prefix "$tmp/issue.json")
auth_header="Authorization: Bearer $token"

stage=models
curl -fsS --max-time 30 -H "$auth_header" "$base_url/v1/models" > "$tmp/models.json"
jq -e '.data | any(.id == "goldencode")' "$tmp/models.json" >/dev/null

for member in goldencode-tencent goldencode-tiankuan; do
  runtime=${member#goldencode-}
  session=$(session_for_member "$member")
  printf '%s\n' "$session" > "$tmp/session-$runtime.txt"
  jq -n --arg marker "DUAL_PROVIDER_${runtime}_OK" '{
    model: "goldencode",
    messages: [{role:"user",content:("Reply exactly " + $marker + ".")}],
    stream: false,
    reasoning_effort: "low",
    max_tokens: 1024
  }' > "$tmp/request-$runtime.json"

  stage=chat_$runtime
  status=$(curl -sS --max-time 180 -D "$tmp/headers-$runtime.txt" \
    -o "$tmp/response-$runtime.json" -w '%{http_code}' \
    -H "$auth_header" \
    -H "x-medcode-client-session-id: $session" \
    -H 'Content-Type: application/json' \
    --data-binary @"$tmp/request-$runtime.json" \
    "$base_url/v1/chat/completions")
  test "$status" = 200
  jq -e '.model == "goldencode" and (.choices[0].message.content | type == "string" and length > 0)' \
    "$tmp/response-$runtime.json" >/dev/null
  request_id=$(request_id_from_headers "$tmp/headers-$runtime.txt")
  test -n "$request_id"
  printf '%s\n' "$request_id" > "$tmp/request-id-$runtime.txt"

  stage=event_$runtime
  admin events --request-id "$request_id" --limit 5 > "$tmp/events-$runtime.json"
  expected_model=glm-5.3
  if [ "$runtime" = tiankuan ]; then
    expected_model=official/glm-5.3
  fi
  jq -e \
    --arg runtime "$runtime" \
    --arg member "$member" \
    --arg upstream_model "$expected_model" '
      .events | any(
        .public_model_id == "goldencode"
        and .upstream_runtime == $runtime
        and .provider == $runtime
        and .upstream_account_id == $member
        and .upstream_model == $upstream_model
        and .status == "ok"
      )
    ' "$tmp/events-$runtime.json" >/dev/null
done

stage=tiankuan_required_tool
tiankuan_session=$(cat "$tmp/session-tiankuan.txt")
jq -n '{
  model: "goldencode",
  messages: [
    {role:"system",content:"Use the required tool."},
    {role:"user",content:"Multiply 17 by 23."}
  ],
  tools: [{
    type:"function",
    function:{
      name:"multiply",
      description:"Multiply two integers.",
      parameters:{
        type:"object",
        properties:{a:{type:"integer"},b:{type:"integer"}},
        required:["a","b"],
        additionalProperties:false
      }
    }
  }],
  tool_choice:"required",
  stream:false,
  reasoning_effort:"high",
  max_tokens:1024
}' > "$tmp/tool-request.json"
test "$(curl -sS --max-time 180 -o "$tmp/tool-response.json" -w '%{http_code}' \
  -H "$auth_header" \
  -H "x-medcode-client-session-id: $tiankuan_session" \
  -H 'Content-Type: application/json' \
  --data-binary @"$tmp/tool-request.json" \
  "$base_url/v1/chat/completions")" = 200
jq -e '
  .choices[0].finish_reason == "tool_calls"
  and .choices[0].message.tool_calls[0].function.name == "multiply"
  and ((.choices[0].message.tool_calls[0].function.arguments | fromjson) as $args
    | $args.a == 17 and $args.b == 23)
' "$tmp/tool-response.json" >/dev/null

stage=cleanup_key
admin revoke "$prefix" > "$tmp/revoke.json"
prefix=
test "$(curl -sS --max-time 30 -o "$tmp/revoked.json" -w '%{http_code}' \
  -H "$auth_header" "$base_url/v1/models")" = 401

stage=log_secret_scan
if docker logs "$gateway_container" 2>&1 | grep -Fq "$token"; then
  exit 1
fi
if docker logs "$gateway_container" 2>&1 | grep -Fq 'DUAL_PROVIDER_'; then
  exit 1
fi

echo "base_url=$base_url"
echo "models=goldencode"
echo "providers=tencent-200,tiankuan-200"
echo "tiankuan_tool=required-valid"
echo "temporary_key=revoke-401"
echo "log_secret_scan=clean"
echo "request_ids=tencent:$(cat "$tmp/request-id-tencent.txt"),tiankuan:$(cat "$tmp/request-id-tiankuan.txt")"
stage=complete
