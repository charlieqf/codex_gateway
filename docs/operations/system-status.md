# System Status

Last updated: 2026-04-22

## Current Phase

The project is in Phase 1 development. It is not production deployed.

Completed:

- TypeScript/npm workspace scaffold.
- OpenAI Codex provider feasibility validation using ChatGPT device-code authorization.
- Real `provider-codex` adapter backed by `@openai/codex-sdk`.
- Development gateway routes:
  - `GET /gateway/status`
  - `POST /sessions`
  - `GET /sessions`
  - `POST /sessions/:id/messages` as SSE
- Temporary development bearer token via `GATEWAY_DEV_ACCESS_TOKEN`.
- Default-protected Fastify auth hook with explicit public health route.
- Request context injection for dev subject/subscription/provider/scope.
- SSE close abort, heartbeat, and write cleanup.
- SQLite schema migration and SQLite-backed session persistence via `GATEWAY_SQLITE_PATH`.
- Formal access credential issue/list/revoke/rotate MVP.
- Opaque access credential generation with stored SHA-256 hash and prefix lookup.
- SQLite-backed credential auth hook for gateway requests.
- Auth mode selection prefers credential auth when a credential store is available; dev auth is rejected under `NODE_ENV=production`.
- `/gateway/health` exposes `auth_mode`.
- Admin CLI `issue`, `list`, `revoke`, `rotate`, `events`, `report-usage`, and `prune-events`.
- Per-credential in-process rate limiting for requests per minute, requests per day, and concurrency.
- SQLite request event writer for gateway observations.
- Admin CLI usage aggregation and dry-run-capable manual request event pruning.
- Production runtime startup validation for credential auth, SQLite state, `CODEX_HOME`, and dev-token rejection.
- Docker Compose gateway skeleton with loopback-only port mapping, non-root runtime image, and local resource limits.
- Docker maintenance-window runbook for shared VM installation and rollback.
- Azure VM non-invasive smoke tests against `127.0.0.1:18787`.

Not completed:

- Persistent/distributed rate limiting for multiple gateway processes.
- Scope enforcement beyond conservative Codex adapter defaults.
- Scheduled retention automation and materialized usage reports.
- Activated long-running systemd/container deployment on the shared VM.
- Public TLS routing through Nginx/Caddy.

## Verified Runtime

Local and Azure VM checks have passed:

```bash
npm install
npm ci
npm run build
npm test
```

Most recent Azure VM validation:

- Commit `33f5b9b`.
- Node `v24.12.0`, npm `11.6.2`.
- `npm ci`, `npm run build`, and `npm test` passed.
- Container deployment skeleton was validated by native build/test only; the shared VM has no Docker CLI available, so no container was started.
- Read-only checks confirmed no listener on `18787` and no `node`, `codex`, or `tsx` smoke process.
- Local Windows validation also passed production health smoke with temporary SQLite/CODEX_HOME and health reporting `auth_mode: credential`, `session: sqlite`, and `observation: enabled`.

Current test coverage:

- Provider Codex adapter event mapping and error normalization.
- SQLite store migration/session persistence.
- Access credential generation, hash verification, expiration, and revocation.
- SQLite access credential persistence and revocation.
- In-memory gateway rate limiter for rpm/day/concurrency policies.
- SQLite request event persistence, usage aggregation, manual pruning, and admin CLI event listing.
- Gateway dev auth hook, credential auth hook, production runtime validation, rate-limit hook, request validation, subject isolation, SSE routes, and SQLite-backed session persistence.

## Provider Status

OpenAI Codex / ChatGPT subscription path is viable for MVP continuation:

- Device-code login works without desktop environment.
- Login state is stored under isolated `CODEX_HOME`.
- SDK streamed turn works.
- Resume by provider thread id works.
- Gateway-to-Codex SSE smoke works.
- Optimized gateway auth/context/SSE path was revalidated on the Azure VM after commit `62b9801`.
- SQLite credential auth path was revalidated on the Azure VM after commit `5f57221`.
- Credential rotate and in-process rate-limit paths were revalidated on the Azure VM after commit `c696be0`.
- Auth-mode hardening was revalidated on the Azure VM after commit `6f4d9d6`.
- Request event writing and admin CLI `events` were revalidated on the Azure VM after commit `3a35b24`.
- Admin CLI `report-usage` and dry-run-capable `prune-events` were revalidated on the Azure VM after commit `43a5e08`.
- Container deployment hardening and production runtime validation were revalidated on the Azure VM after commit `33f5b9b`; Docker was not available and was not installed.

Sensitive provider files:

- `CODEX_HOME/auth.json` exists only on the VM/user state directory.
- Do not commit, print, paste, or back up provider auth files unless encrypted and explicitly requested.

## Data State

Development state is intentionally isolated from existing VM services:

- Repo checkout: user-owned test directory.
- Node runtime: user-local install.
- Codex auth: user-owned isolated `CODEX_HOME`.
- SQLite gateway db: user-owned isolated state directory.

SQLite schema currently includes:

- `schema_migrations`
- `subjects`
- `subscriptions`
- `access_credentials`
- `sessions`
- `request_events`

Session persistence, access credential authentication, single-process credential rate limiting, request event writing, dynamic usage reports, and dry-run-capable manual event pruning are wired into the gateway. Scheduled retention jobs, materialized reports, and multi-process shared rate limiting are still pending.

## Ops Skill

A local Codex skill named `codex-gateway-ops` has been created for this workstation. It is stored outside the repository under the local Codex skills directory because it contains operator-local access details. The public repository only records sanitized access patterns and safety rules.
