#!/usr/bin/env bash
set -euo pipefail

export PATH="${NODE_HOME:-$HOME/.local/codex-gateway-node}/bin:$PATH"
export GATEWAY_HOST="${GATEWAY_HOST:-127.0.0.1}"
export GATEWAY_PORT="${GATEWAY_PORT:-18787}"

node --version
npm --version

npm install
npm run build

echo "Starting gateway on ${GATEWAY_HOST}:${GATEWAY_PORT}"
npm --workspace @codex-gateway/gateway run start

