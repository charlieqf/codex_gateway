# Runbook Index

Last updated: 2026-11-13.

Choose one path for the task. Do not read every operations document.

## Fast Support

| Task | Start here |
| --- | --- |
| Recent 12/24-hour Gateway service review | [固定只读巡检](./gateway-service-review.zh-CN.md) |
| Root disk pressure and archival candidates | [2026-11-13 space assessment](./gateway-root-disk-review-2026-11-13.zh-CN.md); recheck references before any cleanup |
| Named user's Desktop messages | [Desktop User Message Query](./client-message-query-support.zh-CN.md) |
| Generic MedCode unavailable/error | [MedCode Service Unavailable](./medcode-service-unavailable-runbook.md) |
| Model/vision operation-specific error messages | [2026-09-10 Error Copy Release](./r760-model-error-copy-release-2026-09-10.zh-CN.md) |
| Desktop turn/support-code diagnostics | [Desktop Client Turn Diagnostics](./desktop-client-turn-diagnostics-runbook.md) |
| Current production state | [System Status](./system-status.md) |
| R760 access/deployment boundary | [Environment Access](./environment-access.md) |

A named-user message query should immediately run
`scripts/query-client-messages.py`; it does not require the deployment
documents.

## Control And Business Operations

| Task | Runbook |
| --- | --- |
| Real-user key / user / Plan / entitlement / usage | [R760 Control-Plane Authority](./r760-control-plane-authority.md) |
| One user's token quota: look up, reset or gift tokens | [单用户 Token 额度操作](./user-quota-operations.zh-CN.md) |
| Real-user/Desktop key provisioning details | [MedEvidence Codex Key Provisioning](./medevidence-codex-key-provisioning.md) |
| Billing operator console | [Real User Issue Web Console](./real-user-issue-web-console.md) |
| Independent Free/paid balances, cancellation target and reset conflicts | [Quota Contract](../outbox/medevidence-free-paid-quota-contract-2026-09-10.zh-CN.md) (free-allowance clauses superseded), [2026-09-11 Fix Release](./r760-quota-review-fixes-release-2026-09-11.zh-CN.md) |
| Historical one-off Free allowance rollout and free_quota_exhausted contract | [Contract v2](../outbox/medevidence-free-once-quota-contract-2026-09-11.zh-CN.md), [Release](./r760-free-once-release-2026-09-11.zh-CN.md); use [Quota Operations](./user-quota-operations.zh-CN.md) and live entitlements for current amounts |
| Historical 2026-09-11 paid quota adjustment | [Adjustment](./medevidence-plan-quota-adjustment-2026-09-11.zh-CN.md); current limits may differ; verify the live Plan and entitlement through [Quota Operations](./user-quota-operations.zh-CN.md) |
| Internal phone authentication | [Internal Phone Auth v1](./internal-phone-auth-v1.zh-CN.md) |
| MedEvidence Desktop minimum version, upgrade response and login-access recovery | [beta.76 Version Gate Rollout](./medevidence-minimum-version-beta76-2026-09-16.zh-CN.md) |
| Historical: temporary new-user daily 10k free quota (superseded by the one-off allowance) | [2026-09-10 Release](./r760-phone-signup-free-10k-release-2026-09-10.zh-CN.md); active grants were migrated by the schema 30 release |
| SMS login and billing account linking | [Joint Test Contract](../outbox/medevidence-sms-phone-signup-gateway-joint-test-2026-09-09.zh-CN.md), [Compatibility Release](./r760-billing-create-compatibility-release-2026-09-09.zh-CN.md); May create preserved, resolve optional, phone-auth v1 reused; historical daily Free terms are superseded |

## Runtime Components

AF3 is the sole supported protein service: [AF3 Gateway v1](./alphafold3-gateway-v1.md)
and [2026-10-21 acceptance / AF2 retirement](../outbox/alphafold3-gateway-acceptance-2026-10-21/README.md).

| Task | Runbook |
| --- | --- |
| GoldenCode Local context admission | [Local Context Admission Release](./goldencode-local-context-admission-release-2026-08-30.zh-CN.md) |
| Current provider routing and historical restoration | [System Status](./system-status.md) and live routing configuration; dated restoration receipts are historical evidence |
| Gateway failover release and Tencent-only public acceptance | [GoldenCode Failover Release](./goldencode-failover-release-2026-09-07.zh-CN.md) |
| Final provider error / stop client automatic retry | [GoldenCode Terminal Retry Contract](./goldencode-terminal-retry-contract-2026-09-07.zh-CN.md) |
| Tencent/TianKuan bidirectional failover code/configuration | [GoldenCode Failover Implementation](./goldencode-failover-implementation-2026-09-07.zh-CN.md) |
| Tencent/TianKuan bidirectional failover design | [GoldenCode Failover Implementation Plan](./goldencode-tencent-tiankuan-failover-implementation-plan-2026-09-07.zh-CN.md) |
| External Codex configuration | [Codex GoldenCode External Access](./codex-goldencode-external-access.md) |
| CN1 loopback/dark edge | [CN1 GoldenCode Gateway](./cn1-goldencode-gateway.md) |
| R760 image egress | [R760 Mihomo Image Egress](./r760-mihomo-image-egress.md) |
| Runtime config classification | [Runtime Configuration Matrix](./runtime-configuration-change-matrix.md) |
| Container deployment | [Container Deployment](./container-deploy.md) |
| Scheduled database backup, release backup location, retention report | [R760 Backup Operations](./r760-backup-operations.zh-CN.md) |

## Documentation Roles

- `system-status.md`: concise current facts only.
- `environment-access.md`: current access and safe command boundary.
- `operational-experience.md`: cross-cutting lessons only.
- Task runbooks: maintained execution procedures.
- Files with dates in their names: historical implementation or release
  evidence, not current instructions unless a current runbook links them for a
  specific reason.
- Git history: superseded status and transition detail.

Former Azure deployment, compatibility, mirror and usage-merge documents are
historical recovery material. They are not part of routine Gateway operations.
