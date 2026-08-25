# R760 Gateway Control-Plane Authority

Last updated: 2026-08-25

## Authority boundary

R760 is the authoritative endpoint for these operations:

- real-user `cgu_live_*` issuance;
- user enable/disable and credential revoke/update;
- plan and entitlement changes;
- current and historical Gateway usage queries.

The former Azure Gateway is logically offline. Its VM, DNS, containers and
databases may still be physically present or running, but they are not a
supported endpoint, compatibility target, control mirror, usage source or
rollback condition.

```text
control writes: operator -> R760 authority
usage history:  R760 events -> R760 authority
```

Do not run routine cross-environment mirror or usage-merge workflows. Never
copy a complete retained database over R760. A separately authorized historical
data-recovery investigation may inspect retained assets, but it does not make
them part of normal operation.

## Real-user key issuance

Use only the formal R760 issue script and pass the Desktop version being
validated:

```powershell
python scripts\issue-real-user-cgu-key.py --name "<real name>" --phone "<phone>" --client-version "<strict-semver>"
```

The script performs the R760 create, resolve, backing
credential, entitlement and capability checks, and marks the local handoff as
`authority_mode=r760_only`. It has no compatibility mirror or dual-endpoint
path. The retained `--r760-only` option is a deprecated no-op for existing
operator command compatibility.

The historical `issue-desktop-e2e-opaque-key.ps1` now also defaults to R760,
but remains a diagnostic/E2E helper and is not approved for real-user delivery.
`provision-medevidence-codex-key.ps1` is a retained legacy recovery tool; it is
not a current authority path.

## User, credential, plan and entitlement writes

`scripts/manage-r760-gateway-control.py` is the approved R760-only mutation
wrapper. It creates and verifies an online R760 SQLite backup before every
write, runs the allowlisted admin operation only on R760, and verifies SQLite
integrity and foreign keys afterward. It never mirrors or validates Azure.

Use `--what-if` before a write where the wrapper offers a concrete plan. The
global real-user RPM floor operation is:

```powershell
python scripts\manage-r760-gateway-control.py --what-if -- ensure-user-rpm-minimum 20
python scripts\manage-r760-gateway-control.py -- ensure-user-rpm-minimum 20
```

This operation selects non-revoked, non-expired `desktop` and legacy `unknown`
user credentials. It raises only credentials below the requested floor;
credentials already at or above the floor, expired credentials, revoked
credentials, and `service`/`operator` credentials remain unchanged.

Every non-issuance user, credential, Plan or Entitlement mutation retains these
requirements:

- an R760 backup before the write;
- an explicit target and dry-run where supported;
- post-write SQLite integrity/FK checks;
- R760-only public validation;
- no mirror or dual-endpoint validation.

Do not substitute a raw ad hoc command or the historical Azure mirror workflow.

## Usage authority and reports

R760 traffic writes usage directly to R760. Query R760 without a compatibility
merge:

```powershell
python scripts\check-daily-usage-health.py --format json
```

`scripts/sync-azure-r760-gateway-usage.py` is retained historical tooling and
must not be run as a reporting prerequisite. Events produced by a physically
retained legacy endpoint after logical cutover are not current authoritative
usage and must not be added manually to R760 totals.

## Client-message queries

The message-query helper defaults to R760:

```powershell
python scripts\query-client-messages.py --user "<user>" --limit 20
```

Client-message storage is support telemetry, not part of the authoritative
plan or token-usage ledger. The legacy compatibility query flag is for a
separately authorized historical investigation only, not routine support.

## Retained VM and physical shutdown

Logical Gateway shutdown is already the operating assumption and has no
remaining mirror/merge gate. Physical VM/container deletion or shutdown is a
different maintenance action because the shared VM may retain unrelated
services and audit assets. It requires separate inventory, ownership, backup
and authorization; it is not a phone-auth implementation or client-release
condition.

## Historical initial authority cutover evidence

The remainder of this section is retained only to explain the 2026-08-05/06
transition. It is not a current mirror, merge or dual-endpoint runbook.

The live authority switch was executed on 2026-08-06 after commit `7073011`
was pushed:

- preflight found schema v24, matching encryption-secret digests, healthy
  SQLite/FKs, zero control drift from Azure into R760 and zero open
  reservations on both endpoints;
- one inert rehearsal entitlement that still said `active` was cancelled on
  R760 through the guarded management wrapper. The corresponding subject was
  already disabled and its credential revoked;
- the same operation created a verified Azure backup at
  `/home/qian/codex-gateway-backups/r760-authority-mirror/azure-pre-control-state-sync-20260805T220444Z-b8092f0c.db`
  and mirrored 21 R760-only rehearsal dependency rows. A follow-up control
  dry-run reported zero changes across 11 plans, 626 subjects, 634 credentials,
  336 entitlements, 90 unified keys, 82 upstream bindings, 86 billing events
  and 93 billing subject events;
- the first fixed usage window ended at `2026-08-05T22:05:49.435Z` and imported
  2,758 request events, 775 finalized reservations and 110 admin-audit rows.
  A later fixed tail window ending at `2026-08-05T22:09:17.996Z` imported one
  additional request and one additional audit row created by the dual-endpoint
  verification. Both windows converged to zero changes on their second plan;
- the R760 usage backups were
  `/data/backups/codex-gateway/r760-usage-pre-control-state-sync-20260805T220613Z-6cc03bb7.db`
  and
  `/data/backups/codex-gateway/r760-usage-pre-control-state-sync-20260805T221023Z-0197be19.db`.
  Their SHA-256 values were respectively
  `4dfd695bc2adb6e4fec4b894d5e27c7dee89b22af56b6f897633b10e6a71118d`
  and `bc7f18ea99a2be6f508b0f02a3c9c5cdf9849f4cfce160a0c712032093e3bbfb`;
  both reported `quick_check=ok` and zero foreign-key violations;
- one existing real-user handoff key passed public validation on R760 and
  Azure after the mirror. R760 public health returned 200, TLS was valid,
  Gateway was healthy with zero restarts, and the R760 daily usage query
  completed without collector errors. The formal R760 Billing Admin token also
  authenticated a public read-only Plan query successfully. The report's only
  warning was a missing optional
  `ops-runtime.json` snapshot; this does not affect the authoritative SQLite
  control or usage records but remains a monitoring follow-up.

No identity, phone number, key prefix or full credential is recorded here.
