# Billing Admin Token Management Plan

Status: Implemented in repository; deployment pending
Date: 2026-05-19

## Problem

Billing Admin API access is currently controlled by process environment
variables:

```text
GATEWAY_BILLING_ADMIN_TOKEN
GATEWAY_BILLING_ADMIN_TOKEN_NEXT
```

The gateway reads these values at process startup. Adding, rotating, or removing
a Billing Admin token therefore requires changing the container environment and
recreating the live gateway container. That is too much operational risk for
routine billing/payment integration testing.

This issue applies only to Billing Admin API tokens used for
`/gateway/admin/billing/v1/*`. It does not apply to user-facing `cgu_live_*`
keys, backing Gateway `cgw.*` keys, plan grants, or entitlement updates; those
are already SQLite-backed and do not require a container restart.

## Goals

- Issue a Billing Admin test token without changing env files or recreating the
  gateway container.
- Revoke a Billing Admin token immediately.
- Keep full token plaintext out of SQLite, logs, audit rows, screenshots,
  tickets, and chat.
- Preserve the current env token as a break-glass fallback during rollout.
- Give billing/payment teams short-lived, purpose-labeled tokens with clear
  ownership.

## Non-Goals

- No browser/client-side use. Billing Admin tokens remain server-to-server only.
- No broad admin UI in this phase.
- No replacement for user `cgu_live_*` provisioning.
- No changes to billing API request/response contracts beyond authentication.

## Target Operator Experience

Issue a short-lived test token:

```bash
node apps/admin-cli/dist/index.js --db /var/lib/codex-gateway/gateway.db \
  billing-token issue \
  --label "billing-team-p0-test" \
  --expires-days 14
```

List active Billing Admin tokens:

```bash
node apps/admin-cli/dist/index.js --db /var/lib/codex-gateway/gateway.db \
  billing-token list --active-only
```

Revoke a token by prefix:

```bash
node apps/admin-cli/dist/index.js --db /var/lib/codex-gateway/gateway.db \
  billing-token revoke <token-prefix>
```

The `issue` command prints the full token once. Subsequent list/show/audit
output must show only the token prefix and metadata.

## Token Format

Use an explicit prefix so operators and logs can distinguish Billing Admin
tokens from user credentials:

```text
bat_test_<prefix>.<secret>
bat_live_<prefix>.<secret>
```

Recommended behavior:

- `bat_test_*`: default for external integration tests; short expiration.
- `bat_live_*`: reserved for trusted backend production integrations. Live
  tokens still require an explicit expiration.
- Prefix length should be long enough for support lookup, for example 14-16
  base64url characters after `bat_test_` or `bat_live_`.
- Secret should be at least 256 bits of random entropy.
- Operators refer to a token by the full public prefix before the dot, for
  example `bat_test_abcd1234...`. CLI `list`, `show`, and `revoke` should use
  that same full prefix and reject ambiguous bare random suffixes.

## Data Model

Add a SQLite table in `packages/store-sqlite/src/migrations.ts` through
`migrateGatewaySchema`. The current highest gateway migration is version 14, so
this feature should add version 15 with `applyMigration(db, 15, ...)` and use
`CREATE TABLE IF NOT EXISTS`, matching the existing migration style.

```sql
CREATE TABLE IF NOT EXISTS billing_admin_tokens (
  id TEXT PRIMARY KEY,
  prefix TEXT NOT NULL UNIQUE,
  hash TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('test', 'live')),
  state TEXT NOT NULL CHECK (state IN ('active', 'revoked')),
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  metadata_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_billing_admin_tokens_state_expires
  ON billing_admin_tokens(state, expires_at);
```

Rules:

- `state` is `active` or `revoked`.
- `id` uses a non-sensitive prefixed random id such as `bat_<random>`.
- `prefix` stores the full public lookup prefix before the dot, for example
  `bat_test_abcd1234...`, not only the random suffix.
- `expires_at` is required for both `test` and `live` DB tokens. There are no
  non-expiring SQLite-backed Billing Admin tokens; production integrations must
  still use explicit renewal.
- Store only a SHA-256 hash of the full token.
- Billing Admin tokens are not recoverable. Do not add a ciphertext column, do
  not support a reveal command, and do not require
  `GATEWAY_API_KEY_ENCRYPTION_SECRET` for `billing-token issue`.
- Store only safe metadata, such as owner/team, purpose, external ticket id, and
  environment.
- Do not store the full token in `metadata_json`.

## Gateway Authentication

Refactor `apps/gateway/src/billing-admin.ts` so Billing Admin route preflight
authenticates bearer tokens through a mode-aware helper instead of assuming env
token access must exist.

Authentication order in the first rollout:

1. Parse the bearer token as a DB-backed token only if it matches
   `bat_(test|live)_<prefix>.<secret>`.
2. For matching DB-token shapes, look up `billing_admin_tokens.prefix` using
   the full public prefix before the dot.
3. Require `state='active'`, `revoked_at IS NULL`, and
   `expires_at > now`.
4. Hash the full token with the existing `sha256:` prefix format and compare
   with `timingSafeEqual`.
5. If the bearer token does not match the `bat_*` shape, skip the DB lookup and
   compare it against `GATEWAY_BILLING_ADMIN_TOKEN` and
   `GATEWAY_BILLING_ADMIN_TOKEN_NEXT`.

This hybrid mode keeps current operations working while allowing hot-issued
tokens.

Important operational constraint: in `hybrid` mode, any bearer token shaped like
`bat_test_*` or `bat_live_*` is treated as a SQLite-backed DB token. If the DB
lookup misses, is expired, or is revoked, authentication fails with 401 and does
not fall back to env token comparison. Therefore
`GATEWAY_BILLING_ADMIN_TOKEN` and `GATEWAY_BILLING_ADMIN_TOKEN_NEXT` must not be
configured with `bat_test_*` or `bat_live_*` values unless the gateway is forced
to `GATEWAY_BILLING_ADMIN_TOKEN_MODE=env`.

Use unsalted SHA-256 for these tokens, consistent with existing access
credential hashing. The secret has at least 256 bits of random entropy, so a
slow password hash such as bcrypt or argon2 is not required.

Suggested config:

```text
GATEWAY_BILLING_ADMIN_TOKEN_MODE=hybrid
```

Accepted values:

- `env`: only current environment-token behavior.
- `db`: only SQLite Billing Admin tokens.
- `hybrid`: SQLite tokens plus env fallback.

Recommended first deployment: `hybrid`.

### Route Configuration Check

The current implementation treats `options.access === null` as "Billing Admin
API is not configured" and returns a 503 before token validation. That logic
must change for `db` and `hybrid` mode.

Required behavior:

- In `env` mode, the route is configured only when env token access is present.
- In `db` mode, the route is configured when the SQLite Billing Admin token
  store is present, even if no env token exists.
- In `hybrid` mode, the route is configured when either the SQLite token store
  is present or env token access is present.

Do not gate Billing Admin route availability solely on
`resolveBillingAdminAccess(...)` returning a non-null env access object.

## Usage Tracking

On successful SQLite-token auth:

- set `last_used_at` best-effort, throttled to at most once per token per
  minute to avoid write amplification under the default Billing Admin route
  rate limit;
- include only token prefix, never token plaintext, in sanitized warning logs;
- never log full token.

If `last_used_at` update fails due to a transient SQLite write issue, the API
request should continue after logging a sanitized warning. Authentication should
not depend on usage tracking writes.

## Admin CLI

Add a `billing-token` command group:

```text
billing-token issue
billing-token list
billing-token show
billing-token revoke
```

`issue` options:

```text
--label <label>              required non-secret purpose/owner label
--expires-days <days>        default 14 for test tokens
--expires-at <iso>           mutually exclusive with --expires-days
--kind test|live             default test
--metadata <json>            optional safe metadata
```

`issue` must not read or require `GATEWAY_API_KEY_ENCRYPTION_SECRET`. The full
token is not encrypted for later recovery; if it is lost, issue a replacement
and revoke the old prefix.

`list` options:

```text
--active-only
--state active|revoked
--limit <n>
```

`revoke` options:

```text
<token-prefix>               full public prefix, e.g. bat_test_abcd1234...
--reason <text>
```

CLI output must be clean JSON. Only `issue` returns `token`.

## Audit Events

Add audit actions:

```text
billing-token-issue
billing-token-revoke
```

Add these actions to the `AdminAuditAction` union in
`packages/core/src/types.ts`; otherwise TypeScript callers cannot write audit
events for the new CLI commands.

Audit rows should include:

- token id
- token prefix
- label
- expiration
- kind
- reason for revocation, if provided

Audit rows must not include full token plaintext or token hash.
Because successful audit params store labels verbatim, labels must also be
treated as non-secret operator metadata and must never contain token plaintext.

## Redaction Requirements

Before enabling DB-backed Billing Admin tokens, update all audit and gateway log
sanitizers to redact the new token format:

```text
bat_(test|live)_[A-Za-z0-9._-]+
```

Minimum code paths to update:

- `apps/admin-cli/src/audit.ts` `sanitizeAuditErrorMessage`
- gateway-side error/log sanitization used by Billing Admin routes

This is a blocking rollout requirement. Without it, a token included in an
exception message or upstream error body could be written to admin audit rows or
logs in plaintext, violating the primary security goal.

## Security Rules

- Billing Admin tokens are only for trusted billing/payment backends.
- Do not put Billing Admin tokens in browser, desktop app, mobile app, client
  config, screenshots, tickets, logs, or chat.
- Do not confuse Billing Admin tokens with `cgu_live_*` user keys.
- Prefer short expirations for external test tokens.
- Revoke unused test tokens after each joint test window.

## Rollout Plan

1. Add gateway schema migration version 15 in
   `packages/store-sqlite/src/migrations.ts` using `applyMigration(db, 15, ...)`
   and `CREATE TABLE IF NOT EXISTS billing_admin_tokens`. Done.
2. Add token generation/hash helpers, SQLite store methods, and CLI commands.
   Done.
3. Extend `AdminAuditAction` in `packages/core/src/types.ts` with
   `billing-token-issue` and `billing-token-revoke`. Done.
4. Add `bat_(test|live)_...` redaction to admin CLI audit sanitization and
   gateway-side log/error sanitization. Done.
5. Add gateway authenticator with `hybrid` mode and fix route configuration so
   DB-only mode does not return 503 just because env access is absent.
   Done.
6. Add tests for issue/list/show/revoke and request authentication.
   Done.
7. Deploy once with `GATEWAY_BILLING_ADMIN_TOKEN_MODE=hybrid`.
8. Issue one short-lived `bat_test_*` token.
9. Validate:

   ```bash
   curl -fsS \
     -H "Authorization: Bearer <token>" \
     https://gw.instmarket.com.au/gateway/admin/billing/v1/plans
   ```

10. Give the token to the billing/payment team through the approved secure
   channel.
11. Revoke test tokens after the joint test window.
12. Keep env token as break-glass until DB-token operations have been stable.

## Test Coverage

Unit/integration tests should cover:

- valid SQLite Billing Admin token can access `/gateway/admin/billing/v1/plans`;
- missing token returns `401 missing_credential`;
- wrong token returns `401 invalid_credential`;
- revoked token returns `401 invalid_credential`;
- expired token returns `401 invalid_credential`;
- env fallback still works in `hybrid` mode;
- `db` mode does not accept env tokens;
- `db` mode works with no `GATEWAY_BILLING_ADMIN_TOKEN` configured when the
  SQLite token store exists;
- non-`bat_*` env token strings skip DB parsing and still compare against env
  tokens in `env` and `hybrid` mode;
- `bat_*` shaped env token strings do not fall back to env comparison in
  `hybrid` mode;
- CLI `issue` prints full token once;
- CLI `list` and `show` never print full token;
- audit output never contains full token or hash;
- audit/log sanitizers redact `bat_test_*` and `bat_live_*` token strings;
- `last_used_at` updates on successful DB-token auth;
- `last_used_at` updates are throttled so repeated requests in the same minute
  do not write every time;
- failure to update `last_used_at` does not fail the request.

## Operational Impact

After this change, issuing or revoking Billing Admin tokens becomes a database
operation and does not require:

- editing `config/gateway.container.env`;
- recreating the gateway container;
- touching Nginx;
- interrupting active gateway requests.

One deployment is still required to introduce the feature.

## Open Questions

- What is the default maximum lifetime for test tokens: 7 days, 14 days, or 30
  days?
- Should `billing-token issue` write a local handoff JSON, or only print JSON to
  stdout for an operator-managed secure handoff?
- Should successful Billing Admin API requests create request events, or is
  admin audit plus `last_used_at` enough?
- Should expired token rows be pruned by a new command, or left as inactive
  historical metadata? Authentication rejects expired rows either way, so
  pruning is operational cleanup rather than access control.
