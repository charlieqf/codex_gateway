# Environment Access

Last updated: 2026-08-31.

This document covers the current R760 access boundary. Historical Azure and
migration commands have been removed from the active path.

## R760

```text
SSH:             root@117.186.49.26:7723
operator key:    C:\Users\rdpuser\.ssh\id_ed25519
app root:        /opt/codex-gateway-r760
compose project: codex_gateway_r760
gateway:         codex_gateway_r760-gateway-1
origin:          https://goldencode.instmarket.com.au:1443
```

Connectivity check:

```powershell
ssh -p 7723 -i $env:USERPROFILE\.ssh\id_ed25519 `
  -o BatchMode=yes -o ConnectTimeout=10 -o IdentitiesOnly=yes `
  root@117.186.49.26 "hostname; whoami"
```

## Fast Read-Only Paths

Desktop user messages:

```powershell
$cutoff = (Get-Date).ToUniversalTime().AddHours(-48).ToString("o")
python scripts\query-client-messages.py `
  --user "<name>" --since $cutoff --timezone Asia/Shanghai `
  --limit 500 --include-text --format json
```

Public health:

```powershell
Invoke-RestMethod https://goldencode.instmarket.com.au:1443/gateway/health
```

Live release and containers:

```bash
readlink -f /opt/codex-gateway-r760/current
readlink -f /opt/codex-gateway-r760/previous
docker ps --filter label=com.docker.compose.project=codex_gateway_r760 \
  --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
```

Do not print Compose configuration, container environment or protected files.

## Runtime Paths

Inside the Gateway container:

```text
gateway DB:      /var/lib/codex-gateway/gateway.db
client events:   /var/lib/codex-gateway/client-events.db
```

Only the Gateway publishes `127.0.0.1:18787->8787`. Research services and raw
Qwen/vLLM publish no host ports.

## Remote Command Safety

- Start with read-only checks.
- Use SSH keys; do not script passwords.
- Keep simple read-only remote commands on one line.
- For multi-step Bash, JSON or shell variables, pipe a reviewed script over
  SSH. Do not embed it in a double-quoted PowerShell string.
- Open diagnostic SQLite connections read-only and enable
  `PRAGMA query_only=ON`.
- Do not read or print env values, tokens, full credentials or `auth.json`.

## Deployment Boundary

Before an authorized deployment:

1. read the component-specific runbook and current state;
2. verify the committed release and unrelated working-tree changes;
3. create and verify a pre-change backup;
4. validate protected file existence/owner/mode without printing contents;
5. run `docker compose config --quiet`, never rendered config;
6. recreate only the intended service;
7. verify release symlinks, health/restarts, bug-specific smoke and database
   integrity.

Do not change Nginx, firewall, Netplan, Docker daemon, DNS or public ports
unless the user explicitly authorizes that infrastructure change.

## Former Azure Gateway

The former Azure Gateway is logically offline and excluded from ordinary
queries, control writes, usage reports, validation and rollback. Its shared VM
may retain unrelated services and audit data. Access requires a separately
authorized historical recovery or shared-host maintenance task.
