# Runbook Index

Current status and access notes:

1. [System Status](./system-status.md)
2. [Environment Access](./environment-access.md)
3. [Operational Experience](./operational-experience.md)

Deployment and safety:

1. [Azure Ubuntu VM Deployment Notes](./azure-ubuntu-vm.md)
2. [Container Deployment Runbook](./container-deploy.md)
3. [Safe Shared-VM Testing](./safe-vm-testing.md)
4. [Docker Maintenance Window Runbook](./docker-maintenance-window.md)

Operational workflows now covered:

- User-friendly API key issue, list, rotate, and revoke.
- User listing plus user disable/enable.
- Request event inspection by API key or user.
- Dynamic usage reports by API key or user.
- Admin operation audit for issue/revoke/rotate/disable/enable/prune actions.
- Dry-run-capable request event pruning.
- Shared VM loopback smoke validation.
- Container deployment skeleton.
- Default compose isolation for loopback-only gateway deployment.
- Docker maintenance-window checklist for shared VM installation.

Operational workflows still pending:

- Fuller upstream Codex account administration.
- Admin operator identity capture.
- Scheduled retention automation.
- Materialized usage reports.
- Long-running production deployment activation.
- Public TLS routing through a maintenance window.

The local `codex-gateway-ops` skill stores workstation-specific VM access notes
outside this repository. Do not commit operator-local secrets.
