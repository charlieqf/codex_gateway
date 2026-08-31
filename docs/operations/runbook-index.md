# Runbook Index

Last updated: 2026-08-31.

Choose one path for the task. Do not read every operations document.

## Fast Support

| Task | Start here |
| --- | --- |
| Named user's Desktop messages | [Desktop User Message Query](./client-message-query-support.zh-CN.md) |
| Generic MedCode unavailable/error | [MedCode Service Unavailable](./medcode-service-unavailable-runbook.md) |
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
| Real-user/Desktop key provisioning details | [MedEvidence Codex Key Provisioning](./medevidence-codex-key-provisioning.md) |
| Billing operator console | [Real User Issue Web Console](./real-user-issue-web-console.md) |
| Internal phone authentication | [Internal Phone Auth v1](./internal-phone-auth-v1.zh-CN.md) |

## Runtime Components

| Task | Runbook |
| --- | --- |
| GoldenCode Local context admission | [Local Context Admission Release](./goldencode-local-context-admission-release-2026-08-30.zh-CN.md) |
| External Codex configuration | [Codex GoldenCode External Access](./codex-goldencode-external-access.md) |
| CN1 loopback/dark edge | [CN1 GoldenCode Gateway](./cn1-goldencode-gateway.md) |
| R760 image egress | [R760 Mihomo Image Egress](./r760-mihomo-image-egress.md) |
| Runtime config classification | [Runtime Configuration Matrix](./runtime-configuration-change-matrix.md) |
| Container deployment | [Container Deployment](./container-deploy.md) |

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
