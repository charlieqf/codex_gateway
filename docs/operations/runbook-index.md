# Runbook Index

Current status and access notes:

1. [System Status](./system-status.md)
2. [Environment Access](./environment-access.md)
3. [Operational Experience](./operational-experience.md)

Deployment and safety:

1. [Azure Ubuntu VM Deployment Notes](./azure-ubuntu-vm.md)
2. [Container Deployment Runbook](./container-deploy.md)
3. [Safe Shared-VM Testing](./safe-vm-testing.md)

Operational workflows now covered:

- Access credential issue, list, rotate, and revoke.
- Request event inspection.
- Dynamic usage reports.
- Dry-run-capable request event pruning.
- Shared VM loopback smoke validation.
- Container deployment skeleton.
- Default compose isolation for loopback-only gateway deployment.

Operational workflows still pending:

- Full subject/subscription administration.
- Scheduled retention automation.
- Materialized usage reports.
- Long-running production deployment activation.
- Public TLS routing through a maintenance window.

The local `codex-gateway-ops` skill stores workstation-specific VM access notes
outside this repository. Do not commit operator-local secrets.
