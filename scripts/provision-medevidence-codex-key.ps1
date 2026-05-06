#requires -Version 5.1
<#
.SYNOPSIS
Provision or reuse a Codex Gateway API key for a MedEvidence v2 issued-key JSON file.

.DESCRIPTION
This script is the hardened operator path for adding the codex_gateway section to
a MedEvidence API key handoff file. It handles UTF-8 BOM JSON, preserves the
original array/object JSON root shape, avoids fragile nested SSH quoting by
base64-wrapping the remote Node script, sets the VM-local Node PATH, uses
docker compose exec -T, creates a gateway state backup before writes, validates
the public credential endpoint, and checks that no active key or entitlement
expires before the requested cutoff.

The full API key is written only into the requested local JSON file. Console
output prints only a masked prefix. By default the script also writes a
top-level `unified_key` in the form:

  cmev1.<codex-gateway-api-key>.<medevidence-v2-api-key>

.EXAMPLE
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\provision-medevidence-codex-key.ps1 `
  -IssuedJsonPath C:\Users\rdpuser\medevidence_api_keys\issued_20260506-200941_fengqian.json

.EXAMPLE
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\provision-medevidence-codex-key.ps1 `
  -IssuedJsonPath C:\Users\rdpuser\medevidence_api_keys\issued_20260506-200941_fengqian.json `
  -WhatIf
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [Parameter(Mandatory = $true)]
  [string]$IssuedJsonPath,

  [string]$VmHost = "4.242.58.89",
  [string]$VmUser = "qian",
  [string]$SshKey = "$HOME\.ssh\medevidence_azure_wus2_ed25519",
  [string]$RemoteRepo = "/home/qian/codex-gateway-test",
  [string]$ComposeProject = "codex_gateway_test",
  [string]$ComposeFile = "compose.azure.yml",
  [string]$GatewayService = "gateway",
  [string]$GatewayDb = "/var/lib/codex-gateway/gateway.db",
  [string]$GatewayBaseUrl = "https://gw.instmarket.com.au",
  [string]$UnifiedKeyVersion = "cmev1",

  [string]$PlanId = "plan_internal_high_quota_v1",
  [string]$PeriodEnd = "2026-07-01T00:00:00.000Z",
  [ValidateSet("code", "medical")]
  [string]$Scope = "code",
  [int]$RequestsPerMinute = 10,
  [int]$RequestsPerDay = 200,
  [int]$ConcurrentRequests = 4,

  [string]$UserId,
  [string]$KeyLabel,
  [switch]$ForceNewKey,
  [switch]$NoBackup,
  [switch]$SkipCredentialValidation,
  [switch]$SkipUnifiedKey
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"

function Read-JsonPreservingRoot {
  param([Parameter(Mandatory = $true)][string]$Path)

  $raw = [IO.File]::ReadAllText($Path, [Text.Encoding]::UTF8)
  $raw = $raw -replace "^\uFEFF", ""
  $trimmed = $raw.TrimStart()
  $wasArray = $trimmed.StartsWith("[")
  $root = ConvertFrom-Json -InputObject $raw
  $entries = @($root)
  if ($entries.Count -lt 1) {
    throw "JSON file has no entries: $Path"
  }

  [pscustomobject]@{
    Root = $root
    Entries = [object[]]$entries
    WasArray = $wasArray
  }
}

function Write-JsonPreservingRoot {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][object[]]$Entries,
    [Parameter(Mandatory = $true)][bool]$WasArray
  )

  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  if ($WasArray) {
    $json = ConvertTo-Json -InputObject @($Entries) -Depth 50
  } else {
    $json = ConvertTo-Json -InputObject $Entries[0] -Depth 50
  }
  [IO.File]::WriteAllText($Path, $json + "`r`n", $utf8NoBom)
}

function Get-DefaultLabel {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$PrincipalId
  )

  $leaf = [IO.Path]::GetFileNameWithoutExtension($Path)
  if ($leaf -match "^issued_(\d{8})-\d{6}_(.+)$") {
    $date = $Matches[1]
    $suffix = ($Matches[2] -replace "[^A-Za-z0-9_-]", "-").Trim("-")
    if ($suffix.Length -gt 0) {
      return "medevidence-unified-$date-$suffix"
    }
  }

  $today = (Get-Date).ToUniversalTime().ToString("yyyyMMdd")
  return "medevidence-unified-$today-$($PrincipalId.Substring(0, [Math]::Min(12, $PrincipalId.Length)))"
}

function ConvertTo-Base64Utf8 {
  param([Parameter(Mandatory = $true)][string]$Value)
  [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Value))
}

function New-UnifiedKey {
  param(
    [Parameter(Mandatory = $true)][string]$Version,
    [Parameter(Mandatory = $true)][string]$CodexGatewayToken,
    [Parameter(Mandatory = $true)][string]$MedEvidenceV2Token
  )

  if ($Version -notmatch "^[A-Za-z0-9_-]+$") {
    throw "Unified key version contains unsupported characters: $Version"
  }
  if ($CodexGatewayToken -notmatch "^cgw\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{16,}$") {
    throw "Codex Gateway token does not match the expected cgw.<prefix>.<secret> format."
  }
  if ($MedEvidenceV2Token -notmatch "^[A-Za-z0-9_-]+$") {
    throw "MedEvidence v2 plaintext key must not contain whitespace or dot separators."
  }

  "$Version.$CodexGatewayToken.$MedEvidenceV2Token"
}

function Invoke-RemoteNodeProvision {
  param(
    [Parameter(Mandatory = $true)][hashtable]$Payload,
    [Parameter(Mandatory = $true)][string]$Target,
    [Parameter(Mandatory = $true)][string]$KeyPath
  )

  $payloadJson = ConvertTo-Json -InputObject $Payload -Depth 20 -Compress
  $payloadB64 = ConvertTo-Base64Utf8 $payloadJson
  $remoteScript = @'
set -euo pipefail
export NODE_HOME="$HOME/.local/codex-gateway-node"
export PATH="$NODE_HOME/bin:$PATH"
if ! command -v node >/dev/null 2>&1; then
  echo "node_not_found" >&2
  exit 127
fi
PAYLOAD_B64='__PAYLOAD_B64__' node --input-type=module <<'NODE'
import { execFileSync } from "node:child_process";
import { Buffer } from "node:buffer";

const payload = JSON.parse(Buffer.from(process.env.PAYLOAD_B64, "base64").toString("utf8"));
process.chdir(payload.remoteRepo);

function run(file, args, options = {}) {
  return execFileSync(file, args, {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    ...options
  });
}

function compose(args) {
  return run("sudo", [
    "docker",
    "compose",
    "-p",
    payload.composeProject,
    "-f",
    payload.composeFile,
    ...args
  ]);
}

function admin(args) {
  const stdout = compose([
    "exec",
    "-T",
    payload.gatewayService,
    "node",
    "apps/admin-cli/dist/index.js",
    "--db",
    payload.gatewayDb,
    ...args
  ]);
  return JSON.parse(stdout);
}

function sqliteAll(sql, params = []) {
  const source = `
import { DatabaseSync } from "node:sqlite";
import { Buffer } from "node:buffer";
const db = new DatabaseSync(process.argv[1]);
const sql = Buffer.from(process.argv[2], "base64").toString("utf8");
const params = JSON.parse(Buffer.from(process.argv[3], "base64").toString("utf8"));
const rows = db.prepare(sql).all(...params);
db.close();
console.log(JSON.stringify(rows));
`;
  const stdout = compose([
    "exec",
    "-T",
    payload.gatewayService,
    "node",
    "--input-type=module",
    "-e",
    source,
    payload.gatewayDb,
    Buffer.from(sql, "utf8").toString("base64"),
    Buffer.from(JSON.stringify(params), "utf8").toString("base64")
  ]);
  return JSON.parse(stdout);
}

function backupState() {
  if (payload.noBackup) {
    return null;
  }
  run("mkdir", ["-p", "backups"]);
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const safe = payload.userId.replace(/[^A-Za-z0-9_.-]/g, "-");
  const backupPath = `${payload.remoteRepo}/backups/gateway-state-before-issue-${safe}-${stamp}.tgz`;
  run("sudo", [
    "tar",
    "-czf",
    backupPath,
    "-C",
    "/var/lib/docker/volumes/codex_gateway_test_gateway_state/_data",
    "."
  ]);
  run("sudo", ["chown", `${process.env.USER}:${process.env.USER}`, backupPath]);
  return backupPath;
}

function activeCredentialForLabel() {
  const listed = admin(["list", "--user", payload.userId, "--active-only"]);
  const credentials = Array.isArray(listed.credentials) ? listed.credentials : [];
  return credentials.find((credential) => credential.label === payload.keyLabel && credential.scope === payload.scope) ?? null;
}

function activeEntitlementForPlan() {
  const listed = admin(["entitlement", "list", "--user", payload.userId, "--state", "active"]);
  const entitlements = Array.isArray(listed.entitlements) ? listed.entitlements : [];
  return entitlements.find((entitlement) => {
    if (entitlement.plan_id !== payload.planId || entitlement.state !== "active") {
      return false;
    }
    return entitlement.period_end === null || Date.parse(entitlement.period_end) >= Date.parse(payload.periodEnd);
  }) ?? null;
}

function ensureCredential() {
  const existing = payload.forceNewKey ? null : activeCredentialForLabel();
  if (existing) {
    const revealed = admin(["reveal-key", existing.prefix]);
    return {
      mode: "reused",
      credential: revealed.credential,
      token: revealed.credential.token
    };
  }

  const issued = admin([
    "issue",
    "--user",
    payload.userId,
    "--user-label",
    payload.displayName,
    "--name",
    payload.displayName,
    "--phone",
    payload.phone,
    "--label",
    payload.keyLabel,
    "--scope",
    payload.scope,
    "--expires-days",
    "56",
    "--rpm",
    String(payload.requestsPerMinute),
    "--rpd",
    String(payload.requestsPerDay),
    "--concurrent",
    String(payload.concurrentRequests),
    "--no-entitlement-check"
  ]);
  return {
    mode: "issued",
    credential: issued.credential,
    token: issued.token
  };
}

function ensureEntitlement() {
  const existing = activeEntitlementForPlan();
  if (existing) {
    return {
      mode: "reused",
      entitlement: existing
    };
  }
  const granted = admin([
    "entitlement",
    "grant",
    "--user",
    payload.userId,
    "--plan",
    payload.planId,
    "--period",
    "one_off",
    "--end",
    payload.periodEnd,
    "--replace",
    "--notes",
    "Match Wang Yun high quota plan"
  ]);
  return {
    mode: "granted",
    entitlement: granted.entitlement
  };
}

function ensureCredentialPolicy(prefix) {
  const updated = admin([
    "update-key",
    prefix,
    "--expires-at",
    payload.periodEnd,
    "--rpm",
    String(payload.requestsPerMinute),
    "--rpd",
    String(payload.requestsPerDay),
    "--concurrent",
    String(payload.concurrentRequests)
  ]);
  return updated.credential;
}

const backupPath = backupState();
const credentialResult = ensureCredential();
const entitlementResult = ensureEntitlement();
const updatedCredential = ensureCredentialPolicy(credentialResult.credential.prefix);
const plan = admin(["plan", "show", payload.planId]).plan;

const cutoff = payload.periodEnd;
const shortKeys = sqliteAll(
  `
  SELECT s.id, s.name, ac.prefix, ac.expires_at
  FROM access_credentials ac
  JOIN subjects s ON s.id = ac.subject_id
  WHERE ac.revoked_at IS NULL
    AND s.state = 'active'
    AND datetime(ac.expires_at) > datetime('now')
    AND datetime(ac.expires_at) < datetime(?)
  ORDER BY ac.expires_at
  `,
  [cutoff]
);
const shortEntitlements = sqliteAll(
  `
  SELECT s.id, s.name, e.id AS entitlement_id, e.plan_id, e.period_end
  FROM entitlements e
  JOIN subjects s ON s.id = e.subject_id
  WHERE e.state = 'active'
    AND s.state = 'active'
    AND e.period_end IS NOT NULL
    AND datetime(e.period_end) < datetime(?)
  ORDER BY e.period_end
  `,
  [cutoff]
);

console.log(JSON.stringify({
  backup_path: backupPath,
  credential_mode: credentialResult.mode,
  entitlement_mode: entitlementResult.mode,
  token: credentialResult.token,
  credential: updatedCredential,
  plan,
  entitlement: entitlementResult.entitlement,
  access_check: {
    cutoff,
    short_keys: shortKeys,
    short_entitlements: shortEntitlements
  }
}));
NODE
'@
  $remoteScript = $remoteScript.Replace("__PAYLOAD_B64__", $payloadB64)
  $scriptB64 = ConvertTo-Base64Utf8 $remoteScript

  $sshArgs = @(
    "-i", $KeyPath,
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=8",
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "IdentitiesOnly=yes",
    $Target,
    "echo $scriptB64 | base64 -d | bash"
  )
  $stdout = & ssh @sshArgs
  if ($LASTEXITCODE -ne 0) {
    throw "Remote provisioning failed with exit code $LASTEXITCODE."
  }
  ConvertFrom-Json -InputObject ($stdout -join "`n")
}

function Test-CurrentCredential {
  param(
    [Parameter(Mandatory = $true)][string]$BaseUrl,
    [Parameter(Mandatory = $true)][string]$Token,
    [Parameter(Mandatory = $true)][string]$ExpectedUserId,
    [Parameter(Mandatory = $true)][string]$ExpectedPrefix
  )

  $response = Invoke-RestMethod `
    -Method Get `
    -Uri "$BaseUrl/gateway/credentials/current" `
    -Headers @{ Authorization = "Bearer $Token" } `
    -TimeoutSec 30
  if ($response.subject.id -ne $ExpectedUserId) {
    throw "Credential validation returned user '$($response.subject.id)', expected '$ExpectedUserId'."
  }
  if ($response.credential.prefix -ne $ExpectedPrefix) {
    throw "Credential validation returned prefix '$($response.credential.prefix)', expected '$ExpectedPrefix'."
  }
  if ($response.entitlement.state -ne "active") {
    throw "Credential validation returned entitlement state '$($response.entitlement.state)'."
  }
  $response
}

$resolvedPath = (Resolve-Path -LiteralPath $IssuedJsonPath).Path
$jsonState = Read-JsonPreservingRoot -Path $resolvedPath
if ($jsonState.Entries.Count -ne 1) {
  throw "Expected exactly one MedEvidence key entry in $resolvedPath; found $($jsonState.Entries.Count)."
}

$entry = $jsonState.Entries[0]
foreach ($field in @("principal_id", "display_name", "phone_e164")) {
  if (-not $entry.PSObject.Properties[$field] -or [string]::IsNullOrWhiteSpace([string]$entry.$field)) {
    throw "Missing required field '$field' in $resolvedPath."
  }
}

$medEvidenceV2Token = $null
if ($entry.PSObject.Properties["plaintext_api_key"]) {
  $medEvidenceV2Token = [string]$entry.plaintext_api_key
}
if (-not $SkipUnifiedKey -and [string]::IsNullOrWhiteSpace($medEvidenceV2Token)) {
  throw "Missing top-level plaintext_api_key in $resolvedPath; cannot build unified_key."
}

$principalId = [string]$entry.principal_id
$displayName = [string]$entry.display_name
$phone = [string]$entry.phone_e164
if (-not $UserId) {
  $UserId = "medevidence-$principalId"
}
if (-not $KeyLabel) {
  $KeyLabel = Get-DefaultLabel -Path $resolvedPath -PrincipalId $principalId
}

$payload = @{
  remoteRepo = $RemoteRepo
  composeProject = $ComposeProject
  composeFile = $ComposeFile
  gatewayService = $GatewayService
  gatewayDb = $GatewayDb
  userId = $UserId
  displayName = $displayName
  phone = $phone
  keyLabel = $KeyLabel
  planId = $PlanId
  periodEnd = $PeriodEnd
  scope = $Scope
  requestsPerMinute = $RequestsPerMinute
  requestsPerDay = $RequestsPerDay
  concurrentRequests = $ConcurrentRequests
  forceNewKey = [bool]$ForceNewKey
  noBackup = [bool]$NoBackup
}

$target = "$VmUser@$VmHost"
if (-not $PSCmdlet.ShouldProcess($UserId, "provision Codex Gateway API key and update $resolvedPath")) {
  [pscustomobject]@{
    user_id = $UserId
    display_name = $displayName
    phone = $phone
    key_label = $KeyLabel
    plan_id = $PlanId
    period_end = $PeriodEnd
    unified_key_version = $(if ($SkipUnifiedKey) { $null } else { $UnifiedKeyVersion })
    will_write_unified_key = -not $SkipUnifiedKey
    dry_run = $true
  } | ConvertTo-Json -Depth 5
  exit 0
}

$result = Invoke-RemoteNodeProvision -Payload $payload -Target $target -KeyPath $SshKey
if (-not $result.token) {
  throw "Remote provisioning did not return a recoverable API key token."
}

if (-not $SkipCredentialValidation) {
  [void](Test-CurrentCredential `
    -BaseUrl $GatewayBaseUrl `
    -Token ([string]$result.token) `
    -ExpectedUserId $UserId `
    -ExpectedPrefix ([string]$result.credential.prefix))
}

$codexGateway = [ordered]@{
  endpoint_base_url = "$GatewayBaseUrl/v1"
  credential_validation_url = "$GatewayBaseUrl/gateway/credentials/current"
  user_id = $UserId
  api_key_id = $result.credential.id
  key_prefix = $result.credential.prefix
  label = $result.credential.label
  scope = $result.credential.scope
  status = $result.credential.status
  created_at = $result.credential.created_at
  expires_at = $result.credential.expires_at
  rate = $result.credential.rate
  plaintext_api_key = [string]$result.token
  plan = $result.plan
  entitlement = $result.entitlement
}
$entry | Add-Member -Force -NotePropertyName codex_gateway -NotePropertyValue $codexGateway
if (-not $SkipUnifiedKey) {
  $unifiedKey = New-UnifiedKey `
    -Version $UnifiedKeyVersion `
    -CodexGatewayToken ([string]$result.token) `
    -MedEvidenceV2Token $medEvidenceV2Token
  $entry | Add-Member -Force -NotePropertyName unified_key_version -NotePropertyValue $UnifiedKeyVersion
  $entry | Add-Member -Force -NotePropertyName unified_key -NotePropertyValue $unifiedKey
}
Write-JsonPreservingRoot -Path $resolvedPath -Entries $jsonState.Entries -WasArray $jsonState.WasArray

$shortPrefix = [string]$result.credential.prefix
if ($shortPrefix.Length -gt 8) {
  $shortPrefix = $shortPrefix.Substring(0, 4) + "..." + $shortPrefix.Substring($shortPrefix.Length - 4)
}

[pscustomobject]@{
  user_id = $UserId
  display_name = $displayName
  phone = $phone
  key_prefix = $shortPrefix
  credential_mode = $result.credential_mode
  entitlement_mode = $result.entitlement_mode
  expires_at = $result.credential.expires_at
  plan_id = $result.entitlement.plan_id
  entitlement_end = $result.entitlement.period_end
  backup_path = $result.backup_path
  validation = $(if ($SkipCredentialValidation) { "skipped" } else { "ok" })
  short_active_keys = @($result.access_check.short_keys).Count
  short_active_entitlements = @($result.access_check.short_entitlements).Count
  unified_key_written = -not $SkipUnifiedKey
  file_updated = $resolvedPath
} | ConvertTo-Json -Depth 8
