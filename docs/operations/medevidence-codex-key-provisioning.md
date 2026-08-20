# MedEvidence Codex Gateway Key Provisioning

## Real User cgu_live Key

For a real Desktop/MedEvidence user who should receive one opaque client
credential, use the Gateway-owned billing/v2 path. This path creates the
Gateway subject, automatically asks MedEvidence v2 to create the hidden v2 key,
creates the backing Gateway key, wraps both runtime credentials as one
`cgu_live_*` key on the authoritative R760 Gateway, validates the key and
backing credential on R760, and only then writes the full key to a local
handoff JSON. The handoff points clients to
`https://goldencode.instmarket.com.au:1443`. No compatibility endpoint is
written or validated.

Do not hand-issue a MedEvidence v2 key first for this path. Do not send users
the backing `cgw.*` key or the hidden `mev2_live_*` key.
Use `scripts\issue-real-user-cgu-key.py` for real users. The older
`issue-desktop-e2e-opaque-key.ps1` script name is historical and is retained
below only as a lower-level diagnostic.

Current real-user trial defaults as of 2026-07-01:

- plan: `plan_internal_high_quota_image_v1`
- capabilities: `chat`, `tools`, `image_generation`
- backing Gateway key expiration: defaults to now + 92 days; operator-provided
  `--key-expires-at` values under 90 days are rejected
- entitlement end: defaults to now + 92 days; operator-provided
  `--entitlement-end` values under 90 days are rejected
- backing Gateway key rate: `10` requests/minute, `200` requests/day,
  `4` concurrent requests
- scope: `code`

Recommended one-command path:

```powershell
python scripts\issue-real-user-cgu-key.py --name "<real name>" --phone "<phone>" --client-version "<strict-semver>"
```

The script is always R760-only. `--client-version` is required and is sent on
the public resolver and credential-validation requests so the same command
continues to work after the Desktop 426 gate is enabled. The retained
`--r760-only` option is a deprecated no-op.

Codex/operator shortcut for a typical request like
"给新用户 张三 13800138000 发key":

```powershell
python scripts\issue-real-user-cgu-key.py --name "张三" --phone 13800138000 --client-version "<strict-semver>"
```

Preflight without issuing a key:

```powershell
python scripts\issue-real-user-cgu-key.py --name "<real name>" --phone "<phone>" --client-version "<strict-semver>" --what-if
```

The Python script defaults `external_user_id` to `phone_<digits>`, grants
`plan_internal_high_quota_image_v1`, sets the backing Gateway key to
`10` rpm, `200` rpd, `4` concurrent requests, expires that backing key and
the entitlement at least 90 days in the future and updates the stored
name/phone metadata on R760. The issue script then validates the fixed R760 resolver
URLs, backing credential, active entitlement and image capability. It writes the full
`cgu_live_*` key only to a pseudonymously named local handoff JSON under
`C:\Users\rdpuser\medevidence_api_keys`. `--skip-credential-validation` is
intentionally rejected for real-user issuance.

After a successful run, share only the safe summary in chat: `key_prefix`,
`subject_id`, `capabilities`, and `handoff_path`. Deliver the full key only
through the approved private channel using the handoff JSON.

The script reads the Billing Admin token from `GATEWAY_BILLING_ADMIN_TOKEN` if
set; otherwise it reads the current container env over SSH. It must not print
the Billing Admin token, backing `cgw.*` key, hidden `mev2_live_*` key, or full
`cgu_live_*` key to the console. Console output is limited to safe prefixes,
identifiers, counts, validation status and backup/handoff paths.

All user enable/disable, key revoke/update, plan and entitlement changes must
target R760 only. `manage-r760-gateway-control.py` is not an approved current
mutation path while it still performs a compatibility mirror; follow the
reviewed R760-only procedure in `r760-control-plane-authority.md`.

Query authoritative usage directly from R760:

```powershell
python scripts\check-daily-usage-health.py --format json
```

Do not run a compatibility usage merge as a reporting prerequisite. Full
operating rules are in
`docs/operations/r760-control-plane-authority.md`.

For image generation, clients should call `/gateway/images/generations` with
`model: "medcode-image-default"` or omit `model` to use the default. Do not ask
clients to send `gpt-image-2` as the public model name.

Legacy PowerShell path, retained only for diagnostics and E2E recovery. Its
defaults now point to R760.
It is not an approved real-user issue path because it does not itself enforce
the formal billing/v2 issuance and R760 validation flow. Preflight with a
stable ASCII external user id:

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
cd /home/qian/codex-gateway-release-4697fba-20260803T083513Z
sudo docker compose -p codex_gateway_test -f compose.azure.yml exec -T gateway \
  node apps/admin-cli/dist/index.js --db /var/lib/codex-gateway/gateway.db \
  update-user <subject-id> --label "<real name>" --name "<real name>" --phone "<phone>"

sudo docker compose -p codex_gateway_test -f compose.azure.yml exec -T gateway \
  node apps/admin-cli/dist/index.js --db /var/lib/codex-gateway/gateway.db \
  update-key <gateway-prefix> \
  --label "medevidence-unified-<yyyymmdd>-<short-user-id>" \
  --rpm 10 --rpd 200 --concurrent 4 \
  --expires-at <iso-at-least-90-days-from-now>
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

This section is historical recovery guidance only. Do not use
`scripts/provision-medevidence-codex-key.ps1` for a new user: it defaults to the
Azure compatibility stack, produces legacy `cmev1.*`, and does not enforce the
current R760-only billing/v2 validation workflow. Use it only after explicit
approval for an existing MedEvidence v2 JSON recovery, then validate the
resulting R760 control state separately.

Default legacy cmev1 provisioning settings:

- plan: `plan_internal_high_quota_v1`
- key expiration: defaults to now + 92 days
- entitlement end: defaults to now + 92 days; values under 90 days are rejected
- rate: `10` requests/minute, `200` requests/day, `4` concurrent requests

Dry-run the derived user id and label:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\provision-medevidence-codex-key.ps1 `
  -IssuedJsonPath C:\Users\rdpuser\medevidence_api_keys\<legacy-issued-file>.json `
  -WhatIf
```

Provision or reuse the key:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\provision-medevidence-codex-key.ps1 `
  -IssuedJsonPath C:\Users\rdpuser\medevidence_api_keys\<legacy-issued-file>.json
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
