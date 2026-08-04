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
loopback Gateway public route: none
```

Separately, CN1 now has the approved dedicated edge role for the R760 migration:

```text
gw.instmarket.com.au:443
  -> CN1 Nginx only
  -> https://goldencode.instmarket.com.au:1443
  -> R760 Gateway
```

The vhost is installed and enabled but remains dark because public
`gw.instmarket.com.au` DNS still points to Azure. It proxies to the fixed R760
public NAT `117.186.49.26:1443` with origin SNI
`goldencode.instmarket.com.au`; it does not proxy to CN1
`127.0.0.1:18787`, import R760 state or read any LLM/image provider key.

Do not treat the successful Aliyun-to-Aliyun explicit-resolution smoke as
public cutover approval. A 2026-08-04 Sydney public-Internet check was
intercepted before Nginx with Aliyun `Non-compliance ICP Filing` on HTTP and a
TLS reset on HTTPS; Azure-to-CN1 HTTPS was also reset. Resolve this public
ingress/filing boundary and repeat independent-network tests before changing
DNS. Further Nginx, certificate or public `80/443` changes still require an
explicit maintenance action.

Basic CN1 checks:

```bash
cd /opt/codex-gateway-cn1/current
docker compose -p codex_gateway_cn1 -f compose.azure.yml ps
curl -fsS http://127.0.0.1:18787/gateway/health
```

The CN1 profile exposes only `goldencode`, currently backed only by Tencent
GLM-5.2. Qianfan, Aliyun and OpenRouter are absent from the effective pool. See
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

Current destination boundary as of 2026-08-04:

- Docker/containerd roots and Gateway/Research state are under `/data`;
- `current` is release `43e118eb00083ee44164329568a62941169ee78c` and
  `previous` is the exact Azure-matching
  `4697fba0b74d2ea8aa0ace0699a6117397ad9b01` release. Only the public Gateway
  was updated; its active image is
  `sha256:11edd786e8b06f2b7ddc600d829503e3368bf971fd44f15618b76f34afed17f0`,
  while all three Research container IDs remain unchanged;
- six formal volumes contain the latest verified Azure online snapshots plus
  subsequent R760 E2E state;
- formal Compose project `codex_gateway_r760` is running all four business
  containers plus Mihomo healthy with zero restarts; only Gateway binds
  `127.0.0.1:18787`;
- the `goldencode` certificate/SNI vhost is installed and public `:1443` TLS
  and Gateway health return 200 with an explicit address override; ordinary
  `goldencode` public DNS is still pending;
- the management Netplan persists the USB NIC by MAC; a separate cold-boot
  maintenance drill still requires iDRAC/local-console fallback;
- public and Research GLM-5.2 routes are Tencent-only. They may reuse the same
  Tencent provider key, but keep separate Gateway/service/SQLite boundaries and
  validate the shared account's aggregate quota, rate and concurrency. A
  Tencent credential present in the protected local deployment config was
  exposed to operator terminal output on 2026-08-04 and must be rotated before
  cutover without printing any secret; architecture still does not require
  separate credentials for the two pools;
- a dedicated R760 Mihomo infrastructure container now provides image egress
  only on the private `codex_gateway_r760_default` network. It publishes no host
  port; only the public Gateway receives proxy variables, and Tencent/internal
  destinations are covered by exact `NO_PROXY` entries. The public
  `gpt-image-1.5` path and direct xAI provider smoke succeed. Gemini still fails
  with Google's unsupported-user-location precondition across all 21 currently
  alive copied nodes, so a supported-region node is still required before the
  complete three-model image gate passes. A real post-deploy image request event
  now attributes the selected route to `openai-api / gpt-image-1.5`; the paired
  text control event remains `tencent / glm-5.2`. Do not expose `7890`, route
  Research LLM through Mihomo or reuse an OpenEvidence residential proxy.

Destination text requests expose only `goldencode`, backed only by direct
Tencent GLM-5.2. Image generation remains separate at
`/gateway/images/generations` with client model `medcode-image-default`; target
upstreams are `gpt-image-1.5`, `grok-imagine-image-quality` and
`gemini-3.1-flash-image`, never `gpt-image-2`.

Before any R760 Compose mutation, use the exact formal release and private env
documented by the migration checklist, run `docker compose config --quiet`,
verify secret owner/mode and confirm the six named volumes. Never print the
rendered config, env files or secret contents. Recreate only the intended
service and preserve the current release, previous symlink, image tags and
state backup rollback boundaries.

The 2026-08-04 attribution release used a networkless immutable overlay of the
verified prior Gateway image plus the tested compiled Gateway/core output,
because the destination lacked a usable base-image cache and Docker Hub was
unstable. Preserve its installed release directory, image label and rollback tag; use the
canonical repository Dockerfile for the next normal rebuild when registry
access is stable.

Operate and validate the image-egress container with
[`r760-mihomo-image-egress.md`](./r760-mihomo-image-egress.md). It is a fifth
infrastructure container; the Doctor Research application boundary remains the
same four containers.

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
/home/qian/codex-gateway-release-4697fba-20260803T083513Z
```

The immutable release marker records runtime commit
`4697fba0b74d2ea8aa0ace0699a6117397ad9b01`. The Tencent-only route change has
a restricted pre-change backup under
`/home/qian/codex-gateway-backups/tencent-only-20260804T0255Z`; preserve the
previous verified releases and image tags until the migration observation and
rollback windows close.

The current Gateway image is
`sha256:02affff39848b80f280fba44514615e49197bad381ddd3b08c6d722f848a7f47`;
the current Research LLM Gateway image is
`sha256:99fc3789ae0920538e3fba202476b8a50162f1d110894cbfa5e26b6cfc012c6a`;
the current Research Worker image is
`sha256:9ca22e9f54dd38c64515bb7143ee3ff145dca4e6bfb1de5ac81b0b5abd4c726c`;
and the current Research maintenance image is
`sha256:dc76e04777f3c8a2b4ff5e5d2931d72643b76af26950cbd89b92550d619451cb`.

Production Compose mutations must now use the base file, Research overlay and
private Compose env together:

```bash
cd /home/qian/codex-gateway-release-4697fba-20260803T083513Z
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

Before removing the seven legacy public model IDs or cutting `gw` to R760, read
[`goldencode-cutover-audit-2026-08-04.zh-CN.md`](./goldencode-cutover-audit-2026-08-04.zh-CN.md).
The audit found active `max`/`pro` consumers and no account-side proof of the
shared Tencent quota/rate/concurrency, so both remain cutover blockers.

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

This preserves Azure's temporary eight-model compatibility/rollback surface; it
does not mean every enabled legacy route satisfies the Tencent-only target
policy. The 2026-08-04 audit confirmed enabled Qianfan, Aliyun and OpenRouter
GLM-5.2 legacy routes even though they had no latest seven-day traffic.

The recovery source for the restored 8-model Azure env on 2026-07-03 was:

```text
/home/qian/codex-gateway-release-goldencode-20260702T104451Z/config/gateway.container.env
```

Do not copy this file to CN1 or R760. Do not print its values. If env lines must be
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
cd /home/qian/codex-gateway-release-4697fba-20260803T083513Z
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

Build and unit tests must run in a separately prepared clean checkout, never by
fetching/checking out inside the live immutable release:

```bash
cd /home/qian/codex-gateway-build-<commit>
git status --short
test "$(git rev-parse HEAD)" = "<full-commit>"
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
cd /home/qian/codex-gateway-release-4697fba-20260803T083513Z
TARGET_ACCOUNT=codex-pro-1 bash scripts/public-image-plus-smoke.sh
TARGET_ACCOUNT=sub_openai_codex_dev bash scripts/public-image-plus-smoke.sh
```

Run public smoke scripts sequentially. Running multiple scripts that issue or
revoke temporary API keys at the same time can hit transient SQLite write locks.
