# Doctor Research controlled-beta evidence

Status as of 2026-07-18: **Worker mainline implemented; external-provider
staging E2E pending**.

This matrix separates executable engineering evidence from provider,
product-quality and production approvals. A passing offline or in-process test
must never be reported as a live PubMed, Crossref, ORCID, Brave or LLM result.

## Mainline requirements

| Requirement | Implementation evidence | Current gate |
|---|---|---|
| Startable Worker lifecycle | `apps/research-worker/src/index.ts` and `runtime.ts`; startup, ready heartbeat, graceful drain and dependency-loss tests | Passed offline and on Azure Ubuntu |
| Heartbeat, lease, renewal, fencing, cancellation and terminal convergence | Research Store lease/fencing transactions, lease guard and Worker runtime tests, including cancellation after the final renewal | Passed deterministic race tests |
| Independent maintenance/scheduler | `maintenance-index.ts`, database-fenced maintenance locks, reconciliation, cleanup, storage probe and verified backup lifecycle | Passed deterministic process/backup tests |
| First-party live adapters | Bounded PubMed E-utilities, Crossref REST and ORCID public-record adapters | Code/mocked protocol tests passed; the live `Shen Baiyong / Ruijin Hospital / Surgery` preflight discovered 15 PubMed records, retained 14 after author-affiliation binding and resolved all 15 available DOI records through Crossref; production contacts and ORCID terms remain open |
| Official-site retrieval/search and LLM | Allowlisted direct-URL retrieval plus optional explicit-domain Brave search, and exact-model Gateway LLM readiness/generation | The allowlisted SJTUSM profile fetched live and matched name, hospital and department; `goldencode`/GLM-5.2 is selected and fail-closed code/tests passed; live model quality evidence is pending |
| No public proxy, Scholar scraping or dynamic Skill execution | Proxy variables rejected while enabled; Compose clears proxy variables; no Scholar adapter; immutable compiled `SkillDefinition`; runtime image excludes docs/Skill archives | Passed config, image-content and source audit |
| Exactly four atomic artifacts | Immutable temp-write/fsync/link publication, one fenced DB transaction, orphan cleanup and authenticated hash-verified streaming downloads | Passed crash tests and HTTP E2E with exactly four files |
| Isolated staging state | Loopback-only staging Compose with separate Gateway, Research state and Research backup volumes | Compose/security assertions passed; disabled volumes created on Azure |
| Secret-safe smoke | `scripts/research-beta-smoke.mjs` accepts only literal loopback, reads token/request from files, bounds responses and verifies four hashes | Syntax and Python wrapper tests passed; live invocation pending |
| Default-off and fail-closed | Gateway, Worker and maintenance flags default false; enabled startup/admission rejects incomplete DB, storage, backup, provider, model, quota or Worker readiness | Passed route/config/runtime negative tests |
| Existing Gateway compatibility | Full build and Vitest suite covers chat, sessions, responses compatibility, tools, images, credentials and Research | Current changes passed 482/482 on Windows plus 11/11 Python contract tests; 475/475 passed on Azure Ubuntu for the immediately preceding runtime-equivalent release |

## End-to-end evidence

The authenticated in-process E2E uses separate Gateway and Worker SQLite
connections and exercises:

```text
POST create
  -> ready Worker heartbeat
  -> lease
  -> frozen identity/evidence adapters
  -> structured model output
  -> deterministic validation
  -> succeeded
  -> GET result
  -> four authenticated, size- and SHA-256-verified downloads
```

It verifies exactly four distinct artifact kinds and rows: `profile`, `review`,
`questions` and `answers`. It also verifies two sources, two claims and one
reference in the closed evidence set. This proves the application mainline and
storage/control-plane boundaries, but deliberately uses frozen providers.

The same focused E2E and the complete 475-test suite passed from the isolated
Azure Ubuntu staging source directory. No staging or production listener was
started for those tests. The Phase 0.5 follow-up changes only documentation and
its frozen policy fixture/test; the final release is revalidated separately
before publication.

## Negative and recovery mapping

| Check | Deterministic evidence |
|---|---|
| Worker unavailable rejects create | Gateway Research admission tests |
| Cancel during work cannot become succeeded | lease guard, Store arbitration and Worker final-renewal race tests |
| Expired lease takeover fences old owner | two-owner Store fake-clock tests |
| Foreign subject sees uniform not-found | result, run and artifact route tests |
| Traversal and symlink paths rejected | artifact/root guard and intermediate-link tests |
| Missing provider/model settings reject readiness | Worker config, dependency-loss and LLM readiness tests |
| Storage and stale backup reject admission/readiness | admission guard, storage probe and fresh-backup Worker tests |
| Backup restore verifies DB and artifacts | snapshot restore, SQLite integrity/foreign-key and hash-corruption tests |
| Non-Research Gateway behavior remains compatible | complete Gateway/provider/admin test suite |

These deterministic checks reduce staging risk. The controlled-beta runbook
still requires the corresponding live-process drills with approved staging
providers before production can be proposed.

## Release compatibility and production state

Phase 0.5 is complete for the pinned rollback boundary documented in
`phase0.5-compatibility.md`. A read-only probe in that production image decoded
all current stored feature policies and confirmed that the production Research
flag remained false. It did not write a capability or alter a user, key, plan,
entitlement, environment, container, listener or edge route.

## Open external gates

The following cannot be replaced by deterministic code:

- staging-only credentials for the direct GoldenCode pool, plus a chat-only
  service credential restricted exactly to `goldencode`;
- production ORCID terms/commercial-use decision or registered/member
  credential; staging uses the bounded Anonymous API;
- reviewed first-party domain allowlist and direct official URLs for the beta
  doctors; a Brave key is needed only if automatic site discovery is enabled;
- NCBI and Crossref operator contact values;
- approved beta doctor requests and human identity/citation/claim review;
- Phase 0B frozen real-doctor fixtures and quality thresholds;
- encrypted backup target, limits, RPO/RTO, privacy/cross-border and provider
  terms approvals.

Until these inputs exist and the live staging runbook passes, the production
decision remains **NO-GO**.
