# Doctor Research Phase 0.5 compatibility gate

Status as of 2026-07-18: **passed for the current controlled-beta release
line**.

This gate proves that the existing Gateway policy data remains readable and
that a known rollback image can read `doctor_research` before any production
plan or entitlement is allowed to contain that capability. It does not approve
the Research API, a provider, a beta user, or production enablement.

## Pinned rollback boundary

The minimum permitted rollback image after the first production
`doctor_research` capability write is:

```text
source commit:
ccccf1cf42a93de6de73c22746dd54bec7c3dd08

image digest:
sha256:d0f1b54a82bcf48e47448a7e2876f434ef001587b8cc99c0629043dd11b6a3ac
```

Do not roll a Gateway that has stored `doctor_research` back to an image older
than this boundary. A future replacement boundary must pass the same checks
and update the frozen fixture in the same reviewed change.

## Evidence

The machine-readable, non-secret fixture is
`packages/core/src/fixtures/phase0.5-compatibility.v1.json`. It freezes:

- legacy and current stored feature-policy shapes;
- camel-case and snake-case compatibility reads;
- public round-trip output;
- unknown future-capability preservation on stored reads;
- strict writer acceptance of `doctor_research` and rejection of unknown
  values;
- the pinned rollback commit and image digest.

The core and SQLite tests cover the fixture plus plan get/list, entitlement
snapshot/grant/read, unknown-value round-trip and strict writer boundaries.

On 2026-07-18, a read-only process executed inside the pinned running image:

- accepted a strict `["chat", "doctor_research"]` writer policy;
- preserved an injected future capability on the tolerant stored-reader path;
- decoded all 196 existing production plan and entitlement policy rows without
  printing their values;
- confirmed that the production Research API flag was still false.

The production database, users, keys, plans, entitlements, container, image,
environment and listener were not changed by this check.

## Invalidation

Repeat and re-record this gate before:

- changing the feature-policy storage or public serialization contract;
- changing the minimum rollback image;
- writing `doctor_research` to any production plan or entitlement;
- enabling the production Research API.

If the pinned image is unavailable, its digest is not the expected digest, any
stored policy fails to decode, or the Research flag is unexpectedly enabled,
the release is **NO-GO**.
