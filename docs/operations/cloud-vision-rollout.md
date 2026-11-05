# R760 cloud vision enablement and subsequent updates

Use this procedure for an authorized Gateway release that enables or preserves
the shared GLM/DeepSeek vision route. Follow [container deployment](./container-deploy.md)
for source reconciliation, immutable image build, drain, rollback and final verification.
Run the commands below on R760 as root. Never print or commit candidate env files.

## 1. Prepare the committed release and backup

Set `REV` to the approved, tested, pushed **full 40-character main revision**.
Reconcile it with the actual live revision before proceeding. The release preparation
script accepts an already-verified Git bundle when GitHub is unavailable from R760.

```bash
set -euo pipefail
umask 077
REV='<full-approved-main-revision>'
ROOT=/opt/codex-gateway-r760
RELEASE="$ROOT/releases/$REV"
STAGE="$ROOT/staging/$REV"
BACKUP="$ROOT/backups/release-${REV:0:12}"
CANDIDATE="$BACKUP/vision-candidate.env"

# Run the reviewed prepare script, streamed from the intended committed source:
python3 -B /path/to/reviewed/r760-gateway-release-20260923-prepare.py "$REV" /path/to/verified-main.bundle
```

Preparation creates immutable `releases/$REV`, build source `staging/$REV/src`,
and protected `backups/release-${REV:0:12}/deployment.json` plus verified DB backups.
Build/test `codex_gateway_r760-gateway:$REV` from the archived source, with the exact
`org.opencontainers.image.revision=$REV` label. Rehearse opening a copy of the DB backup.
Include these committed runtime files in an overlay build (the normal Dockerfile
does not install arbitrary ops scripts): `deepseek-vision-preflight.mjs`,
`goldencode-d-public-smoke.mjs`, and `vision-smoke-helpers.mjs`, under `/app/scripts/ops`.
The Python scripts execute from the host release directory.

## 2. Generate the exact candidate

```bash
python3 -B "$RELEASE/scripts/ops/prepare-deepseek-vision.py" \
  --env-file "$ROOT/shared/config/gateway.container.env" \
  --output "$CANDIDATE"
test "$(stat -c %a "$CANDIDATE")" = 600
```

The output path is mandatory for deployment: **`backups/release-<first 12 revision
characters>/vision-candidate.env`**. The script copies the live GLM vision block,
preserves other configuration, and publishes the protected file atomically without
overwriting an existing file. `changed: false` is valid when updating code after vision
is already enabled; the new release still needs the same preflight and cutover checks.
If a candidate exists, verify its recorded hash/provenance; do not overwrite it blindly.
If production configuration changed after preparation, prepare a fresh reviewed candidate
and rerun preflight. Do not bypass the deployment byte-equality assertion.

## 3. Preflight the candidate image with that file

```bash
python3 -B "$RELEASE/scripts/ops/run-vision-preflight-r760.py" "$REV"
```

The wrapper pins the prepared live container and candidate image, mounts only the
candidate and required provider secret files read-only, and invokes:

```text
node --use-env-proxy --env-file=/run/vision-candidate.env /app/scripts/ops/deepseek-vision-preflight.mjs --responses-control
```

It does **not** mount production databases. Gateway state is in memory.
The wrapper includes `--use-env-proxy` when the live `NODE_USE_ENV_PROXY` is `1`.
With Node 24, merely loading that variable through `--env-file` did not activate
proxying in the verified R760 probe; without the flag xAI timed out while the
same request with the flag reached the upstream. Keep this startup flag aligned
with production rather than treating such a timeout as a provider outage.
The isolated preflight process uses root to read the root-owned 0600 candidate;
the production Gateway user is unchanged. It tests
both cloud models with MAX and real xAI image requests. It records
`staging/$REV/vision-preflight.log` and `preflight-proof.json` (image ID, candidate
SHA-256 and exit code), with a bounded runtime and task-container cleanup. Require
exit code 0, two successful routing/content checks and no pending reservations.
Do not run preflight with the original live env or an independently reconstructed
registry. Do not source the env in a shell; `node --env-file` loads it as data.

## 4. Deploy the checked candidate

```bash
python3 -B "$RELEASE/scripts/ops/deploy-goldencode-d-r760.py" "$REV" --enable-vision
```

Retain the 30-second continuous natural-idle window. The operator explicitly
confirmed this requirement on 2026-10-28; prolonged busy traffic does not authorize
shortening it. The temporary five-second option was withdrawn after that decision.

The shared `gateway-drain.py` requires a 30-second natural idle window with both active requests and
background work at zero. Admission stays open during this wait; if no window is
available within 15 minutes, the release stops without changing production.
`--drain-without-idle` was removed after the 2026-10-28 outage: it closed model and
login admission for several minutes while one long request finished. Do not use an
older script to bypass this guard. This also protects the generic release and
component cutover callers. After the idle check, drain defaults to and is capped at
30 seconds (including older callers passing 180/900, with a stderr warning naming
the requested and effective values); a race with new work must
resume the pinned old instance and fail the
release, not cancel that work or recreate the service. This single-container
procedure still has a short cutover interruption; it is not a zero-downtime rollout.
Record public health throughout cutover as required by the deployment runbook.

The script regenerates the candidate from the current live env and requires
**byte-for-byte equality** with `$CANDIDATE` before changing production. It verifies
the pinned preparation state, replaces only Gateway, checks other containers,
protected files, ports, DB integrity and bounded public convergence, and updates
current/previous. Failure after mutation restores the saved env/image and checks
public convergence; inspect the protected deployment logs if rollback fails.
Do not use the legacy add-model mode without `--enable-vision` for this workflow.

## 5. Verify the public endpoint and cleanup

```bash
SMOKE_RC=0
docker exec codex_gateway_r760-gateway-1 \
  node /app/scripts/ops/goldencode-d-public-smoke.mjs --vision || SMOKE_RC=$?
docker cp codex_gateway_r760-gateway-1:/tmp/goldencode-d-public-smoke.json \
  "$STAGE/public-smoke.json"
docker exec codex_gateway_r760-gateway-1 node -e \
  "require('fs').unlinkSync('/tmp/goldencode-d-public-smoke.json')"
test "$SMOKE_RC" -eq 0
```

Require all six public checks: D Chat/Responses, each streaming and nonstreaming;
GLM image MAX; D text MAX. Verify image content, runtime attribution, complete
stream terminals, final ledger usage and `cleanup`: disabled synthetic subject,
revoked credentials (public 401), cancelled entitlement, deprecated plan and zero
pending reservations. Audit rows remain. If smoke fails, still copy its report and
verify cleanup before diagnosing; do not blindly repeat it or claim rollout success.
Finish with exact live revision/current/previous checks, health/restarts/ports,
SQLite integrity/FKs, sanitized logs, then update system status and a release receipt.

## Full TianKuan switch and repeat-image telemetry (2026-11-05)

For the authorized complete replacement, add `--tiankuan` to both candidate preparation
and preflight. This changes **both** cloud vision routes to TianKuan
`deepseek-v4.1-flash`, preserving text routes, reasoning policy and limits. Build with
`deploy/r760-clinical.Dockerfile`, which installs `tiankuan-vision-smoke.mjs` and its
document fixture. The TianKuan preflight requires all 16 checks. The legacy deployment
helper above only implements the older xAI copy; use the reviewed release-specific
cutover with `prepare_env(original_env, tiankuan=True)` and exact candidate equality.
Retain the 30-second natural-idle gate and bounded drain/rollback procedure.
Public verification runs `tiankuan-vision-smoke.mjs --public`; it checks both API forms,
streaming, history, tool continuation, token accounting and persisted image fingerprints.
The document fixture is a deployment contract test, not broad model-quality proof;
the earlier seven-segment 8264 fixture produced occasional OCR/tool-argument errors.

Repeat-image statistics extend existing `vision_observation_json` and attempt JSON;
no database migration is needed. Fingerprints are HMAC-scoped to subject and client
session (request scope if missing), never raw image bytes, URLs or object paths.
The default stable key is purpose-derived from the protected R2 credential; optional
`GATEWAY_VISION_OBSERVATION_HMAC_SECRET` overrides it (minimum 32 characters).
Without either, a random process key is explicitly marked; key generations are never
joined. R2 credential rotation therefore starts a new statistics generation.
Renewed signatures match only within the configured immutable R2 asset namespace;
arbitrary URL queries are retained. Inline and URL forms, reuploads, and recompressed
images are not joined. Rejected/large requests have explicit scan/omission counts.

On the R760 host, query the mounted Gateway database read-only:

```bash
python3 -B "$RELEASE/scripts/ops/vision-repeat-stats.py" \
  --db /data/docker/volumes/codex_gateway_r760_gateway_state/_data/gateway.db \
  --since '2026-11-05T00:00:00Z'
```

Resolve the actual `/var/lib/codex-gateway` mount source from the live container before
using the example database path. The report separates internal duplicates, repeated
identities across requests, same/different client message IDs, failure retries and
contract recovery attempts. Attempt image counts describe attempted input, not proof
of upload or billing. Token totals cover entire image-bearing requests. First-seen is
limited to the query window; old events cannot retrospectively gain fingerprints.
Same-message repeats can be valid tool continuations; repetition alone is not waste.
No image payload removal or deduplication is enabled by this telemetry change.
