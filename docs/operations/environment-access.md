# Environment Access

This document records safe access patterns. It intentionally does not store concrete VM passwords, device codes, ChatGPT tokens, `auth.json` contents, or public host details that should stay in operator-local notes.

## Local Development

Repository:

```text
C:\work\code\codex-gateway
```

Baseline commands:

```powershell
npm install
npm run build
npm test
npm run probe:codex -- --codex-home .gateway-state\codex-home
```

Development gateway:

```powershell
$env:GATEWAY_DEV_ACCESS_TOKEN = "local-dev-token"
$env:CODEX_HOME = "C:\work\code\codex-gateway\.gateway-state\codex-home"
$env:CODEX_WORKDIR = "C:\work\code\codex-gateway"
$env:GATEWAY_SQLITE_PATH = "C:\work\code\codex-gateway\.gateway-state\gateway.db"
npm run dev:gateway
```

Issue a local SQLite-backed access credential:

```powershell
$env:GATEWAY_SQLITE_PATH = "C:\work\code\codex-gateway\.gateway-state\gateway.db"
npm run dev:admin -- --db $env:GATEWAY_SQLITE_PATH issue --label local-dev --scope code
```

Run the gateway in credential auth mode:

```powershell
Remove-Item Env:\GATEWAY_DEV_ACCESS_TOKEN -ErrorAction SilentlyContinue
$env:GATEWAY_AUTH_MODE = "credential"
$env:GATEWAY_SQLITE_PATH = "C:\work\code\codex-gateway\.gateway-state\gateway.db"
npm run dev:gateway
```

Auth mode safety:

- When `GATEWAY_SQLITE_PATH` points to a credential-capable store, gateway startup defaults to credential auth even if `GATEWAY_DEV_ACCESS_TOKEN` is present.
- `GATEWAY_AUTH_MODE=dev` keeps the development bearer-token path explicit for local tests.
- `NODE_ENV=production` rejects dev auth mode at startup.
- `GET /gateway/health` returns `auth_mode`.

## Azure VM Access Pattern

Use SSH key authentication. Do not use or store VM passwords in scripts or docs.

Template:

```bash
ssh -i ~/.ssh/<azure-vm-key> qian@<azure-vm-host>
```

Before running any write operation, inspect the VM without changing services:

```bash
hostname
whoami
uname -a
df -h / /opt /var 2>/dev/null
free -h
ss -ltn
systemctl is-active nginx apache2 caddy docker 2>/dev/null || true
```

Known VM constraints from current testing:

- Existing important app lives under `/opt/medevidence-v2`.
- Nginx is active and owns port `80`.
- Local services have been observed on `127.0.0.1:8081` and `127.0.0.1:5432`.
- Docker Engine and the Docker Compose plugin are installed and active, but the `qian` user is not in the `docker` group.
- Continue using `sudo docker ...` for controlled gateway tests; do not change Docker daemon settings, network/firewall rules, or host service routing without an explicit maintenance window.

## VM Project Paths

Use only user-owned paths for Codex Gateway tests:

```bash
cd "$HOME/codex-gateway-test"
export NODE_HOME="$HOME/.local/codex-gateway-node"
export PATH="$NODE_HOME/bin:$PATH"
export CODEX_HOME="$HOME/codex-gateway-state/codex-home"
export CODEX_WORKDIR="$HOME/codex-gateway-test"
export GATEWAY_SQLITE_PATH="$HOME/codex-gateway-state/gateway.db"
```

Directory permissions:

```bash
chmod 700 "$HOME/codex-gateway-state" "$CODEX_HOME"
```

## Safe VM Test Commands

Build and unit tests:

```bash
cd "$HOME/codex-gateway-test"
git fetch origin main
git reset --hard origin/main
export NODE_HOME="$HOME/.local/codex-gateway-node"
export PATH="$NODE_HOME/bin:$PATH"
npm install
npm run build
npm test
```

Credential CLI smoke:

```bash
node apps/admin-cli/dist/index.js --db "$HOME/codex-gateway-state/gateway.db" issue --label vm-smoke --scope code
node apps/admin-cli/dist/index.js --db "$HOME/codex-gateway-state/gateway.db" list --active-only
node apps/admin-cli/dist/index.js --db "$HOME/codex-gateway-state/gateway.db" events --limit 50
node apps/admin-cli/dist/index.js --db "$HOME/codex-gateway-state/gateway.db" report-usage --days 7
node apps/admin-cli/dist/index.js --db "$HOME/codex-gateway-state/gateway.db" prune-events --before-days 30 --dry-run
node apps/admin-cli/dist/index.js --db "$HOME/codex-gateway-state/gateway.db" rotate <credential-prefix> --grace-hours 24
node apps/admin-cli/dist/index.js --db "$HOME/codex-gateway-state/gateway.db" revoke <credential-prefix>
```

Only run `prune-events` without `--dry-run` after reviewing the cutoff and matched count, preferably against an explicitly named smoke DB first.

Provider status probe:

```bash
export CODEX_HOME="$HOME/codex-gateway-state/codex-home"
npm run probe:codex -- --codex-home "$CODEX_HOME"
```

Provider SDK probe after authorization:

```bash
npm run probe:codex -- --codex-home "$CODEX_HOME" --run --timeout-ms 180000
```

Development gateway must bind only to loopback:

```bash
export GATEWAY_HOST=127.0.0.1
export GATEWAY_PORT=18787
```

After any gateway smoke test:

```bash
ss -ltnp 'sport = :18787' || true
pgrep -af 'node apps/gateway/dist/index.js|codex exec|codex app-server' || true
```
