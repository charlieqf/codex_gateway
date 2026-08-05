#!/usr/bin/env python3
"""Safe Gateway control-plane reconciliation primitives.

Sensitive database rows and runtime credentials are streamed through process
memory and SSH stdin/stdout only. Public results contain counts and digests,
never key material, ciphertext, phone numbers, or user labels.
"""

from __future__ import annotations

import json
import re
import secrets
import subprocess
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from codex_gateway_ops_common import redact_secrets


DEFAULT_DB_PATH = "/var/lib/codex-gateway/gateway.db"
DEFAULT_HELPER_CONTAINER_PATH = "/tmp/gateway-control-state-transfer.cjs"
DEFAULT_HELPER_LOCAL_PATH = Path(__file__).with_name("gateway-control-state-transfer.cjs")
DEFAULT_AZURE_BASE_URL = "https://gw.instmarket.com.au"
DEFAULT_R760_BASE_URL = "https://goldencode.instmarket.com.au:1443"
DEFAULT_R760_BACKUP_ROOT = "/data/backups/codex-gateway"
DEFAULT_AZURE_BACKUP_ROOT = "/home/qian/codex-gateway-backups/r760-authority-mirror"


class SyncError(RuntimeError):
    pass


@dataclass(frozen=True)
class RemoteGateway:
    name: str
    host: str
    user: str
    ssh_key: str
    container: str
    port: int = 22
    use_sudo: bool = False


def default_azure_gateway() -> RemoteGateway:
    return RemoteGateway(
        name="azure",
        host="4.242.58.89",
        user="qian",
        ssh_key=r"~\.ssh\medevidence_azure_wus2_ed25519",
        container="codex_gateway_test-gateway-1",
        use_sudo=True,
    )


def default_r760_gateway() -> RemoteGateway:
    return RemoteGateway(
        name="r760",
        host="117.186.49.26",
        user="root",
        ssh_key=r"~\.ssh\id_ed25519",
        container="codex_gateway_r760-gateway-1",
        port=7723,
    )


def shell_word(value: str) -> str:
    return "'" + value.replace("'", "'\"'\"'") + "'"


def expanded_path(value: str) -> Path:
    return Path(value.replace("~", str(Path.home()), 1))


def docker_command(endpoint: RemoteGateway) -> str:
    return "sudo docker" if endpoint.use_sudo else "docker"


def ssh_command(endpoint: RemoteGateway) -> list[str]:
    key = expanded_path(endpoint.ssh_key)
    if not key.exists():
        raise SyncError(f"SSH key was not found for {endpoint.name}: {key}")
    command = [
        "ssh",
        "-i",
        str(key),
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=8",
        "-o",
        "StrictHostKeyChecking=accept-new",
        "-o",
        "IdentitiesOnly=yes",
    ]
    if endpoint.port != 22:
        command.extend(["-p", str(endpoint.port)])
    command.append(f"{endpoint.user}@{endpoint.host}")
    return command


def run_ssh(
    endpoint: RemoteGateway,
    remote_command: str,
    *,
    stdin: str | None = None,
    timeout_seconds: int = 120,
) -> subprocess.CompletedProcess[str]:
    try:
        completed = subprocess.run(
            [*ssh_command(endpoint), remote_command],
            input=stdin,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout_seconds,
        )
    except subprocess.TimeoutExpired as exc:
        raise SyncError(f"{endpoint.name} SSH operation timed out.") from exc
    except OSError as exc:
        raise SyncError(f"Could not start SSH for {endpoint.name}: {exc}") from exc
    if completed.returncode != 0:
        safe_error = redact_secrets(completed.stderr.strip())[:1000]
        raise SyncError(
            f"{endpoint.name} remote operation failed with exit {completed.returncode}"
            + (f": {safe_error}" if safe_error else ".")
        )
    return completed


def install_helper(
    endpoint: RemoteGateway,
    helper_path: Path = DEFAULT_HELPER_LOCAL_PATH,
    *,
    container_path: str = DEFAULT_HELPER_CONTAINER_PATH,
) -> None:
    if not helper_path.is_file():
        raise SyncError(f"Control-state helper was not found: {helper_path}")
    helper = helper_path.read_text(encoding="utf-8")
    remote = (
        f"{docker_command(endpoint)} exec -i {shell_word(endpoint.container)} "
        f"sh -c {shell_word(f'umask 077; cat > {container_path}')}"
    )
    run_ssh(endpoint, remote, stdin=helper)


def remove_helper_best_effort(
    endpoint: RemoteGateway,
    *,
    container_path: str = DEFAULT_HELPER_CONTAINER_PATH,
) -> None:
    remote = (
        f"{docker_command(endpoint)} exec {shell_word(endpoint.container)} "
        f"rm -f {shell_word(container_path)}"
    )
    try:
        run_ssh(endpoint, remote, timeout_seconds=30)
    except Exception:
        pass


def run_helper_json(
    endpoint: RemoteGateway,
    command: str,
    *,
    payload: dict[str, Any] | None = None,
    extra_args: list[str] | None = None,
    helper_container_path: str = DEFAULT_HELPER_CONTAINER_PATH,
    timeout_seconds: int = 180,
) -> dict[str, Any]:
    if command not in {"inspect", "export", "plan", "apply", "backup"}:
        raise SyncError("Unsupported remote helper command.")
    arguments = [command, "--db", DEFAULT_DB_PATH, *(extra_args or [])]
    remote = (
        f"{docker_command(endpoint)} exec -i {shell_word(endpoint.container)} "
        f"node {shell_word(helper_container_path)} "
        + " ".join(shell_word(value) for value in arguments)
    )
    stdin = json.dumps(payload, ensure_ascii=False, separators=(",", ":")) if payload is not None else None
    completed = run_ssh(endpoint, remote, stdin=stdin, timeout_seconds=timeout_seconds)
    try:
        result = json.loads(completed.stdout)
    except json.JSONDecodeError as exc:
        raise SyncError(f"{endpoint.name} helper returned invalid JSON.") from exc
    if not isinstance(result, dict):
        raise SyncError(f"{endpoint.name} helper returned an invalid result.")
    return result


def verify_inspections(source: dict[str, Any], target: dict[str, Any]) -> None:
    if source.get("format") != target.get("format"):
        raise SyncError("Source and target control-state formats differ.")
    if source.get("migration") != target.get("migration"):
        raise SyncError("Source and target Gateway schema versions differ.")
    source_digest = source.get("encryption_secret_sha256")
    target_digest = target.get("encryption_secret_sha256")
    if not source_digest or not target_digest:
        raise SyncError("Gateway API-key encryption secret is missing on one or both nodes.")
    if source_digest != target_digest:
        raise SyncError("Gateway API-key encryption secrets do not match; sync is blocked.")
    for inspection in (source, target):
        integrity = inspection.get("integrity") or {}
        if integrity.get("quick_check") != "ok" or integrity.get("foreign_key_violations") != 0:
            raise SyncError("Source or target SQLite integrity check failed.")


def create_target_backup(
    endpoint: RemoteGateway,
    *,
    backup_root: str,
    backup_label: str,
    stamp: str | None = None,
    helper_container_path: str = DEFAULT_HELPER_CONTAINER_PATH,
) -> dict[str, Any]:
    stamp = stamp or datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    if not re.fullmatch(r"\d{8}T\d{6}Z", stamp):
        raise SyncError("Invalid backup timestamp.")
    if not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,31}", backup_label):
        raise SyncError("Invalid target backup label.")
    basename = (
        f"{backup_label}-pre-control-state-sync-{stamp}-{secrets.token_hex(4)}.db"
    )
    container_path = f"/var/lib/codex-gateway/.{basename}"
    host_path = f"{backup_root.rstrip('/')}/{basename}"
    backup = run_helper_json(
        endpoint,
        "backup",
        extra_args=["--output", container_path],
        helper_container_path=helper_container_path,
        timeout_seconds=300,
    )
    expected_sha256 = str(backup.get("sha256") or "")
    if not re.fullmatch(r"[a-f0-9]{64}", expected_sha256):
        raise SyncError("Target backup helper did not return a valid SHA-256 digest.")

    privilege = "sudo " if endpoint.use_sudo else ""
    remote = " && ".join(
        [
            f"{privilege}install -d -m 0700 {shell_word(backup_root.rstrip('/'))}",
            f"{privilege}test ! -e {shell_word(host_path)}",
            f"{docker_command(endpoint)} cp "
            f"{shell_word(endpoint.container + ':' + container_path)} {shell_word(host_path)}",
            f"{privilege}chmod 0400 {shell_word(host_path)}",
            f"{privilege}sha256sum {shell_word(host_path)}",
        ]
    )
    completed = run_ssh(endpoint, remote, timeout_seconds=300)
    actual_sha256 = completed.stdout.strip().split(maxsplit=1)[0] if completed.stdout.strip() else ""
    if actual_sha256 != expected_sha256:
        raise SyncError("Target host backup SHA-256 does not match the verified SQLite snapshot.")

    cleanup = (
        f"{docker_command(endpoint)} exec {shell_word(endpoint.container)} "
        f"rm -f {shell_word(container_path)}"
    )
    run_ssh(endpoint, cleanup, timeout_seconds=30)
    return {
        "backup_id": basename,
        "backup_path": host_path,
        "size_bytes": backup.get("size_bytes"),
        "sha256": expected_sha256,
        "integrity": backup.get("integrity"),
    }


def create_r760_backup(
    endpoint: RemoteGateway,
    *,
    backup_root: str = DEFAULT_R760_BACKUP_ROOT,
    stamp: str | None = None,
    helper_container_path: str = DEFAULT_HELPER_CONTAINER_PATH,
) -> dict[str, Any]:
    """Backward-compatible R760 backup helper."""
    return create_target_backup(
        endpoint,
        backup_root=backup_root,
        backup_label="r760",
        stamp=stamp,
        helper_container_path=helper_container_path,
    )


def sync_gateway_control_state(
    *,
    apply: bool,
    source: RemoteGateway,
    target: RemoteGateway,
    target_backup_root: str,
    source_name: str | None = None,
    target_name: str | None = None,
    max_passes: int = 3,
) -> dict[str, Any]:
    if max_passes < 1 or max_passes > 5:
        raise SyncError("max_passes must be between 1 and 5.")
    source_name = source_name or source.name
    target_name = target_name or target.name
    for value, label in ((source_name, "source"), (target_name, "target")):
        if not re.fullmatch(r"[a-z0-9][a-z0-9._-]{0,31}", value):
            raise SyncError(f"Invalid {label} name.")
    helper_container_path = (
        f"/tmp/gateway-control-state-transfer-{secrets.token_hex(6)}.cjs"
    )
    installed: list[RemoteGateway] = []
    try:
        for endpoint in (source, target):
            install_helper(endpoint, container_path=helper_container_path)
            installed.append(endpoint)

        source_inspection = run_helper_json(
            source, "inspect", helper_container_path=helper_container_path
        )
        target_inspection = run_helper_json(
            target, "inspect", helper_container_path=helper_container_path
        )
        verify_inspections(source_inspection, target_inspection)

        payload = run_helper_json(
            source, "export", helper_container_path=helper_container_path, timeout_seconds=300
        )
        plan = run_helper_json(
            target,
            "plan",
            payload=payload,
            helper_container_path=helper_container_path,
            timeout_seconds=300,
        )
        result: dict[str, Any] = {
            "mode": "apply" if apply else "dry-run",
            "source": source_name,
            "target": target_name,
            "preflight": "ok",
            "schema_version": source_inspection.get("migration"),
            "encryption_secret_match": True,
            "initial_plan": plan,
            "converged": plan.get("changed_rows") == 0,
            "passes": 0,
            "backup": None,
        }
        if not apply or plan.get("changed_rows") == 0:
            return result

        backup = create_target_backup(
            target,
            backup_root=target_backup_root,
            backup_label=target_name,
            helper_container_path=helper_container_path,
        )
        result["backup"] = backup
        backup_id = str(backup["backup_id"])

        for pass_number in range(1, max_passes + 1):
            applied = run_helper_json(
                target,
                "apply",
                payload=payload,
                extra_args=[
                    "--backup-id",
                    backup_id,
                    "--source-name",
                    source_name,
                    "--target-name",
                    target_name,
                ],
                helper_container_path=helper_container_path,
                timeout_seconds=300,
            )
            result["passes"] = pass_number
            result["last_apply"] = applied

            fresh_payload = run_helper_json(
                source,
                "export",
                helper_container_path=helper_container_path,
                timeout_seconds=300,
            )
            final_plan = run_helper_json(
                target,
                "plan",
                payload=fresh_payload,
                helper_container_path=helper_container_path,
                timeout_seconds=300,
            )
            result["final_plan"] = final_plan
            if final_plan.get("changed_rows") == 0:
                result["converged"] = True
                return result
            payload = fresh_payload

        raise SyncError(
            f"{source_name} control state kept changing and did not converge on "
            f"{target_name} within the allowed passes."
        )
    finally:
        for endpoint in reversed(installed):
            remove_helper_best_effort(endpoint, container_path=helper_container_path)


def sync_azure_to_r760(
    *,
    apply: bool,
    azure: RemoteGateway | None = None,
    r760: RemoteGateway | None = None,
    backup_root: str = DEFAULT_R760_BACKUP_ROOT,
    max_passes: int = 3,
) -> dict[str, Any]:
    return sync_gateway_control_state(
        apply=apply,
        source=azure or default_azure_gateway(),
        target=r760 or default_r760_gateway(),
        target_backup_root=backup_root,
        source_name="azure",
        target_name="r760",
        max_passes=max_passes,
    )


def sync_r760_to_azure(
    *,
    apply: bool,
    r760: RemoteGateway | None = None,
    azure: RemoteGateway | None = None,
    backup_root: str = DEFAULT_AZURE_BACKUP_ROOT,
    max_passes: int = 3,
) -> dict[str, Any]:
    return sync_gateway_control_state(
        apply=apply,
        source=r760 or default_r760_gateway(),
        target=azure or default_azure_gateway(),
        target_backup_root=backup_root,
        source_name="r760",
        target_name="azure",
        max_passes=max_passes,
    )


def _http_json(
    method: str,
    url: str,
    bearer: str,
    *,
    body: dict[str, Any] | None = None,
    timeout_seconds: int = 45,
) -> dict[str, Any]:
    data = None
    headers = {"Authorization": f"Bearer {bearer}"}
    if method.upper() == "POST":
        headers["Content-Type"] = "application/json; charset=utf-8"
        data = json.dumps(body or {}).encode("utf-8")
    request = Request(url, data=data, headers=headers, method=method.upper())
    try:
        with urlopen(request, timeout=timeout_seconds) as response:
            parsed = json.loads(response.read().decode("utf-8"))
    except HTTPError as exc:
        raise SyncError(f"Gateway validation returned HTTP {exc.code}.") from exc
    except URLError as exc:
        raise SyncError("Gateway validation endpoint was unreachable.") from exc
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise SyncError("Gateway validation returned invalid JSON.") from exc
    if not isinstance(parsed, dict):
        raise SyncError("Gateway validation returned an invalid response.")
    return parsed


def _nested(value: Any, *keys: str) -> Any:
    current = value
    for key in keys:
        if not isinstance(current, dict):
            return None
        current = current.get(key)
    return current


def _validate_endpoint(
    base_url: str,
    opaque_key: str,
    *,
    expected_subject_id: str | None,
    require_image_capability: bool,
    timeout_seconds: int,
) -> dict[str, Any]:
    base_url = base_url.rstrip("/")
    resolved = _http_json(
        "POST",
        f"{base_url}/gateway/unified-keys/resolve",
        opaque_key,
        body={},
        timeout_seconds=timeout_seconds,
    )
    subject_id = str(_nested(resolved, "subject", "id") or "")
    codex_key = str(_nested(resolved, "codex_gateway", "api_key") or "")
    medevidence_key = str(_nested(resolved, "medevidence", "api_key") or "")
    if not resolved.get("valid") or not subject_id or not codex_key.startswith("cgw."):
        raise SyncError("Unified key resolve validation failed.")
    if expected_subject_id and subject_id != expected_subject_id:
        raise SyncError("Unified key resolved to an unexpected subject.")
    if not medevidence_key:
        raise SyncError("Unified key resolve did not return a MedEvidence runtime key.")
    if _nested(resolved, "codex_gateway", "endpoint_base_url") != f"{base_url}/v1":
        raise SyncError("Unified key resolve returned an unexpected Gateway endpoint.")
    if _nested(resolved, "codex_gateway", "credential_validation_url") != (
        f"{base_url}/gateway/credentials/current"
    ):
        raise SyncError("Unified key resolve returned an unexpected credential validation URL.")

    current = _http_json(
        "GET",
        f"{base_url}/gateway/credentials/current",
        codex_key,
        timeout_seconds=timeout_seconds,
    )
    capabilities = list(_nested(current, "entitlement", "feature_policy", "capabilities") or [])
    if not current.get("valid") or _nested(current, "subject", "id") != subject_id:
        raise SyncError("Backing Gateway credential validation failed.")
    if _nested(current, "entitlement", "state") != "active":
        raise SyncError("Backing Gateway credential does not have an active entitlement.")
    if require_image_capability and "image_generation" not in capabilities:
        raise SyncError("Backing Gateway credential is missing image_generation capability.")
    return {
        "subject_id": subject_id,
        "unified_prefix": _nested(resolved, "unified_key", "prefix"),
        "codex_prefix": _nested(resolved, "codex_gateway", "key_prefix"),
        "medevidence_prefix": _nested(resolved, "medevidence", "key_prefix"),
        "codex_key": codex_key,
        "medevidence_key": medevidence_key,
        "capabilities": capabilities,
    }


def validate_unified_key_pair(
    opaque_key: str,
    *,
    expected_subject_id: str | None = None,
    azure_base_url: str = DEFAULT_AZURE_BASE_URL,
    r760_base_url: str = DEFAULT_R760_BASE_URL,
    require_image_capability: bool = True,
    timeout_seconds: int = 45,
) -> dict[str, Any]:
    if not opaque_key.startswith("cgu_live_"):
        raise SyncError("Validation input is not a cgu_live key.")
    azure = _validate_endpoint(
        azure_base_url,
        opaque_key,
        expected_subject_id=expected_subject_id,
        require_image_capability=require_image_capability,
        timeout_seconds=timeout_seconds,
    )
    r760 = _validate_endpoint(
        r760_base_url,
        opaque_key,
        expected_subject_id=expected_subject_id,
        require_image_capability=require_image_capability,
        timeout_seconds=timeout_seconds,
    )
    comparable = ["subject_id", "unified_prefix", "codex_prefix", "medevidence_prefix", "codex_key", "medevidence_key"]
    if any(azure[field] != r760[field] for field in comparable):
        raise SyncError("Azure and R760 resolved identities or runtime credentials differ.")
    return {
        "azure": "ok",
        "r760": "ok",
        "subject_match": True,
        "runtime_credentials_match": True,
        "active_entitlement": True,
        "image_generation": "image_generation" in azure["capabilities"],
    }


def load_opaque_key_file(path: Path) -> tuple[str, str | None]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise SyncError("Could not read a valid key handoff JSON.") from exc
    if not isinstance(value, dict):
        raise SyncError("Key handoff JSON must be an object.")
    key = str(value.get("key") or "")
    if not key.startswith("cgu_live_"):
        raise SyncError("Key handoff JSON does not contain a cgu_live key.")
    subject_id = str(value.get("subject_id") or "") or None
    return key, subject_id
