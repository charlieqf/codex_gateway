# CN1 GoldenCode Gateway

Last updated: 2026-07-03

This runbook records the CN1-only Codex Gateway profile on the Aliyun CN1 VM.
It is deliberately different from the Azure `gw.instmarket.com.au` gateway.

## Current State

- Deployment host: Aliyun CN1 VM. Use operator-local skill/access notes for SSH
  details; do not commit SSH credentials or provider keys.
- App root: `/opt/codex-gateway-cn1`
- Current release symlink: `/opt/codex-gateway-cn1/current`
- Compose file: `/opt/codex-gateway-cn1/current/compose.azure.yml`
- Compose project: `codex_gateway_cn1`
- Container: `codex_gateway_cn1-gateway-1`
- Container image tag: `codex_gateway_cn1-gateway:latest`
- Runtime env file: `/opt/codex-gateway-cn1/current/config/gateway.container.env`
- Provider-key backup copy: `/opt/codex-gateway-cn1/secrets/provider.env`
- Docker volumes:
  - `codex_gateway_cn1_gateway_state`
  - `codex_gateway_cn1_gateway_logs`
- Listener: `127.0.0.1:18787->8787`
- Public routing: none. No CN1 Nginx public route is configured for this
  gateway yet.

## Model Profile

CN1 is a domestic-only, GLM-5.2-only gateway. `/v1/models` should expose only:

```text
goldencode
```

`goldencode` is a sticky HRW pool with these enabled members:

| member | runtime | upstream model |
| --- | --- | --- |
| `goldencode-qianfan` | `qianfan` | `glm-5.2` |
| `goldencode-tencent` | `tencent` | `glm-5.2` |
| `goldencode-aliyun` | `aliyun` | `glm-5.2` |

OpenRouter is intentionally absent from the CN1 profile. Do not add
`MEDCODE_OPENROUTER_*` env vars or an OpenRouter pool member to CN1 unless the
CN-only policy is deliberately changed.

Important env shape:

```text
MEDCODE_PUBLIC_MODEL_ID=goldencode
MEDCODE_IMAGE_GENERATION_ENABLED=0
GATEWAY_ALLOW_EMPTY_UPSTREAM_POOL=1
GATEWAY_PUBLIC_PHASE=cn1-loopback
```

`GATEWAY_ALLOW_EMPTY_UPSTREAM_POOL=1` is intentional for CN1 because this
profile does not expose Codex/OpenAI subscription-backed models. The service
still uses credential auth and SQLite state.

## Safety Rules

- Do not modify CN1 Nginx, public ports `80/443`, MedEvidence services, or
  firewall rules while operating this loopback gateway.
- Do not run `docker compose down` unless the project name is explicit and the
  volume impact is understood.
- Do not print `config/gateway.container.env`, provider keys, admin bearer
  tokens, or full user API keys.
- Do not copy Azure's full 8-model env onto CN1. Azure and CN1 are separate
  deployment profiles.
- If exposing CN1 publicly later, add a dedicated hostname/server block that
  proxies to `http://127.0.0.1:18787`. Do not reuse an existing MedEvidence
  hostname root path.

## Basic Checks

Run these on CN1:

```bash
cd /opt/codex-gateway-cn1/current
docker compose -p codex_gateway_cn1 -f compose.azure.yml ps
curl -fsS http://127.0.0.1:18787/gateway/health
ss -ltnp '( sport = :18787 or sport = :8787 )'
```

Expected health shape:

```json
{
  "state": "ready",
  "service": "goldencode",
  "auth_mode": "credential",
  "provider": "goldencode",
  "phase": "cn1-loopback"
}
```

Check that OpenRouter is absent without printing secrets:

```bash
cd /opt/codex-gateway-cn1/current
docker compose -p codex_gateway_cn1 -f compose.azure.yml exec -T gateway sh -lc '
for k in MEDCODE_PUBLIC_MODEL_ID MEDCODE_IMAGE_GENERATION_ENABLED GATEWAY_ALLOW_EMPTY_UPSTREAM_POOL GATEWAY_PUBLIC_PHASE; do
  printf "%s=%s\n" "$k" "$(printenv "$k")"
done
if printenv MEDCODE_OPENROUTER_API_KEY >/dev/null 2>&1; then
  echo openrouter_env=present
else
  echo openrouter_env=absent
fi
'
```

## Temporary-Key Smoke

Use the admin CLI inside the container. The full key is sensitive; keep it in a
shell variable and revoke it after the smoke.

```bash
cd /opt/codex-gateway-cn1/current
COMPOSE='docker compose -p codex_gateway_cn1 -f compose.azure.yml'
DB=/var/lib/codex-gateway/gateway.db
USER_ID="goldencode-cn1-smoke-$(date +%s)"

issue_json="$($COMPOSE exec -T gateway node apps/admin-cli/dist/index.js --db "$DB" issue \
  --user "$USER_ID" \
  --user-label "$USER_ID" \
  --label goldencode-cn1-smoke \
  --scope code \
  --expires-days 1 \
  --rpm 20 \
  --rpd 100 \
  --concurrent 2)"

token="$(printf '%s' "$issue_json" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>process.stdout.write(JSON.parse(s).token));')"
prefix="$(printf '%s' "$issue_json" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>process.stdout.write(JSON.parse(s).credential.prefix));')"

curl -fsS -H "Authorization: Bearer $token" \
  http://127.0.0.1:18787/v1/models

curl -fsS -H "Authorization: Bearer $token" \
  -H "Content-Type: application/json" \
  -H "x-medcode-client-session-id: cn1-smoke-session" \
  --data '{"model":"goldencode","messages":[{"role":"user","content":"Reply with exactly: cn1-goldencode-ok"}],"max_tokens":32}' \
  http://127.0.0.1:18787/v1/chat/completions

$COMPOSE exec -T gateway node apps/admin-cli/dist/index.js --db "$DB" revoke "$prefix" >/dev/null
$COMPOSE exec -T gateway node apps/admin-cli/dist/index.js --db "$DB" disable-user "$USER_ID" >/dev/null
```

## Sticky And Load-Balancing Smoke

For a fuller self-test, choose one HRW session for each member and send two
requests per session. The expected result is:

```text
goldencode-qianfan: 2
goldencode-tencent: 2
goldencode-aliyun: 2
```

Then verify request events with:

```bash
cd /opt/codex-gateway-cn1/current
docker compose -p codex_gateway_cn1 -f compose.azure.yml exec -T gateway \
  node apps/admin-cli/dist/index.js --db /var/lib/codex-gateway/gateway.db \
  events --user <temporary-smoke-user> --limit 20
```

For every successful smoke event, these fields should match:

```text
public_model_id=goldencode
upstream_account_id=goldencode-qianfan|goldencode-tencent|goldencode-aliyun
upstream_runtime=qianfan|tencent|aliyun
upstream_model=glm-5.2
reasoning_effort=medium
status=ok
```

## Deployment Notes

CN1 Docker Hub access was unstable during the first deployment. The initial
runtime image was loaded from the Azure-validated `codex_gateway_test-gateway`
image and re-tagged as `codex_gateway_cn1-gateway:latest`; runtime behavior is
controlled by CN1's separate env file, not by the Azure env.

Docker daemon proxy was configured through the local CN1 `mihomo` proxy to help
future image pulls:

```text
/etc/systemd/system/docker.service.d/http-proxy.conf
HTTP_PROXY=http://127.0.0.1:7890
HTTPS_PROXY=http://127.0.0.1:7890
```

If a future deploy builds on CN1, confirm Docker can pull base images first.
If Docker Hub remains unstable, prefer loading a trusted image artifact and
tagging it to `codex_gateway_cn1-gateway:latest`.

## Stop And Start

Stop only the CN1 Gateway:

```bash
cd /opt/codex-gateway-cn1/current
docker compose -p codex_gateway_cn1 -f compose.azure.yml stop gateway
```

Start it again:

```bash
cd /opt/codex-gateway-cn1/current
docker compose -p codex_gateway_cn1 -f compose.azure.yml up -d --no-build gateway
curl -fsS http://127.0.0.1:18787/gateway/health
```

Do not use the Azure compose project name `codex_gateway_test` on CN1.
