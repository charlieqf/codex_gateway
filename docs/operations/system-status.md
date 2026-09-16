# System Status

Last verified: 2026-09-16 00:18 UTC (10:18 Sydney): MedEvidence Desktop beta.76 minimum-version rollout, public Phone Auth and conversation smoke, active Phone identity readiness, all three databases and all six runtime containers.

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

Gateway, Compose and container health verified on 2026-09-16; local inference behavior last verified on 2026-09-06:

- `current`:
  `3dcc3cc9517641a599faa61479cb50545c6abd3f` (pinned runtime source committed and pushed to `main`; `d29dcb1` only updates operator smoke scripts)
- `previous`:
  `8f3e4b00447a5443cfc0433f991bd4047f68f2af` (schema 30 compatible previous Gateway release; Research Worker remains on `0bfb985`)
- Gateway release source: `origin/main`; pin and verify its latest commit before deployment.
- Public Gateway: healthy, published only on
  `127.0.0.1:18787->8787`
- Research Worker and Research LLM Gateway: healthy, without published host ports
- Research maintenance: healthy with zero restarts, checked 2026-09-11 01:04 UTC.
  Its missing temporary-smoke files were reproduced byte-for-byte from stored
  results and restored; the original container completed a verified backup at
  00:51:32 UTC. Audit-retained records were preserved. Gateway and Worker versions
  did not change. See [recovery evidence](../../artifacts/doctor-research-agent-2026-09-10/maintenance-recovery-verified-20260911.json).
- `qwen38-fp8-local`: healthy, private container port only

Gateway runs `3dcc3cc`, schema 30, deployed 2026-09-16 00:08:41 UTC from a pinned
`main` commit. At 00:14:44 UTC its Desktop gate was independently changed to
`medevidence_all` with minimum `2.0.0-beta.76` and the stable public installer URL.
Phone Session routes require the explicit MedEvidence version header; identified
Desktop credentials and registered Phone subjects are also gated on resolver,
credentials/current, `/v1/*`, Research, image and Vision routes. Service/operator
credentials and shared clients not identified as MedEvidence remain outside that
product-scoped gate. Upgrade responses return both structured `download_url` and
the full URL in the visible message for old-client compatibility.

The pinned Linux image passed 28 quota tests and 595 Gateway/Store tests; the local
full suite passed 1,381 tests with 3 skipped. Public acceptance proved two real
Desktop-class `1.9.116` conversation requests receive 426, while beta.76 completed
Phone enrollment, login, bootstrap, resolver/current and one 135-token model call.
Both synthetic accounts were disabled with zero active credentials, sessions or
unfinished reservations. The post-smoke aggregate found 294 active Phone identities
and zero inactive Subject, unhealthy current Key/backing credential or missing active
chat entitlement among them. All three databases passed integrity/FK checks, Gateway
is healthy with zero restarts, and the other five containers were unchanged. See the
[beta.76 rollout and recovery runbook](./medevidence-minimum-version-beta76-2026-09-16.zh-CN.md).

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
The Research Worker remains on `0bfb985` with the practical-profile workflow;
its container and the other four supporting services were unchanged and healthy.
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

Image generation remains separate under client model
`medcode-image-default`; its primary upstream is the external
`llada-image-turbo-fp8` API, with `gpt-image-2` retained as the first fallback.

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
