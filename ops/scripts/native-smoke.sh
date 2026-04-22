#!/usr/bin/env bash
set -euo pipefail

export PATH="${NODE_HOME:-$HOME/.local/codex-gateway-node}/bin:$PATH"
export GATEWAY_HOST="${GATEWAY_HOST:-127.0.0.1}"
export GATEWAY_PORT="${GATEWAY_PORT:-18787}"
LOG_FILE="${LOG_FILE:-/tmp/codex-gateway-native-smoke.log}"

if [ -n "${CODEX_HOME:-}" ]; then
  mkdir -p "$CODEX_HOME"
  chmod 700 "$CODEX_HOME"
fi

node --version
npm --version

npm install
npm run build

if ss -ltn | awk '{print $4}' | grep -q ":${GATEWAY_PORT}$"; then
  echo "Port ${GATEWAY_PORT} is already in use" >&2
  exit 2
fi

rm -f "$LOG_FILE"
echo "Starting gateway on ${GATEWAY_HOST}:${GATEWAY_PORT}"
setsid env GATEWAY_HOST="$GATEWAY_HOST" GATEWAY_PORT="$GATEWAY_PORT" \
  npm --workspace @codex-gateway/gateway run start >"$LOG_FILE" 2>&1 &
PID=$!

cleanup() {
  kill -TERM "-$PID" 2>/dev/null || true
  wait "$PID" 2>/dev/null || true
}
trap cleanup EXIT

for _ in $(seq 1 20); do
  if curl -fsS "http://${GATEWAY_HOST}:${GATEWAY_PORT}/gateway/health"; then
    echo
    echo "Native smoke test passed."
    exit 0
  fi
  sleep 1
done

echo "Gateway did not become healthy. Last log lines:" >&2
tail -80 "$LOG_FILE" >&2 || true
exit 4
