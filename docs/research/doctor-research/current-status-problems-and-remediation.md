# Doctor Research Current Status

Last verified: 2026-08-31.

This file contains current state and open concerns only. Completed rollout,
incident and case evidence remains in dated reports and Git history.

## Current State

- R760 is the only supported public/runtime/control authority.
- Public origin: `https://goldencode.instmarket.com.au:1443`
- API prefix: `/gateway/research/v1`
- Gateway, Research LLM Gateway, Worker and maintenance containers were healthy
  in the 2026-08-31 read-only check.
- Research services have no published host ports.
- Research uses an isolated Tencent GLM-5.3 `goldencode` profile.
- The former Azure Research/Gateway stack is retired from routine use and is
  not an old-client compatibility or rollback condition.
- CN1's retained loopback/dark edge is not in the request path.

Current Gateway release and container evidence are recorded in
[System Status](../../operations/system-status.md). Recheck live symlinks and
container labels before any change.

## Product Boundary

Doctor Research accepts a doctor's name, hospital and department and produces
an asynchronous evidence-backed public profile. Identity may require user
selection. Insufficient or conflicting public evidence is a valid terminal or
warning condition; the service must not invent facts to satisfy completeness.

The `brief` API name is retained for compatibility. Content completeness,
citation validity and medical quality require domain review in addition to
runtime success.

## Operational Priorities

1. Preserve subject/run/artifact isolation and `doctor_research` entitlement
   enforcement.
2. Keep Research LLM traffic isolated from public Gateway and Local Qwen.
3. Keep Worker/maintenance health, lease reconciliation, storage admission and
   backup freshness independently observable.
4. Preserve source provenance, warnings and deterministic artifact manifests.
5. Validate generic identity discovery without treating the reviewed identity
   registry as a whitelist.
6. Rotate any previously exposed secrets only through a separately approved
   coordinated procedure.

## Triage Order

1. Capture `X-Request-Id`, `run_id`, user prefix and exact local time.
2. Check R760 Gateway health and Research container health/restarts.
3. Inspect the run state, worker heartbeat and sanitized component logs.
4. Classify admission, worker, LLM, retrieval, domain-quality or client
   artifact handling before acting.
5. Use [Production Runbook](./production-runbook.md) for recovery and smoke.

Do not begin with Azure, a restart, provider reroute or database restore.
