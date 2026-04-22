# Docker Maintenance Window Runbook

This runbook is for the shared Azure Ubuntu VM where Docker is currently absent
and other important services are running. It must be executed only during an
explicit maintenance window.

Official Docker reference: <https://docs.docker.com/engine/install/ubuntu/>

## Current Read-Only Baseline

Last observed on 2026-04-22:

- Hostname: `medevidence-1`.
- OS: Ubuntu 24.04 Azure kernel.
- Docker CLI: absent.
- Listening ports:
  - `0.0.0.0:80` and `[::]:80` owned by existing Nginx.
  - `0.0.0.0:22` and `[::]:22` for SSH.
  - `127.0.0.1:5432` for PostgreSQL.
  - `127.0.0.1:8081` for an existing local service.
  - `127.0.0.1:18787` not listening.
- Running critical services include:
  - `nginx.service`
  - `medevidence-v2.service`
  - `medevidence-v2-worker.service`
  - `postgresql@16-main.service`

## Explicit Approval Required

Before starting, record approval for:

1. Maintenance window start and end time.
2. Permission to install Docker Engine and the Docker Compose plugin.
3. Permission to start Docker daemon and containerd.
4. Permission to run only the `codex_gateway_test` compose project.
5. Confirmation that `80/443`, Nginx, firewall, systemd services, and existing
   application directories are not to be modified.

If any item is not approved, stop before making changes.

## Hard Stop Conditions

Abort or roll back if any of these happen:

- `apt` proposes removing Nginx, PostgreSQL, MedEvidence, SSH, or core system
  packages.
- Docker installation or startup breaks Nginx on port `80`.
- Docker installation changes SSH reachability.
- `docker compose config` shows host `80` or `443` bindings in the default
  gateway deployment.
- Gateway cannot be kept on `127.0.0.1:18787`.
- CPU, memory, or disk usage spikes in a way that threatens existing services.

## Pre-Window Snapshot

Run and save output in the operator notes, not in Git:

```bash
date -Is
hostname
whoami
uptime
df -h
free -h
ss -ltnp
systemctl is-active nginx medevidence-v2 medevidence-v2-worker postgresql@16-main ssh
systemctl status nginx --no-pager
systemctl status medevidence-v2 --no-pager
systemctl status medevidence-v2-worker --no-pager
systemctl status postgresql@16-main --no-pager
curl -fsS http://127.0.0.1/ >/tmp/codex-gateway-pre-nginx.html || echo nginx-local-check-failed
```

If `curl http://127.0.0.1/` is not a valid health check for the existing Nginx
site, replace it with the service owner's approved health URL before the window.

## Pre-Install Safety Checks

```bash
command -v docker || true
apt-cache policy docker-ce docker-ce-cli containerd.io docker-compose-plugin || true
sudo apt-get update
sudo apt-get -s install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

Review the simulated install output. Stop if it removes or upgrades unrelated
critical services unexpectedly.

## Install Docker

Use Docker's official apt repository for Ubuntu:

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu \
  $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}") stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

Do not add the `qian` user to the `docker` group during the first window.
The `docker` group is effectively root-equivalent. Use `sudo docker ...` for the
initial validation.

## Post-Install Host Checks

```bash
sudo docker --version
sudo docker compose version
systemctl is-active docker containerd
systemctl is-active nginx medevidence-v2 medevidence-v2-worker postgresql@16-main ssh
ss -ltnp
curl -fsS http://127.0.0.1/ >/tmp/codex-gateway-post-nginx.html || echo nginx-local-check-failed
```

Expected:

- Nginx still owns `80`.
- SSH still owns `22`.
- No listener on `18787` yet.
- Existing critical services remain active.

## Gateway Compose Config Check

```bash
cd /home/qian/codex-gateway-test
git fetch origin main
git merge --ff-only origin/main
cp -n config/gateway.container.example.env config/gateway.container.env
chmod 600 config/gateway.container.env
sudo docker compose -p codex_gateway_test -f compose.azure.yml config
```

Before starting, verify the rendered config publishes only:

```text
127.0.0.1:18787:8787
```

If the rendered config includes host `80` or `443`, stop.

## Gateway Container Smoke

```bash
sudo docker compose -p codex_gateway_test -f compose.azure.yml build gateway
sudo docker compose -p codex_gateway_test -f compose.azure.yml up -d gateway
sudo docker compose -p codex_gateway_test -f compose.azure.yml ps
curl -fsS http://127.0.0.1:18787/gateway/health
```

Expected health fields:

```json
{
  "auth_mode": "credential",
  "store": {
    "session": "sqlite",
    "observation": "enabled"
  }
}
```

This smoke does not validate real Codex streaming. It validates container
startup, production config, SQLite store, health, and loopback-only exposure.

## Stop After Smoke

Unless long-running test operation is explicitly approved, stop the container:

```bash
sudo docker compose -p codex_gateway_test -f compose.azure.yml stop gateway
ss -ltnp | grep ':18787' || true
sudo docker compose -p codex_gateway_test -f compose.azure.yml ps
```

Do not run `docker compose down` and do not delete volumes unless a separate
cleanup decision is made.

## Rollback

If the gateway container itself causes problems:

```bash
cd /home/qian/codex-gateway-test
sudo docker compose -p codex_gateway_test -f compose.azure.yml stop gateway
ss -ltnp | grep ':18787' || true
systemctl is-active nginx medevidence-v2 medevidence-v2-worker postgresql@16-main ssh
```

If Docker installation itself causes host networking or service issues, and
Docker was installed only for this window:

```bash
sudo systemctl stop docker containerd || true
sudo apt-get purge -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo rm -f /etc/apt/sources.list.d/docker.list /etc/apt/keyrings/docker.asc
sudo apt-get update
systemctl is-active nginx medevidence-v2 medevidence-v2-worker postgresql@16-main ssh
ss -ltnp
```

Do not delete `/var/lib/docker` during emergency rollback unless disk pressure
requires it and the operator confirms no useful test state must be retained.

## Success Criteria

- Existing services remain active.
- Nginx still owns port `80`.
- No process binds host `443`.
- Gateway binds only `127.0.0.1:18787` during smoke.
- Health returns `auth_mode: credential`.
- Stopping the gateway removes the `18787` listener.
- No public routing is changed.
