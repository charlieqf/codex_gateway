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
- `node:sqlite` works on local Windows and Azure Ubuntu Node 24, but prints an experimental warning.

## Known Pitfalls

- `npm run <script> -- --arg "value with spaces"` can still become fragile through nested SSH/shell layers. Prefer simple prompts for remote smoke tests.
- Running Codex probes can create session/cache files under `CODEX_HOME`; keep `.gateway-state/` and VM state directories out of Git.
- Do not run `docker compose down` on shared infrastructure unless the project name is explicit and verified.
- Do not install Docker on the current shared VM without an explicit maintenance window; Docker can alter iptables/network behavior.
- Keep public edge services out of the default compose file. On the shared VM, `80/443` must require a separate maintenance task.

## Current Recommended Next Step

Validate the container path without changing host services:

1. Run local `docker compose config` using a temporary `config/gateway.container.env`.
2. Build the gateway image locally if Docker is available.
3. On the Azure VM, perform only read-only Docker inspection unless a maintenance window is approved.
4. Do not start a long-running container on the shared VM until current Docker usage and resource headroom are reviewed.
