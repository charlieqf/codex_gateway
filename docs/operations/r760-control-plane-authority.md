# R760 Gateway Control-Plane Authority

Last updated: 2026-09-17.

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

## Explicitly authorized one-off Free total reset

The Billing quota-reset API currently accepts minute/day/month windows; those
do not reset the lifetime `period` ledger of `plan_free_once_1m_v1`.
For a user-authorized reset of a Free-only account, use the guarded operation:

```powershell
python scripts/manage-r760-gateway-control.py --what-if -- reset-free-total <subject-id> <entitlement-id> <expected-used> 1000000 <reason>
python scripts/manage-r760-gateway-control.py -- reset-free-total <subject-id> <entitlement-id> <expected-used> 1000000 <reason>
```

It requires an active matching subject and one-off Free entitlement, the exact
previous used value and total limit, no other live entitlements, and no unfinished
reservations (including expired reservations awaiting settlement). After the
verified backup, a write transaction rechecks these conditions, removes only
that entitlement's lifetime usage window, and records its complete before image
in a `quota-reset` admin audit event. Historical requests, settled reservations,
other usage windows, credentials and Plan policies remain unchanged. A retry
with the old expected usage fails. The wrapper checks integrity and foreign keys
afterward; separately verify the account balance through the live Gateway.

## Existing Unified Key Expiry Extension

`update-key --expires-at` updates the backing Gateway credential only. To
extend an existing recoverable current unified Key after the backing credential
and entitlements have been renewed, use an explicitly authorized plan:

```json
{
  "version": 1,
  "reason": "Approved expiry renewal",
  "items": [{
    "subjectId": "<exact-subject-id>",
    "keyId": "<exact-current-unified-key-id>",
    "expectedExpiresAt": "2026-10-01T00:00:00.000Z",
    "expiresAt": "2027-01-01T00:00:00.000Z"
  }]
}
```

```powershell
python scripts/manage-r760-gateway-control.py --what-if -- extend-unified-key-expiry .tmp/approved-renewal.json
python scripts/manage-r760-gateway-control.py -- extend-unified-key-expiry .tmp/approved-renewal.json
```

The wrapper reads the plan once, previews it, verifies a pre-write backup, then
rechecks every target in one write transaction. It requires the exact old
expiry, an active subject, one current recoverable desktop Key, its matching
active phone identity, a backing credential covering the new expiry, and
continuous code/chat entitlement coverage. It only extends unexpired Keys.
Any mismatch or audit failure rolls back the whole batch. The operation changes
only the unified Key expiry and adds a per-Key `update-key` audit event with
operation `extend-unified-key-expiry`; existing tokens and bindings remain valid.
The original plan fails its expected-old-value check after a successful apply.

Afterward verify the new expiry through unified-key resolve, the backing
credential through `/gateway/credentials/current`, and the selected upstream
through `/validate-key`, using the required Desktop version header. Keep all
tokens in memory and emit only sanitized results. The 2026-09-17 closure
record (`docs/operations/oct1-expiry-closure-check-2026-09-17.zh-CN.md`) names
the affected users and is kept locally, outside the public repository.

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
