# MedEvidence Imaging v1 — Gateway

Implementation: `apps/gateway/src/imaging/`. Public prefix `/gateway/imaging/v1`;
private prefix `/internal/imaging/v1`. Profile `radar-abdominal-research-v1`.
This runbook describes implementation and activation, not proof of deployment or
real CT acceptance. Record those separately with the tested commit and actual IDs.

Contract clarification proposed to the Desktop/star owner: current star returns
ineligible series without `shape_xyz` / `spacing_xyz`. Gateway preserves these
omissions only when `eligible:false`; eligible series require both valid vectors.
It never fills in geometry. Public timestamps follow star's Unix seconds. The
pending GPU-duration addition remains outside v1; the local field stays NULL.

## Configuration and pilot admission

The default is **off**. `GET /capabilities` still requires the existing Gateway
credential and returns `available:false`; all other imaging operations return 503.
Do not add RADAR to the public chat model registry or fall back to another model.

Enable only after controlled delivery and verification of the star certificate,
service credential, runtime acceptance and explicit Subject allowlist:

| Environment variable | Value / default |
| --- | --- |
| `GATEWAY_IMAGING_MODE` | `off` (default) or `pilot` |
| `GATEWAY_IMAGING_SUBJECT_IDS` | Comma-separated authoritative Subject IDs; empty permits nobody; no wildcard |
| `GATEWAY_IMAGING_SQLITE_PATH` | Required independent persistent path, e.g. `/var/lib/codex-gateway/imaging/control.db` |
| `GATEWAY_IMAGING_STAR_URL` | Final verified HTTPS endpoint; proposed `https://192.168.77.7:8786/internal/imaging/v1` |
| `GATEWAY_IMAGING_STAR_CA_FILE` | Read-only private mount of the trusted CA/server certificate |
| `GATEWAY_IMAGING_STAR_TOKEN_FILE` | Read-only private mount of the dedicated service bearer token |
| `GATEWAY_IMAGING_DAILY_JOBS` | 10 admitted job submissions per Subject per UTC day |
| `GATEWAY_IMAGING_ACTIVE_JOBS` | 1 pending/queued/executing/cancelling job per Subject |
| `GATEWAY_IMAGING_DAILY_STUDIES` | 20 study submissions per Subject per UTC day |
| `GATEWAY_IMAGING_ACTIVE_STUDIES` | 4 uploading/validating/pending studies per Subject |
| `GATEWAY_IMAGING_CONTROL_TIMEOUT_MS` | 15000, maximum 60000 |
| `GATEWAY_IMAGING_TRANSFER_TIMEOUT_MS` | 300000 maximum/default; public transfer route maximum is also 300000 |

Bad/missing imaging configuration disables imaging without preventing Gateway
startup. Never print config values, service tokens or client keys. The SQLite
directory is created with mode 0700 and its database with 0600; validate the
mounted directory ownership and WAL/SHM permissions under the runtime UID.
Never point this component at `gateway.db` or `client-events.db`.

Runtime HTTP admission is separate from chat: 240 requests per Subject per UTC
minute, four concurrent requests per Subject/eight globally, and two transfers
per Subject/four globally. It is process-local protection, not a billing ledger.
The 300-second transfer ceiling accommodates the Desktop acceptance link at
about 67 KB/s, where an 8 MiB chunk already takes more than 120 seconds.
Job/study submission allowances and ambiguous reservations persist across restart.
Rejected/failed submissions can consume the conservative daily submission
allowance; replays never consume a second allowance. No token deduction or new
charging rule is introduced. `gpu_seconds` is nullable and remains NULL until a
real, agreed star measurement is available; wall time is not a substitute.

## Identity, persistence and recovery

- The existing credential/unified-key authentication hook resolves the Subject.
  The session is an association only. All reads/writes use `(Subject, resource)`;
  unknown, other-owner, expired and revoked resources return 404.
- Private owner is SHA-256 of `medevidence-imaging-v1:subject:<subject-id>`.
  Client internal headers are discarded; the HTTPS client constructs all private
  headers and uses only its dedicated service token. Session associations are
  hashed with the owner reference before persistence or transmission; authorized
  diagnostics can derive the same hash from a known session ID. Arbitrary client
  session strings never enter the control database or star.
- Exact allowed JSON fields are persisted, never filenames, CT bytes/base64,
  arbitrary URLs, model paths or commands. Idempotency keys are stored as hashes.
  A canonical request fingerprint includes the operation kind; changing content
  or operation under the same Subject/key returns 409.
- Submission intent commits before network I/O. Ambiguous creates retain their
  allowance and replay **the same request and private key**, including after
  Gateway restart. They never create another inference attempt. Definite 429
  responses require an explicit client retry and fresh concurrency admission.
- A bounded recovery loop reconciles pending submissions, known resource IDs and
  durable cancel/delete intent every two seconds, eight records per sweep. This
  is a single Gateway process and a single star executor, not distributed leases.
- Client disconnection does not cancel an accepted job. Cancellation uses the
  explicit endpoint. A network failure yields retryable 503 without inventing a
  terminal job result. star's `worker_restarted` result remains authoritative.
- Delete records revocation before contacting star, immediately denying study,
  job and artifact reads. star performs cancellation and physical cleanup;
  Gateway retries the durable request and reconciles revoked job capacity.
- Study/file access lasts at most 24h. Control/idempotency tombstones and audit
  retain 30 days after their relevant timestamp, removed in bounded batches.
  Star owns physical file deletion. Backups have their own controlled retention.

## Streaming and result access

Upload uses an encapsulated binary parser and backpressured Node streams, with
exact Content-Length and SHA-256 checks. The main process never buffers a CT
file or upload chunk. Each request is at most 8 MiB; total input is at most
512 MiB. Only small JSON responses are buffered, capped at 1 MiB. Input parsing,
ZIP/decompression/geometry limits and GPU execution are star responsibilities.

TLS verifies both the supplied trust chain and the endpoint hostname/IP. HTTP,
redirects and client-supplied destination URLs are refused. No certificate bypass
is available. Downloads require the completed job's immutable, validated manifest,
safe relative paths, matching length/hash headers and streaming hash validation.
A late mismatch terminates the stream; the client must verify bytes before
exposing its local file. No public URL or unrestricted private file proxy exists.

Application request logging redacts the whole imaging route/query even on auth
failure and unmatched paths. Imaging requests skip chat usage/observation and
token-reservation housekeeping. The independent imaging audit records route
templates, opaque IDs, Subject, request ID, status and sanitized error codes.

The existing R760 edge already disables proxy request/response buffering.
`config/nginx/imaging-location.conf` additionally isolates imaging timeouts and
suppresses arbitrary client paths in ordinary Nginx access/error logs. Its
installation is an explicit Nginx change: back up the current vhost, review the
include inside only the GoldenCode server block, run `nginx -t`, then reload.
Do not replace other routes or change ports/TLS material. Keep this include
through a program rollback so imaging URLs remain redacted.

## Release and acceptance

Follow `container-deploy.md` and the codex-gateway-ops skill: fetch and reconcile
main/origin/main/deployed revision, scoped commit only, immutable artifact,
verified backup of affected state/config, exact live Compose overlays, Gateway
service only, health/restarts and read-only SQLite integrity/FK verification.
The source revision does not contain secrets. Initially deploy with mode off.
Pilot activation requires the protected star files and a named test Subject;
temporary test credentials must be revoked and test resources deleted afterwards.

Local automated coverage:

```powershell
npm run typecheck
node node_modules/vitest/vitest.mjs run apps/gateway/src/imaging
```

Before claiming live completion, record:

1. Actual R760→star certificate validation and private authentication with no user
   credential forwarding; certificate/credential delivery references only.
2. A real public/deidentified CT upload, hash, study ID, selected series, job ID,
   polling states, complete result manifest and verified downloaded hashes.
3. Cross-Subject 404, changed idempotency 409, interrupted upload resume, explicit
   cancel, expiry and ambiguous-response/restart recovery evidence.
4. The Desktop ordinary-chat tool path that produces the offline HTML, opens it
   and checks its real bundle/provenance/previews. Mock tests and health 200 are
   not this acceptance.
5. Login/ordinary conversation regression, audit/config redaction, cleanup and
   the remaining `gpu_seconds` star contract addition. Do not estimate the value.
