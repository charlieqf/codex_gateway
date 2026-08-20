# MedEvidence Internal Phone Auth v1 Contract

| Item | Value |
| --- | --- |
| Contract ID | `medevidence-internal-phone-auth-v1` |
| Contract version | `1` |
| Artifact state | `contract_candidate`; freeze attestation lives in the coordination document |
| Origin | `https://goldencode.instmarket.com.au:1443` |
| Fixture file | [`fixtures.json`](./fixtures.json) |
| Integrity file | [`SHA256SUMS`](./SHA256SUMS) |

This directory is the normative Desktop/Gateway wire-contract candidate for
the internal-user cutover. The Gateway implementation plan and Desktop design
are non-normative references.

The contract becomes frozen only when:

1. this directory is committed and pushed;
2. the coordination document records a permalink containing the full
   40-character commit SHA;
3. Gateway and Desktop sign the same commit.

Until then, its status is `unfrozen` and neither team may describe the real
adapter as integration-ready.

## JSON and header rules

- JSON request bodies use `Content-Type: application/json`.
- Request objects are closed: unknown request fields return
  `400 invalid_request`.
- Fields shown in `fixtures.json` are required unless this file says otherwise.
- Clients must ignore additional response fields so v1 responses can grow
  additively.
- `X-Request-ID` is returned on every response. The same value appears as
  `error.request_id` on JSON errors.
- `X-MedEvidence-Client-Version` is required wherever the version-gate column
  says `desktop`.
- Every response on the seven routes below, including errors, returns
  `Cache-Control: no-store` and `Pragma: no-cache`.
- Secrets, raw phone numbers, JWTs and complete keys must not appear in logs,
  audit parameters, URLs or diagnostics.

## Normative route table

| Method | Path | Authorization | Version gate | Success |
| --- | --- | --- | --- | --- |
| `POST` | `/gateway/auth/v1/login/start` | none | always Desktop | `200` JSON |
| `POST` | `/gateway/auth/v1/token/refresh` | refresh token in JSON | always Desktop | `200` JSON |
| `POST` | `/gateway/auth/v1/logout` | `Bearer <access-jwt>` | always Desktop | `204` empty |
| `POST` | `/gateway/auth/v1/session/bootstrap` | `Bearer <access-jwt>` | always Desktop | `200` JSON |
| `POST` | `/gateway/unified-keys/resolve` | `Bearer <cgu_live_*>` | credential class `desktop` | `200` JSON |
| `GET` | `/gateway/credentials/current` | `Bearer <cgw.*>` | credential class `desktop` | `200` JSON |
| `GET` | `/gateway/account/v1/current` | `Bearer <access-jwt>` | always Desktop | `200` JSON |

## Request bodies

### `POST /gateway/auth/v1/login/start`

Required JSON fields:

| Field | Contract |
| --- | --- |
| `phone` | String matching `^1[3-9][0-9]{9}$`; Gateway normalizes it to `+86` E.164 |
| `client` | Literal `medevidence-desktop` |
| `device_id` | Opaque Desktop-generated stable device ID, 16–128 ASCII characters |
| `contract_version` | Integer `1` |

For an enabled, fully prepared internal phone identity, the response is
`responses.login_start_authenticated` in `fixtures.json`. An unknown or
unprepared phone returns `403 phone_not_registered` and creates no Subject,
Session, Key or Entitlement row.

### `POST /gateway/auth/v1/token/refresh`

Required JSON fields:

| Field | Contract |
| --- | --- |
| `refresh_token` | Opaque refresh token returned by the previous login/refresh |
| `client` | Literal `medevidence-desktop` |
| `device_id` | Must equal the Session device ID |
| `contract_version` | Integer `1` |

Success returns `responses.refresh_authenticated` and atomically invalidates
the previous refresh token. If Desktop cannot prove that the new token pair was
persisted, it clears the local Session and logs in again; it never sends the old
refresh token again. Reuse of a rotated token revokes that Session family and
returns `401 refresh_token_invalid`.

### Bodyless routes

`logout`, `session/bootstrap` and `unified-keys/resolve` are semantically
bodyless POST routes. For compatibility with the current Desktop resolver they
accept either an omitted body or exactly one empty JSON object `{}`; an object
containing any field, an array, a scalar or JSON `null` returns
`400 invalid_request`. `requests.unified_key_resolve` is the accepted empty
object fixture. `credentials/current` and `account/v1/current` are GET routes
and accept no request body.

Logout is idempotent: a recognized token for the same already-revoked Session
still returns `204`; an unrecognized or malformed token returns the mapped
`401` error.

## Required response shapes

`fixtures.json` contains the complete required examples:

- `responses.login_start_authenticated`;
- `responses.refresh_authenticated`;
- `responses.bootstrap`;
- `responses.resolve`;
- `responses.credentials_current`;
- `responses.account_current_internal`.

Every named field in those examples is required. Values beginning with
`<` and ending with `>` are non-secret placeholders. Timestamps are RFC 3339
UTC strings. Desktop must tolerate additional response fields.

### Cross-response invariants

For one authenticated Desktop Session, Gateway and Desktop must enforce all of
the following:

- `subject.id` is identical in login/refresh, bootstrap, resolve,
  `credentials/current` and `account/current` responses;
- `bootstrap.unified_key.key_prefix` equals
  `resolve.unified_key.prefix`;
- `bootstrap.unified_key.expires_at` and
  `resolve.unified_key.expires_at` are the same non-null future RFC 3339 value;
- `credentials_current.credential.expires_at` is separate backing-credential
  metadata and remains nullable under the existing current-route contract; the
  non-null rule above applies only to the unified key returned by bootstrap and
  resolve;
- `resolve.codex_gateway.key_prefix` equals
  `credentials_current.credential.prefix`;
- both `credentials_current.entitlement.feature_policy.capabilities` and
  `account_current_internal.capabilities` contain `chat`; any mismatch fails
  closed and Desktop does not enter the main UI or send a business request;
- Gateway-owned returned URLs are exact: `resolver_url` is
  `https://goldencode.instmarket.com.au:1443/gateway/unified-keys/resolve`,
  `account_url` is
  `https://goldencode.instmarket.com.au:1443/gateway/account/v1/current`,
  `codex_gateway.endpoint_base_url` is
  `https://goldencode.instmarket.com.au:1443/v1`, and
  `codex_gateway.credential_validation_url` is
  `https://goldencode.instmarket.com.au:1443/gateway/credentials/current`.
  Desktop rejects an alternate scheme, host, port or path. The separate
  `medevidence.base_url` must equal the approved configured MedEvidence HTTPS
  origin.

Any Subject, key-prefix, expiry or URL invariant failure is an invalid Gateway
response: Desktop clears in-memory runtime credentials and does not continue
with a partially matched bundle.

The internal `account/current` response always has:

- `identity.kind=internal`;
- a non-empty internal `plan_id`;
- `token_wallet=null` and `image_credits=null`;
- `capabilities` containing `chat`.

Desktop enters its main UI only after bootstrap, resolve,
`credentials/current` and `account/current` all succeed and the account
capabilities include `chat`.

## Version gate

`X-MedEvidence-Client-Version` uses strict SemVer comparison. A missing,
malformed or lower-than-configured version returns
`426 client_upgrade_required`.

The gate has an explicit enable switch. When enabled,
`minimum_desktop_version` must be a non-empty strict SemVer and `download_url`
must be a non-empty absolute HTTPS URL. Gateway rejects an invalid config
activation and must not enable `transition_phone_only` without a valid gate
configuration. The actual version and URL are operational values filled before
the maintenance window, not wire-contract fields.

The gate covers:

- all four `/gateway/auth/v1/*` routes in this contract;
- `/gateway/unified-keys/resolve`;
- `/gateway/credentials/current`;
- `/gateway/account/v1/current`;
- Desktop calls to `/v1/*`;
- Desktop calls to `/gateway/research/v1/*`;
- Desktop calls to `/gateway/images/generations`;
- all four existing Vision Asset operations:
  `POST /gateway/vision/assets`,
  `POST /gateway/vision/assets/:assetId/complete`,
  `POST /gateway/vision/assets/:assetId/read-url`, and
  `DELETE /gateway/vision/assets/:assetId`.

The private presigned R2 `PUT` returned by Vision Asset create is not a Gateway
route: it receives neither the Desktop version header nor the Gateway bearer,
and is outside the 426 gate. This contract adds version gating to the four
Gateway Vision routes without changing their existing payload/response shapes.

For bearer-protected runtime routes, Gateway authenticates the credential,
reads its explicit class, then applies the Desktop version gate. Credentials
created for this Desktop flow, including the backing `cgw.*`, have class
`desktop`. Only credentials explicitly provisioned as `service` or `operator`
are exempt. A missing or unknown credential class is not exempt. Gateway must
not infer an exemption from `User-Agent`, a missing header, route history or
source IP.

Credential class is server-owned metadata bound to the Session, unified key
and backing credential; a client cannot select or override it in a header or
body. Desktop-only auth routes check version before their body/session logic.
Bearer-protected resolver and business routes first authenticate far enough to
resolve credential class: an invalid bearer remains `401`, while a valid
non-exempt credential with a missing, malformed or old version is `426`.

The 426 JSON is `errors.client_upgrade_required` in `fixtures.json` and
requires `minimum_version`, `download_url` and `request_id`. Desktop must not
parse `message` for upgrade data. The fixture's valid SemVer and URL are test
values, not the operational minimum version; the maintenance-window checklist
records the actual configured values without changing this wire shape. Every
426 response on every covered route returns `Cache-Control: no-store` and
`Pragma: no-cache`.

## Error mapping

All JSON errors on the seven core routes in the normative route table use:

```json
{
  "error": {
    "code": "<stable-code>",
    "message": "<human-readable-not-parsed>",
    "request_id": "req_example"
  }
}
```

`retry_after_seconds` is required for `429`. The 426-only fields are described
above.

| HTTP | Code | Applies to |
| ---: | --- | --- |
| 400 | `invalid_request` | malformed JSON, unknown/missing field, invalid phone/device/contract version, non-empty body on a bodyless route |
| 401 | `missing_credential` | missing required bearer |
| 401 | `invalid_credential` | malformed or unknown `cgu_live_*`/`cgw.*` |
| 401 | `revoked_credential` | revoked unified/backing credential |
| 401 | `expired_credential` | expired unified/backing credential |
| 401 | `access_token_invalid` | invalid/revoked Access JWT or Session |
| 401 | `access_token_expired` | expired Access JWT |
| 401 | `refresh_token_invalid` | invalid, expired, rotated or replayed Refresh Token |
| 403 | `phone_not_registered` | internal phone not fully prepared/enabled |
| 403 | `account_disabled` | Subject or phone identity disabled |
| 403 | `capability_not_allowed` | internal Plan lacks the requested capability |
| 409 | `phone_identity_conflict` | normalized phone maps to multiple candidates |
| 409 | `account_migration_required` | current unified/runtime key is not recoverable |
| 426 | `client_upgrade_required` | missing, malformed or old Desktop version |
| 429 | `auth_rate_limited` | login/start phone/IP risk bucket exceeded |
| 503 | `service_unavailable` | required Gateway dependency unavailable |

## Phone-only transition security

`transition_phone_only` is not strong identity verification. Gateway must:

- apply configurable per-phone-hash and per-IP-risk-key limits to
  `login/start` and return `429` with `Retry-After`;
- audit request ID, phone hash, Subject ID, Session ID, auth method and outcome
  without raw phone or secrets;
- set `no-store/no-cache` on sensitive responses;
- record `auth_method=transition_phone_only` and never represent it as SMS
  verified;
- allow rapid Session revocation and current unified-key rotation.

The coordination document contains the business risk-owner signature. Without
that signature, the maintenance window is not ready.
