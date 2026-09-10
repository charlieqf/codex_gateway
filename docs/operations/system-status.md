# System Status

Last verified: 2026-09-10 (vision limits/recovery release, compiled image smoke, public health and Compose services).

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

Gateway and Compose verification on 2026-09-10; local inference verification on 2026-09-06:

- `current`:
  `8dab89da424ce722df2c433d52132e19707536b9`
- `previous`:
  `31946c97954af05399582010f5da7589204aac4b`
- Public Gateway: healthy, published only on
  `127.0.0.1:18787->8787`
- Research Worker, Research LLM Gateway and Research maintenance: healthy,
  without published host ports
- `qwen38-fp8-local`: healthy, private container port only

Gateway runs `8dab89d`; Research Worker remains on the existing runtime with
Doctor Research Skill `1.6.119`. Three overseas doctors with the original Chinese institution inputs
and one Chinese doctor passed public execution and all 16 artifact downloads.
Results retain source and literature quality warnings. Release evidence:
[Doctor Search overseas repair](../research/doctor-research/overseas-doctor-release-2026-09-07.zh-CN.md).

The [timeout observability release](./r760-timeout-observability-release-2026-09-08.zh-CN.md)
preserves interrupted stream progress and classifies header/body read timeouts.
Public success/deadline tests and ordinary-user admin correlation passed;
synthetic body-timeout tests passed during that release.

The [Billing compatibility release](./r760-billing-create-compatibility-release-2026-09-09.zh-CN.md)
preserves May's POST /subjects contract and makes resolve optional. Passing phone
directly enables account linking and atomic new-phone provisioning with a
daily free entitlement and phone enrollment; the optional two-step
flow remains supported. Legacy requests without phone or prior resolve retain
original Billing behavior. Desktop reuses phone-auth v1 after external SMS login;
external-token v2 is withdrawn. Configuration and schema 28 remain unchanged.
The [2026-09-10 free-quota release](./r760-phone-signup-free-10k-release-2026-09-10.zh-CN.md)
temporarily sets new signups to `plan_free_daily_10k_v1` (10,000 tokens/day).
Existing 1M/day and other grants retain their original Plans, keys and snapshots.

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
The actual image passed 16 isolated route cases, all 574 Linux tests passed, and
control data/configuration/schema 28 remain unchanged. Gateway work did not modify
Desktop source or packages. Its team separately reports image-budget fixes and 203
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
