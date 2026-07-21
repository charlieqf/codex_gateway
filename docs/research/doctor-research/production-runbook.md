# Doctor Research production runbook

This runbook deploys the staging-validated Doctor Research mainline into the
existing Azure `codex_gateway_test` Compose project. It keeps the public
Gateway on `127.0.0.1:18787`, uses the existing Nginx route, and adds no public
Docker listener.

## Current production deployment

As of 2026-07-21, the public Azure Gateway, Research Worker and maintenance
service run commit `f91ff78a0812f7e5fe7eb09a0230df53e5732aa1` from:

```text
/home/qian/codex-gateway-release-f91ff78-20260721T101407Z
```

The execution contract is `1.6.58`, with prompt `v27`, validation contract
`v39` and workflow `doctor_research_workflow.v52`. The public Gateway remains
bound only to `127.0.0.1:18787`; the internal LLM Gateway was not recreated.
The ordinary public surface still exposes the exact eight-model registry.
Build, all 531 Vitest tests and all 23 Python tests passed before deployment.
The medical-team Skill directory has no Git diff and its deployed four-file
bundle SHA-256 remains:

```text
6d5e839f942f87f1064a6d855c37b54302300aacd700360aa5fef8907a2fa351
```

The API is enabled for a restricted, named-user production trial, but this
release has **not** passed strict four-artifact production acceptance. Two
public-HTTPS release runs remained below the ten-minute ceiling but failed
closed without publishing partial artifacts:

- `drr_9f7bb667522046389ef4579805b8fda4` ran from
  `2026-07-21T10:18:56.718Z` to `10:25:51.134Z` (414.416 seconds) and ended
  `upstream_unavailable` after required GoldenCode/GLM-5.2 generation calls
  did not return. The Worker then performed its deliberate dependency-failure
  restart and returned healthy.
- `drr_25f189a126d54b6c9e0979495225215e` ran from
  `2026-07-21T10:27:43.049Z` to `10:35:12.100Z` (449.051 seconds). Two
  synthesis shards returned in approximately 77 and 108 seconds; another
  attempt received an upstream HTTP 500 `Batch backend error`. The final
  peer output was rejected as `model_contract_error` because one reviewed
  topic section was `328/600` characters. All other final validation errors
  had been closed.

Do not describe `1.6.58` as fully accepted and do not broaden access beyond
approved named trial users until a fresh real run succeeds, returns exactly
three Markdown files and one five-line text file, all manifest hashes match,
and the four downloaded contents pass manual review. The current behavior is
intentionally fail-closed: users may receive a terminal upstream or model
contract error rather than unsupported medical content.

The only retained online database backup and the current rollback image tags
are:

```text
/home/qian/codex-gateway-backups/f91ff78/20260721T101407Z
codex_gateway_test-gateway:rollback-644d566-20260721T101407Z
codex_gateway_test-research-worker:rollback-644d566-20260721T101407Z
codex_gateway_test-research-maintenance:rollback-644d566-20260721T101407Z
```

All three SQLite backups passed integrity and foreign-key checks. Their
SHA-256 values are:

```text
gateway.db       77e25be2be71aff63b10a95ba7197d5e68a4351301fa5f793bd58326052a953f
client-events.db 8af7bd9ddec088e6ec4f03cf2ca0528c629c242b3fd899470e88e76d0e609a9b
research.db      f66af06e1f9935b964ea5d6d6c0bf9d4781bbf3a4768ac81f3bec4c2204ad4fb
```

The superseded `644d566` database backup was deleted only after those hashes,
the new release and service health were verified. Historical source releases
and the pre-Research compatibility boundary remain separate from database
backup retention.

The separate backup volume is encrypted at rest by the Azure managed-disk
platform and has passed a networkless scratch-volume restore drill. It is on
the same OS disk, so it is not an off-host disaster-recovery copy.

## Production shape

Compose must always be invoked with both files and the explicit project name:

```bash
docker compose -p codex_gateway_test \
  --env-file config/research.production.compose.env \
  -f compose.azure.yml \
  -f compose.research-production.yml
```

The overlay adds:

- the Research API configuration and Research state volume to the existing
  public Gateway;
- an internal, non-published LLM Gateway whose production GoldenCode pool
  currently enables only direct Aliyun GLM-5.2 with three-call concurrency;
  Qianfan and Tencent remain disabled rollback entries;
- one Worker and one independent maintenance process;
- separate Research state, verified-backup, internal-LLM-state and log
  volumes.

Max, Codex, OpenRouter, public HTTP proxies, Google Scholar and dynamic Skill
execution are not part of the Research generation path.

The production SLA is a hard ten-minute wall-clock ceiling from API run
creation, not merely Worker active time. The protected Worker environment must
keep `RESEARCH_HARD_DEADLINE_SECONDS` at `570` or lower,
`RESEARCH_LLM_TIMEOUT_MS` below that deadline (currently `240000`), and
`RESEARCH_SYNTHESIS_SHARD_COUNT=3`. Configuration loading fails closed if the
deadline exceeds 600 seconds.

## Default-closed switches

All four host-side switches default to false:

```text
RESEARCH_PRODUCTION_API_ENABLED
RESEARCH_PRODUCTION_LLM_READINESS_API_ENABLED
RESEARCH_PRODUCTION_WORKER_ENABLED
RESEARCH_PRODUCTION_MAINTENANCE_ENABLED
```

The LLM-readiness switch registers the authenticated Worker readiness route
only on the isolated, non-published LLM Gateway. Enable it only after the
internal service credential exists. Do not enable public API admission until
maintenance has produced a fresh verified backup and the Worker has published
a ready heartbeat. Never set `RESEARCH_ACCEPT_WHEN_WORKER_UNAVAILABLE=true`.

## Required private files

Create these untracked files in the clean production release:

```text
config/research.production.api.env
config/research.production.compose.env
config/research.production.worker.env
config/research.production.llm-gateway.env
secrets/research-production-qianfan-key
secrets/research-production-tencent-key
secrets/research-production-aliyun-key
secrets/research-production-llm-token
```

The four env files must be mode `0600`. Provider and service-token files must
be host owner `999:999`, mode `0400`. Compose local secrets do not enforce the
declared uid/gid/mode; verify host metadata.

Create the Compose env from
`config/research.production.compose.example.env`. Its four enable switches
must remain false until the corresponding start-order gate below passes.

The Worker example deliberately fails production startup until:

- the NCBI and Crossref contact address is replaced with a monitored operator
  address;
- the external User-Agent placeholder is replaced;
- the backup target's encryption has been verified and
  `RESEARCH_BACKUP_TARGET_ENCRYPTION_CONFIRMED=true`;
- ORCID is either `disabled`, or an approved anonymous/credentialed mode is
  configured.

With `RESEARCH_ORCID_MODE=disabled`, runs omitting ORCID remain supported.
Requests that explicitly supply ORCID fail identity resolution; the Worker
does not silently ignore an asserted ORCID.

## Preflight and rollback boundary

Before any build or recreate:

1. Confirm the current production container is healthy, has zero unexpected
   restarts and publishes only `127.0.0.1:18787`.
2. Confirm the protected base env contains the exact eight-model registry and
   all four existing provider key names without printing values.
3. Run online SQLite backup for `gateway.db` and `client-events.db`, then
   verify database hashes, integrity and foreign keys.
4. Tag the current production image by timestamp and retain the clean
   `ccccf1c` rollback release.
5. Confirm at least 10 GiB and 10% filesystem free space.
6. Render Compose with `config --quiet`; never print the rendered environment.

The minimum rollback image after writing a `doctor_research` capability remains
the pinned boundary in `phase0.5-compatibility.md`. Rollback must preserve the
Research volume and must not delete completed artifacts.

## Bootstrap the internal LLM credential

Start only `research-llm-gateway`, still leaving the public Research API and
Worker disabled. In its isolated Gateway database:

1. Create a service plan from
   `research.production.token-policy.example.json` and
   `research.production.service-feature-policy.example.json`.
2. Issue a service credential with exactly the `goldencode` public-model
   allowlist and no `doctor_research`, image or admin capability. Its bounded
   rate must cover five calls per run and three concurrent synthesis calls
   (`rpm >= 5`, `rpd >= 5`, `concurrent >= 3`). The fifth call is reserved
   for one bounded shard retry after a retryable transport failure or a
   remaining unusable fragment contract. Common harmless envelope differences
   are normalized deterministically and do not consume that retry.
3. Grant the service entitlement.
4. Capture the full token only in a mode-`0600` temporary file, atomically
   install the token secret as `999:999`/`0400`, and remove the temporary file.
5. Set `RESEARCH_PRODUCTION_LLM_READINESS_API_ENABLED=true` and recreate only
   `research-llm-gateway`.
6. Verify `/v1/models` from inside the Compose network lists only
   `goldencode`.

## Start order

Use this order:

1. Build all four services from the clean release.
2. Start the internal LLM Gateway, bootstrap its credential, then enable only
   its isolated LLM-readiness API switch.
3. Start maintenance with only
   `RESEARCH_PRODUCTION_MAINTENANCE_ENABLED=true`.
4. Wait for a successful verified backup and healthy maintenance.
5. Start the Worker with `RESEARCH_PRODUCTION_WORKER_ENABLED=true`.
6. Wait for live PubMed/Crossref/official-source/direct-GLM preflight and a
   current ready heartbeat.
7. Recreate only the public Gateway with
   `RESEARCH_PRODUCTION_API_ENABLED=true`.
8. Verify the ordinary eight-model surface and existing Gateway smokes before
   granting a beta user.

## Beta user and real E2E

Create a dedicated production beta plan with only `doctor_research`. Grant it
only to named, approved beta users; do not add the capability to a shared
existing plan.

Every real user handoff must record a name and phone number. Store the full API
key only in an approved local handoff file or private channel. Console, logs,
documents and tickets remain prefix-only.

Run the smoke from the VM against literal loopback
`http://127.0.0.1:18787`, using separate mode-`0600` token, request and output
paths. Success requires:

- `POST -> heartbeat/lease -> live sources -> GoldenCode/GLM-5.2 ->
  validation -> succeeded`;
- `GET result`;
- exactly four manifest entries and downloads;
- exactly three Markdown files and one five-line text file;
- downloaded sizes and SHA-256 values equal the manifest.
- measured create-to-terminal wall time below 600 seconds;
- one three-call concurrent synthesis fan-out, at most one bounded retry for
  a transport/upstream failure, and exactly one compact peer-review call;
- a rendered 3-8-row core evidence table and no partial artifact publication.

Then verify the public HTTPS status/result/download path, foreign-subject
uniform `404`, encoded traversal rejection, cancellation convergence,
stale-heartbeat `503`, backup creation and isolated restore.

After collecting the release evidence, revoke the E2E credential, disable its
temporary user and remove its mode-`0600` token/request files. Never hand an
E2E credential to a beta user; provision a new named credential with recorded
phone metadata instead.

## Rollback

If the public Gateway, eight-model registry, Worker readiness, backup,
admission or E2E check fails:

1. Set `RESEARCH_PRODUCTION_API_ENABLED=false` and recreate only Gateway.
2. Stop Worker and maintenance with their 45-second grace period.
3. Restore the previous Gateway image/release without deleting Research
   volumes.
4. Re-run ordinary health, auth, models, chat, Responses and strict-tools
   smokes.
5. Keep failed Research runs and sanitized logs for review; do not fabricate a
   success or publish partial artifacts.
