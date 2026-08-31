# MedCode Service Unavailable

Last updated: 2026-08-31.

Use this runbook after collecting the affected user, approximate time and any
session/message/request ID. Start read-only; do not restart or reauthenticate
from the generic UI message alone.

## 1. Locate The Request

For a named Desktop user, query messages first:

```powershell
$cutoff = (Get-Date).ToUniversalTime().AddHours(-2).ToString("o")
python scripts\query-client-messages.py `
  --user "<name>" --since $cutoff --timezone Asia/Shanghai `
  --limit 100 --include-text --format json
```

Use the resulting message/request IDs. Do not inspect unrelated users.

## 2. Check R760 Service Shape

```powershell
Invoke-RestMethod https://goldencode.instmarket.com.au:1443/gateway/health
ssh -p 7723 -i $env:USERPROFILE\.ssh\id_ed25519 `
  -o BatchMode=yes -o ConnectTimeout=10 -o IdentitiesOnly=yes `
  root@117.186.49.26 `
  "docker ps --filter label=com.docker.compose.project=codex_gateway_r760 --format '{{.Names}}|{{.Status}}|{{.Ports}}'"
```

Expected: Gateway and Research services healthy; only Gateway publishes
`127.0.0.1:18787->8787`. The local Qwen container is independently healthy
and has no host port.

If the container is down, switch to the container incident path. Do not continue
with provider-account remediation.

## 3. Inspect Events And Sanitized Logs

Inside R760:

```bash
docker exec codex_gateway_r760-gateway-1 \
  node apps/admin-cli/dist/index.js \
  --db /var/lib/codex-gateway/gateway.db \
  events --limit 100

docker logs --since 2h codex_gateway_r760-gateway-1 2>&1 \
  | grep -E 'sanitized error|context_compaction_required|context window|service_unavailable|rate limit|429|provider_reauth_required|output_length|truncated' \
  | tail -n 160 || true
```

Prefer filters by the known request, user or credential prefix through the
admin CLI. Never print container environment, provider response bodies, full
keys or auth files.

## 4. Classify Before Acting

| Evidence | Classification | Next action |
| --- | --- | --- |
| `context_compaction_required` | GoldenCode Local request exceeds 32K admission | Client compacts, rebuilds and retries once |
| Upstream context-window error | Context too large | Reduce history/material; do not reauthenticate |
| Gateway/provider 429 | Capacity or quota | Inspect origin, limit kind and retry-after |
| `missing_credential` / `invalid_credential` | Client/resolver authentication | Validate current credential path |
| Provider 5xx with Tencent route | Provider failure | Correlate neighboring requests and retry policy |
| Output length / truncated tool args | Long-output contract | Use long-output diagnostics |
| Gateway calls all `ok`, artifact missing/bad | Desktop/tool-loop/artifact | Move to Desktop investigation |
| Explicit provider credential/auth failure | Provider authentication | Use the provider-specific authorized recovery |

A generic `service_unavailable` is not proof of credential failure.

## 5. Recovery And Verification

Any mutation requires explicit authorization and the provider/component-specific
procedure. After recovery:

- re-run the exact failing request shape or a bounded equivalent;
- confirm a new request event has the expected terminal status;
- verify public health and container restart count;
- scan recent sanitized logs;
- confirm no temporary user, credential, reservation or file remains.

Report the request IDs and classification, not secrets or raw provider bodies.
