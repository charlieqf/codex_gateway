# Doctor Research controlled-beta evidence

Status as of 2026-07-18: **controlled-beta staging mainline passed with live
first-party sources and GoldenCode/GLM-5.2; production remains disabled and
NO-GO**.

This matrix separates executable engineering evidence from provider,
product-quality and production approvals. A passing offline or in-process test
must never be reported as a live PubMed, Crossref, ORCID, Brave or LLM result.

## Mainline requirements

| Requirement | Implementation evidence | Current gate |
|---|---|---|
| Startable Worker lifecycle | `apps/research-worker/src/index.ts` and `runtime.ts`; startup, ready heartbeat, graceful drain and dependency-loss tests | Passed offline and on Azure Ubuntu |
| Heartbeat, lease, renewal, fencing, cancellation and terminal convergence | Research Store lease/fencing transactions, lease guard and Worker runtime tests, including cancellation after the final renewal | Passed deterministic race tests |
| Independent maintenance/scheduler | `maintenance-index.ts`, database-fenced maintenance locks, reconciliation, cleanup, storage probe and verified backup lifecycle | Passed deterministic process/backup tests |
| First-party live adapters | Bounded PubMed E-utilities, Crossref REST and ORCID public-record adapters | Code/mocked protocol tests passed; the live `Shen Baiyong / Ruijin Hospital / Surgery` run discovered 15 PubMed records, retained 14 after author-affiliation binding and resolved all 15 available DOI records through Crossref; production contacts and ORCID terms remain open |
| Official-site retrieval/search and LLM | Allowlisted direct-URL retrieval plus optional explicit-domain Brave search, and exact-model Gateway LLM readiness/generation | The allowlisted SJTUSM profile fetched live and matched name, hospital and department; the direct three-member `goldencode`/GLM-5.2 pool passed exact-model readiness and structured generation with reasoning effort `low`; Max, OpenRouter and Brave were not used |
| No public proxy, Scholar scraping or dynamic Skill execution | Proxy variables rejected while enabled; Compose clears proxy variables; no Scholar adapter; immutable compiled `SkillDefinition`; runtime image excludes docs/Skill archives | Passed config, image-content and source audit |
| Exactly four atomic artifacts | Immutable temp-write/fsync/link publication, one fenced DB transaction, orphan cleanup and authenticated hash-verified streaming downloads | Passed crash tests and live HTTP E2E with exactly four files: three Markdown and one text |
| Isolated staging state | Loopback-only staging Compose with separate Gateway, Research state and Research backup volumes | Passed Compose/security assertions and live Azure staging at `127.0.0.1:18788`; production remained on its original loopback listener |
| Secret-safe smoke | `scripts/research-beta-smoke.mjs` accepts only literal loopback, reads token/request from files, bounds responses and verifies four hashes | Live invocation exited zero without printing credentials, request input or artifact bodies |
| Default-off and fail-closed | Gateway, Worker and maintenance flags default false; enabled startup/admission rejects incomplete DB, storage, backup, provider, model, quota or Worker readiness | Passed route/config/runtime negative tests |
| Existing Gateway compatibility | Full build and Vitest suite covers chat, sessions, responses compatibility, tools, images, credentials and Research | Current changes passed 487/487 Vitest tests and 14/14 Python contract tests; production dependency audit reported zero vulnerabilities |

## End-to-end evidence

Both the authenticated in-process E2E and the live loopback staging E2E use
separate Gateway and Worker SQLite connections and exercise:

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

The deterministic E2E verifies exactly four distinct artifact kinds and rows:
`profile`, `review`, `questions` and `answers`, plus the closed evidence rows.
The live E2E at commit `1fdd0fa62444af14fa358c4fb09968ad1a3b01c5`
completed run `drr_e5d73d1b922745639ecf820f9df81cc8` in one lease attempt.
It reached `succeeded`, returned a `doctor_research_result.v1`, stored exactly
four artifact rows and downloaded exactly these files:

| Download file | Bytes | SHA-256 |
|---|---:|---|
| `profile.md` | 577 | `916f55b8bed1e09e89802d178125f9b056f205de27254428a0eef03a0599ba34` |
| `frontier-review.md` | 6424 | `491c366dbd69c32d89867cc3af9e17d8a9ee5ccc0ffd3ca32a65c858bdc738f6` |
| `predicted-questions.txt` | 278 | `04f91e5dcc06d5e59c6df9b7bb0ca1e9ab28da741be02ae86ee12a9d40d86fef` |
| `questions-and-answers.md` | 6137 | `a22d8261a2ed4441530a28c7d752b65aba8741735abcf0718d80601a6d71b548` |

The questions file contained exactly five lines. The result reported the
expected human-review and evidence-coverage warnings; unsupported narrative
numbers were marked `unverified`/`未核验` and the complete schema, narrative,
citation and evidence-closure gates were rerun before success.

## Negative and recovery mapping

| Check | Deterministic evidence |
|---|---|
| Worker unavailable rejects create | Gateway Research admission tests plus live stale-heartbeat drill returning `503 research_worker_unavailable` |
| Cancel during work cannot become succeeded | lease guard, Store arbitration and Worker final-renewal race tests plus live cancellation during LLM work; the run remained `cancelled`, result returned `409 run_not_complete`, and artifact count remained zero |
| Expired lease takeover fences old owner | two-owner Store fake-clock tests |
| Foreign subject sees uniform not-found | result, run and artifact route tests plus live foreign-subject probes for run, result and all four downloads, each returning uniform `404` |
| Traversal and symlink paths rejected | artifact/root guard and intermediate-link tests plus three live encoded traversal probes returning `404 artifact_not_found` |
| Missing provider/model settings reject readiness | Worker config, dependency-loss and LLM readiness tests |
| Storage and stale backup reject admission/readiness | admission guard, storage probe and fresh-backup Worker tests |
| Backup restore verifies DB and artifacts | snapshot restore, SQLite integrity/foreign-key and hash-corruption tests plus live backup `drb_cf6a01d4733946b2ada650aa9de12ae0`, copied to a new networkless restore directory and verified with four artifacts and schema version 5 |
| Non-Research Gateway behavior remains compatible | complete Gateway/provider/admin test suite |

Staging logs and audit rows were also inspected without printing bodies.
Audit parameters contained only identity fingerprints, mode/language, lease
generation/worker ID, artifact count and hashes. Gateway, Worker and
maintenance logs contained no doctor identity, official URL, Prompt or
credential literals.

## Release compatibility and production state

Phase 0.5 is complete for the pinned rollback boundary documented in
`phase0.5-compatibility.md`. A read-only probe in that production image decoded
all current stored feature policies and confirmed that the production Research
flag remained false. It did not write a capability or alter a user, key, plan,
entitlement, environment, container, listener or edge route.

## Open external gates

The following cannot be replaced by deterministic code:

- production ORCID terms/commercial-use decision or registered/member
  credential; staging uses the bounded Anonymous API;
- production NCBI/Crossref operator contacts and a reviewed first-party domain
  allowlist; Brave is optional and remains disabled;
- approved beta doctor requests and human identity/citation/claim review;
- Phase 0B frozen real-doctor fixtures and quality thresholds;
- encrypted production backup target, limits, RPO/RTO,
  privacy/cross-border, capacity and provider-terms approvals;
- explicit authorization to change production environment, grant
  `doctor_research`, restart the production container or expose the route.

The isolated, loopback-only staging controlled beta is **GO**. Production
remains **NO-GO** and disabled.
