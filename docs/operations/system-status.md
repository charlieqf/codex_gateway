# System Status

Last updated: 2026-07-18

## Current Phase

The Azure gateway is the live public HTTPS Gateway. It originated as a
controlled trial for up to 10 trusted users, but the 2026-07-15 production
`trial-check` found 77 active users and 73 active API keys, so it no longer
fits that original 10-user boundary. A separate CN1 loopback-only GoldenCode
gateway is also running for domestic-only GLM-5.2 validation.

Completed:

- Codex SDK child-process cancellation crash hardening:
  - the live 2026-07-17 incident was traced to an unhandled
    `child.stdin` `write EPIPE` after an aborted Codex SDK turn, which caused
    the npm Gateway process to exit and Docker to restart the container;
  - `@openai/codex-sdk` is pinned to `0.144.1`, and an exact-version,
    exact-source-hash postinstall patch attaches a stdin error handler while
    preserving non-abort failures;
  - SSE disconnects now carry a structured `client_aborted` reason through the
    provider stream and do not mark an upstream account successful or failed;
  - the patch is idempotent and has a 16 MiB input cancellation regression
    test that reproduces the former unhandled-error path.

- Monitoring data-plane implementation and local no-notify watchdog fixtures:
  - Gateway active-request registry and atomic runtime snapshot;
  - read-only admin `ops-snapshot` with 5/15-minute request aggregation;
  - explicit local/upstream/unknown `rate_limited` disambiguation;
  - configurable total chat deadline;
  - host watchdog collector, standalone rule evaluator, sanitized fixtures,
    incident deduplication/resolution state, and hardened systemd templates;
  - real email/SMS delivery and external Gatus deployment remain disabled and
    are not part of this completed data-plane scope.

- TypeScript/npm workspace scaffold.
- OpenAI Codex provider feasibility validation using ChatGPT device-code authorization.
- Real `provider-codex` adapter backed by `@openai/codex-sdk`.
- Development gateway routes:
  - `GET /gateway/status`
  - `GET /gateway/credentials/current`
  - `POST /sessions`
  - `GET /sessions`
  - `POST /sessions/:id/messages` as SSE
- Temporary development bearer token via `GATEWAY_DEV_ACCESS_TOKEN`.
- Default-protected Fastify auth hook with explicit public health route.
- Request context injection for dev subject/upstream account/provider/scope.
- SSE close abort, heartbeat, and write cleanup.
- SQLite schema migration and SQLite-backed session persistence via `GATEWAY_SQLITE_PATH`.
- User-friendly API key issue/list/update/revoke/rotate MVP.
- API key user metadata management for `name` and `phone_number`, including `issue --name --phone`, `update-user`, `list-active-keys`, `reveal-key`, and `reveal-keys`.
- One-command admin provisioning through `provision-user` for trusted backends/operators to create or update a user, grant or renew a plan entitlement, and optionally issue an API key after external approval or payment.
- Recoverable API key storage for newly issued/rotated keys via encrypted `token_ciphertext`; historical hash-only keys cannot be reconstructed.
- Opaque access credential generation with stored SHA-256 hash and prefix lookup.
- SQLite-backed credential auth hook for gateway requests.
- API key self-validation route `GET /gateway/credentials/current`, which validates the current bearer credential, returns public user/key metadata, and skips normal request rate-limit consumption.
- Auth mode selection prefers credential auth when a credential store is available; dev auth is rejected under `NODE_ENV=production`.
- `/gateway/health` exposes `auth_mode`.
- Admin CLI `issue`, `list`, `list-users`, `list-active-keys`, `update-user`, `update-key`, `disable-user`, `enable-user`, `revoke`, `rotate`, `reveal-key`, `reveal-keys`, `events`, `report-usage`, `audit`, `trial-check`, and `prune-events`.
- Admin CLI read-only Desktop client event queries: `client-messages` and `client-diagnostics` across the main `gateway.db` identity store and `client-events.db`, including user/name lookup, credential prefix lookup, unified-key env lookup, prompt preview/full-text switch, and diagnostic metadata filters.
- Admin CLI read-only MedEvidence tool audit export: `client-medevidence-tool-audit` reads `client_diagnostic_events.metadata_json`, joins matching `client_message_events`, supports recent-window filters, `entrypoint=gateway`, minimum question length, and JSON/JSONL/CSV output for mixed MedEvidence routing guard samples.
- One-command Desktop E2E opaque key issuance through
  `scripts/issue-desktop-e2e-opaque-key.ps1`. This uses the live Billing Admin
  subject API, lets Gateway request the hidden MedEvidence v2 key, grants an
  active plan entitlement, validates `cgu_live_*` resolve plus
  `/gateway/credentials/current`, and writes the full key only to a local
  handoff JSON.
- Browser-based read-only client message inspection for operators:
  `GET /gateway/admin/client-messages` serves a static live-refresh UI and
  `GET /gateway/admin/client-messages.json` returns recent Desktop messages
  across all users. The data route is protected by the independent
  `GATEWAY_ADMIN_MESSAGES_TOKEN` bearer token by default and does not accept
  normal user API keys. `GATEWAY_ADMIN_MESSAGES_AUTH=open` exists for temporary
  controlled debugging and makes the page/data route unauthenticated.
- Client diagnostic metadata ingestion stores the full metadata JSON object without field whitelisting, while rejecting obvious credential/secret material. The diagnostic metadata limit is 192KB UTF-8 and the diagnostic body limit is 256KB so MedEvidence tool audit fields can include both Desktop original text and the extracted MedEvidence question.
- Per-credential in-process rate limiting for requests per minute, requests per day, and concurrency.
- A system-wide floor of 300,000 tokens per minute for every explicit non-null
  plan, entitlement snapshot, and API key token policy. Missing or `null`
  values remain unlimited. SQLite migration 21 raises persisted lower values,
  while core/store normalization prevents future plan or key writes below the
  floor.
- Rate-limit response contract v1 for Gateway and OpenAI-compatible errors:
  - all `429 rate_limited` JSON/SSE errors include `request_id`,
    `rate_limit_contract_version=1`, `limit_kind`, `rate_limit_origin`, and
    `retry_after_seconds`;
  - Gateway-local request and token limits expose structured maximum/used/requested details;
  - confirmed provider rate limits use `rate_limit_origin=upstream` and do not
    masquerade as user quota exhaustion;
  - non-streaming responses return standard `Retry-After` plus sanitized
    classification headers;
  - client-event ingest rejections emit sampled structured diagnostics instead
    of one extra warning per rejected upload.
- SQLite request event writer for gateway observations, including Phase 1 token usage fields when provider usage is available.
- Admin CLI usage aggregation with token totals and dry-run-capable manual request event pruning.
- Production runtime startup validation for credential auth, SQLite state, `CODEX_HOME`, and dev-token rejection.
- Docker Compose gateway skeleton with loopback-only port mapping, non-root runtime image, and local resource limits.
- Docker maintenance-window runbook for shared VM installation and rollback.
- Docker Engine and Docker Compose plugin installed on the Azure VM during an approved maintenance window.
- Public internal trial runbook and Nginx dedicated-hostname example.
- Long-running loopback gateway container started on the shared Azure VM for the controlled internal trial.
- Public HTTPS routing for `gw.instmarket.com.au` through existing host Nginx to `127.0.0.1:18787`.
- Azure VM non-invasive smoke tests against `127.0.0.1:18787`.
- CN1 loopback-only GoldenCode Gateway deployment:
  - App root: `/opt/codex-gateway-cn1`.
  - Compose project: `codex_gateway_cn1`.
  - Container: `codex_gateway_cn1-gateway-1`.
  - Listener: `127.0.0.1:18787->8787`.
  - Public routing: none.
  - Runtime profile: only `goldencode`, with enabled GLM-5.2 pool members
    `goldencode-qianfan`, `goldencode-tencent`, and `goldencode-aliyun`.
  - OpenRouter and image generation are intentionally absent from the CN1
    profile.
  - Health returned `state=ready`, `service=goldencode`,
    `auth_mode=credential`, and `phase=cn1-loopback` on 2026-07-03.
  - Sticky/load-balancing smoke on 2026-07-03 issued a temporary key, verified
    `/v1/models` exposes only `goldencode`, sent two requests to each HRW-picked
    member session, and recorded request events for all three upstream member
    ids with `upstream_model=glm-5.2` and `reasoning_effort=medium`.
- OpenAI-compatible beta routes:
  - `GET /v1/models`
  - `GET /v1/models/:id`
  - `POST /v1/chat/completions`
- OpenAI Chat Completions response shape for non-streaming and streaming SSE, including `chat.completion.chunk` frames and `data: [DONE]`.
- Chat Completions compatibility for assistant `tool_calls`, `{ role: "tool", tool_call_id, content }` history, `finish_reason: "tool_calls"`, and OpenAI-shaped `usage` when upstream token usage is available.
- Chat Completions model allowlist validation for the public `medcode` model id.
- Chat Completions tool-call turns suppress upstream text content after a `tool_call` has been emitted, so container sandbox failure text is not forwarded as assistant content for the client-side tool path.
- Phase 2 strict client-defined tools runtime has local gateway support: when `/v1/chat/completions` receives non-empty `tools[]`, the gateway asks for a strict JSON envelope, validates tool names against the client registry, validates arguments with JSON Schema, performs one repair attempt, and only then returns OpenAI-shaped `tool_calls`.
- Phase 2 strict client-defined tools runtime has been deployed to the public controlled-trial gateway and validated with a temporary `medevidence(question: string)` tool call plus `role: "tool"` follow-up.
- Phase 2 strict client-defined tools now honors OpenAI-style `tool_choice` for `"none"`, `"required"`, and named function choices, suppresses upstream native tool calls when `tool_choice` is `"none"`, validates complex nested JSON Schemas, and records strict validation failures through request observations and sanitized gateway logs.
- Phase 2 strict client-defined tools now falls back to a normal assistant
  message only when `tool_choice=auto`, the upstream output is non-empty plain
  text, and both the initial parse and repair fail with non-JSON output.
  Malformed tool-call attempts, schema validation failures, `tool_choice=required`,
  and named function choices still fail with `tool_call_validation_failed`.
- Strict client-defined tools accept JSON Schemas tagged as draft-07, draft 2019-09, or draft 2020-12, including client-generated `$schema: "https://json-schema.org/draft/2020-12/schema"` tool parameters.
- Local P4 upstream Codex account pool implementation:
  - Optional `GATEWAY_UPSTREAM_ACCOUNTS_JSON` config for multiple independent
    `codexHome` login states, with single-account `CODEX_HOME` fallback.
  - Router selection for new sessions and stateless OpenAI-compatible chat,
    sticky existing sessions by `sessions.upstream_account_id`, HRW soft
    affinity, config `enabled=false`, DB runtime state hydration, per-account
    max concurrency and cooldown exclusion.
  - Provider outcomes update per-account `state`, `last_used_at`, and
    `cooldown_until`; stateless chat retries at most once before client-visible
    business output; existing sessions never fail over.
  - `request_events.upstream_account_id` records the selected runtime account.
- Live P4 two-account upstream Codex pool configuration:
  - The controlled-trial gateway now sets
    `GATEWAY_UPSTREAM_ACCOUNTS_JSON=/var/lib/codex-gateway/upstream-accounts.json`.
  - The pool contains the existing `sub_openai_codex_dev` login state and a
    second `codex-pro-1` login state, each with `maxConcurrent: 1`.
  - Both `CODEX_HOME` directories passed real Codex SDK probes from inside the
    running gateway container, and post-restart smoke events recorded successful
    requests on both upstream account ids.
- Local P4c upstream-account image binding implementation:
  - `upstream_accounts.image_api_key_env` is migrated and bootstrap-upserted as
    non-secret config metadata while preserving account runtime state.
  - Account pool config accepts `imageApiKeyEnv`, `imageBaseUrlEnv`, and
    `imageTimeoutMs`; `imageApiKeyEnv` values that look like real `sk-...`
    keys are rejected.
  - Image generation can route through per-account OpenAI image providers with
    independent image-side inflight, cooldown, key-invalid state, retry before
    response body write, and legacy single-key fallback only when no image
    binding is declared.
- Live P4c per-account image binding configuration:
  - `sub_openai_codex_dev` declares
    `imageApiKeyEnv=MEDCODE_IMAGE_OPENAI_API_KEY`.
  - `codex-pro-1` declares
    `imageApiKeyEnv=MEDCODE_IMAGE_OPENAI_API_KEY_B`.
  - Both image env names are logged and stored as non-secret metadata only; API
    key values remain in the deployment env file and are not printed.
- Live image billing fallback now supports an ordered extra-provider retry
  chain from a mounted secret file:
  - Existing legacy OpenAI fallback remains first:
    `image-billing-fallback`.
  - Extra fallback ids are derived from the secret file provider labels, such
    as `image-billing-fallback-openai-1`,
    `image-billing-fallback-xai-1`, and
    `image-billing-fallback-gemini-1`.
  - The mounted secret file path is configured through
    `MEDCODE_IMAGE_BILLING_FALLBACK_KEYS_FILE`; the file contains only
    operator-managed secrets and must not be committed or printed.
  - Deployment smoke on 2026-07-03 selected primary image account
    `codex-pro-1`, retried through the fallback chain, succeeded on
    `image-billing-fallback-xai-1`, and recorded request id
    `req-3ce3e1da-50ec-4c9f-bf8a-171afb7e8c58` with `status=ok`.
- Azure live model-surface recovery on 2026-07-03:
  - A recreate from stale `config/gateway.container.env` temporarily exposed
    only `max`, `expert`, `pro`, and `standard`, causing
    `Model 'goldencode' does not exist` for live clients.
  - The env was restored by merging the GoldenCode registry and
    qianfan/tencent/aliyun provider env lines from the 2026-07-02 GoldenCode
    release env, while preserving newer image fallback and admin-token
    settings.
  - Post-recovery `/v1/models` exposed all 8 public models:
    `max`, `specialist`, `consultant`, `expert`, `advisor`, `pro`,
    `standard`, and `goldencode`.
  - `model=goldencode` smoke returned 200 and request event
    `req-0bfbcf27-c65f-4782-8f80-38fc72cb4a0c` recorded
    `upstream_account_id=goldencode-tencent`, `upstream_runtime=tencent`,
    `upstream_model=glm-5.2`, `reasoning_effort=medium`, and `status=ok`.
  - Any future Azure live recreate must run the model-config preflight and
    post-deploy `/v1/models` plus `goldencode` smoke documented in
    `docs/operations/internal-trial-runbook.md`.
- Two real controlled-trial API keys issued and managed by the SQLite credential store, currently capped at 10 requests per minute, 200 requests per day, and 4 concurrent requests each.

Not completed:

- Native SDK-level dynamic tool registration, MCP bridge support, or pause/resume of the same upstream turn while waiting for external tool results.
- `/v1/responses`.
- OpenAI-compatible SSE framing for the native `/sessions/:id/messages` endpoint.
- Persistent/distributed rate limiting for multiple gateway processes.
- Token budget enforcement; current implementation records token usage but does not block by token quota.
- Code-level enforcement that every issued API key has user name and phone; the CLI supports these fields and runbooks require them, but missing fields are currently a workflow violation rather than a hard error.
- Scope enforcement beyond conservative Codex adapter defaults.
- Scheduled retention automation and materialized usage reports.
- Systemd ownership/monitoring for the long-running container.
- Additional image-provider health automation remains pending; current image
  validation is manual smoke plus request-event inspection.

## Verified Runtime

Local and Azure VM checks have passed:

```bash
npm install
npm ci
npm run build
npm test
```

Most recent Azure VM validation:

- 2026-07-18 commit `ccccf1c` deployed the completed OpenAI SSE termination
  contract, pre-commit tool-call buffering, credential public-model allowlists,
  and the disabled-by-default Doctor Research Phase 0 foundation to the live
  Azure Gateway from clean release checkout
  `/home/qian/codex-gateway-release-ccccf1c-20260718T031500Z`. Local and VM
  `npm ci`, `npm run build`, all 435 tests in 28 files, the 6 Python operations
  tests, and Python syntax checks passed. The protected env was copied
  byte-for-byte with mode `600`; preflight confirmed the exact 8-model registry
  and all four Azure GoldenCode provider key names without printing values.
  `RESEARCH_API_ENABLED` remained disabled, no Research database was created,
  and no Worker or scheduler was enabled. Online SQLite snapshots for both live
  databases passed integrity checks and are stored under
  `/var/lib/codex-gateway/backups/pre-ccccf1c-20260718T031142Z`. The deployed
  image is
  `sha256:d0f1b54a82bcf48e47448a7e2876f434ef001587b8cc99c0629043dd11b6a3ac`;
  the previous image remains tagged
  `codex_gateway_test-gateway:rollback-f64cfa1-20260718T031500Z`. The first
  switch was automatically rolled back because an anonymous disabled-route
  probe expected `404` but the global auth hook correctly returned `401`; the
  gate was corrected to verify the protected container configuration directly,
  and the second switch completed healthy. Gateway schema migration `23` and
  database quick check passed. The container has zero restarts, remains
  loopback-only at `127.0.0.1:18787->8787`, and Nginx/Docker stayed active.
  Public OpenAI-compatible and strict-tools smokes passed. A focused production
  credential smoke verified `allowed_public_models=["max"]`, allowed `max`,
  rejected a `standard` chat before provider execution with
  `403 model_not_allowed_for_credential`, and preserved missing/wrong-key
  `401` boundaries. The final audit found no active keys across the eight most
  recent deployment-smoke users and no recent uncaught, unhandled, fatal, or
  `EPIPE` log lines. CN1 was explicitly excluded and remains unchanged.
- 2026-07-18 commit `f64cfa1` deployed incomplete OpenAI-compatible SSE
  detection and empty-response classification to the live Azure Gateway from
  clean release checkout
  `/home/qian/codex-gateway-release-f64cfa1-20260718T000109Z`. A separate
  clean local worktree and the VM release both passed `npm ci`,
  `npm run build`, and all 346 tests in 23 files. The protected env preflight
  confirmed the exact 8-model registry and all four Azure GoldenCode provider
  key names without printing secret values. A stopped-container, consistent
  database archive is stored at
  `/home/qian/codex-gateway-backups/f64cfa1/gateway-databases-pre-f64cfa1-20260718T000109Z.tgz`.
  The deployed image is
  `sha256:1ac387f0286cd281b2ad39c5be2c9388c58df8f2a41ae0b465ed574a02cab78d`;
  the previous image remains tagged
  `codex_gateway_test-gateway:pre-f64cfa1` for rollback. The first preflight
  attempt rejected shell-quoted registry JSON before any runtime mutation; the
  parser was corrected and the failed release containing the protected env was
  removed. During the stopped backup, a non-privileged `chmod` exited after the
  root-owned archive was already complete; the mode was corrected with `sudo`
  and the already-built release was activated. The live container is healthy
  with zero restarts and no OOM, and remains loopback-only at
  `127.0.0.1:18787->8787`. Public OpenAI-compatible, strict tools, `pro`
  native-tools, and GoldenCode smokes passed and cleaned up every temporary key
  and user. `/v1/models` returned exactly `max`, `specialist`, `consultant`,
  `expert`, `advisor`, `pro`, `standard`, and `goldencode`. Pro request
  `req-221b3c24-ba2c-4866-a183-a46e52c08cee` recorded
  `openrouter / z-ai/glm-5-turbo / tool_calls / finish_reason_and_done /
  status=ok`. GoldenCode request
  `req-2324f914-f6bb-41fc-8a75-a3f94b794b4e` recorded
  `goldencode-openrouter / openrouter / z-ai/glm-5.2 / stop /
  finish_reason_and_done / status=ok`. Image inspection confirmed the new SSE
  error markers, and post-deploy logs contained no `EPIPE`, unhandled, fatal,
  incomplete-stream, or empty-response entries. `trial-check` infrastructure
  checks passed but its overall result remains false because the existing
  active-user count exceeds the old controlled-trial threshold and historical
  key/contact/entitlement findings remain; no real user, key, or entitlement
  was changed. CN1 was explicitly excluded and remains unchanged.
- 2026-07-17 commit `843d6aa` deployed the Codex SDK stdin `EPIPE` crash fix
  to the live Azure Gateway from clean release checkout
  `/home/qian/codex-gateway-release-843d6aa-20260717T042146Z`. Local and VM
  `npm run build` passed, and all 335 tests in 23 files passed. The protected
  env preflight confirmed the exact 8-model registry and all four Azure
  GoldenCode provider key names without printing secret values. A
  stopped-container, consistent database archive is stored at
  `/home/qian/codex-gateway-backups/843d6aa/gateway-databases-pre-843d6aa-20260717T042413Z.tgz`.
  The deployed image is
  `sha256:2d23e375abf6cfa4a790cdb65e32526af9f16ebad42249891f56d3c847036937`;
  the previous image remains tagged
  `codex_gateway_test-gateway:pre-843d6aa` for rollback. An initial activation
  reached HTTP readiness while Docker health was still `starting`; the strict
  deployment guard automatically restored the previous image. After verifying
  the rollback, activation was repeated with a combined HTTP-ready and Docker
  health wait and completed successfully. The live container is healthy with
  zero restarts and no OOM, and remains loopback-only at
  `127.0.0.1:18787->8787`. The runtime image reports Codex SDK `0.144.1` with
  the stdin patch present, and a 16 MiB image-level cancellation regression
  survived without an unhandled error. Public OpenAI-compatible and strict
  tools smokes passed and cleaned up their temporary keys/users.
  `/v1/models` returned exactly `max`, `specialist`, `consultant`, `expert`,
  `advisor`, `pro`, `standard`, and `goldencode`. GoldenCode native-tools
  request `req-8ed013b2-4b73-4df9-8df9-f38cbe26d920` recorded
  `goldencode-aliyun / aliyun / glm-5.2 / medium / status=ok`. Post-deploy
  logs contained no new `EPIPE` or unhandled-error exit. CN1 was explicitly
  excluded from this deployment and remains unchanged.
- 2026-07-16 commit `14b4bb2` deployed the system-wide 300,000 token/minute
  floor to the live Azure Gateway from clean release checkout
  `/home/qian/codex-gateway-release-14b4bb2-20260716T113736Z`. Local and VM
  `npm run build` passed, and all 329 tests in 22 files passed. The protected
  env preflight confirmed all 8 public models and all four Azure GoldenCode
  provider key names without printing secret values. A stopped-container,
  consistent pre-migration database archive is stored at
  `/home/qian/codex-gateway-backups/14b4bb2/gateway-databases-pre-14b4bb2-20260716T114043Z.tgz`.
  Migration 21 completed with zero remaining explicit plan, entitlement, or
  API key values below 300,000; `plan_paid_monthly_v1` and the affected
  `subj_6etViPr6cpYeOuf_kvZF6oJd` entitlement now expose
  `tokensPerMinute=300000`. The container runs image
  `sha256:bc7f18361dcb434c94b6c4b663aab1a458668ed06aa2151c31fe882fd0600cd3`,
  is healthy with zero restarts, and remains loopback-only at
  `127.0.0.1:18787->8787`. Public OpenAI-compatible smoke passed and cleaned
  up its temporary key. `/v1/models` returned exactly `max`, `specialist`,
  `consultant`, `expert`, `advisor`, `pro`, `standard`, and `goldencode`.
  GoldenCode native-tools request
  `req-51fb2225-d065-4333-8b0b-543485ed8e14` recorded
  `goldencode-openrouter / openrouter / z-ai/glm-5.2 / medium / status=ok`;
  its temporary key was revoked. CN1 was explicitly excluded from this
  deployment and remains unchanged.
- 2026-07-15 commit `db12b11` deployed rate-limit response contract v1 to the
  live Azure Gateway from clean release checkout
  `/home/qian/codex-gateway-release-db12b11-20260715T101500Z`. VM
  `npm run build` and all 326 tests in 22 files passed. The protected env
  preflight confirmed all 8 public models and the four GoldenCode provider
  keys without printing secret values. A consistent pre-deploy database
  archive was stored at
  `/home/qian/codex-gateway-backups/db12b11/gateway-databases-pre-db12b11-20260715T103101Z.tgz`.
  The container started at `2026-07-15T10:31:27Z` on image
  `sha256:ab61480826e2be9f9743b324f31cd1384ce2f376f5811b2dcf5fc4c2996060a6`,
  stayed healthy with zero restarts, and remained loopback-only at
  `127.0.0.1:18787->8787`. Public OpenAI-compatible smoke passed; the exact
  8-model surface passed; GoldenCode request
  `req-2d29bb6b-880c-489d-ac30-add8dfb934f1` recorded
  `goldencode-qianfan / qianfan / glm-5.2 / medium`; and local 429 request
  `req-1aedad43-533c-492e-850a-1ba4b9733f85` returned
  `request_minute / gateway / contract version 1` with matching body and
  headers. All temporary smoke keys were revoked and their users disabled.
  The controlled-trial check now reports existing operational debt: 77 active
  users exceed the historical limit of 10, 14 active keys lack both daily and
  concurrency caps, 17 active users lack contact metadata, and several legacy
  entitlement states need review. No real user was disabled during deployment.
- 2026-06-30 the live controlled-trial gateway registry was updated in
  `config/gateway.container.env` to publish four public models:
  `max -> gpt-5.5`, `expert -> z-ai/glm-5.2` with
  `reasoning.effort=high`, `pro -> z-ai/glm-5-turbo` with
  `reasoning.effort=none`, and
  `standard -> deepseek/deepseek-v4-pro` with `reasoning.effort=none`.
  The pre-change env-file backup is
  `config/gateway.container.env.pre-expert-20260630T025233Z`. The gateway
  container was recreated healthy and remained loopback-only at
  `127.0.0.1:18787->8787`. Public OpenAI-compatible smoke passed. Native tools
  smoke confirmed `/v1/models` returns `expert,max,pro,standard`; `expert`,
  `pro`, and `standard` each returned a `write_file` tool call. One initial
  `pro` native-tools run hit the 300s client timeout and was recorded as
  `client_aborted`; a focused rerun of `pro` with a 600s smoke timeout passed.
  Temporary smoke credentials had no active keys remaining after cleanup.
- 2026-05-14 the second upstream ChatGPT/Codex login was upgraded to Pro,
  verified with a real Codex SDK probe from inside the running gateway
  container using `/var/lib/codex-gateway/codex-home-plus`, and renamed in the
  live pool from `codex-plus-1` to `codex-pro-1`. The live config backup is
  `/var/lib/codex-gateway/upstream-accounts.json.pre-rename-codex-plus-1-to-codex-pro-1-20260514T101803Z`;
  the live SQLite backup is
  `/var/lib/codex-gateway/gateway.db.pre-rename-codex-plus-1-to-codex-pro-1-20260514T101803Z`.
  No existing sessions referenced `codex-plus-1`, so no session rows needed
  migration. The Gateway container was recreated healthy, public
  `/gateway/health` returned `ready`, and a temporary-key route smoke succeeded
  on `codex-pro-1` with request id
  `req-4b426595-807a-4bb4-8a65-75172c6d8aba`; temporary credentials were
  revoked/disabled.
- 2026-05-12 the live controlled-trial gateway enabled P4c image binding for
  both upstream accounts. The second image API key is configured as
  `MEDCODE_IMAGE_OPENAI_API_KEY_B` and bound to `codex-plus-1`; after the
  OpenAI project billing limit was corrected, a real
  `/gateway/images/generations` smoke succeeded on `codex-plus-1` with
  `request_events.upstream_account_id=codex-plus-1`. A follow-up image smoke on
  `sub_openai_codex_dev` also succeeded. The gateway was recreated healthy and
  still publishes only `127.0.0.1:18787->8787`.
- 2026-05-12 public smoke after enabling both image bindings passed against
  `https://gw.instmarket.com.au`: OpenAI-compatible health/auth/model/chat,
  tool-result history, streaming SSE, and strict client-defined tools
  required/named/none/follow-up flows. Temporary smoke API keys/users were
  revoked and disabled by the scripts.
- 2026-05-12 the live controlled-trial gateway was switched from the single
  `CODEX_HOME` fallback to a real two-account upstream Codex pool. The existing
  account id `sub_openai_codex_dev` was preserved for session compatibility,
  `codex-plus-1` was added with
  `/var/lib/codex-gateway/codex-home-plus`, both accounts passed SDK probes
  inside the gateway container, and `upstream_accounts` shows both accounts
  active. The gateway container was recreated healthy and still publishes only
  `127.0.0.1:18787->8787`.
- 2026-05-12 public smoke after enabling the two-account pool passed against
  `https://gw.instmarket.com.au`: OpenAI-compatible health/auth/model/chat,
  tool-result history, streaming SSE, and strict client-defined tools
  required/named/none/follow-up flows. Temporary smoke API keys/users were
  revoked and disabled by the scripts. Recent `request_events` show successful
  post-restart traffic on both `sub_openai_codex_dev` and `codex-plus-1`.
- 2026-05-12 commit `4e61f98` was pushed and deployed to the live controlled
  trial gateway using a clean release checkout
  `/home/qian/codex-gateway-release-4e61f98-20260511T230214Z`. VM `npm ci`,
  `npm run build`, and `npm test` passed with 8 test files and 177 tests. The
  live SQLite files were backed up inside the gateway state volume with suffix
  `20260511T230252Z`, the Docker image was rebuilt, and the gateway container
  was recreated healthy as `codex_gateway_test-gateway-1`, still publishing
  only `127.0.0.1:18787->8787`.
- 2026-05-12 public smoke after deployment passed against
  `https://gw.instmarket.com.au`: health, unauthenticated `/v1/models`
  rejection, wrong-model rejection, model listing, non-stream chat with usage,
  tool-result history with usage, streaming SSE, strict client-defined tools
  required/named/none/follow-up flows, and request-id headers. Temporary smoke
  API keys/users were revoked and disabled by the scripts.
- 2026-05-11 Local validation for P4 upstream account pool plus P4c
  account-bound image generation passed `npm run build` and `npm test` with 8
  test files and 177 tests.
- 2026-05-11 Azure VM read-only baseline found the shared VM healthy with
  Nginx and Docker active, public `80/443` listeners unchanged, and the live
  Gateway still listening on `127.0.0.1:18787`. Public OpenAI-compatible smoke
  against `https://gw.instmarket.com.au` passed health,
  unauthenticated `/v1/models` rejection, wrong-model rejection, model listing,
  non-stream chat with usage, tool-result history with usage, streaming SSE,
  and request-id headers. The temporary smoke API key/user were revoked and
  disabled by the smoke script. This smoke validates the currently deployed
  live gateway; the P4 multi-account pool code has not yet been deployed to
  that container.
- 2026-05-10 Gateway-brokered `cgu_live_*` unified client key resolver was
  deployed to the live controlled-trial gateway. Local and VM `npm run build`
  and `npm test` passed with 7 test files and 131 tests. The Docker image was
  rebuilt, the live SQLite volume was backed up, the Gateway container was
  recreated, and public health remained ready at
  `https://gw.instmarket.com.au/gateway/health`.
- The deployed resolver was validated with a temporary `cgu_live_*`: public
  resolve returned runtime Gateway and MedEvidence credentials, the returned
  Gateway credential validated through `/gateway/credentials/current`, auth
  boundary checks rejected `cgu_live_*` on Gateway business routes and `cgw.*`
  on resolve, and revoking the backing `cgw.*` made resolve return
  `revoked_credential`. Temporary smoke keys and user were cleaned up.
- `GATEWAY_PUBLIC_BASE_URL` in the gateway container environment was corrected
  to `https://gw.instmarket.com.au`, so resolve returns
  `codex_gateway.endpoint_base_url: https://gw.instmarket.com.au/v1` and
  `codex_gateway.credential_validation_url:
  https://gw.instmarket.com.au/gateway/credentials/current`.
- Public OpenAI-compatible smoke passed after the rebuild: health,
  unauthenticated `/v1/models` rejection, wrong-model `404 model_not_found`,
  model listing, non-stream chat with usage, tool-result history, streaming SSE,
  and cleanup.
- 2026-05-07 admin CLI rebuild deployed to the live Azure VM Gateway container.
  The container is healthy as `codex_gateway_test-gateway-1`, public
  `https://gw.instmarket.com.au/gateway/health` succeeds, and
  `codex-gateway-admin --help` inside the container exposes
  `--client-events-db`, `client-messages`, and `client-diagnostics`.
- The deployed read-only Desktop message query was validated against production
  `gateway.db` and `client-events.db` by querying a real user display name.
- 2026-05-07 strict client-defined tools auto plain-text fallback was deployed
  to the live Azure VM Gateway container. Local and VM Gateway typecheck passed,
  local `npm run build` and `npm test` passed with 117 tests, VM `npm run build`
  passed, and the rebuilt container is healthy on loopback and public health.
- Current deployed source includes API key contact metadata/reveal support,
  Phase 1 token usage recording, `gpt-5.5`, and the request id / usage
  aggregation fix that prevents reused Fastify request ids from pinning new
  usage to old `started_at` timestamps. The live gateway reasoning effort was
  lowered from `high` to `medium` on 2026-05-12 after diagnosing long Desktop
  Research agent turns with very large contexts/outputs.
- Local Windows validation passed `npm run build` and `npm test` with 6 test files and 65 tests.
- Azure VM checkout `/home/qian/codex-gateway-test` was updated from the current working tree; VM `npm run build` and `npm test` passed with 6 test files and 65 tests.
- Docker image rebuild initially exposed VM-side `package-lock.json` platform drift caused by `npm install`; lockfile metadata was corrected with the same npm generation used by the container, `npm ci --dry-run` passed, and the gateway image rebuilt successfully.
- Docker Compose gateway was recreated from the current image and is healthy as `codex_gateway_test-gateway-1`, publishing only `127.0.0.1:18787->8787`.
- The `codex_gateway_test` compose project and `codex_gateway_test_gateway_state`
  volume names are historical trial names but currently identify the live
  Gateway deployment. Do not rename them outside an explicit maintenance task.
- Current production SQLite paths are container paths:
  `/var/lib/codex-gateway/gateway.db` and
  `/var/lib/codex-gateway/client-events.db`, backed by Docker volume
  `codex_gateway_test_gateway_state`. The VM host does not need
  `/var/lib/codex-gateway`, and `$HOME/codex-gateway-state/gateway.db` is not
  the live production database.
- DNS `gw.instmarket.com.au` resolves to `4.242.58.89`.
- Existing host Nginx owns public `80` and `443`; the gateway container does not bind public ports.
- Nginx has a dedicated `gw.instmarket.com.au` server that proxies HTTPS traffic to `http://127.0.0.1:18787`.
- Let's Encrypt certificate for `gw.instmarket.com.au` was issued with certbot and expires on 2026-07-21; certbot installed its automatic renewal task.
- Public `https://gw.instmarket.com.au/gateway/health` returns gateway health with `auth_mode: credential`, SQLite session store, and observation enabled.
- HTTP `http://gw.instmarket.com.au/gateway/health` redirects to HTTPS.
- Public `GET /gateway/credentials/current` smoke passed with a temporary API key, including success metadata, missing credential `401 missing_credential`, wrong credential `401 invalid_credential`, `X-Request-Id` headers, and cleanup by revoking the temporary key and disabling the temporary smoke user.
- Public Ajv compatibility smoke passed: `POST /v1/chat/completions` accepted a strict client-defined `tools[]` schema containing `$schema: "https://json-schema.org/draft/2020-12/schema"` and returned an OpenAI-shaped `tool_calls` response. The temporary smoke key was revoked and the smoke user was disabled.
- Public OpenAI-compatible smoke against `https://gw.instmarket.com.au/v1` passed health, unauthenticated `/v1/models` rejection, wrong-model `404 model_not_found`, model listing, non-stream chat with usage, tool-result history, streaming SSE, and `X-Request-Id` response headers; the temporary smoke key was revoked afterward.
- Phase 2 strict client-defined tools public smoke passed against `https://gw.instmarket.com.au/v1`: a temporary API key produced a `medevidence` tool call from the client-declared schema with `tool_choice: "required"`, produced a named `search_evidence` call with function `tool_choice`, returned a normal message with `tool_choice: "none"`, then used a `role: "tool"` follow-up to return `strict-tools-result-ok`. The temporary smoke key was revoked and the temporary smoke user was disabled.
- API key management and token usage smoke passed against the deployed public gateway: temporary key issue, active-key listing, full-key reveal, `GET /gateway/credentials/current`, chat completion usage, request-level `events`, daily `report-usage`, sanitized `audit`, and cleanup all succeeded.
- After the shared VM vhost correction, IP-based HTTP access to `http://4.242.58.89/` again reaches MedEvidence instead of the Codex Gateway vhost, while `https://gw.instmarket.com.au/gateway/health` continues to reach Codex Gateway.
- `trial-check --max-active-users 10` is the current controlled-trial preflight threshold; it remains a guardrail against accidental broad key issuance, not a runtime user limit.
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
- Provider token usage mapping from upstream completed turns.
- Provider error stream handling now stops after turn-level or item-level provider errors and sanitizes provider-specific auth text.
- SQLite store migration/session persistence.
- SQLite bootstrap upserts no longer reactivate disabled users or overwrite upstream account runtime state.
- Access credential generation, hash verification, expiration, and revocation.
- SQLite user and API key persistence, API key update/revocation/reveal, user contact metadata update, user disable/enable, and admin audit event persistence.
- In-memory gateway rate limiter for rpm/day/concurrency policies.
- SQLite request event persistence with token usage fields, usage aggregation with token totals, manual pruning, admin CLI event listing, and read-only controlled-trial checks.
- Gateway dev auth hook, credential auth hook, production runtime validation, rate-limit hook, request validation, subject isolation, SSE routes, OpenAI Chat Completions routes, OpenAI-shaped tool-call/usage wrapping, and SQLite-backed session persistence.
- Gateway API key self-validation route coverage, including invalid key handling and rate-limit bypass for validation-only calls.
- Strict client-defined tool schema compatibility coverage for draft 2020-12 and draft-07 `$schema` declarations.
- Strict client-defined tools fallback coverage for `tool_choice=auto` plain
  text, plus non-fallback coverage for malformed tool-call output and
  `tool_choice=required` / named function choices.
- Admin CLI Desktop client message/diagnostic query coverage for unified-key env parsing without full-key leakage, preview/full-text behavior, cross-database user/credential joins, and diagnostic metadata lookup.
- Admin CLI MedEvidence tool audit export coverage for metadata audit fields, Desktop message backfill, and JSONL/CSV output.

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
- `upstream_accounts`
- `access_credentials`
- `sessions`
- `request_events`
- `admin_audit_events`

Session persistence, API key authentication, API key issue/update/revoke/rotate/reveal, user contact metadata, user-level disable/enable, single-process API key rate limiting, request event writing with token usage fields, admin action audit events, dynamic usage reports with token totals, read-only controlled-trial checks, dry-run-capable manual request event pruning, and strict client-defined tools validation are wired into the gateway. Public HTTPS routing for `gw.instmarket.com.au` is active through existing Nginx. Existing SQLite databases migrate `subscriptions` / `subscription_id` to `upstream_accounts` / `upstream_account_id`; public compatibility aliases remain for `/gateway/status`, session JSON, and `GATEWAY_PUBLIC_SUBSCRIPTION_ID`. Token budget enforcement, scheduled retention jobs, materialized usage reports, admin operator identity capture, native SDK-level dynamic tool registration, `/v1/responses`, and multi-process shared rate limiting are still pending.

## Ops Skill

A local Codex skill named `codex-gateway-ops` has been created for this workstation. It is stored outside the repository under the local Codex skills directory because it contains operator-local access details. The public repository only records sanitized access patterns and safety rules.
