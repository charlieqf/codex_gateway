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
- Azure VM non-invasive smoke tests against `127.0.0.1:18787`.

Not completed:

- Formal access credential issue/list/revoke/rotate.
- Credential hash lookup replacing `GATEWAY_DEV_ACCESS_TOKEN`.
- Per-credential rate limiting.
- Scope enforcement beyond conservative Codex adapter defaults.
- Admin CLI implementation.
- Observation writer and usage reports.
- Long-running systemd/container deployment.
- Public TLS routing through Nginx/Caddy.

## Verified Runtime

Local and Azure VM checks have passed:

```bash
npm install
npm run build
npm test
```

Current test coverage:

- Provider Codex adapter event mapping and error normalization.
- SQLite store migration/session persistence.
- Gateway auth hook, request validation, subject isolation, SSE routes, and SQLite-backed session persistence.

## Provider Status

OpenAI Codex / ChatGPT subscription path is viable for MVP continuation:

- Device-code login works without desktop environment.
- Login state is stored under isolated `CODEX_HOME`.
- SDK streamed turn works.
- Resume by provider thread id works.
- Gateway-to-Codex SSE smoke works.

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

Only session persistence is wired into the gateway so far.

## Ops Skill

A local Codex skill named `codex-gateway-ops` has been created for this workstation. It is stored outside the repository under the local Codex skills directory because it contains operator-local access details. The public repository only records sanitized access patterns and safety rules.
