# Runtime configuration change matrix

Last updated: 2026-07-29

This document distinguishes source/image changes, startup-only container
configuration and already-online database policy. It is intended to prevent a
simple policy update from being treated as a full application rebuild when the
running code already supports the requested value.

## Current mechanics

The Gateway reads its environment and constructs providers, model registries,
rate limiters and the Research store during startup. The Research Worker and
maintenance processes each call `loadResearchWorkerConfig()` once during
startup. There is no application `SIGHUP` or file-watcher reload contract.

Consequently:

- changing source code, dependencies, the medical Skill bundle, the compiled
  identity registry or another file copied by `Dockerfile` requires a new
  image;
- changing an `env_file`, Compose environment value, secret mount, volume,
  resource limit or health check does not require an image build, but does
  require `docker compose up -d --no-deps --force-recreate <service>` for each
  affected service; `docker compose restart` does not load changed environment;
- database-backed credential, plan and entitlement changes are read on
  subsequent requests and do not require a container restart.

The repository currently references about 122 Gateway environment names and
84 Worker/maintenance environment names. These counts include compatibility
and optional provider settings; they are evidence of startup configuration
surface, not a recommendation to make every value dynamically writable.

## Change matrix

| Configuration group | Current source and affected process | Current operation | Recommended direction |
| --- | --- | --- | --- |
| User state, credential label/scope/expiry, RPM/RPD/concurrency, credential model allowlist | Gateway SQLite; read during authentication | Online through audited admin/billing commands; no restart | Keep online and database-backed |
| Plan, entitlement, capability allowlist and token policy | Gateway SQLite; resolved on each protected request | Online through audited plan/entitlement/billing paths; no restart | Keep online and database-backed |
| Billing admin tokens and unified-key records | Gateway SQLite | Online issue/revoke/rotate; no restart | Keep online and database-backed |
| Upstream account health, cooldown and sticky-session state | Gateway SQLite runtime state | Updated online by routing/runtime logic | Keep online; do not confuse it with pool membership configuration |
| Research daily runs, rolling unique doctors, active brief, global queue and `needs_input` limits | API and Worker env; store captures an immutable limits object at startup | Today: no image rebuild when the value is already supported, but recreate all Research-aware containers to maintain parity | Highest-priority online-policy candidate; make Gateway the single admission authority and expose a policy version to Worker/maintenance |
| Research control-plane read/mutation RPM | Gateway startup-created in-process limiter | Recreate Gateway | Candidate only after a persistent/versioned rate policy is implemented; avoid a partial hot reload that leaves old limiter state ambiguous |
| Public model registry, aliases, context/output ceilings and request timeouts | Gateway env/JSON loaded at startup | Recreate Gateway; rebuild only when parser/code changes | Keep restart-gated for now; a future versioned routing policy may move safe non-secret weights/ceilings online |
| Upstream pool membership, endpoints, concurrency, model and reasoning defaults | Gateway pool JSON/env loaded at startup | Recreate the affected public or internal LLM Gateway | Keep restart-gated until atomic pool validation and rollback exist |
| Provider/API key files and encryption/auth secrets | Secret/env read during startup and retained by adapters | Rotate protected file, then recreate affected service | Keep restart-gated; do not expose secrets through a general online policy API |
| Research provider, adapter, LLM and wall-clock budgets | Worker env loaded once | Recreate Worker; maintenance also recreates today because both share one config loader | Keep release-gated because these values affect cancellation, cost, evidence collection and the 10-minute contract |
| Prompt, validation, workflow, prose/review policy and medical Skill bundle | Source or files copied into image, bound to versions and digests | Build/test/replay, new image and controlled deployment | Must remain immutable and release-gated; never make these casual online switches |
| Official identity registry | Versioned file copied into image and validated at Gateway startup | Build a reviewed release and recreate Gateway | Possible later as a signed/versioned reviewed registry with digest and atomic activation; not as an unrestricted admin edit |
| Backup interval/retention, TTLs, disk/storage floors and cleanup batches | Worker/maintenance env; some storage/backup admission checks also run in Gateway | Recreate affected services | Keep restart-gated by default because mistakes can delete data or disable fail-closed admission; split process-specific values to reduce restart scope |
| Service enable flags, ports, volumes, Docker CPU/memory/PID limits and health checks | Compose | Recreate affected container | Keep Compose-controlled; these are lifecycle/infrastructure settings |
| Nginx, public ports, firewall, Docker daemon and other host services | Host operations outside application config | Explicit maintenance procedure | Never move into the application hot-update path |

## Recommended lightweight path

### Immediate operational improvement

For an env-only change already understood by the deployed code:

1. create a versioned protected-config revision and validate it without
   printing values;
2. reuse the exact existing image digest rather than invoking `compose build`;
3. back up affected state and record the prior config revision;
4. recreate only the services that actually consume the changed value;
5. verify loaded sanitized values, health, restart count and public behavior;
6. roll back by recreating those services with the prior config revision.

The 2026-07-29 unlimited-doctor release still needed a one-time image build
because the old code rejected `0`. Future movement between `0` and a positive
integer does not require rebuilding that image.

### P0: database-backed Research admission policy

Move only operational admission values into a strict SQLite policy table. The
active row should include a monotonically increasing version, daily-run limit,
nullable rolling unique-doctor limit, active-brief/queue/`needs_input` limits,
activation time, operator identity, reason, checksum and previous version.

Required safety contract:

- no implicit default: a missing, malformed or unsupported active policy makes
  create admission fail closed;
- policy activation and audit event commit in one transaction;
- `createRun()` reads the active version inside the same immediate transaction
  that charges admission, so one request cannot mix versions;
- audited `show`, `validate`, `activate` and `rollback` commands expose no
  secrets;
- readiness publishes only the loaded policy version/checksum;
- concurrency tests prove atomic cutover and exact-once quota charging;
- the initial migration mechanically imports the validated env values and does
  not change policy by itself.

Gateway should be the sole writer and admission decision-maker. Worker,
maintenance and the internal LLM Gateway do not need duplicate quota values;
they should observe a version for diagnostics rather than block startup on a
separate copy. This reduces a normal admission-policy change from four
container recreations to one audited online transaction.

### P1/P2 candidates

- P1: separate Worker execution policy from maintenance scheduling/storage
  policy so changing a backup interval does not restart generation and changing
  an LLM budget does not restart maintenance.
- P1: add versioned, non-secret provider-routing configuration only after pool
  validation, health-drain and rollback semantics exist.
- P2: consider a reviewed identity-registry activation path with signed digest,
  diff review and acceptance evidence.

Secrets, medical Skill text, evidence/identity/quality gates, destructive
retention settings, host networking and public routing should remain outside a
general online configuration API.
