#!/bin/sh
set -eu

gateway_container=codex_gateway_r760-gateway-1
action=${1:-}

admin() {
  docker exec "$gateway_container" node \
    /app/apps/admin-cli/dist/index.js \
    --db /var/lib/codex-gateway/gateway.db \
    "$@"
}

cleanup_fixture() {
  fixture=$1
  case "$fixture" in
    /data/llm-runtime/qwen-api/unified-public-smoke.*) ;;
    *) echo "Refusing unexpected fixture path: $fixture" >&2; return 1 ;;
  esac

  if [ -s "$fixture/unified.json" ]; then
    unified_prefix=$(jq -er '.key.prefix' "$fixture/unified.json")
    admin unified-key revoke "$unified_prefix" > "$fixture/unified-revoke.json"
  fi
  if [ -s "$fixture/access.json" ]; then
    access_prefix=$(jq -er '.credential.prefix' "$fixture/access.json")
    admin revoke "$access_prefix" > "$fixture/access-revoke.json"
  fi
  if [ -s "$fixture/user.txt" ]; then
    user=$(sed -n '1p' "$fixture/user.txt")
    admin disable-user "$user" > "$fixture/user-disable.json"
  fi
  rm -rf -- "$fixture"
}

case "$action" in
  issue)
    timestamp=$(date -u +%Y%m%dT%H%M%SZ)
    fixture=$(mktemp -d /data/llm-runtime/qwen-api/unified-public-smoke.XXXXXX)
    chmod 0700 "$fixture"
    user=goldencode-local-unified-smoke-$timestamp
    printf '%s\n' "$user" > "$fixture/user.txt"
    chmod 0600 "$fixture/user.txt"
    failed=1
    rollback_issue() {
      status=$?
      trap - EXIT HUP INT TERM
      if [ "$failed" -eq 1 ]; then
        cleanup_fixture "$fixture" >/dev/null 2>&1 || true
      fi
      exit "$status"
    }
    trap rollback_issue EXIT HUP INT TERM

    admin issue \
      --user "$user" \
      --user-label "Unified public smoke" \
      --label "Unified public smoke" \
      --scope code \
      --credential-class desktop \
      --expires-days 1 \
      --rpm 20 \
      --rpd 50 \
      --concurrent 2 \
      --tokens-per-minute 300000 \
      --tokens-per-day 1000000 \
      --tokens-per-month 10000000 \
      --max-prompt-tokens 24576 \
      --max-total-tokens 32768 \
      --reserve-tokens 8192 \
      --missing-usage-charge reserve \
      --allowed-public-models goldencode,goldencode-local \
      --no-entitlement-check > "$fixture/access.json"
    chmod 0600 "$fixture/access.json"
    access_prefix=$(jq -er '.credential.prefix' "$fixture/access.json")
    medevidence_key=$(openssl rand -hex 32)
    docker exec -e UNIFIED_SMOKE_ME_KEY="$medevidence_key" "$gateway_container" node \
      /app/apps/admin-cli/dist/index.js \
      --db /var/lib/codex-gateway/gateway.db \
      unified-key issue \
      --user "$user" \
      --codex-credential-prefix "$access_prefix" \
      --medevidence-key-env UNIFIED_SMOKE_ME_KEY \
      --label "Unified public smoke" \
      --expires-days 1 > "$fixture/unified.json"
    unset medevidence_key
    chmod 0600 "$fixture/unified.json"

    failed=0
    trap - EXIT HUP INT TERM
    echo "fixture=$fixture"
    echo "access_prefix=$access_prefix"
    echo "unified_prefix=$(jq -er '.key.prefix' "$fixture/unified.json")"
    ;;
  cleanup)
    if [ "$#" -ne 2 ]; then
      echo "usage: $0 cleanup <fixture-path>" >&2
      exit 2
    fi
    cleanup_fixture "$2"
    echo "fixture_cleaned=true"
    ;;
  *)
    echo "usage: $0 issue | cleanup <fixture-path>" >&2
    exit 2
    ;;
esac
