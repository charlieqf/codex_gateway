# Public Internal Controlled Trial Runbook

Last updated: 2026-04-23

This runbook is for a small controlled internal trial with up to 10 trusted users who must
reach the gateway from the public internet. It is not a public beta plan.

## Current VM Inventory

Read-only inspection on 2026-04-22 showed the original pre-trial baseline:

- Existing Nginx is active and owns public `80`.
- Public `443` is not currently listening on the VM.
- Existing Nginx has one enabled site, a default `server_name _` on `80`.
- That site proxies `location /` to `127.0.0.1:8081`.
- `127.0.0.1:8081` is an existing gunicorn service and must not be changed.
- PostgreSQL listens only on `127.0.0.1:5432`.
- Docker and containerd are active.
- The `codex_gateway_test` compose project name was created during early
  validation and is now the historical name used by the live trial deployment.
- The Codex Gateway compose file renders only `127.0.0.1:18787:8787`.
- UFW is inactive; Docker has installed its normal iptables/nftables chains.

Public routing must therefore be added as a dedicated Nginx hostname that
proxies to `127.0.0.1:18787`. Do not modify the existing default site behavior
or the existing `127.0.0.1:8081` upstream.

## Current Trial Endpoint

The current controlled public internal trial endpoint is:

```text
https://gw.instmarket.com.au
```

Current state after the approved maintenance window:

- `gw.instmarket.com.au` resolves to `4.242.58.89`.
- Existing host Nginx owns public `80` and `443`.
- Gateway Docker Compose publishes only `127.0.0.1:18787->8787`.
- Nginx proxies `gw.instmarket.com.au` HTTPS traffic to
  `http://127.0.0.1:18787`.
- Let's Encrypt certificate expires on 2026-07-21.
- Public health check succeeds:
  `https://gw.instmarket.com.au/gateway/health`.
- Live Gateway state is in Docker volume `codex_gateway_test_gateway_state`.
  The production SQLite paths are container paths:
  `/var/lib/codex-gateway/gateway.db` and
  `/var/lib/codex-gateway/client-events.db`.
- The VM host is not expected to have `/var/lib/codex-gateway`; do not use
  `$HOME/codex-gateway-state/gateway.db` for current production queries.

## Scope

Use this runbook only when:

- One trusted operator owns all admin CLI actions.
- The trial has at most 10 active users.
- The gateway runs as a single Docker Compose instance.
- Users receive individual API keys with daily and concurrency caps.
- A dedicated public hostname is available for the gateway.
- A maintenance window is approved for Nginx/TLS changes.

Admin operator identity capture and distributed rate limiting are intentionally
deferred for this tiny single-instance trial.

## Hard Boundaries

Do not:

- Change the existing Nginx default server block for `server_name _`.
- Change the existing `127.0.0.1:8081` service.
- Bind the gateway container directly to public `0.0.0.0`.
- Add a second public edge container that binds `80` or `443` on this shared VM.
- Run `docker compose down` unless the compose project name is explicit and
  reviewed.
- Print API keys, `CODEX_HOME/auth.json`, browser tokens, or VM secrets.

## Public Access Design

Use this topology:

```text
public HTTPS hostname
  -> existing host Nginx
  -> http://127.0.0.1:18787
  -> gateway container :8787
  -> codex_gateway_test_gateway_state volume
```

The compose service remains loopback-only:

```text
127.0.0.1:18787 -> gateway container 0.0.0.0:8787
```

This keeps Docker from owning public ports and lets Nginx remain the single host
edge process.

## Preflight

From the VM checkout:

```bash
cd "$HOME/codex-gateway-test"
export NODE_HOME="$HOME/.local/codex-gateway-node"
export PATH="$NODE_HOME/bin:$PATH"

npm run build
npm test
```

Read-only host checks:

```bash
hostname
whoami
sudo ss -ltnp
systemctl is-active nginx docker containerd postgresql@16-main medevidence-v2 medevidence-v2-worker ssh
sudo nginx -t
sudo docker compose -p codex_gateway_test -f compose.azure.yml config
```

Before starting, verify:

- Nginx still owns `80`.
- Nothing owns `443`.
- Nothing owns `127.0.0.1:18787`.
- Compose publishes only `127.0.0.1:18787:8787`.
- The existing Nginx site still proxies to `127.0.0.1:8081`.

## Start Gateway Container

Create or review the local env file:

```bash
cd "$HOME/codex-gateway-test"
cp -n config/gateway.container.example.env config/gateway.container.env
chmod 600 config/gateway.container.env
grep -E '^(NODE_ENV|GATEWAY_AUTH_MODE|GATEWAY_SQLITE_PATH|CODEX_HOME|CODEX_WORKDIR|CODEX_SKIP_GIT_REPO_CHECK)=' config/gateway.container.env
```

For the current Azure live gateway, `config/gateway.container.env` is not a
generic example file; it is a protected runtime artifact. Before any live
`build`, `up -d`, or `up -d --force-recreate`, run a model-config preflight.
This command prints only model ids and key presence, not secret values:

```bash
node - <<'NODE'
const fs = require("fs");
const envText = fs.readFileSync("config/gateway.container.env", "utf8");
const env = Object.fromEntries(
  envText
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith("#") && line.includes("="))
    .map((line) => {
      const index = line.indexOf("=");
      return [line.slice(0, index), line.slice(index + 1)];
    })
);
const expected = ["max", "specialist", "consultant", "expert", "advisor", "pro", "standard", "goldencode"];
const registry = JSON.parse(env.MEDCODE_PUBLIC_MODELS_JSON || "{}");
const ids = Object.keys(registry);
const missing = expected.filter((id) => !ids.includes(id));
const keyNames = [
  "MEDCODE_QIANFAN_API_KEY",
  "MEDCODE_TENCENT_TOKENHUB_API_KEY",
  "MEDCODE_ALIYUN_DASHSCOPE_API_KEY",
  "MEDCODE_OPENROUTER_API_KEY"
];
const missingKeys = keyNames.filter((name) => !env[name]);
console.log(JSON.stringify({ ids, missing, missingKeys }, null, 2));
if (missing.length || missingKeys.length) process.exit(1);
NODE
```

Do not proceed if this preflight fails. A stale env file can recreate a healthy
container that silently exposes only the older public model set.

Start the gateway:

```bash
sudo docker compose -p codex_gateway_test -f compose.azure.yml build gateway
sudo docker compose -p codex_gateway_test -f compose.azure.yml up -d gateway
sudo docker compose -p codex_gateway_test -f compose.azure.yml ps
curl -fsS http://127.0.0.1:18787/gateway/health
```

Expected health includes `state: ready`, `auth_mode: credential`, SQLite session
store, and observation enabled.

After every live recreate, validate the public model surface before declaring
the deployment complete:

```bash
USER_ID="goldencode-model-smoke-$(date +%s)"
ISSUE_JSON="$(
  sudo docker compose -p codex_gateway_test -f compose.azure.yml exec -T gateway \
    node apps/admin-cli/dist/index.js --db /var/lib/codex-gateway/gateway.db \
    issue --user "$USER_ID" --user-label "$USER_ID" --label goldencode-model-smoke \
    --scope code --expires-days 1 --rpm 3 --rpd 10 --concurrent 1
)"
TOKEN="$(printf '%s' "$ISSUE_JSON" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>process.stdout.write(JSON.parse(s).token))')"
PREFIX="$(printf '%s' "$ISSUE_JSON" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>process.stdout.write(JSON.parse(s).credential.prefix))')"

curl -fsS -H "Authorization: Bearer $TOKEN" \
  https://gw.instmarket.com.au/v1/models \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const ids=JSON.parse(s).data.map((m)=>m.id); const required=["max","specialist","consultant","expert","advisor","pro","standard","goldencode"]; const missing=required.filter((id)=>!ids.includes(id)); console.log(JSON.stringify({ids, missing})); if(missing.length) process.exit(1);})'

curl -fsS -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -H "x-medcode-client-session-id: goldencode-model-smoke" \
  --data '{"model":"goldencode","messages":[{"role":"user","content":"Reply with exactly: goldencode-ok"}],"max_tokens":32}' \
  https://gw.instmarket.com.au/v1/chat/completions \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const x=JSON.parse(s); console.log(JSON.stringify({model:x.model, choices:(x.choices||[]).length})); if(x.model!=="goldencode") process.exit(1);})'

sudo docker compose -p codex_gateway_test -f compose.azure.yml exec -T gateway \
  node apps/admin-cli/dist/index.js --db /var/lib/codex-gateway/gateway.db revoke "$PREFIX" >/dev/null
sudo docker compose -p codex_gateway_test -f compose.azure.yml exec -T gateway \
  node apps/admin-cli/dist/index.js --db /var/lib/codex-gateway/gateway.db disable-user "$USER_ID" >/dev/null
```

## Nginx Public Routing

Use `ops/nginx/codex-gateway-public-trial.example.conf` as the starting point.
Replace `trial-gateway.example.com` with the approved dedicated hostname.

Maintenance-window sequence:

```bash
cd "$HOME/codex-gateway-test"
sudo install -m 0644 ops/nginx/codex-gateway-public-trial.example.conf \
  /etc/nginx/sites-available/codex-gateway-public-trial.conf
sudo sed -i 's/trial-gateway.example.com/<approved-hostname>/g' \
  /etc/nginx/sites-available/codex-gateway-public-trial.conf
```

Provision TLS certificates for the approved hostname before enabling the `443`
server block. This VM did not have `certbot` or existing Let's Encrypt state in
the latest read-only inspection, so certificate provisioning must be part of the
maintenance plan.

Enable and test:

```bash
sudo ln -s /etc/nginx/sites-available/codex-gateway-public-trial.conf \
  /etc/nginx/sites-enabled/codex-gateway-public-trial.conf
sudo nginx -t
sudo systemctl reload nginx
```

Post-change checks:

```bash
sudo ss -ltnp '( sport = :80 or sport = :443 or sport = :18787 or sport = :8081 )'
curl -fsS http://127.0.0.1:18787/gateway/health
curl -fsS https://<approved-hostname>/gateway/health
curl -fsS http://127.0.0.1/ >/tmp/existing-nginx-check.html || true
systemctl is-active nginx docker containerd postgresql@16-main medevidence-v2 medevidence-v2-worker ssh
```

Expected:

- Nginx owns `80` and `443`.
- Gateway still owns only `127.0.0.1:18787` through Docker publishing.
- Existing app on `127.0.0.1:8081` remains active.
- Public health returns non-sensitive gateway health.

## Trial Check

The `trial-check` command is read-only. Run it inside the container after at
least one trial API key exists:

```bash
sudo docker compose -p codex_gateway_test -f compose.azure.yml exec -T gateway \
  node apps/admin-cli/dist/index.js \
  --db /var/lib/codex-gateway/gateway.db \
  trial-check --max-active-users 10
```

A result with warnings can still be acceptable for a tiny trial, but any `error`
should be fixed first. `trial-check` ignores the internal development user
`subj_dev` when counting active trial users, because the gateway may seed that
record for local development compatibility.

## Issue Access

For MedEvidence/Desktop users who need the unified broker credential, issue an
opaque `cgu_live_*` key through the billing/v2 path in
`docs/operations/medevidence-codex-key-provisioning.md`. That path
automatically requests the hidden MedEvidence v2 key and returns one client key
for handoff.

Create one API key per user. Prefer short expirations and explicit caps.
Use this direct `issue` path only for raw Gateway `cgw.*` access, internal
smoke users, or fallback operations where the user should not receive a
`cgu_live_*` key.

```bash
sudo docker compose -p codex_gateway_test -f compose.azure.yml exec -T gateway \
  node apps/admin-cli/dist/index.js \
  --db /var/lib/codex-gateway/gateway.db \
  issue \
  --user trial-alice \
  --name "Alice Zhang" \
  --phone "+15551234567" \
  --label "Alice internal trial" \
  --scope code \
  --expires-days 14 \
  --rpm 10 \
  --rpd 200 \
  --concurrent 1
```

`GATEWAY_API_KEY_ENCRYPTION_SECRET` must be configured in the container
environment before issuing or rotating keys. The API key is printed and stored
as encrypted `token_ciphertext`, so an operator can later run
`reveal-key <credential-prefix>`. Send full keys through the agreed private
channel only.

After issuing:

```bash
sudo docker compose -p codex_gateway_test -f compose.azure.yml exec -T gateway \
  node apps/admin-cli/dist/index.js --db /var/lib/codex-gateway/gateway.db list --user trial-alice --active-only
sudo docker compose -p codex_gateway_test -f compose.azure.yml exec -T gateway \
  node apps/admin-cli/dist/index.js --db /var/lib/codex-gateway/gateway.db list-active-keys --user trial-alice
sudo docker compose -p codex_gateway_test -f compose.azure.yml exec -T gateway \
  node apps/admin-cli/dist/index.js --db /var/lib/codex-gateway/gateway.db audit --user trial-alice --limit 20
sudo docker compose -p codex_gateway_test -f compose.azure.yml exec -T gateway \
  node apps/admin-cli/dist/index.js --db /var/lib/codex-gateway/gateway.db trial-check --max-active-users 10
```

## Daily Checks

From the operator workstation, use the read-only Python report for the current
Sydney calendar day:

```powershell
python scripts\check-daily-usage-health.py
```

The report queries production through SSH key authentication and checks public
and loopback health, VM resources, critical services, the Gateway container,
TLS expiry, recent request health, per-user usage, models, upstream accounts,
tokens, and error codes. Requests without a user id (for example rejected
`missing_credential` traffic) are reported separately and are not counted as
active users. The report does not read or print full API keys, phone numbers,
container environment variables, or user prompts.

Useful variants:

```powershell
# Machine-readable output for the current Sydney day.
python scripts\check-daily-usage-health.py --format json

# A completed historical Sydney calendar day.
python scripts\check-daily-usage-health.py --date 2026-07-15

# Return exit code 2 when the collected health state is warning or critical.
python scripts\check-daily-usage-health.py --fail-on-unhealthy
```

Without `--fail-on-unhealthy`, exit code `0` means collection completed even if
the report contains a warning; collection/connection failures return `1`.

The lower-level container commands remain available as a manual fallback.
During the trial, also check recent admin operations at least once per day:

```bash
sudo docker compose -p codex_gateway_test -f compose.azure.yml exec -T gateway \
  node apps/admin-cli/dist/index.js --db /var/lib/codex-gateway/gateway.db report-usage --days 1
sudo docker compose -p codex_gateway_test -f compose.azure.yml exec -T gateway \
  node apps/admin-cli/dist/index.js --db /var/lib/codex-gateway/gateway.db events --limit 50
sudo docker compose -p codex_gateway_test -f compose.azure.yml exec -T gateway \
  node apps/admin-cli/dist/index.js --db /var/lib/codex-gateway/gateway.db audit --limit 50
sudo docker compose -p codex_gateway_test -f compose.azure.yml exec -T gateway \
  node apps/admin-cli/dist/index.js --db /var/lib/codex-gateway/gateway.db trial-check --max-active-users 10
```

Look for:

- Unexpected active users or API keys.
- API keys without daily and concurrency caps.
- Missing user name or phone metadata for active trial users.
- Token usage spikes in `report-usage` or request-level `events`.
- Repeated `rate_limited` or provider errors.
- Admin actions that were not expected.
- Any `reveal-key` audit event that was not expected.

## Public OpenAI-Compatible Smoke

After rebuilding the gateway, run the public smoke script from the VM checkout:

```bash
cd "$HOME/codex-gateway-test"
./scripts/public-openai-smoke.sh
```

The script issues a temporary API key inside the running gateway container,
tests public HTTPS `/gateway/health`, `/v1/models`, non-streaming chat,
streaming chat, tool-result history, and `X-Request-Id` response headers, then
revokes the temporary key and disables the temporary user. It prints only the
temporary key prefix, not the full API key.

Useful overrides:

```bash
BASE_URL=https://gw.instmarket.com.au ./scripts/public-openai-smoke.sh
COMPOSE_COMMAND="docker compose" ./scripts/public-openai-smoke.sh
```

If a consumer reports a problem, ask for the response `X-Request-Id`, their API
key prefix, endpoint, status code, timestamp and timezone, and a redacted
request/response shape. Do not ask them to send a full API key.

## Backup

For the current trial stage, back up the Docker state volume while the gateway
is stopped. Online backup automation is still pending.

```bash
cd "$HOME/codex-gateway-test"
sudo docker compose -p codex_gateway_test -f compose.azure.yml stop gateway

backup_dir="$PWD/backups"
backup_stamp="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$backup_dir"
chmod 700 "$backup_dir"

sudo docker run --rm \
  -v codex_gateway_test_gateway_state:/data:ro \
  -v "$backup_dir:/backup" \
  busybox tar czf "/backup/gateway-state-$backup_stamp.tgz" /data

chmod 600 "$backup_dir/gateway-state-$backup_stamp.tgz"
sudo docker compose -p codex_gateway_test -f compose.azure.yml up -d gateway
```

If `codex-home` is included, treat the archive as a sensitive credential backup.
Do not print or upload it casually.

## Stop And Roll Back

Disable affected access immediately:

```bash
sudo docker compose -p codex_gateway_test -f compose.azure.yml exec -T gateway \
  node apps/admin-cli/dist/index.js --db /var/lib/codex-gateway/gateway.db disable-user trial-alice
```

Stop the gateway container:

```bash
sudo docker compose -p codex_gateway_test -f compose.azure.yml stop gateway
```

Remove only the gateway Nginx site if public routing causes trouble:

```bash
sudo rm -f /etc/nginx/sites-enabled/codex-gateway-public-trial.conf
sudo nginx -t
sudo systemctl reload nginx
```

Confirm:

```bash
sudo ss -ltnp '( sport = :80 or sport = :443 or sport = :18787 or sport = :8081 )'
systemctl is-active nginx docker containerd postgresql@16-main medevidence-v2 medevidence-v2-worker ssh
```

## Deferred Before Wider Trial

Before expanding beyond this controlled internal trial, implement or explicitly
accept the risk for:

- Long-running deployment ownership and alerting.
- Online SQLite backup/restore automation.
- Persistent/distributed rate limiting for more than one gateway instance.
- Admin operator identity capture.
- Scheduled request-event retention.
