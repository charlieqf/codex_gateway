#!/usr/bin/env python3
"""Create a Doctor Research run and download its four verified artifacts."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import stat
import sys
import time
import unicodedata
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Iterable
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import (
    HTTPRedirectHandler,
    Request,
    build_opener,
)


DEFAULT_BASE_URL = "https://gw.instmarket.com.au"
DEFAULT_MAX_WAIT_SECONDS = 590
MAXIMUM_JSON_BYTES = 5_000_000
MAXIMUM_REQUEST_FILE_BYTES = 65_536
MAXIMUM_ARTIFACT_BYTES = 1_048_576
MAXIMUM_RATE_LIMIT_RETRIES = 4
MAXIMUM_RATE_LIMIT_WAIT_SECONDS = 60
RUN_ID_PATTERN = re.compile(r"^drr_[a-f0-9]{32}$")
ARTIFACT_ID_PATTERN = re.compile(r"^dra_[a-f0-9]{32}$")
SHA256_PATTERN = re.compile(r"^[a-f0-9]{64}$")
TERMINAL_STATUSES = frozenset(
    {"succeeded", "failed", "cancelled", "expired", "needs_input"}
)
EXPECTED_ARTIFACTS = {
    "profile": (".md", "text/markdown; charset=utf-8"),
    "review": (".md", "text/markdown; charset=utf-8"),
    "questions": (".txt", "text/plain; charset=utf-8"),
    "answers": (".md", "text/markdown; charset=utf-8"),
}
WINDOWS_RESERVED_NAMES = frozenset(
    {"CON", "PRN", "AUX", "NUL"}
    | {f"COM{index}" for index in range(1, 10)}
    | {f"LPT{index}" for index in range(1, 10)}
)


class DemoError(RuntimeError):
    """A safe, user-displayable demo failure."""


class NeedsInputError(DemoError):
    """The service requires a human identity decision."""


class ApiError(DemoError):
    """A structured API error that may carry bounded retry guidance."""

    def __init__(
        self,
        message: str,
        *,
        status: int,
        retry_after_seconds: int | None,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.retry_after_seconds = retry_after_seconds


@dataclass(frozen=True)
class Artifact:
    artifact_id: str
    kind: str
    filename: str
    content_type: str
    size_bytes: int
    sha256: str
    download_url: str


class NoRedirectHandler(HTTPRedirectHandler):
    """Prevent bearer credentials from being forwarded through redirects."""

    def redirect_request(  # type: ignore[override]
        self,
        req: Request,
        fp: Any,
        code: int,
        msg: str,
        headers: Any,
        newurl: str,
    ) -> None:
        return None


class ResearchClient:
    def __init__(self, base_url: str, api_key: str, timeout_seconds: int) -> None:
        self.base_url = validate_base_url(base_url)
        self.api_key = api_key
        self.timeout_seconds = timeout_seconds
        self.opener = build_opener(NoRedirectHandler())

    def request_json(
        self,
        method: str,
        path: str,
        *,
        body: dict[str, Any] | None = None,
        headers: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        request_headers = {
            "Accept": "application/json",
            "Authorization": f"Bearer {self.api_key}",
            "User-Agent": "codex-gateway-doctor-research-python-demo/1.0",
            **(headers or {}),
        }
        data = None
        if body is not None:
            data = json.dumps(
                body, ensure_ascii=False, separators=(",", ":")
            ).encode("utf-8")
            request_headers["Content-Type"] = "application/json"
        started = time.monotonic()
        attempt = 0
        while True:
            attempt += 1
            request = Request(
                self._url(path),
                data=data,
                headers=request_headers,
                method=method,
            )
            try:
                with self.opener.open(
                    request, timeout=self.timeout_seconds
                ) as response:
                    payload = read_bounded(response, MAXIMUM_JSON_BYTES)
                    return parse_json_object(payload)
            except HTTPError as error:
                payload = read_http_error(error)
                parsed = api_error(error.code, error.headers, payload)
                if method != "GET":
                    raise parsed from None
                self._wait_for_rate_limit_retry(
                    parsed,
                    path=path,
                    attempt=attempt,
                    started=started,
                )
            except URLError as error:
                raise DemoError(
                    f"Network request failed: {error.reason}"
                ) from None

    def download(self, artifact: Artifact, destination: Path) -> None:
        expected_path = (
            f"/gateway/research/v1/artifacts/{artifact.artifact_id}/download"
        )
        if artifact.download_url != expected_path:
            raise DemoError("Artifact download URL did not match its ID.")
        request_headers = {
            "Accept": (
                "text/plain"
                if artifact.kind == "questions"
                else "text/markdown"
            ),
            "Authorization": f"Bearer {self.api_key}",
            "User-Agent": "codex-gateway-doctor-research-python-demo/1.0",
        }
        started = time.monotonic()
        attempt = 0
        while True:
            attempt += 1
            request = Request(
                self._url(expected_path),
                headers=request_headers,
                method="GET",
            )
            try:
                with self.opener.open(
                    request, timeout=self.timeout_seconds
                ) as response:
                    content_type = response.headers.get(
                        "Content-Type", ""
                    ).lower()
                    content_length = response.headers.get("Content-Length")
                    if (
                        content_type != artifact.content_type
                        or content_length != str(artifact.size_bytes)
                        or response.headers.get("Cache-Control")
                        != "private, no-store"
                        or response.headers.get("X-Content-Type-Options")
                        != "nosniff"
                    ):
                        raise DemoError(
                            f"Artifact response headers were invalid for "
                            f"{artifact.kind}."
                        )
                    digest = hashlib.sha256()
                    size = 0
                    with destination.open("xb") as output:
                        while True:
                            chunk = response.read(64 * 1024)
                            if not chunk:
                                break
                            size += len(chunk)
                            if size > MAXIMUM_ARTIFACT_BYTES:
                                raise DemoError(
                                    f"Artifact {artifact.kind} exceeded the "
                                    "client size limit."
                                )
                            output.write(chunk)
                            digest.update(chunk)
                        output.flush()
                        os.fsync(output.fileno())
                break
            except HTTPError as error:
                payload = read_http_error(error)
                parsed = api_error(error.code, error.headers, payload)
                self._wait_for_rate_limit_retry(
                    parsed,
                    path=expected_path,
                    attempt=attempt,
                    started=started,
                )
            except URLError as error:
                raise DemoError(
                    f"Artifact download failed: {error.reason}"
                ) from None

        if size != artifact.size_bytes or digest.hexdigest() != artifact.sha256:
            raise DemoError(
                f"Artifact integrity verification failed for {artifact.kind}."
            )
        if artifact.kind == "questions":
            validate_five_line_questions(destination)

    def _url(self, path: str) -> str:
        if not path.startswith("/") or "://" in path:
            raise DemoError("Client attempted to use an invalid API path.")
        return f"{self.base_url}{path}"

    def _wait_for_rate_limit_retry(
        self,
        error: ApiError,
        *,
        path: str,
        attempt: int,
        started: float,
    ) -> None:
        if error.status != 429 or attempt > MAXIMUM_RATE_LIMIT_RETRIES:
            raise error
        wait_seconds = (
            error.retry_after_seconds
            if error.retry_after_seconds is not None
            else 1
        )
        elapsed = time.monotonic() - started
        if (
            wait_seconds < 0
            or elapsed + wait_seconds > MAXIMUM_RATE_LIMIT_WAIT_SECONDS
        ):
            raise error
        emit(
            {
                "event": "rate_limit_retry",
                "path": path,
                "attempt": attempt,
                "retry_after_seconds": wait_seconds,
            }
        )
        time.sleep(wait_seconds)


def parse_args(argv: Iterable[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Run the production Doctor Research API and download exactly "
            "three Markdown files plus one text file."
        )
    )
    parser.add_argument(
        "--request-file",
        help=(
            "UTF-8 JSON create-request body. It cannot be combined with "
            "doctor, literature, language, publication, or client-reference "
            "arguments."
        ),
    )
    parser.add_argument("--doctor-name")
    parser.add_argument("--hospital")
    parser.add_argument("--department")
    parser.add_argument(
        "--literature-name",
        help=(
            "Verified PubMed-indexed name, for example 'Lu Qingsheng'. "
            "Requires the other two --literature-* arguments."
        ),
    )
    parser.add_argument("--literature-hospital")
    parser.add_argument("--literature-department")
    parser.add_argument("--title")
    parser.add_argument("--city")
    parser.add_argument(
        "--orcid",
        help="Only use when the target deployment has approved ORCID access.",
    )
    parser.add_argument(
        "--official-profile-url",
        action="append",
        dest="official_profile_urls",
        help="Approved HTTPS official profile URL; repeat for up to three.",
    )
    parser.add_argument(
        "--language",
        choices=("zh-CN", "en"),
        help="CLI request language (default without --request-file: zh-CN).",
    )
    parser.add_argument(
        "--publication-years",
        type=int,
        choices=range(1, 11),
        help="CLI publication window (default without --request-file: 5).",
    )
    parser.add_argument("--client-reference")
    parser.add_argument(
        "--base-url",
        default=DEFAULT_BASE_URL,
        help=f"Gateway origin (default: {DEFAULT_BASE_URL}).",
    )
    parser.add_argument(
        "--api-key-file",
        help=(
            "Path to a private API-key file. If omitted, "
            "DOCTOR_RESEARCH_API_KEY is used."
        ),
    )
    parser.add_argument(
        "--output-dir",
        default="doctor-research-output",
        help="Parent directory for the atomically published run directory.",
    )
    parser.add_argument(
        "--idempotency-key",
        help=(
            "Reuse this after an uncertain create response. A fresh key is "
            "generated and printed before POST when omitted."
        ),
    )
    parser.add_argument(
        "--poll-seconds",
        type=bounded_integer("poll seconds", 2, 60),
        default=5,
    )
    parser.add_argument(
        "--max-wait-seconds",
        type=bounded_integer("maximum wait seconds", 60, 600),
        default=DEFAULT_MAX_WAIT_SECONDS,
    )
    parser.add_argument(
        "--request-timeout-seconds",
        type=bounded_integer("request timeout seconds", 5, 300),
        default=60,
    )
    return parser.parse_args(argv)


def main(argv: Iterable[str] | None = None) -> int:
    api_key = ""
    try:
        args = parse_args(argv)
        api_key = read_api_key(args.api_key_file)
        payload = build_payload(args)
        idempotency_key = validate_idempotency_key(
            args.idempotency_key
            or f"research:python-demo:{uuid.uuid4()}"
        )
        client = ResearchClient(
            args.base_url, api_key, args.request_timeout_seconds
        )
        emit(
            {
                "event": "create",
                "idempotency_key": idempotency_key,
                "base_url": client.base_url,
            }
        )
        receipt = client.request_json(
            "POST",
            "/gateway/research/v1/doctor-runs",
            body=payload,
            headers={"Idempotency-Key": idempotency_key},
        )
        run_id = required_match(
            receipt.get("run_id"), RUN_ID_PATTERN, "run ID"
        )
        emit({"event": "accepted", "run_id": run_id})
        wait_for_success(
            client,
            run_id,
            poll_seconds=args.poll_seconds,
            max_wait_seconds=args.max_wait_seconds,
        )
        result = client.request_json(
            "GET", f"/gateway/research/v1/doctor-runs/{run_id}/result"
        )
        quality_status, warnings = validate_result_quality(result)
        artifacts = validate_manifest(
            result, run_id=run_id, doctor_name=payload["doctor"]["name"]
        )
        output_directory = download_artifacts(
            client,
            artifacts,
            output_root=Path(args.output_dir),
            run_id=run_id,
        )
        emit(
            {
                "outcome": "succeeded",
                "run_id": run_id,
                "quality_status": quality_status,
                "warnings": warnings,
                "output_directory": str(output_directory),
                "files": [artifact.filename for artifact in artifacts],
            }
        )
        return 0
    except NeedsInputError as error:
        emit(
            {"outcome": "needs_input", "message": safe_message(error, api_key)},
            stream=sys.stderr,
        )
        return 2
    except (DemoError, OSError, ValueError) as error:
        emit(
            {"outcome": "failed", "message": safe_message(error, api_key)},
            stream=sys.stderr,
        )
        return 1


def build_payload(args: argparse.Namespace) -> dict[str, Any]:
    cli_fields = (
        "doctor_name",
        "hospital",
        "department",
        "literature_name",
        "literature_hospital",
        "literature_department",
        "title",
        "city",
        "orcid",
        "official_profile_urls",
        "language",
        "publication_years",
        "client_reference",
    )
    if args.request_file:
        if any(getattr(args, field) is not None for field in cli_fields):
            raise DemoError(
                "--request-file cannot be combined with request-body "
                "command-line arguments."
            )
        return load_request_payload(args.request_file)

    if not args.official_profile_urls:
        raise DemoError(
            "At least one --official-profile-url is required when "
            "--request-file is not used."
        )
    if len(args.official_profile_urls) > 3:
        raise DemoError("At most three official profile URLs are allowed.")
    doctor: dict[str, Any] = {
        "name": normalized_required(args.doctor_name, "doctor name"),
        "hospital": normalized_required(args.hospital, "hospital"),
        "department": normalized_required(args.department, "department"),
        "official_profile_urls": [
            validate_official_url(value)
            for value in args.official_profile_urls
        ],
    }
    for key in ("title", "city", "orcid"):
        value = getattr(args, key)
        if value:
            doctor[key] = unicodedata.normalize("NFC", value.strip())
    literature_values = (
        args.literature_name,
        args.literature_hospital,
        args.literature_department,
    )
    if any(literature_values) and not all(literature_values):
        raise DemoError(
            "The three --literature-* arguments must be supplied together."
        )
    if all(literature_values):
        doctor["literature_identity"] = {
            "name": normalized_required(
                args.literature_name, "literature name"
            ),
            "hospital": normalized_required(
                args.literature_hospital, "literature hospital"
            ),
            "department": normalized_required(
                args.literature_department, "literature department"
            ),
        }
    payload: dict[str, Any] = {
        "doctor": doctor,
        "mode": "brief",
        "language": args.language or "zh-CN",
        "options": {
            "publication_years": args.publication_years or 5,
            "citation_style": "vancouver",
        },
    }
    if args.client_reference:
        payload["client_reference"] = unicodedata.normalize(
            "NFC", args.client_reference.strip()
        )
    return validate_request_payload(payload)


def load_request_payload(filename: str) -> dict[str, Any]:
    path = Path(filename).expanduser()
    if path.is_symlink():
        raise DemoError("Request file must not be a symbolic link.")
    metadata = path.stat()
    if not stat.S_ISREG(metadata.st_mode):
        raise DemoError("Request-file path is not a regular file.")
    if metadata.st_size < 2 or metadata.st_size > MAXIMUM_REQUEST_FILE_BYTES:
        raise DemoError("Request-file size was invalid.")
    with path.open("rb") as input_file:
        raw = input_file.read(MAXIMUM_REQUEST_FILE_BYTES + 1)
    if len(raw) > MAXIMUM_REQUEST_FILE_BYTES:
        raise DemoError("Request-file size was invalid.")
    try:
        payload = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise DemoError("Request file was not a valid UTF-8 JSON object.") from None
    return validate_request_payload(payload)


def validate_request_payload(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise DemoError("Request file must contain one JSON object.")
    assert_only_keys(
        value,
        {"doctor", "mode", "language", "options", "client_reference"},
        "request",
    )
    if value.get("mode") != "brief":
        raise DemoError("Only mode 'brief' is supported.")
    if value.get("language") not in ("zh-CN", "en"):
        raise DemoError("language must be 'zh-CN' or 'en'.")

    raw_doctor = value.get("doctor")
    raw_options = value.get("options")
    if not isinstance(raw_doctor, dict) or not isinstance(raw_options, dict):
        raise DemoError("doctor and options must be JSON objects.")
    assert_only_keys(
        raw_doctor,
        {
            "name",
            "hospital",
            "department",
            "title",
            "city",
            "orcid",
            "official_profile_urls",
            "literature_identity",
        },
        "doctor",
    )
    assert_only_keys(
        raw_options,
        {"publication_years", "citation_style"},
        "options",
    )

    doctor: dict[str, Any] = {
        "name": normalized_text(raw_doctor.get("name"), "doctor.name", 2, 100),
        "hospital": normalized_text(
            raw_doctor.get("hospital"), "doctor.hospital", 1, 200
        ),
        "department": normalized_text(
            raw_doctor.get("department"), "doctor.department", 1, 200
        ),
    }
    raw_urls = raw_doctor.get("official_profile_urls")
    if not isinstance(raw_urls, list) or not 1 <= len(raw_urls) <= 3:
        raise DemoError(
            "doctor.official_profile_urls must contain one to three URLs."
        )
    urls = [validate_official_url(item) for item in raw_urls]
    if len(set(urls)) != len(urls):
        raise DemoError("doctor.official_profile_urls contained duplicates.")
    doctor["official_profile_urls"] = urls

    for key, maximum in (("title", 100), ("city", 100)):
        if key in raw_doctor:
            doctor[key] = normalized_text(
                raw_doctor[key], f"doctor.{key}", 1, maximum
            )
    if "orcid" in raw_doctor:
        doctor["orcid"] = validate_orcid(raw_doctor["orcid"])

    if "literature_identity" in raw_doctor:
        literature = raw_doctor["literature_identity"]
        if not isinstance(literature, dict):
            raise DemoError("doctor.literature_identity must be an object.")
        assert_only_keys(
            literature,
            {"name", "hospital", "department"},
            "doctor.literature_identity",
        )
        doctor["literature_identity"] = {
            "name": normalized_text(
                literature.get("name"),
                "doctor.literature_identity.name",
                2,
                100,
            ),
            "hospital": normalized_text(
                literature.get("hospital"),
                "doctor.literature_identity.hospital",
                2,
                200,
            ),
            "department": normalized_text(
                literature.get("department"),
                "doctor.literature_identity.department",
                2,
                200,
            ),
        }

    publication_years = raw_options.get("publication_years")
    if (
        not isinstance(publication_years, int)
        or isinstance(publication_years, bool)
        or not 1 <= publication_years <= 10
    ):
        raise DemoError("options.publication_years must be an integer from 1 to 10.")
    if raw_options.get("citation_style") != "vancouver":
        raise DemoError("Only citation_style 'vancouver' is supported.")

    payload: dict[str, Any] = {
        "doctor": doctor,
        "mode": "brief",
        "language": value["language"],
        "options": {
            "publication_years": publication_years,
            "citation_style": "vancouver",
        },
    }
    if "client_reference" in value:
        payload["client_reference"] = normalized_text(
            value["client_reference"], "client_reference", 1, 128
        )
    return payload


def assert_only_keys(
    value: dict[str, Any], allowed: set[str], description: str
) -> None:
    unexpected = sorted(set(value) - allowed)
    if unexpected:
        raise DemoError(
            f"{description} contained unsupported field(s): "
            + ", ".join(unexpected)
        )


def normalized_text(
    value: Any, description: str, minimum: int, maximum: int
) -> str:
    if not isinstance(value, str):
        raise DemoError(f"{description} must be a string.")
    normalized = unicodedata.normalize("NFC", value.strip())
    if (
        not minimum <= len(normalized) <= maximum
        or any(ord(char) < 32 or ord(char) == 127 for char in normalized)
        or any(0xD800 <= ord(char) <= 0xDFFF for char in normalized)
    ):
        raise DemoError(f"{description} was invalid.")
    return normalized


def validate_orcid(value: Any) -> str:
    normalized = normalized_text(value, "doctor.orcid", 19, 19)
    if not re.fullmatch(r"[0-9]{4}(?:-[0-9]{4}){2}-[0-9]{3}[0-9X]", normalized):
        raise DemoError("doctor.orcid was invalid.")
    compact = normalized.replace("-", "")
    total = 0
    for digit in compact[:15]:
        total = (total + int(digit)) * 2
    check_value = (12 - (total % 11)) % 11
    expected = "X" if check_value == 10 else str(check_value)
    if compact[15] != expected:
        raise DemoError("doctor.orcid checksum was invalid.")
    return normalized


def wait_for_success(
    client: ResearchClient,
    run_id: str,
    *,
    poll_seconds: int,
    max_wait_seconds: int,
) -> None:
    deadline = time.monotonic() + max_wait_seconds
    previous: tuple[Any, ...] | None = None
    while True:
        snapshot = client.request_json(
            "GET", f"/gateway/research/v1/doctor-runs/{run_id}"
        )
        status = snapshot.get("status")
        stage = snapshot.get("stage")
        progress = snapshot.get("progress")
        percent = progress.get("percent") if isinstance(progress, dict) else None
        current = (status, stage, percent)
        if current != previous:
            emit(
                {
                    "event": "progress",
                    "run_id": run_id,
                    "status": status,
                    "stage": stage,
                    "percent": percent,
                }
            )
            previous = current
        if status == "succeeded":
            return
        if status == "needs_input":
            candidates = snapshot.get("input_required", {}).get(
                "candidates", []
            )
            candidate_ids = [
                candidate.get("candidate_id")
                for candidate in candidates
                if isinstance(candidate, dict)
                and isinstance(candidate.get("candidate_id"), str)
            ]
            raise NeedsInputError(
                "Identity selection is required; no candidate was selected "
                f"automatically. run_id={run_id}, "
                f"candidate_ids={candidate_ids}"
            )
        if status in TERMINAL_STATUSES:
            reason = snapshot.get("terminal_reason", "unknown")
            detail = snapshot.get("terminal_detail_public")
            raise DemoError(
                f"Run {run_id} ended as {status}: {reason}"
                + (f" ({detail})" if isinstance(detail, str) else "")
            )
        if status not in {"queued", "running"}:
            raise DemoError(f"Run {run_id} returned an unknown status.")
        if time.monotonic() >= deadline:
            raise DemoError(
                f"Run {run_id} exceeded the bounded wait time; it was not "
                "cancelled and can be queried again."
            )
        time.sleep(poll_seconds)


def validate_manifest(
    result: dict[str, Any], *, run_id: str, doctor_name: str
) -> list[Artifact]:
    if (
        result.get("schema_version") != "doctor_research_result.v1"
        or result.get("run_id") != run_id
    ):
        raise DemoError("Result schema or run identity was invalid.")
    raw_artifacts = result.get("artifacts")
    if not isinstance(raw_artifacts, list) or len(raw_artifacts) != 4:
        raise DemoError("Result did not contain exactly four artifacts.")
    expected_prefix = f"{safe_display_name(doctor_name)}_"
    artifacts: dict[str, Artifact] = {}
    filenames: set[str] = set()
    for raw in raw_artifacts:
        if not isinstance(raw, dict):
            raise DemoError("Artifact manifest entry was invalid.")
        kind = raw.get("kind")
        if kind not in EXPECTED_ARTIFACTS or kind in artifacts:
            raise DemoError("Artifact kinds were invalid or duplicated.")
        extension, content_type = EXPECTED_ARTIFACTS[kind]
        artifact_id = required_match(
            raw.get("artifact_id"), ARTIFACT_ID_PATTERN, "artifact ID"
        )
        sha256 = required_match(
            raw.get("sha256"), SHA256_PATTERN, "artifact SHA-256"
        )
        size_bytes = raw.get("size_bytes")
        if (
            not isinstance(size_bytes, int)
            or isinstance(size_bytes, bool)
            or size_bytes < 0
            or size_bytes > MAXIMUM_ARTIFACT_BYTES
        ):
            raise DemoError("Artifact size was invalid.")
        filename = validate_artifact_filename(
            raw.get("filename"), extension=extension
        )
        if not filename.startswith(expected_prefix):
            raise DemoError(
                "Localized artifact filename did not start with the "
                "normalized doctor name."
            )
        if filename in filenames:
            raise DemoError("Artifact filenames were duplicated.")
        filenames.add(filename)
        if raw.get("content_type") != content_type:
            raise DemoError("Artifact content type was invalid.")
        download_url = raw.get("download_url")
        expected_url = (
            f"/gateway/research/v1/artifacts/{artifact_id}/download"
        )
        if download_url != expected_url:
            raise DemoError("Artifact download URL was invalid.")
        artifacts[kind] = Artifact(
            artifact_id=artifact_id,
            kind=kind,
            filename=filename,
            content_type=content_type,
            size_bytes=size_bytes,
            sha256=sha256,
            download_url=download_url,
        )
    if set(artifacts) != set(EXPECTED_ARTIFACTS):
        raise DemoError("Artifact set was incomplete.")
    ordered = [artifacts[kind] for kind in EXPECTED_ARTIFACTS]
    if (
        sum(item.filename.endswith(".md") for item in ordered) != 3
        or sum(item.filename.endswith(".txt") for item in ordered) != 1
    ):
        raise DemoError("Artifact extensions were not exactly 3 MD + 1 TXT.")
    return ordered


def validate_result_quality(result: dict[str, Any]) -> tuple[str, list[str]]:
    quality = result.get("quality")
    source_coverage = result.get("source_coverage")
    if not isinstance(quality, dict) or not isinstance(source_coverage, dict):
        raise DemoError("Result quality or source coverage was invalid.")
    status = quality.get("status")
    if status not in {"passed", "passed_with_warnings"}:
        raise DemoError("Result quality status was invalid.")
    checks = quality.get("checks")
    if (
        not isinstance(checks, list)
        or not checks
        or any(not isinstance(item, str) or not item for item in checks)
    ):
        raise DemoError("Result quality checks were invalid.")
    warnings = validate_warning_codes(
        quality.get("warnings"), "quality warnings"
    )
    source_warnings = validate_warning_codes(
        source_coverage.get("warnings"), "source-coverage warnings"
    )
    return status, list(dict.fromkeys([*warnings, *source_warnings]))


def validate_warning_codes(value: Any, description: str) -> list[str]:
    if (
        not isinstance(value, list)
        or len(value) > 100
        or any(
            not isinstance(item, str)
            or not re.fullmatch(r"[a-z][a-z0-9_.:-]{0,119}", item)
            for item in value
        )
    ):
        raise DemoError(f"Result {description} were invalid.")
    return [item for item in value if isinstance(item, str)]


def download_artifacts(
    client: ResearchClient,
    artifacts: list[Artifact],
    *,
    output_root: Path,
    run_id: str,
) -> Path:
    root = prepare_output_root(output_root)
    final_directory = root / run_id
    staging_directory = root / f".{run_id}.{uuid.uuid4().hex}.tmp"
    if final_directory.exists():
        raise DemoError(f"Output run directory already exists: {final_directory}")
    staging_directory.mkdir(mode=0o700)
    try:
        for artifact in artifacts:
            client.download(artifact, staging_directory / artifact.filename)
        names = sorted(path.name for path in staging_directory.iterdir())
        expected = sorted(artifact.filename for artifact in artifacts)
        if names != expected:
            raise DemoError(
                "Staging directory did not contain exactly four artifacts."
            )
        os.rename(staging_directory, final_directory)
    except BaseException:
        shutil.rmtree(staging_directory, ignore_errors=True)
        raise
    return final_directory.resolve()


def prepare_output_root(path: Path) -> Path:
    expanded = path.expanduser()
    if expanded.is_symlink():
        raise DemoError("Output root must not be a symbolic link.")
    expanded.mkdir(parents=True, exist_ok=True, mode=0o700)
    resolved = expanded.resolve()
    if not resolved.is_dir():
        raise DemoError("Output root is not a directory.")
    return resolved


def read_api_key(filename: str | None) -> str:
    env_value = os.environ.get("DOCTOR_RESEARCH_API_KEY")
    if filename and env_value:
        raise DemoError(
            "Use either --api-key-file or DOCTOR_RESEARCH_API_KEY, not both."
        )
    if filename:
        path = Path(filename).expanduser()
        if path.is_symlink():
            raise DemoError("API-key file must not be a symbolic link.")
        metadata = path.stat()
        if not stat.S_ISREG(metadata.st_mode):
            raise DemoError("API-key path is not a regular file.")
        if os.name != "nt" and metadata.st_mode & 0o077:
            raise DemoError("API-key file permissions must be 0600 or stricter.")
        if metadata.st_size < 8 or metadata.st_size > 16_384:
            raise DemoError("API-key file size was invalid.")
        value = path.read_text(encoding="utf-8").strip()
    elif env_value:
        value = env_value.strip()
    else:
        raise DemoError(
            "--api-key-file or DOCTOR_RESEARCH_API_KEY is required."
        )
    if len(value) < 8 or len(value) > 8_192 or re.search(r"[\r\n\x00]", value):
        raise DemoError("API key was invalid.")
    return value


def validate_base_url(value: str) -> str:
    parsed = urlsplit(value.strip())
    if (
        parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
        or parsed.path not in ("", "/")
        or not parsed.hostname
    ):
        raise DemoError("Base URL must be an origin without credentials.")
    if parsed.scheme == "http" and parsed.hostname not in ("127.0.0.1", "::1"):
        raise DemoError("Plain HTTP is allowed only on a literal loopback host.")
    if parsed.scheme not in ("http", "https"):
        raise DemoError("Base URL must use HTTPS or literal-loopback HTTP.")
    try:
        _ = parsed.port
    except ValueError:
        raise DemoError("Base URL port was invalid.") from None
    return value.strip().rstrip("/")


def validate_official_url(value: str) -> str:
    if not isinstance(value, str):
        raise DemoError("Official profile URL must be a string.")
    normalized = unicodedata.normalize("NFC", value.strip())
    if not normalized or len(normalized) > 2_048:
        raise DemoError("Official profile URL length was invalid.")
    parsed = urlsplit(normalized)
    try:
        port = parsed.port
    except ValueError:
        raise DemoError("Official profile URL port was invalid.") from None
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.fragment
        or port not in (None, 443)
    ):
        raise DemoError(
            "Official profile URLs must use credential-free HTTPS on port 443 "
            "without fragments."
        )
    return normalized


def validate_artifact_filename(value: Any, *, extension: str) -> str:
    if not isinstance(value, str):
        raise DemoError("Artifact filename was invalid.")
    normalized = unicodedata.normalize("NFC", value)
    if (
        normalized != value
        or len(normalized) > 180
        or normalized in ("", ".", "..")
        or normalized.endswith((" ", "."))
        or "/" in normalized
        or "\\" in normalized
        or ":" in normalized
        or re.search(r'[<>"|?*]', normalized)
        or re.search(r"[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]", normalized)
        or not normalized.endswith(extension)
    ):
        raise DemoError("Artifact filename was unsafe.")
    stem = normalized.split(".", 1)[0].upper()
    if stem in WINDOWS_RESERVED_NAMES:
        raise DemoError("Artifact filename used a reserved device name.")
    return normalized


def safe_display_name(value: str) -> str:
    cleaned = re.sub(
        r'[<>:"/\\|?*\x00-\x1f\x7f]',
        "_",
        unicodedata.normalize("NFC", value),
    )
    cleaned = re.sub(r"[.\s]+$", "", cleaned).strip()
    return "".join(list(cleaned)[:80]) or "doctor"


def validate_five_line_questions(path: Path) -> None:
    try:
        text = path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        raise DemoError("Questions artifact was not valid UTF-8.") from None
    lines = text.splitlines()
    if len(lines) != 5 or any(not line.strip() for line in lines):
        raise DemoError(
            "Questions artifact did not contain exactly five non-empty lines."
        )


def validate_idempotency_key(value: str) -> str:
    if (
        not re.fullmatch(r"research:[A-Za-z0-9._:-]+", value)
        or len(value) > 128
    ):
        raise DemoError("Idempotency key was invalid.")
    return value


def normalized_required(value: Any, description: str) -> str:
    if not isinstance(value, str):
        raise DemoError(f"{description} is required.")
    return normalized_text(value, description, 1, 200)


def bounded_integer(
    description: str, minimum: int, maximum: int
) -> Callable[[str], int]:
    def parse(value: str) -> int:
        try:
            parsed = int(value)
        except ValueError:
            raise argparse.ArgumentTypeError(
                f"{description} must be an integer"
            ) from None
        if parsed < minimum or parsed > maximum:
            raise argparse.ArgumentTypeError(
                f"{description} must be from {minimum} to {maximum}"
            )
        return parsed

    return parse


def required_match(value: Any, pattern: re.Pattern[str], description: str) -> str:
    if not isinstance(value, str) or not pattern.fullmatch(value):
        raise DemoError(f"Server returned an invalid {description}.")
    return value


def read_bounded(response: Any, maximum_bytes: int) -> bytes:
    payload = response.read(maximum_bytes + 1)
    if len(payload) > maximum_bytes:
        raise DemoError("HTTP response exceeded the client byte limit.")
    return payload


def read_http_error(error: HTTPError) -> bytes:
    try:
        return read_bounded(error, MAXIMUM_JSON_BYTES)
    finally:
        error.close()


def parse_json_object(payload: bytes) -> dict[str, Any]:
    try:
        value = json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise DemoError("Server returned invalid JSON.") from None
    if not isinstance(value, dict):
        raise DemoError("Server JSON response was not an object.")
    return value


def api_error(status: int, headers: Any, payload: bytes) -> ApiError:
    code = "http_error"
    message = "Request was rejected."
    try:
        value = parse_json_object(payload)
        error = value.get("error")
        if isinstance(error, dict):
            if isinstance(error.get("code"), str):
                code = error["code"]
            if isinstance(error.get("message"), str):
                message = error["message"]
    except DemoError:
        pass
    retry_after = headers.get("Retry-After") if headers is not None else None
    request_id = headers.get("X-Request-Id") if headers is not None else None
    suffix = ""
    if retry_after:
        suffix += f", retry_after={retry_after}"
    if request_id:
        suffix += f", request_id={request_id}"
    retry_after_seconds = None
    if isinstance(retry_after, str) and re.fullmatch(r"[0-9]{1,6}", retry_after):
        retry_after_seconds = int(retry_after)
    return ApiError(
        f"HTTP {status} {code}: {message}{suffix}",
        status=status,
        retry_after_seconds=retry_after_seconds,
    )


def safe_message(error: BaseException, api_key: str) -> str:
    message = str(error)
    if api_key:
        message = message.replace(api_key, "[redacted]")
    message = re.sub(
        r"(?:cgu|cgw|sk|Bearer)[_-][A-Za-z0-9_-]{8,}",
        "[redacted]",
        message,
    )
    return message[:1_000]


def emit(value: dict[str, Any], *, stream: Any = None) -> None:
    target = sys.stdout if stream is None else stream
    line = json.dumps(value, ensure_ascii=False, sort_keys=True) + "\n"
    try:
        target.write(line)
    except UnicodeEncodeError:
        target.write(json.dumps(value, ensure_ascii=True, sort_keys=True) + "\n")
    target.flush()


if __name__ == "__main__":
    raise SystemExit(main())
