#!/bin/sh
set -eu

real_codex="${CODEX_GATEWAY_REAL_CODEX_PATH:-/usr/local/bin/codex}"

if [ "${CODEX_GATEWAY_EPHEMERAL:-0}" = "1" ] && [ "${1:-}" = "exec" ]; then
  shift
  exec "$real_codex" exec --ephemeral "$@"
fi

exec "$real_codex" "$@"
