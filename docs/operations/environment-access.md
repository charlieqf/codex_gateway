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

Before deciding whether a setting needs an image build, container recreate or
no restart, consult
[`runtime-configuration-change-matrix.md`](runtime-configuration-change-matrix.md).

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

## CN1 GoldenCode Gateway Access Pattern

CN1 hosts a separate Codex Gateway profile for domestic-only GoldenCode testing.
Use operator-local skill/access notes for the concrete CN1 SSH target.

This is not the Azure `gw.instmarket.com.au` gateway. Do not copy Azure's full
8-model env to CN1.

Current CN1 Gateway shape:

```text
app root: /opt/codex-gateway-cn1
current release: /opt/codex-gateway-cn1/current
compose project: codex_gateway_cn1
container: codex_gateway_cn1-gateway-1
listener: 127.0.0.1:18787->8787
public route: none
```

Separately, CN1 has an approved but not yet installed edge role for the R760
migration:

```text
gw.instmarket.com.au:443
  -> CN1 Nginx only
  -> https://goldencode.instmarket.com.au:1443
  -> R760 Gateway
```

This edge vhost must not proxy to CN1 `127.0.0.1:18787`, import R760 state or
read any LLM/image provider key. Installing it is a public `80/443` maintenance
action and is not authorized by routine loopback checks.

Basic CN1 checks:

```bash
cd /opt/codex-gateway-cn1/current
docker compose -p codex_gateway_cn1 -f compose.azure.yml ps
curl -fsS http://127.0.0.1:18787/gateway/health
```

The CN1 profile exposes only `goldencode`, backed by `qianfan`, `tencent`, and
`aliyun` GLM-5.2 pool members. OpenRouter is intentionally absent. See
`docs/operations/cn1-goldencode-gateway.md` for the full runbook.

A four-container domestic Gateway and Doctor Research migration is prepared for
R760. The existing single-container CN1 commands are neither destination nor
cutover commands. CN1 is only the future `gw` edge, while R760 owns application
containers, state and provider credentials. The preparation, validation and
rollback gates are in
`docs/implementation/domestic-gateway-doctor-research-migration-plan-2026-07-30.zh-CN.md`.

## R760 Domestic Destination Access Pattern

Use operator-local access notes for the concrete SSH target and key. Keep those
details out of this repository.

Approved destination shape:

```text
app root: /opt/codex-gateway-r760
compose project: codex_gateway_r760
public gateway listener: 127.0.0.1:18787->8787
origin TLS identity: https://goldencode.instmarket.com.au:1443
advertised public base: https://gw.instmarket.com.au
public text models: goldencode only
```

The three other services are `research-llm-gateway`, `research-worker` and
`research-maintenance`; they publish no host port. Do not install another
PostgreSQL for this stack: Gateway/Research use their existing SQLite volumes,
and the host's PostgreSQL 17 data remains under `/data/postgresql/17/main` for
the services that already depend on it.

Current preparation boundary as of 2026-08-03:

- Docker/containerd roots and Gateway/Research state are under `/data`;
- four offline images and the clean release are staged;
- six formal volumes contain a verified initial Azure snapshot;
- formal Compose config passed while all four enable flags remained false;
- no formal container is running and `127.0.0.1:18787` is free;
- the `goldencode` certificate/SNI vhost is installed and public `:1443` TLS
  works with an explicit address override, returning expected `502` until the
  Gateway starts; ordinary `goldencode` public DNS is still pending;
- the management Netplan persists the USB NIC by MAC; a separate cold-boot
  maintenance drill still requires iDRAC/local-console fallback;
- the staged env still requires the newly approved low-cost image chain before
  it may be started. Public and Research may reference the same Aliyun provider
  key, but keep separate secret files/injection paths and validate the shared
  account's aggregate quota, rate and concurrency.

Destination text requests expose only `goldencode`, backed by direct Qianfan,
Tencent and Aliyun GLM-5.2. Image generation remains separate at
`/gateway/images/generations` with client model `medcode-image-default`; target
upstreams are `gpt-image-1.5`, `grok-imagine-image-quality` and
`gemini-3.1-flash-image`, never `gpt-image-2`.

Before any R760 Compose mutation, use the exact formal release and private env
documented by the migration checklist, run `docker compose config --quiet`,
verify secret owner/mode and confirm the six named volumes. Never print the
rendered config, env files or secret contents. Routine destination inspection
must remain read-only until the deploy window is explicitly authorized.

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
/home/qian/codex-gateway-release-29790d2-20260730T062157Z
```

The immutable release marker records runtime commit
`29790d2784913bfe14c71e8f72d51ae48748e5e7`. The verified immediate rollback
boundary is `/home/qian/codex-gateway-backups/29790d2/20260730T062157Z` plus
the four `rollback-cb703da-20260730T062157Z` image tags.

The current Gateway image is
`sha256:1c99ca4587e38bd053c2a826699000ef1ccf39a761168b94ad5e9eba85040e59`;
the current Research LLM Gateway image is
`sha256:c5183b2ce0c7afc3de7791ef0a9b280843da37cb915555543ea5ffe5cf050504`;
the current Research Worker image is
`sha256:be007db4c85b83501a3d73ce107c1d780b1c3fa8cb53723bc30fa25545ad80c2`;
and the current Research maintenance image is
`sha256:ea0992aa5163c2ba1e24de8438167152fe309ec425c20666b9cd33c2b851e274`.

Production Compose mutations must now use the base file, Research overlay and
private Compose env together:

```bash
cd /home/qian/codex-gateway-release-29790d2-20260730T062157Z
sudo docker compose \
  --env-file config/research.production.compose.env \
  -p codex_gateway_test \
  -f compose.azure.yml \
  -f compose.research-production.yml \
  --profile research-production <command>
```

Do not recreate `gateway` with only `compose.azure.yml`: that would omit the
Research API env and Research state mount. Read-only/admin `exec` commands
against the already-running Gateway may continue to use the base file alone.

The live Azure env file in that checkout must be treated as a protected runtime
artifact. On 2026-07-03, recreating the live container from a stale
`config/gateway.container.env` regressed `/v1/models` from the expected
8-model set to 4 models and temporarily removed `goldencode`. Before any
`docker compose up`, `--force-recreate`, or image rebuild against the live
`codex_gateway_test` project, verify that the env file still includes:

```text
MEDCODE_PUBLIC_MODELS_JSON with:
  max, specialist, consultant, expert, advisor, pro, standard, goldencode
MEDCODE_QIANFAN_API_KEY
MEDCODE_TENCENT_TOKENHUB_API_KEY
MEDCODE_ALIYUN_DASHSCOPE_API_KEY
MEDCODE_OPENROUTER_API_KEY
```

The recovery source for the restored 8-model Azure env on 2026-07-03 was:

```text
/home/qian/codex-gateway-release-goldencode-20260702T104451Z/config/gateway.container.env
```

Do not copy this file to CN1. Do not print its values. If env lines must be
merged, merge only named keys and keep any newer live-only settings, such as
image fallback secret-file paths and billing/admin token settings.

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

Production Doctor Research uses these additional non-public services and
separate Docker volumes:

```text
codex_gateway_test-research-llm-gateway-1
codex_gateway_test-research-worker-1
codex_gateway_test-research-maintenance-1

codex_gateway_test_research_production_state
codex_gateway_test_research_production_backups
codex_gateway_test_research_production_llm_gateway_state
codex_gateway_test_research_production_llm_gateway_logs
```

Only the public Gateway publishes a Docker port, still exactly
`127.0.0.1:18787->8787`. The Research LLM Gateway, Worker and maintenance
services publish none.

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
