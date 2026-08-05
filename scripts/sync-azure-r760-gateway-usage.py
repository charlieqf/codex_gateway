#!/usr/bin/env python3
"""Merge Azure compatibility usage into the authoritative R760 usage ledger."""

from __future__ import annotations

import argparse
import json
import sys

from codex_gateway_ops_common import redact_secrets
from gateway_state_sync import (
    DEFAULT_R760_BACKUP_ROOT,
    RemoteGateway,
    default_azure_gateway,
    default_r760_gateway,
)
from gateway_usage_sync import DEFAULT_USAGE_SYNC_SINCE, sync_azure_usage_to_r760


def positive_int(value: str) -> int:
    parsed = int(value)
    if parsed < 1:
        raise argparse.ArgumentTypeError("value must be positive")
    return parsed


def parse_args() -> argparse.Namespace:
    azure = default_azure_gateway()
    r760 = default_r760_gateway()
    parser = argparse.ArgumentParser(
        description=(
            "Idempotently merge finalized Azure compatibility usage into R760. "
            "The default is a read-only dry-run; --apply backs up R760 before writing."
        )
    )
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--fail-on-drift", action="store_true")
    parser.add_argument("--since", default=DEFAULT_USAGE_SYNC_SINCE)
    parser.add_argument("--until")
    parser.add_argument("--max-passes", type=positive_int, default=3)
    parser.add_argument("--backup-root", default=DEFAULT_R760_BACKUP_ROOT)
    parser.add_argument("--azure-host", default=azure.host)
    parser.add_argument("--azure-user", default=azure.user)
    parser.add_argument("--azure-port", type=positive_int, default=azure.port)
    parser.add_argument("--azure-ssh-key", default=azure.ssh_key)
    parser.add_argument("--azure-container", default=azure.container)
    parser.add_argument("--r760-host", default=r760.host)
    parser.add_argument("--r760-user", default=r760.user)
    parser.add_argument("--r760-port", type=positive_int, default=r760.port)
    parser.add_argument("--r760-ssh-key", default=r760.ssh_key)
    parser.add_argument("--r760-container", default=r760.container)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.fail_on_drift and args.apply:
        print("error: --fail-on-drift is only valid for a read-only dry-run", file=sys.stderr)
        return 2
    azure = RemoteGateway(
        name="azure",
        host=args.azure_host,
        user=args.azure_user,
        ssh_key=args.azure_ssh_key,
        container=args.azure_container,
        port=args.azure_port,
        use_sudo=True,
    )
    r760 = RemoteGateway(
        name="r760",
        host=args.r760_host,
        user=args.r760_user,
        ssh_key=args.r760_ssh_key,
        container=args.r760_container,
        port=args.r760_port,
    )
    try:
        result = sync_azure_usage_to_r760(
            apply=args.apply,
            azure=azure,
            r760=r760,
            since=args.since,
            until=args.until,
            backup_root=args.backup_root,
            max_passes=args.max_passes,
        )
        print(json.dumps(result, ensure_ascii=False, indent=2))
        if args.fail_on_drift and (result.get("initial_plan") or {}).get("changed_rows") != 0:
            return 3
        return 0
    except Exception as exc:
        print(redact_secrets(f"error: {exc}"), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
