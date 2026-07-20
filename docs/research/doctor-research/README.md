# Doctor Research

This directory contains the production Doctor Research API guide, deployment
runbooks, and historical implementation records. The public production target
is the Azure VM deployment at `https://gw.instmarket.com.au`; CN1 is a
separate loopback-only GoldenCode environment and is not a Doctor Research
deployment target.

## Current production contract

The medical team's authoritative business source is
`docs/research/采访skill/`. The service does not edit or maintain a fork of
those files. The production image copies the source directory byte-for-byte,
loads exactly these four files as a bounded read-only bundle, and records a
SHA-256 bundle digest at Worker startup and in every run's first checkpoint:

1. `doctor-research-query/SKILL.md`
2. `literature-review/SKILL.md`
3. `citation-management/SKILL.md`
4. `scientific-writing/SKILL.md`

The Worker applies the parent Skill and the three child Skills in their
declared order. Platform code supplies the safe adapters, closed evidence set,
JSON contract, budgets, citation/number/evidence-grade gates, artifact
rendering, and mandatory peer-review pass. It never executes Python or shell
scripts from the Skill tree. Medical-team updates therefore require replacing
the source folder, rebuilding the immutable image, reviewing the new bundle
digest, and rerunning the regression and live E2E gates; no business-text
"optimization" should be made in this repository unless correcting an
unambiguous error agreed with the medical team.

The request field remains `"mode": "brief"` for v1 wire compatibility. That
label does not waive the medical Skill's current 6000-character review and
40-reference search target: production now enforces the length floor, searches
up to 40 verified field references, and reports the actual count and evidence
boundary when fewer relevant verified records are available.

## Contents

- `api-service-design.md`: reviewed API and implementation design.
- `controlled-beta-runbook.md`: isolated staging bootstrap, smoke, negative
  tests, shutdown and production gate.
- `controlled-beta-evidence.md`: requirement-to-code/test/runtime evidence and
  the explicit external live-E2E gap.
- `production-runbook.md`: default-closed production overlay, bootstrap,
  enablement, E2E and rollback sequence.
- `phase0.5-compatibility.md`: pinned rollback image and capability
  compatibility gate.
- `../采访skill/`: authoritative medical-team Skill bundle used by production.
- `doctor-research-query/`: superseded adapted design copy retained only for
  historical comparison; it is not loaded by production.
- `doctor-research-query/doctor-research-query.skill`: archive rebuilt from
  and byte-matched to the reviewed adjacent `SKILL.md`.
- `doctor-research-query/samples/known-invalid/`: quarantined historical
  samples and the superseded Skill archive that must never be discovered as
  golden fixtures or executable inputs.

The production Worker uses frozen execution contract `1.6.23` together with the
hashed medical-team bundle. It loads only the four allowlisted `SKILL.md`
files; `.skill` archives, samples, assets, references, and scripts are not
executed or dynamically discovered. The source files remain byte-exact and
read-only. At prompt time, the Worker mechanically retains the parent
business rules/output templates and the child Skills' workflow, evidence,
citation, writing, and quality sections, while omitting packaging-only
examples, install commands, optional visual/PDF deliverables, external-tool
instructions, resources, dependencies, and assets outside this four-text-file
API. The full bundle hash and derived projection hash are both recorded.

For latency, execution `1.6.23` splits synthesis into three bounded independent
fragments, routes them with separate internal session affinity, and starts at
most two concurrently against isolated direct-GLM capacity. The third starts
as soon as one slot settles. If provider admission temporarily exposes only
one slot, the scheduler reduces concurrency before continuing. The verified
doctor profile is projected deterministically from exact official-source
excerpts, so the model does not receive or regenerate that profile. A final
call performs only the medical Skill's concise peer-review self-check and
returns bounded exact-text corrections instead of rewriting the complete
article.

The Worker projects only the required fields from model fragment envelopes and
accepts a closing fragment returned directly as bounded Markdown. This
transport normalization does not waive any content check: every fragment is
checked against the medical Skill's target language and exact section/length
contract before assembly. The middle shard always supplies four substantive
topic sections, and the closing shard may add one evidence-supported topic,
followed by one evidence-synthesis/controversy section, one
limitations/outlook section, and one conclusion. Empty sections,
duplicate substantive paragraphs, unbalanced delimiters, truncated numeric
prose, and low-information or duplicated core-evidence fields are rejected.

If exactly one synthesis shard encounters a retryable transport failure, an
unusable envelope, or a medical-Skill contract violation, execution may spend
one additional call to retry only that shard inside the same hard deadline.
Short-lived `429` admission responses are retried within the same recorded
stage attempt. Numeric safety normalization removes the complete unsupported
sentence rather than clipping a comma-delimited fragment, and deterministic
evidence-boundary supplements are never repeated merely to reach the length
floor. The Worker then assembles the fragments, renders the 3-8-paper core
evidence table from verified publication metadata and abstracts, adds verified
identity, sources, all reference metadata, search report, coverage and quality
fields, and validates the unchanged public result schema. Up to 40 verified
references, the 6000-character floor, and the mandatory peer-review attempt
remain in force.

The peer-review model is always attempted. If that bounded call times out or
returns an unusable patch envelope, the Worker records a transparent warning
and applies the same deterministic safety, citation, number, evidence-grade
and length gates to the unpatched assembled draft. It never treats an
unparseable peer-review response as approval.

The API has a non-negotiable ten-minute wall-clock ceiling measured from run
creation, including queue wait and retries. Production is configured with a
570-second Worker deadline and a 240-second per-model-call timeout so terminal
state can be observed before the client reaches its 600-second wait bound.
Work that cannot close its evidence and output contracts in that window fails
with `deadline_exceeded`; the service never publishes a partial four-file
result.

Production currently enables only the Aliyun direct GLM member with capacity
for the three synthesis calls. Qianfan and Tencent remain explicit disabled
configuration entries for reversible operator rollback; repeated live
validation showed that a required long fragment could otherwise reach the
240-second call limit without a response.

## API quick reference

All routes require a Doctor Research credential as
`Authorization: Bearer <key>`. Create also requires a unique, reusable
`Idempotency-Key`.

```http
POST /gateway/research/v1/doctor-runs
Authorization: Bearer <key>
Idempotency-Key: research:<stable-client-id>
Content-Type: application/json

{
  "doctor": {
    "name": "陆清声",
    "hospital": "海军军医大学第一附属医院",
    "department": "血管外科",
    "official_profile_urls": [
      "https://www.carm.org.cn/gywm/fzjg/zywyh/art/2025/art_8451aeed0bc14fbab6541f37c08b5195.html"
    ],
    "literature_identity": {
      "name": "Lu Qingsheng",
      "hospital": "Changhai Hospital",
      "department": "Vascular Surgery"
    }
  },
  "mode": "brief",
  "language": "zh-CN",
  "options": {
    "publication_years": 5,
    "citation_style": "vancouver"
  }
}
```

Poll `GET /gateway/research/v1/doctor-runs/{run_id}` until `succeeded`, then
read `GET /gateway/research/v1/doctor-runs/{run_id}/result`. Download each
manifest entry through its authenticated `download_url`; verify both
`size_bytes` and `sha256`. The supported end-user client is
`scripts/doctor-research-demo.py`, documented below. Its default and maximum
polling window is 600 seconds, matching the public API ceiling.

## Python API demo

`scripts/doctor-research-demo.py` is the dependency-free end-user example for
the asynchronous production API. It:

- reads the bearer credential from a private file or
  `DOCTOR_RESEARCH_API_KEY`, never from a command-line token argument;
- sends create with a reusable `Idempotency-Key`, polls bounded status, and
  stops without guessing if human identity selection is required;
- refuses redirects and non-loopback plain HTTP so the bearer credential is
  not forwarded to an untrusted endpoint;
- validates the exact four-kind manifest, downloads through authenticated
  same-origin paths, and checks content type, length and SHA-256;
- preserves safe localized server filenames such as
  `陆清声_基础信息与研究方向.md`;
- accepts a separately verified PubMed literature identity for bilingual
  profiles while keeping the supplied Chinese display identity and filenames;
- atomically publishes a run directory containing exactly three Markdown
  files and one five-line text file. Partial downloads remain unpublished and
  are removed.

Example:

```powershell
python scripts/doctor-research-demo.py `
  --doctor-name "陆清声" `
  --hospital "海军军医大学第一附属医院" `
  --department "血管外科" `
  --literature-name "Lu Qingsheng" `
  --literature-hospital "Changhai Hospital" `
  --literature-department "Vascular Surgery" `
  --title "教授、主任医师" `
  --city "上海" `
  --official-profile-url "https://www.carm.org.cn/gywm/fzjg/zywyh/art/2025/art_8451aeed0bc14fbab6541f37c08b5195.html" `
  --official-profile-url "https://www.qk.sjtu.edu.cn/jscp/CN/10.16139/j.1007-9610.2022.04.008" `
  --api-key-file "C:\private\doctor-research.key" `
  --output-dir ".\doctor-research-output"
```

The API key must belong to a named user on the dedicated Doctor Research beta
plan. On POSIX, the key file must be mode `0600` or stricter. If create returns
an uncertain network outcome, rerun with the `idempotency_key` printed before
the POST instead of generating a second run.

The three `--literature-*` values are optional as a group. When supplied, an
allowlisted official page must place the display name and literature name in
the same bounded identity block, and each retained PubMed record must
independently attribute both the literature hospital and department to the
matching author. A separate allowlisted official profile URL may provide the
doctor's position, expertise and research-direction evidence. The run fails
closed if the identity bridge, publication attribution or required profile
evidence is missing.

## Historical Phase 0 status

The following records describe the earlier Phase 0 baseline and are retained
for audit history; they do not override the current production contract above.
At that time, the repository-path entry gate reported:

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
  direct official-source retrieval and optional Brave search over an explicit
  domain allowlist;
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
- blocks raw or entity-encoded HTML, Markdown links/images, URLs, dangerous
  URI schemes, control bytes and bidirectional text controls in all
  model-controlled narrative fields; the answers artifact renders only
  server-verified source links and IDs;
- rejects public proxies and pins allowlisted official-site TLS connections
  to DNS results that exclude special-purpose IPv4, IPv6, mapped and
  translation ranges.

Validation after the controlled-beta hardening pass:

- clean `npm ci` lockfile install;
- `npm run build`;
- `npm test` (32 test files, 475 tests);
- `python -m unittest discover -s tests -p "test_*.py"` (11 tests), including
  the non-root Docker workspace readability contract;
- syntax checks for the beta smoke and both container health scripts;
- staging Compose parse and security assertions;
- `npm audit --omit=dev` (0 production vulnerabilities);
- `git diff --check`.

The live staging closure on 2026-07-18 then:

- selected only the direct `goldencode`/GLM-5.2 pool with reasoning effort
  `low`; Max, Codex, OpenRouter, public proxies, Google Scholar and dynamic
  Skill execution were not used;
- completed a real
  `POST -> heartbeat/lease -> PubMed/Crossref/official source -> structured
  LLM -> validation -> succeeded -> result -> four downloads` run;
- verified exactly three Markdown files and one five-line text file, with all
  sizes and SHA-256 values equal to the stored manifest;
- passed live cancellation, stale-heartbeat `503`, foreign-subject `404`,
  encoded traversal rejection and isolated four-artifact backup/restore;
- passed GoldenCode model, Chat Completions and Responses compatibility smoke;
- found no doctor input, Prompt, source body, artifact body or credential
  literal in Research audit parameters or container logs.

This is still not a production enablement. Production flags and credentials
remain unchanged and disabled. The production ORCID terms/credential decision,
human quality approval, encrypted backup/restore target and approved
production limits/RPO/RTO are still required. The separate Phase 0.5
rollback-compatibility gate is pinned in `phase0.5-compatibility.md`.
