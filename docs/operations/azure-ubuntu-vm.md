# Azure Ubuntu VM Deployment Notes

This project targets a single Azure Ubuntu VM for the MVP. The current shared
test VM also hosts important services, so deployment work must stay isolated
until a maintenance window is explicitly approved.

For the container runbook, see [container-deploy.md](./container-deploy.md).
For the controlled internal trial plan, see
[internal-trial-runbook.md](./internal-trial-runbook.md).
For non-invasive shared-VM rules, see [safe-vm-testing.md](./safe-vm-testing.md).

## Current Deployment Position

- Preferred runtime: Docker Compose, one `gateway` container.
- Default VM exposure: `127.0.0.1:18787` on the VM only.
- Container listener: `0.0.0.0:8787` inside the container.
- Default compose file contains no `80/443` service.
- Current public internal-trial endpoint: `https://gw.instmarket.com.au`,
  through host Nginx to `127.0.0.1:18787`.
- Current compose project name: `codex_gateway_test`.
- Current gateway container name: `codex_gateway_test-gateway-1`.
- State: Docker named volume `codex_gateway_test_gateway_state`, mounted inside
  the container at `/var/lib/codex-gateway`.
- Host volume directory:
  `/var/lib/docker/volumes/codex_gateway_test_gateway_state/_data`.
- Main SQLite path inside the container:
  `/var/lib/codex-gateway/gateway.db`.
- Desktop client-events SQLite path inside the container:
  `/var/lib/codex-gateway/client-events.db`.
- Codex auth home inside the container:
  `/var/lib/codex-gateway/codex-home`.
- Production auth: `GATEWAY_AUTH_MODE=credential`.
- Public `80/443`: not managed by this project by default. A controlled
  internal public trial should add only a dedicated Nginx hostname that proxies
  to `127.0.0.1:18787`, and only during an approved maintenance window.

The VM host is not expected to have `/var/lib/codex-gateway`; that path is the
container mount point. Do not use `$HOME/codex-gateway-state/gateway.db` for
current production investigations; it is legacy native/smoke state and does not
represent traffic served through `gw.instmarket.com.au`.

The `codex_gateway_test` names are historical from the first controlled trial.
They currently identify the live compose project and volume, so do not rename
them during normal operations. A later maintenance task can migrate names to a
less confusing `codex_gateway` / `codex_gateway_prod` convention with explicit
backup and rollback.

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
maintenance plan be considered. For internal users who must access from the
public internet, keep Docker loopback-only and use existing host Nginx as the
single public edge.

## VM Validation Status

The VM has already validated the native Node path, SQLite credential auth,
rate limiting, request event writing, usage reports, and manual event pruning.
Those validations did not modify host reverse proxy, firewall, Docker, or
public ports.

The current public internal-trial deployment keeps existing Nginx on public
`80/443`, preserves the existing local upstream on `127.0.0.1:8081`, keeps
PostgreSQL on `127.0.0.1:5432`, and runs Codex Gateway only through the
loopback-published Docker container.
