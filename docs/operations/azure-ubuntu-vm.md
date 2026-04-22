# Azure Ubuntu VM Deployment Notes

This project targets a single Azure Ubuntu VM for the MVP. The current shared
test VM also hosts important services, so deployment work must stay isolated
until a maintenance window is explicitly approved.

For the container runbook, see [container-deploy.md](./container-deploy.md).
For non-invasive shared-VM rules, see [safe-vm-testing.md](./safe-vm-testing.md).

## Current Deployment Position

- Preferred runtime: Docker Compose, one `gateway` container.
- Default VM exposure: `127.0.0.1:18787` on the VM only.
- Container listener: `0.0.0.0:8787` inside the container.
- Default compose file contains no `80/443` service.
- State: Docker named volume mounted at `/var/lib/codex-gateway`.
- SQLite path: `/var/lib/codex-gateway/gateway.db`.
- Codex auth home: `/var/lib/codex-gateway/codex-home`.
- Production auth: `GATEWAY_AUTH_MODE=credential`.
- Public `80/443`: not managed by this project by default.

## Shared VM Boundary

Do not change any of the following on the shared Azure VM without explicit
maintenance approval:

- Nginx, Caddy, Apache, or existing reverse proxy config.
- Azure NSG, UFW, iptables, or host firewall rules.
- Docker daemon installation or restart.
- Ports `80` and `443`.
- Existing application directories such as `/opt/medevidence-v2`.

All gateway tests on the shared VM must use user-owned paths and loopback-only
ports. The known safe test bind is `127.0.0.1:18787`.

## Baseline Read-Only Checks

These checks are safe because they only inspect state:

```bash
hostname
whoami
uname -a
df -h
free -h
ss -ltnp
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}\t{{.Status}}' || true
docker compose ls || true
systemctl --type=service --state=running --no-pager
```

If Docker is missing or inaccessible, record that fact and stop. Do not install
or repair Docker on the shared VM during normal development validation.

## Recommended MVP Topology

```text
operator laptop
  -> SSH tunnel, optional
  -> VM 127.0.0.1:18787
  -> gateway container :8787
  -> gateway_state volume
       gateway.db
       codex-home/
```

Only after the loopback deployment is stable should a separate reverse-proxy
maintenance plan be considered.

## VM Validation Status

The VM has already validated the native Node path, SQLite credential auth,
rate limiting, request event writing, usage reports, and manual event pruning.
Those validations did not modify host reverse proxy, firewall, Docker, or
public ports.
