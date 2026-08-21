# MedEvidence R760 Dual-track Phone Auth v1 Contract

| Item | Value |
| --- | --- |
| Contract ID | `medevidence-r760-dual-track-phone-auth-v1` |
| Contract version | `1` |
| Artifact state | `contract_candidate` |
| Origin | `https://goldencode.instmarket.com.au:1443` |
| Minimum Desktop version | `2.0.0-beta.40` |
| Fixture file | [`fixtures.json`](./fixtures.json) |
| Integrity file | [`SHA256SUMS`](./SHA256SUMS) |

This directory is the additive Desktop/Gateway contract for long-term
coexistence of legacy `cgu_live_*` credentials and Phone Sessions. It does not
replace or modify the frozen
[`medevidence-internal-phone-auth-v1`](../medevidence-internal-phone-auth-v1/README.md)
wire shapes. It replaces that contract's one-time cutover and global Desktop
version-gate assumptions as specified by the authoritative
[`MedEvidence R760 dual-track implementation specification`](../../implementation/medevidence-r760-dual-track-phone-auth-gateway-implementation-spec-2026-08-21.zh-CN.md).

The contract becomes frozen only when Gateway and Desktop sign the same full
commit. Until then, `contract_candidate` must not be described as deployed or
integration-ready.

## Inherited wire contract

The following remain exactly as defined by the frozen v1 contract:

- request and success-response fields for login, refresh, logout, bootstrap,
  resolver, credentials current and account current;
- closed request objects and `contract_version=1`;
- Ed25519 Access JWT claims, 15-minute Access TTL, atomic Refresh rotation,
  30-day Refresh idle expiry and 180-day Session absolute expiry;
- no-store/no-cache responses and the stable JSON error envelope;
- bootstrap returning the Subject's current `cgu_live_*`, followed by resolver
  and backing-credential validation;
- exact R760 URLs and cross-response Subject/key/capability invariants.

Fields enclosed by `<` and `>` in the fixture are synthetic non-secret
placeholders. The fixture phone and device values are test-only examples and
must never be copied into an allowlist.

## Dual-track invariants

Phone identity, Phone Session, current and compatible unified keys, backing
credential, Plan, Entitlement, capability set, quota windows and usage all
remain anchored to one immutable `subject_id`.

Login, refresh, logout, Refresh replay, Session expiry, Phone identity disable
and Desktop upgrade must not revoke, expire or mutate a legacy unified or
backing key. They must not write Plan, Entitlement, capability, quota-window or
pre-existing usage state. Only a normal billable business request may add its
own usage.

An unknown phone never creates a Subject, key, Plan or Entitlement. A new
device without a legacy key may sign in only when its phone identity was
explicitly prepared by an administrator and remains active.

## Route and version-gate policy

`GATEWAY_DESKTOP_VERSION_GATE` is a strict enum:

| Mode | Policy |
| --- | --- |
| `disabled` | No route is rejected for Desktop version. |
| `auth_only` | Only the five Phone Session routes below are version-gated. |
| `all` | The historical complete Desktop route set is version-gated. |

The historical value `enabled` is invalid configuration and must fail before
the listener starts. `GATEWAY_PHONE_AUTH_MODE=transition` is valid only with
`auth_only`, a strict minimum SemVer and an absolute HTTPS download URL.

The five `auth_only` routes are:

| Method | Path |
| --- | --- |
| `POST` | `/gateway/auth/v1/login/start` |
| `POST` | `/gateway/auth/v1/token/refresh` |
| `POST` | `/gateway/auth/v1/logout` |
| `POST` | `/gateway/auth/v1/session/bootstrap` |
| `GET` | `/gateway/account/v1/current` |

In `auth_only`, a missing, malformed or old
`X-MedEvidence-Client-Version` must not cause HTTP 426 on resolver,
credentials current, `/v1/*`, `/gateway/research/v1/*`, image generation or
the four Vision Asset Gateway operations. Existing auth, Subject, Plan,
capability, model and rate-limit checks still apply.

On a gated route, a missing, malformed or lower strict SemVer returns HTTP 426
`client_upgrade_required` with `minimum_version`, `download_url` and
`request_id`, plus no-store/no-cache headers.

## Stable errors and fallback meaning

The additive stable error is:

| HTTP | Code | Meaning |
| ---: | --- | --- |
| 403 | `phone_login_disabled` | The Phone identity and its Sessions are disabled; the Subject, legacy keys and Plan remain unchanged. |

`account_disabled` is reserved for a disabled Subject. It must not represent a
Phone-only disable. `phone_not_registered` means there is no prepared identity
and must not disclose whether other account data exists.

`phone_subject_mismatch` in the fixture is a Desktop-local classification after
comparing the independently resolved legacy Subject with the Phone Session
Subject. It is not a Gateway HTTP error. Desktop discards the new Session and
may keep an independently valid legacy runtime; Gateway never merges Subjects.

Gateway logout revokes only the current Phone Session family. Desktop's
"sign out this device" additionally records local legacy-login suppression;
that Desktop state-machine behavior remains required for integration but does
not change server key state.

## Login risk buckets

Every successful or failed login attempt obtains permits from independent
SHA-256/HMAC-derived keys in this order:

| Dimension | Setting | Default RPM |
| --- | --- | ---: |
| normalized phone hash | `GATEWAY_PHONE_AUTH_LOGIN_PHONE_RPM` | 5 |
| IP risk-key hash | `GATEWAY_PHONE_AUTH_LOGIN_IP_RPM` | 20 |
| device ID hash | `GATEWAY_PHONE_AUTH_LOGIN_DEVICE_RPM` | 10 |

If a later bucket rejects, earlier permits are released. No limiter key, audit
row or log may contain the raw phone, IP address or device ID. HTTP 429 uses
`auth_rate_limited`, and its `Retry-After` header equals
`error.retry_after_seconds`.

## Fixture assertions

`fixtures.json` is self-contained and includes the inherited success shapes,
the additive error, route-policy matrices, a Desktop-local Subject mismatch
classification and before/after state snapshots. Consumers must assert:

1. every response Subject is `subj_example`;
2. bootstrap and resolver unified-key prefix/expiry agree;
3. resolver and credentials-current backing prefix agree;
4. Plan, Entitlement, capabilities, quota-window identifiers and pre-existing
   usage counters are unchanged by auth operations;
5. legacy unified/backing key revoke and expiry fields are unchanged after
   logout, replay and Phone identity disable;
6. `auth_only` never emits 426 for a legacy/business matrix entry;
7. fixture, logs and test output contain no real phone, JWT, Refresh Token or
   complete live key.

## Attestation

`SHA256SUMS` covers `README.md` and `fixtures.json` with lowercase SHA-256
hex. Any edit requires regenerating and reviewing the attestation. The old
contract directory and its attestation remain unchanged.
