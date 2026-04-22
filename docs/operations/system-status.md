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
- User-friendly API key issue/list/update/revoke/rotate MVP.
- Opaque access credential generation with stored SHA-256 hash and prefix lookup.
- SQLite-backed credential auth hook for gateway requests.
- Auth mode selection prefers credential auth when a credential store is available; dev auth is rejected under `NODE_ENV=production`.
- `/gateway/health` exposes `auth_mode`.
- Admin CLI `issue`, `list`, `list-users`, `update-key`, `disable-user`, `enable-user`, `revoke`, `rotate`, `events`, `report-usage`, `audit`, `trial-check`, and `prune-events`.
- Per-credential in-process rate limiting for requests per minute, requests per day, and concurrency.
- SQLite request event writer for gateway observations.
- Admin CLI usage aggregation and dry-run-capable manual request event pruning.
- Production runtime startup validation for credential auth, SQLite state, `CODEX_HOME`, and dev-token rejection.
- Docker Compose gateway skeleton with loopback-only port mapping, non-root runtime image, and local resource limits.
- Docker maintenance-window runbook for shared VM installation and rollback.
- Docker Engine and Docker Compose plugin installed on the Azure VM during an approved maintenance window.
- Public internal trial runbook and Nginx dedicated-hostname example.
- Long-running loopback gateway container started on the shared Azure VM for the controlled internal trial.
- Public HTTPS routing for `gw.instmarket.com.au` through existing host Nginx to `127.0.0.1:18787`.
- Azure VM non-invasive smoke tests against `127.0.0.1:18787`.

Not completed:

- Persistent/distributed rate limiting for multiple gateway processes.
- Scope enforcement beyond conservative Codex adapter defaults.
- Scheduled retention automation and materialized usage reports.
- Systemd ownership/monitoring for the long-running container.
- Real 1-2 user API key issuance for the public internal trial.

## Verified Runtime

Local and Azure VM checks have passed:

```bash
npm install
npm ci
npm run build
npm test
```

Most recent Azure VM validation:

- Commit `83ff834`.
- DNS `gw.instmarket.com.au` resolves to `4.242.58.89`.
- Docker Compose gateway is running as `codex_gateway_test-gateway-1` and publishes only `127.0.0.1:18787->8787`.
- Existing host Nginx owns public `80` and `443`; the gateway container does not bind public ports.
- Nginx has a dedicated `gw.instmarket.com.au` server that proxies HTTPS traffic to `http://127.0.0.1:18787`.
- Let's Encrypt certificate for `gw.instmarket.com.au` was issued with certbot and expires on 2026-07-21; certbot installed its automatic renewal task.
- Public `https://gw.instmarket.com.au/gateway/health` returns gateway health with `auth_mode: credential`, SQLite session store, and observation enabled.
- HTTP `http://gw.instmarket.com.au/gateway/health` redirects to HTTPS.
- A temporary public smoke API key successfully reached `https://gw.instmarket.com.au/gateway/status`, then was revoked; the revoked token returned `401`; smoke users were disabled afterward.
- `trial-check --max-active-users 2` currently reports not ready only because no real active trial API key has been issued yet.
- Existing services remained active: Nginx, Docker/containerd, PostgreSQL, SSH, `medevidence-v2`, and `medevidence-v2-worker`; Apache and Caddy stayed inactive.

Earlier Azure VM validation:

- Commit `6e96329`.
- Node `v24.12.0`, npm `11.6.2`.
- Docker `29.4.1` and Docker Compose plugin `v5.1.3` were installed from Docker's official Ubuntu apt repository during the approved maintenance window.
- Docker build initially exposed a lockfile incompatibility with the newer npm in the Node container image; commit `6e96329` updated `package-lock.json`, after which the gateway image built successfully.
- `codex_gateway_test` gateway container smoke returned health with `auth_mode: credential`, `store.session: sqlite`, and `store.observation: enabled`.
- During smoke, the gateway published only `127.0.0.1:18787->8787`; Nginx, MedEvidence, PostgreSQL, and SSH remained active.
- The gateway container was stopped after smoke. Final checks showed no running containers, no `18787` listener, and critical services still active. The test compose container and named volumes are retained but stopped.
- Follow-up container validation completed after installing CA certificates in the runtime image:
  - Device-code login inside the gateway container wrote `auth.json` to the persistent `gateway_state` volume with `600` permissions.
  - The packaged container workdir `/app` is not a git checkout, so the container defaults now set `CODEX_SKIP_GIT_REPO_CHECK=1`.
  - Rebuilt gateway image passed `npm run build`, `npm test`, compose config validation, Codex SDK probe from `/app`, and real loopback gateway SSE smoke.
  - The smoke response returned `codex-gateway-container-skip-ok`; the temporary credential was revoked; the gateway container was stopped; final checks showed no `18787` listener and Nginx/Docker still active.

Current test coverage:

- Provider Codex adapter event mapping and error normalization.
- SQLite store migration/session persistence.
- Access credential generation, hash verification, expiration, and revocation.
- SQLite user and API key persistence, API key update/revocation, user disable/enable, and admin audit event persistence.
- In-memory gateway rate limiter for rpm/day/concurrency policies.
- SQLite request event persistence, usage aggregation, manual pruning, admin CLI event listing, and read-only controlled-trial checks.
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
- Docker maintenance-window installation and loopback container smoke were completed on the Azure VM after commit `6e96329`.
- Containerized Codex device-code login, SDK probe, and gateway-to-Codex SSE smoke were revalidated on the Azure VM with the runtime image's CA bundle and `CODEX_SKIP_GIT_REPO_CHECK=1` default.
- User-friendly API key operations were validated locally and on the Azure VM: `issue --user`, `list-users`, `list --user`, `update-key`, `events --user`, `report-usage --user`, `disable-user`, and `enable-user`.
- Public internal trial preflight inventory found existing Nginx on public `80`, no host listener on `443`, the existing app upstream on `127.0.0.1:8081`, PostgreSQL on `127.0.0.1:5432`, Docker active with no running containers, and the Codex Gateway compose file publishing only `127.0.0.1:18787`.
- Public HTTPS internal-trial gateway routing was enabled after explicit authorization. Docker remains loopback-only; Nginx is the single public edge.

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
- `admin_audit_events`

Session persistence, API key authentication, API key update/revoke/rotate, user-level disable/enable, single-process API key rate limiting, request event writing, admin action audit events, dynamic usage reports, read-only controlled-trial checks, and dry-run-capable manual event pruning are wired into the gateway. Public HTTPS routing for `gw.instmarket.com.au` is active through existing Nginx. Scheduled retention jobs, materialized reports, admin operator identity capture, real trial-user key issuance, and multi-process shared rate limiting are still pending.

## Ops Skill

A local Codex skill named `codex-gateway-ops` has been created for this workstation. It is stored outside the repository under the local Codex skills directory because it contains operator-local access details. The public repository only records sanitized access patterns and safety rules.
