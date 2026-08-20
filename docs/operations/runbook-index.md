# Runbook Index

Current status and access notes:

1. [System Status](./system-status.md)
2. [Environment Access](./environment-access.md)
3. [Operational Experience](./operational-experience.md)

Deployment and safety:

1. [Azure Ubuntu VM Deployment Notes](./azure-ubuntu-vm.md)
2. [Container Deployment Runbook](./container-deploy.md)
3. [Public Internal Controlled Trial Runbook](./internal-trial-runbook.md)
4. [Safe Shared-VM Testing](./safe-vm-testing.md)
5. [Docker Maintenance Window Runbook](./docker-maintenance-window.md)
6. [MedCode Windows Tool-Call Smoke](./medcode-windows-toolcall-smoke.md)
7. [MedCode Partner Trial Test Plan](./medcode-partner-trial-test-plan.md)
8. [Desktop User Message Query Support](./client-message-query-support.zh-CN.md)
9. [MedCode Service Unavailable Runbook](./medcode-service-unavailable-runbook.md)
10. [CN1 GoldenCode Gateway](./cn1-goldencode-gateway.md)
11. [R760 Mihomo Image Egress](./r760-mihomo-image-egress.md)
12. [Domestic Gateway and Doctor Research Migration Plan](../implementation/domestic-gateway-doctor-research-migration-plan-2026-07-30.zh-CN.md)
13. [GoldenCode Cutover Consumer and Tencent Capacity Audit](./goldencode-cutover-audit-2026-08-04.zh-CN.md)
14. [R760 Gateway Control-Plane Authority](./r760-control-plane-authority.md)
15. [R760 Internal Phone Auth v1](./internal-phone-auth-v1.zh-CN.md)

Operational workflows now covered:

- User-friendly API key issue, list, active-key inventory, update, reveal, rotate, and revoke.
- One-command `provision-user` workflow for trusted backends or operators to create/update a user, grant or renew a plan entitlement, and optionally issue an API key after external approval/payment.
- User listing plus user contact metadata update and user disable/enable.
- Request event inspection by API key or user.
- Dynamic usage reports by API key or user, including token usage fields.
- Admin operation audit for issue/update/reveal/revoke/rotate/disable/enable/prune actions.
- Read-only `trial-check` for controlled internal trials.
- Dry-run-capable request event pruning.
- Shared VM loopback smoke validation.
- Container deployment skeleton.
- Default compose isolation for loopback-only gateway deployment.
- Public internal trial plan through existing Nginx and a dedicated hostname.
- Docker maintenance-window checklist for shared VM installation.
- MedCode Windows `shell` tool-call smoke checklist.
- Partner trial checklist for MedEvidence, OpenCode CLI, and OpenCode Desktop.
- Public API key self-validation through `GET /gateway/credentials/current`, including client-facing guidance in `docs/client-api-key-validation-guide.md`.
- Real user and Desktop E2E opaque `cgu_live_*` key issuance through the Gateway-owned billing/v2 path, documented in `docs/operations/medevidence-codex-key-provisioning.md`.
- R760-authoritative key issuance, user/plan control writes, Azure compatibility
  mirroring, deduplicated usage merge and usage queries, documented in
  `docs/operations/r760-control-plane-authority.md`.
- Legacy Azure `cmev1` handoff recovery through
  `scripts/provision-medevidence-codex-key.ps1`; explicitly excluded from new
  user/R760 authority issuance in
  `docs/operations/medevidence-codex-key-provisioning.md`.
- Upstream Codex account reauthentication through `scripts/reauth-upstream-codex-account.sh`, documented in `docs/operations/environment-access.md`.
- Current API key management and token usage recording guidance in `docs/implementation/medcode-api-key-management.md` and `docs/implementation/medcode-api-key-token-budget.md`.
- Server-side subscription rollout runbook in `docs/implementation/server-side-subscription-rollout-plan.md`; this explicitly excludes account creation pages, billing pages, and payment systems.
- Registration/payment integration contract in `docs/implementation/registration-payment-integration-spec.md` for external signup, checkout, webhook, CRM, or billing teams that need to trigger gateway provisioning.
- Billing Admin token hot-issue/revoke plan in `docs/implementation/billing-admin-token-management-plan.md`, to remove the current need to recreate the gateway container when issuing billing integration test tokens.
- Desktop client message, diagnostic, and MedEvidence tool audit export ownership guidance plus read-only admin CLI examples in `docs/operations/client-message-query-support.zh-CN.md`.
- `MedCode service is temporarily unavailable` triage, including event/log
  classification and upstream Codex account reauthentication.
- CN1 domestic-only GoldenCode Gateway operation: loopback Docker service,
  current Tencent-only GLM-5.2 route, smoke/attribution checks, and the separately
  approved `gw:443 -> R760:1443` edge role.
- R760 private Mihomo image egress: secure CN1 snapshot transfer, no-host-port
  container operation, Gateway-only proxy scope, Tencent `NO_PROXY`, rollback,
  and the remaining Gemini supported-region gate.
- R760 domestic migration: one public `goldencode` text model, retained
  low-cost image generation, four-container Doctor Research, CN1 edge cutover,
  state synchronization, validation and temporary Azure rollback.
- GoldenCode cutover audit: active legacy-model consumers, 30-day Tencent
  public/Research usage, observed concurrency and the remaining account-capacity
  evidence required before cutover.

Operational workflows still pending:

- Fuller upstream Codex account administration beyond reauthentication.
- Admin operator identity capture.
- Scheduled retention automation.
- Materialized usage reports.
- Token budget enforcement beyond current token usage recording.
- Systemd ownership/monitoring for the long-running gateway container.

The local `codex-gateway-ops` skill stores workstation-specific VM access notes
outside this repository. Do not commit operator-local secrets.
