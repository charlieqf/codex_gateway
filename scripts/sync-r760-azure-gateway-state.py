#!/usr/bin/env python3
"""Mirror authoritative R760 Gateway control state to Azure compatibility."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from codex_gateway_ops_common import redact_secrets
from gateway_state_sync import (
    DEFAULT_AZURE_BACKUP_ROOT,
    DEFAULT_AZURE_BASE_URL,
    DEFAULT_R760_BASE_URL,
    RemoteGateway,
    default_azure_gateway,
    default_r760_gateway,
    load_opaque_key_file,
    sync_r760_to_azure,
    validate_unified_key_pair,
)


def positive_int(value: str) -> int:
    parsed = int(value)
    if parsed < 1:
        raise argparse.ArgumentTypeError("value must be positive")
    return parsed


def parse_args() -> argparse.Namespace:
    r760 = default_r760_gateway()
    azure = default_azure_gateway()
    parser = argparse.ArgumentParser(
        description=(
            "Safely mirror R760's authoritative Gateway control-plane rows to the "
            "temporary Azure compatibility endpoint. The default is a read-only dry run; "
            "--apply creates a verified Azure backup first."
        )
    )
    parser.add_argument("--apply", action="store_true")
    parser.add_argument(
        "--fail-on-drift",
        action="store_true",
        help="For manual dry-runs, return exit code 3 when compatibility mirroring is required.",
    )
    parser.add_argument("--max-passes", type=positive_int, default=3)
    parser.add_argument("--backup-root", default=DEFAULT_AZURE_BACKUP_ROOT)
    parser.add_argument("--verify-key-file", action="append", default=[])
    parser.add_argument("--no-require-image-capability", action="store_true")
    parser.add_argument("--r760-base-url", default=DEFAULT_R760_BASE_URL)
    parser.add_argument("--azure-base-url", default=DEFAULT_AZURE_BASE_URL)
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
    parser.add_argument("--timeout-seconds", type=positive_int, default=45)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.verify_key_file and not args.apply:
        print("error: --verify-key-file requires --apply", file=sys.stderr)
        return 2
    if args.fail_on_drift and args.apply:
        print("error: --fail-on-drift is only valid for a read-only dry-run", file=sys.stderr)
        return 2

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
    try:
        result = sync_r760_to_azure(
            apply=args.apply,
            r760=r760,
            azure=azure,
            backup_root=args.backup_root,
            max_passes=args.max_passes,
        )
        verified = 0
        for value in args.verify_key_file:
            opaque_key, expected_subject_id = load_opaque_key_file(Path(value))
            validate_unified_key_pair(
                opaque_key,
                expected_subject_id=expected_subject_id,
                azure_base_url=args.azure_base_url,
                r760_base_url=args.r760_base_url,
                require_image_capability=not args.no_require_image_capability,
                timeout_seconds=args.timeout_seconds,
            )
            verified += 1
        result["verified_key_count"] = verified
        print(json.dumps(result, ensure_ascii=False, indent=2))
        if args.fail_on_drift and result.get("initial_plan", {}).get("changed_rows") != 0:
            return 3
        return 0
    except Exception as exc:
        print(redact_secrets(f"error: {exc}"), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
