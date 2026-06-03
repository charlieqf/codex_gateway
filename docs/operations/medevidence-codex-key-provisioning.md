# MedEvidence Codex Gateway Key Provisioning

## Real User cgu_live Key

For a real Desktop/MedEvidence user who should receive one opaque client
credential, use the Gateway-owned billing/v2 path. This path creates the
Gateway subject, automatically asks MedEvidence v2 to create the hidden v2 key,
creates the backing Gateway key, wraps both runtime credentials as one
`cgu_live_*` key, validates resolve/current-credential endpoints, and writes
the full key only to a local handoff JSON.

Do not hand-issue a MedEvidence v2 key first for this path. Do not send users
the backing `cgw.*` key or the hidden `mev2_live_*` key.
Use `scripts\issue-real-user-cgu-key.py` for real users. The older
`issue-desktop-e2e-opaque-key.ps1` script name is historical and is retained
below only as a lower-level fallback.

Current Wang Yun-equivalent trial defaults as of 2026-05-21:

- plan: `plan_internal_high_quota_image_v1`
- capabilities: `chat`, `tools`, `image_generation`
- backing Gateway key expiration: `2026-07-01T00:00:00.000Z`
- backing Gateway key rate: `10` requests/minute, `200` requests/day,
  `4` concurrent requests
- scope: `code`

Recommended one-command path:

```powershell
python scripts\issue-real-user-cgu-key.py --name "<real name>" --phone "<phone>"
```

Codex/operator shortcut for a typical request like
"给新用户 张三 13800138000 发key":

```powershell
python scripts\issue-real-user-cgu-key.py --name "张三" --phone 13800138000
```

Preflight without issuing a key:

```powershell
python scripts\issue-real-user-cgu-key.py --name "<real name>" --phone "<phone>" --what-if
```

The Python script defaults `external_user_id` to `phone_<digits>`, grants
`plan_internal_high_quota_image_v1`, sets the backing Gateway key to
`10` rpm, `200` rpd, `4` concurrent requests, expires that backing key at
`2026-07-01T00:00:00.000Z`, validates resolve/current-credential endpoints,
updates the stored name/phone metadata, and writes the full `cgu_live_*` key
only to a local handoff JSON under
`C:\Users\rdpuser\medevidence_api_keys`.

After a successful run, share only the safe summary in chat: `key_prefix`,
`subject_id`, `capabilities`, and `handoff_path`. Deliver the full key only
through the approved private channel using the handoff JSON.

The script reads the Billing Admin token from `GATEWAY_BILLING_ADMIN_TOKEN` if
set; otherwise it reads the current container env over SSH. It must not print
the Billing Admin token, backing `cgw.*` key, hidden `mev2_live_*` key, or full
`cgu_live_*` key to the console. Console output is prefix-only.

For image generation, clients should call `/gateway/images/generations` with
`model: "medcode-image-default"` or omit `model` to use the default. Do not ask
clients to send `gpt-image-2` as the public model name.

Legacy PowerShell path, retained for reference. Preflight with a stable ASCII
external user id:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\issue-desktop-e2e-opaque-key.ps1 `
  -Provider manual_trial `
  -ExternalUserId <stable_ascii_user_id> `
  -DisplayName "<real name>" `
  -PlanId plan_internal_high_quota_image_v1 `
  -WhatIf
```

Issue the opaque key:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\issue-desktop-e2e-opaque-key.ps1 `
  -Provider manual_trial `
  -ExternalUserId <stable_ascii_user_id> `
  -DisplayName "<real name>" `
  -PlanId plan_internal_high_quota_image_v1 `
  -EntitlementDays <days-to-trial-end>
```

The command prints only a safe summary with the `cgu_live_*` prefix, subject id,
plan id, validation status, and handoff path. The full key is written only to
the handoff JSON under `C:\Users\rdpuser\medevidence_api_keys` by default.

Immediately normalize the backing Gateway key to the current real-user trial
guardrails. First resolve the backing prefix without printing runtime keys:

```powershell
$handoffPath = "<handoff-json-path>"
$handoff = Get-Content -LiteralPath $handoffPath -Raw -Encoding UTF8 | ConvertFrom-Json
$resolved = Invoke-RestMethod `
  -Method Post `
  -Uri "$($handoff.base_url)/gateway/unified-keys/resolve" `
  -Headers @{ Authorization = "Bearer $($handoff.key)" } `
  -ContentType "application/json" `
  -Body "{}"

$subjectId = $handoff.subject_id
$gatewayPrefix = $resolved.codex_gateway.key_prefix
```

Then update the live Gateway metadata and backing key inside the container:

```bash
cd /home/qian/codex-gateway-release-4e61f98-20260511T230214Z
sudo docker compose -p codex_gateway_test -f compose.azure.yml exec -T gateway \
  node apps/admin-cli/dist/index.js --db /var/lib/codex-gateway/gateway.db \
  update-user <subject-id> --label "<real name>" --name "<real name>" --phone "<phone>"

sudo docker compose -p codex_gateway_test -f compose.azure.yml exec -T gateway \
  node apps/admin-cli/dist/index.js --db /var/lib/codex-gateway/gateway.db \
  update-key <gateway-prefix> \
  --label "medevidence-unified-<yyyymmdd>-<short-user-id>" \
  --rpm 10 --rpd 200 --concurrent 4 \
  --expires-at 2026-07-01T00:00:00.000Z
```

For non-ASCII names over Windows PowerShell/SSH, verify `list-active-keys`
afterward. If the name appears as `??`, rerun `update-user` through an LF-only
remote script or another UTF-8-safe path before handing off the key.

Final verification:

```powershell
$current = Invoke-RestMethod `
  -Method Get `
  -Uri $handoff.credential_validation_url `
  -Headers @{ Authorization = "Bearer $($resolved.codex_gateway.api_key)" }

[pscustomobject]@{
  key_prefix = $handoff.key_prefix
  resolve_valid = $resolved.valid
  subject_id = $resolved.subject.id
  codex_gateway_prefix = $resolved.codex_gateway.key_prefix
  medevidence_prefix = $resolved.medevidence.key_prefix
  credential_valid = $current.valid
  credential_prefix = $current.credential.prefix
  entitlement_state = $current.entitlement.state
  credential_expires_at = $current.credential.expires_at
  rpm = $current.credential.rate.requestsPerMinute
  rpd = $current.credential.rate.requestsPerDay
  concurrent = $current.credential.rate.concurrentRequests
} | ConvertTo-Json -Depth 8
```

Only share the `cgu_live_*` value through the agreed private channel. Do not
paste full keys into chat, tickets, runbooks, or commit messages.

## Desktop E2E Opaque Key

For Desktop automation that expects the new opaque broker credential, use the
Gateway-owned billing/v2 provisioning path. This creates a billing subject,
lets Gateway request the hidden MedEvidence v2 key, grants the configured plan,
validates resolve/current-credential endpoints, and writes a local handoff JSON.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\issue-desktop-e2e-opaque-key.ps1
```

Expected output is a safe JSON summary containing only the `cgu_live_*` prefix
and the handoff path. The full key is written only to the handoff file under
`C:\Users\rdpuser\medevidence_api_keys` by default.

Use `-WhatIf` to check the derived provider, external user id, plan, and output
location without issuing a key:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\issue-desktop-e2e-opaque-key.ps1 -WhatIf
```

Do not use `scripts/provision-medevidence-codex-key.ps1` for this path. That
legacy script starts from an already-issued MedEvidence v2 JSON file and writes
`cmev1.*`; Desktop E2E opaque handoff should receive only `cgu_live_*`.

## Legacy cmev1 JSON Provisioning

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

The script accepts `-UnifiedKeyMode cmev1|opaque`; the default remains `cmev1`.
`opaque` is intentionally blocked in this provisioning script. Gateway-owned
opaque client keys use the broker format `cgu_live_*` and are issued by the
Admin CLI `unified-key` command path, not by this legacy `cmev1` handoff script.
MedEvidence v2 does not parse `cgu_live_*`; Desktop resolves it through Codex
Gateway and then calls Gateway and MedEvidence with the returned runtime
credentials.

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
- Builds the `cmev1` unified key from the recovered Codex Gateway key and the
  existing MedEvidence v2 `plaintext_api_key`, including the nested
  `api_keys[].plaintext_api_key` shape when exactly one active nested key is
  present.

Do not paste full API keys into chat, tickets, or runbooks. The full key is
written only to the requested local handoff JSON file.
