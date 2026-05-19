#requires -Version 5.1
<#
.SYNOPSIS
Issue a Desktop E2E opaque unified key through the Gateway billing subject API.

.DESCRIPTION
This is the operator path for creating a Desktop automation credential after
the Gateway billing/v2 provisioning flow is available. It calls the public
Billing Admin API to create a subject, lets Gateway request the hidden
MedEvidence v2 key, grants a plan entitlement, validates opaque-key resolve,
validates the returned Gateway credential, and writes a local handoff JSON.

The console output never prints the full cgu_live key or the resolved runtime
keys. The full opaque key is written only to the local handoff file.

.EXAMPLE
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\issue-desktop-e2e-opaque-key.ps1

.EXAMPLE
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\issue-desktop-e2e-opaque-key.ps1 `
  -ExternalUserId desktop_ci_20260512 `
  -OutputDir C:\Users\rdpuser\medevidence_api_keys

.EXAMPLE
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\issue-desktop-e2e-opaque-key.ps1 -WhatIf
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$GatewayBaseUrl = "https://gw.instmarket.com.au",
  [string]$Provider = "desktop_e2e",
  [string]$ExternalUserId,
  [string]$DisplayName = "Desktop E2E Automation",
  [string]$PlanId = "plan_paid_monthly_v1",
  [int]$EntitlementDays = 365,
  [ValidateSet("code", "medical")]
  [string]$Scope = "code",
  [string]$OutputDir = "C:\Users\rdpuser\medevidence_api_keys",

  [string]$BillingAdminToken = $env:GATEWAY_BILLING_ADMIN_TOKEN,
  [string]$VmHost = "4.242.58.89",
  [string]$VmUser = "qian",
  [string]$SshKey = "$HOME\.ssh\medevidence_azure_wus2_ed25519",
  [string]$RemoteRepo = "/home/qian/codex-gateway-release-4e61f98-20260511T230214Z",
  [string]$ComposeProject = "codex_gateway_test",
  [string]$ComposeFile = "compose.azure.yml",
  [string]$GatewayService = "gateway",

  [int]$TimeoutSeconds = 45,
  [switch]$SkipCredentialValidation,
  [switch]$DisableOnFailure = $true
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"

function Write-Utf8NoBom {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Text
  )
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [IO.File]::WriteAllText($Path, $Text, $utf8NoBom)
}

function Get-SafeTimestamp {
  (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ")
}

function Normalize-BaseUrl {
  param([Parameter(Mandatory = $true)][string]$Value)
  $trimmed = $Value.TrimEnd("/")
  if ($trimmed -notmatch "^https?://") {
    throw "GatewayBaseUrl must start with http:// or https://."
  }
  $trimmed
}

function Test-ExternalUserId {
  param([Parameter(Mandatory = $true)][string]$Value)
  if ($Value -notmatch "^[A-Za-z0-9._-]{1,128}$") {
    throw "ExternalUserId must match [A-Za-z0-9._-]{1,128}."
  }
}

function Get-BillingAdminToken {
  if (-not [string]::IsNullOrWhiteSpace($BillingAdminToken)) {
    return $BillingAdminToken.Trim()
  }

  if (-not (Test-Path -LiteralPath $SshKey)) {
    throw "Billing admin token is not set and SSH key was not found: $SshKey"
  }

  $remote = "$VmUser@$VmHost"
  $remoteCommand = "cd $RemoteRepo && sudo docker compose -p $ComposeProject -f $ComposeFile exec -T $GatewayService printenv GATEWAY_BILLING_ADMIN_TOKEN"
  $token = (& ssh -i $SshKey $remote $remoteCommand)
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to read GATEWAY_BILLING_ADMIN_TOKEN from the live Gateway container."
  }
  $joined = ($token -join "`n").Trim()
  if ([string]::IsNullOrWhiteSpace($joined)) {
    throw "GATEWAY_BILLING_ADMIN_TOKEN is empty in the live Gateway container."
  }
  $joined
}

function Invoke-BillingJson {
  param(
    [Parameter(Mandatory = $true)][ValidateSet("Get", "Post")][string]$Method,
    [Parameter(Mandatory = $true)][string]$Uri,
    [Parameter(Mandatory = $true)][hashtable]$Headers,
    [object]$Body
  )

  try {
    if ($Method -eq "Get") {
      return Invoke-RestMethod -Method Get -Uri $Uri -Headers $Headers -TimeoutSec $TimeoutSeconds
    }
    $json = if ($null -eq $Body) { "{}" } else { $Body | ConvertTo-Json -Depth 20 }
    $postHeaders = $Headers.Clone()
    if ($postHeaders.ContainsKey("Content-Type")) {
      $postHeaders.Remove("Content-Type")
    }
    return Invoke-RestMethod `
      -Method Post `
      -Uri $Uri `
      -Headers $postHeaders `
      -ContentType "application/json; charset=utf-8" `
      -Body ([Text.Encoding]::UTF8.GetBytes($json)) `
      -TimeoutSec $TimeoutSeconds
  } catch {
    $message = $_.Exception.Message
    $response = $_.Exception.Response
    if ($response -and $response.GetResponseStream()) {
      try {
        $reader = New-Object IO.StreamReader($response.GetResponseStream())
        $bodyText = $reader.ReadToEnd()
        if ($bodyText) {
          $payload = ConvertFrom-Json -InputObject $bodyText
          if ($payload.error.code) {
            $message = "$message code=$($payload.error.code) message=$($payload.error.message)"
          }
        }
      } catch {
        # Keep the original exception text if the error body is not JSON.
      }
    }
    throw $message
  }
}

function Disable-SubjectBestEffort {
  param(
    [Parameter(Mandatory = $true)][string]$BaseUrl,
    [Parameter(Mandatory = $true)][hashtable]$Headers,
    [Parameter(Mandatory = $true)][string]$SubjectId,
    [Parameter(Mandatory = $true)][string]$IdempotencyKey
  )

  try {
    $disableHeaders = $Headers.Clone()
    $disableHeaders["Idempotency-Key"] = $IdempotencyKey
    [void](Invoke-BillingJson `
      -Method Post `
      -Uri "$BaseUrl/gateway/admin/billing/v1/subjects/$SubjectId/disable" `
      -Headers $disableHeaders `
      -Body @{ reason = "desktop_e2e_issue_failed_cleanup" })
    Write-Warning "Issue failed after subject creation; disabled partial subject $SubjectId."
  } catch {
    Write-Warning "Issue failed after subject creation and cleanup disable also failed for $SubjectId."
  }
}

$baseUrl = Normalize-BaseUrl $GatewayBaseUrl
$stamp = Get-SafeTimestamp
if ([string]::IsNullOrWhiteSpace($ExternalUserId)) {
  $ExternalUserId = "automation_$stamp"
}
Test-ExternalUserId $ExternalUserId

if ($EntitlementDays -lt 1) {
  throw "EntitlementDays must be positive."
}

$targetDescription = "$Provider/$ExternalUserId"
if (-not $PSCmdlet.ShouldProcess($targetDescription, "issue Desktop E2E cgu_live opaque key")) {
  [pscustomobject]@{
    what_if = $true
    provider = $Provider
    external_user_id = $ExternalUserId
    display_name = $DisplayName
    gateway_base_url = $baseUrl
    plan_id = $PlanId
    entitlement_days = $EntitlementDays
    output_dir = $OutputDir
  } | ConvertTo-Json -Depth 8
  return
}

$subjectId = $null
$completed = $false
$billingToken = $null
$createdSubjectThisRun = $false
try {
  $billingToken = Get-BillingAdminToken
  if ($billingToken.Length -lt 24) {
    throw "Billing admin token must be at least 24 characters."
  }

  $headers = @{
    Authorization = "Bearer $billingToken"
    "Content-Type" = "application/json"
  }

  $createHeaders = $headers.Clone()
  $createHeaders["Idempotency-Key"] = "$Provider`:$ExternalUserId`:create_subject"
  $createBody = [ordered]@{
    provider = $Provider
    external_user_id = $ExternalUserId
    display_name = $DisplayName
    scope_allowlist = @($Scope)
    metadata = [ordered]@{
      purpose = "desktop_e2e_automation"
      issued_by = "issue-desktop-e2e-opaque-key.ps1"
      created_at = (Get-Date).ToUniversalTime().ToString("o")
    }
  }
  $create = Invoke-BillingJson `
    -Method Post `
    -Uri "$baseUrl/gateway/admin/billing/v1/subjects" `
    -Headers $createHeaders `
    -Body $createBody

  if ($create.idempotent_replay -eq $true -and -not $create.credential.key) {
    throw "Billing subject create was an idempotent replay. The opaque key is only returned once; use a new ExternalUserId or rotate the subject key."
  }
  if (-not $create.credential.key -or -not ([string]$create.credential.key).StartsWith("cgu_live_")) {
    throw "Billing subject create did not return a cgu_live opaque key."
  }
  $subjectId = [string]$create.subject.id
  $createdSubjectThisRun = ($create.created -eq $true -and $create.idempotent_replay -ne $true)

  $periodStart = [DateTimeOffset]::UtcNow
  $periodEnd = $periodStart.AddDays($EntitlementDays)
  $entitlementHeaders = $headers.Clone()
  $entitlementHeaders["Idempotency-Key"] = "$Provider`:$ExternalUserId`:purchase:$stamp"
  $entitlementBody = [ordered]@{
    event_type = "purchase"
    apply_mode = "apply"
    provider = $Provider
    external_order_id = "desktop_e2e_$stamp"
    external_event_id = "evt_$stamp"
    subject_id = $subjectId
    plan_id = $PlanId
    period_kind = "one_off"
    period_start = $periodStart.ToString("o")
    period_end = $periodEnd.ToString("o")
    replace_current = $true
    amount_minor = 0
    currency = "USD"
    metadata = [ordered]@{
      purpose = "desktop_e2e_automation"
      note = "No-charge internal E2E automation entitlement"
    }
  }
  $entitlement = Invoke-BillingJson `
    -Method Post `
    -Uri "$baseUrl/gateway/admin/billing/v1/entitlement-events" `
    -Headers $entitlementHeaders `
    -Body $entitlementBody
  if (-not $entitlement.applied -or $entitlement.entitlement.state -ne "active") {
    throw "Entitlement grant did not become active."
  }

  $resolveHeaders = @{
    Authorization = "Bearer $($create.credential.key)"
    "Content-Type" = "application/json"
  }
  $resolved = Invoke-BillingJson `
    -Method Post `
    -Uri "$baseUrl/gateway/unified-keys/resolve" `
    -Headers $resolveHeaders `
    -Body @{}
  if (-not $resolved.valid -or $resolved.subject.id -ne $subjectId) {
    throw "Opaque key resolve validation failed."
  }
  if (-not $resolved.codex_gateway.api_key -or -not $resolved.medevidence.api_key) {
    throw "Opaque key resolve response did not include both runtime credentials."
  }

  $capabilities = @()
  if (-not $SkipCredentialValidation) {
    $currentHeaders = @{ Authorization = "Bearer $($resolved.codex_gateway.api_key)" }
    $current = Invoke-BillingJson `
      -Method Get `
      -Uri "$baseUrl/gateway/credentials/current" `
      -Headers $currentHeaders
    if (-not $current.valid -or $current.subject.id -ne $subjectId -or $current.entitlement.state -ne "active") {
      throw "Gateway credential validation failed."
    }
    $capabilities = @($current.entitlement.feature_policy.capabilities)
  }

  New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
  $handoffPath = Join-Path $OutputDir "desktop_e2e_opaque_$stamp.json"
  $handoff = [ordered]@{
    key_type = "opaque_unified_cgu_live"
    key = [string]$create.credential.key
    key_prefix = [string]$create.credential.key_prefix
    subject_id = $subjectId
    provider = $Provider
    external_user_id = $ExternalUserId
    display_name = $DisplayName
    base_url = $baseUrl
    openai_compatible_base_url = "$baseUrl/v1"
    resolve_url = "$baseUrl/gateway/unified-keys/resolve"
    credential_validation_url = "$baseUrl/gateway/credentials/current"
    plan_id = [string]$entitlement.entitlement.plan_id
    entitlement_id = [string]$entitlement.entitlement.id
    entitlement_period_start = [string]$entitlement.entitlement.period_start
    entitlement_period_end = [string]$entitlement.entitlement.period_end
    capabilities = $capabilities
    issued_at = [string]$create.credential.issued_at
    expires_at = [string]$create.credential.expires_at
    notes = @(
      "Give Desktop this cgu_live key, not the underlying cgw or MedEvidence v2 keys.",
      "Desktop should call /gateway/unified-keys/resolve and then use returned runtime credentials."
    )
  }
  Write-Utf8NoBom -Path $handoffPath -Text (($handoff | ConvertTo-Json -Depth 20) + "`r`n")
  try {
    icacls $handoffPath /inheritance:r /grant:r "$($env:USERNAME):(R,W)" | Out-Null
  } catch {
    Write-Warning "Could not tighten ACLs on handoff file: $handoffPath"
  }

  $completed = $true
  [pscustomobject]@{
    issued = "ok"
    key_type = "cgu_live"
    subject_id = $subjectId
    key_prefix = [string]$create.credential.key_prefix
    plan_id = [string]$entitlement.entitlement.plan_id
    entitlement_state = [string]$entitlement.entitlement.state
    capabilities = $capabilities
    resolve_validation = "ok"
    credential_validation = if ($SkipCredentialValidation) { "skipped" } else { "ok" }
    handoff_path = $handoffPath
  } | ConvertTo-Json -Depth 8
} finally {
  if (-not $completed -and $DisableOnFailure -and $subjectId -and $createdSubjectThisRun) {
    if ([string]::IsNullOrWhiteSpace($billingToken)) {
      $billingToken = Get-BillingAdminToken
    }
    $cleanupHeaders = @{
      Authorization = "Bearer $billingToken"
      "Content-Type" = "application/json"
    }
    Disable-SubjectBestEffort `
      -BaseUrl $baseUrl `
      -Headers $cleanupHeaders `
      -SubjectId $subjectId `
      -IdempotencyKey "$Provider`:$subjectId`:disable_subject:issue_failed_cleanup"
  }
}
