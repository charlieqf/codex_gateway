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

Issue a local SQLite-backed API key for a user:

```powershell
$env:GATEWAY_SQLITE_PATH = "C:\work\code\codex-gateway\.gateway-state\gateway.db"
$env:GATEWAY_API_KEY_ENCRYPTION_SECRET = "<operator-managed-secret>"
npm run dev:admin -- --db $env:GATEWAY_SQLITE_PATH issue --user local-user --name "Local User" --phone "+15550000000" --label local-dev --scope code
```

Run the gateway in API key auth mode:

```powershell
Remove-Item Env:\GATEWAY_DEV_ACCESS_TOKEN -ErrorAction SilentlyContinue
$env:GATEWAY_AUTH_MODE = "credential"
$env:GATEWAY_SQLITE_PATH = "C:\work\code\codex-gateway\.gateway-state\gateway.db"
npm run dev:gateway
```

Auth mode safety:

- When `GATEWAY_SQLITE_PATH` points to an API-key-capable store, gateway startup defaults to API key auth even if `GATEWAY_DEV_ACCESS_TOKEN` is present.
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

Use only user-owned paths for native Node smoke tests and isolated development
checks. The historical checkout below may contain local operator/debug changes;
do not reset it without an explicit cleanup task:

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

The current live gateway is operated from a clean release checkout:

```text
/home/qian/codex-gateway-release-4e61f98-20260511T230214Z
```

The directory name records the original runtime deployment commit and is
historical; the checkout may be detached at a newer docs/scripts commit. Use
this directory for `compose.azure.yml`, public smoke scripts, and env-file
updates unless a newer release checkout has been created deliberately.

These `$HOME/codex-gateway-state` paths are not the current production state for
`gw.instmarket.com.au`. The live gateway runs in Docker Compose project
`codex_gateway_test`, and its production SQLite files are inside the gateway
container at:

```text
/var/lib/codex-gateway/gateway.db
/var/lib/codex-gateway/client-events.db
```

Those container paths are backed on the host by Docker volume
`codex_gateway_test_gateway_state`, not by a host `/var/lib/codex-gateway`
directory. For production admin CLI queries, run the CLI inside the running
container with `sudo docker compose -p codex_gateway_test -f compose.azure.yml
exec -T gateway ...`.

## Production Upstream Account Pool

The live controlled-trial gateway uses `GATEWAY_UPSTREAM_ACCOUNTS_JSON` and two
server-side Codex login states in the Docker volume:

```text
/var/lib/codex-gateway/codex-home
/var/lib/codex-gateway/codex-home-plus
/var/lib/codex-gateway/upstream-accounts.json
```

`sub_openai_codex_dev` preserves the original account id for session
compatibility. `codex-pro-1` is the second Pro account and uses
`/var/lib/codex-gateway/codex-home-plus`; it was named `codex-plus-1` before
2026-05-14. Both accounts use `maxConcurrent: 1`.

Device login for a live upstream account must use the hardened reauth script
from the release checkout. It sets only `CODEX_HOME`, never prints the
container environment or `auth.json`, runs the SDK probe with the live model,
and repairs the SQLite runtime row after a successful probe.

```bash
cd /home/qian/codex-gateway-release-4e61f98-20260511T230214Z
bash scripts/reauth-upstream-codex-account.sh --account codex-pro-1
```

If the account was already marked `reauth_required` inside the running gateway
process, add `--recreate-gateway` so the process reloads the repaired SQLite
state after the successful probe:

```bash
bash scripts/reauth-upstream-codex-account.sh --account codex-pro-1 --recreate-gateway
```

Verify only, without starting a device login:

```bash
bash scripts/reauth-upstream-codex-account.sh --account codex-pro-1 --verify-only
```

## Production Image Binding

The live P4c image binding uses env variable names in
`upstream-accounts.json`, not secret values:

```text
sub_openai_codex_dev -> MEDCODE_IMAGE_OPENAI_API_KEY
codex-pro-1          -> MEDCODE_IMAGE_OPENAI_API_KEY_B
```

The API key values live only in `config/gateway.container.env` and the running
container environment. Never print or commit them. If an image key fails due to
project billing, invalid key, or another persistent upstream issue, temporarily
remove only that account's `imageApiKeyEnv` from
`/var/lib/codex-gateway/upstream-accounts.json` and recreate the gateway
container so image traffic does not route to the broken key.

## Safe VM Test Commands

Build and unit tests:

```bash
cd /home/qian/codex-gateway-release-4e61f98-20260511T230214Z
git fetch origin main
git checkout --detach origin/main
export NODE_HOME="$HOME/.local/codex-gateway-node"
export PATH="$NODE_HOME/bin:$PATH"
npm ci
npm run build
npm test
```

User/API key CLI smoke:

```bash
export GATEWAY_API_KEY_ENCRYPTION_SECRET="<operator-managed-secret>"
node apps/admin-cli/dist/index.js --db "$HOME/codex-gateway-state/gateway.db" issue --user vm-smoke --name "VM Smoke" --phone "+15550000000" --label vm-smoke --scope code
node apps/admin-cli/dist/index.js --db "$HOME/codex-gateway-state/gateway.db" list-users
node apps/admin-cli/dist/index.js --db "$HOME/codex-gateway-state/gateway.db" list --user vm-smoke --active-only
node apps/admin-cli/dist/index.js --db "$HOME/codex-gateway-state/gateway.db" list-active-keys
node apps/admin-cli/dist/index.js --db "$HOME/codex-gateway-state/gateway.db" update-user vm-smoke --name "VM Smoke" --phone "+15550000000"
node apps/admin-cli/dist/index.js --db "$HOME/codex-gateway-state/gateway.db" reveal-key <credential-prefix>
node apps/admin-cli/dist/index.js --db "$HOME/codex-gateway-state/gateway.db" update-key <credential-prefix> --scope medical --rpm 10 --rpd 200 --concurrent 1
node apps/admin-cli/dist/index.js --db "$HOME/codex-gateway-state/gateway.db" events --user vm-smoke --limit 50
node apps/admin-cli/dist/index.js --db "$HOME/codex-gateway-state/gateway.db" report-usage --user vm-smoke --days 7
node apps/admin-cli/dist/index.js --db "$HOME/codex-gateway-state/gateway.db" report-usage --credential-id <credential-id> --days 7
node apps/admin-cli/dist/index.js --db "$HOME/codex-gateway-state/gateway.db" audit --user vm-smoke --limit 50
node apps/admin-cli/dist/index.js --db "$HOME/codex-gateway-state/gateway.db" trial-check --max-active-users 10
node apps/admin-cli/dist/index.js --db "$HOME/codex-gateway-state/gateway.db" disable-user vm-smoke
node apps/admin-cli/dist/index.js --db "$HOME/codex-gateway-state/gateway.db" enable-user vm-smoke
node apps/admin-cli/dist/index.js --db "$HOME/codex-gateway-state/gateway.db" prune-events --before-days 30 --dry-run
node apps/admin-cli/dist/index.js --db "$HOME/codex-gateway-state/gateway.db" rotate <credential-prefix> --grace-hours 24
node apps/admin-cli/dist/index.js --db "$HOME/codex-gateway-state/gateway.db" revoke <credential-prefix>
```

Only run `prune-events` without `--dry-run` after reviewing the cutoff and
matched count, preferably against an explicitly named smoke DB first. The admin
CLI records write-side operations in `admin_audit_events`; use `audit` to inspect
who was changed, which API key prefix was touched, and whether the operation
succeeded.
`events` and `report-usage` include token usage fields when the upstream provider
returns usage.

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

Public image smoke for a specific account:

```bash
cd /home/qian/codex-gateway-release-4e61f98-20260511T230214Z
TARGET_ACCOUNT=codex-pro-1 bash scripts/public-image-plus-smoke.sh
TARGET_ACCOUNT=sub_openai_codex_dev bash scripts/public-image-plus-smoke.sh
```

Run public smoke scripts sequentially. Running multiple scripts that issue or
revoke temporary API keys at the same time can hit transient SQLite write locks.
