#!/usr/bin/env python3
"""Run an approved R760 control-plane write and mirror it to Azure.

The dedicated real-user issuance script remains the only supported command for
creating deliverable cgu_live keys. This wrapper intentionally rejects admin
commands that reveal or return full credentials.
"""

from __future__ import annotations

import argparse
import base64
import json
import sys
from typing import Any

from codex_gateway_ops_common import redact_secrets
from gateway_state_sync import (
    DEFAULT_AZURE_BACKUP_ROOT,
    RemoteGateway,
    default_azure_gateway,
    default_r760_gateway,
    docker_command,
    run_ssh,
    shell_word,
    sync_r760_to_azure,
)


GATEWAY_DB_PATH = "/var/lib/codex-gateway/gateway.db"
SIMPLE_WRITE_COMMANDS = {
    "disable-user",
    "enable-user",
    "revoke",
    "update-key",
    "update-user",
}
NESTED_WRITE_COMMANDS = {
    "entitlement": {"bulk-grant", "cancel", "grant", "pause", "renew", "resume"},
    "plan": {"create", "deprecate"},
    "unified-key": {"revoke"},
}


class ManagementError(RuntimeError):
    pass


def positive_int(value: str) -> int:
    parsed = int(value)
    if parsed < 1:
        raise argparse.ArgumentTypeError("value must be positive")
    return parsed


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    r760 = default_r760_gateway()
    azure = default_azure_gateway()
    parser = argparse.ArgumentParser(
        description=(
            "Run an approved user/key/plan write on authoritative R760, then "
            "fail closed unless the Azure compatibility mirror converges."
        )
    )
    parser.add_argument("--what-if", action="store_true")
    parser.add_argument("--timeout-seconds", type=positive_int, default=60)
    parser.add_argument("--sync-max-passes", type=positive_int, default=3)
    parser.add_argument("--compatibility-backup-root", default=DEFAULT_AZURE_BACKUP_ROOT)
    parser.add_argument("--r760-host", default=r760.host)
    parser.add_argument("--r760-user", default=r760.user)
    parser.add_argument("--r760-port", type=positive_int, default=r760.port)
    parser.add_argument("--r760-ssh-key", default=r760.ssh_key)
    parser.add_argument("--r760-container", default=r760.container)
    parser.add_argument("--azure-host", default=azure.host)
    parser.add_argument("--azure-user", default=azure.user)
    parser.add_argument("--azure-port", type=positive_int, default=azure.port)
    parser.add_argument("--azure-ssh-key", default=azure.ssh_key)
    parser.add_argument("--azure-container", default=azure.container)
    parser.add_argument(
        "admin_args",
        nargs=argparse.REMAINDER,
        help="Admin CLI write after '--', for example: -- disable-user <user-id>",
    )
    args = parser.parse_args(argv)
    if args.admin_args and args.admin_args[0] == "--":
        args.admin_args = args.admin_args[1:]
    return args


def validate_admin_args(admin_args: list[str]) -> tuple[str, str | None]:
    if not admin_args:
        raise ManagementError("An admin CLI write command is required after '--'.")
    command = admin_args[0]
    if command in SIMPLE_WRITE_COMMANDS:
        return command, None
    allowed_nested = NESTED_WRITE_COMMANDS.get(command)
    if allowed_nested and len(admin_args) >= 2 and admin_args[1] in allowed_nested:
        return command, admin_args[1]
    raise ManagementError(
        "Command is not in the safe R760 control-write allowlist. Use "
        "issue-real-user-cgu-key.py for issuance; reveal/rotate commands are intentionally rejected."
    )


def run_remote_admin(
    endpoint: RemoteGateway,
    admin_args: list[str],
    *,
    timeout_seconds: int,
) -> dict[str, Any]:
    payload = base64.urlsafe_b64encode(
        json.dumps(admin_args, ensure_ascii=False).encode("utf-8")
    ).decode("ascii")
    node_script = (
        'const {spawnSync}=require("node:child_process");'
        'const b=process.env.ADMIN_ARGS_B64||"";'
        'const a=JSON.parse(Buffer.from(b.replace(/-/g,"+").replace(/_/g,"/"),"base64").toString("utf8"));'
        f'const r=spawnSync("node",["apps/admin-cli/dist/index.js","--db","{GATEWAY_DB_PATH}",...a],'
        '{encoding:"utf8"});'
        'if(r.stdout)process.stdout.write(r.stdout);'
        'if(r.stderr)process.stderr.write(r.stderr);'
        'process.exit(r.status===null?1:r.status);'
    )
    remote_command = (
        f"{docker_command(endpoint)} exec -i -w /app -e ADMIN_ARGS_B64={payload} "
        f"{shell_word(endpoint.container)} node -e {shell_word(node_script)}"
    )
    completed = run_ssh(endpoint, remote_command, timeout_seconds=timeout_seconds)
    try:
        result = json.loads(completed.stdout) if completed.stdout.strip() else {}
    except json.JSONDecodeError as exc:
        raise ManagementError("R760 admin CLI returned invalid JSON.") from exc
    if not isinstance(result, dict):
        raise ManagementError("R760 admin CLI returned an unexpected result.")
    return result


def public_sync_result(value: dict[str, Any]) -> dict[str, Any]:
    backup = value.get("backup") if isinstance(value.get("backup"), dict) else None
    return {
        "converged": value.get("converged") is True,
        "passes": value.get("passes"),
        "changed_rows": (value.get("initial_plan") or {}).get("changed_rows"),
        "azure_backup_path": backup.get("backup_path") if backup else None,
    }


def execute(args: argparse.Namespace) -> dict[str, Any]:
    command, subcommand = validate_admin_args(args.admin_args)
    if args.what_if:
        return {
            "what_if": True,
            "authority": "r760",
            "compatibility_mirror": "azure",
            "command": command,
            "subcommand": subcommand,
            "argument_count": len(args.admin_args),
        }

    r760 = RemoteGateway(
        name="r760",
        host=args.r760_host,
        user=args.r760_user,
        ssh_key=args.r760_ssh_key,
        container=args.r760_container,
        port=args.r760_port,
    )
    azure = RemoteGateway(
        name="azure",
        host=args.azure_host,
        user=args.azure_user,
        ssh_key=args.azure_ssh_key,
        container=args.azure_container,
        port=args.azure_port,
        use_sudo=True,
    )
    authority_result = run_remote_admin(
        r760,
        args.admin_args,
        timeout_seconds=args.timeout_seconds,
    )
    mirror = sync_r760_to_azure(
        apply=True,
        r760=r760,
        azure=azure,
        backup_root=args.compatibility_backup_root,
        max_passes=args.sync_max_passes,
    )
    if not mirror.get("converged"):
        raise ManagementError(
            "R760 write succeeded, but the Azure compatibility mirror did not converge. "
            "Do not repeat the write blindly; run the mirror dry-run and reconcile it."
        )
    return {
        "status": "ok",
        "authority": "r760",
        "command": command,
        "subcommand": subcommand,
        "authority_result": authority_result,
        "azure_compatibility_mirror": public_sync_result(mirror),
    }


def main() -> int:
    args = parse_args()
    try:
        result = execute(args)
        print(redact_secrets(json.dumps(result, ensure_ascii=False, indent=2)))
        return 0
    except Exception as exc:
        print(redact_secrets(f"error: {exc}"), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
