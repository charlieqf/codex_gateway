#!/bin/sh
set -eu

if [ "${CODEX_GATEWAY_ROLLOUT_ARCHIVE_ON_START:-0}" = "1" ]; then
  if ! node /app/scripts/archive-unreferenced-codex-rollouts.mjs --from-env --apply; then
    echo "warning=Codex rollout startup archive failed; gateway startup will continue without moving files." >&2
  fi
fi

exec "$@"
