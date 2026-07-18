#!/usr/bin/env python3
"""
Query recent Desktop client messages from the live Codex Gateway container.

This is a read-only wrapper around the deployed admin CLI `client-messages`
command. By default it prints a readable support view with prompt previews. Use
`--include-text` only when full user prompts are needed for a support reason.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

from codex_gateway_ops_common import DEFAULT_REMOTE_REPO, redact_secrets


DEFAULT_VM_HOST = "4.242.58.89"
DEFAULT_VM_USER = "qian"
DEFAULT_SSH_KEY = r"~\.ssh\medevidence_azure_wus2_ed25519"
DEFAULT_COMPOSE_PROJECT = "codex_gateway_test"
DEFAULT_COMPOSE_FILE = "compose.azure.yml"
DEFAULT_GATEWAY_SERVICE = "gateway"
DEFAULT_GATEWAY_DB = "/var/lib/codex-gateway/gateway.db"
DEFAULT_CLIENT_EVENTS_DB = "/var/lib/codex-gateway/client-events.db"

class QueryError(RuntimeError):
    pass


def main() -> int:
    configure_stdio()
    args = parse_args()
    try:
        result = query_messages(args)
        if args.format == "json":
            print(json.dumps(result, ensure_ascii=False, indent=2))
        else:
            print(format_text_output(result, include_text=args.include_text))
    except Exception as exc:
        print(redact_secrets(f"error: {exc}"), file=sys.stderr)
        return 1
    return 0


def configure_stdio() -> None:
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if callable(reconfigure):
            reconfigure(encoding="utf-8", errors="replace")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Query recent Desktop client messages from the live Gateway SQLite databases."
    )
    identity = parser.add_mutually_exclusive_group(required=True)
    identity.add_argument("--user", help="User id, label, or stored display name.")
    identity.add_argument("--subject-id", help="Gateway subject id.")
    identity.add_argument("--credential-prefix", help="Gateway API key prefix.")

    parser.add_argument("--session-id", help="Filter by Desktop session id.")
    parser.add_argument("--message-id", help="Filter by Desktop message id.")
    parser.add_argument("--request-id", help="Filter by Gateway ingest request id.")
    parser.add_argument("--limit", type=positive_int, default=20, help="Maximum messages to return.")
    parser.add_argument(
        "--include-text",
        action="store_true",
        help="Return full prompt text instead of only text_preview.",
    )
    parser.add_argument("--preview-chars", type=positive_int, default=160)
    parser.add_argument("--since", help="Inclusive ISO start time passed to the admin CLI.")
    parser.add_argument("--timezone", default="Asia/Shanghai", help="IANA timezone for local timestamps.")
    parser.add_argument("--format", choices=["text", "json"], default="text")

    parser.add_argument("--vm-host", default=DEFAULT_VM_HOST)
    parser.add_argument("--vm-user", default=DEFAULT_VM_USER)
    parser.add_argument("--ssh-key", default=DEFAULT_SSH_KEY)
    parser.add_argument("--remote-repo", default=DEFAULT_REMOTE_REPO)
    parser.add_argument("--compose-project", default=DEFAULT_COMPOSE_PROJECT)
    parser.add_argument("--compose-file", default=DEFAULT_COMPOSE_FILE)
    parser.add_argument("--gateway-service", default=DEFAULT_GATEWAY_SERVICE)
    parser.add_argument("--gateway-db", default=DEFAULT_GATEWAY_DB)
    parser.add_argument("--client-events-db", default=DEFAULT_CLIENT_EVENTS_DB)
    parser.add_argument("--timeout-seconds", type=positive_int, default=45)
    return parser.parse_args()


def positive_int(value: str) -> int:
    parsed = int(value)
    if parsed < 1:
        raise argparse.ArgumentTypeError("value must be positive")
    return parsed


def query_messages(args: argparse.Namespace) -> dict[str, Any]:
    admin_args = [
        "--db",
        args.gateway_db,
        "--client-events-db",
        args.client_events_db,
        "client-messages",
        "--limit",
        str(args.limit),
        "--preview-chars",
        str(args.preview_chars),
        "--timezone",
        args.timezone,
    ]
    append_optional(admin_args, "--user", args.user)
    append_optional(admin_args, "--subject-id", args.subject_id)
    append_optional(admin_args, "--credential-prefix", args.credential_prefix)
    append_optional(admin_args, "--session-id", args.session_id)
    append_optional(admin_args, "--message-id", args.message_id)
    append_optional(admin_args, "--request-id", args.request_id)
    append_optional(admin_args, "--since", args.since)
    if args.include_text:
        admin_args.append("--include-text")

    payload = base64.urlsafe_b64encode(json.dumps(admin_args, ensure_ascii=False).encode("utf-8")).decode(
        "ascii"
    )
    node_script = (
        'const {spawnSync}=require("node:child_process");'
        'const b=process.env.ADMIN_ARGS_B64||"";'
        'const args=JSON.parse(Buffer.from(b.replace(/-/g,"+").replace(/_/g,"/"),"base64").toString("utf8"));'
        'const r=spawnSync("node",["apps/admin-cli/dist/index.js",...args],{encoding:"utf8"});'
        'if(r.stdout)process.stdout.write(r.stdout);'
        'if(r.stderr)process.stderr.write(r.stderr);'
        'process.exit(r.status===null?1:r.status);'
    )
    remote_command = (
        f"cd {shell_word(args.remote_repo)} && "
        f"sudo docker compose -p {shell_word(args.compose_project)} "
        f"-f {shell_word(args.compose_file)} exec -T "
        f"-e ADMIN_ARGS_B64={payload} "
        f"{shell_word(args.gateway_service)} node -e {shell_word(node_script)}"
    )
    completed = run_ssh(args, remote_command)
    stdout = completed.stdout.strip()
    try:
        parsed = json.loads(stdout) if stdout else {}
    except json.JSONDecodeError as exc:
        raise QueryError(f"admin CLI returned non-JSON output: {stdout[:1000]}") from exc
    if not isinstance(parsed, dict):
        raise QueryError("admin CLI returned an unexpected JSON shape.")
    return parsed


def append_optional(args: list[str], flag: str, value: str | None) -> None:
    if value:
        args.extend([flag, value])


def run_ssh(args: argparse.Namespace, remote_command: str) -> subprocess.CompletedProcess[str]:
    ssh_key = expanded_ssh_key(args.ssh_key)
    if not ssh_key.exists():
        raise QueryError(f"SSH key was not found: {ssh_key}")
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
        remote_command,
    ]
    completed = subprocess.run(
        command,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=max(args.timeout_seconds, 15),
    )
    if completed.returncode != 0:
        raise QueryError(
            redact_secrets(
                "remote command failed: "
                f"exit={completed.returncode} stderr={completed.stderr.strip()[:1000]}"
            )
        )
    return completed


def format_text_output(result: dict[str, Any], *, include_text: bool) -> str:
    subject = result.get("subject") if isinstance(result.get("subject"), dict) else None
    credential = result.get("credential") if isinstance(result.get("credential"), dict) else None
    messages = result.get("messages") if isinstance(result.get("messages"), list) else []

    lines: list[str] = []
    if subject:
        lines.append(
            "subject: "
            f"{subject.get('name') or subject.get('label') or subject.get('id')} "
            f"(id={subject.get('id')}, state={subject.get('state')})"
        )
    else:
        lines.append("subject: <not resolved>")
    if credential:
        lines.append(
            "credential: "
            f"prefix={credential.get('prefix')} status={credential.get('status')} "
            f"scope={credential.get('scope')}"
        )
    lines.append(f"messages: {len(messages)}")

    for index, raw in enumerate(messages, start=1):
        if not isinstance(raw, dict):
            continue
        text_value = raw.get("text") if include_text else raw.get("text_preview")
        if not isinstance(text_value, str):
            text_value = ""
        lines.append("")
        lines.append(
            f"{index}. {raw.get('received_at_local') or raw.get('received_at')} "
            f"agent={raw.get('agent') or ''} session={raw.get('session_id') or ''}"
        )
        lines.append(f"   message_id={raw.get('message_id') or ''} request_id={raw.get('request_id') or ''}")
        lines.append(indent_block(text_value, "   "))
    return "\n".join(lines)


def indent_block(value: str, prefix: str) -> str:
    if value == "":
        return prefix
    return "\n".join(prefix + line for line in value.splitlines())


def expanded_ssh_key(value: str) -> Path:
    return Path(value.replace("~", str(Path.home()), 1))


def shell_word(value: str) -> str:
    return "'" + value.replace("'", "'\"'\"'") + "'"


if __name__ == "__main__":
    raise SystemExit(main())
