# MedEvidence Codex Gateway Key Provisioning

Last updated: 2026-08-31.

Use this runbook to issue one opaque `cgu_live_*` credential to a real
Desktop/MedEvidence user. R760 is the only authority. Do not pre-issue a hidden
MedEvidence key and do not use a former Azure workflow.

## Current Command

Preflight:

```powershell
python scripts\issue-real-user-cgu-key.py `
  --name "<real name>" `
  --phone "<phone>" `
  --client-version "<strict-semver>" `
  --what-if
```

Issue:

```powershell
python scripts\issue-real-user-cgu-key.py `
  --name "<real name>" `
  --phone "<phone>" `
  --client-version "<strict-semver>"
```

The wrapper creates or updates the R760 subject, creates the hidden v2 and
backing Gateway credentials, grants the Plan, wraps them as `cgu_live_*`, and
validates the public resolver and backing credential before writing a local
handoff JSON.

## Enforced Defaults

The script is the source of truth. Its current real-user defaults are:

- public base: `https://goldencode.instmarket.com.au:1443`;
- Plan: `plan_internal_high_quota_image_v1`;
- capabilities: chat, tools and image generation;
- validity: 92 days by default, with operator-provided key/entitlement expiry
  rejected when under 90 days;
- limits: at least/default 20 requests per minute, 200 requests per day and 4
  concurrent requests;
- scope: `code`;
- handoff directory: `C:\Users\rdpuser\medevidence_api_keys`.

`--client-version` must be strict SemVer. The retained `--r760-only` option is
a deprecated no-op because issuance is always R760-only.

## Handoff And Privacy

The console may report only safe prefixes, subject id, Plan/capabilities,
validation status and `handoff_path`. The full unified key is written only to
the pseudonymous local handoff JSON.

- Deliver the full key only through the approved private channel.
- Never send the backing `cgw.*` key or hidden `mev2_live_*` key to the user.
- Never paste full credentials, billing tokens or Authorization headers into
  chat, tickets, logs, screenshots or repository files.
- Do not use `--skip-credential-validation`; it is rejected for real users.

## Later Changes And Usage

All user enable/disable, key revoke/update, Plan and entitlement changes use
the guarded R760-only wrapper:

```powershell
python scripts\manage-r760-gateway-control.py --what-if -- <admin operation>
python scripts\manage-r760-gateway-control.py -- <admin operation>
```

Use only operations accepted by its allowlist. It creates and verifies an
online SQLite backup before a write. Full rules are in
[R760 Control-Plane Authority](./r760-control-plane-authority.md).

Query authoritative usage directly from R760:

```powershell
python scripts\check-daily-usage-health.py --format json
```

Do not run an Azure mirror or usage merge. Legacy E2E/cmev1 issuance detail is
retained in Git history for explicitly authorized recovery only.
