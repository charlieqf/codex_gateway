#!/usr/bin/env python3
"""Run an approved R760-only control-plane write with a verified backup.

The dedicated real-user issuance script remains the only supported command for
creating deliverable cgu_live keys. This wrapper intentionally rejects admin
commands that reveal or return full credentials.
"""

from __future__ import annotations

import argparse
import base64
import json
import secrets
import sys
from typing import Any

from codex_gateway_ops_common import redact_secrets
from gateway_state_sync import (
    DEFAULT_R760_BACKUP_ROOT,
    RemoteGateway,
    create_target_backup,
    default_r760_gateway,
    docker_command,
    install_helper,
    remove_helper_best_effort,
    run_helper_json,
    run_ssh,
    shell_word,
)


GATEWAY_DB_PATH = "/var/lib/codex-gateway/gateway.db"
BULK_USER_RPM_COMMAND = "ensure-user-rpm-minimum"
USER_CREDENTIAL_CLASSES = {"desktop", "unknown"}
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
    parser = argparse.ArgumentParser(
        description=(
            "Run an approved user/key/plan write on authoritative R760 after "
            "creating a verified online SQLite backup."
        )
    )
    parser.add_argument("--what-if", action="store_true")
    parser.add_argument("--timeout-seconds", type=positive_int, default=60)
    parser.add_argument("--backup-root", default=DEFAULT_R760_BACKUP_ROOT)
    parser.add_argument("--r760-host", default=r760.host)
    parser.add_argument("--r760-user", default=r760.user)
    parser.add_argument("--r760-port", type=positive_int, default=r760.port)
    parser.add_argument("--r760-ssh-key", default=r760.ssh_key)
    parser.add_argument("--r760-container", default=r760.container)
    parser.add_argument(
        "admin_args",
        nargs=argparse.REMAINDER,
        help=(
            "Admin CLI write after '--', or the wrapper-owned "
            f"'{BULK_USER_RPM_COMMAND} <rpm>' operation."
        ),
    )
    args = parser.parse_args(argv)
    if args.admin_args and args.admin_args[0] == "--":
        args.admin_args = args.admin_args[1:]
    return args


def validate_admin_args(admin_args: list[str]) -> tuple[str, str | None]:
    if not admin_args:
        raise ManagementError("An admin CLI write command is required after '--'.")
    command = admin_args[0]
    if command == BULK_USER_RPM_COMMAND:
        if len(admin_args) != 2:
            raise ManagementError(
                f"{BULK_USER_RPM_COMMAND} requires exactly one positive RPM value."
            )
        positive_int(admin_args[1])
        return command, None
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
        'const fs=require("node:fs");'
        'const b=process.env.ADMIN_ARGS_B64||"";'
        'const a=JSON.parse(Buffer.from(b.replace(/-/g,"+").replace(/_/g,"/"),"base64").toString("utf8"));'
        f'const r=spawnSync("node",["apps/admin-cli/dist/index.js","--db","{GATEWAY_DB_PATH}",...a],'
        '{encoding:"utf8",maxBuffer:16777216});'
        'if(r.stdout)fs.writeSync(1,r.stdout);'
        'if(r.stderr)fs.writeSync(2,r.stderr);'
        'process.exitCode=r.status===null?1:r.status;'
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


def active_or_reenableable_user_credentials(value: dict[str, Any]) -> list[dict[str, Any]]:
    credentials = value.get("credentials")
    if not isinstance(credentials, list):
        raise ManagementError("R760 credential inventory returned an unexpected result.")
    return [
        credential
        for credential in credentials
        if isinstance(credential, dict)
        and credential.get("credential_class") in USER_CREDENTIAL_CLASSES
        and credential.get("revoked_at") is None
        and credential.get("status") != "expired"
    ]


def credential_rpm(credential: dict[str, Any]) -> int:
    rate = credential.get("rate")
    rpm = rate.get("requestsPerMinute") if isinstance(rate, dict) else None
    if not isinstance(rpm, int) or rpm < 1:
        raise ManagementError("R760 credential inventory contains an invalid RPM value.")
    return rpm


def user_rpm_plan(value: dict[str, Any], minimum_rpm: int) -> tuple[dict[str, Any], list[str]]:
    credentials = active_or_reenableable_user_credentials(value)
    distribution: dict[str, int] = {}
    prefixes: list[str] = []
    for credential in credentials:
        rpm = credential_rpm(credential)
        distribution[str(rpm)] = distribution.get(str(rpm), 0) + 1
        if rpm < minimum_rpm:
            prefix = credential.get("prefix")
            if not isinstance(prefix, str) or not prefix:
                raise ManagementError("R760 credential inventory contains a missing prefix.")
            prefixes.append(prefix)
    return (
        {
            "minimum_rpm": minimum_rpm,
            "eligible_user_credentials": len(credentials),
            "credentials_below_minimum": len(prefixes),
            "credentials_unchanged": len(credentials) - len(prefixes),
            "before_rpm_distribution": dict(
                sorted(distribution.items(), key=lambda item: int(item[0]))
            ),
        },
        prefixes,
    )


def validate_r760_inspection(value: dict[str, Any]) -> dict[str, Any]:
    integrity = value.get("integrity") if isinstance(value.get("integrity"), dict) else {}
    if integrity.get("quick_check") != "ok" or integrity.get("foreign_key_violations") != 0:
        raise ManagementError("R760 SQLite integrity or foreign-key validation failed.")
    return {
        "schema_version": value.get("migration"),
        "quick_check": integrity.get("quick_check"),
        "foreign_key_violations": integrity.get("foreign_key_violations"),
    }


def r760_endpoint(args: argparse.Namespace) -> RemoteGateway:
    return RemoteGateway(
        name="r760",
        host=args.r760_host,
        user=args.r760_user,
        ssh_key=args.r760_ssh_key,
        container=args.r760_container,
        port=args.r760_port,
    )


def execute(args: argparse.Namespace) -> dict[str, Any]:
    command, subcommand = validate_admin_args(args.admin_args)
    r760 = r760_endpoint(args)
    bulk_minimum_rpm = (
        int(args.admin_args[1]) if command == BULK_USER_RPM_COMMAND else None
    )
    bulk_plan: dict[str, Any] | None = None
    if bulk_minimum_rpm is not None:
        inventory = run_remote_admin(r760, ["list"], timeout_seconds=args.timeout_seconds)
        bulk_plan, _ = user_rpm_plan(inventory, bulk_minimum_rpm)
    if args.what_if:
        return {
            "what_if": True,
            "authority": "r760",
            "authority_mode": "r760_only",
            "command": command,
            "subcommand": subcommand,
            "argument_count": len(args.admin_args),
            **({"plan": bulk_plan} if bulk_plan is not None else {}),
        }

    helper_path = f"/tmp/gateway-control-state-transfer-{secrets.token_hex(6)}.cjs"
    install_helper(r760, container_path=helper_path)
    try:
        before = validate_r760_inspection(
            run_helper_json(r760, "inspect", helper_container_path=helper_path)
        )
        backup = create_target_backup(
            r760,
            backup_root=args.backup_root,
            backup_label="user-rpm" if bulk_minimum_rpm is not None else "r760-control",
            helper_container_path=helper_path,
        )
        if bulk_minimum_rpm is not None:
            authority_result = run_remote_admin(
                r760,
                [BULK_USER_RPM_COMMAND, str(bulk_minimum_rpm)],
                timeout_seconds=max(args.timeout_seconds, 600),
            )
        else:
            authority_result = run_remote_admin(
                r760,
                args.admin_args,
                timeout_seconds=args.timeout_seconds,
            )
        after = validate_r760_inspection(
            run_helper_json(r760, "inspect", helper_container_path=helper_path)
        )
        result: dict[str, Any] = {
            "status": "ok",
            "authority": "r760",
            "authority_mode": "r760_only",
            "command": command,
            "subcommand": subcommand,
            "backup": backup,
            "integrity_before": before,
            "integrity_after": after,
        }
        if bulk_minimum_rpm is None:
            result["authority_result"] = authority_result
            return result

        final_inventory = run_remote_admin(
            r760, ["list"], timeout_seconds=args.timeout_seconds
        )
        final_plan, _ = user_rpm_plan(final_inventory, bulk_minimum_rpm)
        if final_plan["credentials_below_minimum"] != 0:
            raise ManagementError(
                "R760 user RPM update completed, but post-write verification still found "
                f"{final_plan['credentials_below_minimum']} credentials below the minimum."
            )
        result["plan"] = bulk_plan
        result["updated_credentials"] = authority_result.get("updated_credentials")
        result["post_write"] = final_plan
        return result
    finally:
        remove_helper_best_effort(r760, container_path=helper_path)


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
