# Registration And Payment Integration Spec

| Field | Value |
| --- | --- |
| Status | Draft |
| Date | 2026-05-04 |
| Audience | Teams building user registration, account pages, checkout, payment webhooks, or CRM workflows |
| Scope | Contract between those systems and Codex Gateway plan/quota provisioning |

## Purpose

This document defines how an external registration or payment system should
connect to Codex Gateway after a user is approved, paid, renewed, refunded, or
cancelled.

The current integration surface is the admin CLI. A browser must never call the
CLI directly. The registration/payment system must call it from a trusted
server-side backend, worker, or job runner.

## System Boundary

Codex Gateway owns:

- users as gateway subjects;
- API keys;
- plan templates;
- entitlements;
- token quota enforcement;
- token usage reporting;
- admin audit records;
- `GET /gateway/credentials/current` for API key status and quota display.

The registration/payment system owns:

- signup UI and identity verification;
- login/session management for its own website;
- product pages and checkout;
- payment provider integration;
- order, invoice, refund, and subscription state;
- customer email or in-app delivery of newly issued API keys;
- idempotency for webhooks and retries.

Codex Gateway does not store prices, payment methods, invoices, card data, or
payment provider secrets.

## Integration Pattern

Short term:

1. The registration/payment backend receives a business event, such as
   `payment_succeeded`.
2. It validates the event with the payment provider.
3. It records the event in its own database with an idempotency key.
4. It calls `codex-gateway-admin provision-user`.
5. It parses JSON stdout and stores the provisioning result.
6. If a new API key was issued, it displays or delivers that key once through a
   secure channel.

Do not expose shell execution through an HTTP endpoint. If the other team needs
an HTTP integration later, add a narrow internal admin API behind internal
networking plus service authentication, and keep the same semantics as this
document.

## Runtime Requirements

The backend or worker that calls the CLI needs:

- access to the built gateway repository or container image;
- access to the gateway SQLite database;
- `GATEWAY_API_KEY_ENCRYPTION_SECRET` configured;
- Node.js runtime matching the deployed gateway build;
- permission to execute `node apps/admin-cli/dist/index.js`;
- log redaction for `credential.token`, `Authorization`, complete `cgw.*`
  strings, and internal policy fields such as `entitlement.policy_snapshot`.

Example container command shape:

```bash
cd /home/qian/codex-gateway-test
sudo docker compose -p codex_gateway_test -f compose.azure.yml exec -T gateway \
  node apps/admin-cli/dist/index.js --db /var/lib/codex-gateway/gateway.db \
  provision-user ... < /dev/null
```

## Plan Catalog Contract

The payment system must map its commercial products to gateway plan ids. Gateway
plan ids are operational quota templates, not price ids.

Initial mapping template:

| Commercial product | Payment price id | Gateway plan id | Period | Issue API key on first purchase | Notes |
| --- | --- | --- | --- | --- | --- |
| Trial | TBD | `plan_trial_v1` | monthly | yes | Internal trial or controlled onboarding |
| Pro | TBD | `plan_pro_v1` | monthly | yes | Main paid individual plan |
| Internal | none | `plan_internal_v1` | unlimited | manual only | Staff, test, or trusted internal usage |

Rules:

- Do not infer price from gateway plan id.
- Do not change a plan's quota by updating the existing plan row. Create a new
  plan id version and start granting that new plan.
- Only grant plans whose id has been explicitly approved in the product mapping.
- Operators publish plan version changes through the rollout runbook or a direct
  release notice. The payment system must update its commercial-product-to-plan
  mapping table before using a new plan id.
- Deprecated plans fail provisioning with
  `Plan is deprecated and cannot grant new entitlements: <plan_id>`.

## User Identity Contract

The payment system must provide a stable gateway user id through `--user`.

Recommended format:

```text
medevidence-<stable_external_customer_id>
```

Requirements:

- The same human or customer account must always map to the same gateway user id.
- The id must not contain raw email addresses, phone numbers, full names, or
  payment-provider secrets.
- The id must be stable across renewals, failed payments, refunds, and API key
  rotations.
- `--name` and `--phone` are hard-required CLI options for every
  `provision-user` call, including trials. Missing either option causes the CLI
  to exit non-zero before provisioning.
- `--user-label` is optional. Use it only when the account display label should
  differ from `--name`; otherwise the gateway uses the name as the user label.

## CLI Command Contract

Use `provision-user` for successful approval or payment.

Monthly entitlement periods are aligned to UTC calendar months. For example, a
monthly grant executed on `2026-05-15` returns
`period_start=2026-05-01T00:00:00.000Z` and
`period_end=2026-06-01T00:00:00.000Z`. The entitlement period is not the exact
checkout timestamp.

First paid activation, with new API key:

```bash
node apps/admin-cli/dist/index.js --db /var/lib/codex-gateway/gateway.db provision-user \
  --user medevidence-cus_123 \
  --name "Example User" \
  --phone "+15550001111" \
  --user-label "Example User" \
  --plan plan_pro_v1 \
  --period monthly \
  --replace \
  --key-label "Example User API key" \
  --scope code \
  --expires-days 365 \
  --rpm 60 \
  --rpd 5000 \
  --concurrent 4 \
  --external-id pi_123
```

Warning: rerunning this command with `--key-label` issues a new API key on each
successful call. The payment system must use the idempotency table described
below before invoking the command.

Renewal, without issuing another key:

```bash
node apps/admin-cli/dist/index.js --db /var/lib/codex-gateway/gateway.db provision-user \
  --user medevidence-cus_123 \
  --name "Example User" \
  --phone "+15550001111" \
  --plan plan_pro_v1 \
  --renew \
  --external-id invoice_456
```

One-off entitlement:

```bash
node apps/admin-cli/dist/index.js --db /var/lib/codex-gateway/gateway.db provision-user \
  --user medevidence-cus_123 \
  --name "Example User" \
  --phone "+15550001111" \
  --plan plan_trial_v1 \
  --period one_off \
  --duration 7d \
  --replace \
  --key-label "Example User trial key" \
  --scope code \
  --external-id manual_trial_001
```

Important behavior:

- `--key-label` issues a new API key. Omit it when the user should keep the
  existing key.
- `--replace` cancels conflicting current or scheduled entitlements before
  granting the new one.
- With `--renew`, `--replace` only replaces an already-existing scheduled
  renewal. Do not use it for routine invoice webhook retries; reserve it for
  operator correction of a bad scheduled renewal.
- `--renew` creates a scheduled monthly renewal after the current active monthly
  entitlement and returns an entitlement with `state="scheduled"`. It does not
  issue an API key unless `--key-label` is also used, which should normally be
  avoided for renewals.
- `--external-id` is stored for audit correlation. It is not currently a
  database-level idempotency key inside Codex Gateway.
- Credential request rate limits and token quotas are independent. A Pro user
  can hit `rate_limited` because of `--rpm`, `--rpd`, or `--concurrent` even
  when token quota remains available.

## CLI Invocation Requirements

Use argument-array execution, not shell string concatenation.

Node.js example:

```ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const { stdout } = await execFileAsync(
  "node",
  [
    "apps/admin-cli/dist/index.js",
    "--db",
    "/var/lib/codex-gateway/gateway.db",
    "provision-user",
    "--user",
    gatewayUserId,
    "--name",
    customerName,
    "--phone",
    customerPhone,
    "--user-label",
    customerName,
    "--plan",
    "plan_pro_v1",
    "--period",
    "monthly",
    "--replace",
    "--key-label",
    "Customer API key",
    "--scope",
    "code",
    "--expires-days",
    "365",
    "--rpm",
    "60",
    "--rpd",
    "5000",
    "--concurrent",
    "4",
    "--external-id",
    paymentIntentId
  ],
  {
    env: {
      ...process.env,
      GATEWAY_API_KEY_ENCRYPTION_SECRET: process.env.GATEWAY_API_KEY_ENCRYPTION_SECRET
    },
    windowsHide: true,
    maxBuffer: 1024 * 1024
  }
);

const result = JSON.parse(stdout);
```

Python example:

```python
import json
import os
import subprocess

completed = subprocess.run(
    [
        "node",
        "apps/admin-cli/dist/index.js",
        "--db",
        "/var/lib/codex-gateway/gateway.db",
        "provision-user",
        "--user",
        gateway_user_id,
        "--name",
        customer_name,
        "--phone",
        customer_phone,
        "--user-label",
        customer_name,
        "--plan",
        "plan_pro_v1",
        "--period",
        "monthly",
        "--replace",
        "--key-label",
        "Customer API key",
        "--scope",
        "code",
        "--expires-days",
        "365",
        "--rpm",
        "60",
        "--rpd",
        "5000",
        "--concurrent",
        "4",
        "--external-id",
        payment_intent_id,
    ],
    check=True,
    capture_output=True,
    text=True,
    env=os.environ.copy(),
)

result = json.loads(completed.stdout)
```

## Provisioning Output

Successful provisioning returns JSON on stdout.

First paid activation output shape:

```json
{
  "user": {
    "id": "medevidence-cus_123",
    "label": "Example User",
    "name": "Example User",
    "phone_number": "+15550001111",
    "state": "active",
    "created_at": "2026-05-04T00:00:00.000Z"
  },
  "plan": {
    "id": "plan_pro_v1",
    "display_name": "Pro",
    "scope_allowlist": ["code"],
    "priority_class": 5,
    "team_pool_id": null,
    "state": "active",
    "created_at": "2026-05-04T00:00:00.000Z",
    "metadata": null
  },
  "entitlement": {
    "id": "ent_<id>",
    "user_id": "medevidence-cus_123",
    "subject_id": "medevidence-cus_123",
    "plan_id": "plan_pro_v1",
    "policy_snapshot": {
      "tokensPerMinute": 2000000,
      "tokensPerDay": 100000000,
      "tokensPerMonth": 2000000000,
      "maxPromptTokensPerRequest": 380000,
      "maxTotalTokensPerRequest": 400000,
      "reserveTokensPerRequest": 100000,
      "missingUsageCharge": "estimate"
    },
    "scope_allowlist": ["code"],
    "period_kind": "monthly",
    "period_start": "2026-05-01T00:00:00.000Z",
    "period_end": "2026-06-01T00:00:00.000Z",
    "state": "active",
    "team_seat_id": null,
    "created_at": "2026-05-15T03:00:00.000Z",
    "cancelled_at": null,
    "cancelled_reason": null,
    "notes": null
  },
  "credential": {
    "id": "cred_<id>",
    "prefix": "<prefix>",
    "user_id": "medevidence-cus_123",
    "subject_id": "medevidence-cus_123",
    "label": "Example User API key",
    "scope": "code",
    "expires_at": "2027-05-15T03:00:00.000Z",
    "revoked_at": null,
    "status": "active",
    "is_currently_valid": true,
    "token_available": true,
    "token_unavailable_reason": null,
    "rate": {
      "requestsPerMinute": 60,
      "requestsPerDay": 5000,
      "concurrentRequests": 4
    },
    "created_at": "2026-05-15T03:00:00.000Z",
    "rotates_id": null,
    "user": {
      "id": "medevidence-cus_123",
      "label": "Example User",
      "name": "Example User",
      "phone_number": "+15550001111",
      "state": "active",
      "created_at": "2026-05-04T00:00:00.000Z"
    },
    "token": "<full API key, present only when a key was issued>"
  },
  "credential_issued": true,
  "mode": "grant"
}
```

The example above assumes the command was executed on `2026-05-15`. The
monthly entitlement still starts at the UTC month boundary, `2026-05-01`.

Renewal output shape:

```json
{
  "user": {
    "id": "medevidence-cus_123",
    "label": "Example User",
    "name": "Example User",
    "phone_number": "+15550001111",
    "state": "active",
    "created_at": "2026-05-04T00:00:00.000Z"
  },
  "plan": {
    "id": "plan_pro_v1",
    "display_name": "Pro",
    "scope_allowlist": ["code"],
    "priority_class": 5,
    "team_pool_id": null,
    "state": "active",
    "created_at": "2026-05-04T00:00:00.000Z",
    "metadata": null
  },
  "entitlement": {
    "id": "ent_<scheduled-renewal-id>",
    "user_id": "medevidence-cus_123",
    "subject_id": "medevidence-cus_123",
    "plan_id": "plan_pro_v1",
    "policy_snapshot": {
      "tokensPerMinute": 2000000,
      "tokensPerDay": 100000000,
      "tokensPerMonth": 2000000000,
      "maxPromptTokensPerRequest": 380000,
      "maxTotalTokensPerRequest": 400000,
      "reserveTokensPerRequest": 100000,
      "missingUsageCharge": "estimate"
    },
    "scope_allowlist": ["code"],
    "period_kind": "monthly",
    "period_start": "2026-06-01T00:00:00.000Z",
    "period_end": "2026-07-01T00:00:00.000Z",
    "state": "scheduled",
    "team_seat_id": null,
    "created_at": "2026-05-20T03:00:00.000Z",
    "cancelled_at": null,
    "cancelled_reason": null,
    "notes": null
  },
  "credential": null,
  "credential_issued": false,
  "mode": "renew"
}
```

Fields the payment system may persist:

- `user.id`
- `plan.id`
- `entitlement.id`
- `entitlement.period_start`
- `entitlement.period_end`
- `credential.id`, when `credential` is non-null
- `credential.prefix`, when `credential` is non-null
- whether `credential_issued` is true
- the upstream `external_id` in the payment system's own database

Fields that must not be logged:

- `credential.token`
- complete API keys in any `cgw.*` form
- full `Authorization` headers
- `entitlement.policy_snapshot`
- `credential.rate`

Fields that must not be displayed to end users:

- `entitlement.policy_snapshot`, including `reserveTokensPerRequest` and
  `missingUsageCharge`
- `credential.rate`; display request-rate limits separately only if product
  copy explicitly explains them
- `entitlement.scope_allowlist` when it duplicates `plan.scope_allowlist`; use
  the plan-level display field for account pages

## API Key Delivery

If `credential_issued` is true, `credential.token` is present in CLI stdout on
every successful key-issuing call. The CLI does not enforce "show once." The
payment system must persist or display the token exactly once according to its
own idempotency records, then discard it from memory and logs.

The payment system must choose one approved delivery method:

- show once after checkout in an authenticated account page;
- store encrypted in that system's secret store for later reveal;
- hand off to an operator through a secure internal workflow.

Do not send full API keys through analytics, client logs, normal server logs,
URLs, email subject lines, screenshots, or support tickets.

After delivery, clients can validate a key through:

```http
GET https://gw.instmarket.com.au/gateway/credentials/current
Authorization: Bearer <API_KEY>
```

That route returns public account, plan, entitlement, and quota metadata without
consuming normal request or token quota.

## API Key Rotation

When a customer asks to replace an existing API key, use `rotate`, not
`provision-user --key-label`.

```bash
node apps/admin-cli/dist/index.js --db /var/lib/codex-gateway/gateway.db rotate <credential-prefix> \
  --grace-hours 24
```

`rotate` issues a replacement credential for the same user and lets the old key
remain valid for the configured grace period. This gives the customer time to
update clients without changing their plan entitlement.

Do not use `provision-user --key-label` for key rotation. That command is for
new provisioning events; it may grant or replace entitlements and it does not
revoke the old key.

## Idempotency

The registration/payment system must implement idempotency before calling the
CLI.

Required idempotency keys:

| Event | Suggested idempotency key |
| --- | --- |
| First successful payment | payment intent id or checkout session id |
| Recurring invoice paid | invoice id |
| Manual trial grant | internal approval id |
| Refund | refund id |
| Cancellation | subscription id plus cancellation timestamp |

Critical rule:

- Never call `provision-user --key-label ...` more than once for the same first
  purchase event. Each successful call issues a new API key.

Recommended backend behavior:

1. Insert the payment event into a local `provisioning_events` table with a
   unique idempotency key.
2. If the insert conflicts and the prior event succeeded, return the stored
   result without calling the CLI again.
3. If the prior event is in progress, retry later.
4. If the prior event failed, allow an operator or retry policy to rerun it.
5. Store the gateway result, including credential prefix and entitlement id.

`--external-id` is for Codex Gateway audit correlation. It does not replace the
payment system's idempotency table.

## Payment State Machine

Recommended handling:

| Payment/subscription state | Gateway action | CLI |
| --- | --- | --- |
| Signup created, unpaid | none | none |
| Trial approved | grant one-off or trial monthly entitlement; optionally issue key | `provision-user --period one_off` or `--period monthly --key-label ...` |
| First payment succeeded | grant active paid entitlement and issue key once | `provision-user --period monthly --replace --key-label ...` |
| Renewal invoice paid | create scheduled renewal, no new key | `provision-user --renew` |
| Payment failed but grace period active | no immediate gateway change, notify user | none |
| Grace period ended unpaid | pause or cancel entitlement | `entitlement pause` or `entitlement cancel` |
| User cancels at period end | leave current entitlement active; do not renew | none until period end |
| Immediate cancellation | cancel entitlement | `entitlement cancel <entitlement-id> --reason ...` |
| Refund approved | manual policy decision: cancel, pause, or leave active | `entitlement cancel`, `entitlement pause`, or no gateway action |
| Chargeback or abuse | disable user or revoke API key | `disable-user` or `revoke` |

The payment system must not infer that a paid subscription is active only from
its own billing state. For user-facing quota/account pages, it should query or
cache Gateway state from `GET /gateway/credentials/current` when an API key is
available, or from its own stored provisioning result for account-level display.

Compatibility mode note:

- With `GATEWAY_REQUIRE_ENTITLEMENT=0`, a legacy user that has never had any
  entitlement history may still pass through the compatibility path.
- Once `provision-user` creates entitlement history for a user, later expiry,
  pause, cancellation, or future-only scheduling is enforced for that user.
  The user does not fall back to the legacy path.
- With `GATEWAY_REQUIRE_ENTITLEMENT=1`, users without active entitlements are
  rejected as `plan_inactive`.

## Error Handling

CLI success:

- exit code `0`;
- stdout is parseable JSON.

CLI failure:

- non-zero exit code;
- stdout may be empty;
- stderr may contain diagnostics for operators.

Do not show raw CLI stderr directly to end users. Map failures to user-safe
messages and alert operations.

Common failures:

| Failure | Likely cause | Backend response |
| --- | --- | --- |
| `Plan not found` | product mapped to an unknown plan id | mark provisioning failed; alert operations |
| `Plan is deprecated` | product mapped to an old plan | mark provisioning failed; alert operations |
| `User is disabled; enable the user before provisioning.` | user was administratively disabled for chargeback, abuse, or operator hold | CLI exits non-zero; do not re-enable automatically; operators must explicitly run `enable-user` before another `provision-user` retry |
| `API key scope is not allowed` | product scope mismatch | mark provisioning failed; alert operations |
| `GATEWAY_API_KEY_ENCRYPTION_SECRET is required` | worker environment misconfigured | retry only after environment fix |
| SQLite lock or transient process failure | concurrent writes or deployment issue | retry with backoff if idempotency is in place |

## Cancellation And Refund Operations

The first version should keep refunds and chargebacks operator-controlled unless
there is a clear policy.

Useful commands:

```bash
node apps/admin-cli/dist/index.js --db /var/lib/codex-gateway/gateway.db entitlement show --user medevidence-cus_123
node apps/admin-cli/dist/index.js --db /var/lib/codex-gateway/gateway.db entitlement pause <entitlement-id> --reason "payment failed"
node apps/admin-cli/dist/index.js --db /var/lib/codex-gateway/gateway.db entitlement cancel <entitlement-id> --reason "refund approved"
node apps/admin-cli/dist/index.js --db /var/lib/codex-gateway/gateway.db disable-user medevidence-cus_123
node apps/admin-cli/dist/index.js --db /var/lib/codex-gateway/gateway.db revoke <credential-prefix>
```

Policy decisions still needed before automation:

- whether refund cancels entitlement immediately or at period end;
- whether unused quota has any commercial value;
- whether failed renewal has a grace period;
- whether chargeback disables the whole user or only revokes keys.

## Account And Quota Display

There are two supported read paths:

1. If the website has the user's API key available in a secure server-side
   context, call the public credential status route.
2. If the website only has `gateway_user_id`, prefer the payment system's local
   provisioning cache. For operator/admin pages, the backend may call
   `entitlement show --user <gateway-user-id>` or `token-windows --user
   <gateway-user-id>`. Do not execute admin CLI commands on every normal
   customer page load unless this has been explicitly approved operationally.

For a user who has an API key, account pages can call:

```http
GET /gateway/credentials/current
Authorization: Bearer <API_KEY>
```

Displayable fields:

- `credential.prefix`
- `credential.scope`
- `credential.expires_at`
- `credential.token`, meaning the filtered token quota policy, not the API key
  secret
- `plan.display_name`
- `plan.scope_allowlist`
- `entitlement.period_kind`
- `entitlement.period_start`
- `entitlement.period_end`
- `entitlement.state`
- `token_usage.minute/day/month.limit`
- `token_usage.minute/day/month.used`
- `token_usage.minute/day/month.reserved`
- `token_usage.minute/day/month.remaining`

Do not display or depend on:

- raw `plan.id` as a commercial product name;
- raw `entitlement.id` unless in an operator view;
- `reserveTokensPerRequest`;
- `missingUsageCharge`;
- reservation ids;
- raw policy JSON.

If a model request returns `429 rate_limited` and
`token_usage.minute/day/month.remaining` are all greater than zero or `null`,
the request-rate or concurrency limit was hit, not token quota exhaustion.

## Client Error Handling

Business clients using `/v1/chat/completions` should handle:

| HTTP | `error.code` | Meaning |
| --- | --- | --- |
| 401 | `missing_credential` or `invalid_credential` | API key missing or invalid |
| 402 | `plan_inactive` | no active usable entitlement |
| 402 | `plan_expired` | entitlement expired |
| 403 | `forbidden_scope` | API key scope is not allowed by plan |
| 429 | `rate_limited` | request rate, concurrency, request size, or token quota limit |

For `429 rate_limited`, clients should call
`GET /gateway/credentials/current` and inspect
`token_usage.minute/day/month.remaining` before displaying "quota exhausted."
If all token `remaining` values are greater than zero or `null`, show a request
rate, concurrency, request-size, or retry message instead of a quota-exhausted
message.

## Logging And Security

Required redaction patterns:

- complete `cgw.<prefix>.<secret>` strings;
- `Authorization: Bearer ...`;
- CLI JSON field `credential.token`;
- CLI JSON field `entitlement.policy_snapshot`;
- CLI JSON field `credential.rate`;
- payment provider secrets;
- customer PII beyond what operations explicitly need.

Recommended storage:

- store API key prefix in normal tables;
- store full API key only encrypted, or do not store it at all after display;
- store `external-id`, `gateway_user_id`, `entitlement_id`, and
  `credential_prefix` for reconciliation;
- store `entitlement.period_end` so the payment system can drive renewal
  reminders or proactive reconciliation before expiry.

Access control:

- only trusted backend workers may call the CLI;
- customer support tools should reveal only API key prefix by default;
- full key reveal must be a separate privileged workflow.

## Reconciliation And Audit

The payment system should store a local provisioning row:

| Column | Notes |
| --- | --- |
| `idempotency_key` | unique |
| `external_payment_id` | payment provider id |
| `gateway_user_id` | value passed to `--user` |
| `gateway_plan_id` | value passed to `--plan` |
| `gateway_entitlement_id` | from CLI output |
| `gateway_entitlement_period_end` | from CLI output; useful for renewal prompts and reconciliation |
| `gateway_credential_prefix` | from CLI output, nullable for renewals |
| `status` | pending, succeeded, failed |
| `last_error` | redacted |
| `created_at` / `updated_at` | timestamps |

Gateway audit can be queried by operators:

```bash
node apps/admin-cli/dist/index.js --db /var/lib/codex-gateway/gateway.db audit --action provision-user --limit 50
node apps/admin-cli/dist/index.js --db /var/lib/codex-gateway/gateway.db audit --user medevidence-cus_123 --limit 50
```

Usage reports:

```bash
node apps/admin-cli/dist/index.js --db /var/lib/codex-gateway/gateway.db report-usage --user medevidence-cus_123 --days 30 --group-by entitlement
node apps/admin-cli/dist/index.js --db /var/lib/codex-gateway/gateway.db token-windows --user medevidence-cus_123
```

## Acceptance Tests For The Registration/Payment Team

Minimum test matrix:

| Case | Expected result |
| --- | --- |
| Signup without payment | no gateway CLI call |
| First payment succeeds | one `provision-user` call, one API key issued, active entitlement created |
| Duplicate payment webhook | no second CLI call and no second API key |
| Renewal succeeds | `provision-user --renew`, scheduled entitlement returned, no new API key |
| Duplicate renewal webhook | no second CLI call |
| Payment fails before grace expiry | no gateway change |
| Grace expires unpaid | entitlement paused or cancelled according to policy |
| Refund approved | operator-approved pause/cancel path runs |
| Product maps to deprecated plan | provisioning fails safely and alerts operations |
| API key display page refreshes | full API key is not shown again unless intentionally stored/revealed |
| Customer requests key replacement | `rotate <credential-prefix> --grace-hours <n>` is used, not `provision-user --key-label` |
| Client checks quota | `/gateway/credentials/current` displays plan, entitlement, and token usage |

Gateway-side verification after test provisioning:

```bash
node apps/admin-cli/dist/index.js --db /var/lib/codex-gateway/gateway.db entitlement show --user <gateway-user-id>
node apps/admin-cli/dist/index.js --db /var/lib/codex-gateway/gateway.db list-active-keys --user <gateway-user-id>
node apps/admin-cli/dist/index.js --db /var/lib/codex-gateway/gateway.db audit --user <gateway-user-id> --limit 20
node apps/admin-cli/dist/index.js --db /var/lib/codex-gateway/gateway.db token-windows --user <gateway-user-id>
```

## Open Decisions

- Final commercial product to gateway plan mapping.
- Payment provider and exact webhook event names.
- Whether full API keys are stored encrypted by the registration/payment system
  or only displayed once.
- Refund and chargeback entitlement policy.
- Grace period after renewal payment failure.
- Whether to add an internal admin API after the first CLI-backed integration.
- Who owns monthly renewal monitoring if the payment provider is unavailable.

## Related Documents

- `docs/implementation/server-side-subscription-rollout-plan.md`
- `docs/consumer-plan-entitlement-rollout-notice.md`
- `docs/client-api-key-validation-guide.md`
- `docs/operations/runbook-index.md`
