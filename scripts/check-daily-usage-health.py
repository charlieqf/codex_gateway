#!/usr/bin/env python3
"""
Report one local calendar day's live Gateway usage and server health.

The production SQLite database stays inside the Gateway container. This script
uses SSH key authentication and read-only admin/SQLite queries; it never reads
or prints API key values, container environment variables, or user prompts.
"""

from __future__ import annotations

import argparse
import base64
import concurrent.futures
import json
import re
import socket
import ssl
import subprocess
import sys
import time
from collections import defaultdict
from datetime import date, datetime, time as datetime_time, timezone
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from codex_gateway_ops_common import DEFAULT_REMOTE_REPO, redact_secrets


DEFAULT_GATEWAY_BASE_URL = "https://gw.instmarket.com.au"
DEFAULT_TIMEZONE = "Australia/Sydney"
DEFAULT_VM_HOST = "4.242.58.89"
DEFAULT_VM_USER = "qian"
DEFAULT_SSH_KEY = r"~\.ssh\medevidence_azure_wus2_ed25519"
DEFAULT_COMPOSE_PROJECT = "codex_gateway_test"
DEFAULT_COMPOSE_FILE = "compose.azure.yml"
DEFAULT_GATEWAY_SERVICE = "gateway"
DEFAULT_GATEWAY_DB = "/var/lib/codex-gateway/gateway.db"
DEFAULT_RUNTIME_SNAPSHOT = "/var/lib/codex-gateway/ops-runtime.json"
DEFAULT_LOOPBACK_HEALTH_URL = "http://127.0.0.1:18787/gateway/health"

INFRASTRUCTURE_ERROR_CODES = {
    "upstream_timeout",
    "upstream_unavailable",
    "service_unavailable",
    "provider_reauth_required",
    "subscription_unavailable",
}

REMOTE_COLLECTOR = r"""
import json
import os
import platform
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone
from urllib.error import HTTPError
from urllib.request import urlopen

config = json.loads(__import__("base64").urlsafe_b64decode(sys.argv[1]).decode("utf-8"))
errors = []


def run(command, *, cwd=None, timeout=30, allow_failure=False):
    completed = subprocess.run(
        command,
        cwd=cwd,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
    )
    if completed.returncode != 0 and not allow_failure:
        stderr = completed.stderr.strip().replace("\n", " ")[:500]
        raise RuntimeError("command failed (exit={}): {}".format(completed.returncode, stderr))
    return completed


def json_command(command, name, *, cwd=None, timeout=30):
    try:
        completed = run(command, cwd=cwd, timeout=timeout)
        return json.loads(completed.stdout)
    except Exception as exc:
        errors.append({"component": name, "error": str(exc)})
        return None


def read_meminfo():
    values = {}
    with open("/proc/meminfo", "r", encoding="utf-8") as handle:
        for line in handle:
            key, raw = line.split(":", 1)
            fields = raw.strip().split()
            if fields:
                values[key] = int(fields[0]) * 1024
    return {
        "total_bytes": values.get("MemTotal", 0),
        "available_bytes": values.get("MemAvailable", 0),
        "swap_total_bytes": values.get("SwapTotal", 0),
        "swap_free_bytes": values.get("SwapFree", 0),
    }


def service_states(names):
    states = {}
    for name in names:
        completed = run(["systemctl", "is-active", name], allow_failure=True, timeout=8)
        states[name] = completed.stdout.strip() or "unknown"
    return states


def loopback_health(url):
    started = time.monotonic()
    try:
        with urlopen(url, timeout=10) as response:
            raw = response.read(65536).decode("utf-8", errors="replace")
            return {
                "ok": response.status == 200,
                "status_code": response.status,
                "latency_ms": round((time.monotonic() - started) * 1000, 1),
                "body": json.loads(raw) if raw else None,
            }
    except HTTPError as exc:
        return {
            "ok": False,
            "status_code": exc.code,
            "latency_ms": round((time.monotonic() - started) * 1000, 1),
            "error": str(exc),
        }
    except Exception as exc:
        return {
            "ok": False,
            "status_code": None,
            "latency_ms": round((time.monotonic() - started) * 1000, 1),
            "error": str(exc),
        }


repo = config["remote_repo"]
compose = [
    "sudo", "-n", "docker", "compose",
    "-p", config["compose_project"],
    "-f", config["compose_file"],
]
admin = [
    *compose, "exec", "-T", config["gateway_service"],
    "node", "apps/admin-cli/dist/index.js", "--db", config["gateway_db"],
]

disk = shutil.disk_usage("/")
with open("/proc/uptime", "r", encoding="utf-8") as handle:
    uptime_seconds = float(handle.read().split()[0])

host = {
    "checked_at": datetime.now(timezone.utc).isoformat(),
    "hostname": platform.node(),
    "uptime_seconds": uptime_seconds,
    "load_average": list(os.getloadavg()),
    "disk_root": {"total_bytes": disk.total, "used_bytes": disk.used, "free_bytes": disk.free},
    "memory": read_meminfo(),
    "services": service_states(config["services"]),
}

listeners = run(["ss", "-ltnH"], allow_failure=True, timeout=8)
host["relevant_listeners"] = [
    line.strip() for line in listeners.stdout.splitlines()
    if any((":" + port) in line for port in ("80", "443", "18787", "8081", "5432"))
]

container = None
try:
    container_id = run([*compose, "ps", "-q", config["gateway_service"]], cwd=repo).stdout.strip()
    if not container_id:
        raise RuntimeError("Gateway container was not found")
    state = json.loads(run([
        "sudo", "-n", "docker", "inspect", "--format", "{{json .State}}", container_id
    ]).stdout)
    ports = json.loads(run([
        "sudo", "-n", "docker", "inspect", "--format", "{{json .NetworkSettings.Ports}}", container_id
    ]).stdout)
    name = run([
        "sudo", "-n", "docker", "inspect", "--format", "{{.Name}}", container_id
    ]).stdout.strip().lstrip("/")
    restart_count_text = run([
        "sudo", "-n", "docker", "inspect", "--format", "{{.RestartCount}}", container_id
    ]).stdout.strip()
    container = {
        "id": container_id[:12],
        "name": name,
        "status": state.get("Status"),
        "running": bool(state.get("Running")),
        "restarting": bool(state.get("Restarting")),
        "oom_killed": bool(state.get("OOMKilled")),
        "started_at": state.get("StartedAt"),
        "restart_count": int(restart_count_text) if restart_count_text.isdigit() else None,
        "health": (state.get("Health") or {}).get("Status"),
        "ports": ports or {},
    }
    stats_text = run(
        ["sudo", "-n", "docker", "stats", "--no-stream", "--format", "{{json .}}", container_id],
        timeout=15,
    ).stdout.strip()
    container["stats"] = json.loads(stats_text) if stats_text else None
except Exception as exc:
    errors.append({"component": "container", "error": str(exc)})

usage = json_command(
    [*admin, "report-usage", "--since", config["since_utc"], "--until", config["until_utc"]],
    "report-usage",
    cwd=repo,
    timeout=config["timeout_seconds"],
)
ops_snapshot = json_command(
    [*admin, "ops-snapshot", "--runtime-snapshot", config["runtime_snapshot"]],
    "ops-snapshot",
    cwd=repo,
    timeout=config["timeout_seconds"],
)

support_query = r'''
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.REPORT_DB, { readOnly: true, timeout: 1000 });
db.exec("PRAGMA query_only = ON");
const users = db.prepare(`
  SELECT id, label, name, state
  FROM subjects
  ORDER BY id
`).all();
const errorRows = db.prepare(`
  SELECT CASE WHEN subject_id IS NULL OR subject_id = '' THEN 'unattributed' ELSE 'authenticated' END AS audience,
         COALESCE(error_code, 'unknown') AS error_code,
         COALESCE(limit_kind, '') AS limit_kind,
         COUNT(*) AS count
  FROM request_events
  WHERE started_at >= ? AND started_at < ? AND status != 'ok'
  GROUP BY audience, COALESCE(error_code, 'unknown'), COALESCE(limit_kind, '')
  ORDER BY count DESC, audience, error_code
`).all(process.env.REPORT_SINCE, process.env.REPORT_UNTIL);
process.stdout.write(JSON.stringify({ users, error_breakdown: { rows: errorRows } }));
db.close();
'''

support_data = json_command(
    [
        *compose, "exec", "-T",
        "-e", "REPORT_DB=" + config["gateway_db"],
        "-e", "REPORT_SINCE=" + config["since_utc"],
        "-e", "REPORT_UNTIL=" + config["until_utc"],
        config["gateway_service"], "node", "-e", support_query,
    ],
    "daily-support-data",
    cwd=repo,
    timeout=config["timeout_seconds"],
)

result = {
    "host": host,
    "container": container,
    "loopback_health": loopback_health(config["loopback_health_url"]),
    "usage": usage,
    "users": {"users": support_data.get("users", [])} if isinstance(support_data, dict) else None,
    "ops_snapshot": ops_snapshot,
    "error_breakdown": support_data.get("error_breakdown") if isinstance(support_data, dict) else None,
    "collector_errors": errors,
}
print(json.dumps(result, ensure_ascii=False))
"""


class ReportError(RuntimeError):
    pass


def main() -> int:
    configure_stdio()
    args = parse_args()
    try:
        report = collect_report(args)
        if args.format == "json":
            print(json.dumps(report, ensure_ascii=False, indent=2))
        else:
            print(format_text_report(report, include_user_ids=args.include_user_ids))
        if args.fail_on_unhealthy and report["health"]["status"] != "healthy":
            return 2
        return 0
    except Exception as exc:
        print(redact_secrets(f"error: {exc}"), file=sys.stderr)
        return 1


def configure_stdio() -> None:
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if callable(reconfigure):
            reconfigure(encoding="utf-8", errors="replace")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Query today's live Gateway user usage and server health (read-only)."
    )
    parser.add_argument(
        "--date",
        help="Local calendar date in YYYY-MM-DD. Defaults to today; past dates use the full day.",
    )
    parser.add_argument("--timezone", default=DEFAULT_TIMEZONE, help="IANA reporting timezone.")
    parser.add_argument("--format", choices=["text", "json"], default="text")
    parser.add_argument("--include-user-ids", action="store_true")
    parser.add_argument("--fail-on-unhealthy", action="store_true")
    parser.add_argument("--disk-warning-percent", type=percent, default=85.0)
    parser.add_argument("--tls-warning-days", type=non_negative_int, default=14)
    parser.add_argument("--gateway-base-url", default=DEFAULT_GATEWAY_BASE_URL)
    parser.add_argument("--vm-host", default=DEFAULT_VM_HOST)
    parser.add_argument("--vm-user", default=DEFAULT_VM_USER)
    parser.add_argument("--ssh-key", default=DEFAULT_SSH_KEY)
    parser.add_argument("--remote-repo", default=DEFAULT_REMOTE_REPO)
    parser.add_argument("--compose-project", default=DEFAULT_COMPOSE_PROJECT)
    parser.add_argument("--compose-file", default=DEFAULT_COMPOSE_FILE)
    parser.add_argument("--gateway-service", default=DEFAULT_GATEWAY_SERVICE)
    parser.add_argument("--gateway-db", default=DEFAULT_GATEWAY_DB)
    parser.add_argument("--runtime-snapshot", default=DEFAULT_RUNTIME_SNAPSHOT)
    parser.add_argument("--loopback-health-url", default=DEFAULT_LOOPBACK_HEALTH_URL)
    parser.add_argument("--timeout-seconds", type=positive_int, default=45)
    return parser.parse_args()


def positive_int(value: str) -> int:
    parsed = int(value)
    if parsed < 1:
        raise argparse.ArgumentTypeError("value must be positive")
    return parsed


def non_negative_int(value: str) -> int:
    parsed = int(value)
    if parsed < 0:
        raise argparse.ArgumentTypeError("value must be non-negative")
    return parsed


def percent(value: str) -> float:
    parsed = float(value)
    if not 0 < parsed <= 100:
        raise argparse.ArgumentTypeError("value must be greater than 0 and at most 100")
    return parsed


def collect_report(args: argparse.Namespace) -> dict[str, Any]:
    reporting_tz = load_timezone(args.timezone)
    now_utc = datetime.now(timezone.utc)
    start_utc, until_utc, local_day = reporting_window(args.date, reporting_tz, now_utc)

    remote_config = {
        "remote_repo": args.remote_repo,
        "compose_project": args.compose_project,
        "compose_file": args.compose_file,
        "gateway_service": args.gateway_service,
        "gateway_db": args.gateway_db,
        "runtime_snapshot": args.runtime_snapshot,
        "loopback_health_url": args.loopback_health_url,
        "since_utc": iso_z(start_utc),
        "until_utc": iso_z(until_utc),
        "timeout_seconds": args.timeout_seconds,
        "services": ["nginx", "docker", "postgresql", "medevidence-v2", "medevidence-v2-worker"],
    }

    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
        public_future = executor.submit(query_public_health, args.gateway_base_url, args.timeout_seconds)
        remote_future = executor.submit(query_remote, args, remote_config)
        public = public_future.result()
        remote = remote_future.result()

    usage = summarize_usage(
        remote.get("usage"),
        remote.get("users"),
        remote.get("error_breakdown"),
    )
    report: dict[str, Any] = {
        "schema_version": 1,
        "generated_at": iso_z(datetime.now(timezone.utc)),
        "reporting_timezone": args.timezone,
        "local_date": local_day.isoformat(),
        "window": {
            "since_utc": iso_z(start_utc),
            "until_utc": iso_z(until_utc),
            "since_local": start_utc.astimezone(reporting_tz).isoformat(),
            "until_local": until_utc.astimezone(reporting_tz).isoformat(),
        },
        "usage": usage,
        "server": {
            "public_health": public["health"],
            "tls": public["tls"],
            "host": remote.get("host"),
            "container": remote.get("container"),
            "loopback_health": remote.get("loopback_health"),
            "ops_snapshot": remote.get("ops_snapshot"),
            "collector_errors": sanitize_collector_errors(remote.get("collector_errors")),
        },
    }
    report["health"] = assess_health(
        report,
        disk_warning_percent=args.disk_warning_percent,
        tls_warning_days=args.tls_warning_days,
        loopback_health_url=args.loopback_health_url,
    )
    return report


def load_timezone(name: str) -> ZoneInfo:
    try:
        return ZoneInfo(name)
    except ZoneInfoNotFoundError as exc:
        raise ReportError(
            f"timezone data for {name!r} is unavailable; install the Python 'tzdata' package"
        ) from exc


def reporting_window(
    requested: str | None,
    reporting_tz: ZoneInfo,
    now_utc: datetime,
) -> tuple[datetime, datetime, date]:
    now_local = now_utc.astimezone(reporting_tz)
    if requested:
        try:
            local_day = date.fromisoformat(requested)
        except ValueError as exc:
            raise ReportError("--date must use YYYY-MM-DD") from exc
    else:
        local_day = now_local.date()
    if local_day > now_local.date():
        raise ReportError("--date cannot be in the future")
    start_local = datetime.combine(local_day, datetime_time.min, tzinfo=reporting_tz)
    if local_day == now_local.date():
        until_local = now_local
    else:
        until_local = datetime.combine(date.fromordinal(local_day.toordinal() + 1), datetime_time.min, tzinfo=reporting_tz)
    return start_local.astimezone(timezone.utc), until_local.astimezone(timezone.utc), local_day


def query_public_health(base_url: str, timeout_seconds: int) -> dict[str, Any]:
    health_url = base_url.rstrip("/") + "/gateway/health"
    started = time.monotonic()
    health: dict[str, Any]
    try:
        request = Request(health_url, headers={"User-Agent": "codex-gateway-daily-health/1"})
        with urlopen(request, timeout=min(timeout_seconds, 20)) as response:
            body = response.read(65536).decode("utf-8", errors="replace")
            health = {
                "ok": response.status == 200,
                "status_code": response.status,
                "latency_ms": round((time.monotonic() - started) * 1000, 1),
                "body": json.loads(body) if body else None,
                "server": response.headers.get("Server"),
            }
    except HTTPError as exc:
        health = {
            "ok": False,
            "status_code": exc.code,
            "latency_ms": round((time.monotonic() - started) * 1000, 1),
            "error": str(exc),
        }
    except (URLError, OSError, ValueError, json.JSONDecodeError) as exc:
        health = {
            "ok": False,
            "status_code": None,
            "latency_ms": round((time.monotonic() - started) * 1000, 1),
            "error": str(exc),
        }
    return {"health": health, "tls": query_tls(base_url, timeout_seconds)}


def query_tls(base_url: str, timeout_seconds: int) -> dict[str, Any]:
    parsed = urlparse(base_url)
    if parsed.scheme != "https" or not parsed.hostname:
        return {"ok": False, "error": "gateway base URL is not HTTPS"}
    port = parsed.port or 443
    try:
        context = ssl.create_default_context()
        with socket.create_connection((parsed.hostname, port), timeout=min(timeout_seconds, 15)) as raw:
            with context.wrap_socket(raw, server_hostname=parsed.hostname) as wrapped:
                certificate = wrapped.getpeercert()
        expires_raw = certificate.get("notAfter")
        if not expires_raw:
            raise ReportError("TLS certificate did not include notAfter")
        expires_at = datetime.strptime(expires_raw, "%b %d %H:%M:%S %Y %Z").replace(tzinfo=timezone.utc)
        days_remaining = (expires_at - datetime.now(timezone.utc)).total_seconds() / 86400
        return {
            "ok": days_remaining > 0,
            "subject": certificate_name(certificate.get("subject")),
            "issuer": certificate_name(certificate.get("issuer")),
            "expires_at": iso_z(expires_at),
            "days_remaining": round(days_remaining, 1),
        }
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


def certificate_name(value: Any) -> str | None:
    if not isinstance(value, tuple):
        return None
    fields: dict[str, str] = {}
    for group in value:
        for item in group:
            if isinstance(item, tuple) and len(item) == 2:
                fields[str(item[0])] = str(item[1])
    return fields.get("commonName") or fields.get("organizationName")


def query_remote(args: argparse.Namespace, config: dict[str, Any]) -> dict[str, Any]:
    ssh_key = expanded_ssh_key(args.ssh_key)
    if not ssh_key.exists():
        raise ReportError(f"SSH key was not found: {ssh_key}")
    payload = base64.urlsafe_b64encode(json.dumps(config).encode("utf-8")).decode("ascii")
    command = [
        "ssh",
        "-i",
        str(ssh_key),
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=8",
        "-o",
        "StrictHostKeyChecking=accept-new",
        "-o",
        "IdentitiesOnly=yes",
        f"{args.vm_user}@{args.vm_host}",
        f"python3 - {payload}",
    ]
    completed = subprocess.run(
        command,
        input=REMOTE_COLLECTOR,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=max(args.timeout_seconds * 4, 60),
    )
    if completed.returncode != 0:
        raise ReportError(
            redact_secrets(
                f"remote collector failed: exit={completed.returncode} "
                f"stderr={completed.stderr.strip()[:1200]}"
            )
        )
    try:
        value = json.loads(completed.stdout)
    except json.JSONDecodeError as exc:
        raise ReportError(
            redact_secrets(f"remote collector returned invalid JSON: {completed.stdout[:800]}")
        ) from exc
    if not isinstance(value, dict):
        raise ReportError("remote collector returned an unexpected JSON shape")
    return value


def summarize_usage(
    usage_result: Any,
    users_result: Any,
    errors_result: Any,
) -> dict[str, Any]:
    rows = usage_result.get("rows", []) if isinstance(usage_result, dict) else []
    users = users_result.get("users", []) if isinstance(users_result, dict) else []
    user_map = {
        str(user.get("id")): user
        for user in users
        if isinstance(user, dict) and user.get("id")
    }

    authenticated = empty_totals()
    unattributed = empty_totals()
    per_user: dict[str, dict[str, Any]] = {}
    model_totals: defaultdict[str, int] = defaultdict(int)
    account_totals: defaultdict[str, int] = defaultdict(int)

    for raw in rows:
        if not isinstance(raw, dict):
            continue
        subject_id = str(raw.get("subject_id") or "")
        destination = authenticated if subject_id else unattributed
        add_usage(destination, raw)
        model = str(raw.get("public_model_id") or "unknown")
        account = str(raw.get("upstream_account_id") or "unassigned")
        if subject_id:
            model_totals[model] += int(raw.get("requests") or 0)
            account_totals[account] += int(raw.get("requests") or 0)
            if subject_id not in per_user:
                metadata = user_map.get(subject_id, {})
                per_user[subject_id] = {
                    "subject_id": subject_id,
                    "name": metadata.get("name") or metadata.get("label") or subject_id,
                    "state": metadata.get("state"),
                    **empty_totals(),
                    "models": defaultdict(int),
                    "upstream_accounts": defaultdict(int),
                }
            current = per_user[subject_id]
            add_usage(current, raw)
            current["models"][model] += int(raw.get("requests") or 0)
            current["upstream_accounts"][account] += int(raw.get("requests") or 0)

    user_rows = []
    for value in per_user.values():
        value["models"] = ordered_counts(value["models"])
        value["upstream_accounts"] = ordered_counts(value["upstream_accounts"])
        value["success_rate_percent"] = success_rate(value)
        user_rows.append(value)
    user_rows.sort(key=lambda item: (-item["requests"], str(item["name"])))

    error_rows = errors_result.get("rows", []) if isinstance(errors_result, dict) else []
    error_breakdown: dict[str, defaultdict[str, int]] = {
        "authenticated": defaultdict(int),
        "unattributed": defaultdict(int),
    }
    rate_limit_breakdown: defaultdict[str, int] = defaultdict(int)
    for raw in error_rows:
        if not isinstance(raw, dict):
            continue
        audience = str(raw.get("audience") or "unattributed")
        error_code = str(raw.get("error_code") or "unknown")
        count = int(raw.get("count") or 0)
        error_breakdown.setdefault(audience, defaultdict(int))[error_code] += count
        limit_kind = str(raw.get("limit_kind") or "")
        if error_code == "rate_limited":
            rate_limit_breakdown[limit_kind or "upstream_or_unknown"] += count

    authenticated["distinct_users"] = len(user_rows)
    authenticated["success_rate_percent"] = success_rate(authenticated)
    unattributed["success_rate_percent"] = success_rate(unattributed)
    all_totals = empty_totals()
    for key in all_totals:
        all_totals[key] = authenticated[key] + unattributed[key]
    all_totals["success_rate_percent"] = success_rate(all_totals)

    return {
        "authenticated": authenticated,
        "unattributed": unattributed,
        "all_events": all_totals,
        "by_model_authenticated": ordered_counts(model_totals),
        "by_upstream_account_authenticated": ordered_counts(account_totals),
        "errors": {
            "authenticated": ordered_counts(error_breakdown["authenticated"]),
            "unattributed": ordered_counts(error_breakdown["unattributed"]),
            "rate_limit_by_kind": ordered_counts(rate_limit_breakdown),
        },
        "users": user_rows,
    }


TOTAL_FIELDS = (
    "requests",
    "ok",
    "errors",
    "rate_limited",
    "prompt_tokens",
    "completion_tokens",
    "total_tokens",
    "cached_prompt_tokens",
    "estimated_tokens",
    "reasoning_tokens",
    "usage_missing",
    "over_request_limit",
    "identity_guard_hit",
)


def empty_totals() -> dict[str, int]:
    return {field: 0 for field in TOTAL_FIELDS}


def add_usage(destination: dict[str, Any], row: dict[str, Any]) -> None:
    for field in TOTAL_FIELDS:
        destination[field] = int(destination.get(field) or 0) + int(row.get(field) or 0)


def success_rate(totals: dict[str, Any]) -> float | None:
    requests = int(totals.get("requests") or 0)
    return round(int(totals.get("ok") or 0) * 100 / requests, 2) if requests else None


def ordered_counts(values: dict[str, int]) -> dict[str, int]:
    return dict(sorted(values.items(), key=lambda item: (-item[1], item[0])))


def assess_health(
    report: dict[str, Any],
    *,
    disk_warning_percent: float,
    tls_warning_days: int,
    loopback_health_url: str = DEFAULT_LOOPBACK_HEALTH_URL,
) -> dict[str, Any]:
    critical: list[str] = []
    warnings: list[str] = []
    server = report["server"]

    public = server.get("public_health") or {}
    if not public.get("ok") or get_path(public, "body", "state") != "ready":
        critical.append("public Gateway health is not ready")
    loopback = server.get("loopback_health") or {}
    if not loopback.get("ok") or get_path(loopback, "body", "state") != "ready":
        critical.append("loopback Gateway health is not ready")

    container = server.get("container") or {}
    if not container.get("running") or container.get("health") != "healthy":
        critical.append("Gateway container is not running and healthy")
    if container.get("oom_killed"):
        critical.append("Gateway container was OOM-killed")
    if not ports_are_loopback_only(
        container.get("ports"),
        loopback_health_url=loopback_health_url,
    ):
        critical.append("Gateway container port binding is not loopback-only")

    host = server.get("host") or {}
    services = host.get("services") if isinstance(host.get("services"), dict) else {}
    for service in ("nginx", "docker", "postgresql", "medevidence-v2", "medevidence-v2-worker"):
        if services.get(service) != "active":
            critical.append(f"host service {service} is {services.get(service) or 'unknown'}")

    disk = host.get("disk_root") if isinstance(host.get("disk_root"), dict) else {}
    total_bytes = int(disk.get("total_bytes") or 0)
    used_percent = int(disk.get("used_bytes") or 0) * 100 / total_bytes if total_bytes else None
    if used_percent is not None and used_percent >= disk_warning_percent:
        warnings.append(f"root disk usage is {used_percent:.1f}%")

    tls = server.get("tls") or {}
    if not tls.get("ok"):
        critical.append("public TLS validation failed")
    elif float(tls.get("days_remaining") or 0) < tls_warning_days:
        warnings.append(f"TLS certificate expires in {tls.get('days_remaining')} days")

    ops = server.get("ops_snapshot") or {}
    if ops.get("runtimeSnapshotStatus") != "ok":
        warnings.append(f"Gateway runtime snapshot is {ops.get('runtimeSnapshotStatus') or 'unavailable'}")
    window = get_path(ops, "windows", "15m") or {}
    if int(window.get("infrastructureErrors") or 0) > 0:
        warnings.append(
            f"last 15 minutes contain {window.get('infrastructureErrors')} infrastructure errors"
        )
    if int(window.get("upstreamRateLimited") or 0) > 0:
        warnings.append(
            f"last 15 minutes contain {window.get('upstreamRateLimited')} upstream rate limits"
        )

    daily_infra_errors = sum(
        count
        for code, count in report["usage"]["errors"]["authenticated"].items()
        if code in INFRASTRUCTURE_ERROR_CODES
    )
    if daily_infra_errors:
        warnings.append(f"reporting day contains {daily_infra_errors} authenticated infrastructure errors")

    for item in server.get("collector_errors") or []:
        critical.append(f"collector component {item.get('component')}: {item.get('error')}")

    status = "critical" if critical else "warning" if warnings else "healthy"
    return {"status": status, "critical": critical, "warnings": warnings}


def ports_are_loopback_only(
    ports: Any,
    *,
    loopback_health_url: str = DEFAULT_LOOPBACK_HEALTH_URL,
) -> bool:
    if not isinstance(ports, dict):
        return False
    try:
        parsed = urlparse(loopback_health_url)
        expected_host_port = parsed.port
    except ValueError:
        return False
    if parsed.hostname not in {"127.0.0.1", "::1", "localhost"} or not expected_host_port:
        return False
    bindings = [
        binding
        for published in ports.values()
        if isinstance(published, list)
        for binding in published
    ]
    if not bindings:
        return False
    return any(
        isinstance(binding, dict)
        and str(binding.get("HostPort")) == str(expected_host_port)
        for binding in bindings
    ) and all(
        isinstance(binding, dict)
        and binding.get("HostIp") in {"127.0.0.1", "::1"}
        for binding in bindings
    )


def format_text_report(report: dict[str, Any], *, include_user_ids: bool) -> str:
    window = report["window"]
    usage = report["usage"]
    authenticated = usage["authenticated"]
    unattributed = usage["unattributed"]
    server = report["server"]
    health = report["health"]
    status_label = {"healthy": "健康", "warning": "需关注", "critical": "异常"}[health["status"]]

    lines = [
        f"Codex Gateway 当日使用与健康报告 — {report['local_date']}",
        f"状态: {status_label} ({health['status']})",
        f"时间范围: {window['since_local']} 至 {window['until_local']}",
        "",
        "用户使用",
        (
            f"  已认证用户 {authenticated.get('distinct_users', 0)} 人，"
            f"请求 {number(authenticated['requests'])}，成功 {number(authenticated['ok'])}，"
            f"失败 {number(authenticated['errors'])}，限流 {number(authenticated['rate_limited'])}，"
            f"成功率 {format_percent(authenticated.get('success_rate_percent'))}"
        ),
        (
            f"  Token：总计 {number(authenticated['total_tokens'])}，"
            f"输入 {number(authenticated['prompt_tokens'])}，"
            f"输出 {number(authenticated['completion_tokens'])}，"
            f"缓存输入 {number(authenticated['cached_prompt_tokens'])}"
        ),
        f"  模型：{format_counts(usage['by_model_authenticated'])}",
        f"  上游账户：{format_counts(usage['by_upstream_account_authenticated'])}",
    ]
    if unattributed["requests"]:
        lines.append(
            f"  未归属/未认证事件 {number(unattributed['requests'])}，"
            f"失败 {number(unattributed['errors'])}（不计入活跃用户）"
        )
    lines.extend(["", "按用户"])
    if not usage["users"]:
        lines.append("  今天尚无已认证用户请求。")
    for user in usage["users"]:
        identity = str(user["name"])
        if include_user_ids:
            identity += f" [{user['subject_id']}]"
        lines.append(
            f"  - {identity}: 请求 {number(user['requests'])}，成功 {number(user['ok'])}，"
            f"失败 {number(user['errors'])}，Token {number(user['total_tokens'])}，"
            f"模型 {format_counts(user['models'])}"
        )

    auth_errors = usage["errors"]["authenticated"]
    unauth_errors = usage["errors"]["unattributed"]
    lines.extend(
        [
            "",
            "错误分布",
            f"  已认证：{format_counts(auth_errors)}",
            f"  未归属：{format_counts(unauth_errors)}",
            "",
            "服务健康",
        ]
    )
    public = server.get("public_health") or {}
    loopback = server.get("loopback_health") or {}
    container = server.get("container") or {}
    host = server.get("host") or {}
    tls = server.get("tls") or {}
    lines.append(
        f"  公网：HTTP {public.get('status_code')} / {get_path(public, 'body', 'state') or 'unknown'} / "
        f"{public.get('latency_ms')} ms"
    )
    lines.append(
        f"  回环：HTTP {loopback.get('status_code')} / {get_path(loopback, 'body', 'state') or 'unknown'} / "
        f"{loopback.get('latency_ms')} ms"
    )
    lines.append(
        f"  容器：{container.get('status') or 'unknown'} / health={container.get('health') or 'unknown'} / "
        f"restart={container.get('restart_count')} / OOM={container.get('oom_killed')} / "
        f"{format_container_stats(container.get('stats'))}"
    )
    disk = host.get("disk_root") if isinstance(host.get("disk_root"), dict) else {}
    memory = host.get("memory") if isinstance(host.get("memory"), dict) else {}
    disk_percent = ratio_percent(disk.get("used_bytes"), disk.get("total_bytes"))
    memory_percent = ratio_percent(
        int(memory.get("total_bytes") or 0) - int(memory.get("available_bytes") or 0),
        memory.get("total_bytes"),
    )
    load = host.get("load_average") or []
    lines.append(
        f"  VM：运行 {format_duration(host.get('uptime_seconds'))}，"
        f"负载 {format_load(load)}，根盘 {format_percent(disk_percent)}，"
        f"内存 {format_percent(memory_percent)}"
    )
    lines.append(f"  服务：{format_service_states(host.get('services'))}")
    lines.append(
        f"  TLS：{tls.get('subject') or 'unknown'}，到期 {tls.get('expires_at') or 'unknown'}，"
        f"剩余 {tls.get('days_remaining')} 天"
    )
    ops_15m = get_path(server, "ops_snapshot", "windows", "15m") or {}
    lines.append(
        f"  最近 15 分钟：请求 {number(ops_15m.get('total') or 0)}，"
        f"成功 {number(ops_15m.get('ok') or 0)}，失败 {number(ops_15m.get('errors') or 0)}，"
        f"P95 {format_ms(ops_15m.get('p95DurationMs'))}"
    )
    upstream = get_path(server, "ops_snapshot", "upstreamAccounts") or []
    lines.append(f"  上游状态：{format_upstream_states(upstream)}")

    if health["critical"] or health["warnings"]:
        lines.extend(["", "关注项"])
        lines.extend(f"  - 严重：{item}" for item in health["critical"])
        lines.extend(f"  - 警告：{item}" for item in health["warnings"])
    return "\n".join(lines)


def format_container_stats(stats: Any) -> str:
    if not isinstance(stats, dict):
        return "资源数据不可用"
    return f"CPU {stats.get('CPUPerc') or '?'} / 内存 {stats.get('MemUsage') or '?'}"


def format_service_states(value: Any) -> str:
    if not isinstance(value, dict):
        return "不可用"
    return ", ".join(f"{name}={state}" for name, state in value.items())


def format_upstream_states(value: Any) -> str:
    if not isinstance(value, list) or not value:
        return "不可用"
    parts = []
    for item in value:
        if not isinstance(item, dict):
            continue
        suffix = ""
        if item.get("cooldownUntil"):
            suffix = f", cooldown={item.get('cooldownUntil')}"
        parts.append(f"{item.get('id')}={item.get('state')}{suffix}")
    return ", ".join(parts) or "不可用"


def format_counts(value: dict[str, int]) -> str:
    if not value:
        return "无"
    return ", ".join(f"{key} {number(count)}" for key, count in value.items())


def number(value: Any) -> str:
    return f"{int(value or 0):,}"


def format_percent(value: float | None) -> str:
    return "无数据" if value is None else f"{value:.1f}%"


def ratio_percent(numerator: Any, denominator: Any) -> float | None:
    bottom = float(denominator or 0)
    return float(numerator or 0) * 100 / bottom if bottom else None


def format_duration(value: Any) -> str:
    seconds = int(float(value or 0))
    days, remainder = divmod(seconds, 86400)
    hours, _ = divmod(remainder, 3600)
    return f"{days}天{hours}小时"


def format_load(value: Any) -> str:
    if not isinstance(value, list) or len(value) < 3:
        return "不可用"
    return "/".join(f"{float(item):.2f}" for item in value[:3])


def format_ms(value: Any) -> str:
    if value is None:
        return "无数据"
    milliseconds = float(value)
    return f"{milliseconds / 1000:.1f}s" if milliseconds >= 1000 else f"{milliseconds:.0f}ms"


def sanitize_collector_errors(value: Any) -> list[dict[str, str]]:
    if not isinstance(value, list):
        return []
    result = []
    for item in value:
        if isinstance(item, dict):
            result.append(
                {
                    "component": str(item.get("component") or "unknown"),
                    "error": redact_secrets(str(item.get("error") or "unknown")),
                }
            )
    return result


def get_path(value: Any, *keys: str) -> Any:
    current = value
    for key in keys:
        if not isinstance(current, dict):
            return None
        current = current.get(key)
    return current


def expanded_ssh_key(value: str) -> Path:
    if not value.startswith("~"):
        return Path(value)
    suffix_parts = [
        part for part in re.split(r"[\\/]+", value[1:]) if part
    ]
    return Path.home().joinpath(*suffix_parts)


def iso_z(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


if __name__ == "__main__":
    raise SystemExit(main())
