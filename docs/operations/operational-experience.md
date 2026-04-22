# Operational Experience

Last updated: 2026-04-22

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

## Operator Vocabulary

- Use "user" in operator docs and CLI examples for the person, client, or device group receiving access. The internal table is `subjects`.
- Use "API key" for the bearer token issued to a user. The internal table is `access_credentials`, and only the prefix plus hash is stored.
- Use "upstream Codex account" for the server-side ChatGPT/Codex login state under `CODEX_HOME`. The internal provider record is a subscription.
- 中文文档里优先写“用户 / API key / 上游 Codex 账号 / 用量”，只在排查数据库或代码时补充 `subject`、`access_credential`、`subscription`。

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

## Known Pitfalls

- `npm run <script> -- --arg "value with spaces"` can still become fragile through nested SSH/shell layers. Prefer simple prompts for remote smoke tests.
- Running Codex probes can create session/cache files under `CODEX_HOME`; keep `.gateway-state/` and VM state directories out of Git.
- Do not run `docker compose down` on shared infrastructure unless the project name is explicit and verified.
- Do not install Docker on the current shared VM without an explicit maintenance window; Docker can alter iptables/network behavior.
- Keep public edge services out of the default compose file. On the shared VM, `80/443` must require a separate maintenance task.
- Docker is now installed on the shared VM, but the `qian` user was not added to the `docker` group. Continue using `sudo docker ...` for controlled operations unless access policy is explicitly changed.
- Do not leave temporary device-login logs in `/tmp`; remove them after authorization because they can contain one-time device codes.

## Current Recommended Next Step

Container loopback validation is complete. The next safe work is to choose the next MVP hardening item without changing host edge services:

1. Keep the shared VM gateway container stopped between tests.
2. Do not enable a long-running compose/systemd deployment until Docker resource headroom and operational ownership are reviewed.
3. Keep public TLS/Nginx integration as a separate maintenance task.
4. Consider the next application-level hardening work: persistent multi-process rate limiting, subject/subscription management, or scheduled event retention.
