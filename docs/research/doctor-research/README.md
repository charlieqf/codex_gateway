# Doctor Research

This directory is the ASCII-only home for the first-party Doctor Research
design and Phase 0 implementation material.

## Contents

- `api-service-design.md`: reviewed API and implementation design.
- `controlled-beta-runbook.md`: isolated staging bootstrap, smoke, negative
  tests, shutdown and production gate.
- `doctor-research-query/`: first-party source Skill retained as design input.
- `doctor-research-query/doctor-research-query.skill`: archive rebuilt from
  and byte-matched to the reviewed adjacent `SKILL.md`.
- `doctor-research-query/samples/known-invalid/`: quarantined historical
  samples and the superseded Skill archive that must never be discovered as
  golden fixtures or executable inputs.

The production Worker must use a reviewed, versioned `SkillDefinition`; it must
not load `SKILL.md`, `.skill` archives, samples, or scripts dynamically from
this documentation tree.

## Phase 0 status

The repository-path entry gate is complete:

- the former `docs/采访skill/` tree has been removed;
- every repository path in this migrated tree is ASCII-only;
- known-invalid samples are quarantined;
- third-party snapshots live separately under
  `docs/reference/skills/k-dense/`.

The offline engineering foundation is now tracked as Phase 0A and is complete.
Phase 0B evidence validation remains open; see `phase0-readiness.md`.

## Implementation log

The first Phase 0 foundation batch was completed on 2026-07-17:

- Gateway schema migration `22` adds the nullable
  `access_credentials.allowed_public_models_json` column and database guards
  against invalid, empty, duplicate, or malformed model ID arrays.
- Credential issuance validates explicit allowlists against a caller-supplied
  canonical public-model registry; existing credentials retain `NULL = all
  enabled public models`.
- `/v1/chat/completions` enforces the allowlist on the resolved canonical
  public model before reasoning, entitlement, runtime, or provider selection.
  Credential rotation preserves the restriction.
- The frozen Research `GatewayErrorCode` and `LimitKind` additions,
  `GatewayResponseDialect`, `researchRouteConfig`, Research error envelope,
  and auth-hook dialect selection are implemented.
- `npm run build` and the full `npm test` suite passed after this batch
  (24 test files, 349 tests).

The second Phase 0 foundation batch was completed on 2026-07-17:

- persisted plan and entitlement policies now use a forward-compatible
  capability decoder that preserves unknown strings; at that batch the strict
  writer still rejected `doctor_research` pending the later feature-version
  change recorded below;
- a separate Research SQLite connection, migration table, initial schema,
  admission ledger, idempotency replay/tombstone handling, subject isolation,
  append-only-with-retention audit, and create/list/get Store contract are
  implemented;
- opt-in Fastify create/list/get route skeletons implement the Research error
  dialect, entitlement capability checks, strict request fields, canonical
  hashing, exact idempotency replay, keyset pagination, quota errors, subject
  isolation, and fail-closed logical TTL behavior;
- terminal point reads return `410 run_expired`; list filtering applies the
  same logical TTL rules, including delayed
  `needs_input -> cancelled/identity_selection_timeout` reconciliation;
- credential public-model restrictions are enforced on chat, responses, and
  both native sessions mutations. CLI issue/update accepts
  `--allowed-public-models`, aliases are canonicalized against the configured
  registry, and both CLI and billing-admin rotations preserve restrictions;
- read-only admin diagnostics tolerate pre-migration-22 databases, both quota
  dashboard label implementations include Research limits, and Research 503
  envelopes retain retry metadata;
- daily health checks derive loopback bindings from the configured health URL,
  preserve Windows 8.3 paths containing `~`, and share deployment/redaction
  constants with the other operational scripts.

Validation after the second batch:

- `npm run build`;
- `npm test` (26 test files, 365 tests);
- `python -m unittest tests/test_check_daily_usage_health.py` (6 tests);
- Python syntax compilation for the three operational entry points and their
  shared module;
- `git diff --check` (only an existing CRLF normalization warning).

The third Phase 0 offline-contract batch was completed on 2026-07-17:

- Research schema migration `2` upgrades the initial artifact table without
  rewriting migration `1`; both fresh databases and already-recorded v1
  databases receive distinct ASCII/UTF-8 filenames and the frozen four-kind
  constraint;
- the Store now executes lease acquire/renew/takeover, generation fencing,
  checkpoint writes, active-time accounting, current-owner cancellation,
  cancel-versus-success arbitration, TTL reconciliation, heartbeat process
  replacement/staleness, and idempotency response scrubbing/tombstone cleanup;
- create, list, point-read, cancel, and identity-selection routes are
  subject-scoped and use the Research dialect. Identity selection supports
  exact replay, reject/selection state contracts, candidate redaction,
  active-brief re-admission, and subject-local identity alias merging;
- `@codex-gateway/research-agent` freezes the production
  `SkillDefinition`, `doctor_research_run.v1` receipt and
  `doctor_research_result.v1` result schemas, unique-JSON/AJV validation,
  one-repair metrics, frozen fake adapters, deterministic Unicode/word and
  citation counters, claim/reference closure checks, prompt-injection
  negatives, four-text rendering, and atomic file/crash-recovery harnesses;
- the offline backup harness uses SQLite Online Backup, derives its immutable
  artifact manifest from the snapshot, and verifies database hash, integrity,
  foreign keys, artifact rows, sizes and hashes. A parameterized disk probe
  reports free-byte, free-percent and Research-byte admission failures without
  pretending unapproved production thresholds are final;
- successful completion atomically commits one result, exactly four artifact
  metadata rows, terminal state, active time, and audit under the current
  fencing token. A cancellation request or old generation cannot leave
  partial result/artifact rows;
- the first-party source Skill now explicitly treats external content as
  untrusted data. Unverified identifiers cannot enter confirmed output, and
  full-mode length/reference targets require code validation rather than model
  self-report. Legacy natural-language evals are explicitly excluded from CI
  and Phase 0 fixture counts.

Validation after the third batch:

- `npm run build`;
- `npm test` (28 test files, 393 tests);
- focused Research contracts across core, Store, Gateway routes, and
  `research-agent`;
- the Skill Creator validator with `PYTHONUTF8=1` on Windows;
- JSON validation proving the legacy eval manifest has no `files: []` and is
  not auto-discoverable.

A 2026-07-18 review follow-up hardened the same offline foundation:

- admin CLI rotation now preserves a stored credential model allowlist without
  revalidating it against the operator shell's current public-model registry;
- create, identity-selection and cancel operations share one idempotency
  resolver and consistently audit replay, conflict and expired outcomes;
- cancel first persists an overdue `needs_input` run as
  `cancelled/identity_selection_timeout`, then returns the current idempotent
  cancelled receipt without rewriting it as `cancelled_by_user`;
- status responses no longer publish fabricated zero-valued statistics before
  real checkpoint counters exist.

Validation after the follow-up:

- `npm run build`;
- focused admin CLI, Research Store and Research route tests (44 tests);
- `npm test` (28 test files, 393 tests);
- `python -m unittest tests/test_check_daily_usage_health.py` (6 tests).

A second 2026-07-18 review follow-up completed the Phase 0A engineering
foundation and corrected existing Gateway regressions:

- production assembly now creates a separate Research SQLite Store only when
  `RESEARCH_API_ENABLED=true`; enabling is fail-closed unless the database
  path, control-plane limits and admission limits are explicitly configured;
- the strict feature-policy writer accepts `doctor_research`, while stored
  policy reads remain forward-compatible;
- every Research route uses an independent subject/credential read or mutation
  limiter before entering the Store. Repeated same-minute admission denials no
  longer amplify retained audit rows;
- the receipt `result_url` now resolves to a subject-scoped, authenticated
  result endpoint;
- native sessions retain model-allowlist enforcement without fabricating
  public-model telemetry;
- corrupt legacy allowlist JSON is read fail-closed as deny-all instead of
  turning authentication or list operations into 500 errors;
- CLI and billing rotations preserve stored allowlists without revalidating
  them against a changing model registry. Legacy billing records with no
  readable Gateway credential keep the historical unrestricted behavior and
  emit an operator warning rather than becoming unrotatable;
- legitimate `content_filter`, reasoning-only and hidden structured-output
  completions no longer become false `502 upstream_empty_response` failures;
- result statistics use persisted values, backup verification reports missing
  or corrupt snapshots as failed checks, path containment has one shared
  implementation, and all three mutating endpoints share the idempotency
  insertion helper.

Validation after the second follow-up:

- `npm run build`;
- focused core, Store, Agent, provider, Research route and Gateway tests
  (9 test files, 263 tests);
- `npm test` (28 test files, 412 tests);
- `python -m unittest tests/test_check_daily_usage_health.py` (6 tests);
- `git diff --check` (only an existing CRLF normalization warning).

The authoritative phased completion matrix is `phase0-readiness.md`.

The controlled-beta implementation batch on 2026-07-18 adds:

- a default-off `research-worker` entry point with startup preflight, ready
  heartbeat, lease renewal/fencing, cancellation, retry/requeue, graceful
  drain and terminal convergence;
- an independently startable maintenance/scheduler process for reconciliation,
  cleanup, storage probes and verified backups; staging Worker readiness
  requires its fresh backup and keeps embedded maintenance disabled;
- bounded first-party PubMed, Crossref and ORCID adapters plus fail-closed
  Brave official-site search over an explicit domain allowlist;
- a Gateway-backed non-streaming LLM client with exact credential/model
  readiness, persistent per-run budgets, unique-JSON/AJV validation and one
  bounded repair;
- atomic immutable publication and authenticated streaming download of
  exactly four hash-verified Markdown/text artifacts;
- separate Research state and backup volumes, loopback-only default-closed
  staging Compose, restrictive Worker runtime settings and a redacted E2E
  smoke script;
- an isolated in-process HTTP E2E covering credential-authenticated POST,
  heartbeat-gated admission, separate Gateway/Worker SQLite connections,
  lease, workflow, success, GET result and four authenticated hash-verified
  artifact downloads.

The final controlled-beta hardening pass also:

- advances the frozen first-party Skill to `1.2.0` /
  `doctor-research-prompt.v2` and rejects queued work carrying any other
  Skill, prompt, input or output version;
- requires hospital and department for beta admission, binds each accepted
  PubMed author to both values in that author's own affiliation, and rejects
  article-level or same-name-only attribution; a single official source must
  also place name, hospital and department in one bounded local text window;
- accepts profile facts only as type-anchored, normalized contiguous excerpts
  from their cited official/ORCID source, rebuilds profile arrays from those
  claims, and rejects unsupported numeric narrative claims;
- persists fenced LLM stage hashes, timings, token counts and Gateway request
  IDs without persisting prompts or source bodies;
- uses Research migrations `3` through `5` for persistent budgets, run-scoped
  source/claim/reference keys and database-fenced maintenance locks, then
  atomically commits the evidence rows and subject-local canonical identity
  mapping with each successful result;
- makes Worker LLM readiness prove that the credential's request and token
  policy covers the configured per-call and per-run budget, rather than only
  checking that non-zero limits exist;
- covers cancellation arriving after the final renewal but before terminal
  commit, repeated evidence IDs across runs, and exactly-four-artifact
  publication in deterministic Worker-loop tests;
- blocks raw HTML, Markdown links/images, URLs and dangerous URI schemes in
  all model-controlled narrative fields; the answers artifact renders only
  server-verified source links and IDs;
- rejects public proxies and pins allowlisted official-site TLS connections
  to DNS results that exclude special-purpose IPv4, IPv6, mapped and
  translation ranges.

Validation after the controlled-beta hardening pass:

- clean `npm ci` lockfile install;
- `npm run build`;
- `npm test` (32 test files, 473 tests);
- `python -m unittest discover -s tests -p "test_*.py"` (8 tests);
- syntax checks for the beta smoke and both container health scripts;
- staging Compose parse and security assertions;
- `npm audit --omit=dev` (0 production vulnerabilities);
- `git diff --check`.

This is still not a production enablement. Production flags and credentials
remain unchanged and disabled. Live staging evidence with approved ORCID,
official-search and LLM credentials, provider/quality approval, rollback
compatibility, encrypted backup/restore and production limits is still
required.
