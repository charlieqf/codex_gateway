# Operational Experience

Last updated: 2026-07-23

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
- When the long-lived VM checkout is dirty, create or reuse a clean release
  checkout instead of cleaning it in place. The current release checkout name
  records the original runtime deployment commit and may be detached at a newer
  docs/scripts commit.
- A clean source archive intentionally excludes untracked production env and
  secret files. Before the first Compose recreate in a new release directory,
  copy every required protected file from the current release, restore its
  exact owner/group/mode, run Compose config validation, and explicitly verify
  each bind/secret source exists. A config-only pass does not guarantee that a
  later recreate can mount every relative secret path.
- The Azure host has no supported system Node/npm. Validate release code in an
  ephemeral Node container; for the Python suite that invokes Node-backed
  helpers, use an ephemeral image containing both Node and Python. Do not treat
  host `node` absence as a product test failure or install a new host runtime.
- Avoid quote-heavy one-line SSH commands from PowerShell when shell variables,
  JSON, or heredocs are involved. Transfer a temporary script or pipe normalized
  LF-only content to `bash -s`.
- Protected env files can wrap JSON values in matching single or double quotes.
  Preflight parsers should remove only one matching outer quote pair before
  `JSON.parse`, validate the exact expected registry, and print key names or
  presence only, never values.
- For disk admission, compare `available * 100` with `blocks * threshold`
  instead of truncating an integer percentage. Before deleting superseded
  deployment backups, resolve and validate every exact path, retain the current
  runtime rollback boundary plus the newly verified backup, and never touch
  live state volumes.
- Opening a copied SQLite database with a normal verification connection can
  create `-wal`/`-shm` sidecars. Prefer a read-only URI; if sidecars were
  created, remove only the exact files after the database and manifest checks
  pass.
- Nullable migration columns preserve old-row rollback compatibility, but new
  terminal observations should persist explicit boolean outcomes. In
  particular, record both `cancel_requested=false` and
  `cancel_observed=false` after an ordinary provider call, while preserving a
  previously observed `true`.
- Archives written through a root-owned temporary Docker container are also
  root-owned on the host bind mount. Use `sudo chmod` for the final mode, and
  install an error/exit recovery trap before stopping the live service so a
  post-backup permission failure cannot leave the container stopped.
- For live incident workflows, prefer an interactive SSH session into the VM and
  run repo Bash scripts there. Windows PowerShell should only open SSH or run
  simple one-line read-only commands; it should not be the business logic layer
  for remote Bash/Docker commands.
- Once the production Research overlay is active, every Gateway recreate must
  include `compose.azure.yml`, `compose.research-production.yml` and
  `config/research.production.compose.env`. A base-only recreate silently
  drops the Research env and state mount.
- Local Compose secrets ignore requested uid/gid/mode. Keep the host provider
  and Worker token files owned by `999:999` and mode `0400`, then verify the
  running non-root service can read them without printing their values.
- A mode-`0600` host smoke token must be read by a one-off container using the
  host owner's numeric UID/GID. Do not weaken the token file mode to make the
  default Node image user work.
- A scratch Docker volume is root-owned initially. For a networkless restore
  drill, initialize only that scratch volume with a one-shot container granted
  `CHOWN`, then run the actual backup verification as UID/GID `999:999` with
  all capabilities dropped.
- Exclude `secrets/`, smoke output and temporary operator scripts in
  `.dockerignore`. A Dockerfile that never copies a secret can still send it
  to the local daemon as part of the build context unless it is ignored.
- Do not transliterate Chinese doctor names inside the Worker or relax author
  matching. Accept an explicit PubMed-indexed literature identity only when an
  allowlisted official source co-locates the display and literature names, and
  still verify the matching author's same affiliation contains both the
  literature hospital and department.
- A bilingual journal page can close the Chinese/English name bridge without
  supplying a usable doctor research-direction claim. For a controlled run,
  allow a second first-party profile page with explicit position/expertise/
  research text; retain fail-closed `verified_research_direction_required`
  behavior instead of treating an article abstract as a doctor profile.

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
- Each upstream Codex account must use a distinct `CODEX_HOME`. The live
  account pool currently uses `/var/lib/codex-gateway/codex-home` and
  `/var/lib/codex-gateway/codex-home-plus` inside the Docker volume.
- The packaged runtime workdir `/app` is not a git checkout, so real Codex SDK
  probes from the container need `--skip-git-repo-check`.

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
- Public smoke scripts that issue/revoke temporary API keys should run
  sequentially. Running them in parallel can hit transient SQLite write locks
  in admin audit/key writes.
- The isolated Research LLM Gateway needs its authenticated Worker readiness
  route, but it must not make public admission available. Keep the separate
  `RESEARCH_PRODUCTION_LLM_READINESS_API_ENABLED` switch default-off, enable it
  only after the chat-only service credential exists, and publish no port for
  that service.
- Profile claim arrays are rebuilt only from exact contiguous official-source
  claims. Do not reapply the free-narrative adjacent-word numeric rule to those
  already closed claims; it falsely rejects one-token official phrases such as
  an alphanumeric research-program name. Review, core evidence, questions and
  answers must retain the stricter numeric evidence-closure and safe-redaction
  checks.
- Direct GLM-5.2 structured calls can take 8-14 minutes before the first byte
  for large evidence prompts. Keep lease renewal independent of the model
  request and preserve the 15-minute per-call and 30-minute per-run hard
  bounds; never replay the same non-idempotent model call across providers.
- The production Research backup volume is separate and Azure-managed disks
  are encrypted at rest, but both live and backup volumes currently reside on
  the same OS disk. The verified backup supports application rollback, not
  host-loss disaster recovery. Keep the 512 MiB storage ceiling and 10 GiB
  admission floor until an off-host backup target is approved.
- For P4 account-pool changes, preserve the legacy account id
  `sub_openai_codex_dev` so existing sessions remain sticky and continue to
  resolve after enabling `GATEWAY_UPSTREAM_ACCOUNTS_JSON`.
- For P4c image binding, store only env variable names in
  `/var/lib/codex-gateway/upstream-accounts.json`. API key values belong in the
  env file/container environment and must not be printed.
- The second live upstream account is now `codex-pro-1`; it uses the same
  `/var/lib/codex-gateway/codex-home-plus` login state and image env binding
  that were formerly attached to `codex-plus-1`. When renaming account ids,
  check for sticky `sessions.upstream_account_id` rows that still reference the
  old id before recreating the Gateway container.
- If an image key is routed successfully but OpenAI returns a persistent project
  error such as `Billing hard limit has been reached`, temporarily remove that
  account's `imageApiKeyEnv` and recreate the gateway so live image traffic does
  not keep selecting the broken key. After billing/key correction, rebind and
  verify with `scripts/public-image-plus-smoke.sh`.
- `scripts/public-image-plus-smoke.sh` chooses a temporary credential whose HRW
  affinity maps to the requested `TARGET_ACCOUNT`, grants a short image-capable
  entitlement, calls `/gateway/images/generations`, verifies the response, and
  checks `request_events.upstream_account_id`.
- `MedCode service is temporarily unavailable` is a symptom, not a root cause.
  Always classify it through `request_events` and sanitized provider logs before
  taking action. Refresh-token errors mean upstream Codex reauthentication;
  context-window errors mean the user request/history is too large; rate-limit
  errors mean retry/limit inspection; `missing_credential` usually means client
  credential/probe traffic.
- Upstream Codex reauthentication should use
  `scripts/reauth-upstream-codex-account.sh` from the VM release checkout. Do
  not hand-compose `docker exec sh -lc 'export CODEX_HOME=...'` login commands.
- Doctor Research warning lists are schema-controlled sets. A warning emitted
  by both fragment normalization and final safety normalization must be
  deduplicated before result assembly; otherwise a fully rendered run can fail
  after the `render_artifacts` checkpoint. Keep assembly-contract failures
  classified as `model_contract_error`, not `upstream_unavailable`, so the
  Worker does not restart for an internal deterministic contract defect.
- For Doctor Research timeout diagnosis, join `research_stage_runs` and
  Gateway `request_events` first by
  `run_id:stage:attempt` client session. A timed-out call may have no response
  request ID, while the client session still exposes provider first-event,
  duration, terminal source and cancellation observation.
- Treat Worker and internal-Gateway terminal sources as different layers. A
  Worker stage may record an HTTP `provider_response`/`model_upstream_error`
  while the joined internal request records `gateway_deadline` and cancellation
  `1/1`; correlate by request ID and
  `x-medcode-client-session-id=<run>:<stage>:<attempt>` before classifying it.
- For non-stream Research calls, legacy `first_byte_ms` is stamped after the
  response body is collected and is not model first-token latency. Use
  `provider_first_event_ms`; retain `first_byte_ms` only for compatibility.
- Accepting a model response envelope is safe only when the wrapper is unique
  and conventional. The `1.6.76` body-fragment normalizer accepts a direct
  fragment or exactly one `body`, `body_fragment`, or `review` wrapper, then
  reruns every fragment/Skill/complete validator. It must reject ambiguous or
  incomplete shapes instead of guessing which nested object is medical output.
- Real E2E scripts should install cleanup traps before issuing credentials and
  remove keys, entitlements, users and output paths on both success and error.
  Do not probe an invented public Research readiness route; use container
  health/admission checks or the authenticated internal Worker readiness route
  defined by the current runbook.
- Optional Doctor Research UI fields commonly arrive as `""`, whitespace, or
  `null`; normalize those representations to omitted before validating bounded
  optional text. Do not apply that rule to the required name/hospital/department
  identity anchors. In direct-source mode, a three-field request also needs a
  startup-validated server registry keyed by the normalized exact identity
  triple. Registry URLs must still pass the official-domain allowlist and the
  normal identity/evidence workflow; unregistered identities fail closed rather
  than being guessed from a translated name.

## Known Pitfalls

- `npm run <script> -- --arg "value with spaces"` can still become fragile through nested SSH/shell layers. Prefer simple prompts for remote smoke tests.
- Running Codex probes can create session/cache files under `CODEX_HOME`; keep `.gateway-state/` and VM state directories out of Git.
- Do not run `docker compose down` on shared infrastructure unless the project name is explicit and verified.
- Do not install Docker on the current shared VM without an explicit maintenance window; Docker can alter iptables/network behavior.
- Keep public edge services out of the default compose file. On the shared VM, `80/443` must require a separate maintenance task.
- Docker is now installed on the shared VM, but the `qian` user was not added to the `docker` group. Continue using `sudo docker ...` for controlled operations unless access policy is explicitly changed.
- Do not leave temporary device-login logs in `/tmp`; remove them after authorization because they can contain one-time device codes.
- Do not leave temporary key-injection files or smoke scripts in `/tmp`; clean
  them after use. They can contain one-time device codes, API keys, or
  operationally sensitive commands.
- Public internal users need a real public HTTPS entrypoint. On the current shared VM, keep the gateway container loopback-only and add only a dedicated Nginx hostname that proxies to `127.0.0.1:18787` during an approved maintenance window. Do not let Docker/Caddy bind public `80/443` on this host while existing Nginx owns the edge.
- The approved public internal trial window for `gw.instmarket.com.au` kept Docker loopback-only, added a dedicated Nginx hostname, issued a Let's Encrypt certificate with certbot, and validated public credential auth. A temporary smoke key was revoked and the smoke users were disabled afterward.
- The Codex Gateway Nginx vhost must never become the default `80/443`
  server on the shared US VM. It should answer only the dedicated gateway
  hostname. IP-based or unknown-Host requests must continue to land on the
  MedEvidence default vhost that proxies to `127.0.0.1:8081`; otherwise CN
  gateway calls to `http://4.242.58.89` can be redirected into Codex Gateway and
  fail with `missing_credential`.

## Current Recommended Next Step

Container loopback validation, public HTTPS routing, two upstream Codex account
pooling, and per-account image binding are complete. The next safe work is to
operate the controlled trial without changing host edge services:

1. Keep `/v1/chat/completions` as the primary compatibility target.
2. Verify OpenAI-shaped `tool_calls`, tool-result history messages, streaming chunks, and usage fields after every gateway rebuild.
3. Verify `GET /gateway/credentials/current` after every gateway rebuild so client login/settings pages can validate API keys without model calls.
4. Verify both `codex-pro-1` and `sub_openai_codex_dev` image bindings after any image-key or billing change.
5. Check `trial-check`, `report-usage`, `events`, and `audit` daily during the trial.
6. Keep the gateway container loopback-only and keep Nginx as the only public edge.
7. Before expanding beyond 10 controlled-trial users, revisit persistent multi-process rate limiting, admin operator identity capture, backup automation, scheduled retention, and image-provider health automation.
