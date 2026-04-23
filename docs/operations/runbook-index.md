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

- User-friendly API key issue, list, update, rotate, and revoke.
- User listing plus user disable/enable.
- Request event inspection by API key or user.
- Dynamic usage reports by API key or user.
- Admin operation audit for issue/update/revoke/rotate/disable/enable/prune actions.
- Read-only `trial-check` for 1-2 user controlled internal trials.
- Dry-run-capable request event pruning.
- Shared VM loopback smoke validation.
- Container deployment skeleton.
- Default compose isolation for loopback-only gateway deployment.
- Public internal trial plan through existing Nginx and a dedicated hostname.
- Docker maintenance-window checklist for shared VM installation.
- MedCode Windows `shell` tool-call smoke checklist.
- Partner trial checklist for MedEvidence, OpenCode CLI, and OpenCode Desktop.

Operational workflows still pending:

- Fuller upstream Codex account administration.
- Admin operator identity capture.
- Scheduled retention automation.
- Materialized usage reports.
- Long-running production deployment activation.
- Public TLS routing execution through a maintenance window.

The local `codex-gateway-ops` skill stores workstation-specific VM access notes
outside this repository. Do not commit operator-local secrets.
