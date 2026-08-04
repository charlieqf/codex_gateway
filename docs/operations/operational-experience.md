# Operational Experience

Last updated: 2026-08-04

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
- A restrictive archive/extraction umask also changes modes on tracked,
  non-secret bind-mounted configuration. Before recreating a service that runs
  as UID/GID `999:999`, explicitly restore release directories to `0755`,
  read-only tracked configuration to `0444`, and verify readability from the
  intended container user. Keep secret files at their stricter owner and mode.
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
- Optional client identity URLs must augment, never replace, the exact
  server-reviewed registry sources. Merge authoritative URLs first, de-duplicate
  and apply the existing bound afterward; otherwise a partial client cache can
  silently remove the bilingual identity bridge and cause a valid registered
  doctor to fail identity resolution.

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
  identity anchors. In the historical direct-source implementation, a
  three-field request also needed a startup-validated server registry keyed by
  the normalized exact identity triple. That explains the old failure mode but
  is not the product contract. Cached registry URLs must still pass the
  official-domain allowlist and the normal identity/evidence workflow.
- A reviewed Doctor Research identity registry may accelerate a verified
  identity, but it must not become an eligibility list unless the business
  owner explicitly requested pre-registration. The authoritative medical Skill
  requires discovery for the doctor named by the user and candidate selection
  for ambiguity. A `direct` source mode plus a one-doctor registry can pass a
  repeated smoke case while making the product unusable for every other
  three-field request. Production must fail startup if general identity search
  is required but its provider credential is absent; service health and
  same-case E2E are not evidence of arbitrary-doctor coverage.
- Doctor Research daily quota is an admission/resource contract, not a success
  counter. Once admitted, failed and cancelled runs still count; otherwise a
  caller could bypass the limit by forcing failures. Return the exact next UTC
  day reset and current `maximum/used/requested` values. A fixed 30-second
  retry is actively misleading for a daily window.
- A production daily-quota change must update both protected API and Worker env
  files, recreate all four Research-aware containers, and verify the loaded
  value in each process. Raising the daily total does not imply raising active
  run, Worker concurrency, global queue, unique-doctor, entitlement or medical
  quality boundaries. When the affected subject is already at the former
  ceiling, compare its persisted UTC-day admissions with the newly loaded
  limit instead of consuming another real run only to prove admission.
- Daily Research runs and rolling unique doctors are separate contracts. A
  higher daily run allowance must not silently raise the privacy/anti-bulk
  doctor count. For `research_unique_doctors_30d`, compute capacity from each
  distinct doctor's most recent admission, return the earliest expiry as the
  real `Retry-After`, and include `rolling_30_days` plus
  `maximum/used/requested`; a fixed 30-second retry causes useless create
  loops. End-user parsers may need to accept seven-digit retry values while
  still refusing to automatically retry a non-idempotent create or sleep for
  weeks.
- An explicit business decision may disable the rolling unique-doctor limit
  without changing medical quality or identity gates. Use a validated `0`
  sentinel, keep positive-value rollback behavior and reject missing, negative
  or non-integer configuration. This is an operational admission policy, not a
  medical-Skill edit.
- Do not rebuild an image merely because an already-supported env value
  changed. Startup env still requires `compose up --force-recreate` rather than
  `restart`, but the exact existing image can be reused and only consuming
  services need recreation. The detailed split and database-policy migration
  proposal are in `runtime-configuration-change-matrix.md`.
- Release validation images and build cache can push disk availability below a
  percentage floor even when more than 10 GiB remains. The `ddb1dcc` rollout
  correctly stopped maintenance at 12 GiB/9% free. Removing only the unused
  `node:24-bookworm` validation image restored 13 GiB/10%; production images,
  rollback tags, volumes and database backups were retained before resuming.
- A host script copied into a container with mode `0600` may remain root-owned
  and be unreadable by the container's unprivileged Node user. For one-shot,
  import-free diagnostic or SQLite-backup modules, prefer
  `docker exec -i ... node --input-type=module - < script`; then copy out only
  the verified backup files and remove their exact temporary paths.
- Deterministic final-output repair is appropriate only for a closed set of
  presentation defects whose transformation is lossless or monotonically
  subtractive. Duplicate-paragraph removal, unmatched-delimiter removal and
  inline-enumeration normalization must be refused when any evidence, numeric,
  identity, length, structure or safety diagnostic remains, and the complete
  validator must pass again before artifacts are published.
- Targeted Doctor Research correction calls should have their own measured
  reasoning, output and wall-clock budgets. Production attempt-4 history from
  2026-07-22 showed `low / 18,000` succeeding 13/27 times with 14 timeouts,
  while `none / 8,000-10,000` succeeded 19/19. Bound correction and peer calls
  before changing providers or medical gates, and retain cancellation/no-overlap
  verification for every retry.
- After a bounded Doctor Research correction succeeds, rerun deterministic
  safety validation before assigning the last model-call slot. If exactly one
  section remains repairable, preserve the structured diagnostic and use the
  existing section-id/original-SHA/allowed-evidence repair contract. A generic
  peer call can discard that information and leave no budget for the targeted
  repair. This is slot reallocation, not a sixth call or a relaxed gate; reject
  hash mismatches, evidence escapes and any failed complete validation.
- A VM release gate must provide both Node and Python to Python tests that
  invoke Node health scripts. The Azure host has Python but no system Node/npm;
  the operator-local Node binary does not automatically enter non-interactive
  SSH `PATH`. Run JS gates in a pinned Node container and Python gates in a
  read-only container that also has Node, rather than interpreting
  `FileNotFoundError: node` as an application regression.
- Tag rollback images before a new build replaces mutable `latest` metadata.
  If that metadata is already gone, rebuild the exact previous clean release
  and tag that image, then rebuild the activation release. Do not use
  `docker commit` on a running production container because its configured
  runtime environment may contain secrets.
- `docker cp` cannot read a file that exists only in a container tmpfs such as
  `/tmp`. For a verified SQLite backup, copy the file inside the container to
  an exact temporary path on its state volume, copy it to the host, and remove
  only that exact temporary file after hash/integrity verification.
- `docker cp` creates host backup files as root on this VM. Run the final
  read-only permission change with `sudo`, then run `sudo sha256sum --check`;
  an unprivileged checksum failure after mode `0400` is a permissions issue,
  not evidence that an already matched container/host backup hash changed.

- Treat an HTTP 200 from PubMed as transport success, not semantic success.
  Validate the ESearch payload inside the same bounded sequential retry loop;
  classify malformed JSON/shape as an external `invalid_payload`, wait for the
  old attempt to finish before retrying, and allow at most one request-scope
  Worker replay after adapter retries are exhausted.
- Publication-title frequency is not enough to derive a PubMed field query.
  Filter grammatical connectors and generic prose both when terms are derived
  and again when the query is built. The real `1.6.99` failure used
  `endovascular AND aortic AND for`; `1.6.100` produced medically meaningful
  terms and closed 40 references for the same three-field case.
- A successful general search does not imply every synthesis should publish.
  When two independent shard quality contracts fail together, retain the
  bounded fail-closed behavior and zero artifacts. Measure the next independent
  run and improve deterministic prompt/input defects; do not turn a multi-gate
  failure into repeated self-rewrites or lower identity/evidence/safety gates.
- Never interpolate an API key into a remotely quoted shell header. Shell and
  SSH quote loss can turn the header value into command arguments and expose it
  in diagnostics. Build authenticated requests inside a process that reads a
  mode-0600 file, redact all exceptions, and immediately disable/revoke the
  isolated test credential if any output path exposes it. Verify zero active
  credentials, cancel the temporary entitlement, and remove its work directory.
- Deployment validation scripts must accept both supported public-model registry
  shapes (top-level list and object-with-`models`) before asserting the exact
  eight IDs. A predeploy script should stop safely after backup/tagging when its
  own assertion is incompatible; resume with an independently reverified
  candidate rather than deleting the new rollback boundary or recreating a
  production container prematurely.
- Disk recovery is healthy only when it preserves the live volumes, current
  release, newest verified database backup, and immediate rollback image tags.
  Record before/after free space and remove only superseded build cache,
  redundant archives, and backups already replaced by independently verified
  boundaries.
- A successful same-cloud explicit-resolution edge smoke does not prove public
  Internet reachability. The CN1 `gw` vhost passed TLS, chat, SSE, Research,
  artifact and image tests from another Aliyun VM, while a Sydney client saw
  `403 Server: Beaver / Non-compliance ICP Filing` on HTTP and TLS reset on
  HTTPS before Nginx; Azure-to-CN1 HTTPS was also reset. Always test a new edge
  from at least one independent public network and correlate the attempt with
  Nginx access logs before approving DNS cutover.
- For a DNS-01 certificate that must renew independently after the old edge is
  retired, keep the narrowly scoped DNS API token in a root-owned mode-0600
  credential file on the new edge. Prove token permission with staging
  issuance, issue the production certificate, run a renewal dry-run, and test
  the deploy hook separately because Certbot skips deploy hooks during an
  ordinary dry-run. Do not delete the operator-local source token after copying
  the persistent edge credential.

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
