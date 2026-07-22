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

The engineering-side derived thresholds are declared once in
`packages/research-agent/src/review-contract-policy.ts`. That policy records
the authoritative Skill path, medical-team ownership, and the exact reviewed
bundle SHA-256. Workflow admission fails closed when the active bundle digest
does not match it, so a Skill update cannot silently reuse stale prompt,
validator, or supplementer rules. The prompt builders, fragment and complete
validators,
deterministic supplementers, JSON contract, and language counters all consume
that policy. Prose defect detection and deterministic repair share
`review-prose-rules.ts`; the replay suite must pass unchanged before either
derived rule source is released.

Normal synthesis prompts use
`doctor_research_prompt_projection.v1`: each call receives a minimal doctor
context, bounded search expressions, one global citation/evidence-ID/title
map, and only that shard's closed publication subset. A title appears only in
the global map rather than being repeated in each publication object; author
lists and abstracts are mechanically bounded without engineering-side medical
summarization. Per-call input tokens and usable remaining wall time are
preflighted before a stage run is charged, and the Worker retains a cleanup
tail for structured failure persistence and cancellation observation.

The request field remains `"mode": "brief"` for v1 wire compatibility. Normal
execution targets the medical Skill's current 6000-character review and
40-reference search target: production searches up to 40 verified field
references and reports the actual count and evidence boundary when fewer
relevant verified records are available. The only production degradation is
documented below: after two successful core synthesis fragments and two
transport failures for the closing fragment, the service may publish a
complete, explicitly warned result with a 5000-character aggregate floor.

The current Azure release is commit
`a77cf01fe8e71b92bb071cab40c4ab5e0e6d37bb`, execution `1.6.72`, prompt `v28`,
validation `v39` and workflow `doctor_research_workflow.v65`. Five consecutive
same-case public E2E runs all reached terminal state in under ten minutes;
three produced hash-verified 3 MD + 1 TXT results and two failed closed with
zero artifacts. The service therefore remains `controlled-trial` until the
medical team completes manual content acceptance and agrees on the required
success-rate and soft-completeness policy.

## Contents

- `current-status-problems-and-remediation.md`: current Azure release status,
  known acceptance gaps, root-cause analysis and prioritized remediation plan.
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

The production Worker uses frozen execution contract `1.6.72` together with the
hashed medical-team bundle. It loads only the four allowlisted `SKILL.md`
files; `.skill` archives, samples, assets, references, and scripts are not
executed or dynamically discovered. The source files remain byte-exact and
read-only. At prompt time, the Worker mechanically retains the parent
business rules/output templates and the child Skills' workflow, evidence,
citation, writing, and quality sections, while omitting packaging-only
examples, install commands, optional visual/PDF deliverables, external-tool
instructions, resources, dependencies, and assets outside this four-text-file
API. The full bundle hash and derived projection hash are both recorded.

For latency, execution `1.6.72` splits synthesis into three bounded independent
fragments and routes them with separate internal session affinity. It starts
two calls, observes a bounded 15-second window for a fast provider-admission
rejection, and then starts the third concurrently when both accepted calls
remain active. A fast rejection retains the accepted call and reduces
concurrency before continuing. Each synthesis call has a 180-second
engineering deadline inside the 570-second run deadline. The foundation,
middle, and closing fragments additionally use output ceilings of 8,000,
10,000, and 8,000 tokens, respectively, below the provider-wide 18,000-token
ceiling. These engineering ceilings prevent a bounded fragment from consuming
its whole time budget through unnecessary continuation without changing any
medical-Skill section or evidence floor. The verified
doctor profile is projected deterministically from exact official-source
excerpts, so the model does not receive or regenerate that profile. A final
call performs only the medical Skill's concise peer-review self-check and
returns bounded exact-text corrections instead of rewriting the complete
article. That compact peer-review call has a 120-second engineering deadline;
if its transport is unavailable, deterministic evidence-closure may accept
the assembled draft only when every medical Skill content gate still passes.
When complete validation isolates the remaining hard failure to one body or
closing section, the bounded correction path sends only that section, its
structured diagnostics, and the closed evidence already cited by that
section. The response must carry the stable section ID, exact source-section
SHA-256, and a complete replacement under `doctor_research_section_repair.v1`.
The Worker rejects stale hashes, changed headings, citations outside the
allowed evidence subset, and any replacement that fails complete validation;
all other section bytes remain unchanged. The existing peer-review
`old_text`/`new_text` patch contract remains supported. If failures span
independent hard-gate domains, the Worker fails closed instead of starting a
second broad self-rewrite.
The three normal fragment targets preserve all per-section floors and total
115% of the configured review minimum, replacing an engineering
over-allocation that previously requested 210% across the three calls. This
reduces model output latency without changing the medical-team Skill or the
normal 6,000-character review floor. The middle call is explicitly balanced
across exactly four topic sections, and the closing call emits exactly the
three required closing sections without a nonessential transition section.

When evidence-safety removal makes an otherwise substantive limitations or
conclusion section underfill the medical Skill's explicit section floor, the
fallback may append only pre-reviewed evidence-boundary prose: at least half
of the limitations section and one quarter of the conclusion must remain, and
the original 600/200 content floors are never reduced.
The same post-safety conservative closure applies to a model body topic only
when at least 75% of the Skill's 600-character floor remains and the section
contains verified citations. It can add only pre-reviewed evidence-boundary
prose tied to those same citations; a shorter or uncited topic still fails
closed.

Execution `1.6.72` also closes model-fragment presentation defects without
rewriting medical content: a paragraph-level dangling transition such as
`但该研究...` is made self-contained, and a subjectless scope sentence such as
`涵盖...` is anchored to the evidence in the review. Dangling post-safety
phrases such as `该关联`, `该趋势`, `该个案`, `该发现`, or a paragraph-leading
`该大样本研究` are removed or given an explicit source referent. A single
leaked question/answer marker, a heading such as `简短学术问答`, a horizontal
rule, and anything following it after the conclusion are removed. A comparison
sentence that ends at `相比` and a result sentence that ends at bare `显示 [n]`
are treated as incomplete rather than published, and a claim inferred only
from a paper title is replaced by an explicit abstract-availability boundary.
Presentation-only sentence removal and demonstrative closure run to a bounded
fixed point, because deleting an unsupported leading sentence can expose a
formerly internal `该发现`, `该结果`, `该趋势`, `该病例`, or `该个案` as the new
paragraph start. This convergence changes no medical fact and must still pass
the complete evidence validator.
Deterministic length or reference-closure paragraphs are inserted into the
evidence-synthesis section instead of being appended after the conclusion.
For a Chinese question
that explicitly asks for an effectiveness or success rate, the deterministic
answer check may add only explicitly labelled rate or shrinkage metrics found
in that answer's already-bound PubMed abstract. It never searches for or
invents a replacement fact, and the normal numeric evidence-closure and
100-300-character answer gates still apply.
If evidence-safety removal leaves a Chinese question about target-vessel
patency or EASIX prognostic value with only boundary language, execution
`1.6.72` may copy only the explicitly labelled patency, odds-ratio, or
hazard-ratio values from that answer's already-bound PubMed abstract. The
mapping is keyword-limited, idempotent, and remains subject to the same numeric
and statistic-label evidence closure; it does not infer a clinical
recommendation or use another reference's values. The same exact-source rule
closes an AVP/endoleak effectiveness question with the abstract's explicitly
labelled technical-success, immediate angiographic-success, and shrinkage
metrics. It also closes a D-dimer surveillance answer or review paragraph with
the abstract's explicitly labelled adjusted hazard ratio and sensitivity odds
ratio when model prose was truncated, and can restore the two explicitly
labelled EASIX prognostic estimates when a fragment dropped their subject.
Core-evidence sample flow also retains both the source-cohort and
actually included counts when the abstract reports both, instead of selecting
only the larger number. An abstract that does not expose a specific study
design now receives a neutral methods boundary rather than a duplicated
`原始表述为准。设计` phrase.

When several near-minimum body sections require deterministic boundary
completion, execution `1.6.72` rotates distinct pre-reviewed paragraphs across
sections so the completion step cannot create duplicate prose. It repeats the
unchanged section-floor check after whole-review paragraph deduplication, since
a shared model paragraph may otherwise leave a section just below its floor.
The post-safety topic pool contains enough distinct boundary paragraphs for
all allowed topic sections, so earlier supplements in other sections cannot
exhaust the final floor-closing pass.
That final check can add only a boundary paragraph not already present in the
review; it does not lower or reinterpret any medical content gate. A substantive
closing limitations or conclusion section that is near its unchanged Skill
floor is completed before fragment contract evaluation, using the same
claim-free evidence-boundary text and citation checks already used after
safety normalization. This prevents two mechanically repairable diagnostics
from consuming model retries or failing the whole run.

Before spending the medical Skill's peer-review call, the Worker previews the
same deterministic evidence closure used by the unavailable-peer fallback. If
that closure would remove the complete introduction while the original
fragment passed its Skill floor, one bounded correction call runs concurrently
with peer review. It regenerates only the introduction from the five verified
foundation abstracts, forbids narrative numbers, retains the 800-character
floor, and does not alter any medical-team Skill text or any thematic section.

If an upstream transport timeout consumes the first bounded shard retry and
the returned fragment still misses a medical Skill section contract, the
remaining fifth call is reallocated to that exact fragment. Because the five
call budget is then exhausted, the Worker's evidence, citation, prose, length,
and presentation gates perform the required concise pre-publication self-check.
The run publishes only if every unchanged medical Skill requirement passes;
otherwise it fails closed before the 570-second wall deadline.

Before applying the medical Skill's four-section and per-section length gates,
the Worker removes only exactly duplicated body paragraphs under the same
normalization used by the duplicate-prose validator. It then recomputes every
section floor and all evidence gates, so repeated model text cannot be counted
as substantive length and removal cannot waive a medical Skill requirement.

When any transport, format, or Skill retry has consumed the fourth call, the
Worker previews its
deterministic evidence closure before allocating the fifth call. If that
preview shows an otherwise present conclusion would be removed entirely, the
fifth call regenerates only the conclusion from five verified abstracts,
forbids narrative numbers and treatment recommendations, and retains the
medical Skill's 200-character floor. Full deterministic self-review then runs
over the assembled document; any remaining failure is rejected.

The Worker projects only the required fields from model fragment envelopes and
accepts a closing fragment returned directly as bounded Markdown. This
transport normalization does not waive any content check: every fragment is
checked against the medical Skill's target language and exact section/length
contract before assembly. The middle shard always supplies four substantive
topic sections, and the closing shard supplies exactly one
evidence-synthesis/controversy section, one limitations/outlook section, and
one conclusion. Empty sections,
duplicate substantive paragraphs, unbalanced delimiters, truncated numeric
prose, and low-information, English-substituted, or duplicated Chinese
core-evidence fields are rejected. The deterministic core table obtains study
type and sample size only from the verified PubMed title/abstract, and reuses
evidence-closed Chinese sentences from the validated introduction for methods
and results where available. A combined method/result sentence is split only
at an explicit result or reported-rate marker; otherwise the methods cell uses
the conservative study-design fallback while the complete evidence sentence
remains available to the results cell. Subjectless result starts in the
deterministic core table are repaired with evidence-neutral study attribution.
Study-design matching is sentence-bounded, so a
retrospective study is not mislabeled as prospective merely because its
conclusion asks for prospective validation. Safety normalization treats decimal
points as part of a number rather than a sentence boundary, repairs a bounded
set of subjectless or comparison-only Chinese sentence starts left by safe
clause deletion, renumbers damaged inline outlook enumerations, strips an
accidentally appended Q&A block from the review while preserving any later
independently generated synthesis, limitations, and conclusion sections, and
also strips repeated orphan `答：` paragraphs after the conclusion even when
their Q&A heading was lost during evidence closure. It removes duplicate
substantive paragraphs that arise only after unsupported
numerical sentences are closed. A prescriptive treatment sentence supported
only by case reports or case series is removed instead of being promoted into
a general recommendation.

Answer length is closed deterministically with evidence-neutral boundary
language before the Worker decides whether to spend its one bounded correction
slot. This avoids an unnecessary model rewrite of otherwise valid Q&A content.
Chinese factual quantities in answers are normalized to Arabic digits before
the exact-number evidence gate, so spelled-out quantities cannot bypass
closure against their cited abstracts. A case-report-only or case-series-only
answer also receives and validates an explicit non-generalization boundary.
Repeated evidence-boundary sentences are removed, and repeated length closure
is idempotent. Mean-versus-median follow-up labels are checked against the
cited abstract and deterministically corrected when the exact statistic and
unit identify an unambiguous mismatch. Chinese answers with a subjectless
finding verb receive an evidence-neutral study subject. When a question
explicitly asks whether female and male outcomes are comparable, a comparable
outcome statement is projected only when that exact relationship is present in
the cited abstract. Review study-design labels are corrected from the cited
abstract, and a sentence claiming spinal-cord injury is removed when none of
that paragraph's cited abstracts reports that clinical topic. A collective
answer may call multiple sources retrospective only when every cited abstract
explicitly reports a retrospective design; otherwise that unsupported design
label is removed and the two studies are named directly.
After the concise peer-review patch, the Worker first validates the corrected
draft without rewriting it and invokes deterministic safety normalization only
when a gate still fails. If that normalization would leave a medical-Skill
section under its explicit length floor, and the fifth model-call slot is still
available, one 90-second exact-text convergence pass may repair only the
remaining review diagnostics. Case-report or case-series evidence that is used
to recommend routine, standard, or preferred treatment is now a direct
validation error as well as a deterministic removal rule.

If exactly one synthesis shard encounters a retryable transport failure, an
unusable envelope, or a medical-Skill contract violation, execution may spend
one additional call to retry only that shard inside the same hard deadline.
Foundation retries are capped at 120 seconds, middle-fragment retries at
170 seconds, and closing-fragment retries at 90 seconds. If both the original
closing call and its bounded retry fail after the foundation and four-topic
body have succeeded, execution `1.6.72` builds only the three closing sections
from pre-reviewed evidence-boundary prose. When body and closing transport
failures overlap, the non-reconstructable body retry is scheduled ahead of
the closing retry; if that body then succeeds but closing transport remains
unavailable, the same bounded closing fallback is used. A remaining call still
attempts compact peer review; when both transport retries consumed the
five-call budget, the unchanged deterministic evidence-safety validator
performs the final self-check. Every section floor, identity rule, citation
rule, numeric closure,
evidence-grade rule, five-question contract, and artifact integrity check is
unchanged. Only the aggregate review floor may decrease from 6000 to 5000
characters, and the result records
`deterministic_closing_transport_fallback_applied`. Foundation or body
transport exhaustion, or any remaining validation failure, still fails
closed. The 570-second run deadline remains the outer limit.
Short-lived `429` admission responses are retried within the same recorded
stage attempt. A short but substantive abstract may be completed with whole
evidence-closed sentences selected from that same fragment's validated
introduction, followed when needed by one fixed claim-free evidence-boundary
sentence. An underfilled optional closing topic is removed because the four
mandatory topic sections are already complete. These actions are recorded as
warnings; neither lowers a medical Skill length gate nor consumes another
model call. Numeric safety normalization first preserves only complete,
substantive Chinese clauses from the model's original sentence whose numbers
are all closed against the cited abstracts. It removes the complete sentence
when no such clause is safe, never splits decimal points, and rejects
unbalanced or truncated results. Citation-closure paragraphs are rechecked for
case, in-vitro, and observational scope. Deterministic evidence-boundary
supplements are never repeated merely to reach the length floor. The Worker
then assembles the fragments, renders the
3-8-paper core evidence table from verified publication metadata and
abstracts, adds verified identity, sources, all reference metadata, search
report, coverage and quality fields, and validates the unchanged public result
schema. Up to 40 verified references, the normal 6000-character floor, and the
mandatory peer-review attempt remain in force, subject only to the explicit
closing-transport degradation above.

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
      "https://www.carm.org.cn/gywm/fzjg/zywyh/art/2025/art_8451aeed0bc14fbab6541f37c08b5195.html",
      "https://www.qk.sjtu.edu.cn/jscp/CN/abstract/abstract45986.shtml"
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
- honors integer `Retry-After` guidance for rate-limited authenticated GETs,
  with at most four retries and no more than 60 seconds of added wait for each
  result or artifact request;
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
  --official-profile-url "https://www.qk.sjtu.edu.cn/jscp/CN/abstract/abstract45986.shtml" `
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

## Offline model-response replay

Reviewed replay fixtures live only under
`packages/research-agent/test-fixtures/replay/`. The replay entry accepts a
sanitized run input, fixed closed evidence, an injected clock, and the ordered
model response-or-error sequence. It performs the production fragment parse,
deterministic normalization, merge, complete validation, peer substring patch,
and four-text rendering without network access. Tests run every fixture twice
and require identical diagnostics, semantic results, artifact bytes, and
aggregate content SHA-256.

The current suite contains 13 independent sanitized fixtures exercised by 16
tests; repeated-run variants account for the difference between fixture and
test counts.

The initial suite contains synthetic derived cases for short topic sections,
orphaned references, truncated comparison prose, QA after the conclusion,
unsupported numbers, missing citations, peer patches, malformed shard JSON,
provider 500, 429 admission rejection, timeout cancellation, and client abort.
Each fixture is pinned to the exact medical-team Skill bundle digest and the
prompt, validation, workflow, and response-template versions; a digest or
version change fails closed pending review. The quarantined
`samples/known-invalid/` directory is never loaded as a replay fixture.

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
