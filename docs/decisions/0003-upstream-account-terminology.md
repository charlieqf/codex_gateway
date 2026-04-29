# ADR 0003: Internal Provider Records Are Upstream Accounts

## Status

Accepted

## Context

The codebase previously used `subscription` for two different ideas:

- the server-side provider login state that the gateway uses to reach Codex or another upstream provider;
- a future user-facing commercial concept such as a plan, subscription, or entitlement.

Keeping both meanings under the same word made the gateway store schema, public status responses, admin output, and operator docs ambiguous.

## Decision

Use `upstream account` for the internal provider-login record.

Runtime schema and TypeScript contracts use `upstream_accounts`, `upstream_account_id`, `UpstreamAccount`, and `upstreamAccount`. Public gateway metadata uses `upstream_account` and `upstream_account_label` because this value is a display label, not a database foreign key.

The old public compatibility aliases remain for one compatibility window:

- `/gateway/status` returns both `upstream_account` and deprecated `subscription`.
- Session JSON returns both `upstream_account_label` and deprecated `subscription_id`.
- `GATEWAY_PUBLIC_SUBSCRIPTION_ID` is accepted as a deprecated fallback when `GATEWAY_PUBLIC_UPSTREAM_ACCOUNT_LABEL` is absent.
- `subscription_unavailable` remains an error code because external clients may already match it.

Admin CLI and observation output use `upstream_account_id` for new JSON fields. Historical audit payloads are immutable and may still contain older nested field names.

## Consequences

- Future user-facing plan or entitlement work can use `subscription` without colliding with provider-login state.
- Existing SQLite databases are migrated from `subscriptions` / `subscription_id` to `upstream_accounts` / `upstream_account_id`.
- Existing clients that read the old public fields continue to work while new clients can move to the clearer names.
