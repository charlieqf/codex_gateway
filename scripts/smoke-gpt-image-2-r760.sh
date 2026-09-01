#!/bin/sh
set -eu

base_url=${BASE_URL:-https://goldencode.instmarket.com.au:1443}
gateway_container=codex_gateway_r760-gateway-1
timestamp=$(date -u +%Y%m%dT%H%M%SZ)
smoke_user=gpt-image-2-smoke-$timestamp
tmp=$(mktemp -d /data/codex-gateway-r760/gpt-image-2-smoke.XXXXXX)
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
    /data/codex-gateway-r760/gpt-image-2-smoke.*) rm -rf -- "$tmp" ;;
    *) echo "Refusing to remove unexpected smoke path: $tmp" >&2 ;;
  esac
  if [ "$status" -ne 0 ]; then
    echo "failed_stage=$stage" >&2
  fi
  exit "$status"
}
trap cleanup EXIT HUP INT TERM

request_id_from_headers() {
  awk 'BEGIN { IGNORECASE=1 } /^x-request-id:/ { gsub("\r", "", $2); print $2 }' "$1" | tail -1
}

stage=public_health
curl -fsS --max-time 30 "$base_url/gateway/health" > "$tmp/health.json"
jq -e '.state == "ready" and .phase == "r760-loopback"' "$tmp/health.json" >/dev/null

stage=issue_key
admin issue \
  --user "$smoke_user" \
  --user-label "GPT Image 2 production smoke" \
  --label "GPT Image 2 production smoke" \
  --scope code \
  --credential-class service \
  --expires-days 1 \
  --rpm 10 \
  --rpd 20 \
  --concurrent 1 \
  --tokens-per-minute 300000 \
  --tokens-per-day 1000000 \
  --tokens-per-month 10000000 \
  --max-prompt-tokens 24576 \
  --max-total-tokens 32768 \
  --reserve-tokens 8192 \
  --missing-usage-charge reserve > "$tmp/issue.json"
chmod 0600 "$tmp/issue.json"
token=$(jq -er .token "$tmp/issue.json")
prefix=$(jq -er .credential.prefix "$tmp/issue.json")
auth_header="Authorization: Bearer $token"

stage=grant_entitlement
admin entitlement grant \
  --user "$smoke_user" \
  --plan plan_paid_monthly_v1 \
  --period one_off \
  --duration 1h \
  --replace > "$tmp/entitlement.json"

stage=generate_image
jq -n '{
  model:"medcode-image-default",
  prompt:"Create a minimal blue circle centered on a white background, flat icon style.",
  size:"1024x1024",
  quality:"low",
  output_format:"jpeg",
  metadata:{client:"gpt-image-2-r760-smoke"}
}' > "$tmp/request.json"
status=$(curl -sS --max-time 240 -D "$tmp/headers.txt" \
  -o "$tmp/response.json" -w '%{http_code}' \
  -H "$auth_header" \
  -H 'Content-Type: application/json' \
  --data-binary @"$tmp/request.json" \
  "$base_url/gateway/images/generations")
test "$status" = 200
jq -e '
  (.id | startswith("imgreq_"))
  and (.data[0].b64_json | type == "string" and length > 100)
  and .data[0].mime_type == "image/jpeg"
' "$tmp/response.json" >/dev/null
request_id=$(request_id_from_headers "$tmp/headers.txt")
test -n "$request_id"

stage=event_audit
admin events --request-id "$request_id" --limit 5 > "$tmp/events.json"
jq -e '.events | any(
  .public_model_id == "medcode-image-default"
  and .provider == "openai-api"
  and .upstream_model == "gpt-image-2"
  and .status == "ok"
)' "$tmp/events.json" >/dev/null

stage=cleanup_key
admin revoke "$prefix" > "$tmp/revoke.json"
prefix=
test "$(curl -sS --max-time 30 -o "$tmp/revoked.json" -w '%{http_code}' \
  -H "$auth_header" "$base_url/v1/models")" = 401

stage=log_secret_scan
if docker logs "$gateway_container" 2>&1 | grep -Fq "$token"; then
  exit 1
fi
if docker logs "$gateway_container" 2>&1 | grep -Fq 'minimal blue circle'; then
  exit 1
fi

echo "base_url=$base_url"
echo "public_model=medcode-image-default"
echo "upstream_model=gpt-image-2"
echo "image_generation=200-valid-jpeg"
echo "temporary_key=revoke-401"
echo "log_secret_scan=clean"
echo "request_id=$request_id"
stage=complete
