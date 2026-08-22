# System Status

Last updated: 2026-08-22

## Current Phase

R760 is the only supported Gateway runtime, control plane and usage authority.
The supported client origin is
`https://goldencode.instmarket.com.au:1443`.

The former Azure Gateway is logically offline as of the 2026-08-20 owner
decision. Its VM, DNS, containers, databases or static files may still be
physically present or running, but they are not:

- a supported client endpoint;
- a compatibility or retry target;
- a control-state mirror;
- a usage source that must be merged into R760;
- a release-success or rollback condition.

Do not run routine R760-to-Azure control mirror or Azure-to-R760 usage merge
workflows. Do not direct a client back to the old endpoint. Existing VM assets
remain preserved only for audit, unrelated-service ownership and separately
authorized data recovery; this decision is not permission to delete or stop
the shared VM.

A separate CN1 loopback-only GoldenCode gateway may remain physically running
for domestic validation, but it is not a second public authority or fallback.
The installed CN1 `gw` vhost remains dark.

This section supersedes every older compatibility, mirror, merge or shutdown
gate statement retained later in this file. Those statements are historical
evidence only and must not be used as current operating instructions.

Current operational state:

- The 2026-08-22 Desktop beta.40 live integration found that unified Phone
  Auth resolve returned the database-stored Gateway credential prefix while
  returning an API key whose public form begins with `cgw.`. Desktop correctly
  rejected that inconsistent pair as `invalid_gateway_response`. The code fix
  keeps the database and existing credentials unchanged, exposes the public
  prefix as `cgw.<stored-prefix>` from client-facing status/current/resolve
  responses, and normalizes that representation before internal credential
  updates. Main commit `5f01efeec34baad26eb5e3e54693bf72c0dd97f9`
  passed 801 tests (plus two configured skips),
  typecheck and build. A minimal networkless overlay rebuilt from the deployed
  `f7e69ea` base passed 206 focused tests and is live as Gateway image
  `sha256:60f3e70aa12ae1c648a6cfbb73f262234bc44dde60d2e61e28f31d99a2173baf`.
  The pre-change backup is
  `/data/codex-gateway-r760/backups/phone-auth-ab-window-20260822T004050Z`;
  rollback image tag
  `codex_gateway_r760-gateway:rollback-prefix-contract-20260822T004000Z`
  resolves to the preceding image. A first overlay build was rejected by the
  post-deploy semantic smoke because its filtered source patch had applied no
  files; it never opened Phone Auth and was replaced by artifact v2. The live
  resolver and `credentials/current` now both return the same public prefix,
  and the runtime key begins with that prefix.
- The MedEvidence R760 dual-track Phone Auth Gateway and Desktop beta.40 live
  contract are frozen and accepted. The immutable contract is the complete
  `docs/contracts/medevidence-r760-dual-track-phone-auth-v1` tree at
  `dc4e86828da32ae0ce8119302b04a68f5bde5569`; Desktop acceptance commit is
  `65eadd000a310e64897e9700def9b8f4e0941be9`. The separate freeze attestation is
  `docs/coordination/medevidence-desktop-beta40-phone-auth-r760-live-contract-freeze-2026-08-22.zh-CN.md`.
  The deployed
  additive code commit is
  `f7e69eabbc5c1fed484d63f2547af158fc70238e`; R760 `current` points to that
  immutable release, `previous` points to
  `c0d26ec28eb4794cea14750bd0a68e5a7b57b981`. The base image was
  `sha256:2c7b587c1005ea77e5f89647c793b3e5617d49564681f10f371d4f463cfb8891`;
  the active Gateway image is the prefix-contract overlay recorded above.
  The release retains the production `c0d26ec` client-message dashboard. The
  canary/snapshot evidence scripts are committed at `3aa506b`. This live
  release boundary supersedes older release/image paragraphs retained below
  as historical evidence.
- The authenticated client-message dashboard remains available at
  `/gateway/admin/client-messages`. Its `c0d26ec` deployment added custom time
  windows, complete message text, exact `subject_id + client_message_id`
  correlation, per-message outcomes and duration, provider/estimated Token
  usage, per-user aggregates, filtering, pagination and sorting. The original
  48-hour production verification returned all 63 selected-user messages and
  326 correlated request events without recording message bodies or complete
  credentials in this document. Its pre-switch backup
  `/data/codex-gateway-r760/backups/pre-c0d26ec-20260821T004616Z` and rollback
  image `codex_gateway_r760-gateway:rollback-1a49682-20260821T004616Z` remain
  historical recovery evidence; the newer `f7e69ea` rollback boundary below
  is authoritative for the currently deployed Gateway.
- The verified rollback boundary is
  `/data/codex-gateway-r760/backups/pre-f7e69ea-20260821T052003Z`. Its original
  `gateway.db`, `client-events.db` and retained post-canary `gateway.db` all
  pass their recorded SHA-256 checks. The live Gateway database reports
  `quick_check=ok`, zero foreign-key errors and schema version/count `25/25`;
  existing migration 25 SQL was not changed. The four persistent Phone Auth
  secret files are in the existing `gateway_state` volume with mode `0600` and
  are not exposed by health, configuration output or logs.
- The first controlled Desktop integration window was activated at
  `2026-08-21T22:19:18Z` (`2026-08-22 08:19:18 AEST`) with
  `GATEWAY_PHONE_AUTH_MODE=transition`,
  `GATEWAY_DESKTOP_VERSION_GATE=auth_only` and minimum Desktop
  `2.0.0-beta.40`. It is limited to two synthetic A/B identities plus one
  unregistered negative fixture. The transient systemd timer
  `codex-gateway-phone-auth-window-20260821T220809Z.timer` is scheduled for
  `2026-08-22T00:19:18Z` (`10:19:18 AEST`) and invokes the protected rollback
  script to disable both Phone identities, revoke their Phone Sessions, restore
  `disabled / disabled` and recreate only Gateway. The verified pre-window
  backup is
  `/data/codex-gateway-r760/backups/phone-auth-ab-window-20260821T220809Z`.
  After the deadline, verify live health and the timer service result rather
  than assuming either state from this historical record. No real-user phone
  identity, Nginx, DNS, Research or provider configuration is part of this
  window.
- After the first timer completed successfully, a replacement controlled
  window was activated at `2026-08-22T00:49:54Z`
  (`2026-08-22 10:49:54 AEST`) on the verified prefix hotfix. It uses the same
  two synthetic A/B identities and unregistered U fixture, with
  `transition / auth_only / 2.0.0-beta.40`. Timer
  `codex-gateway-phone-auth-window-20260822T004716Z.timer` completed at
  `2026-08-22T02:49:54Z` (`12:49:54 AEST`) with `Result=success` and
  `ExecMainStatus=0`; the timer is inactive. Its verified
  post-hotfix pre-window backup is
  `/data/codex-gateway-r760/backups/phone-auth-ab-window-20260822T004716Z`.
  A/B login, bootstrap, resolve, `credentials/current`, `account/current`,
  legacy no-version-header resolve and logout all passed; both public prefix
  consistency checks passed. U returned strict `403 phone_not_registered`.
  The final Desktop A/B/U matrix passed, including four real chats with one
  transport attempt and one Gateway request ID each. The post-deadline audit
  found `disabled / disabled / null`, both controlled identities disabled,
  all eight related Phone Sessions revoked and zero active Refresh Tokens.
  Gateway and all three Research containers are healthy with zero restarts;
  the prefix hotfix image remains deployed. A read-only comparison with the
  pre-window backup proved exact Subject, credential, unified-key, entitlement
  and Plan equality. Four finalized reservations and no open reservation
  account exactly for prompt 141,772, completion 48, total 141,820, cached
  88,384 and estimated 0 Tokens. No auth/resolve/retry call was charged.
- A final live audit at `2026-08-21T06:29:01Z` found public and loopback
  `/gateway/health` returning Phone Auth `disabled / disabled / null`. Gateway,
  Research Worker, Research maintenance and the isolated Research LLM Gateway
  were healthy with restart count zero; their three Research container IDs
  were unchanged by the rollout. The six production project volumes are
  unchanged. Only Gateway publishes `127.0.0.1:18787`; the host's pre-existing
  `127.0.0.1:8081` and PostgreSQL `127.0.0.1:5432` listeners are unrelated and
  no additional listener was created. Final configuration is
  `GATEWAY_PHONE_AUTH_MODE=disabled`,
  `GATEWAY_DESKTOP_VERSION_GATE=disabled`, with login RPM defaults `5/20/10`
  for phone/IP/device. No Azure, CN1, Nginx, DNS, provider-pool, Research or
  vessel configuration changed.
- Later on 2026-08-21, the public `goldencode` pool was changed independently
  of the Phone Auth rollout to one enabled member,
  `goldencode-tencent / tencent / glm-5.3`, with default
  `reasoning_effort=high`. The live Tencent credential advertised both
  `glm-5.2` and `glm-5.3` as online; direct provider probes and public Gateway
  non-stream, SSE, required/named/none/follow-up tool-call, usage and request-
  event attribution checks passed after activation. The protected config
  rollback boundary is
  `/data/codex-gateway-r760/backups/pre-glm-5.3-20260821T114108Z`.
  TokenSwitch remains removed after its enterprise balance was exhausted.
  Research remains on its independent Tencent-only `glm-5.2` Gateway and did
  not inherit this change. Older public GLM-5.2/TokenSwitch pool statements
  retained below are historical evidence.
- The disabled baseline and the later `transition + auth_only` canary both
  proved beta.38 compatibility without a Desktop version header: resolver,
  credentials current, models, chat, strict tools, public Responses tool
  follow-up, Research create/status/cancel and the complete Vision Asset
  create/upload/complete/read/delete lifecycle passed. Image generation reached
  its existing upstream provider and returned an upstream-origin 429 because
  the provider credits were exhausted; it did not return 426 and did not enter
  a Gateway version gate. Changing the provider pool was outside this rollout.
- The beta.40 canary proved missing, invalid and beta.39 headers return the
  exact 426 contract on only the five Phone Session routes. Registered-phone
  login, bootstrap, account current, Refresh rotation, replay rejection,
  logout and identity disable passed. `phone_login_disabled` and
  `account_disabled` were observed as distinct 403 errors. Logout, replay,
  Phone identity disable and temporary Subject disable did not revoke or
  change the existing legacy key. Isolated live probes also returned 429 from
  each SHA-256 phone, IP and device risk bucket at the configured threshold.
- Pre/post snapshots prove every pre-existing row in `subjects` (758),
  `access_credentials` (766), `unified_client_keys` (196), `plans` (11),
  `entitlements` (443) and `request_events` (139953) remained present and byte
  equivalent. Pre-existing token windows, entitlement token windows and token
  reservations had no missing row or numeric regression. A strict Phone
  lifecycle additionally preserved the canary Subject, Plan, entitlement,
  capabilities and its exact pre-existing usage totals. All four controlled
  temporary Subjects now have no phone, active credential, unified key,
  entitlement, Phone identity or Phone Session; transient files were removed
  and only required audit tombstones remain. No real-user preregistration or
  mutation was performed. Gateway logs from the rollout contain no JWT,
  Refresh Token, complete key or phone number; two broad 11-digit matches were
  verified as `responseTime` values.

- Desktop update distribution is authoritative in Cloudflare R2 bucket
  `goldencode-updates` through `https://updates.instmarket.com.au`; the public
  feed URLs did not change. GitHub Releases hold immutable version archives.
  Any retained VM static copy has no current release or rollback role and must
  not be used to publish or validate a release. MedEvidence
  `v2.0.0-beta.26` passed R2 manifest, HEAD, Range and full-hash validation;
  all four feed pointers passed. The MedEvidence trailing-slash changelog alias
  was added, while the GoldenCode alias remained a documented static-site gap
  in that validation window. The canonical release procedure is
  `C:\work\code\medevidence-opencode-stable\docs\desktop-release-r2.md`.
- R760 is now the control and usage authority for real-user key issuance, user
  enable/disable, credential revoke/update, plan/entitlement management and
  usage reports. Real-user issuance must use
  `scripts/issue-real-user-cgu-key.py --client-version <strict-semver>` and
  validate only R760. The script is inherently R760-only; the retained
  `--r760-only` option is a deprecated no-op.
  `scripts/manage-r760-gateway-control.py` currently performs an automatic
  compatibility mirror and is therefore not an approved current mutation path
  until it gains and validates an R760-only mode; other control writes require
  a separately reviewed R760-only procedure.
- Authoritative usage reports query R760 directly. Do not run
  `scripts/sync-azure-r760-gateway-usage.py` as a reporting prerequisite and do
  not add physically retained legacy events to R760 totals.
- The 2026-08-05/06 mirror and usage-merge records remain preserved in
  `docs/operations/r760-control-plane-authority.md` as historical cutover
  evidence only. They do not authorize another mirror, merge or dual-endpoint
  validation.
- The post-switch R760 daily report completed successfully: public health 200,
  TLS valid, Gateway healthy, restart count zero and no collector errors. It
  also passed an authenticated Billing Admin Plan query. The daily report
  currently has one monitoring-only warning because
  `/var/lib/codex-gateway/ops-runtime.json` has not been configured on R760;
  control and usage queries are otherwise operational.
- R760 now runs release
  `573a7a9d6d3fd123c01a60bcd11a4db7a73028b2`; `previous` is
  `9ba088508d1df2de30441adb4814409b1d757bc8`. The public Gateway image is
  `sha256:3ce6a2124ea7d79b2c7d5ef298501b62eafe2cdb114b94594a5724a141701591`
  and the Research Worker image is
  `sha256:6132ce8c4614cff2f31f72ae48f101cc9fe5f5f720b8f9d6b4e3a0fe2a911ed9`.
  Both are networkless overlays of their preceding verified images. Gateway,
  Worker, the unchanged isolated Research LLM Gateway, unchanged maintenance
  service and Mihomo are healthy with zero restarts. The consistent pre-switch
  database/config rollback boundary is
  `/data/codex-gateway-r760/backups/pre-573a7a9-20260806T101350Z`.
- R760's only public text model remains `goldencode`, advertised as 200,000
  context and 128,000 maximum output tokens. It is now an HRW-sticky pool with
  exactly two enabled `glm-5.2` members:
  `goldencode-tencent / tencent` and
  `goldencode-tokenswitch / tokenswitch`; `requireAllMembers=false` preserves
  bounded retry/failover when one member is unavailable. Production strict
  required/named/none/follow-up tool calls passed. Directed live requests then
  selected each member independently and persisted `status=ok`, HTTP 200,
  `upstream_model=glm-5.2` and one tool call for both runtimes. Research remains
  on its separate Tencent-only internal Gateway and does not inherit the public
  pool or Mihomo route.
- The TokenSwitch credential is stored on R760 only as the protected
  root-managed source file mounted read-only into Gateway (`999:999/0400`), and
  the operator workstation copy is DPAPI-protected and excluded from Git. The
  credential was originally supplied in a chat message, so it must still be
  treated as exposed and rotated through the normal rollback-safe secret update
  after this deployment; its value is not recorded in source, logs or docs.
- Doctor Research Worker `doctor-research-skill.1.6.105` is ready with workflow
  `v82`, prompt `v31`, validation `v43` and artifact policy `v3`. The deployed
  runtime contract accepts an empty personal `research_directions` list,
  renders an explicit evidence-gap disclosure and rejects unsupported personal
  direction attribution while continuing a related-field review. All 167
  focused Gateway/Research tests, 9 Python contract tests, build, typecheck and
  the full 657-pass/2-skip Vitest suite passed before deployment. Post-deploy
  SQLite integrity/FK checks passed; there were no active Research runs or
  unfinished public/internal reservations, the Worker heartbeat was fresh, and
  all temporary smoke credentials were disabled and revoked.
- Run `drr_54b3658520f84736b1b065529675d7d7` exists only on the Azure
  compatibility stack, not R760. Azure execution `1.6.104` verified one
  official identity source, found no doctor-attributed publication and retained
  40 related-field PubMed papers, then hard-failed before synthesis with
  `verified_research_direction_required` because the official source did not
  contain an exact citable personal research-direction statement. This was not
  a provider outage and did not mean that the user had to supply a homepage.
  The client-facing `UnknownError`/temporary-unavailable message and turn code
  `T:R26DR1A9` were a generic mapping that hid the terminal Research reason; no
  matching client-diagnostic upload was present. Existing failed runs are
  immutable, so the repaired behavior applies to a new run on R760.
- Desktop `2.0.0-beta.26` still must not be described as a complete long-task
  protocol fix. It has active summary/UI state and local chunked artifact
  transaction foundations (`chunked-file-write-v1` and
  `artifact-completion-v1`, default off), but not the complete negotiated
  `context-compaction-v1` or exact `artifact-write-v1` protocol. Stable
  generation/id, Gateway special-error handling, one-shot retry, anti-loop
  rules, protocol guarantees for todo/tool state and immutable artifact ID/hash,
  and packaged Desktop-to-R760 protocol E2E remain incomplete. The Gateway does
  not currently accept the experimental capability headers, so beta.26 does not
  enable that recovery path even though core cancellation/restart/chunk/hash/
  atomic-commit tests and a real R760 long task passed.

- Azure MedEvidence US was retired reversibly at `2026-08-05T06:19:04Z` after
  confirming `requests=0`, `jobs=0`, no last-30-day events and no non-MedEvidence
  PostgreSQL consumers. Public/internal web plus both workers are inactive,
  disabled and protected by `RefuseManualStart`; PostgreSQL 16 `main` is down
  and its units are masked. `8081/8083/5432` have no listeners. This database
  is neither the Codex Gateway SQLite database nor the CN Aliyun RDS domain;
  its data remains preserved for rollback and archive, not as a US recovery
  target.
- TokenBridge/NewAPI was retired reversibly at `2026-08-05T06:22:05Z`. Its
  NewAPI, MySQL and Redis containers are exited with restart policy `no`, and
  `13000/13306/16379` have no listeners. The retained Nginx retired vhost
  returns HTTP 410 under forced public SNI; the operator workstation's ordinary
  DNS lookup currently returns no A record. Original containers, bind data,
  certificate and active-vhost config remain available only for rollback.
- The same-host rollback directory is
  `/home/qian/azure-retirement-backups/20260805T061540Z`. It contains protected
  config, PostgreSQL logical/cold backups and TokenBridge logical/cold backups;
  gzip/tar and SHA-256 verification passed. It is not an off-host disaster
  recovery copy, so neither retired stack may be deleted until an off-host
  copy and restore drill pass.

- Azure production runs commit
  `4697fba0b74d2ea8aa0ace0699a6117397ad9b01` from
  `/home/qian/codex-gateway-release-4697fba-20260803T083513Z`.
  Doctor Research execution is `1.6.104`, prompt `v30`, validation `v42` and
  workflow `v81`. Its Gateway, isolated Research LLM Gateway, Worker and
  maintenance containers are healthy with zero restarts; only the public
  Gateway publishes `127.0.0.1:18787`.
- The migration-target routes were narrowed to Tencent when the Aliyun and
  Qianfan subscriptions were cancelled. Azure public `goldencode`, Azure
  Research staging/production, CN1 loopback and R760 Research remain
  `goldencode-tencent / tencent / glm-5.2`. R760 public `goldencode` is the one
  deliberate exception: it now balances Tencent with TokenSwitch as recorded
  above. Azure production Research keeps Qianfan and Aliyun only as disabled
  entries and gives Tencent `maxConcurrent=3`. However, Azure's legacy
  eight-model public registry still
  has enabled `specialist / qianfan / glm-5.2`,
  `expert / openrouter / z-ai/glm-5.2` and
  `advisor / aliyun / glm-5.2` routes. They had no requests in the latest seven
  days, but their enabled state means Azure as a whole does not yet enforce the
  Tencent-only LLM policy. No live registry change was made during the audit.
- A read-only Azure audit at `2026-08-04T07:41Z` found that the planned
  one-model public surface is not yet safe to cut over. During the prior 30 days,
  the seven non-`goldencode` IDs handled 7,406 requests and 507,102,322 observed
  or estimated tokens. The most recent 24 hours still contained 129 `max` and
  122 `pro` requests from five active consumers; nine active consumers used an
  old model during the most recent seven days. These clients must move to
  `model=goldencode`, followed by a zero-use observation period, before the
  other IDs are removed. See
  `docs/operations/goldencode-cutover-audit-2026-08-04.zh-CN.md`.
- The same 30-day audit observed 930 public and 68 Research Tencent requests,
  totalling 56,555,349 observed or estimated tokens. Reconstructed aggregate
  overlap peaked at 3. The public Tencent pool has no explicit
  `maxConcurrent`, while Research has 3; this is not an aggregate capacity of
  6, and the shared Tencent account's contractual concurrency, RPM, TPM, quota,
  balance and validity remain unverified. Account-side evidence plus a
  simultaneous R760 public/Research load test are cutover gates.
- During the local audit, a Tencent provider credential in the protected
  deployment config was inadvertently displayed in operator terminal output.
  It was not added to Git or documentation and is not repeated here, but it
  must be treated as exposed and rotated before cutover across every environment
  that references it. Credential isolation between the public and Research
  pools remains optional; rotation is required because of this incident, not
  because the architecture requires separate keys.
- The Azure public Gateway was recreated at `2026-08-04T02:56:39Z` after a
  restricted backup and Compose validation. Its first ten post-recreate
  `goldencode` events, including smoke request
  `req-fefde9bc-527e-46ab-b392-5c927d76de2f`, all succeeded through Tencent.
  Azure Research production has recorded 32 Tencent-only GLM-5.2 successes
  since its current container start. Azure staging smoke
  `req-58b14ff4-20e2-4cdf-b25d-9d1408cfb384` and CN1 smoke
  `req-cb134460-c360-4dd5-93c4-e5cbc94d26ed` also succeeded through Tencent.
- The staging route change exposed an operator rollback-mode error: a restored
  non-secret registry temporarily inherited mode `0600`, so its container
  could not read the file and restarted. The registry was restored to
  `qian:qian/0644`, staging returned healthy, and the Tencent-only change was
  then reapplied successfully. The final recreated staging Gateway and its
  unchanged Worker/maintenance containers are all healthy with restart count
  zero. No secret-file permission was broadened.
- Before the current `573a7a9` release, the formal R760 project had `current` at
  `/opt/codex-gateway-r760/releases/9ba088508d1df2de30441adb4814409b1d757bc8`
  and `previous` at `43e118eb00083ee44164329568a62941169ee78c`.
  Only the public Gateway was recreated for the long-output P0 shadow release;
  the three Research container IDs stayed unchanged. All four business
  containers and the separate Mihomo infrastructure container are healthy with
  zero restarts; only Gateway publishes `127.0.0.1:18787`. SQLite integrity and
  foreign keys pass, maintenance backup
  `drb_d206cec62645458db6f1e2a750dbc1e6` succeeded, Worker
  `doctor-research-skill.1.6.104` is ready, and `/data` is about 1% used.
- Three R760 real Research runs succeeded once each and published exactly four
  artifacts. Two complete client E2Es passed download size/SHA-256 validation
  in 179 and 183 seconds. The middle server run also succeeded with four
  artifacts, but an initial smoke key with `rpm=4` received HTTP 429 during
  download; raising only that temporary key to `rpm=120` closed the client
  path. All 15 business LLM calls across the three runs used Tencent GLM-5.2.
  All E2E keys are revoked, entitlements cancelled, users disabled, and no R760
  temporary directory, nonterminal run or unfinished reservation remains.
- R760 now runs a dedicated Mihomo `v1.19.23` infrastructure container on the
  private `codex_gateway_r760_default` network. Its CN1-derived configuration
  contains 32 embedded nodes and no online proxy-provider dependency. It has a
  read-only root filesystem, no Linux capabilities, no host-published port and
  restart self-healing; the CN1 source listener shape was not copied. Only the
  public Gateway has `HTTP_PROXY`/`HTTPS_PROXY`, while exact `NO_PROXY` entries
  keep Tencent and the domestic/internal endpoints direct. A fault-injection
  smoke succeeded through Tencent while Mihomo was stopped.
- The R760 low-cost image path now succeeds through Mihomo for the public
  `medcode-image-default -> gpt-image-1.5` route and for a direct xAI
  `grok-imagine-image-quality` fallback-provider smoke. There is still no
  `gpt-image-2`. Gemini remains a cutover blocker: its key is accepted far
  enough to return Google `FAILED_PRECONDITION`, but all 21 currently alive
  copied nodes report that their exit location is unsupported. The temporary
  selector controller was loopback-only, then removed, and the pre-probe config
  and cache hashes were restored before production restart. Cache and GeoIP are
  mutable runtime state; ongoing integrity checks cover the static binary and
  derived config. Commit `43e118eb00083ee44164329568a62941169ee78c` now records
  the actual image provider and upstream model before every primary,
  account-retry and billing-fallback attempt. Build and all 40 test files / 638
  tests passed before deployment. A real R760 smoke then recorded text request
  `req-ffe8ee38-9f61-417d-9b6a-b816b000393e` as
  `tencent / goldencode / glm-5.2` and image request
  `req-72502774-9ad4-4b49-a797-ef50c43c289e` as
  `openai-api / medcode-image-default / gpt-image-1.5`; both completed with
  `status=ok`. The temporary credential, entitlement and user were cleaned.
  Gemini reachability remains the only open low-cost three-model image gate.
- The preceding `9ba0885` R760 Gateway image was
  `sha256:3e783ea7d6d6b811d10adaed708321465faf5ac7232e00053aa55a3b3022a9bf`.
  Because Docker Hub was unstable and the host had no usable base-image cache,
  it was built networklessly as an immutable overlay of the previously verified
  `43e118e` Gateway image plus the locally tested `apps/gateway/dist` and
  `packages/core/dist` from `9ba0885`. This is an auditable deployment artifact,
  not a replacement for a later canonical full Dockerfile rebuild.
- R760 commit `9ba0885` adds completion assessment, UTF-8 tool-argument byte
  diagnostics, dedicated output-length/tool-call truncation contracts,
  validation subtypes and lossless per-attempt duration/usage aggregation. The
  production recovery-mode variable remains unset, so the effective mode is the
  code default `shadow`; `error` has not been enabled for production credentials
  and active chunk remains 0%. The pre-change online backups of `gateway.db`,
  `client-events.db` and `research.db` passed integrity, foreign-key and SHA-256
  checks under
  `/data/codex-gateway-r760/backups/pre-long-output-p0-20260806T033029Z`.
  Public post-deploy checks passed the exact `goldencode` model surface,
  non-stream chat, SSE, required/named/none/follow-up tool calls, Tencent
  `glm-5.2` attribution and the new attempt/argument-byte audit fields. Gateway
  restart count is zero, all temporary credentials/users were cleaned and no
  smoke reservation remains unfinished. The deterministic local long-task
  fixture passed, but a full Desktop/R760 long-task agent-loop E2E has not yet
  run; this shadow release therefore does not close the original user-visible
  incident.
- During the final 2026-08-06 post-deploy status query, an operator-side shell
  quoting error caused the running Gateway's environment to be printed in the
  operator tool output. No secret value was committed to Git or copied into
  documentation, and values must not be repeated. Treat every non-empty secret
  shown there as exposed, including provider API keys and Gateway internal,
  admin, billing and encryption credentials. Rotation has not been attempted
  automatically because the encryption credential and cross-service tokens
  require a backed-up, coordinated migration to avoid invalidating stored
  ciphertext or causing an outage. The owners must inventory all affected
  consumers, rotate/re-encrypt through an approved rollback-safe procedure,
  validate both R760 and compatibility dependencies, and record closure.
- R760 origin `:1443`, loopback/SNI health and the existing MedEvidence
  `8081/8082` checks pass.
- A DNS-only `A` record now resolves `goldencode.instmarket.com.au` directly to
  `117.186.49.26`. Public NAT maps external `:1443` to R760 Nginx `:443`, which
  proxies to Gateway on `127.0.0.1:18787`. Public TLS and health pass from the
  Sydney operator workstation, CN1 and Azure.
- R760 `GATEWAY_PUBLIC_BASE_URL` was changed from
  `https://gw.instmarket.com.au` to
  `https://goldencode.instmarket.com.au:1443` under rollback boundary
  `/data/codex-gateway-r760/backups/pre-public-base-url-20260804T103816Z`.
  The full base + Research + R760 override Compose configuration validated, and
  only `gateway` was force-recreated. All three Research container IDs stayed
  unchanged; all four services remain healthy with zero restarts. A real
  `cgu_live` resolve now advertises
  `https://goldencode.instmarket.com.au:1443/v1`, `/v1/models` returns only
  `goldencode`, credential validation and a Tencent GLM-5.2 chat return 200,
  the authenticated Research list returns 200, and a post-change low-quality
  `medcode-image-default` request returned a valid JPEG.
- The approved CN1 edge maintenance was executed on 2026-08-04 without changing
  public DNS. A dedicated non-default `gw.instmarket.com.au` vhost pins
  `117.186.49.26:1443`, verifies TLS/SNI as
  `goldencode.instmarket.com.au`, uses HTTP/1.1 keepalive and TLS session reuse,
  disables request/response buffering and caching, and keeps the existing
  5 MiB request limit and 3600-second long-request timeout. The independently
  issued ECDSA certificate expires on 2026-11-02. Cloudflare DNS-01 staging,
  production issuance and `certbot renew --dry-run` succeeded; the persistent
  credential is root-owned mode `0600`, the Certbot timer is active, and the
  deploy hook separately passed `nginx -t` and a reload. The pre-change Nginx
  backup is
  `/opt/codex-gateway-cn1/backups/pre-gw-edge-20260804T182835+1000`.
- An Aliyun-to-Aliyun explicit-resolution dark smoke proved HTTP redirect,
  certificate validation, `phase=r760-loopback`, unauthenticated `401`, opaque
  credential self-check, the exact `goldencode` model surface, non-stream chat,
  SSE, client disconnect/recovery, Research list/result, four-artifact manifest,
  authenticated artifact size/SHA-256, and low-quality
  `medcode-image-default` generation. Representative requests were
  `req-82bd95c3-2d9c-4925-8a51-d8359884e365` and
  `req-c7309ed6-6597-40ca-9617-59c630f44a26`.
- The same forced CN1 address from the Sydney operator workstation returned
  `403 Server: Beaver` with page title `Non-compliance ICP Filing` on HTTP;
  HTTPS for `gw`, `medevidence` and the existing `nip.io` name was reset before
  Nginx and produced no Nginx access entry. Azure-to-CN1 HTTPS was also reset.
  The CN1 route therefore remains installed but dark and is not the selected
  migration path. Azure remains the live `gw` address at `4.242.58.89`; R760
  clients instead migrate explicitly to the separate DNS-only `goldencode`
  endpoint.
- Restricted route backups are under
  `/home/qian/codex-gateway-backups/tencent-only-20260804T0255Z` on Azure and
  `/opt/codex-gateway-cn1/backups/tencent-only-20260804T0305Z` on CN1.
  R760 Mihomo rollback files are under
  `/data/codex-gateway-r760/backups/pre-mihomo-20260804T034553Z`; the later
  state-permission boundary is
  `/data/codex-gateway-r760/backups/pre-mihomo-state-umask-20260804T043007Z`; see
  `docs/operations/r760-mihomo-image-egress.md`. The Gateway-only attribution
  deployment has an additional consistent SQLite boundary at
  `/data/codex-gateway-r760/backups/pre-image-attribution-20260804T064424Z`;
  the prior release and rollback-tagged Gateway image remain installed.

Superseded 2026-08-03 status snapshot (retained for audit):

- Azure runtime commit `29790d2784913bfe14c71e8f72d51ae48748e5e7`,
  execution `1.6.100`, prompt `v30`, validation `v42`, workflow `v77`, from
  `/home/qian/codex-gateway-release-29790d2-20260730T062157Z`.
- Gateway, Research LLM Gateway, Worker and maintenance are healthy with zero
  restarts. Only the Gateway publishes `127.0.0.1:18787`; public and loopback
  health are `ready / controlled-trial`. CN1, Nginx, public ports and
  MedEvidence were not changed.
- The Worker calls the isolated, non-published Research LLM Gateway. Its
  production pool currently enables only direct Aliyun GLM-5.2 with
  `maxConcurrent=3`; Qianfan and Tencent remain disabled entries. It does not
  call or share capacity with the public `goldencode` pool.
- Worker-only SerpAPI uses the explicit Google engine for general doctor
  identity discovery. The identity registry is a cache, not a whitelist.
  Daily admission is 50 per subject per UTC day and distinct doctors are
  unlimited; all identity, evidence, quality and artifact gates remain active.
- Local release gates passed build, 40 files/625 Vitest tests, 36 Python tests,
  npm audit with zero vulnerabilities, `git diff --check`, and medical-Skill
  zero diff.
- Runtime `1.6.99` completed five consecutive strict public engineering-case
  E2Es in 177.257–257.217 seconds, each with exactly 3 MD + 1 five-line TXT and
  matching manifest, sizes, SHA-256 and complete Worker/Gateway/provider
  timelines. Both non-stream disconnect routes also recorded provider
  cancellation requested/observed `1/1`.
- Runtime `1.6.100` fixed publication-title connector words entering PubMed
  topic queries. The supplied minimal three-field case then closed 40 field
  references; one run failed safely on two model-quality contracts with zero
  artifacts, and `drr_acadf775c00c42c1924ebf3180a519b7` succeeded in 173.301
  seconds with strict four-file verification.
- Rollback boundary
  `/home/qian/codex-gateway-backups/29790d2/20260730T062157Z` and all four
  `rollback-cb703da-20260730T062157Z` images are verified. Post-deploy backup
  `drb_ad694a206a6746d8b1f95a1a07741b72` passed a networkless read-only
  verification with 320 artifacts.
- Azure root-disk availability was restored from about 17 GiB to 24–26 GiB
  while preserving live volumes, current releases and verified rollback
  boundaries. The temporary E2E key was revoked, user disabled, entitlement
  cancelled, and all temporary files removed.
- Access remains controlled-trial until the medical team approves
  representative cases and manually accepts the four generated files.

The superseded snapshot also recorded the following migration preparation:

- The destination is the Dell PowerEdge R760 and the runtime boundary is four
  containers: the public Gateway, an isolated Research LLM Gateway, one Worker
  and one maintenance service. Only the public Gateway publishes the R760
  loopback listener.
- The destination public text-model surface is exactly `goldencode`. The seven
  other Azure public model ids are not migrated. `goldencode` uses direct
  Qianfan, Tencent and Aliyun GLM-5.2 with no OpenRouter.
- Image generation remains a separate public capability at
  `/gateway/images/generations` using the stable client model id
  `medcode-image-default`. The R760 target must exclude `gpt-image-2` and use
  the existing lower-cost chain: `gpt-image-1.5`,
  `grok-imagine-image-quality`, and `gemini-3.1-flash-image`. The currently
  staged formal R760 env predates this decision and still needs its image
  secrets/model mapping added and revalidated.
- Only LLM upstreams are constrained to mainland-direct providers. Doctor
  Research may continue using its controlled SerpAPI, PubMed, Crossref, ORCID
  and official-site adapters, and the separate image providers are governed by
  their own cost/security policy.
- The Research Worker never uses the public pool. Its dedicated internal pool
  remains Aliyun-only for the migration; a separate three-provider Research
  pool is deferred to a later phase.
- R760 Docker/containerd data roots are on `/data`; the clean release and four
  verified offline images are staged. A production-like isolated rehearsal
  reached 4/4 healthy, exercised all three public GLM-5.2 members, restored
  state across a stack restart and completed one strict four-artifact Research
  E2E after one earlier model-contract failure.
- Formal private env/secret files and the initial consistent Azure snapshot are
  present with restricted modes. Six correctly labelled formal volumes were
  restored and their four SQLite databases, 328 artifacts and backup boundary
  passed hash/integrity checks. The formal containers remain stopped and
  `127.0.0.1:18787` remains free.
- R760's management Netplan now persists the USB NIC by MAC with static address,
  gateway and DNS; unplugged 10 Gb NICs no longer block boot. SSH, DNS,
  wait-online, existing MedEvidence health and public `:1443` SNI were
  revalidated. A future cold-boot drill still requires iDRAC/local-console
  fallback. The NVIDIA driver is currently unavailable after the kernel change,
  but the planned Gateway/Research and API-backed image workloads do not depend
  on the local GPU.
- The R760 `goldencode.instmarket.com.au` DNS-01 certificate and dedicated SNI
  vhost are installed; certificate validation through public `:1443` succeeds.
  The origin returns the expected `502` while the formal Gateway is stopped.
  This validation used an explicit address override; ordinary public DNS for
  the `goldencode` origin is not yet present.
- CN1 has ample current proxy headroom, Nginx/certbot are active, and its existing
  vhosts/config test pass. Thirty cold CN1-to-R760 HTTPS samples measured TCP
  p50/p95 `10.09/10.89 ms`, cumulative TLS p50/p95 `26.22/26.89 ms`, and total
  immediate-response p50/p95 `43.81/45.54 ms`. Upstream keepalive should reduce
  steady-state overhead primarily to the roughly 10 ms inter-site round trip.
- CN1's dedicated `gw` certificate/vhost, SSE and long-request settings,
  upstream keepalive, certificate renewal dry-run and dark smoke are complete.
  Public Internet reachability/ICP handling, DNS cutover, monitoring, the R760
  origin allowlist and a post-cutover rollback drill remain open. CN1 would
  become the public single point after Azure is retired, so the observed public
  ingress block is a hard cutover gate rather than a cosmetic warning.
- The business owner confirmed on 2026-08-04 that the public and Research pools
  may reuse the same Aliyun provider key. New credentials or a rotation are not
  a cutover gate. The two Gateways, service bearer tokens, secret-file paths,
  SQLite state, concurrency and usage attribution remain separate; shared
  upstream quota/rate-limit/billing and correlated key failure are accepted and
  must be included in capacity validation.
- The original 2026-08-01/02 window passed without cutover. Azure remains the
  temporary rollback boundary until the next approved deploy/sync/cutover
  window passes every gate; it is not the permanent edge and is to be retired
  after the observation window.
- See
  `docs/implementation/domestic-gateway-doctor-research-migration-plan-2026-07-30.zh-CN.md`.

Historical rollout record (retained for audit):

- Doctor Research engineering remediation `1.6.83` plus the unlimited-doctor
  admission policy is deployed to the Azure
  controlled-trial environment:
  - runtime commit `ddb1dcca5a92d2d032383f9cb01ae5cf65b22be4` from clean release
    `/home/qian/codex-gateway-release-ddb1dcc-20260729T063301Z`;
  - local and Azure gates passed build, 40 files/598 Vitest tests, 36 Python
    tests, npm audit with zero vulnerabilities and medical-Skill zero diff;
  - execution `1.6.83`, prompt `v29`, validation `v42`, workflow `v72`; the
    deployed medical bundle SHA-256 remains
    `6d5e839f942f87f1064a6d855c37b54302300aacd700360aa5fef8907a2fa351`;
  - cancellation, full Worker/Gateway/provider timelines, 15-fixture/23-test
    deterministic replay, shared review/prose rules, hash-bound section repair,
    evidence projection and bounded body-envelope normalization are active;
  - the same engineering-allowlisted case passed five consecutive strict public
    HTTPS Python E2Es in 166.765–378.099 seconds. Each returned exactly 3 MD +
    1 TXT and passed filename, manifest, size and SHA-256 verification;
  - real-user run `drr_32fe62a652dc4a9f8d9b561b68a478e5` exposed that a
    client-supplied one-URL list replaced the complete server-reviewed identity
    source set. `1.6.79` now preserves registered sources and adds only valid
    client URLs;
  - a new request containing exactly top-level `name`, `hospital`, and
    `department` succeeded as `drr_07b07f128ce746edb777fbc70dbe3340`
    in 265.857 server seconds with 3 MD + 1 five-line TXT and complete
    manifest/size/SHA-256 verification;
  - request `req-4aaf46f6-6104-48f6-8c8d-b85f6c7322ed` was a genuine daily
    quota rejection after two admitted identity failures exhausted the former
    allowance; `1.6.80` raised the controlled allowance from 2 to 5 and now
    returns the actual next UTC reset plus usage details instead of a fixed
    30-second retry;
  - the operator-approved production policy now permits 50 admitted runs per
    subject per UTC day. All four containers load `50`; failed/cancelled runs
    still count, while single-active-run, Worker concurrency 1, global queue 2,
    entitlement and medical quality boundaries remain unchanged;
  - request `req-2bc6c36c-fa4d-4186-967f-14377eebe4e0` was a genuine,
    pre-model `research_unique_doctors_30d` rejection: the subject had used all
    five rolling-window doctor slots and requested a sixth unseen doctor. The
    old generic 30-second retry was misleading; `ff5db5f` changed an enabled
    rolling-window policy to return the
    earliest real per-doctor last-admission expiry plus
    `rolling_30_days / maximum / used / requested` while that policy was still
    enabled;
  - production public-contract smoke
    `req-d7e8d1a1-1ead-4a5a-bf6b-94c03a49cf1f` returned
    `maximum=5`, `used=5`, `requested=1` and an exact 2,519,833-second
    `Retry-After`; the subject's run/admission counts stayed `30/30` and the
    temporary key was revoked;
  - the business owner then explicitly removed the different-doctor count
    limit. All four containers now load
    `RESEARCH_MAX_UNIQUE_DOCTORS_PER_SUBJECT_30D=0`; missing, negative and
    non-integer values remain startup errors, and positive values retain the
    old rolling-window contract for rollback;
  - public request `req-a420c2e0-49fc-49b3-8190-eebe1d17b54a` admitted the
    formerly blocked new-doctor shape as run
    `drr_44172c711e494cacb3b0eda1947326a7`. It was immediately cancelled,
    produced zero artifacts, consumed exactly one run/admission and left zero
    temporary keys;
  - the reported user's subject had used 5 admissions on the rollout day and
    therefore had 45 remaining without consuming another run for verification;
  - `1.6.81` permits a final deterministic repair only when all remaining
    diagnostics are duplicate paragraph, unmatched delimiter or invalid inline
    enumeration, and reruns every hard validator before acceptance;
  - exact-three-field public run `drr_ed34e4ea72af4648b0e29d87b2f42175`
    succeeded in 198.292 server seconds, exercised the bounded delimiter
    repair, joined all five Worker and Gateway/provider timelines, and verified
    exactly 3 MD + 1 TXT against manifest sizes and SHA-256;
  - real-user `1.6.81` run `drr_fe4729ec07eb42aea302d3289735b33f`
    failed closed in 321.483 seconds because its QA correction inherited
    `reasoning=low` and an 18,000-token ceiling, reached the 175-second
    provider deadline, and the later peer response did not satisfy the
    contract. It published zero artifacts; identity, quota and deployment
    were not the cause;
  - production history since 2026-07-22 showed the old attempt-4
    `low / 18,000` shape succeeded 13/27 times and timed out 14/27, while
    existing `none / 8,000-10,000` calls succeeded 19/19. `1.6.82` therefore
    bounds all targeted correction and peer calls without changing the model,
    medical Skill, quality gates or artifact contract;
  - post-deploy three-field public E2E
    `drr_e3eee788c4da4c5e88c78f248929728a` succeeded in 161.227 server seconds.
    Its QA correction used `reasoning=none`, 8,000 output tokens, a 2.323-second
    first provider event and 11.866-second provider duration. The Python client
    verified exactly 3 MD + 1 TXT, manifest sizes and every SHA-256;
  - latest reported `1.6.82` run `drr_cd3716ae58524bf299e36d6437b12a00`
    was not a deployment, identity, quota or provider failure. All five Aliyun
    calls returned 200, but after a successful QA correction the fifth slot
    was still used for a contract-unusable general peer response; deterministic
    fallback then left one topic at 313/450 and correctly published zero
    artifacts;
  - `1.6.83` reuses that fifth and final slot for the existing hash-bound
    single-section repair only when a completed bounded correction leaves
    exactly one repairable section. It adds no sixth call and preserves the
    original-section SHA, allowed-evidence, citation, complete-validation and
    fail-closed boundaries;
  - exact-three-field post-deploy public E2E
    `drr_ad1f050c609945c29d546315d4857173` succeeded in 201.212 server-active
    seconds (203 seconds client wall time). Five Aliyun requests returned 200
    with complete timelines and cancellation `0/0`; the run committed 76
    sources, 40 references and 9 claims, and exactly 3 MD + 1 five-line TXT
    matched result/manifest/file sizes and every SHA-256;
  - two of those runs exercised the 175-second provider deadline. Cancellation
    was requested and observed, the replacement attempts began only after the
    old calls terminated, and no same-session provider overlap was found;
  - the controlled-trial policy preserves all identity, citation, numeric,
    evidence-grade, safety and artifact hard gates while treating pure length
    targets as target plus warned release floor. All five accepted results were
    `passed_with_warnings`;
  - final service verification found all four containers healthy with zero
    restarts, only `127.0.0.1:18787` published, public/loopback health ready,
    and no active run, unfinished reservation or temporary validation file. The
    requested named user test credential remains active for handoff;
  - public OpenAI, strict-tools, the exact eight-model surface and focused
    `goldencode` native-tools smokes passed. One first native call through
    OpenRouter reached its 240-second client bound and verified
    `client_abort/cancel_requested=1/cancel_observed=1`; controlled retry
    `req-c61a0ac5-e163-42fa-a779-393062489c72` succeeded in 118 seconds. All
    temporary smoke/E2E users were disabled with zero active keys, the
    temporary entitlement was cancelled and temporary output was removed;
  - verified rollback boundary:
    `/home/qian/codex-gateway-backups/ddb1dcc/20260729T063301Z`, with image tags
    `rollback-ff5db5f-20260729T063301Z` and all four databases integrity/FK/hash
    checked;
  - superseded deployment backup directories from `70ca267` through
    `20ca27f` were removed only after the verified `599fd53` boundary was
    confirmed, recovering about 8.6 GiB. The `599fd53/20260727T022356Z`
    boundary, the `2559d3a` and `02b74de` boundaries, the current
    `eb94fa8/20260728T062916Z`, `ff5db5f/20260729T053039Z` and current
    `ddb1dcc/20260729T063301Z` boundaries and all live state volumes remain;
  - access remains controlled-trial. The medical team still needs to confirm
    representative cases, decide whether to retain the soft completeness policy,
    and manually accept four-file content. CN1, Nginx, public ports and
    MedEvidence were not modified.

- Historical Doctor Research `1.6.72` deployment record (superseded by the
  current entry above):
  - runtime commit `a77cf01fe8e71b92bb071cab40c4ab5e0e6d37bb` from clean release
    `/home/qian/codex-gateway-release-a77cf01-20260722T103032Z`;
  - build, 579 Vitest tests, 23 Python tests, npm audit and medical-Skill
    zero-diff checks passed both locally and on the VM;
  - both non-stream `/v1/chat/completions` and `/v1/responses` public-HTTPS
    disconnect smokes propagated cancellation to the provider and recorded
    `client_aborted`, `cancel_requested=1` and `cancel_observed=1`; a normal
    provider call explicitly recorded `cancel_requested=0` and
    `cancel_observed=0`;
  - Worker/Gateway/provider call timelines now include prompt/output budgets,
    admission wait, real provider first event/duration, client duration,
    terminal source and cancellation state; timeout joins use the client
    session ID when no Gateway request ID is available;
  - the deterministic replay suite, shared review/prose policy, hash-bound
    section repair, evidence-prompt deduplication and safety-normalization
    fallbacks are active. The replay set has 13 independent fixtures and 16
    tests. Medical Skill bundle SHA-256 remains
    `6d5e839f942f87f1064a6d855c37b54302300aacd700360aa5fef8907a2fa351`;
  - five consecutive public E2E runs of the same engineering-allowlisted smoke
    case all reached terminal state in 209.931-358.272 seconds. Three succeeded
    with exactly 3 MD + 1 TXT and
    verified manifest hashes; two failed closed as `model_contract_error`
    with zero artifacts because multiple evidence gates or the unchanged
    `600`-character topic floor remained unsatisfied;
  - an additional exact-runtime post-deploy public E2E,
    `drr_eab9f11f07484434aff46074bfd567e0`, succeeded in 227.733 seconds with
    exactly 3 MD + 1 TXT and verified all manifest hashes. Its temporary key,
    entitlement, user and downloaded files were cleaned;
  - current main commit `d31177f6085f02aa9c94434fe2988438ed2e22a6`
    adds the complete Chinese API usage/caution guide, a tracked JSON request
    example and a strictly validated Python `--request-file` client. Main
    passed build, 579 Vitest tests, 30 Python tests and npm audit with zero
    vulnerabilities. This client/docs-only commit did not restart the
    `a77cf01` runtime;
  - the updated Python client was validated through public HTTPS. Run
    `drr_f0048d1f058945dca14495ddcb111a99` failed closed with zero artifacts
    as `model_contract_error` in 170.726 seconds after multiple independent
    content gates remained unresolved. Controlled rerun
    `drr_62ac092339a14b55957141918c750af4` succeeded in 389.430 seconds and
    downloaded exactly 3 MD + 1 TXT with every size and SHA-256 verified. Its
    timed-out correction recorded cancellation `1/1`, and a later call waited
    31.010 seconds for admission rather than overlapping it;
  - compared with the two `1.6.58` production runs, mean create-to-terminal
    time fell from 431.734 to 270.852 seconds (37.3%). Mean estimated prompt
    tokens per associated Gateway event fell from 14116.89 to 12635.76
    (10.5%); this cross-version observation is not a causal isolation test and
    does not replace medical content review;
  - final service verification found all four containers healthy with zero
    restarts, public Gateway bound only to `127.0.0.1:18787`, and loopback plus
    public health checks passing. All temporary E2E/abort users were disabled,
    credentials revoked, entitlements cancelled and reservations finalized;
    the Python-client validation users and temporary VM directories were also
    verified clean;
  - verified pre-deploy backup:
    `/home/qian/codex-gateway-backups/a77cf01/20260722T103032Z`; immediate
    rollback images are tagged `rollback-70ca267-20260722T103032Z`, and the
    earlier verified `70ca267/20260722T093500Z` database boundary is retained;
  - access remains controlled-trial. Do not expand it until the medical team
    confirms representative cases, manually accepts the four-file contents and
    decides whether any soft completeness policy should change. CN1, Nginx,
    public ports and MedEvidence were not modified.

- Native-tool recovery for GoldenCode/ABS compatibility was deployed on
  2026-07-19:
  - public Gateway runtime commit
    `857d45330081adbb3f46a942b78a413349b51a5e` was built from clean release
    `/home/qian/codex-gateway-release-857d453-20260719T134615Z`;
  - when an upstream returns no native tool call and its entire body is the
    serialized `[assistant tool_calls]` envelope, the Gateway now recovers it
    through the existing declared-tool-name and JSON Schema validation path.
    It does not add a provider attempt or expose the serialized envelope as
    assistant text;
  - online backups are retained under
    `/home/qian/codex-gateway-backups/857d453/20260719T134822Z`. Both
    `gateway.db` and `client-events.db` passed SQLite integrity checks with
    zero foreign-key violations;
  - rollback image
    `codex_gateway_test-gateway:rollback-857d453-20260719T134822Z` is retained.
    The deployed Gateway image is
    `sha256:e685f308424c0840219658f478ed1a1ffa575957c0ced73c0c1fa377f3b27413`;
  - public health, the exact eight-model surface, four protected provider-key
    names, OpenAI chat, strict tools, GoldenCode native tools and an ABS-like
    Qianfan tool continuation all passed. The native-tool request
    `req-0404a550-d5ce-4d14-92b1-0bc45e2f5341` and continuation request
    `req-f23a650c-2608-4056-9cd2-4d7469f8b7f0` each recorded one upstream
    attempt;
  - the Gateway remained bound only to `127.0.0.1:18787` with zero restarts.
    Research LLM Gateway, Worker and maintenance container identities, start
    times and restart counts were unchanged.

- Historical 2026-07-18 Doctor Research controlled-beta profile (superseded by
  the current Aliyun-only internal Research pool) was enabled on the production
  Azure Gateway:
  - runtime checkout commit
    `71df0fac7047000f88a057a79ef649e2cad0a819`
    from clean release
    `/home/qian/codex-gateway-release-499241c-20260718T234851Z`;
  - the public Gateway remains loopback-only on `127.0.0.1:18787`; Nginx and
    its public edge configuration were not changed;
  - separate production Research database/artifact and backup volumes,
    internal LLM Gateway state/log volumes, Worker and independent maintenance
    processes are enabled; all four production containers are healthy with
    zero restarts;
  - the internal, non-published Research LLM Gateway exposes only
    `goldencode`, backed by direct Qianfan, Tencent and Aliyun GLM-5.2
    members; Max, Codex, OpenRouter, public proxies, Google Scholar and
    dynamic third-party Skill execution are absent from this path;
  - Skill `1.3.0` / input schema `doctor_research_run_input.v2` adds a
    fail-closed bilingual literature identity: an allowlisted official source
    must co-locate the Chinese display name and PubMed name, then every
    retained publication must attribute the configured English hospital and
    department to the matching author;
  - production run `drr_da23489a80ae4d51b43f0850fdfd369d` used the display
    name `陆清声`, two complementary first-party official pages, PubMed,
    Crossref and direct Qianfan `goldencode` / `glm-5.2`; it completed
    structured generation, validation and terminal fencing, followed by
    public HTTPS result retrieval and four authenticated hash-verified
    downloads;
  - the verified localized result contains exactly
    `陆清声_基础信息与研究方向.md`,
    `陆清声_相关领域前沿综述.md`,
    `陆清声_医生可能问机器人问题.txt`, and
    `陆清声_问题与答案.md`; the txt contains exactly five non-empty lines.
    Production stale-heartbeat `503`, exact
    cancellation replay/convergence, subject isolation, encoded traversal and
    networkless isolated backup/restore drills passed;
  - the post-deploy public model surface remained exactly the expected eight
    models. A temporary-key `goldencode` Chat Completions smoke completed with
    `upstream_account_id=goldencode-openrouter`,
    `upstream_model=z-ai/glm-5.2`, `reasoning_effort=medium` and `status=ok`;
  - public OpenAI, strict-tools and public `goldencode` native-tools
    compatibility smokes passed after the final Gateway recreation;
  - admission limits remain conservative: Worker concurrency 1, global queued
    runs 2, two runs per subject per day, 512 MiB Research storage ceiling,
    and a 10 GiB/10% free-space floor. The OS filesystem had 15 GiB free at
    final validation;
  - beta access is granted only through the dedicated
    `plan_research_beta_production_v1` plan. A real user handoff still requires
    that user's name and phone number; no existing shared user plan received
    `doctor_research`. All deployment/E2E credentials were revoked, their
    users disabled, and their token files removed after final verification;
    none is available for user handoff.

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

- 2026-07-30 Doctor Research runtime `1.6.100 @ 29790d2` passed the full local
  release gate (build, 40 files/625 Vitest, 36 Python, zero-vulnerability audit,
  diff check and medical-Skill zero diff), verified four-database rollback
  snapshots, built four immutable candidate images and activated them in
  dependency order. All services reached healthy with zero restarts and the
  exact release workdir; only the Gateway retained `127.0.0.1:18787`.
  Loopback/public eight-model checks, internal one-model check, entitlement,
  post-deploy networkless backup verification, a real arbitrary-doctor search,
  complete five-call timeline, and strict four-artifact download verification
  passed. Temporary access and files were removed afterward.
- 2026-07-18 the isolated Doctor Research staging Compose project passed the
  live controlled-beta rehearsal documented in
  `docs/research/doctor-research/controlled-beta-evidence.md`. Run
  `drr_e5d73d1b922745639ecf820f9df81cc8` succeeded through
  GoldenCode/GLM-5.2 and produced exactly four hash-verified files. Backup
  `drb_cf6a01d4733946b2ada650aa9de12ae0` passed a networkless isolated restore.
  Staging Gateway, Worker and maintenance were healthy with zero restarts after
  the drills, and staging published only `127.0.0.1:18788`. The production
  Gateway remained healthy with zero restarts on its original image and
  loopback listener; its Research feature flag remained false.
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
- Let's Encrypt certificate for `gw.instmarket.com.au` is managed by certbot.
  The live certificate checked on 2026-07-19 is valid from 2026-06-21 through
  2026-09-19, confirming automatic renewal replaced the earlier certificate.
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

Session persistence, API key authentication, API key issue/update/revoke/rotate/reveal, user contact metadata, user-level disable/enable, single-process API key rate limiting, request event writing with token usage fields, admin action audit events, dynamic usage reports with token totals, read-only controlled-trial checks, dry-run-capable manual request event pruning, strict client-defined tools validation, and `/v1/responses` are wired into the gateway. Public HTTPS routing for `gw.instmarket.com.au` is active through existing Nginx. Existing SQLite databases migrate `subscriptions` / `subscription_id` to `upstream_accounts` / `upstream_account_id`; public compatibility aliases remain for `/gateway/status`, session JSON, and `GATEWAY_PUBLIC_SUBSCRIPTION_ID`. Token budget enforcement, scheduled retention jobs, materialized usage reports, admin operator identity capture, native SDK-level dynamic tool registration, and multi-process shared rate limiting are still pending.

## Ops Skill

A local Codex skill named `codex-gateway-ops` has been created for this workstation. It is stored outside the repository under the local Codex skills directory because it contains operator-local access details. The public repository only records sanitized access patterns and safety rules.
