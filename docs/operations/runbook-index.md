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

Operational workflows now covered:

- User-friendly API key issue, list, active-key inventory, update, reveal, rotate, and revoke.
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
- MedEvidence v2 handoff JSON to Codex Gateway API key provisioning through `scripts/provision-medevidence-codex-key.ps1`, documented in `docs/operations/medevidence-codex-key-provisioning.md`.
- Current API key management and token usage recording guidance in `docs/implementation/medcode-api-key-management.md` and `docs/implementation/medcode-api-key-token-budget.md`.
- Server-side subscription rollout runbook in `docs/implementation/server-side-subscription-rollout-plan.md`; this explicitly excludes account creation pages, billing pages, and payment systems.

Operational workflows still pending:

- Fuller upstream Codex account administration.
- Admin operator identity capture.
- Scheduled retention automation.
- Materialized usage reports.
- Token budget enforcement beyond current token usage recording.
- Systemd ownership/monitoring for the long-running gateway container.

The local `codex-gateway-ops` skill stores workstation-specific VM access notes
outside this repository. Do not commit operator-local secrets.
