#!/usr/bin/env python3
"""
Issue a real-user cgu_live key through the Gateway-owned billing/v2 path.

The script prints only safe prefixes and writes the full cgu_live key to the
local handoff JSON. It never writes resolved backing Gateway or MedEvidence
runtime keys to disk.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import re
import stat
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from codex_gateway_ops_common import DEFAULT_REMOTE_REPO, redact_secrets


DEFAULT_GATEWAY_BASE_URL = "https://gw.instmarket.com.au"
DEFAULT_PROVIDER = "manual_trial"
DEFAULT_PLAN_ID = "plan_internal_high_quota_image_v1"
MIN_REAL_USER_VALIDITY_DAYS = 90
DEFAULT_REAL_USER_VALIDITY_DAYS = 92
DEFAULT_OUTPUT_DIR = r"C:\Users\rdpuser\medevidence_api_keys"

DEFAULT_VM_HOST = "4.242.58.89"
DEFAULT_VM_USER = "qian"
DEFAULT_SSH_KEY = r"~\.ssh\medevidence_azure_wus2_ed25519"
DEFAULT_COMPOSE_PROJECT = "codex_gateway_test"
DEFAULT_COMPOSE_FILE = "compose.azure.yml"
DEFAULT_GATEWAY_SERVICE = "gateway"
GATEWAY_DB_PATH = "/var/lib/codex-gateway/gateway.db"

class IssueError(RuntimeError):
    pass


def main() -> int:
    configure_stdio()
    args = parse_args()
    try:
        result = issue_key(args)
    except Exception as exc:
        print(redact_secrets(f"error: {exc}"), file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


def configure_stdio() -> None:
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if callable(reconfigure):
            reconfigure(encoding="utf-8", errors="replace")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Issue a real-user cgu_live key and write a local handoff JSON."
    )
    parser.add_argument("--name", required=True, help="Real user display name.")
    parser.add_argument("--phone", required=True, help="User phone number.")
    parser.add_argument(
        "--external-user-id",
        help="Stable ASCII external user id. Defaults to phone_<digits>.",
    )
    parser.add_argument("--provider", default=DEFAULT_PROVIDER)
    parser.add_argument("--gateway-base-url", default=DEFAULT_GATEWAY_BASE_URL)
    parser.add_argument(
        "--plan-id",
        default=DEFAULT_PLAN_ID,
        help="Default includes image_generation: plan_internal_high_quota_image_v1.",
    )
    parser.add_argument("--scope", default="code", choices=["code", "medical"])
    parser.add_argument(
        "--entitlement-end",
        help="Entitlement end ISO timestamp. Defaults to now + 92 days; values under 90 days are rejected.",
    )
    parser.add_argument(
        "--key-expires-at",
        help="Backing Gateway key expiration ISO timestamp. Defaults to now + 92 days; values under 90 days are rejected.",
    )
    parser.add_argument("--rpm", type=positive_int, default=10)
    parser.add_argument("--rpd", type=positive_int, default=200)
    parser.add_argument("--concurrent", type=positive_int, default=4)
    parser.add_argument("--output-dir", default=DEFAULT_OUTPUT_DIR)
    parser.add_argument(
        "--billing-admin-token-env",
        default="GATEWAY_BILLING_ADMIN_TOKEN",
        help="Environment variable containing the Billing Admin token.",
    )
    parser.add_argument("--vm-host", default=DEFAULT_VM_HOST)
    parser.add_argument("--vm-user", default=DEFAULT_VM_USER)
    parser.add_argument("--ssh-key", default=DEFAULT_SSH_KEY)
    parser.add_argument("--remote-repo", default=DEFAULT_REMOTE_REPO)
    parser.add_argument("--compose-project", default=DEFAULT_COMPOSE_PROJECT)
    parser.add_argument("--compose-file", default=DEFAULT_COMPOSE_FILE)
    parser.add_argument("--gateway-service", default=DEFAULT_GATEWAY_SERVICE)
    parser.add_argument("--timeout-seconds", type=positive_int, default=45)
    parser.add_argument("--skip-credential-validation", action="store_true")
    parser.add_argument(
        "--no-require-image-capability",
        action="store_true",
        help="Allow issuing with a non-image plan. The default requires image_generation.",
    )
    parser.add_argument(
        "--disable-on-failure",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Disable a newly created partial subject if a later step fails.",
    )
    parser.add_argument("--what-if", action="store_true", help="Print planned safe settings only.")
    return parser.parse_args()


def positive_int(value: str) -> int:
    parsed = int(value)
    if parsed < 1:
        raise argparse.ArgumentTypeError("value must be positive")
    return parsed


def issue_key(args: argparse.Namespace) -> dict[str, Any]:
    base_url = normalize_base_url(args.gateway_base_url)
    external_user_id = args.external_user_id or default_external_user_id(args.phone)
    validate_external_user_id(external_user_id)
    resolve_expiration_defaults(args)
    validate_iso_utc(args.entitlement_end, "entitlement-end")
    validate_iso_utc(args.key_expires_at, "key-expires-at")
    validate_minimum_expiration(args.entitlement_end, "entitlement-end")
    validate_minimum_expiration(args.key_expires_at, "key-expires-at")
    stamp = utc_stamp()
    safe_user_slug = safe_slug(external_user_id)
    handoff_path = str(Path(args.output_dir) / f"real_user_cgu_{stamp}_{safe_user_slug}.json")

    if args.what_if:
        return {
            "what_if": True,
            "provider": args.provider,
            "external_user_id": external_user_id,
            "display_name": args.name,
            "phone": args.phone,
            "gateway_base_url": base_url,
            "plan_id": args.plan_id,
            "requires_image_generation": not args.no_require_image_capability,
            "entitlement_end": iso_millis_z(parse_iso_utc(args.entitlement_end)),
            "key_expires_at": iso_millis_z(parse_iso_utc(args.key_expires_at)),
            "rate": {
                "requestsPerMinute": args.rpm,
                "requestsPerDay": args.rpd,
                "concurrentRequests": args.concurrent,
            },
            "handoff_path": handoff_path,
        }

    subject_id: str | None = None
    created_subject_this_run = False
    completed = False
    billing_token = get_billing_admin_token(args)

    try:
        create = create_subject(args, base_url, billing_token, external_user_id, stamp)
        if create.get("idempotent_replay") is True and not get_path(create, "credential", "key"):
            raise IssueError(
                "Billing subject create was an idempotent replay. The cgu_live key is only "
                "returned once; use a new --external-user-id or rotate the existing subject key."
            )

        opaque_key = str(get_path(create, "credential", "key") or "")
        if not opaque_key.startswith("cgu_live_"):
            raise IssueError("Billing subject create did not return a cgu_live key.")

        subject_id = str(get_path(create, "subject", "id") or "")
        if not subject_id:
            raise IssueError("Billing subject create did not return a subject id.")
        created_subject_this_run = bool(create.get("created") is True and create.get("idempotent_replay") is not True)

        entitlement = grant_entitlement(args, base_url, billing_token, subject_id, external_user_id, stamp)
        entitlement_record = entitlement.get("entitlement") or {}
        if not entitlement.get("applied") or entitlement_record.get("state") != "active":
            raise IssueError("Entitlement grant did not become active.")

        resolved = resolve_opaque_key(args, base_url, opaque_key)
        if not resolved.get("valid") or get_path(resolved, "subject", "id") != subject_id:
            raise IssueError("Opaque key resolve validation failed.")

        codex_api_key = str(get_path(resolved, "codex_gateway", "api_key") or "")
        gateway_prefix = str(get_path(resolved, "codex_gateway", "key_prefix") or "")
        medevidence_prefix = get_path(resolved, "medevidence", "key_prefix")
        if not codex_api_key or not gateway_prefix:
            raise IssueError("Opaque key resolve response did not include the backing Gateway key.")

        label = f"medevidence-unified-{datetime.now(timezone.utc).strftime('%Y%m%d')}-{safe_user_slug[:32]}"
        update_user(args, subject_id)
        update_key(args, gateway_prefix, label)

        current = None
        capabilities: list[str] = []
        if not args.skip_credential_validation:
            current = current_credential(args, base_url, codex_api_key)
            if not current.get("valid") or get_path(current, "subject", "id") != subject_id:
                raise IssueError("Gateway credential validation failed.")
            if get_path(current, "entitlement", "state") != "active":
                raise IssueError("Gateway credential validation did not return an active entitlement.")
            capabilities = list(get_path(current, "entitlement", "feature_policy", "capabilities") or [])
            if not args.no_require_image_capability and "image_generation" not in capabilities:
                raise IssueError("Issued credential does not include image_generation capability.")

        write_handoff(
            args=args,
            path=Path(handoff_path),
            base_url=base_url,
            opaque_key=opaque_key,
            create=create,
            entitlement=entitlement_record,
            resolved=resolved,
            current=current,
            subject_id=subject_id,
            external_user_id=external_user_id,
            capabilities=capabilities,
        )
        completed = True
        return {
            "issued": "ok",
            "key_type": "cgu_live",
            "subject_id": subject_id,
            "key_prefix": get_path(create, "credential", "key_prefix"),
            "codex_gateway_prefix": gateway_prefix,
            "medevidence_prefix": medevidence_prefix,
            "plan_id": entitlement_record.get("plan_id"),
            "entitlement_state": entitlement_record.get("state"),
            "capabilities": capabilities,
            "image_generation": "image_generation" in capabilities,
            "rate": {
                "requestsPerMinute": args.rpm,
                "requestsPerDay": args.rpd,
                "concurrentRequests": args.concurrent,
            },
            "backing_key_expires_at": args.key_expires_at,
            "resolve_validation": "ok",
            "credential_validation": "skipped" if args.skip_credential_validation else "ok",
            "handoff_path": handoff_path,
        }
    finally:
        if (
            not completed
            and args.disable_on_failure
            and subject_id
            and created_subject_this_run
        ):
            disable_subject_best_effort(args, base_url, billing_token, subject_id)


def create_subject(
    args: argparse.Namespace,
    base_url: str,
    billing_token: str,
    external_user_id: str,
    stamp: str,
) -> dict[str, Any]:
    body = {
        "provider": args.provider,
        "external_user_id": external_user_id,
        "display_name": args.name,
        "scope_allowlist": [args.scope],
        "metadata": {
            "purpose": "real_user_manual_trial",
            "issued_by": "issue-real-user-cgu-key.py",
            "created_at": now_iso(),
        },
    }
    return http_json(
        "POST",
        f"{base_url}/gateway/admin/billing/v1/subjects",
        bearer_headers(billing_token, f"{args.provider}:{external_user_id}:create_subject"),
        body,
        args.timeout_seconds,
    )


def grant_entitlement(
    args: argparse.Namespace,
    base_url: str,
    billing_token: str,
    subject_id: str,
    external_user_id: str,
    stamp: str,
) -> dict[str, Any]:
    body = {
        "event_type": "purchase",
        "apply_mode": "apply",
        "provider": args.provider,
        "external_order_id": f"manual_trial_{stamp}",
        "external_event_id": f"evt_{stamp}",
        "subject_id": subject_id,
        "plan_id": args.plan_id,
        "period_kind": "one_off",
        "period_start": now_iso_minus_seconds(60),
        "period_end": iso_millis_z(parse_iso_utc(args.entitlement_end)),
        "replace_current": True,
        "amount_minor": 0,
        "currency": "USD",
        "metadata": {
            "purpose": "real_user_manual_trial",
            "note": "No-charge internal real-user trial entitlement",
        },
    }
    return http_json(
        "POST",
        f"{base_url}/gateway/admin/billing/v1/entitlement-events",
        bearer_headers(billing_token, f"{args.provider}:{external_user_id}:purchase:{stamp}"),
        body,
        args.timeout_seconds,
    )


def resolve_opaque_key(args: argparse.Namespace, base_url: str, opaque_key: str) -> dict[str, Any]:
    return http_json(
        "POST",
        f"{base_url}/gateway/unified-keys/resolve",
        {"Authorization": f"Bearer {opaque_key}", "Content-Type": "application/json"},
        {},
        args.timeout_seconds,
    )


def current_credential(args: argparse.Namespace, base_url: str, codex_api_key: str) -> dict[str, Any]:
    return http_json(
        "GET",
        f"{base_url}/gateway/credentials/current",
        {"Authorization": f"Bearer {codex_api_key}"},
        None,
        args.timeout_seconds,
    )


def update_user(args: argparse.Namespace, subject_id: str) -> dict[str, Any]:
    return run_remote_admin(
        args,
        [
            "update-user",
            subject_id,
            "--label",
            args.name,
            "--name",
            args.name,
            "--phone",
            args.phone,
        ],
    )


def update_key(args: argparse.Namespace, gateway_prefix: str, label: str) -> dict[str, Any]:
    return run_remote_admin(
        args,
        [
            "update-key",
            gateway_prefix,
            "--label",
            label,
            "--rpm",
            str(args.rpm),
            "--rpd",
            str(args.rpd),
            "--concurrent",
            str(args.concurrent),
            "--expires-at",
            iso_millis_z(parse_iso_utc(args.key_expires_at)),
        ],
    )


def disable_subject_best_effort(
    args: argparse.Namespace,
    base_url: str,
    billing_token: str,
    subject_id: str,
) -> None:
    try:
        http_json(
            "POST",
            f"{base_url}/gateway/admin/billing/v1/subjects/{subject_id}/disable",
            bearer_headers(billing_token, f"{args.provider}:{subject_id}:disable_subject:issue_failed_cleanup"),
            {"reason": "issue_real_user_cgu_key_failed_cleanup"},
            args.timeout_seconds,
        )
        print(f"warning: disabled partial subject {subject_id} after issue failure", file=sys.stderr)
    except Exception as exc:
        print(redact_secrets(f"warning: cleanup disable failed for {subject_id}: {exc}"), file=sys.stderr)


def write_handoff(
    *,
    args: argparse.Namespace,
    path: Path,
    base_url: str,
    opaque_key: str,
    create: dict[str, Any],
    entitlement: dict[str, Any],
    resolved: dict[str, Any],
    current: dict[str, Any] | None,
    subject_id: str,
    external_user_id: str,
    capabilities: list[str],
) -> None:
    current_credential_record = current.get("credential") if current else None
    handoff = {
        "key_type": "opaque_unified_cgu_live",
        "key": opaque_key,
        "key_prefix": get_path(create, "credential", "key_prefix"),
        "subject_id": subject_id,
        "provider": args.provider,
        "external_user_id": external_user_id,
        "display_name": args.name,
        "phone": args.phone,
        "base_url": base_url,
        "openai_compatible_base_url": f"{base_url}/v1",
        "resolve_url": f"{base_url}/gateway/unified-keys/resolve",
        "credential_validation_url": f"{base_url}/gateway/credentials/current",
        "plan_id": entitlement.get("plan_id"),
        "entitlement_id": entitlement.get("id"),
        "entitlement_period_start": entitlement.get("period_start"),
        "entitlement_period_end": entitlement.get("period_end"),
        "capabilities": capabilities,
        "image_generation": "image_generation" in capabilities,
        "codex_gateway_key_prefix": get_path(resolved, "codex_gateway", "key_prefix"),
        "medevidence_key_prefix": get_path(resolved, "medevidence", "key_prefix"),
        "issued_at": get_path(create, "credential", "issued_at"),
        "expires_at": get_path(create, "credential", "expires_at"),
        "backing_gateway_expires_at": args.key_expires_at,
        "backing_gateway_rate": {
            "requestsPerMinute": args.rpm,
            "requestsPerDay": args.rpd,
            "concurrentRequests": args.concurrent,
        },
        "credential": public_credential_subset(current_credential_record),
        "notes": [
            "Give Desktop this cgu_live key, not the underlying cgw or MedEvidence v2 keys.",
            "Desktop should call /gateway/unified-keys/resolve and then use returned runtime credentials.",
            "For image generation, call /gateway/images/generations with model medcode-image-default.",
        ],
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(handoff, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tighten_file_permissions(path)


def public_credential_subset(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None
    return {
        "id": value.get("id"),
        "prefix": value.get("prefix"),
        "scope": value.get("scope"),
        "expires_at": value.get("expires_at"),
        "status": value.get("status"),
        "rate": value.get("rate"),
    }


def http_json(
    method: str,
    url: str,
    headers: dict[str, str],
    body: dict[str, Any] | None,
    timeout_seconds: int,
) -> dict[str, Any]:
    data = None
    request_headers = dict(headers)
    if method.upper() == "POST":
        request_headers.setdefault("Content-Type", "application/json; charset=utf-8")
        data = json.dumps(body or {}, ensure_ascii=False).encode("utf-8")
    request = Request(url, data=data, headers=request_headers, method=method.upper())
    try:
        with urlopen(request, timeout=timeout_seconds) as response:
            response_body = response.read().decode("utf-8")
            return json.loads(response_body) if response_body else {}
    except HTTPError as exc:
        message = f"HTTP {exc.code} {url}"
        try:
            error_body = exc.read().decode("utf-8")
            if error_body:
                parsed = json.loads(error_body)
                error = parsed.get("error") if isinstance(parsed, dict) else None
                if isinstance(error, dict):
                    message += f" code={error.get('code')} message={error.get('message')}"
                else:
                    message += f" body={error_body[:500]}"
        except Exception:
            pass
        raise IssueError(redact_secrets(message)) from exc
    except URLError as exc:
        raise IssueError(redact_secrets(f"request failed for {url}: {exc}")) from exc


def bearer_headers(token: str, idempotency_key: str | None = None) -> dict[str, str]:
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    if idempotency_key:
        headers["Idempotency-Key"] = idempotency_key
    return headers


def get_billing_admin_token(args: argparse.Namespace) -> str:
    env_value = os.environ.get(args.billing_admin_token_env)
    if env_value and env_value.strip():
        return env_value.strip()

    ssh_key = expanded_ssh_key(args.ssh_key)
    if not ssh_key.exists():
        raise IssueError(
            f"{args.billing_admin_token_env} is not set and SSH key was not found: {ssh_key}"
        )
    remote_command = (
        f"cd {shell_word(args.remote_repo)} && "
        f"sudo docker compose -p {shell_word(args.compose_project)} "
        f"-f {shell_word(args.compose_file)} exec -T {shell_word(args.gateway_service)} "
        "printenv GATEWAY_BILLING_ADMIN_TOKEN"
    )
    completed = run_ssh(args, remote_command)
    token = completed.stdout.strip()
    if not token:
        raise IssueError("GATEWAY_BILLING_ADMIN_TOKEN is empty in the live Gateway container.")
    if len(token) < 24:
        raise IssueError("Billing admin token must be at least 24 characters.")
    return token


def run_remote_admin(args: argparse.Namespace, admin_args: list[str]) -> dict[str, Any]:
    payload = base64.urlsafe_b64encode(json.dumps(admin_args, ensure_ascii=False).encode("utf-8")).decode(
        "ascii"
    )
    node_script = (
        'const {spawnSync}=require("node:child_process");'
        'const b=process.env.ADMIN_ARGS_B64||"";'
        'const args=JSON.parse(Buffer.from(b.replace(/-/g,"+").replace(/_/g,"/"),"base64").toString("utf8"));'
        f'const r=spawnSync("node",["apps/admin-cli/dist/index.js","--db","{GATEWAY_DB_PATH}",...args],'
        '{encoding:"utf8"});'
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
        return json.loads(stdout) if stdout else {}
    except json.JSONDecodeError as exc:
        raise IssueError(redact_secrets(f"admin CLI returned non-JSON output: {stdout[:1000]}")) from exc


def run_ssh(args: argparse.Namespace, remote_command: str) -> subprocess.CompletedProcess[str]:
    command = [
        "ssh",
        "-i",
        str(expanded_ssh_key(args.ssh_key)),
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
        raise IssueError(
            redact_secrets(
                "remote command failed: "
                f"exit={completed.returncode} stderr={completed.stderr.strip()[:1000]}"
            )
        )
    return completed


def normalize_base_url(value: str) -> str:
    normalized = value.rstrip("/")
    if not re.match(r"^https?://", normalized):
        raise IssueError("gateway-base-url must start with http:// or https://.")
    return normalized


def default_external_user_id(phone: str) -> str:
    digits = re.sub(r"\D+", "", phone)
    if not digits:
        raise IssueError("phone must contain at least one digit when --external-user-id is omitted.")
    return f"phone_{digits}"


def validate_external_user_id(value: str) -> None:
    if not re.match(r"^[A-Za-z0-9._-]{1,128}$", value):
        raise IssueError("external-user-id must match [A-Za-z0-9._-]{1,128}.")


def resolve_expiration_defaults(args: argparse.Namespace) -> None:
    now = datetime.now(timezone.utc)
    default_expiration = now + timedelta(days=DEFAULT_REAL_USER_VALIDITY_DAYS)
    if not args.entitlement_end:
        args.entitlement_end = iso_millis_z(default_expiration)
    if not args.key_expires_at:
        args.key_expires_at = iso_millis_z(default_expiration)


def validate_minimum_expiration(value: str, name: str) -> None:
    parsed = parse_iso_utc(value)
    minimum = datetime.now(timezone.utc) + timedelta(days=MIN_REAL_USER_VALIDITY_DAYS)
    if parsed < minimum:
        raise IssueError(
            f"{name} must be at least {MIN_REAL_USER_VALIDITY_DAYS} days in the future "
            f"(minimum {iso_millis_z(minimum)})."
        )


def safe_slug(value: str) -> str:
    slug = re.sub(r"[^A-Za-z0-9._-]+", "-", value).strip("-._")
    return slug[:48] or "user"


def parse_iso_utc(value: str) -> datetime:
    normalized = value.strip()
    if normalized.endswith("Z"):
        normalized = normalized[:-1] + "+00:00"
    parsed = datetime.fromisoformat(normalized)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def validate_iso_utc(value: str, name: str) -> None:
    try:
        parse_iso_utc(value)
    except ValueError as exc:
        raise IssueError(f"{name} must be an ISO timestamp, e.g. 2026-10-01T00:00:00.000Z.") from exc


def iso_millis_z(value: datetime) -> str:
    value = value.astimezone(timezone.utc)
    return value.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def now_iso() -> str:
    return iso_millis_z(datetime.now(timezone.utc))


def now_iso_minus_seconds(seconds: int) -> str:
    return iso_millis_z(datetime.now(timezone.utc) - timedelta(seconds=seconds))


def utc_stamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def expanded_ssh_key(value: str) -> Path:
    return Path(value.replace("~", str(Path.home()), 1))


def shell_word(value: str) -> str:
    return "'" + value.replace("'", "'\"'\"'") + "'"


def get_path(value: Any, *keys: str) -> Any:
    current = value
    for key in keys:
        if not isinstance(current, dict):
            return None
        current = current.get(key)
    return current


def tighten_file_permissions(path: Path) -> None:
    if os.name == "nt":
        username = os.environ.get("USERNAME")
        if not username:
            return
        try:
            subprocess.run(
                ["icacls", str(path), "/inheritance:r", "/grant:r", f"{username}:(R,W)"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False,
            )
        except OSError:
            pass
    else:
        path.chmod(stat.S_IRUSR | stat.S_IWUSR)


if __name__ == "__main__":
    raise SystemExit(main())
