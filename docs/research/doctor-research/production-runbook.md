# Doctor Research production runbook

This runbook deploys the staging-validated Doctor Research mainline into the
existing Azure `codex_gateway_test` Compose project. It keeps the public
Gateway on `127.0.0.1:18787`, uses the existing Nginx route, and adds no public
Docker listener.

## Current production deployment

As of 2026-07-29, the public Azure Gateway and all three Research services run
commit `ddb1dcca5a92d2d032383f9cb01ae5cf65b22be4` from:

```text
/home/qian/codex-gateway-release-ddb1dcc-20260729T063301Z
```

The execution contract is `1.6.83`, prompt `v29`, validation contract `v42`
and workflow `doctor_research_workflow.v72`. The public Gateway remains bound
only to `127.0.0.1:18787`; the three Research services publish no host port.
All four containers are healthy, have zero restarts and use the exact release
workdir. Public and loopback health return `ready / controlled-trial`.

This healthy state does not imply arbitrary-doctor coverage. The deployed
`1.6.83` Worker still loads `RESEARCH_WEB_SEARCH_PROVIDER=direct`, has no web
search secret, and the image-bound reviewed registry contains only the
engineering smoke doctor. That temporary controlled-trial restriction was not
a product requirement. The next activation must use general identity search;
the registry remains a cache and must never be used as an eligibility list.

Local and Azure release gates passed build, 40 test files with all 598 Vitest
tests, all 36 Python tests, `git diff --check` and an npm audit with zero
vulnerabilities. The medical-team Skill directory has no Git diff, and the
deployed four-file bundle SHA-256 remains:

```text
6d5e839f942f87f1064a6d855c37b54302300aacd700360aa5fef8907a2fa351
```

Real-user `1.6.82` run `drr_cd3716ae58524bf299e36d6437b12a00`
failed closed in 143.414 active seconds even though all five Aliyun GLM-5.2
calls returned HTTP 200 within their bounds. After a successful QA correction,
the workflow unconditionally spent the fifth and final call on a general peer
review. That response was contract-unusable, and deterministic safety
normalization then exposed one remaining 313/450 topic. This was a workflow
routing gap, not identity, quota, deployment, provider availability or a
medical-Skill defect; zero artifacts were published.

Execution `1.6.83` keeps the five-call ceiling and every medical/content gate.
Only after a completed bounded QA, review-content or introduction correction,
when deterministic diagnostics identify exactly one remaining repairable
section, it reallocates the final peer slot to the existing hash-bound
single-section repair contract. The repair receives only that failed section,
its original SHA-256, structured diagnostics and allowed evidence IDs. A hash
mismatch, citation escape or failed complete validation still terminates with
zero artifacts. The regression suite proves the route with no sixth call and
byte-preserves already-passing sections.

Post-deploy exact-three-field public E2E
`drr_ad1f050c609945c29d546315d4857173` succeeded in 201.212 server-active
seconds (203 seconds client wall time). Its five Aliyun calls all returned 200,
joined to complete Worker/Gateway/provider timelines, recorded cancellation
`0/0`, and did not overlap sequential correction/peer calls. The run committed
76 sources, 40 references and 9 claims. It published exactly 3 MD + 1 TXT; the
result JSON, manifest entries, stored files, byte sizes and every SHA-256
matched, and the TXT contained exactly five lines.

Real-user run `drr_fe4729ec07eb42aea302d3289735b33f` on `1.6.81` reached a
clear failed terminal state in 321.483 seconds. Its QA correction used the
old default `reasoning=low` and 18,000-token ceiling, reached the 175-second
Gateway deadline, and recorded cancellation `1/1`. The later peer call was
admitted only after the old call terminated, but its unusable patch left a
331/450 topic, a 0/160 conclusion and one unmatched delimiter, so the run
correctly published zero artifacts. A subsequent same-case `1.6.81` run,
`drr_04adc0d5f5284133b64c5120154a1351`, succeeded in 139.191 seconds with
four artifacts, confirming that deployment, identity and quota were active.

The incident also exposed a stable performance split in production history
since 2026-07-22: attempt-4 calls using the old `low / 18,000` default
succeeded 13/27 times and timed out 14/27 times, while already-bounded
`none / 8,000-10,000` calls succeeded 19/19 times. Execution `1.6.82`
therefore bounds every targeted correction and peer-review call to
`reasoning=none`, at most 8,000 or 10,000 output tokens, and an explicit
correction wall-clock bound. It does not change the medical Skill, prompt,
validation, identity, citation, numeric, evidence-grade, safety, length or
artifact gates.

Post-deploy public E2E `drr_e3eee788c4da4c5e88c78f248929728a` used exactly
the three required top-level identity fields and completed in 161.227 server
seconds (164 seconds client wall time). It exercised the QA correction path:
attempt 4 used `reasoning=none`, an 8,000-token ceiling, reached its first
provider event in 2.323 seconds and completed in 11.866 seconds. The run
published exactly 3 MD + 1 TXT, and the Python client verified every manifest
size and SHA-256. All five calls joined to complete Worker/Gateway/provider
timelines, with no cancellation or overlap.

Execution `1.6.76` established the five-run engineering baseline below, and
`1.6.77` first proved the three-field request contract. A subsequent real-user
run, `drr_32fe62a652dc4a9f8d9b561b68a478e5`, exposed that a non-empty client
`official_profile_urls` list replaced rather than augmented the server-reviewed
registry. The single submitted Chinese profile therefore removed the registered
bilingual identity bridge, and identity resolution correctly failed closed.

Execution `1.6.79` now merges the authoritative registered URLs first and then
adds allowlisted client URLs, with de-duplication and the existing three-URL
bound. A public HTTPS acceptance call submitted exactly the three top-level
business fields `name`, `hospital`, and `department`. The Gateway applied both
server-reviewed identity sources, and `drr_07b07f128ce746edb777fbc70dbe3340`
succeeded in 265.857 server seconds (272.4 seconds client wall time). It
downloaded exactly 3 MD + 1 TXT, verified all manifest sizes and SHA-256 values,
and verified that the TXT had five non-empty lines. All five Worker calls joined
to complete Gateway/provider timelines; the permitted three-call initial shard
fan-out ended before the targeted follow-up began, so there was no old/new
follow-up overlap.

Two admitted failures caused by that old identity-source defect then exhausted
the former two-run daily subject quota. Request
`req-4aaf46f6-6104-48f6-8c8d-b85f6c7322ed` was a genuine
`research_daily_runs` rejection, not a failed deployment, but the old response
incorrectly advertised a fixed 30-second retry. `1.6.80` sets the controlled-
trial allowance to five admitted runs per UTC day and returns the true next-UTC-
day reset interval plus `maximum`, `used` and `requested` values. Admitted
failed and cancelled runs continue to count as the intentional anti-abuse
contract.

The current operator-approved production policy raises that per-subject UTC-day
admission ceiling from 5 to 50. The public Gateway, internal LLM Gateway,
Worker and maintenance containers all load the same value. This does not change
the single active brief run per subject, Worker concurrency 1, global queued-run
limit 2, entitlement boundary or medical quality gates. At post-deploy
verification, the reported user's subject had 5
admissions for the current UTC day and therefore 45 remaining under the new
ceiling without issuing another Research run merely to test the configuration.

Execution `1.6.81` adds a final bounded repair only when every remaining
diagnostic is duplicate paragraph, unmatched delimiter or invalid inline
enumeration. It reruns the complete identity, citation, numeric, evidence-grade,
length, structure, safety and artifact contract after the mechanical change.
Public run `drr_ed34e4ea72af4648b0e29d87b2f42175`, using exactly the three
required top-level fields, succeeded in 198.292 server seconds (204.9 seconds
client wall time). Its five Worker calls joined to Gateway/provider timelines,
and exactly 3 MD + 1 TXT matched every manifest size and SHA-256.

The earlier dependency-free Python baseline was:

| Run | Client create-to-terminal | Server duration | Result |
| --- | ---: | ---: | --- |
| `drr_701cffeff8534a4699a255556e2828eb` | 327.055 s | 324.749 s | success, four verified artifacts |
| `drr_6e631e5255254b5ca479a91bdfdff8d9` | 378.099 s | 376.004 s | success, four verified artifacts |
| `drr_b789d7d82b974872a59d3b784e9b1d6d` | 321.301 s | 320.391 s | success, four verified artifacts |
| `drr_0ac3161cfb0d47a38194e2b714d45726` | 344.805 s | 341.876 s | success, four verified artifacts |
| `drr_38ff2d2cfadd4bbb9043551acc29d762` | 166.765 s | 165.905 s | success, four verified artifacts |

Each result was `passed_with_warnings`, contained exactly 3 MD + 1 TXT, and
passed independent filename, size, manifest and SHA-256 checks. Two runs
exercised a 175-second internal Gateway deadline: provider cancellation was
observed `1/1`, and the replacement attempt began only after the timed-out
attempt ended (18 ms and 15 ms gaps respectively). Across the five runs, all
24 Worker stage rows had prompt/output budget, admission, sent, total and
request-ID data; all joined to Gateway events with admitted, provider-first-
event and provider-duration data. There were no same-session provider-call
overlaps. For non-stream calls, use `provider_first_event_ms`, not the legacy
`first_byte_ms`, as the real provider first-event timing.

The current controlled-trial policy retains the medical generation targets
and applies only a lower release floor for pure length completeness:
`6000/800/600/800/600/200` targets become
`5000/640/450/640/450/160` release floors for aggregate review,
introduction, each topic, synthesis, limitations and conclusion. A result
between target and floor is published only as `passed_with_warnings`.
Identity, citation, numeric evidence, evidence grade, safety, chapter count,
5-question/5-answer and four-file integrity gates remain fail-closed.

The `1.6.81` acceptance reused the explicitly issued named test credential,
which remains active for the requested user handoff; it did not create another
temporary credential. Local validation downloads and scripts were removed.
Final checks found zero active runs and zero unfinished public or internal-LLM
token reservations. The medical team has not yet confirmed this case as a
representative acceptance case or manually accepted the generated content, so
access must remain a named-user controlled trial.

After the `1.6.82` rollout, public OpenAI compatibility, strict-tools and the
exact eight-model surface passed. Focused `goldencode` native-tools request
`req-750bbdfa-20b6-4396-b05f-32f824070e7a` succeeded. All four smoke/E2E
users were disabled, their credentials have zero active keys, the Research
entitlement was cancelled, and the temporary files were removed. Maintenance
backup `drb_c9380e46353645fbaa63cdabdee45da0` then succeeded under `1.6.82`.

After the `1.6.83` rollout, public OpenAI compatibility, strict-tools and the
exact eight-model surface passed. One focused public `goldencode` native-tools
call through OpenRouter reached its 240-second client bound and proved
`client_abort` cancellation `1/1`; the next controlled smoke succeeded as
request `req-c61a0ac5-e163-42fa-a779-393062489c72` in 118 seconds without a
configuration or provider switch. Final audit found all four containers
healthy with zero restarts, only `127.0.0.1:18787` published, no active
Research run, no unfinished public or internal-LLM token reservation, no
temporary credential/file, and no critical post-activation log marker.
Maintenance backup `drb_04675f91276241d2a6f519b67119d852` succeeded after
activation.

Request `req-2bc6c36c-fa4d-4186-967f-14377eebe4e0` was a genuine pre-model
`research_unique_doctors_30d` rejection: the subject had admitted five distinct
doctors in the rolling window and requested a sixth. This limit is independent
of the 50-run UTC-day allowance. The old response incorrectly fell back to a
generic 30-second retry and omitted usage, which made a weeks-long quota look
transient. Runtime hotfix `ff5db5f` preserved the then-active five-doctor
boundary, calculates the earliest capacity from each existing doctor's latest
admission, and returns the exact reset interval with `rolling_30_days` and
`maximum/used/requested`.

Public contract smoke `req-d7e8d1a1-1ead-4a5a-bf6b-94c03a49cf1f` verified
`maximum=5`, `used=5`, `requested=1` and matching header/body
`Retry-After=2519833`. The affected subject's run/admission counts remained
`30/30`, so the rejected create had no side effect. Public OpenAI, strict-tools,
eight-model-surface and focused `goldencode` native-tools smokes passed. Final
audit found all four containers healthy with zero restarts, only
`127.0.0.1:18787` published, no active Research run, no unfinished public or
internal-LLM reservation, and no active temporary quota-smoke key. Maintenance
backup `drb_34756cef30d84cd2bfea3b1c6cc890c1` succeeded after activation.

The business owner then explicitly authorized removing the different-doctor
count restriction. Release `ddb1dcc` defines
`RESEARCH_MAX_UNIQUE_DOCTORS_PER_SUBJECT_30D=0` as disabled, retains the full
rolling-window contract for positive rollback values, and rejects missing,
negative or non-integer values. All four containers load `0` and daily `50`.
Public request `req-a420c2e0-49fc-49b3-8190-eebe1d17b54a` admitted the formerly
blocked new-doctor shape as run `drr_44172c711e494cacb3b0eda1947326a7`.
The smoke immediately cancelled it, verified zero artifacts and exactly one
new run/admission, then revoked its temporary key.

Post-deploy OpenAI compatibility, strict-tools, exact eight-model surface and
focused `goldencode` native-tools smokes passed; native-tools request
`req-153869a9-eb80-4a8b-9b14-98c25479a9b7` returned `write_file`. Final state
had four healthy zero-restart containers, no active Research run, no unfinished
public/internal-LLM reservation and no active temporary key/user. Maintenance
backup `drb_4e6ee057cc6b407da6711d8d8edd56ff` succeeded. The unused
`node:24-bookworm` release-validation image was removed after its space use
tripped the 10% storage admission floor; no production/rollback image, volume
or database backup was removed. Configuration restart/build classification is
maintained in `../../operations/runtime-configuration-change-matrix.md`.

The verified pre-deploy database and image rollback boundary for `1.6.83` is:

```text
/home/qian/codex-gateway-backups/ddb1dcc/20260729T063301Z
codex_gateway_test-gateway:rollback-ff5db5f-20260729T063301Z
codex_gateway_test-research-llm-gateway:rollback-ff5db5f-20260729T063301Z
codex_gateway_test-research-worker:rollback-ff5db5f-20260729T063301Z
codex_gateway_test-research-maintenance:rollback-ff5db5f-20260729T063301Z
```

All copied databases passed SQLite integrity and foreign-key checks. Their
SHA-256 values are:

```text
gateway.db              43a4f07052f65c311e335cef0880819b8826c9c6b58a360f70929e6e6fbb244a
client-events.db        c9b4aac791ab50ec687ab234042875a99b71b81d4a366169cf90766160850742
research.db             5bc65595eac2bc327f00a6d2e2624e897f7eebe6ecb31176f416356be4ea7d92
research-llm-gateway.db 75d5570a5589e05e6c0908d98c938bb83077c2c139e8f4a8759389fe698b2ca7
```

The exact deployed image IDs are Gateway `f87c8f1d0c04`, internal LLM Gateway
`1382673e2d03`, maintenance `e5707a09a716`, and Worker `24ec0f883091`.
The backup is on the same Azure OS disk and supports application rollback, not
host-loss disaster recovery.

The `ddb1dcc` disk preflight found about 15 GiB free. Build and release-test
images temporarily reduced it below the 10% floor; removing only the unused
validation image restored about 13 GiB/10% before activation continued. No
historical backup directory was removed for this release.
The live volumes and the verified `599fd53`, `2559d3a`, `02b74de` and current
`eb94fa8/20260728T062916Z`, `ff5db5f/20260729T053039Z` plus
`ddb1dcc/20260729T063301Z` rollback boundaries remain.

## Historical 1.6.72 acceptance record

As of 2026-07-22, the public Azure Gateway and all three Research services run
commit `a77cf01fe8e71b92bb071cab40c4ab5e0e6d37bb` from:

```text
/home/qian/codex-gateway-release-a77cf01-20260722T103032Z
```

The execution contract is `1.6.72`, with prompt `v28`, validation contract
`v39` and workflow `doctor_research_workflow.v65`. The public Gateway remains
bound only to `127.0.0.1:18787`; no other Research service publishes a host
port. The ordinary public surface still exposes the exact eight-model
registry. Local and Azure release gates passed build, all 579 Vitest tests,
all 23 Python tests and an npm audit with zero vulnerabilities.
The medical-team Skill directory has no Git diff and its deployed four-file
bundle SHA-256 remains:

```text
6d5e839f942f87f1064a6d855c37b54302300aacd700360aa5fef8907a2fa351
```

The API remains a restricted, named-user production trial. Five consecutive
public-HTTPS runs of the same engineering-allowlisted smoke case all reached a
terminal state below ten minutes. The medical team has not yet confirmed that
case as its final representative acceptance case:

- `drr_a98ba77e84a04f99a47de3e322c07043`: succeeded in 237.459 seconds;
- `drr_dffe542c19914841bf9936e65f93ca3a`: succeeded in 209.931 seconds;
- `drr_955f4e47884b4a9eaa1c0b5e57045265`: succeeded in 262.879 seconds;
- `drr_9ac8538f3ce147a0abcf1f6c19a0f96b`: failed closed as
  `model_contract_error` in 285.717 seconds after multiple independent
  citation, numeric, causality and prose gates remained unresolved;
- `drr_9d5fea39377646daa08bdfacfaef1861`: failed closed as
  `model_contract_error` in 358.272 seconds after a cancelled correction
  timeout and a final `476/600` topic section.

After deploying exact runtime commit `a77cf01`, public-HTTPS E2E
`drr_eab9f11f07484434aff46074bfd567e0` succeeded in 227.733 seconds. It again
downloaded exactly 3 MD + 1 TXT and verified every size and manifest SHA-256;
the temporary key was revoked, entitlement cancelled, user disabled and local
downloads removed.

Client documentation and the dependency-free Python example were then updated
on main in commit `d31177f6085f02aa9c94434fe2988438ed2e22a6`. This is an
external client/docs change and did not rebuild or restart the `a77cf01`
Gateway/Worker runtime. Current main passed the same build and 579 Vitest tests,
plus 30 Python tests and a zero-vulnerability npm audit. The new
`--request-file` path was also exercised through the real public API:

- `drr_f0048d1f058945dca14495ddcb111a99` failed closed as
  `model_contract_error` in 170.726 seconds. All four provider calls returned,
  but the assembled response still violated multiple citation, numeric,
  causality, answer-coverage and review-section gates; zero artifacts were
  published.
- `drr_62ac092339a14b55957141918c750af4` succeeded in 389.430 seconds and the
  Python client authenticated, downloaded and independently verified exactly
  3 MD + 1 TXT. A bounded correction call reached the 175-second Gateway
  deadline with `cancel_requested=1` and `cancel_observed=1`; the subsequent
  call was admitted only after a 31.010-second wait, so the old and new
  provider calls did not overlap.

The successful Python-client artifact SHA-256 values, in
`profile / review / questions / answers` order, were:

```text
4ae0c4abd1038fc22ab207ffc9c3a3ac8588363b26b2dca54bbee139266ad4d9
cd76a114605e1c21e4cd121ea2cb96d2c740fc293089f2d1ba0e5b8b186567cb
c10842b07e5978fca5c1094f3fb6229409e670b417866c55a4aecca5179624d3
07775cd687ccaa599988212c936482ec61ca5495d37f4a440412fa9e01c1aa47
```

All temporary Python-validation credentials were revoked, entitlements
cancelled, users disabled and VM/local output directories removed. All four
production containers remained healthy with zero restarts.

Each successful run returned exactly three Markdown files and one five-line
text file, and authenticated downloads matched all manifest SHA-256 values.
Each failed run published zero artifacts. This proves the engineering
terminal-time and artifact-atomicity requirements, but it is not a 5/5 model
success result and the medical team has not yet completed manual content
review. Do not broaden access beyond approved named trial users.

The current verified online database backup and rollback image tags are:

```text
/home/qian/codex-gateway-backups/a77cf01/20260722T103032Z
codex_gateway_test-gateway:rollback-70ca267-20260722T103032Z
codex_gateway_test-research-llm-gateway:rollback-70ca267-20260722T103032Z
codex_gateway_test-research-worker:rollback-70ca267-20260722T103032Z
codex_gateway_test-research-maintenance:rollback-70ca267-20260722T103032Z
```

All three SQLite backups passed integrity and foreign-key checks. Their
SHA-256 values are:

```text
gateway.db       77a8861f7afcfc51d4a5d2a6eb205222fbc52cda0be59cfd927ef6a04d75a642
client-events.db 76459a5c5f8981805e81524150835babefc48f1c357020be38d20d3cbda39376
research.db      77018681ced2f914279bc02dbcea4d8da23da881fd05ea7ffeb04d1859e0684b
```

The prior `70ca267` release remains the immediate source/image rollback
boundary, with its earlier verified database backup retained at
`/home/qian/codex-gateway-backups/70ca267/20260722T093500Z`. Historical
deployment backups superseded by these two verified boundaries were removed;
the current state volumes and both rollback boundaries were retained.

The separate backup volume is encrypted at rest by the Azure managed-disk
platform and has passed a networkless scratch-volume restore drill. It is on
the same OS disk, so it is not an off-host disaster-recovery copy.

## Production shape

Compose must always be invoked with both files and the explicit project name:

```bash
docker compose -p codex_gateway_test \
  --env-file config/research.production.compose.env \
  -f compose.azure.yml \
  -f compose.research-production.yml
```

The overlay adds:

- the Research API configuration and Research state volume to the existing
  public Gateway;
- an internal, non-published LLM Gateway whose production GoldenCode pool
  currently enables only direct Aliyun GLM-5.2 with three-call concurrency;
  Qianfan and Tencent remain disabled rollback entries;
- one Worker and one independent maintenance process;
- one Worker-only Brave Search credential for general doctor identity
  discovery; the token is never exposed to the public or internal LLM Gateway;
- separate Research state, verified-backup, internal-LLM-state and log
  volumes.

Max, Codex, OpenRouter, public HTTP proxies, Google Scholar and dynamic Skill
execution are not part of the Research generation path.

The production SLA is a hard ten-minute wall-clock ceiling from API run
creation, not merely Worker active time. The protected Worker environment must
keep `RESEARCH_HARD_DEADLINE_SECONDS` at `570` or lower, the internal Gateway
provider deadline below the Worker call deadline (currently `175000` ms), and
`RESEARCH_SYNTHESIS_SHARD_COUNT=3`. Configuration loading fails closed if the
deadline exceeds 600 seconds.

## Default-closed switches

All four host-side switches default to false:

```text
RESEARCH_PRODUCTION_API_ENABLED
RESEARCH_PRODUCTION_LLM_READINESS_API_ENABLED
RESEARCH_PRODUCTION_WORKER_ENABLED
RESEARCH_PRODUCTION_MAINTENANCE_ENABLED
```

The LLM-readiness switch registers the authenticated Worker readiness route
only on the isolated, non-published LLM Gateway. Enable it only after the
internal service credential exists. Do not enable public API admission until
maintenance has produced a fresh verified backup and the Worker has published
a ready heartbeat. Never set `RESEARCH_ACCEPT_WHEN_WORKER_UNAVAILABLE=true`.

## Required private files

Create these untracked files in the clean production release:

```text
config/research.production.api.env
config/research.production.compose.env
config/research.production.worker.env
config/research.production.llm-gateway.env
secrets/research-production-qianfan-key
secrets/research-production-tencent-key
secrets/research-production-aliyun-key
secrets/research-production-llm-token
secrets/research-production-web-search-key
```

The four env files must be mode `0600`. Provider and service-token files must
be host owner `999:999`, mode `0400`. Compose local secrets do not enforce the
declared uid/gid/mode; verify host metadata.

A new clean source archive does not contain these untracked protected files.
Copy them from the verified current release before the first service recreate,
then check every exact source path and owner/group/mode. `docker compose config`
can validate the rendered model without proving that a later bind/secret mount
source exists. The failed recreate safety check in the `1.6.76` rollout left
the old healthy container running, but this preflight prevents the avoidable
first-attempt failure.

Create the Compose env from
`config/research.production.compose.example.env`. Its four enable switches
must remain false until the corresponding start-order gate below passes.

The Worker example deliberately fails production startup until:

- the NCBI and Crossref contact address is replaced with a monitored operator
  address;
- the external User-Agent placeholder is replaced;
- the backup target's encryption has been verified and
  `RESEARCH_BACKUP_TARGET_ENCRYPTION_CONFIRMED=true`;
- ORCID is either `disabled`, or an approved anonymous/credentialed mode is
  configured.
- `RESEARCH_WEB_SEARCH_PROVIDER=brave` and the Worker-only search secret path
  are configured. New production code rejects `direct` mode so a healthy
  deployment cannot silently regress to registry-only doctor coverage.

With `RESEARCH_ORCID_MODE=disabled`, runs omitting ORCID remain supported.
Requests that explicitly supply ORCID fail identity resolution; the Worker
does not silently ignore an asserted ORCID.

## Preflight and rollback boundary

Before any build or recreate:

1. Confirm the current production container is healthy, has zero unexpected
   restarts and publishes only `127.0.0.1:18787`.
2. Confirm the protected base env contains the exact eight-model registry and
   all four existing provider key names without printing values.
3. Run online SQLite backup for `gateway.db` and `client-events.db`, then
   verify database hashes, integrity and foreign keys.
4. Tag the current production image by timestamp and retain the clean
   `ccccf1c` rollback release.
5. Confirm at least 10 GiB and 10% filesystem free space.
6. Render Compose with `config --quiet`; never print the rendered environment.

The minimum rollback image after writing a `doctor_research` capability remains
the pinned boundary in `phase0.5-compatibility.md`. Rollback must preserve the
Research volume and must not delete completed artifacts.

## Bootstrap the internal LLM credential

Start only `research-llm-gateway`, still leaving the public Research API and
Worker disabled. In its isolated Gateway database:

1. Create a service plan from
   `research.production.token-policy.example.json` and
   `research.production.service-feature-policy.example.json`.
2. Issue a service credential with exactly the `goldencode` public-model
   allowlist and no `doctor_research`, image or admin capability. Its bounded
   rate must cover six calls per run and three concurrent synthesis calls
   (`rpm >= 6`, `rpd >= 6`, `concurrent >= 3`). One 30-second,
   1,000-output-token call is reserved for deriving safe English PubMed terms
   only when verified publications, the official profile and the supplied
   department provide no deterministic English term. The other five slots
   retain the existing three synthesis shards, bounded transport/contract
   retry and concise peer-review/targeted-repair capacity. Common harmless
   envelope differences are normalized deterministically and do not consume
   that retry. Per-run token capacity must cover at least 204,000 input and
   91,000 output tokens with the production per-call ceilings.
3. Grant the service entitlement.
4. Capture the full token only in a mode-`0600` temporary file, atomically
   install the token secret as `999:999`/`0400`, and remove the temporary file.
5. Set `RESEARCH_PRODUCTION_LLM_READINESS_API_ENABLED=true` and recreate only
   `research-llm-gateway`.
6. Verify `/v1/models` from inside the Compose network lists only
   `goldencode`.

## Start order

Use this order:

1. Build all four services from the clean release.
2. Start the internal LLM Gateway, bootstrap its credential, then enable only
   its isolated LLM-readiness API switch.
3. Start maintenance with only
   `RESEARCH_PRODUCTION_MAINTENANCE_ENABLED=true`.
4. Wait for a successful verified backup and healthy maintenance.
5. Start the Worker with `RESEARCH_PRODUCTION_WORKER_ENABLED=true`.
6. Wait for live PubMed/Crossref/general-identity-search/direct-GLM preflight
   and a current ready heartbeat.
7. Recreate only the public Gateway with
   `RESEARCH_PRODUCTION_API_ENABLED=true`.
8. Verify the ordinary eight-model surface and existing Gateway smokes before
   granting a beta user.

## Beta user and real E2E

Create a dedicated production beta plan with only `doctor_research`. Grant it
only to named, approved beta users; do not add the capability to a shared
existing plan.

Every real user handoff must record a name and phone number. Store the full API
key only in an approved local handoff file or private channel. Console, logs,
documents and tickets remain prefix-only.

Run the smoke from the VM against literal loopback
`http://127.0.0.1:18787`, using separate mode-`0600` token, request and output
paths. Success requires:

- `POST -> heartbeat/lease -> live sources -> GoldenCode/GLM-5.2 ->
  validation -> succeeded`;
- `GET result`;
- exactly four manifest entries and downloads;
- exactly three Markdown files and one five-line text file;
- downloaded sizes and SHA-256 values equal the manifest;
- measured create-to-terminal wall time below 600 seconds;
- one bounded three-call synthesis fan-out and at most six total model calls;
  the optional first call may only derive bounded English search terms;
  the last calls may be a targeted correction, hash-bound section repair or
  compact peer review according to deterministic diagnostics;
- a rendered 3-8-row core evidence table and no partial artifact publication.

Then verify the public HTTPS status/result/download path, foreign-subject
uniform `404`, encoded traversal rejection, cancellation convergence,
stale-heartbeat `503`, backup creation and isolated restore.

After collecting the release evidence, revoke the E2E credential, disable its
temporary user and remove its mode-`0600` token/request files. Never hand an
E2E credential to a beta user; provision a new named credential with recorded
phone metadata instead.

For `1.6.72`, non-stream cancellation was also tested through public HTTPS for
both `/v1/chat/completions` and `/v1/responses`. Each deliberate disconnect
recorded `client_aborted`, `terminal_source=client_abort`,
`cancel_requested=1` and `cancel_observed=1`; temporary users and credentials
were disabled/revoked, and no token reservation remained unfinalized.
After the `a77cf01` deployment, a normal non-stream provider call explicitly
recorded `cancel_requested=0` and `cancel_observed=0`, while fresh Chat and
Responses disconnects again recorded `1/1`. Runtime inflight requests and
unfinalized reservations returned to zero, all four containers remained
healthy with zero restarts, and the temporary credential was revoked and its
user disabled.

## Rollback

If the public Gateway, eight-model registry, Worker readiness, backup,
admission or E2E check fails:

1. Set `RESEARCH_PRODUCTION_API_ENABLED=false` and recreate only Gateway.
2. Stop Worker and maintenance with their 45-second grace period.
3. Restore the previous Gateway image/release without deleting Research
   volumes.
4. Re-run ordinary health, auth, models, chat, Responses and strict-tools
   smokes.
5. Keep failed Research runs and sanitized logs for review; do not fabricate a
   success or publish partial artifacts.
