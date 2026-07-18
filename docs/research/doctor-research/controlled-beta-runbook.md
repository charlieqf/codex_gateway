# Doctor Research controlled-beta runbook

This runbook is for an isolated staging deployment only. It does not authorize
changes to the production Gateway environment, production credentials, Nginx,
the production container, port `18787`, or the production Research feature
flag.

## Safety boundary

- Use `compose.research-staging.yml` as a separate Compose project. Its default
  published address is loopback-only `127.0.0.1:18788`.
- Keep `RESEARCH_STAGING_API_ENABLED`,
  `RESEARCH_STAGING_MAINTENANCE_ENABLED` and
  `RESEARCH_STAGING_WORKER_ENABLED` unset until staging data, secrets,
  entitlements, backup target and upstream capacity are ready.
- Never copy a production user token, upstream account, Gateway encryption
  secret, Research service credential or provider key into staging.
- Do not expose the staging port publicly or add an Nginx route.
- Do not enable `RESEARCH_ACCEPT_WHEN_WORKER_UNAVAILABLE`.
- Do not use a public proxy, scrape Google Scholar, or execute a `.skill`,
  `SKILL.md`, third-party script or downloaded code. The Worker executes the
  reviewed TypeScript workflow and its frozen in-code `SkillDefinition`.

## Required external approvals and credentials

The Worker intentionally fails startup until all of these are present:

1. A staging-only Gateway upstream and an approved exact public model ID.
2. A staging-only Gateway service credential with:
   - an active entitlement containing `chat`;
   - an exact non-empty public-model allowlist containing only
     `RESEARCH_LLM_MODEL`;
   - no `doctor_research`, `image_generation` or admin capability.
3. An approved ORCID public-record access method and credential.
4. A Brave Search API key and a reviewed allowlist of first-party
   hospital/university domains.
5. Operator contact values for NCBI and Crossref.
6. A separate Research state volume and separate backup volume with enough
   free space.

PubMed and Crossref do not substitute for missing ORCID, official-site search
or LLM readiness. Missing any required dependency is a startup/admission
failure, never a successful empty result.

## Prepare staging files

Work from a clean checkout of the intended commit on the isolated host.
Do not use `config/gateway.container.env`.

```bash
umask 077
cp config/research.staging.gateway.example.env \
  config/research.staging.gateway.env
cp config/research.staging.worker.example.env \
  config/research.staging.worker.env
mkdir -p secrets research-smoke-output
chmod 700 secrets research-smoke-output
chmod 600 config/research.staging.gateway.env \
  config/research.staging.worker.env
```

Replace every `replace-with-...` value and every example official domain.
The actual Gateway environment file contains a staging-only encryption secret
and therefore remains untracked with mode `0600`.

Create these secret files without printing their values. Local Docker Compose
implements file-backed secrets as bind mounts, so its `uid`, `gid`, and `mode`
fields are not sufficient by themselves. Install the final files as host
`999:999` with mode `0400`, matching the existing Gateway image user, and
verify metadata only:

```text
secrets/research-staging-web-search-key
secrets/research-staging-orcid-client-id
secrets/research-staging-orcid-client-secret
```

```bash
sudo chown 999:999 \
  secrets/research-staging-web-search-key \
  secrets/research-staging-orcid-client-id \
  secrets/research-staging-orcid-client-secret
sudo chmod 0400 \
  secrets/research-staging-web-search-key \
  secrets/research-staging-orcid-client-id \
  secrets/research-staging-orcid-client-secret
stat -c '%u:%g %a %n' secrets/research-staging-*
```

The LLM service token file is created during credential bootstrap:

```text
secrets/research-staging-llm-token
```

Set paths without putting secret values in the environment:

```bash
export RESEARCH_STAGING_GATEWAY_ENV_FILE=./config/research.staging.gateway.env
export RESEARCH_STAGING_WORKER_ENV_FILE=./config/research.staging.worker.env
export RESEARCH_STAGING_WEB_SEARCH_KEY_FILE=./secrets/research-staging-web-search-key
export RESEARCH_STAGING_ORCID_CLIENT_ID_FILE=./secrets/research-staging-orcid-client-id
export RESEARCH_STAGING_ORCID_CLIENT_SECRET_FILE=./secrets/research-staging-orcid-client-secret
export RESEARCH_STAGING_LLM_TOKEN_FILE=./secrets/research-staging-llm-token
```

Do not enable shell tracing. Validate that the three feature switches are still
closed:

```bash
unset RESEARCH_STAGING_API_ENABLED \
  RESEARCH_STAGING_MAINTENANCE_ENABLED \
  RESEARCH_STAGING_WORKER_ENABLED
docker compose -f compose.research-staging.yml config
docker compose -f compose.research-staging.yml build
docker compose -f compose.research-staging.yml up -d gateway
```

The checked-in example files are intentionally not usable staging
configuration.

## Bootstrap staging-only plans and credentials

Use the admin CLI against the named staging Gateway volume. The following
helper form mounts only the reviewed policy examples:

```bash
dc_admin() {
  docker compose -f compose.research-staging.yml run --rm --no-deps \
    -v "$PWD/config:/staging-config:ro" \
    gateway node apps/admin-cli/dist/index.js \
    --db /var/lib/codex-gateway/gateway.db "$@"
}
```

Create immutable staging-only plans:

```bash
dc_admin plan create \
  --id plan_research_service_staging_v1 \
  --display-name "Research service staging" \
  --scope medical \
  --policy-file /staging-config/research.staging.token-policy.example.json \
  --feature-policy-file /staging-config/research.staging.service-feature-policy.example.json

dc_admin plan create \
  --id plan_research_beta_staging_v1 \
  --display-name "Research beta staging" \
  --scope medical \
  --policy-file /staging-config/research.staging.token-policy.example.json \
  --feature-policy-file /staging-config/research.staging.beta-feature-policy.example.json
```

Create the service subject/key with `--no-entitlement-check`, capture the CLI
JSON only in a restricted temporary file, grant the entitlement immediately,
and extract only the token to the Docker secret file:

```bash
service_issue="$(mktemp)"
chmod 600 "$service_issue"
dc_admin issue \
  --user research-service-staging \
  --user-label "Research service staging" \
  --label "Research Worker LLM" \
  --scope medical \
  --allowed-public-models "<exact-RESEARCH_LLM_MODEL>" \
  --rpm 4 --rpd 100 --concurrent 1 \
  --no-entitlement-check >"$service_issue"
dc_admin entitlement grant \
  --user research-service-staging \
  --plan plan_research_service_staging_v1 \
  --period unlimited >/dev/null
node -e '
  const fs = require("node:fs");
  const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  fs.writeFileSync(process.argv[2], value.token + "\n", {
    encoding: "utf8", flag: "wx", mode: 0o600
  });
' "$service_issue" "$RESEARCH_STAGING_LLM_TOKEN_FILE"
rm -f "$service_issue"
sudo chown 999:999 "$RESEARCH_STAGING_LLM_TOKEN_FILE"
sudo chmod 0400 "$RESEARCH_STAGING_LLM_TOKEN_FILE"
```

Use the same restricted-capture pattern for a dedicated beta user credential.
Its plan is `plan_research_beta_staging_v1`; it must not be the Worker service
subject. Store its full token in a separate mode-`0600` host file for the
smoke test. Do not print either token or commit either file.

Before continuing, inspect redacted CLI output for both subjects:

```bash
dc_admin entitlement show --user research-service-staging
dc_admin entitlement show --user <beta-user-id>
```

## Start the isolated beta

Explicitly opt in only after bootstrap and provider review:

```bash
export RESEARCH_STAGING_API_ENABLED=true
export RESEARCH_STAGING_MAINTENANCE_ENABLED=true
export RESEARCH_STAGING_WORKER_ENABLED=true
docker compose --profile research-beta \
  -f compose.research-staging.yml up -d --build
docker compose --profile research-beta \
  -f compose.research-staging.yml ps
```

The independent maintenance process must complete database-fenced TTL
reconciliation, orphan cleanup, storage admission and a verified initial
backup before it becomes healthy. The Worker depends on that health signal,
then completes live adapter preflight, exact-model credential readiness
(including configured per-call/per-run rate and token coverage), fresh-backup
verification and storage admission before it writes a `ready` heartbeat.
`RESEARCH_EMBEDDED_MAINTENANCE_ENABLED` remains `false`. Until then, create
requests return a Research `503`.

Verify that the host publishes only the staging loopback port:

```bash
ss -ltnp | grep 18788
curl --fail --silent http://127.0.0.1:18788/gateway/health
```

Do not print the Worker environment or inspect Docker secrets through a shell.
Permitted logs contain IDs, generations, counts and error classes, not doctor
input, prompts, source bodies, artifacts or credentials.

## End-to-end smoke

Prepare a bounded JSON request file containing a permitted public doctor
identity. The controlled beta requires both hospital and department; ORCID is
optional but, when supplied, its public record must resolve the same name,
hospital and department anchors exactly. Keep both the beta token and request
JSON in separate mode-`0600` files.

```bash
export RESEARCH_SMOKE_BASE_URL=http://127.0.0.1:18788
export RESEARCH_SMOKE_USER_TOKEN_FILE=/absolute/private/path/beta-user-token
export RESEARCH_SMOKE_REQUEST_FILE=/absolute/private/path/request.json
export RESEARCH_SMOKE_OUTPUT_DIR="$PWD/research-smoke-output"
export RESEARCH_SMOKE_MAX_WAIT_SECONDS=7200
node scripts/research-beta-smoke.mjs
```

Success requires:

- `POST create -> queued/running -> succeeded`;
- result schema and server validation pass;
- exactly four distinct kinds: `profile`, `review`, `questions`, `answers`;
- all four authenticated downloads succeed;
- every downloaded byte count and SHA-256 equals its manifest;
- the output directory contains exactly the four fixed Markdown/text names.

The smoke script accepts only literal `127.0.0.1` or `::1` base addresses; it
never resolves `localhost`, accepts a non-loopback URL, or prints the Bearer
token or doctor request. Treat the emitted run ID and hashes as operational
metadata.

## Negative and recovery checks

Before any production proposal, record staging evidence for:

1. Stop the Worker and verify create returns `503` while status/result reads
   remain available.
2. Cancel one running run during an adapter or LLM call and verify it cannot
   later become `succeeded`.
3. Force lease expiry/takeover with two isolated Worker process instances and
   verify the old generation cannot checkpoint or commit.
4. Request a run and each artifact with a different subject and verify the
   response is uniformly `404`.
5. Try artifact IDs and paths containing traversal/symlink components and
   verify rejection.
6. Remove each required provider secret in turn and verify Worker readiness
   fails.
7. Exhaust storage and backup-age admission thresholds and verify create
   returns the specific Research `503`.
8. Restore a verified backup into a new isolated volume, run SQLite integrity
   and foreign-key checks, and verify all referenced artifact hashes before
   serving it.
9. Run ordinary Gateway health, model, chat, responses and native-session
   smokes against the staging Gateway to prove compatibility.

## Shutdown and cleanup

Disable admission first, drain the Worker, and preserve evidence:

```bash
export RESEARCH_STAGING_API_ENABLED=false
docker compose -f compose.research-staging.yml up -d --no-deps gateway
docker compose --profile research-beta \
  -f compose.research-staging.yml stop -t 45 research-worker research-maintenance
docker compose -f compose.research-staging.yml stop
```

Do not delete staging volumes until the backup/restore evidence and test run
IDs have been reviewed. Volume deletion is a separate destructive action and
is not part of this runbook.

## Production gate

Passing this runbook is necessary but not sufficient for production. Phase 0.5
is pinned separately in `phase0.5-compatibility.md`; do not choose an older
rollback image after a production `doctor_research` capability write. Keep the
production decision at **NO-GO** until Phase 0B quality evidence,
privacy/cross-border review, provider terms, approved capacity, encrypted
backup/restore targets, alerting and the exact production limits/RPO/RTO have
owners and recorded approval.
