# Doctor Research production runbook

This runbook deploys the staging-validated Doctor Research mainline into the
existing Azure `codex_gateway_test` Compose project. It keeps the public
Gateway on `127.0.0.1:18787`, uses the existing Nginx route, and adds no public
Docker listener.

## Current production deployment

As of 2026-07-22, the public Azure Gateway and all three Research services run
commit `a77cf01fe8e71b92bb071cab40c4ab5e0e6d37bb` from:

```text
/home/qian/codex-gateway-release-a77cf01-20260722T103032Z
```

The execution contract is `1.6.72`, with prompt `v28`, validation contract
`v39` and workflow `doctor_research_workflow.v65`. The public Gateway remains
bound only to `127.0.0.1:18787`; no other Research service publishes a host
port. The ordinary public surface still exposes the exact eight-model
registry. Local and Azure release gates passed build, all 579 Vitest tests,
all 23 Python tests and an npm audit with zero vulnerabilities.
The medical-team Skill directory has no Git diff and its deployed four-file
bundle SHA-256 remains:

```text
6d5e839f942f87f1064a6d855c37b54302300aacd700360aa5fef8907a2fa351
```

The API remains a restricted, named-user production trial. Five consecutive
public-HTTPS runs of the same engineering-allowlisted smoke case all reached a
terminal state below ten minutes. The medical team has not yet confirmed that
case as its final representative acceptance case:

- `drr_a98ba77e84a04f99a47de3e322c07043`: succeeded in 237.459 seconds;
- `drr_dffe542c19914841bf9936e65f93ca3a`: succeeded in 209.931 seconds;
- `drr_955f4e47884b4a9eaa1c0b5e57045265`: succeeded in 262.879 seconds;
- `drr_9ac8538f3ce147a0abcf1f6c19a0f96b`: failed closed as
  `model_contract_error` in 285.717 seconds after multiple independent
  citation, numeric, causality and prose gates remained unresolved;
- `drr_9d5fea39377646daa08bdfacfaef1861`: failed closed as
  `model_contract_error` in 358.272 seconds after a cancelled correction
  timeout and a final `476/600` topic section.

After deploying exact runtime commit `a77cf01`, public-HTTPS E2E
`drr_eab9f11f07484434aff46074bfd567e0` succeeded in 227.733 seconds. It again
downloaded exactly 3 MD + 1 TXT and verified every size and manifest SHA-256;
the temporary key was revoked, entitlement cancelled, user disabled and local
downloads removed.

Client documentation and the dependency-free Python example were then updated
on main in commit `d31177f6085f02aa9c94434fe2988438ed2e22a6`. This is an
external client/docs change and did not rebuild or restart the `a77cf01`
Gateway/Worker runtime. Current main passed the same build and 579 Vitest tests,
plus 30 Python tests and a zero-vulnerability npm audit. The new
`--request-file` path was also exercised through the real public API:

- `drr_f0048d1f058945dca14495ddcb111a99` failed closed as
  `model_contract_error` in 170.726 seconds. All four provider calls returned,
  but the assembled response still violated multiple citation, numeric,
  causality, answer-coverage and review-section gates; zero artifacts were
  published.
- `drr_62ac092339a14b55957141918c750af4` succeeded in 389.430 seconds and the
  Python client authenticated, downloaded and independently verified exactly
  3 MD + 1 TXT. A bounded correction call reached the 175-second Gateway
  deadline with `cancel_requested=1` and `cancel_observed=1`; the subsequent
  call was admitted only after a 31.010-second wait, so the old and new
  provider calls did not overlap.

The successful Python-client artifact SHA-256 values, in
`profile / review / questions / answers` order, were:

```text
4ae0c4abd1038fc22ab207ffc9c3a3ac8588363b26b2dca54bbee139266ad4d9
cd76a114605e1c21e4cd121ea2cb96d2c740fc293089f2d1ba0e5b8b186567cb
c10842b07e5978fca5c1094f3fb6229409e670b417866c55a4aecca5179624d3
07775cd687ccaa599988212c936482ec61ca5495d37f4a440412fa9e01c1aa47
```

All temporary Python-validation credentials were revoked, entitlements
cancelled, users disabled and VM/local output directories removed. All four
production containers remained healthy with zero restarts.

Each successful run returned exactly three Markdown files and one five-line
text file, and authenticated downloads matched all manifest SHA-256 values.
Each failed run published zero artifacts. This proves the engineering
terminal-time and artifact-atomicity requirements, but it is not a 5/5 model
success result and the medical team has not yet completed manual content
review. Do not broaden access beyond approved named trial users.

The current verified online database backup and rollback image tags are:

```text
/home/qian/codex-gateway-backups/a77cf01/20260722T103032Z
codex_gateway_test-gateway:rollback-70ca267-20260722T103032Z
codex_gateway_test-research-llm-gateway:rollback-70ca267-20260722T103032Z
codex_gateway_test-research-worker:rollback-70ca267-20260722T103032Z
codex_gateway_test-research-maintenance:rollback-70ca267-20260722T103032Z
```

All three SQLite backups passed integrity and foreign-key checks. Their
SHA-256 values are:

```text
gateway.db       77a8861f7afcfc51d4a5d2a6eb205222fbc52cda0be59cfd927ef6a04d75a642
client-events.db 76459a5c5f8981805e81524150835babefc48f1c357020be38d20d3cbda39376
research.db      77018681ced2f914279bc02dbcea4d8da23da881fd05ea7ffeb04d1859e0684b
```

The prior `70ca267` release remains the immediate source/image rollback
boundary, with its earlier verified database backup retained at
`/home/qian/codex-gateway-backups/70ca267/20260722T093500Z`. Historical
deployment backups superseded by these two verified boundaries were removed;
the current state volumes and both rollback boundaries were retained.

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
keep `RESEARCH_HARD_DEADLINE_SECONDS` at `570` or lower, the internal Gateway
provider deadline below the Worker call deadline (currently `175000` ms), and
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
- downloaded sizes and SHA-256 values equal the manifest;
- measured create-to-terminal wall time below 600 seconds;
- one bounded three-call synthesis fan-out and at most five total model calls;
  the last calls may be a targeted correction, hash-bound section repair or
  compact peer review according to deterministic diagnostics;
- a rendered 3-8-row core evidence table and no partial artifact publication.

Then verify the public HTTPS status/result/download path, foreign-subject
uniform `404`, encoded traversal rejection, cancellation convergence,
stale-heartbeat `503`, backup creation and isolated restore.

After collecting the release evidence, revoke the E2E credential, disable its
temporary user and remove its mode-`0600` token/request files. Never hand an
E2E credential to a beta user; provision a new named credential with recorded
phone metadata instead.

For `1.6.72`, non-stream cancellation was also tested through public HTTPS for
both `/v1/chat/completions` and `/v1/responses`. Each deliberate disconnect
recorded `client_aborted`, `terminal_source=client_abort`,
`cancel_requested=1` and `cancel_observed=1`; temporary users and credentials
were disabled/revoked, and no token reservation remained unfinalized.
After the `a77cf01` deployment, a normal non-stream provider call explicitly
recorded `cancel_requested=0` and `cancel_observed=0`, while fresh Chat and
Responses disconnects again recorded `1/1`. Runtime inflight requests and
unfinalized reservations returned to zero, all four containers remained
healthy with zero restarts, and the temporary credential was revoked and its
user disabled.

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
