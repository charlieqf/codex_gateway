# Codex Gateway

Codex Gateway is the authenticated OpenAI-compatible service used by
GoldenCode/MedEvidence clients. The authoritative production runtime and
control plane is R760.

## Current Production Contract

```text
origin:        https://goldencode.instmarket.com.au:1443
OpenAI base:   https://goldencode.instmarket.com.au:1443/v1
cloud model:  goldencode
local model:  goldencode-local
image model:  medcode-image-default
```

The former Azure Gateway is retired from routine operations. CN1 retains an
isolated loopback/dark edge but is not a public authority or fallback.

## Start With The Task

- Current state: [System Status](./docs/operations/system-status.md)
- Operations routing: [Runbook Index](./docs/operations/runbook-index.md)
- Environment and deployment: [Environment Access](./docs/operations/environment-access.md)
  and [Container Deployment](./docs/operations/container-deploy.md)
- Named-user Desktop messages:
  [Desktop User Message Query](./docs/operations/client-message-query-support.zh-CN.md)
- User/key/Plan/usage authority:
  [R760 Control-Plane Authority](./docs/operations/r760-control-plane-authority.md)
- Client API contract: [Consumer Technical Guide](./docs/consumer-technical-guide.md)
- Doctor Research: [Doctor Research](./docs/research/doctor-research/README.md)

Dated reports and files under `docs/implementation` are design/history unless
a current runbook links them for a specific task. Do not read all documents
before starting a routine query.

## Repository Shape

```text
apps/gateway/          HTTP Gateway and adapters
apps/admin-cli/        operator CLI
apps/research-worker/  Doctor Research worker/maintenance
packages/              shared contracts, providers and SQLite stores
scripts/               guarded operations, smokes and support wrappers
docs/operations/       current runbooks and dated release evidence
docs/research/          Doctor Research contract and implementation records
tests/                  contract and end-to-end coverage
```

## Local Development

Requires Node.js 24 or newer.

```powershell
npm install
npm run typecheck
npm test
npm run dev:gateway
```

Useful commands:

```powershell
npm run dev:admin -- --help
npm run probe:codex -- --codex-home .gateway-state\codex-home
```

Use checked-in example env files only as templates. Real provider keys,
Gateway secrets, Codex login state, unified keys and admin tokens must remain
outside Git and logs.

## Production Discipline

- Production deploys use clean immutable releases, not the local dirty tree.
- R760 data and control writes use guarded wrappers and verified backups.
- Never print secret-bearing env files or rendered Compose configuration.
- Recreate only the service explicitly in scope.
- Verify health, restart counts, focused smokes, SQLite integrity and cleanup.
- Update current-state documentation only after live verification.

## Terminology

- **User / subject:** person or client identity stored in `subjects`.
- **API key / credential:** bearer credential; storage retains a prefix and
  hash, not an ordinary plaintext copy.
- **Unified key:** opaque `cgu_live_*` client key resolving to governed backing
  services.
- **Request event:** request-level status, routing, usage and correlation
  evidence.
- **Client message event:** Desktop user-message telemetry stored separately
  from request events and correlated by subject/message identifiers.
