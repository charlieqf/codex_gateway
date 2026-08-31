# R760 Gateway Container Deployment

Last updated: 2026-08-31.

This runbook covers the current authoritative R760 Compose project. Historical
Azure internal-trial deployment commands are not a production path.

## Runtime Boundary

```text
app root:        /opt/codex-gateway-r760
current release: /opt/codex-gateway-r760/current
compose project: codex_gateway_r760
gateway:         codex_gateway_r760-gateway-1
listener:        127.0.0.1:18787->8787
```

The active Gateway container labels identify the exact Compose files and env
file. Verify those labels before deployment; do not guess or copy a historical
command.

Current verified shape:

```text
compose.azure.yml
compose.research-production.yml
/opt/codex-gateway-r760/shared/config/compose.r760.override.yml
config/research.production.compose.env
```

## Preconditions

1. The intended revision is committed and pushed.
2. Local build, focused tests and `git diff --check` pass.
3. The release archive comes from committed `HEAD`, not the dirty tree.
4. A new immutable release directory exists and `current`/`previous` are
   recorded.
5. A verified pre-change backup covers affected SQLite/config state.
6. Protected files exist with correct owner/mode; values are not printed.
7. Unrelated working-tree and production services remain untouched.

## Compose Validation

From the intended release:

```bash
cd /opt/codex-gateway-r760/current
docker compose \
  --env-file config/research.production.compose.env \
  -p codex_gateway_r760 \
  -f compose.azure.yml \
  -f compose.research-production.yml \
  -f /opt/codex-gateway-r760/shared/config/compose.r760.override.yml \
  --profile research-production \
  config --quiet
```

Never print the rendered Compose configuration.

## Recreate The Gateway Only

When the approved change affects only Gateway:

```bash
docker compose \
  --env-file config/research.production.compose.env \
  -p codex_gateway_r760 \
  -f compose.azure.yml \
  -f compose.research-production.yml \
  -f /opt/codex-gateway-r760/shared/config/compose.r760.override.yml \
  --profile research-production \
  up -d --no-deps --force-recreate gateway
```

Do not recreate Research, Qwen, Mihomo, Nginx or infrastructure unless they are
explicitly in scope.

## Verification

```bash
readlink -f /opt/codex-gateway-r760/current
readlink -f /opt/codex-gateway-r760/previous
docker ps --filter label=com.docker.compose.project=codex_gateway_r760 \
  --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
curl -fsS http://127.0.0.1:18787/gateway/health
```

Also require:

- expected image/revision labels;
- no unexpected container restart;
- public TLS health;
- bug-specific smoke;
- SQLite `quick_check=ok` and zero foreign-key violations when databases are
  in scope;
- sanitized recent-log scan;
- cleanup of temporary users, credentials, reservations and files.

Update `system-status.md` and the local Skill current-state reference only
after live verification. Put detailed evidence in a dated release report.
