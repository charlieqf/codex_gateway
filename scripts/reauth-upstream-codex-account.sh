#!/usr/bin/env bash
set -euo pipefail

ACCOUNT_ID="${ACCOUNT_ID:-codex-pro-1}"
CODEX_HOME_OVERRIDE="${CODEX_HOME_OVERRIDE:-}"
CONTAINER_NAME="${CONTAINER_NAME:-codex_gateway_test-gateway-1}"
GATEWAY_DB="${GATEWAY_DB:-/var/lib/codex-gateway/gateway.db}"
COMPOSE_PROJECT="${COMPOSE_PROJECT:-codex_gateway_test}"
COMPOSE_FILE="${COMPOSE_FILE:-compose.azure.yml}"
GATEWAY_SERVICE="${GATEWAY_SERVICE:-gateway}"
MODEL="${MODEL:-}"
TIMEOUT_MS="${TIMEOUT_MS:-180000}"
DO_LOGIN=1
DO_PROBE=1
REPAIR_DB_STATE=1
RECREATE_GATEWAY=0

if [ -n "${DOCKER_COMMAND:-}" ]; then
  read -r -a DOCKER_BIN <<< "$DOCKER_COMMAND"
else
  DOCKER_BIN=(sudo docker)
fi

if [ -n "${COMPOSE_COMMAND:-}" ]; then
  read -r -a COMPOSE_BIN <<< "$COMPOSE_COMMAND"
else
  COMPOSE_BIN=(sudo docker compose)
fi

usage() {
  cat <<'EOF'
Usage:
  bash scripts/reauth-upstream-codex-account.sh [options]

Reauthenticate a live upstream Codex account inside the Gateway container.
Run this on the Azure VM release checkout, preferably through an interactive
SSH session (`ssh -tt ...`).

Options:
  --account <id>              Upstream account id. Default: codex-pro-1
  --codex-home <path>         Override CODEX_HOME inside the gateway container
  --container <name>          Gateway container. Default: codex_gateway_test-gateway-1
  --model <model>             Probe model. Default: container MEDCODE_UPSTREAM_MODEL or gpt-5.5
  --timeout-ms <ms>           Probe timeout. Default: 180000
  --verify-only               Skip device login; run status/probe/state checks only
  --skip-probe                Skip the SDK probe
  --skip-db-repair            Do not set upstream_accounts state=active/cooldown_until=NULL
  --recreate-gateway          Recreate the Gateway service after DB state repair
  -h, --help                  Show this help

Supported built-in account mappings:
  sub_openai_codex_dev -> /var/lib/codex-gateway/codex-home
  codex-pro-1          -> /var/lib/codex-gateway/codex-home-plus

Security:
  This script does not print container env, auth.json, API keys, bearer tokens,
  or device codes. Codex itself prints a one-time browser code during login;
  do not paste that code into chat, tickets, screenshots, or docs.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --account)
      ACCOUNT_ID="${2:-}"
      if [ -z "$ACCOUNT_ID" ]; then
        echo "error=missing_account" >&2
        exit 2
      fi
      shift 2
      ;;
    --codex-home)
      CODEX_HOME_OVERRIDE="${2:-}"
      if [ -z "$CODEX_HOME_OVERRIDE" ]; then
        echo "error=missing_codex_home" >&2
        exit 2
      fi
      shift 2
      ;;
    --container)
      CONTAINER_NAME="${2:-}"
      if [ -z "$CONTAINER_NAME" ]; then
        echo "error=missing_container" >&2
        exit 2
      fi
      shift 2
      ;;
    --model)
      MODEL="${2:-}"
      if [ -z "$MODEL" ]; then
        echo "error=missing_model" >&2
        exit 2
      fi
      shift 2
      ;;
    --timeout-ms)
      TIMEOUT_MS="${2:-}"
      if ! [[ "$TIMEOUT_MS" =~ ^[1-9][0-9]*$ ]]; then
        echo "error=invalid_timeout_ms value=$TIMEOUT_MS" >&2
        exit 2
      fi
      shift 2
      ;;
    --verify-only)
      DO_LOGIN=0
      shift
      ;;
    --skip-probe)
      DO_PROBE=0
      shift
      ;;
    --skip-db-repair)
      REPAIR_DB_STATE=0
      shift
      ;;
    --recreate-gateway)
      RECREATE_GATEWAY=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "error=unknown_argument arg=$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

codex_home_for_account() {
  case "$1" in
    sub_openai_codex_dev)
      printf '%s\n' "/var/lib/codex-gateway/codex-home"
      ;;
    codex-pro-1)
      printf '%s\n' "/var/lib/codex-gateway/codex-home-plus"
      ;;
    *)
      return 1
      ;;
  esac
}

docker_exec() {
  "${DOCKER_BIN[@]}" exec "$@"
}

compose() {
  "${COMPOSE_BIN[@]}" -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" "$@"
}

gateway_state_json() {
  docker_exec "$CONTAINER_NAME" node -e "
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.argv[1], { readonly: true });
const account = process.argv[2];
const row = db.prepare('select id,state,last_used_at,cooldown_until from upstream_accounts where id = ?').get(account);
if (!row) process.exit(2);
console.log(JSON.stringify(row));
" "$GATEWAY_DB" "$ACCOUNT_ID"
}

repair_gateway_state() {
  docker_exec "$CONTAINER_NAME" node -e "
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.argv[1]);
const account = process.argv[2];
db.prepare(\"update upstream_accounts set state = 'active', cooldown_until = null, updated_at = ? where id = ?\").run(new Date().toISOString(), account);
const row = db.prepare('select id,state,last_used_at,cooldown_until from upstream_accounts where id = ?').get(account);
if (!row) process.exit(2);
console.log(JSON.stringify(row));
" "$GATEWAY_DB" "$ACCOUNT_ID"
}

if [ -z "$CODEX_HOME_OVERRIDE" ]; then
  if ! CODEX_HOME_OVERRIDE="$(codex_home_for_account "$ACCOUNT_ID")"; then
    echo "error=unknown_account account=$ACCOUNT_ID" >&2
    echo "Provide --codex-home for custom accounts." >&2
    exit 2
  fi
fi

CODEX_HOME_TARGET="$CODEX_HOME_OVERRIDE"

if ! "${DOCKER_BIN[@]}" inspect "$CONTAINER_NAME" >/dev/null 2>&1; then
  echo "error=container_not_found container=$CONTAINER_NAME" >&2
  exit 1
fi

if [ "$DO_LOGIN" -eq 1 ] && [ ! -t 0 ]; then
  echo "error=interactive_tty_required" >&2
  echo "Run through an interactive shell, for example: ssh -tt <vm> 'cd <repo> && bash scripts/reauth-upstream-codex-account.sh --account $ACCOUNT_ID'" >&2
  exit 1
fi

echo "account=$ACCOUNT_ID"
echo "codex_home=$CODEX_HOME_TARGET"
echo "container=$CONTAINER_NAME"

docker_exec "$CONTAINER_NAME" mkdir -p "$CODEX_HOME_TARGET"
docker_exec "$CONTAINER_NAME" chmod 700 "$CODEX_HOME_TARGET"

echo "state_before=$(gateway_state_json)"

if [ "$DO_LOGIN" -eq 1 ]; then
  echo "login=starting_device_auth"
  docker_exec -it -e "CODEX_HOME=$CODEX_HOME_TARGET" "$CONTAINER_NAME" codex login --device-auth
  echo "login=completed"
else
  echo "login=skipped"
fi

echo "login_status=checking"
docker_exec -e "CODEX_HOME=$CODEX_HOME_TARGET" "$CONTAINER_NAME" codex login status

if [ -z "$MODEL" ]; then
  set +e
  MODEL="$(docker_exec "$CONTAINER_NAME" printenv MEDCODE_UPSTREAM_MODEL 2>/dev/null)"
  status=$?
  set -e
  if [ "$status" -ne 0 ] || [ -z "$MODEL" ]; then
    MODEL="gpt-5.5"
  fi
fi

if [ "$DO_PROBE" -eq 1 ]; then
  echo "probe=starting model=$MODEL timeout_ms=$TIMEOUT_MS"
  docker_exec -w /app "$CONTAINER_NAME" npm run probe:codex -- \
    --codex-home "$CODEX_HOME_TARGET" \
    --model "$MODEL" \
    --run \
    --timeout-ms "$TIMEOUT_MS" \
    --skip-git-repo-check
  echo "probe=ok"
else
  echo "probe=skipped"
fi

if [ "$REPAIR_DB_STATE" -eq 1 ]; then
  echo "state_repair=active"
  echo "state_after_repair=$(repair_gateway_state)"
else
  echo "state_repair=skipped"
  echo "state_after=$(gateway_state_json)"
fi

if [ "$RECREATE_GATEWAY" -eq 1 ]; then
  if [ ! -f "$COMPOSE_FILE" ]; then
    echo "error=compose_file_not_found path=$COMPOSE_FILE" >&2
    exit 1
  fi
  echo "gateway_recreate=starting"
  compose up -d --no-deps --force-recreate "$GATEWAY_SERVICE"
  echo "gateway_recreate=completed"
  echo "gateway_health=checking"
  compose exec -T "$GATEWAY_SERVICE" node -e "
fetch('http://127.0.0.1:8787/gateway/health')
  .then(async (res) => {
    const body = await res.text();
    console.log(body);
    if (!res.ok) process.exit(1);
  })
  .catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
"
else
  echo "gateway_recreate=skipped"
fi

echo "reauth_upstream_codex_account=ok"
