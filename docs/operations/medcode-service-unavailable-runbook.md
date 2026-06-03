# MedCode Service Unavailable Runbook

Use this runbook when a user reports:

```text
MedCode service is temporarily unavailable.
```

## Rules

- Start read-only. Do not restart Gateway, Docker, Nginx, or host services until
  the failure mode is known.
- Run operational commands from an interactive SSH session on the VM. Do not
  compose quote-heavy Bash, JSON, heredocs, or Docker commands inside Windows
  PowerShell.
- Do not print container env, `auth.json`, API keys, bearer tokens, ChatGPT
  tokens, or device codes.
- Use the release checkout:

```bash
cd /home/qian/codex-gateway-release-4e61f98-20260511T230214Z
```

## 1. Check Service Shape

From the VM:

```bash
curl -fsS https://gw.instmarket.com.au/gateway/health
systemctl is-active nginx docker medevidence-v2 medevidence-v2-worker 2>/dev/null || true
sudo docker compose -p codex_gateway_test -f compose.azure.yml ps
```

Expected:

- Gateway health is `state=ready`.
- Existing host services are active.
- Gateway container is healthy.
- Gateway still publishes only `127.0.0.1:18787->8787`.

If the container or host services are down, stop this runbook and use the
container/host incident path. Do not continue with account reauthentication.

## 2. Inspect Recent Gateway Events

```bash
sudo docker compose -p codex_gateway_test -f compose.azure.yml exec -T gateway \
  node apps/admin-cli/dist/index.js \
  --db /var/lib/codex-gateway/gateway.db \
  events --limit 50
```

Look for:

- `error_code=service_unavailable`
- the affected `upstream_account_id`
- whether the other upstream account still has `status=ok`
- unusually large `estimated_tokens`
- `rate_limited=true` or a non-empty `limit_kind`
- `missing_credential` rows, which usually indicate unauthenticated probes or
  client credential issues rather than an upstream outage

## 3. Inspect Sanitized Provider Logs

```bash
sudo docker logs --since 2h codex_gateway_test-gateway-1 2>&1 \
  | grep -E 'Provider returned sanitized error|refresh token|context window|service_unavailable|provider_reauth_required|rate limit|429' \
  | tail -n 120 || true
```

Then check whether the issue is still happening:

```bash
sudo docker logs --since 15m codex_gateway_test-gateway-1 2>&1 \
  | grep -E 'Provider returned sanitized error|refresh token|context window|service_unavailable|provider_reauth_required|rate limit|429' \
  | tail -n 40 || true
```

## 4. Classify The Failure

| Evidence | Meaning | Action |
| --- | --- | --- |
| `refresh token ... revoked` or `refresh token ... already used` | Upstream Codex login state is invalid. | Reauthenticate the affected account. |
| `ran out of room in the model's context window` | The request context is too large. | Tell the user to start a new conversation or reduce history/materials. Do not reauth. |
| `rate limit`, `429`, or `rate_limited=true` | Request or upstream rate limit. | Use retry guidance and inspect `limit_kind`; do not reauth. |
| `missing_credential` only | Missing/invalid client credential or probe traffic. | Validate the user's API key with `/gateway/credentials/current`; do not reauth. |
| One account has repeated `service_unavailable`, the other has `ok` | Account-specific upstream problem. | Inspect logs for refresh-token evidence, then reauth if confirmed. |

## 5. Inspect Upstream Account State

```bash
sudo docker compose -p codex_gateway_test -f compose.azure.yml exec -T gateway node -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync("/var/lib/codex-gateway/gateway.db", { readonly: true });
const rows = db.prepare(
  "select id,state,last_used_at,cooldown_until from upstream_accounts order by id"
).all();
console.log(JSON.stringify(rows, null, 2));
'
```

Expected healthy state:

- `codex-pro-1`: `state=active`, `cooldown_until=null`
- `sub_openai_codex_dev`: `state=active`, `cooldown_until=null`

## 6. Reauthenticate Affected Account

Only run this after the evidence points to invalid upstream Codex login state.
This script sets only `CODEX_HOME`, runs `codex login --device-auth`, verifies
with the live model, and repairs the account row after a successful probe.

For `codex-pro-1`:

```bash
bash scripts/reauth-upstream-codex-account.sh --account codex-pro-1
```

If the running Gateway process has already loaded the account as
`reauth_required`, recreate only the Gateway service after the successful probe:

```bash
bash scripts/reauth-upstream-codex-account.sh --account codex-pro-1 --recreate-gateway
```

For verify-only checks:

```bash
bash scripts/reauth-upstream-codex-account.sh --account codex-pro-1 --verify-only
bash scripts/reauth-upstream-codex-account.sh --account sub_openai_codex_dev --verify-only
```

## 7. Confirm Recovery

After reauthentication, confirm:

```bash
sudo docker compose -p codex_gateway_test -f compose.azure.yml exec -T gateway \
  node apps/admin-cli/dist/index.js \
  --db /var/lib/codex-gateway/gateway.db \
  events --limit 30

sudo docker logs --since 15m codex_gateway_test-gateway-1 2>&1 \
  | grep -E 'Provider returned sanitized error|refresh token|context window|service_unavailable|provider_reauth_required' \
  | tail -n 40 || true
```

Recovery indicators:

- affected account has new `status=ok` request events
- `upstream_accounts.state=active`
- `cooldown_until=null`
- no fresh refresh-token provider errors
