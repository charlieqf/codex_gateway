# Doctor Research Production Runbook

Last updated: 2026-11-24.

This is the current R760 runbook. Historical Azure deployment and rollback
commands remain in Git history and must not be used for ordinary operations.

## Runtime Boundary

```text
app root:        /opt/codex-gateway-r760
current release: /opt/codex-gateway-r760/current
compose project: codex_gateway_r760
public origin:   https://goldencode.instmarket.com.au:1443
```

Services:

- `gateway`: public API and Research admission/state API;
- `research-llm-gateway`: former private model route retained for rollback;
- `research-worker`: asynchronous execution;
- `research-maintenance`: backup/retention/reconciliation maintenance.

Only Gateway publishes loopback host port `127.0.0.1:18787`. Research services
must have no published host ports.

The R760 override directs the Worker to `http://gateway:8787`, allows host
`gateway`, and mounts the public-pool service credential as its LLM bearer.
The production Worker depends on the Gateway and Research maintenance service.
The base Compose file alone describes the earlier private route. When moving
the Worker, carry over the verified override and secret mount together.
The service credential is kept in
`/opt/codex-gateway-r760/shared/secrets/research-public-llm-bearer`.
For rollback, restore the Worker's previous endpoint, host allowlist,
dependency and bearer mount together, then recreate only `research-worker`
after its active queue drains. Verify an actual model response on the former
route first. Its Tencent plan endpoint returned 403001 on 2026-11-24.

For LLM readiness, check the authenticated Worker readiness endpoint and run a
small Chat Completions request. Readiness validates model access and policy.
Confirm real inference and token settlement in the public Gateway request
events under subject `research-worker-public-pool`. Match each Research stage's
`gateway_request_id` to the public request event to identify the provider.

## Read-Only Status

```bash
readlink -f /opt/codex-gateway-r760/current
readlink -f /opt/codex-gateway-r760/previous
docker ps --filter label=com.docker.compose.project=codex_gateway_r760 \
  --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
curl -fsS http://127.0.0.1:18787/gateway/health
```

Check sanitized recent logs only for the service in scope. Never print env
files, secret mounts or the rendered Compose configuration.

## Compose Shape

Verify active container labels before acting. The current shape uses:

```text
compose.azure.yml
compose.research-production.yml
/opt/codex-gateway-r760/shared/config/compose.r760.override.yml
config/research.production.compose.env
profile: research-production
```

Validate without rendering secrets:

```bash
cd /opt/codex-gateway-r760/current
docker compose \
  --env-file config/research.production.compose.env \
  -p codex_gateway_r760 \
  -f compose.azure.yml \
  -f compose.research-production.yml \
  -f /opt/codex-gateway-r760/shared/config/compose.r760.override.yml \
  --profile research-production config --quiet
```

## Change Procedure

1. Commit, test and push the intended revision.
2. Deploy a clean immutable release and record `current`/`previous`.
3. Verify protected env/secret file presence and mode without printing values.
4. Create and verify online backups for affected Gateway/Research SQLite state.
5. Validate Compose.
6. Recreate only explicitly approved services, respecting dependency order.
7. Verify health/restart counts, worker heartbeat, backup freshness, storage
   admission and the bug-specific smoke.
8. Confirm SQLite `quick_check=ok`, zero foreign-key violations and cleanup of
   temporary runs/users/keys/artifacts.

Do not recreate all services merely because one component changed. The general
release boundary is in
[R760 Container Deployment](../../operations/container-deploy.md).

## Client Smoke

Use a temporary real-user credential with `doctor_research` entitlement. Keep
the full key in a protected file:

```powershell
python scripts\doctor-research-demo.py `
  --base-url https://goldencode.instmarket.com.au:1443 `
  --api-key-file C:\private\doctor-research.key `
  --request-file .\request.json `
  --output-dir .\doctor-research-output
```

Validate request/run IDs, terminal state, manifest schema, artifact count,
sizes and SHA-256 values. Review medical content separately. Remove the
temporary key, entitlement, user/run artifacts and local output after the
smoke.

## Incident Classification

- Admission failure: entitlement, quota, worker heartbeat, backup freshness or
  storage guard.
- Stuck run: worker lease/heartbeat/checkpoint/reconciliation.
- LLM failure: public Gateway request events for the Research service account and provider attempts.
- Retrieval failure: first-party/search adapter evidence and allowed domains.
- Successful run with bad content: domain validation/Skill/evidence quality,
  not automatically infrastructure failure.
- Successful API with missing local file: client download/artifact handling.

Use request and run IDs. Do not restart, change provider routing or restore a
database until evidence identifies that layer.
