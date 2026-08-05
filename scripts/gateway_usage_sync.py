#!/usr/bin/env python3
"""Idempotent Azure-compatibility usage-history merge into authoritative R760."""

from __future__ import annotations

import secrets
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from gateway_state_sync import (
    DEFAULT_R760_BACKUP_ROOT,
    RemoteGateway,
    SyncError,
    create_target_backup,
    default_azure_gateway,
    default_r760_gateway,
    install_helper,
    remove_helper_best_effort,
    run_helper_json,
    verify_inspections,
)


DEFAULT_USAGE_SYNC_SINCE = "2026-08-04T00:00:00.000Z"
DEFAULT_USAGE_HELPER_PATH = Path(__file__).with_name("gateway-usage-history-transfer.cjs")


def normalize_iso(value: str, label: str) -> str:
    normalized = value.strip()
    if normalized.endswith("Z"):
        normalized = normalized[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError as exc:
        raise SyncError(f"{label} must be an ISO timestamp.") from exc
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def sync_azure_usage_to_r760(
    *,
    apply: bool,
    azure: RemoteGateway | None = None,
    r760: RemoteGateway | None = None,
    since: str = DEFAULT_USAGE_SYNC_SINCE,
    until: str | None = None,
    backup_root: str = DEFAULT_R760_BACKUP_ROOT,
    max_passes: int = 3,
) -> dict[str, Any]:
    if max_passes < 1 or max_passes > 5:
        raise SyncError("max_passes must be between 1 and 5.")
    since = normalize_iso(since, "since")
    until = normalize_iso(
        until or datetime.now(timezone.utc).isoformat(),
        "until",
    )
    if until <= since:
        raise SyncError("until must be after since.")

    azure = azure or default_azure_gateway()
    r760 = r760 or default_r760_gateway()
    helper_container_path = f"/tmp/gateway-usage-history-transfer-{secrets.token_hex(6)}.cjs"
    installed: list[RemoteGateway] = []
    try:
        for endpoint in (azure, r760):
            install_helper(
                endpoint,
                helper_path=DEFAULT_USAGE_HELPER_PATH,
                container_path=helper_container_path,
            )
            installed.append(endpoint)

        source_inspection = run_helper_json(
            azure,
            "inspect",
            helper_container_path=helper_container_path,
        )
        target_inspection = run_helper_json(
            r760,
            "inspect",
            helper_container_path=helper_container_path,
        )
        verify_inspections(source_inspection, target_inspection)

        payload = run_helper_json(
            azure,
            "export",
            extra_args=["--since", since, "--until", until],
            helper_container_path=helper_container_path,
            timeout_seconds=600,
        )
        plan = run_helper_json(
            r760,
            "plan",
            payload=payload,
            helper_container_path=helper_container_path,
            timeout_seconds=600,
        )
        result: dict[str, Any] = {
            "mode": "apply" if apply else "dry-run",
            "source": "azure-compatibility",
            "target": "r760-authority",
            "preflight": "ok",
            "schema_version": source_inspection.get("migration"),
            "encryption_secret_match": True,
            "window": {"since": since, "until": until},
            "source_open_reservations": source_inspection.get("open_reservations"),
            "target_open_reservations": target_inspection.get("open_reservations"),
            "initial_plan": plan,
            "converged": plan.get("changed_rows") == 0,
            "passes": 0,
            "backup": None,
        }
        if not apply or plan.get("changed_rows") == 0:
            return result

        backup = create_target_backup(
            r760,
            backup_root=backup_root,
            backup_label="r760-usage",
            helper_container_path=helper_container_path,
        )
        result["backup"] = backup
        for pass_number in range(1, max_passes + 1):
            applied = run_helper_json(
                r760,
                "apply",
                payload=payload,
                extra_args=[
                    "--backup-id",
                    str(backup["backup_id"]),
                    "--source-name",
                    "azure-compatibility",
                    "--target-name",
                    "r760-authority",
                ],
                helper_container_path=helper_container_path,
                timeout_seconds=600,
            )
            result["passes"] = pass_number
            result["last_apply"] = applied
            payload = run_helper_json(
                azure,
                "export",
                extra_args=["--since", since, "--until", until],
                helper_container_path=helper_container_path,
                timeout_seconds=600,
            )
            final_plan = run_helper_json(
                r760,
                "plan",
                payload=payload,
                helper_container_path=helper_container_path,
                timeout_seconds=600,
            )
            result["final_plan"] = final_plan
            if final_plan.get("changed_rows") == 0:
                result["converged"] = True
                return result

        raise SyncError("Azure compatibility usage did not converge on R760 within the fixed window.")
    finally:
        for endpoint in reversed(installed):
            remove_helper_best_effort(endpoint, container_path=helper_container_path)


def public_usage_sync_result(value: dict[str, Any]) -> dict[str, Any]:
    backup = value.get("backup") if isinstance(value.get("backup"), dict) else None
    return {
        "mode": value.get("mode"),
        "source": value.get("source"),
        "target": value.get("target"),
        "window": value.get("window"),
        "converged": value.get("converged") is True,
        "passes": value.get("passes"),
        "changed_rows": (value.get("initial_plan") or {}).get("changed_rows"),
        "backup_path": backup.get("backup_path") if backup else None,
    }
