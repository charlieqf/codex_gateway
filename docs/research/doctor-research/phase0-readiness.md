# Doctor Research Phase 0 readiness

Status as of 2026-07-18:

- **Phase 0A — offline engineering foundation: complete.**
- **Phase 0B — evidence and product validation: incomplete.**
- **Phase 0.5 — release compatibility gate: not started.**
- **Controlled-beta Worker engineering: implemented, live staging evidence pending.**
- **Phase 1 — production readiness and internal brief: not complete.**

The Research feature remains disabled by default. This classification allows
implementation to continue without pretending that unmeasured product quality
or unapproved production settings are safe.

## Phase 0A completed

| Contract | Evidence |
|---|---|
| ASCII repository paths and known-invalid quarantine | `docs/research/doctor-research/` and `samples/known-invalid/` |
| Third-party snapshots are non-executable and isolated | `docs/reference/skills/k-dense/` |
| Credential allowlist, alias normalization and tolerant stored reads | core, Store, CLI and Gateway tests |
| Allowlist enforcement on chat, responses and native sessions | Gateway tests, including null native-session model attribution |
| `doctor_research_run.v1` and `doctor_research_result.v1` | `packages/research-agent/src/contracts.ts` |
| Reviewed immutable `SkillDefinition` and version rule | `packages/research-agent/src/skill-definition.ts` |
| Independent Research SQLite schema and forward migration | Research migrations `1` through `5`, including v1 upgrade, run-scoped evidence-key fixtures and expiring owner-fenced maintenance locks |
| Admission ledger and active-brief database invariant | Store quota and rollback tests |
| Exact create/cancel/identity idempotency and tombstones | replay, conflict, expiry, scrub and reuse tests |
| Lease generation, renewal, takeover and late-write fencing | two-owner fake-clock Store tests |
| Cancel signal versus lease loss and cancel versus success | current-owner and fenced-completion tests |
| Active execution time and `needs_input` timeout reconciliation | fake-clock Store and API tests |
| Worker heartbeat and independent non-reentrant maintenance | process-instance heartbeat, separate maintenance lifecycle, fresh-backup Worker gate, process-local gates and database-fenced maintenance-lock tests |
| Fenced LLM stage request/hash/token accounting | Store and real Worker-loop tests |
| Subject-scoped create/list/get/result/cancel/identity API | Gateway Research route tests |
| Default-off environment assembly | fail-closed `RESEARCH_API_ENABLED` configuration and route assembly tests |
| Grantable `doctor_research` capability | strict writer and stored-decoder tests |
| Independent Research read/mutation limiter | bounded pre-Store route tests with exact `LimitKind` values |
| Frozen fake adapters with `AbortSignal` | `research-agent` adapter tests |
| Prompt-injection isolation | untrusted-source negative fixture and forbidden-fragment check |
| Unique JSON, AJV, semantic closure and one repair | `research-agent` contract tests |
| Deterministic length, reference and citation checks | `research-agent` eval tests |
| Four text renderers and atomic publication recovery | temp-write and post-rename crash tests |
| Snapshot, manifest and disk-admission harnesses | integrity/hash/corruption/missing-snapshot and threshold tests |
| Existing Gateway behavior regression | build and full Vitest suite, including legitimate empty completion cases |

All Phase 0A tests are offline: they use no Azure endpoint, live credential,
live LLM or real-time internet source.

## Controlled-beta engineering implemented

The 2026-07-18 default-off implementation now includes the Worker main loop,
live PubMed/Crossref/ORCID/allowlisted-official-site adapters, exact-model
Gateway LLM preflight, persistent budgets, fenced workflow completion,
an independent maintenance/scheduler process, fresh-backup-gated Worker
readiness, verified backups, four authenticated artifact
downloads and isolated staging configuration. A deterministic in-process E2E
crosses the authenticated HTTP control plane, reaches `succeeded`, persists
the closed evidence set and verifies exactly four downloads. Beta admission
requires hospital plus department; one official source must bind all three
identity anchors in a bounded local window, and publication attribution
requires both anchors in the matched author's own PubMed affiliation.
Profile claims must be exact, type-anchored excerpts of their cited official
source, and unsupported numeric claims fail closed.
All model-controlled narrative fields reject HTML, links, URLs and dangerous
URI schemes. The four-artifact renderer adds only server-verified source links
and identifiers. The current offline baseline passes build, 473 Vitest tests,
8 Python tests, script syntax checks, Compose security assertions and a
zero-vulnerability production dependency audit.

This does not close Phase 0B or make production ready. The implementation has
no approved live ORCID, Brave or LLM credential in the repository and must
not have one. The live loopback staging smoke and its quality review therefore
remain external evidence gates. See `controlled-beta-runbook.md`.

## Phase 0B evidence still required

These decisions and measurements cannot be fabricated in code:

1. Approve the target-doctor population, stratification, minimum evidence,
   quality thresholds and pass/fail policy.
2. Build twenty approved frozen fixtures, including at least fifteen
   stratified real Chinese doctors with permitted minimal snapshots,
   retrieval dates, URLs, hashes and human-verified gold sets.
3. Measure the proposed Phase 1 data-source stack: `recall@15`, author
   attribution precision, claim coverage and insufficient-evidence rates.
4. Select the internal LLM and official-site search provider, then run a
   reproducible structured-output and quality benchmark.

The legacy prompts in `doctor-research-query/evals/evals.json` do not count.
They have no frozen source bundle or human gold set. The quarantined Martin
sample never counts, even if its visible text is edited.

## Gates deliberately moved out of Phase 0

The following controls remain important, but they do not block completion of
the offline engineering foundation:

- **Phase 0.5 release compatibility:** pin the minimum rollback image digest
  and verify capability read compatibility against production-shaped frozen
  snapshots before any `doctor_research` value is written to production.
- **Phase 1 production enablement:** approve RPO/RTO, backup cadence,
  backup-stale thresholds, storage limits, retention, privacy/cross-border
  boundaries and owners; then run the disk-hard-limit and encrypted
  backup/restore drills against those approved values.
- **Third-party snapshot use or redistribution:** recover exact upstream URL,
  commit, acquisition date and applicable license evidence before executing,
  packaging or redistributing a snapshot. Missing provenance does not block
  first-party Doctor Research work while the snapshots remain quarantined,
  non-executable references and are excluded from production images.

## Current decision

Phase 0A may be marked complete. Overall Phase 0 remains open only for the four
Phase 0B evidence items above. Engineering may continue behind the default-off
feature flag, but Research must not be enabled in production and no live
quality claim may be made until Phase 0B, Phase 0.5 and the applicable Phase 1
gates have passed.
