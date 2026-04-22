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
- `node:sqlite` works on local Windows and Azure Ubuntu Node 24, but prints an experimental warning.

## Known Pitfalls

- `npm run <script> -- --arg "value with spaces"` can still become fragile through nested SSH/shell layers. Prefer simple prompts for remote smoke tests.
- Running Codex probes can create session/cache files under `CODEX_HOME`; keep `.gateway-state/` and VM state directories out of Git.
- Do not run `docker compose down` on shared infrastructure unless the project name is explicit and verified.
- Do not install Docker on the current shared VM without an explicit maintenance window; Docker can alter iptables/network behavior.

## Current Recommended Next Step

Implement formal access credential management:

1. SQLite repository for `access_credentials`.
2. Opaque credential generation with prefix + hash.
3. Gateway auth middleware backed by SQLite.
4. Admin CLI `issue`, `list`, `revoke`.

