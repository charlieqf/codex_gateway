# Container Deployment Runbook

This runbook describes the isolated Docker Compose deployment path for Codex
Gateway. It is designed for the Azure Ubuntu VM MVP while avoiding interference
with existing services.

## Files

- `Dockerfile`: builds the gateway runtime image with Node 24 and Codex CLI.
- `compose.azure.yml`: starts the gateway on VM loopback only.
- `compose.edge.example.yml`: optional future public TLS example; do not use on
  the shared VM without a maintenance window.
- `ops/nginx/codex-gateway-public-trial.example.conf`: Nginx example for a
  dedicated public trial hostname that proxies to the loopback gateway.
- `config/gateway.container.example.env`: template for production container
  environment.
- `ops/systemd/codex-gateway-compose.service`: optional future systemd wrapper.

Do not commit `config/gateway.container.env`; it is ignored by Git and should
contain only deployment-local values.

## Runtime Boundaries

The default compose service maps:

```text
VM 127.0.0.1:18787 -> gateway container 0.0.0.0:8787
```

It does not publish `80/443` and contains no public edge service. Public TLS is
kept in a separate example compose file to avoid accidental activation.

The gateway container runs as a non-root user and uses:

```text
/var/lib/codex-gateway/gateway.db
/var/lib/codex-gateway/codex-home
```

The default compose service also sets conservative local limits:

```text
cpus: 1.0
mem_limit: 1g
pids_limit: 256
cap_drop: ALL
no-new-privileges: true
```

## Production Environment

Create the local env file:

```bash
cp config/gateway.container.example.env config/gateway.container.env
chmod 600 config/gateway.container.env
```

Minimum required production values:

```bash
NODE_ENV=production
GATEWAY_AUTH_MODE=credential
GATEWAY_SQLITE_PATH=/var/lib/codex-gateway/gateway.db
CODEX_HOME=/var/lib/codex-gateway/codex-home
CODEX_WORKDIR=/app
CODEX_SKIP_GIT_REPO_CHECK=1
```

Do not set `GATEWAY_DEV_ACCESS_TOKEN` in production. The gateway startup path
fails fast if production has a dev token, missing SQLite path, missing
`CODEX_HOME`, or non-credential auth mode.

The default container image does not include a `.git` directory under `/app`.
Keep `CODEX_SKIP_GIT_REPO_CHECK=1` for this packaged runtime unless
`CODEX_WORKDIR` is changed to a mounted trusted git checkout.

## Build

```bash
docker compose -p codex_gateway_test -f compose.azure.yml build gateway
```

## Start

```bash
docker compose -p codex_gateway_test -f compose.azure.yml up -d gateway
docker compose -p codex_gateway_test -f compose.azure.yml ps
curl -fsS http://127.0.0.1:18787/gateway/health
```

Expected health response includes:

```json
{
  "state": "ready",
  "service": "codex-gateway",
  "auth_mode": "credential",
  "store": {
    "session": "sqlite",
    "observation": "enabled"
  }
}
```

The health endpoint intentionally exposes only non-sensitive runtime state. It
does not reveal token values, SQLite paths, or `CODEX_HOME`.

## Bootstrap API Key

Issue the first API key inside the running container:

```bash
docker compose -p codex_gateway_test -f compose.azure.yml exec gateway \
  node apps/admin-cli/dist/index.js \
  --db /var/lib/codex-gateway/gateway.db \
  issue --user bootstrap --name "Bootstrap User" --phone "+15550000000" --label bootstrap --scope code
```

`GATEWAY_API_KEY_ENCRYPTION_SECRET` must be set in the container environment
before issuing or rotating keys. The token is printed and stored as encrypted
`token_ciphertext`, so operators can later run `reveal-key <credential-prefix>`.
Do not put the full token in Git, shell history, or audit notes.

## Codex Login

The Codex login state must live in the persistent `gateway_state` volume:

```bash
docker compose -p codex_gateway_test -f compose.azure.yml exec gateway \
  codex login --device-auth
```

Authorize the device code in a browser. Do not print or copy `auth.json`.

## Usage and Retention

Inspect recent events:

```bash
docker compose -p codex_gateway_test -f compose.azure.yml exec gateway \
  node apps/admin-cli/dist/index.js \
  --db /var/lib/codex-gateway/gateway.db \
  events --user bootstrap --limit 50
```

Generate a dynamic daily report:

```bash
docker compose -p codex_gateway_test -f compose.azure.yml exec gateway \
  node apps/admin-cli/dist/index.js \
  --db /var/lib/codex-gateway/gateway.db \
  report-usage --user bootstrap --days 7
```

`events` and `report-usage` include token usage fields when upstream provider
usage is available: `prompt_tokens`, `completion_tokens`, `total_tokens`,
`cached_prompt_tokens`, `estimated_tokens`, and `usage_source`.

Preview retention cleanup first:

```bash
docker compose -p codex_gateway_test -f compose.azure.yml exec gateway \
  node apps/admin-cli/dist/index.js \
  --db /var/lib/codex-gateway/gateway.db \
  prune-events --before-days 30 --dry-run
```

Run without `--dry-run` only after reviewing `matched`.

## Stop

```bash
docker compose -p codex_gateway_test -f compose.azure.yml stop gateway
```

This preserves the SQLite DB and Codex login state.

## Upgrade

```bash
git fetch origin main
git merge --ff-only origin/main
docker compose -p codex_gateway_test -f compose.azure.yml build gateway
docker compose -p codex_gateway_test -f compose.azure.yml up -d gateway
curl -fsS http://127.0.0.1:18787/gateway/health
```

## Rollback

Record the previous commit before upgrade. To roll back:

```bash
git merge --ff-only <known-good-commit>
docker compose -p codex_gateway_test -f compose.azure.yml build gateway
docker compose -p codex_gateway_test -f compose.azure.yml up -d gateway
```

If the database schema has moved forward, prefer restoring a DB backup rather
than downgrading blindly.

## Backup

Stop the gateway or ensure no writes are in progress, then copy the state volume
to a local backup directory:

```bash
docker run --rm \
  -v codex_gateway_test_gateway_state:/data:ro \
  -v "$PWD/backups:/backup" \
  busybox tar czf /backup/gateway-state-$(date +%Y%m%d-%H%M%S).tgz /data
```

If `codex-home` is included, treat the archive as a sensitive credential backup.
Encrypt it and restrict access.

## Public TLS

The public edge examples are intentionally separated from `compose.azure.yml`.
Do not use them on the shared VM until `80/443` ownership and the maintenance
window are explicitly confirmed.

On the current shared VM, existing Nginx owns public `80` and proxies an
existing service to `127.0.0.1:8081`. For a controlled internal public trial,
prefer the Nginx example in
`ops/nginx/codex-gateway-public-trial.example.conf`: it leaves the gateway
container loopback-only and has Nginx proxy the dedicated hostname to
`127.0.0.1:18787`.

The Caddy edge example is for a future VM where this project owns `80/443`:

```bash
docker compose \
  -p codex_gateway \
  -f compose.azure.yml \
  -f compose.edge.example.yml \
  up -d caddy
```

On the current shared VM, public TLS integration should be handled as a separate
maintenance task.
