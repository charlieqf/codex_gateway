# Server-Side Subscription Rollout Runbook

| Field | Value |
| --- | --- |
| Status | Draft |
| Date | 2026-04-30 |
| Scope | Server-side rollout operations for plan, entitlement, quota, usage, and audit |

## Scope Boundary

This runbook covers only server-side work needed to operate subscription-style access control and manual commercial follow-up.

Explicitly out of scope:

- Account creation pages.
- Billing pages.
- Payment checkout.
- Payment provider integration.
- Invoice generation.
- Refund handling.
- Self-service purchase, upgrade, downgrade, or renewal flows.

The first operating model is manual: an operator creates plans, grants or renews entitlements, checks usage, and takes any commercial action outside this gateway.

## Already Shipped

This is not a fresh implementation plan. The main P3 plan/entitlement code is already in the repository.

Shipped capabilities:

- Plan CLI: `plan create/list/show/deprecate` in `apps/admin-cli/src/index.ts`.
- Entitlement CLI: `entitlement grant/renew/pause/resume/cancel/show/list/bulk-grant` in `apps/admin-cli/src/index.ts`.
- Entitlement-aware token policy selection in `apps/gateway/src/services/token-budget-hook.ts`.
- `entitlement_token_windows` schema and enforcement path in `packages/store-sqlite/src/migrations.ts` and `packages/store-sqlite/src/token-budget.ts`.
- `GET /gateway/credentials/current` returns plan, entitlement, token policy, and token usage fields in `apps/gateway/src/index.ts`.
- `report-usage --group-by entitlement` in `apps/admin-cli/src/index.ts`.
- Entitlement trial checks:
  - `active_credential_entitlements`
  - `entitlement_renewal_window`
  - `active_plan_usage`
- Compatibility and strict mode through `GATEWAY_REQUIRE_ENTITLEMENT`.

Remaining rollout work is primarily configuration, data backfill, verification, monitoring, renewal cadence, and rollback discipline.

## Operator Command Template

On the Azure VM container deployment, run admin commands inside the gateway container:

```bash
cd /home/qian/codex-gateway-test
sudo docker compose -p codex_gateway_test -f compose.azure.yml exec -T gateway \
  node apps/admin-cli/dist/index.js --db /var/lib/codex-gateway/gateway.db <command> < /dev/null
```

Never print or store full API keys in rollout notes. Use user ids, credential ids, and credential prefixes.

## Phase 0: Pre-Rollout Inventory Snapshot

Goal: capture the current operational baseline before granting entitlements.

Run and archive JSON output:

```bash
node apps/admin-cli/dist/index.js --db /var/lib/codex-gateway/gateway.db list-users
node apps/admin-cli/dist/index.js --db /var/lib/codex-gateway/gateway.db list-active-keys
node apps/admin-cli/dist/index.js --db /var/lib/codex-gateway/gateway.db report-usage --days 30
node apps/admin-cli/dist/index.js --db /var/lib/codex-gateway/gateway.db trial-check --max-active-users 10
```

Interpretation:

- `active_credential_entitlements`
  - Compatibility mode: `warning` is acceptable only for documented legacy users.
  - Strict mode rehearsal: must be `ok`.
  - Any `rejected_users` entry is a blocker unless it is an explicit negative test.
- `entitlement_renewal_window`
  - `warning` means at least one active entitlement expires in the next 7 days; renew before strict mode.
- `active_plan_usage`
  - `info` is acceptable for newly created plans or dormant historical plans.
- `user_contact_metadata`
  - Fix missing name/phone for real trial users before strict mode.

Exit criteria:

- Current active users and active API keys are known.
- Current 30-day usage is archived.
- Compatibility mode remains configured:

```text
GATEWAY_REQUIRE_ENTITLEMENT=0
```

## Phase 1: Plan Definition And Bulk Grant

Goal: create the operating plans and grant entitlements to the current controlled-trial users.

### Initial Plan Policies

These values are operating guardrails for the controlled rollout, not payment prices. Confirm them with operations before creating plans in the shared VM database.

| Plan id | Display | Scope | tokens/min | tokens/day | tokens/month | max prompt/request | max total/request | reserve/request | missing usage |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| `plan_trial_v1` | Trial | `code` | 1000000 | 20000000 | 400000000 | 380000 | 400000 | 100000 | `estimate` |
| `plan_pro_v1` | Pro | `code` | 2000000 | 100000000 | 2000000000 | 380000 | 400000 | 100000 | `estimate` |
| `plan_internal_v1` | Internal | `code` | unlimited | unlimited | unlimited | 390000 | 400000 | 100000 | `estimate` |

Policy JSON files:

```json
{
  "tokensPerMinute": 1000000,
  "tokensPerDay": 20000000,
  "tokensPerMonth": 400000000,
  "maxPromptTokensPerRequest": 380000,
  "maxTotalTokensPerRequest": 400000,
  "reserveTokensPerRequest": 100000,
  "missingUsageCharge": "estimate"
}
```

```json
{
  "tokensPerMinute": 2000000,
  "tokensPerDay": 100000000,
  "tokensPerMonth": 2000000000,
  "maxPromptTokensPerRequest": 380000,
  "maxTotalTokensPerRequest": 400000,
  "reserveTokensPerRequest": 100000,
  "missingUsageCharge": "estimate"
}
```

```json
{
  "tokensPerMinute": null,
  "tokensPerDay": null,
  "tokensPerMonth": null,
  "maxPromptTokensPerRequest": 390000,
  "maxTotalTokensPerRequest": 400000,
  "reserveTokensPerRequest": 100000,
  "missingUsageCharge": "estimate"
}
```

Write the three JSON snippets to `/tmp/plan_trial_v1.json`, `/tmp/plan_pro_v1.json`, and `/tmp/plan_internal_v1.json` inside the gateway container before running `plan create`.

Create plans:

```bash
node apps/admin-cli/dist/index.js --db /var/lib/codex-gateway/gateway.db plan create \
  --id plan_trial_v1 \
  --display-name Trial \
  --scope code \
  --policy-file /tmp/plan_trial_v1.json

node apps/admin-cli/dist/index.js --db /var/lib/codex-gateway/gateway.db plan create \
  --id plan_pro_v1 \
  --display-name Pro \
  --scope code \
  --policy-file /tmp/plan_pro_v1.json

node apps/admin-cli/dist/index.js --db /var/lib/codex-gateway/gateway.db plan create \
  --id plan_internal_v1 \
  --display-name Internal \
  --scope code \
  --policy-file /tmp/plan_internal_v1.json
```

### Current User Mapping

Initial mapping for known active controlled-trial users:

| User | User id | Credential prefix | Plan | Action |
| --- | --- | --- | --- | --- |
| Wang Yun | `medevidence-f25ba355979b4ca39545b091a2837195` | `jdJIsjIPHhkHIg` | `plan_trial_v1` | grant monthly entitlement |
| Shen Jie | `medevidence-76650ea38feb47f4b259e1b065151696` | `2TqZWpLkcp2Esg` | `plan_trial_v1` | grant monthly entitlement |
| MedCode Trial User 1 | `medcode-trial-user-1` | `0ZLslPJ_XNKMXA` | review | revoke if unused; otherwise grant `plan_internal_v1` |
| MedCode Trial User 2 | `medcode-trial-user-2` | `IuILGSM7exrosw` | review | revoke if unused; otherwise grant `plan_internal_v1` |

For active legacy users, do not grant only a future scheduled entitlement. Once a user has entitlement history, a future-only `scheduled` entitlement makes current requests return `plan_inactive`, even when `GATEWAY_REQUIRE_ENTITLEMENT=0`.

For this document date, first backfill the current UTC monthly period:

```text
current period_start = 2026-04-01T00:00:00.000Z
period_kind  = monthly
```

Then immediately create the next scheduled renewal for the May period. If this runbook is executed after `2026-05-01T00:00:00.000Z`, use the current UTC month start instead, then renew the following month.

Bulk grant the two named trial users for the current April period:

```bash
node apps/admin-cli/dist/index.js --db /var/lib/codex-gateway/gateway.db entitlement bulk-grant \
  --plan plan_trial_v1 \
  --period monthly \
  --start 2026-04-01T00:00:00.000Z \
  --users medevidence-f25ba355979b4ca39545b091a2837195,medevidence-76650ea38feb47f4b259e1b065151696 \
  --replace
```

Create the next monthly renewal:

```bash
node apps/admin-cli/dist/index.js --db /var/lib/codex-gateway/gateway.db entitlement renew \
  --user medevidence-f25ba355979b4ca39545b091a2837195 \
  --replace

node apps/admin-cli/dist/index.js --db /var/lib/codex-gateway/gateway.db entitlement renew \
  --user medevidence-76650ea38feb47f4b259e1b065151696 \
  --replace
```

Verify:

```bash
node apps/admin-cli/dist/index.js --db /var/lib/codex-gateway/gateway.db plan list
node apps/admin-cli/dist/index.js --db /var/lib/codex-gateway/gateway.db entitlement list --plan plan_trial_v1
node apps/admin-cli/dist/index.js --db /var/lib/codex-gateway/gateway.db trial-check --max-active-users 10
```

## Credential Override Cleanup

Entitlement policy is the primary quota source. Existing `credential.rate.token` values remain active as stricter-only overrides. Hidden overrides can make a user receive less quota than the plan says.

Before strict mode:

1. Inspect `list-active-keys` output for credentials whose `rate` includes `token`.
2. For each override, decide one of:
   - clear it and rely on entitlement policy;
   - keep it as an explicit emergency cap with an owner and expiry date.
3. For normal trial users, prefer clearing token overrides after entitlement grant:

```bash
node apps/admin-cli/dist/index.js --db /var/lib/codex-gateway/gateway.db update-key <credential-prefix> \
  --clear-token-policy
```

If a key has no active entitlement yet and the rollout is still in compatibility mode, add `--no-entitlement-check` only for that transitional update.

## Phase 2: Verification Of Shipped Enforcement

Goal: verify the shipped P3 behavior on the production build and VM database.

Run a small matrix in staging or with temporary users/keys on the shared VM:

| Case | Setup | Expected result |
| --- | --- | --- |
| active entitlement | active monthly entitlement, allowed scope | model request succeeds |
| paused entitlement | pause active entitlement | `plan_inactive` |
| expired entitlement | active entitlement past period end | `plan_expired` |
| cancelled entitlement | cancel entitlement | `plan_inactive` |
| scheduled entitlement | future period start | `plan_inactive` until start |
| scope mismatch | entitlement scope does not include credential scope | `forbidden_scope` |
| legacy compatibility | no entitlement history, `GATEWAY_REQUIRE_ENTITLEMENT=0` | request continues through legacy path |
| strict legacy rejection | no entitlement history, `GATEWAY_REQUIRE_ENTITLEMENT=1` | `plan_inactive` |

Also verify `token-windows`:

```bash
node apps/admin-cli/dist/index.js --db /var/lib/codex-gateway/gateway.db token-windows \
  --user medevidence-f25ba355979b4ca39545b091a2837195
```

For an active entitlement user, the output should include an `entitlement_id` and usage source should be entitlement-backed through the public credential status API.

## Phase 3: Credential Status Verification

Goal: verify `GET /gateway/credentials/current` exposes the account state expected by clients and operators.

Expected response for an entitlement-backed key:

- `valid: true`
- `credential.prefix`
- `credential.scope`
- `credential.token`
- `plan.display_name`
- `plan.scope_allowlist`
- `entitlement.period_kind`
- `entitlement.period_start`
- `entitlement.period_end`
- `entitlement.state`
- `token_usage.source`
- `token_usage.minute/day/month.used`
- `token_usage.minute/day/month.reserved`
- `token_usage.minute/day/month.remaining`

This route must not consume request count quota or token quota.

Do not expose:

- raw API key
- raw `plan.id`
- raw `entitlement.id`
- raw policy JSON
- reservation ids
- internal accounting fields

## Phase 4: Usage, Reconciliation, And Audit

Goal: make manual commercial follow-up possible without a payment system.

Routine usage commands:

```bash
node apps/admin-cli/dist/index.js --db /var/lib/codex-gateway/gateway.db report-usage --days 30
node apps/admin-cli/dist/index.js --db /var/lib/codex-gateway/gateway.db report-usage --days 30 --group-by entitlement
node apps/admin-cli/dist/index.js --db /var/lib/codex-gateway/gateway.db report-usage --user <user-id> --days 30 --group-by entitlement
node apps/admin-cli/dist/index.js --db /var/lib/codex-gateway/gateway.db token-windows --user <user-id>
```

Manual reconciliation should archive JSON output. If spreadsheet handoff is required for operations, add a first-class CSV export or an approved JSON-to-CSV script before using these reports for external billing follow-up.

Weekly audit checks:

```bash
node apps/admin-cli/dist/index.js --db /var/lib/codex-gateway/gateway.db audit --action plan-create --limit 50
node apps/admin-cli/dist/index.js --db /var/lib/codex-gateway/gateway.db audit --action entitlement-grant --limit 50
node apps/admin-cli/dist/index.js --db /var/lib/codex-gateway/gateway.db audit --action entitlement-renew --limit 50
node apps/admin-cli/dist/index.js --db /var/lib/codex-gateway/gateway.db audit --action entitlement-pause --limit 50
node apps/admin-cli/dist/index.js --db /var/lib/codex-gateway/gateway.db audit --action entitlement-cancel --limit 50
node apps/admin-cli/dist/index.js --db /var/lib/codex-gateway/gateway.db audit --action entitlement-expire --limit 50
```

## Observability And Renewal Cadence

Weekly:

- Run `trial-check --max-active-users 10`.
- Run `entitlement list --state active`.
- Run `entitlement list --state scheduled`.
- Run `report-usage --days 7 --group-by entitlement`.
- Review admin audit events for entitlement changes.

Monthly renewal duty:

- Entitlement renewal is manual in this phase.
- Run renewal at least 7 days before `period_end`.
- `entitlement renew` creates a scheduled renewal after the current monthly entitlement.
- Use `--replace` only when intentionally replacing an existing scheduled renewal.

Example:

```bash
node apps/admin-cli/dist/index.js --db /var/lib/codex-gateway/gateway.db entitlement renew \
  --user medevidence-f25ba355979b4ca39545b091a2837195 \
  --replace

node apps/admin-cli/dist/index.js --db /var/lib/codex-gateway/gateway.db entitlement renew \
  --user medevidence-76650ea38feb47f4b259e1b065151696 \
  --replace
```

If strict mode is enabled and renewal is missed, affected users will receive `plan_expired` once the current entitlement expires.

## Client Notice

Use `docs/consumer-plan-entitlement-rollout-notice.md` as the client-facing notice source.

Send notice before any strict-mode switch. Minimum notice for the current trial should be 14 calendar days and must include:

- planned strict-mode date and UTC time;
- unchanged OpenAI-compatible request/response shape;
- `GET /gateway/credentials/current` fields clients may display;
- new error codes: `plan_inactive`, `plan_expired`, `forbidden_scope`;
- statement that account creation, billing pages, checkout, and payment flows are not part of this rollout.

## Strict Mode Go/No-Go Criteria

Do not set `GATEWAY_REQUIRE_ENTITLEMENT=1` in production-like public service unless all criteria pass:

- Client notice was sent at least 14 days earlier.
- Public smoke tests pass.
- `trial-check --max-active-users 10` has no `error`.
- `active_credential_entitlements` is `ok`.
- No active real credential is left in legacy state, unless explicitly revoked before the switch.
- No active entitlement expires in the next 7 days without a scheduled renewal.
- All real active credentials have name and phone metadata.
- Credential token overrides are either cleared or documented as deliberate stricter caps.
- Last 7 days of request events show no unexpected `plan_inactive`, `plan_expired`, or `forbidden_scope`.
- Rollback owner and rollback command are known before the switch.

## Rollback

Rollback from strict mode is configuration-only for legacy strict-mode rejections:

```text
GATEWAY_REQUIRE_ENTITLEMENT=0
```

Expected behavior after rollback:

- Users with no entitlement history return to the compatibility path on their next request.
- Previously failed requests are not replayed automatically.
- Entitlement rows, plan rows, request events, and token reservation rows are not modified by the rollback.
- In-flight or abandoned token reservations do not need manual cleanup; normal finalize or expiry cleanup handles them.

Important: rollback to compatibility mode does not make expired, paused, cancelled, or scheduled entitlement users active again. The current gateway logic rejects those entitlement states regardless of `GATEWAY_REQUIRE_ENTITLEMENT`. To restore those users, renew, resume, or grant a replacement entitlement.

## Production-Like First Rollout Shape

The first rollout should remain compatible:

```text
GATEWAY_REQUIRE_ENTITLEMENT=0
```

Legacy users without entitlement history continue to work. Users granted entitlement start using entitlement-backed quota. Users that have entered the entitlement system and later expire, pause, or cancel are blocked according to their true entitlement state.
