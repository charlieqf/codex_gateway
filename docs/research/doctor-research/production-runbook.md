# Doctor Research production runbook

This runbook deploys the staging-validated Doctor Research mainline into the
existing Azure `codex_gateway_test` Compose project. It keeps the public
Gateway on `127.0.0.1:18787`, uses the existing Nginx route, and adds no public
Docker listener.

## Current production deployment

As of 2026-07-19, the controlled beta is enabled at runtime commit
`4397420c0f25851131cee0c83580e96df6b54281` from:

```text
/home/qian/codex-gateway-release-499241c-20260718T234851Z
```

All four switches are enabled after their gates passed. The public Gateway,
internal direct-GLM Gateway, Worker and maintenance containers are healthy
with zero restarts. Production run
`drr_3d65d1ca83c34eee883679cea27fd116` succeeded and public HTTPS returned
exactly three Markdown artifacts plus one five-line text artifact with
manifest-matching hashes.

The pre-Research release and rollback image remain:

```text
/home/qian/codex-gateway-release-ccccf1c-20260718T031500Z
codex_gateway_test-gateway:rollback-ccccf1c-20260718T235210Z
```

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
- an internal, non-published LLM Gateway exposing only the three direct
  GoldenCode/GLM-5.2 members;
- one Worker and one independent maintenance process;
- separate Research state, verified-backup, internal-LLM-state and log
  volumes.

Max, Codex, OpenRouter, public HTTP proxies, Google Scholar and dynamic Skill
execution are not part of the Research generation path.

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
   allowlist and no `doctor_research`, image or admin capability.
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
