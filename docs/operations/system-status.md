# System Status

Last verified: 2026-08-31.

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

Read-only verification on 2026-08-31:

- `current`:
  `6a9ae87d34b39809b97e0904e01cb62919bd7e89`
- `previous`:
  `e4f27d31324cbddfb1052b19d4fce2d181afa8be`
- Public Gateway: healthy, published only on
  `127.0.0.1:18787->8787`
- Research Worker, Research LLM Gateway and Research maintenance: healthy,
  without published host ports
- `qwen38-fp8-local`: healthy, private container port only

The public text surface contains:

- `goldencode`: Tencent GLM-5.3 cloud route
- `goldencode-local`: R760 Qwen3.8-27B-FP8 local route

Image generation remains separate under client model
`medcode-image-default`.

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

1. Complete installed-Desktop compact/rebuild/one-shot-retry validation for
   `goldencode-local`.
2. Preserve private local inference and independent local health.
3. Keep public and Research provider boundaries separate.
4. Complete separately approved rotation of any previously exposed secrets.

## Documentation Rule

Use [Runbook Index](./runbook-index.md) to choose one task-specific document.
Current facts belong here; detailed execution belongs in a runbook; completed
incident history belongs in a dated report or Git history.
