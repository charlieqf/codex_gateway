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
- Admin CLI `issue`, `list`, `revoke`, and `rotate`.
- Per-credential in-process rate limiting for requests per minute, requests per day, and concurrency.
- Azure VM non-invasive smoke tests against `127.0.0.1:18787`.

Not completed:

- Persistent/distributed rate limiting for multiple gateway processes.
- Scope enforcement beyond conservative Codex adapter defaults.
- Observation writer and usage reports.
- Long-running systemd/container deployment.
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

- Commit `5f57221`.
- Node `v24.12.0`, npm `11.6.2`.
- `npm ci`, `npm run build`, and `npm test` passed.
- Admin CLI issued a temporary SQLite-backed credential.
- Loopback gateway smoke on `127.0.0.1:18787` with `GATEWAY_AUTH_MODE=credential` returned `codex-gateway-credential-ok` over SSE and persisted the provider session reference.
- Revoking the credential through the admin CLI caused the same bearer token to return `revoked_credential`.
- Post-test cleanup confirmed no listener on `18787` and no long-running gateway/Codex process.

Current test coverage:

- Provider Codex adapter event mapping and error normalization.
- SQLite store migration/session persistence.
- Access credential generation, hash verification, expiration, and revocation.
- SQLite access credential persistence and revocation.
- In-memory gateway rate limiter for rpm/day/concurrency policies.
- Gateway dev auth hook, credential auth hook, rate-limit hook, request validation, subject isolation, SSE routes, and SQLite-backed session persistence.

## Provider Status

OpenAI Codex / ChatGPT subscription path is viable for MVP continuation:

- Device-code login works without desktop environment.
- Login state is stored under isolated `CODEX_HOME`.
- SDK streamed turn works.
- Resume by provider thread id works.
- Gateway-to-Codex SSE smoke works.
- Optimized gateway auth/context/SSE path was revalidated on the Azure VM after commit `62b9801`.
- SQLite credential auth path was revalidated on the Azure VM after commit `5f57221`.

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

Session persistence, access credential authentication, and single-process credential rate limiting are wired into the gateway. Observation event writing and multi-process shared rate limiting are still pending.

## Ops Skill

A local Codex skill named `codex-gateway-ops` has been created for this workstation. It is stored outside the repository under the local Codex skills directory because it contains operator-local access details. The public repository only records sanitized access patterns and safety rules.
