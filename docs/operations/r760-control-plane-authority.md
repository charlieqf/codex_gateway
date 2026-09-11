# R760 Gateway Control-Plane Authority

Last updated: 2026-09-11.

## Authority Boundary

R760 is authoritative for:

- real-user `cgu_live_*` issuance;
- user and credential state;
- Plan and entitlement changes;
- Gateway usage reports;
- Desktop client-message telemetry.

The former Azure Gateway is logically offline. Do not run routine control
mirrors, usage merges or dual-endpoint validation. A separately authorized
historical recovery may inspect retained assets but does not make them part of
normal operation.

## Real-User Key Issuance

```powershell
python scripts\issue-real-user-cgu-key.py `
  --name "<real name>" --phone "<phone>"
```

The script creates and validates the R760 Subject, backing credential,
entitlement, capabilities and unified-key handoff. Full keys remain only in the
protected local handoff and approved private delivery channel.

The Desktop E2E issue script is a test helper, not a real-user delivery path.
The legacy `provision-medevidence-codex-key.ps1` and Azure synchronization
scripts are historical recovery tools.

## User, Credential, Plan And Entitlement Changes

Use only the guarded wrapper:

```powershell
python scripts\manage-r760-gateway-control.py --what-if -- disable-user <user>
python scripts\manage-r760-gateway-control.py -- disable-user <user>
```

For supported writes it must:

1. identify an explicit R760 target;
2. show a dry-run where available;
3. create and verify a pre-write online SQLite backup;
4. execute only the allowlisted admin operation;
5. verify SQLite integrity and foreign keys;
6. validate the R760 result without Azure.

Do not substitute raw SQL or an ad-hoc admin command for an available guarded
operation.

For an explicitly authorized in-place Plan token-policy change, the wrapper
also supports an expected-old-value guard (arguments: Plan ID, expected and new
monthly values, and optionally expected and new daily values; `none` means
unlimited):

```powershell
python scripts/manage-r760-gateway-control.py --what-if -- set-plan-token-limits plan_paid_monthly_v1 50000000 150000000
python scripts/manage-r760-gateway-control.py -- set-plan-token-limits plan_paid_monthly_v1 50000000 150000000
python scripts/manage-r760-gateway-control.py -- set-plan-token-limits plan_paid_yearly_v1 none 200000000 none 6000000
```

This operation changes only `plans.policy_json.tokensPerMonth` (and
`tokensPerDay` when daily values are provided), writes an admin audit event in
the same transaction, and verifies that existing entitlement policy snapshots
remain unchanged. It validates the existing immutable-policy trigger,
temporarily drops it under the transaction's write lock, and restores the exact
definition before commit; any failure rolls back both data and DDL. The
existing backup and integrity gates
still apply. New purchases and renewals read the updated Plan; existing grants
retain their snapshots. Migrating existing grants is a separate operation.

## Usage

```powershell
python scripts\check-daily-usage-health.py --format json
```

This queries R760 directly. Do not run
`sync-azure-r760-gateway-usage.py` as a reporting prerequisite and do not add
physically retained legacy events to current totals.

## Desktop Client Messages

Client-message storage is support telemetry, not the billing ledger:

```powershell
$cutoff = (Get-Date).ToUniversalTime().AddHours(-48).ToString("o")
python scripts\query-client-messages.py `
  --user "<user>" --since $cutoff --timezone Asia/Shanghai `
  --limit 500 --include-text --format json
```

See [Desktop User Message Query](./client-message-query-support.zh-CN.md).
Routine queries are read-only and must not print phone numbers or credentials.

## Retained Azure Assets

Logical shutdown is already the operating state. Physical VM/container deletion
is a separate maintenance action because the shared VM may retain unrelated
services and audit assets. It requires explicit inventory, ownership, backup
and authorization.
