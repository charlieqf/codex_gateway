# Codex Gateway Watchdog Runbook

## Current scope

The watchdog is an Azure-host, read-only, no-notification baseline collector.
It does not install Gatus and it does not send email or SMS. The host script
refuses to run unless both `--dry-run` and `--no-notify` are present.

Implemented checks:

- loopback Gateway health;
- host memory, memory PSI, root-disk capacity/growth, inode use, load, and vCPU count;
- container health, restart count, OOM state, cgroup memory/PID use, and Codex child count;
- aggregate request temporary-state size and age inside container `/tmp`;
- persistent Codex SQLite/WAL size and rollout-quarantine size;
- read-only `ops-snapshot` request/error/account/runtime aggregation;
- stable incident keys, consecutive-sample thresholds, new/escalated/ongoing/resolved state;
- degraded host-only reporting when the container or evaluator cannot be executed.

The watchdog never reads prompt/response bodies, `auth.json`, container
environment values, API keys, SMTP credentials, SMS tokens, email addresses,
or phone numbers. It does not restart services, kill processes, delete state,
checkpoint SQLite, or clean disk.

## Repository files

- `scripts/ops/gateway-host-watchdog.sh`: root-owned host collector.
- `scripts/ops/gateway-request-watchdog.mjs`: standalone evaluator copied into the Gateway image.
- `deploy/systemd/codex-gateway-watchdog.service`: hardened no-notify oneshot.
- `deploy/systemd/codex-gateway-watchdog.timer`: one-minute timer.
- `tests/fixtures/watchdog/*.json`: sanitized local fault fixtures.
- `tests/gateway-request-watchdog.test.mjs`: severity, deduplication, recovery, sustained-threshold, and growth tests.

## Before installation

1. Deploy a Gateway image containing
   `/app/scripts/ops/gateway-request-watchdog.mjs`.
2. Confirm the live container is healthy and still publishes only
   `127.0.0.1:18787->8787`.
3. Confirm `ops-snapshot` succeeds inside the container and its SQLite access
   remains `readOnly: true`, with a 1-second busy timeout and
   `PRAGMA query_only = ON`.
4. Validate the host script without persisting a timer:

```bash
sudo install -d -m 0755 /usr/local/lib/codex-gateway-watchdog
sudo install -m 0755 scripts/ops/gateway-host-watchdog.sh \
  /usr/local/lib/codex-gateway-watchdog/gateway-host-watchdog.sh
sudo /usr/local/lib/codex-gateway-watchdog/gateway-host-watchdog.sh \
  --dry-run --no-notify
```

Expected output is one sanitized line such as:

```text
watchdog_status=ok findings=0 new=none escalated=none resolved=none notify=false
```

The state file is root-only at
`/var/lib/codex-gateway-watchdog/state.json`. It contains aggregate metrics and
incident state only.

## Install the no-notify timer

Run from the exact clean release containing the deployed image code:

```bash
sudo install -d -m 0755 /usr/local/lib/codex-gateway-watchdog
sudo install -m 0755 scripts/ops/gateway-host-watchdog.sh \
  /usr/local/lib/codex-gateway-watchdog/gateway-host-watchdog.sh
sudo install -m 0644 deploy/systemd/codex-gateway-watchdog.service \
  /etc/systemd/system/codex-gateway-watchdog.service
sudo install -m 0644 deploy/systemd/codex-gateway-watchdog.timer \
  /etc/systemd/system/codex-gateway-watchdog.timer
sudo systemd-analyze verify \
  /etc/systemd/system/codex-gateway-watchdog.service \
  /etc/systemd/system/codex-gateway-watchdog.timer
sudo systemctl daemon-reload
sudo systemctl enable --now codex-gateway-watchdog.timer
```

This does not alter Nginx, Docker configuration, firewall rules, ports, or any
MedEvidence unit.

## Verification

```bash
sudo systemctl start codex-gateway-watchdog.service
sudo systemctl status codex-gateway-watchdog.service --no-pager
sudo systemctl status codex-gateway-watchdog.timer --no-pager
sudo systemctl list-timers codex-gateway-watchdog.timer --no-pager
sudo journalctl -u codex-gateway-watchdog.service --since '15 minutes ago' \
  --no-pager
sudo stat -c '%a %U:%G %s %n' \
  /var/lib/codex-gateway-watchdog/state.json
```

Acceptance conditions:

- each run completes within the timer interval;
- overlapping execution returns `watchdog_status=skipped` because of `flock`;
- state mode is `0600` under a `0700` directory;
- no new listener or long-running watchdog process exists;
- Gateway and all existing shared-VM services remain healthy;
- journal output contains no secret, user text, email address, or phone number.

Keep the timer in no-notify mode for at least 24 hours before reviewing
thresholds. Do not enable email or SMS by editing the unit: notification code
and provider configuration are a separate reviewed phase.

## Fixture validation

Fixtures run locally and must not be copied into production state:

```powershell
npx vitest run tests/gateway-request-watchdog.test.mjs
node scripts/ops/gateway-request-watchdog.mjs `
  --input tests/fixtures/watchdog/healthy.json
```

The emergency fixture uses synthetic numbers only. Never fill production disk,
create a real OOM, stop Nginx/Docker, or kill an unowned Codex process to test
an alert.

## Degraded behavior

If container inspection is unavailable, the shell collector still checks host
memory and disk. It writes a sanitized `last-degraded.json`, preserves the last
valid evaluator state, and reports at least Warning. Host emergency/critical
memory and disk thresholds still escalate the degraded result.

If only `/tmp` or `ops-snapshot` collection is unavailable, the evaluator
requires two consecutive failed samples before activating the corresponding
Warning. Missing data is never reported as zero or healthy.

## Rollback

```bash
sudo systemctl disable --now codex-gateway-watchdog.timer
sudo systemctl stop codex-gateway-watchdog.service
sudo systemctl reset-failed codex-gateway-watchdog.service
```

Confirm no watchdog process remains. Preserve the root-only state directory for
incident review unless an approved retention action explicitly removes it.

## Remaining work

- 24-hour no-notify baseline review;
- Gatus deployment on the independent Aliyun VM;
- email and SMS provider selection, secret delivery, templates, deduplication routing, and real delivery tests;
- dedicated low-quota canary credential and L2/L3/L4 synthetic model checks;
- probe-user exclusion from normal user-impact and quota dashboards.
