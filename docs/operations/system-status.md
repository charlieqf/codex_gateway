# System Status

Shared Qwen / RADAR scheduling enabled: 2026-09-22 05:03:25 UTC;
service checks completed at 05:04:40 UTC. Star runs scheduler/Qwen `58a4d80`
and RADAR `20a3710300`, with `mode=enforce` and required tickets in both APIs.
GPU0 serves images; GPU1 prioritizes CT without preemption. Host memory admission
may serialize tasks. The final 68 Linux mock tests passed; two real model
initialization leases completed, but no generation or CT inference test was
submitted during this rollout. IndexTTS remains outside the shared lock and its
process is unchanged. See the [scheduler release receipt](./star-qwen-radar-scheduler-release-2026-09-22.zh-CN.md).

Image inference last verified: 2026-09-22 02:50 UTC (before shared scheduling). The public model
`medcode-image-default` uses two local `qwen-image-2.1` workers on star GPUs 0/1
through a bounded private queue and the existing authenticated SSH tunnel.
LLaDA is stopped/disabled and removed from the fallback chain; GPT Image 2 is
the first cloud fallback. Two square images completed concurrently in 64.0 s
versus a 59.5 s single baseline; four queued images completed in 128.5 s.
Public square JPEG, landscape PNG, portrait WebP and ordinary text passed.
Installed MedEvidence client acceptance is pending; the user will
forward the [client test notice](../outbox/medevidence-qwen-image-21-primary-test-notice-2026-09-22.zh-CN.md).
See the [dual-GPU release receipt](./qwen-image-dual-gpu-release-2026-09-22.zh-CN.md)
and [controlled Chinese-label comparison](./qwen-image-label-prompt-comparison-2026-09-22.zh-CN.md).

Last verified: 2026-09-21 07:04 UTC: imaging v1 admits only the explicitly approved Subjects `subj_yBZBxNUHIVszGz4BKXaltrw5` and `subj__3nJpw9INwhmK4k8Qq4K4jlI`; schema 34. Both existing credentials return available:true, with independent limits of 10 jobs per UTC day and one unfinished job per Subject. Other Subjects remain unavailable. See [latest allowlist verification](../../artifacts/imaging-gateway-20260921/pilot-wang-activation.json). Earlier temporary test studies, credentials and entitlements were cleaned up as recorded in the [joint audit](../../artifacts/imaging-gateway-20260921/joint-final-audit.json). Phone readiness was last checked on 2026-09-18: 300/300 active identities ready, with no duplicate-phone groups.

xAI proxy routing additionally verified 2026-09-14 03:03 UTC: dedicated
`api.x.ai -> XAI-EGRESS` priority fallback with two tested leaf nodes, xAI HEAD
health checks every 60 seconds, no public proxy/controller ports. Config-only
SIGHUP rollout; Gateway/Mihomo/Research/Qwen containers unchanged and healthy.
See the [xAI egress rollout](./xai-egress-rollout-2026-09-14.zh-CN.md).

This file contains current operational state only. Dated release reports and Git
history retain implementation evidence; do not append incident history here.

## Authority

- R760 is the only supported Gateway runtime, control plane, usage authority
  and Desktop client-message source.
- Supported origin:
  `https://goldencode.instmarket.com.au:1443`
- The former Azure Gateway is logically offline. It is not a client endpoint,
  compatibility target, control mirror, usage source or rollback gate.
- CN1's retained loopback Gateway and dark edge are not public authorities or
  fallbacks.

## Production Runtime

Gateway config-only activation, public health and dual Qwen inference verified on 2026-09-22 02:50 UTC:

- `current`:
  `f8c1a943d31769125fb80574b22eab6f6c74b06f` (pinned runtime source committed and pushed to `main`; schema 34)
- `previous`:
  `a06d5221b1ced1c91d4a1b4fbd2f968ec6b3b131` (same schema 34; retains the imaging audit INSERT fix; rollback also restores the saved image-provider environment and Compose override)
- Gateway release source: `origin/main`; pin and verify its latest commit before deployment.
- Public Gateway: healthy, published only on
  `127.0.0.1:18787->8787`
- Research Worker and Research LLM Gateway: healthy, without published host ports
- Research Worker: independently deployed `2c561f5a1fe3250c99bbd5bc8c5c80adfb688f9a`; unchanged by this Gateway release.
- Research maintenance: `44c7bdd76d47ea434e006e9ea4dc7d3482df4383`, healthy with zero restarts and unchanged by this Gateway release.
- Research maintenance: healthy with zero restarts, checked 2026-09-11 01:04 UTC.
  Its missing temporary-smoke files were reproduced byte-for-byte from stored
  results and restored; the original container completed a verified backup at
  00:51:32 UTC. Audit-retained records were preserved. Gateway and Worker versions
  did not change. See [recovery evidence](../../artifacts/doctor-research-agent-2026-09-10/maintenance-recovery-verified-20260911.json).
- `qwen38-fp8-local`: healthy, private container port only

Gateway runs `f8c1a94`, schema 34. Imaging v1 defaults off in code and currently
admits only the two approved Subjects above. Full public CT upload, new inference, 15 verified artifacts, owner
isolation, resume, cancellation and deletion passed through the public Gateway.
The source client also completed ordinary-chat tools, inference, verified download
and HTML generation/browser review. This does not certify a newly installed Desktop
release. The audit INSERT defect found during the first run was fixed and the full
CT flow repeated on the final revision. The dedicated Nginx imaging configuration
was explicitly approved and smoothly reloaded at 06:36 UTC. Its include is pinned
to the a06d522 release; syntax, public health, 8 MiB limit and edge log isolation
passed. Preserve this include on program rollback. See [Nginx evidence](../../artifacts/imaging-gateway-20260921/nginx-acceptance.json), the
[Gateway imaging receipt](../outbox/medevidence-imaging-gateway-receipt-2026-09-21.zh-CN.md)
and [activation runbook](./imaging-v1.md).

The vision refresh route
`POST /gateway/vision/assets/:assetId/read-url` uses its independent subject
budget: 20 concurrent requests, 1,920 per fixed UTC minute and 80,000 per UTC day.
Keys and sessions belonging to the same subject share this budget; ordinary
credential counters remain separate. Cancelled refreshes retain capacity until
their asynchronous storage work settles. These are in-memory single-process
protection windows, cleared by restart, not billing ledgers.

The pinned Linux image passed 1,558 tests (3 existing external-fixture tests
skipped), including 18 imaging tests. Root request logging redacts the entire
imaging path/query and also redacts image asset identifiers, queries and unknown
tails for image asset paths, including wrong methods, encoded paths and unmatched
routes; actual routing and admission remain unchanged. All eight unauthenticated
public request-log checks passed, with no test fixtures created. See the
[asset log redaction receipt](./r760-vision-log-redaction-release-2026-09-20.zh-CN.md)
for authenticated integration coverage and the application-log scope.

The preceding image-budget release passed 204 public HTTP response assertions, a client abort,
8/20/40-refresh batches, ordinary-limit isolation and a 135-token GoldenCode call.
All 16 synthetic public-test assets were deleted and verified absent; the earlier
storage preflight also deleted all 40 assets. Both test subjects are disabled,
all three credentials revoked, both entitlements cancelled, and no reservations
remain pending. Temporary plaintext credential files were removed. See the
[image read-URL release receipt](./r760-vision-read-url-release-2026-09-20.zh-CN.md)
for cleanup, backup, capacity and rollback evidence. Refresh operational logs
use route templates; Docker retains at most five 50 MB log files, not a fixed
number of days.

Identity HTTP outcomes retain one final audit writer; phone/IP/device rejections
use fixed-cardinality minute counters. Durable manual issuance and transactional
security audits are unchanged. The
[identity audit release receipt](./r760-identity-request-audit-release-2026-09-18.zh-CN.md)
records its separate validation and performance limits. Identity retention
targets remain 30/7 days with bounded cleanup of 720,000 rows per table per day.

Phone readiness reports 300/300 active identities passing identity/runtime
checks, zero duplicate-phone groups and no new audit-write/prune errors. The
read-only check deliberately excludes entitlement evaluation. New HTTP audit
coverage begins with the first recorded request at 08:36:50 UTC; legacy events
are not backfilled or treated as complete historical HTTP outcomes.

The Desktop gate remains `medevidence_all`, minimum `2.0.0-beta.76`, using
`https://updates.instmarket.com.au/desktop-updates/download/?minimum=2.0.0-beta.76`.
Platform availability is owned by that page's update manifests. This Gateway
release leaves both the minimum and the platform-neutral URL unchanged; its
public smoke verifies the upgrade response, not desktop package hashes.
Phone Session routes require the explicit MedEvidence version header; identified
Desktop credentials and registered Phone subjects are also gated on resolver,
credentials/current, `/v1/*`, Research, image and Vision routes. Service/operator
credentials and shared clients not identified as MedEvidence remain outside that
product-scoped gate. Upgrade responses return both structured `download_url` and
the full URL in the visible message for old-client compatibility.

The previous `8f3e4b0` release split the entrypoint into focused modules; A/S transport is
configured only for the synthetic subject `subj_NWGR8SNzAnybXZPUro0S3k3p`, now
disabled after acceptance. `GATEWAY_BOUNDED_WRITE_MODE=delivery`, the subject
allowlist contains only that account, and maximum delivery concurrency is 2.
No real-user A/S rollout has occurred. B/C remain disabled; Desktop file commit,
journal/crash recovery and mixed-load acceptance remain outstanding. The pinned
Linux build passed 922 tests and 60 contract checks. Public ordinary write, S
overwrite/append, A legacy/unknown-schema, short Chat/Responses, credential and
vision capability checks passed; S reconstructed bytes matched the supplied text
and each accepted A/S case used one provider call. All three databases passed
integrity/FK checks, existing control rows were unchanged, and all six containers
were healthy. See the [A/S deployment receipt](./r760-bounded-write-release-2026-09-15.zh-CN.md),
including the one in-flight request without a completion receipt at cutover.

The retained phone enrollment behavior was deployed on September 14:
Billing resolve and direct signup with phone enroll eligible
legacy subjects using their existing Desktop key; identity conflicts fail explicitly.
The fixed source passed 623 Linux tests, 24 public HTTP checks and a real 135-token
model call. All pre-existing subject, credential, key, plan, entitlement and phone
identity rows were preserved; synthetic accounts were disabled and cleaned up.
See the [phone enrollment release](./r760-phone-enrollment-release-2026-09-14.zh-CN.md),
including the two in-flight requests without completion receipts during the authorized restart.
At that September 14 release the Research Worker remained on `0bfb985` with the
practical-profile workflow. Its current independently deployed revision is listed above.
New signups receive the one-off
`plan_free_once_1m_v1` allowance (1,000,000 tokens for the account lifetime, no reset,
no re-grant on purchase); the 25 active daily Free grants were migrated in place with
their month-window usage carried over once. The paid templates now read monthly
5M/day and 150M per billing period, yearly 6M/day and 200M per UTC calendar month;
existing paid snapshots are unchanged. Old images cannot be rolled back after schema 30.
See the [one-off Free release](./r760-free-once-release-2026-09-11.zh-CN.md) and the
[Free contract v2](../outbox/medevidence-free-once-quota-contract-2026-09-11.zh-CN.md).
The private Research LLM Gateway runs `2126e7c`; it was
unchanged by this release and remains healthy. The earlier
[repair report](./doctor-research-discovery-repair-2026-09-10.zh-CN.md) and
[generalization audit](./doctor-research-generalization-audit-2026-09-10.zh-CN.md)
describe the diagnostic history before the practical-profile flow.

The [timeout observability release](./r760-timeout-observability-release-2026-09-08.zh-CN.md)
preserves interrupted stream progress and classifies header/body read timeouts.
Public success/deadline tests and ordinary-user admin correlation passed;
synthetic body-timeout tests passed during that release.

The [Billing compatibility release](./r760-billing-create-compatibility-release-2026-09-09.zh-CN.md)
preserves May's POST /subjects contract and makes resolve optional. Passing phone
directly enables account linking and atomic new-phone provisioning with a
one-off free entitlement and phone enrollment; the optional two-step
flow remains supported. Legacy requests without phone or prior resolve retain
original Billing behavior. Desktop reuses phone-auth v1 after external SMS login;
external-token v2 is withdrawn. The current schema 30 also supports independent Free/paid accounting.
The temporary `plan_free_daily_10k_v1` default and all earlier daily Free grants
were superseded by the one-off allowance above: the 25 active daily allowances
were migrated to `plan_free_once_1m_v1` with their month-window usage carried
over once; cancelled/expired historical grants keep their original snapshots.

Current paid templates (updated 2026-09-11 10:41 UTC, see the
[paid quota adjustment](./medevidence-plan-quota-adjustment-2026-09-11.zh-CN.md)):
`plan_paid_monthly_v1` is 5M/day and 150M per billing-period month;
`plan_paid_yearly_v1` is 6M/day and 200M per UTC calendar month with no yearly
cap. Annual purchases use Billing `one_off` with explicit one-year start/end
dates; monthly purchases anchor their month window to the billing period. See
the [monthly/yearly purchase handoff](../outbox/medevidence-monthly-yearly-purchase-api-2026-09-10.zh-CN.md),
including outstanding credential-expiry coverage before full annual-payment acceptance.
The Free/paid dual-ledger accounting from the
[Free/paid accounting release](./r760-free-paid-quota-release-2026-09-10.zh-CN.md)
still applies: paid requests borrow the remaining one-off Free first, and the
base Free entitlement survives paid expiry and `replace_current=true` purchases.
Client display fields are in the
[Free/paid quota contract](../outbox/medevidence-free-paid-quota-contract-2026-09-10.zh-CN.md)
as amended by the [one-off contract v2](../outbox/medevidence-free-once-quota-contract-2026-09-11.zh-CN.md).
Do not roll back directly to a program that assumes one active entitlement;
recovery must preserve and understand both ledgers.

The [quota review fixes](./r760-quota-review-fixes-release-2026-09-11.zh-CN.md)
preserve future renewals on default cancellation and reject conflicting resets
with `409 quota_reset_conflict` until shared requests settle. The Gateway dashboard
shows both balances and uncapped usage. Missing default Free templates are initialized
atomically; explicitly deprecated templates fail the paid grant when a new Free is needed.
The contract now accurately states Free missing-usage `estimate` and paid `none`;
existing snapshots are unchanged. Public Billing lifecycle and a real model request
passed, along with 600 Linux tests. Existing control rows were preserved, and the
synthetic account was disabled with all credentials revoked. The separate Research
maintenance outage was recovered on September 11; all six runtime containers were
healthy during the September 14 phone enrollment audit.

The [model error copy release](./r760-model-error-copy-release-2026-09-10.zh-CN.md)
describes failed vision/text operations in Chinese, with separate processing,
connection, timeout and provider-access messages. Error codes, request IDs and
retry contracts remain compatible with installed clients. Runtime fault injection
and public health checks passed; existing control data and other services are unchanged.

The [vision limits and recovery release](./r760-vision-limits-recovery-release-2026-09-10.zh-CN.md)
provides structured image/body limits and authenticated `/gateway/vision/capabilities`.
Only vision requests declaring `x-medcode-vision-recovery-contract: 1` use bounded
recovery: initial generation, tool repair and same-service retry share two calls
and one deadline. Final failures carry the strict client stop contract. The image
limit stays at eight; installed clients without the header retain their retry behavior.
Its isolated route acceptance is recorded in that release report. The current
release retains these behaviors and passed 623 Linux tests. Gateway work did not
modify Desktop source or packages. Its team separately reports image-budget fixes and 203
passing tests; alignment with the new image-limit fields and opt-in header, followed
by EXE/PPT acceptance, remains pending. See the joint contract's delivery review.

The public text surface contains:

- `goldencode`: Tencent GLM-5.3 only; TianKuan is disabled pending payment and explicit restoration.
- `goldencode-local`: R760 Qwen3.8-27B-FP8 local route

The [TianKuan suspension record](./goldencode-tiankuan-suspension-2026-09-07.zh-CN.md)
contains the provider-disable decision. The [Gateway failover release](./goldencode-failover-release-2026-09-07.zh-CN.md)
enables P0 for all `goldencode` text requests while retaining Tencent as the only
enabled member. Provider quota cooldown remains disabled. Cross-provider public
acceptance awaits TianKuan restoration; Tencent-only public acceptance passed.
The [terminal retry contract](./goldencode-terminal-retry-contract-2026-09-07.zh-CN.md)
is deployed and publicly verified: final provider failures explicitly stop supported
clients from automatically replaying the request.

Image generation remains separate under client model `medcode-image-default`.
Its primary upstream is the local `qwen-image-2.1` pool on star GPUs 0/1,
followed by the existing `gpt-image-2` cloud fallback chain. LLaDA is neither
running nor configured as a fallback. Star runs committed release `58a4d80`;
the Gateway image remains `f8c1a94`. Two workers and two waiting slots have a
170-second pool deadline and an 80-second queue wait cap. Worker admission is
at most 80 C, with generation stopped at 88 C. Qwen upstream timeout is 180 s;
Gateway's existing overall image timeout is 240 s. The client's current 210 s
budget can expire first on long cloud fallback paths; this is in the handoff.
Qwen listens only on star loopback; R760 reaches it through an authenticated,
restricted-key SSH tunnel bound to its private Docker bridge. Workers, pool
and tunnel are enabled at boot. No new public port was opened.
The image and RADAR APIs now use the shared resource scheduler. GPU1 is CT-first;
host memory reservations can reduce concurrency. Use the scheduler receipt's
GPU0-only Qwen rollback, which preserves RADAR on GPU1 and never restores LLaDA.

## GoldenCode Local Context Admission

Release `6a9ae87` enforces exact vLLM token admission:

- model context: 32,768 tokens
- maximum requested output: 8,192 tokens
- oversized request response: HTTP 413
  `context_compaction_required`
- generation and token reservation are not started for a rejected request
- client recovery contract: compact, rebuild and retry once

The pinned Du Heng replay verified 24,577 prompt + 8,192 output = 32,769,
overflowing the limit by one token. Full deployment evidence is in
[GoldenCode Local context admission release](./goldencode-local-context-admission-release-2026-08-30.zh-CN.md).

## GoldenCode Local Tool Output Limit

Release `14935735` adds a client-recoverable terminal contract for a malformed
tool call that reaches the request output-token ceiling:

- HTTP 502 `tool_call_output_truncated`
- `failure_kind=confirmed_output_limit`
- `retryable=false`, `transformed_retry_allowed=true`
- `recommended_action=compact_and_generate_in_chunks`
- `recovery_owner=client`
- no same-model validation repair after the token ceiling is confirmed

The Du Heng failure-shape regression pins both recorded argument sizes
(`24,024` and `22,209` bytes) and requires one upstream attempt. The production
read-result replay also returned the structured contract with one attempt.
Detailed evidence and the remaining Desktop recovery failure are in
[GoldenCode Local tool-output truncation release](./goldencode-local-tool-output-truncation-release-2026-08-31.zh-CN.md).

## Desktop Client Messages

Routine user/time-window queries must start with:

```powershell
$cutoff = (Get-Date).ToUniversalTime().AddHours(-48).ToString("o")
python scripts\query-client-messages.py `
  --user "<name>" --since $cutoff --timezone Asia/Shanghai `
  --limit 500 --include-text --format json
```

The authoritative stores are:

- `/var/lib/codex-gateway/gateway.db`
- `/var/lib/codex-gateway/client-events.db`

The authenticated admin page
`/gateway/admin/client-messages` and its JSON route add exact
`subject_id + client_message_id` request correlation, outcome, duration,
token and attempt summaries.

Do not read general deployment history before this query. Do not inspect Azure,
restart services, synchronize databases or run ad-hoc SQL for routine support.

## Control And Usage

- Real-user key issue:
  `scripts/issue-real-user-cgu-key.py`
- Guarded R760 changes:
  `scripts/manage-r760-gateway-control.py`
- Usage:
  `scripts/check-daily-usage-health.py`
- Real-user RPM floor: 20
- Phone Auth is enabled for the approved production population; legacy
  `cgu_live_*` credentials remain supported.
- Routine Azure control/usage synchronization is retired.

## Current Open Work

1. Fix and complete installed-Desktop compact/rebuild/one-shot-retry and
   chunked-write recovery for `goldencode-local`; the current source E2E still
   terminates after a post-compaction `context_compaction_required` response.
2. Preserve private local inference and independent local health.
3. Keep public and Research provider boundaries separate.
4. Complete separately approved rotation of any previously exposed secrets.

## Documentation Rule

Use [Runbook Index](./runbook-index.md) to choose one task-specific document.
Current facts belong here; detailed execution belongs in a runbook; completed
incident history belongs in a dated report or Git history.
