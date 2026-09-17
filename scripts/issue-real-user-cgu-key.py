#!/usr/bin/env python3
"""
Issue a real-user cgu_live key through the Gateway-owned billing/v2 path.

The script prints only safe prefixes and writes the full cgu_live key to the
local handoff JSON. It never writes resolved backing Gateway or MedEvidence
runtime keys to disk.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import stat
import subprocess
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from codex_gateway_ops_common import DEFAULT_REMOTE_REPO, redact_secrets


DEFAULT_GATEWAY_BASE_URL = "https://goldencode.instmarket.com.au:1443"
DEFAULT_PROVIDER = "manual_trial"
DEFAULT_PLAN_ID = "plan_internal_high_quota_image_v1"
MIN_REAL_USER_RPM = 20
MIN_REAL_USER_VALIDITY_DAYS = 90
DEFAULT_REAL_USER_VALIDITY_DAYS = 92
DEFAULT_OUTPUT_DIR = r"C:\Users\rdpuser\medevidence_api_keys"
DESKTOP_VERSION_HEADER = "X-MedEvidence-Client-Version"
STRICT_SEMVER = re.compile(
    r"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)"
    r"(?:-(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)"
    r"(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?"
    r"(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$"
)

DEFAULT_VM_HOST = "117.186.49.26"
DEFAULT_VM_USER = "root"
DEFAULT_VM_PORT = 7723
DEFAULT_SSH_KEY = r"~\.ssh\id_ed25519"
DEFAULT_COMPOSE_PROJECT = "codex_gateway_r760"
DEFAULT_COMPOSE_FILE = "compose.azure.yml"
DEFAULT_GATEWAY_SERVICE = "gateway"
DEFAULT_GATEWAY_CONTAINER = "codex_gateway_r760-gateway-1"

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


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
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
        "--client-version",
        required=True,
        help="Strict SemVer sent with Desktop-gated validation requests.",
    )
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
    parser.add_argument("--rpm", type=real_user_rpm, default=MIN_REAL_USER_RPM)
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
    parser.add_argument("--vm-port", type=positive_int, default=DEFAULT_VM_PORT)
    parser.add_argument("--ssh-key", default=DEFAULT_SSH_KEY)
    parser.add_argument("--remote-repo", default=DEFAULT_REMOTE_REPO)
    parser.add_argument("--compose-project", default=DEFAULT_COMPOSE_PROJECT)
    parser.add_argument("--compose-file", default=DEFAULT_COMPOSE_FILE)
    parser.add_argument("--gateway-service", default=DEFAULT_GATEWAY_SERVICE)
    parser.add_argument("--gateway-container", default=DEFAULT_GATEWAY_CONTAINER)
    parser.add_argument(
        "--r760-only",
        action="store_true",
        help="Deprecated no-op retained for command compatibility; issuance is always R760-only.",
    )
    parser.add_argument("--timeout-seconds", type=positive_int, default=45)
    parser.add_argument(
        "--skip-credential-validation",
        action="store_true",
        help="Deprecated and rejected for real-user issuance; R760 validation is mandatory.",
    )
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
    parser.add_argument("--resume-job", help="Resume the original durable task; never starts a new business event.")
    parser.add_argument("--what-if", action="store_true", help="Print planned safe settings only.")
    return parser.parse_args(argv)


def positive_int(value: str) -> int:
    parsed = int(value)
    if parsed < 1:
        raise argparse.ArgumentTypeError("value must be positive")
    return parsed


def real_user_rpm(value: str) -> int:
    parsed = positive_int(value)
    if parsed < MIN_REAL_USER_RPM:
        raise argparse.ArgumentTypeError(
            f"value must be at least {MIN_REAL_USER_RPM} for a real user"
        )
    return parsed


def issue_key(args: argparse.Namespace) -> dict[str, Any]:
    base_url = normalize_base_url(args.gateway_base_url)
    if not STRICT_SEMVER.fullmatch(args.client_version):
        raise IssueError("--client-version must be a strict SemVer.")
    if args.skip_credential_validation:
        raise IssueError(
            "--skip-credential-validation is no longer permitted for real-user issuance; "
            "R760 validation is always mandatory."
        )
    if not re.fullmatch(r"(?:\+86)?1[3-9][0-9]{9}", args.phone.strip()):
        raise IssueError("phone must be 11 mainland China mobile digits, optionally prefixed by +86.")
    args.phone = "+86" + args.phone.strip().removeprefix("+86")
    if args.provider != DEFAULT_PROVIDER or args.scope != "code":
        raise IssueError("Real-user issuance requires provider manual_trial and scope code.")
    if not args.disable_on_failure:
        raise IssueError("--no-disable-on-failure is no longer supported; compensation is Gateway-owned.")
    external_user_id = args.external_user_id or default_external_user_id(args.phone)
    validate_external_user_id(external_user_id)
    resolve_expiration_defaults(args)
    validate_iso_utc(args.entitlement_end, "entitlement-end")
    validate_iso_utc(args.key_expires_at, "key-expires-at")
    if not getattr(args, "resume_job", None):
        validate_minimum_expiration(args.entitlement_end, "entitlement-end")
        validate_minimum_expiration(args.key_expires_at, "key-expires-at")
    stamp = utc_stamp()
    safe_user_slug = pseudonymous_slug(external_user_id)
    handoff_path = str(Path(args.output_dir) / f"real_user_cgu_{stamp}_{safe_user_slug}.json")

    if args.what_if:
        return {
            "what_if": True,
            "provider": args.provider,
            "external_user_id": "provided" if args.external_user_id else "generated_from_phone",
            "identity_fields": "provided",
            "authoritative_gateway_base_url": base_url,
            "handoff_gateway_base_url": base_url,
            "plan_id": args.plan_id,
            "requires_image_generation": not args.no_require_image_capability,
            "authority_mode": "r760_only",
            "client_version": args.client_version,
            "r760_validation": "required",
            "entitlement_end": iso_millis_z(parse_iso_utc(args.entitlement_end)),
            "key_expires_at": iso_millis_z(parse_iso_utc(args.key_expires_at)),
            "rate": {
                "requestsPerMinute": args.rpm,
                "requestsPerDay": args.rpd,
                "concurrentRequests": args.concurrent,
            },
            "handoff_path": handoff_path,
        }

    billing_token = get_billing_admin_token(args)
    headers = bearer_headers(billing_token)
    headers[DESKTOP_VERSION_HEADER] = args.client_version
    root = f"{base_url}/gateway/admin/billing/v1"
    job_id = getattr(args, "resume_job", None)
    if job_id:
        if not re.fullmatch(r"rui_[a-f0-9]{32}", job_id):
            raise IssueError("--resume-job must be an issuance task ID.")
        job = http_json("GET", f"{root}/real-user-issue/{job_id}", headers, None, args.timeout_seconds)
        if job.get("external_user_id") != external_user_id:
            raise IssueError("Original task belongs to a different external identity.")
        if job.get("state") != "succeeded":
            if job.get("requires_review"):
                raise IssueError(f"Task {job_id} requires manual review; reconcile it in the issuance console before acknowledging recovery.")
            job = http_json("POST", f"{root}/real-user-issue/{job_id}/resume", headers, {}, args.timeout_seconds)
    else:
        job = http_json("POST", f"{root}/real-user-issue", headers, {
            "name": args.name, "phone": args.phone, "provider": args.provider,
            "external_user_id": external_user_id, "plan_id": args.plan_id, "scope": args.scope,
            "entitlement_end": args.entitlement_end, "key_expires_at": args.key_expires_at,
            "rpm": args.rpm, "rpd": args.rpd, "concurrent": args.concurrent,
            "require_image_capability": not args.no_require_image_capability,
        }, args.timeout_seconds)
        job_id = job.get("job_id")
    if not job_id:
        raise IssueError("Gateway did not return a durable task ID; inspect recent tasks before retrying.")
    print(f"Issuance task: {job_id}. Recovery uses --resume-job {job_id}.", file=sys.stderr)
    deadline = time.monotonic() + 1200
    while job.get("state") in ("queued", "running", "compensating"):
        if time.monotonic() >= deadline:
            raise IssueError(f"Task {job_id} is still pending; inspect the original task, do not create another.")
        time.sleep(2)
        job = http_json("GET", f"{root}/real-user-issue/{job_id}", headers, None, args.timeout_seconds)
    if job.get("state") != "succeeded":
        code = (job.get("compensation_error") or job.get("error") or {}).get("code", "unknown")
        raise IssueError(f"Task {job_id}: {job.get('state')} ({code}); recovery action: {job.get('recovery_action')}.")
    opaque_key = str(job.get("unified_key") or "")
    if not opaque_key.startswith("cgu_live_"):
        raise IssueError(f"Task {job_id} succeeded but its key reveal window is unavailable; use the established phone login/recovery path.")
    result = job["result"]
    # Use server-frozen settings, including when this invocation resumes an older task.
    args.name = job.get("display_name", args.name)
    if getattr(args, "resume_job", None):
        args.phone = "****" + str(job.get("phone_tail") or "")
    args.key_expires_at = result["backing_key_expires_at"]
    args.rpm = result["rate"]["requestsPerMinute"]
    args.rpd = result["rate"]["requestsPerDay"]
    args.concurrent = result["rate"]["concurrentRequests"]
    capabilities = result["capabilities"]
    write_handoff(
        args=args, path=Path(handoff_path), base_url=base_url, opaque_key=opaque_key,
        create={"credential": {"key_prefix": result["key_prefix"], "issued_at": job["created_at"],
                              "expires_at": result["backing_key_expires_at"]}},
        entitlement={"plan_id": result["plan_id"], "period_end": result["entitlement_end"]},
        resolved={"codex_gateway": {"key_prefix": result["codex_gateway_prefix"]},
                  "medevidence": {"key_prefix": result["medevidence_prefix"]}},
        subject_id=result["subject_id"], external_user_id=external_user_id,
        capabilities=capabilities,
    )
    return {"issued": "ok", "job_id": job_id, "key_type": "cgu_live", "authority_mode": "r760_only",
            "client_version": args.client_version, **result, "r760_validation": "ok", "handoff_path": handoff_path}


def write_handoff(
    *,
    args: argparse.Namespace,
    path: Path,
    base_url: str,
    opaque_key: str,
    create: dict[str, Any],
    entitlement: dict[str, Any],
    resolved: dict[str, Any],
    subject_id: str,
    external_user_id: str,
    capabilities: list[str],
) -> None:
    handoff = {
        "key_type": "opaque_unified_cgu_live",
        "authority_mode": "r760_only",
        "client_version": args.client_version,
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
        "credential": None,
        "notes": [
            "Give Desktop this cgu_live key, not the underlying cgw or MedEvidence v2 keys.",
            "Desktop should call /gateway/unified-keys/resolve and then use returned runtime credentials.",
            "For image generation, call /gateway/images/generations with model medcode-image-default.",
        ],
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(handoff, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tighten_file_permissions(path)


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
        f"{remote_docker_command(args)} exec {shell_word(args.gateway_container)} "
        "printenv GATEWAY_BILLING_ADMIN_TOKEN"
    )
    completed = run_ssh(args, remote_command)
    token = completed.stdout.strip()
    if not token:
        raise IssueError("GATEWAY_BILLING_ADMIN_TOKEN is empty in the live Gateway container.")
    if len(token) < 24:
        raise IssueError("Billing admin token must be at least 24 characters.")
    return token


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
        "-p",
        str(args.vm_port),
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


def remote_docker_command(args: argparse.Namespace) -> str:
    return "docker" if args.vm_user == "root" else "sudo docker"


def normalize_base_url(value: str) -> str:
    normalized = value.rstrip("/")
    if not re.match(r"^https?://", normalized):
        raise IssueError("gateway-base-url must start with http:// or https://.")
    return normalized


def default_external_user_id(phone: str) -> str:
    digits = phone.strip().removeprefix("+86")
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


def pseudonymous_slug(value: str) -> str:
    return "user-" + hashlib.sha256(value.encode("utf-8")).hexdigest()[:12]


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
