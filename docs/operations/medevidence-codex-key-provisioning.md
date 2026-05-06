# MedEvidence Codex Gateway Key Provisioning

Use `scripts/provision-medevidence-codex-key.ps1` after the MedEvidence v2 key
file already exists locally. The script provisions or reuses the matching Codex
Gateway user, API key, and plan entitlement, then writes a `codex_gateway`
section and a top-level `unified_key` back into the same JSON file.

Default production trial settings match Wang Yun's current access:

- plan: `plan_internal_high_quota_v1`
- key expiration: `2026-07-01T00:00:00.000Z`
- entitlement end: `2026-07-01T00:00:00.000Z`
- rate: `10` requests/minute, `200` requests/day, `4` concurrent requests

Dry-run the derived user id and label:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\provision-medevidence-codex-key.ps1 `
  -IssuedJsonPath C:\Users\rdpuser\medevidence_api_keys\issued_20260506-200941_fengqian.json `
  -WhatIf
```

Provision or reuse the key:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\provision-medevidence-codex-key.ps1 `
  -IssuedJsonPath C:\Users\rdpuser\medevidence_api_keys\issued_20260506-200941_fengqian.json
```

Expected output prints only a masked prefix and operational status, for example:

```json
{
  "credential_mode": "reused",
  "entitlement_mode": "reused",
  "validation": "ok",
  "unified_key_written": true,
  "short_active_keys": 0,
  "short_active_entitlements": 0
}
```

The unified key is a composed credential for clients that need one pasted value:

```text
cmev1.<codex-gateway-api-key>.<medevidence-v2-api-key>
```

The script writes the full value to `unified_key` and the version marker to
`unified_key_version`. Do not print the full value in logs or chat.

The script is intentionally defensive:

- Reads JSON with or without a UTF-8 BOM.
- Preserves the original top-level JSON shape, including single-element arrays.
- Avoids nested SSH quoting by base64-wrapping the remote script and passing
  Docker/Admin CLI arguments as arrays from Node.
- Sets the VM-local Node path before running remote orchestration.
- Uses `docker compose exec -T` so compose cannot consume remaining script
  input.
- Creates a gateway state backup before write operations unless `-NoBackup` is
  passed.
- Reuses an existing active key with the same generated label unless
  `-ForceNewKey` is passed.
- Validates `GET /gateway/credentials/current` with the resulting key.
- Checks that no active key or active entitlement expires before the configured
  cutoff.
- Builds the unified key from the recovered Codex Gateway key and the existing
  top-level MedEvidence v2 `plaintext_api_key`.

Do not paste full API keys into chat, tickets, or runbooks. The full key is
written only to the requested local handoff JSON file.
