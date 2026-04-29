# Operational Experience

Last updated: 2026-04-24

## Safety Rules That Worked

- Treat the Azure VM as shared/important infrastructure.
- Start every VM session with read-only inspection.
- Keep all gateway testing under user-owned paths.
- Bind development gateway only to `127.0.0.1:18787`.
- Never touch Nginx, firewall, systemd, Docker, `/opt/medevidence-v2`, or ports `80/443` during gateway experiments.
- Use `trap`/process-group cleanup for temporary gateway processes.
- Confirm cleanup with `ss` and `pgrep`.

## Access Lessons

- SSH key auth worked; password auth should not be scripted.
- The VM did not have system Node/npm installed.
- User-local Node under `$HOME/.local/codex-gateway-node` worked and avoided `sudo`.
- Inline SSH scripts from Windows PowerShell can corrupt Linux shell quoting/CRLF. Prefer one of:
  - simple one-line read-only commands,
  - stdin pipe to `bash -s`,
  - base64-encoded script transfer for quote-heavy commands.
- In PowerShell, remote Bash variables such as `$HOME`, `$PATH`, and custom env vars can be expanded locally if the SSH command is double-quoted. For multi-step VM scripts, normalize line endings and transfer a base64-encoded script.
- If the VM test checkout has harmless local lockfile drift from prior Linux `npm install` optional dependency metadata, do not use `git reset --hard`. Use `git merge --ff-only` when possible and `npm ci` to avoid further lockfile writes.
- Docker build uses `npm ci` inside the Node container image. If VM-side `npm install` rewrites optional/peer lockfile metadata and Docker later reports missing lockfile entries, repair only the lockfile metadata with the matching container npm generation, verify `npm ci --dry-run`, and keep the checkout clean before rebuilding.

## Operator Vocabulary

- Use "user" in operator docs and CLI examples for the person, client, or device group receiving access. The internal table is `subjects`.
- Use "API key" for the bearer token issued to a user. The internal table is `access_credentials`, and only the prefix plus hash is stored.
- Use "upstream Codex account" for the server-side ChatGPT/Codex login state under `CODEX_HOME`. The internal provider record is an upstream account.
- 中文文档里优先写“用户 / API key / 上游 Codex 账号 / 用量”，只在排查数据库或代码时补充 `subject`、`access_credential`、`upstream_account`。
- Admin write actions and full-key reveal actions are stored as audit events. Audit rows must not contain raw API keys; store only user ids, credential ids, credential prefixes, parameter summaries, status, and sanitized errors.
- API key issue/rotate/reveal requires a stable `GATEWAY_API_KEY_ENCRYPTION_SECRET`; losing it makes encrypted `token_ciphertext` unrecoverable.
- Historical hash-only API keys cannot be reconstructed. If full-key lookup is required for every active key, rotate historical keys after encrypted token storage is deployed or attach encrypted tokens from an existing secure source.
- Current token usage recording is observational: `events` and `report-usage` show provider usage fields, but token budget enforcement is still pending.

## Codex Auth Lessons

- VM desktop environment is not required.
- `codex login --device-auth` prints a browser URL and one-time code.
- Device-code authorization must be enabled in ChatGPT security settings.
- Keep the same `CODEX_HOME` for login, probes, gateway tests, and future service runs.
- `CODEX_HOME/auth.json` was created with `600` permissions; parent directories should be `700`.

## Gateway Smoke Lessons

- Development gateway status succeeded with:
  - temporary bearer token,
  - isolated `CODEX_HOME`,
  - loopback bind,
  - real Codex adapter.
- SSE smoke returned expected model output through the gateway.
- SQLite-backed smoke persisted session provider thread ids.
- The optimized auth/context/SSE gateway path was validated on the VM after commit `62b9801`; the smoke returned `codex-gateway-optimized-ok` and cleanup checks passed.
- The SQLite credential auth path was validated on the VM after commit `5f57221`; issue/list/revoke worked through the admin CLI, the gateway accepted the issued token, and rejected it after revoke.
- Credential rotate and in-process rate limiting were validated on the VM after commit `c696be0`; keep rate-limit smoke DBs explicitly named and remove them after validation.
- API key update operations should be validated with temporary DBs: update label/scope/expiration/rate limits, check `audit --action update-key`, and confirm no raw API key appears in audit output.
- API key management changes should be validated with temporary DBs: issue with `--name` and `--phone`, list active keys, reveal by prefix, rotate, revoke, check token usage fields in `events` and `report-usage`, and confirm audit output never contains a full API key.
- Auth-mode hardening was validated on the VM after commit `6f4d9d6`; health exposed credential auth mode, the leftover dev token path was rejected, and production dev auth failed at startup.
- Request event writing and admin CLI event inspection were validated on the VM after commit `3a35b24`; one successful credential request and one rate-limited request produced two queryable events, and the smoke DB was removed after validation.
- Admin CLI `report-usage` and `prune-events --dry-run` were validated on the VM after commit `43a5e08`; use explicitly named temporary DBs for prune validation and confirm there are no `usage-smoke.*` directories left afterward.
- Container deployment hardening was validated on the VM after commit `33f5b9b` by native `npm ci/build/test` plus read-only Docker inspection; Docker was absent, so no container was started and no Docker installation was attempted.
- Read-only maintenance-window baseline found existing Nginx on `80`, PostgreSQL on `127.0.0.1:5432`, a local service on `127.0.0.1:8081`, MedEvidence services, and no Docker CLI.
- During the approved maintenance window after commit `6e96329`, Docker Engine `29.4.1` and Docker Compose plugin `v5.1.3` were installed. The gateway image built after updating lockfile metadata, loopback health succeeded, and the container was stopped afterward.
- `node:sqlite` works on local Windows and Azure Ubuntu Node 24, but prints an experimental warning.
- After adding CA certificates to the runtime image, `codex login --device-auth` works inside the gateway container and persists auth under the `gateway_state` volume.
- The packaged runtime workdir `/app` is not a git checkout. Keep `CODEX_SKIP_GIT_REPO_CHECK=1` for the default container path, or change `CODEX_WORKDIR` to a mounted trusted git checkout before setting it back to `0`.
- When running `docker compose exec -T` inside a remote heredoc/base64 script, redirect stdin from `/dev/null`; otherwise compose can consume the remaining script input.
- After adding `GET /gateway/credentials/current`, validate API key UX without burning normal request limits by issuing a temporary key, calling the route once successfully, checking missing and wrong credentials return `401`, then revoking the key and disabling the smoke user.

## Known Pitfalls

- `npm run <script> -- --arg "value with spaces"` can still become fragile through nested SSH/shell layers. Prefer simple prompts for remote smoke tests.
- Running Codex probes can create session/cache files under `CODEX_HOME`; keep `.gateway-state/` and VM state directories out of Git.
- Do not run `docker compose down` on shared infrastructure unless the project name is explicit and verified.
- Do not install Docker on the current shared VM without an explicit maintenance window; Docker can alter iptables/network behavior.
- Keep public edge services out of the default compose file. On the shared VM, `80/443` must require a separate maintenance task.
- Docker is now installed on the shared VM, but the `qian` user was not added to the `docker` group. Continue using `sudo docker ...` for controlled operations unless access policy is explicitly changed.
- Do not leave temporary device-login logs in `/tmp`; remove them after authorization because they can contain one-time device codes.
- Public internal users need a real public HTTPS entrypoint. On the current shared VM, keep the gateway container loopback-only and add only a dedicated Nginx hostname that proxies to `127.0.0.1:18787` during an approved maintenance window. Do not let Docker/Caddy bind public `80/443` on this host while existing Nginx owns the edge.
- The approved public internal trial window for `gw.instmarket.com.au` kept Docker loopback-only, added a dedicated Nginx hostname, issued a Let's Encrypt certificate with certbot, and validated public credential auth. A temporary smoke key was revoked and the smoke users were disabled afterward.
- The Codex Gateway Nginx vhost must never become the default `80/443`
  server on the shared US VM. It should answer only the dedicated gateway
  hostname. IP-based or unknown-Host requests must continue to land on the
  MedEvidence default vhost that proxies to `127.0.0.1:8081`; otherwise CN
  gateway calls to `http://4.242.58.89` can be redirected into Codex Gateway and
  fail with `missing_credential`.

## Current Recommended Next Step

Container loopback validation and public HTTPS routing are complete. The next safe work is to harden OpenAI-compatible trial behavior without changing host edge services:

1. Keep `/v1/chat/completions` as the primary compatibility target.
2. Verify OpenAI-shaped `tool_calls`, tool-result history messages, streaming chunks, and usage fields after every gateway rebuild.
3. Verify `GET /gateway/credentials/current` after every gateway rebuild so client login/settings pages can validate API keys without model calls.
4. Check `trial-check`, `report-usage`, `events`, and `audit` daily during the trial.
5. Keep the gateway container loopback-only and keep Nginx as the only public edge.
6. Before expanding beyond 10 controlled-trial users, revisit persistent multi-process rate limiting, admin operator identity capture, backup automation, and scheduled retention.
