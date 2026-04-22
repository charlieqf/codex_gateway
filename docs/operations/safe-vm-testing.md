# Safe Shared-VM Testing

Use this guide whenever the Azure Ubuntu VM may already be running important
services. The goal is to validate Codex Gateway without changing host-level
services or public traffic.

## Hard Rules

- Bind gateway tests only to `127.0.0.1:18787`.
- Do not bind `0.0.0.0:80` or `0.0.0.0:443`.
- Do not modify Nginx, Caddy, Apache, firewall, Azure NSG, Docker daemon, or
  systemd units.
- Do not run `docker compose down` unless the compose project name is explicit
  and verified for this project only.
- Do not write into existing application directories.
- Do not commit or print VM passwords, ChatGPT tokens, Codex `auth.json`,
  browser cookies, or bearer tokens.

## Safe Inspection

Start with read-only commands:

```bash
hostname
whoami
pwd
df -h
free -h
ss -ltnp
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}\t{{.Status}}' || true
docker compose ls || true
```

If a command is missing or permission-denied, record it and continue with the
next read-only check. Do not install packages or restart services.

## Native Node Smoke

Use this path when Docker is missing or should not be touched:

```bash
cd "$HOME/codex-gateway-test"
export NODE_HOME="$HOME/.local/codex-gateway-node"
export PATH="$NODE_HOME/bin:$PATH"
export CODEX_HOME="$HOME/codex-gateway-state/codex-home"
export CODEX_WORKDIR="$HOME/codex-gateway-test"
export GATEWAY_SQLITE_PATH="$HOME/codex-gateway-state/gateway-smoke.db"
export GATEWAY_AUTH_MODE=credential
export GATEWAY_HOST=127.0.0.1
export GATEWAY_PORT=18787

npm ci
npm run build
```

Use the admin CLI to issue a temporary credential into the explicit smoke DB,
then start the gateway only for the duration of the test. Remove the smoke DB
afterward.

## Container Smoke

Only use this path if Docker already exists and inspection shows it can be used
without disturbing other services:

```bash
cp config/gateway.container.example.env config/gateway.container.env
docker compose -p codex_gateway_test -f compose.azure.yml build gateway
docker compose -p codex_gateway_test -f compose.azure.yml up -d gateway
curl -fsS http://127.0.0.1:18787/gateway/health
```

The default compose file starts only the gateway service, publishes only
`127.0.0.1:18787`, and applies local CPU, memory, pid, and capability limits.

Stop only this project's gateway container:

```bash
docker compose -p codex_gateway_test -f compose.azure.yml stop gateway
```

Do not remove volumes unless the state has been reviewed and is known to be
temporary.

## Cleanup Checks

After any smoke test:

```bash
ss -ltnp | grep ':18787' || true
ps -eo pid=,args= | grep -E '[a]pps/gateway|[c]odex exec|[c]odex app-server' || true
find "$HOME/codex-gateway-state" -maxdepth 1 -type d -name '*smoke*' -print
```

The expected final state is no listener on `18787`, no gateway/Codex smoke
process, and no leftover temporary smoke directories or DBs.
