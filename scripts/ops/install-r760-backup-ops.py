#!/usr/bin/env python3
"""Install the R760 backup operations from one committed revision.

Usage on the host (the script itself is piped over SSH):
    python3 - <40-hex revision on origin/main> [verify|install|backup|relocate|report|all]...

verify   fetch the revision into the host mirror, confirm it is on origin/main,
         extract the backup scripts, tests and units, and run the tests with the
         host Python. Every later phase runs verify first and stops on failure.
install  install the scripts to /opt/codex-gateway-r760/ops and the units to
         /etc/systemd/system, then enable the daily backup and report timers.
backup   run the backup service once and show its result.
relocate move /opt/codex-gateway-r760/backups to /data (one-off, idempotent).
report   run the report service once and show its summary.
all      verify, install, backup, relocate, report (in that order).

Prints revisions, paths, sizes and hashes only.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

GATEWAY_ROOT = Path("/opt/codex-gateway-r760")
MIRROR = GATEWAY_ROOT / "staging/codex-gateway-mirror.git"
OPS_DIR = GATEWAY_ROOT / "ops"
UNIT_DIR = Path("/etc/systemd/system")
DATA_DIRS = [Path("/data/backups/codex-gateway-daily"), Path("/data/backups/codex-gateway-retention")]
SCRIPTS = [
    "scripts/ops/r760-db-backup.py",
    "scripts/ops/r760-backup-retention-report.py",
    "scripts/ops/r760-relocate-release-backups.py",
]
TESTS = [
    "tests/test_r760_db_backup.py",
    "tests/test_r760_backup_retention_report.py",
    "tests/test_r760_relocate_release_backups.py",
]
UNITS = [
    "deploy/systemd/codex-gateway-db-backup.service",
    "deploy/systemd/codex-gateway-db-backup.timer",
    "deploy/systemd/codex-gateway-backup-report.service",
    "deploy/systemd/codex-gateway-backup-report.timer",
]
TIMERS = ["codex-gateway-db-backup.timer", "codex-gateway-backup-report.timer"]
PHASES = ["verify", "install", "backup", "relocate", "report"]


def emit(event: str, **fields) -> None:
    print(json.dumps({"event": event, **fields}), flush=True)


def run(args: list[str], **kwargs) -> str:
    result = subprocess.run(args, capture_output=True, text=True, **kwargs)
    if result.returncode:
        tail = (result.stdout + result.stderr).strip().splitlines()[-15:]
        raise SystemExit(json.dumps({"event": "failed", "command": args[:3], "output_tail": tail}, indent=2))
    return result.stdout


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def verify(revision: str) -> Path:
    run(["git", "-C", str(MIRROR), "fetch", "--quiet", "origin", "main"])
    run(["git", "-C", str(MIRROR), "cat-file", "-e", f"{revision}^{{commit}}"])
    run(["git", "-C", str(MIRROR), "merge-base", "--is-ancestor", revision, "FETCH_HEAD"])
    workdir = Path(tempfile.mkdtemp(prefix="backup-ops-"))
    archive = subprocess.run(["git", "-C", str(MIRROR), "archive", revision, *SCRIPTS, *TESTS, *UNITS],
                             capture_output=True, check=True)
    subprocess.run(["tar", "-x", "-C", str(workdir)], input=archive.stdout, check=True)
    tests = subprocess.run([sys.executable, "-m", "unittest", *TESTS],
                           cwd=workdir, capture_output=True, text=True)
    summary = tests.stderr.strip().splitlines()
    # Require a clean pass with nothing skipped: symlink cases only run on Linux.
    if tests.returncode or not summary or summary[-1] != "OK":
        raise SystemExit(json.dumps({"event": "tests_failed", "output_tail": summary[-25:]}, indent=2))
    ran = next((line for line in summary if line.startswith("Ran ")), "")
    emit("verified", revision=revision, python=sys.version.split()[0], tests=ran, workdir=str(workdir))
    return workdir


def write_file(source: Path, destination: Path, mode: int) -> None:
    tmp = destination.with_name(f".{destination.name}.installing")
    tmp.write_bytes(source.read_bytes())
    os.chmod(tmp, mode)
    os.chown(tmp, 0, 0)
    os.replace(tmp, destination)


def install(revision: str, workdir: Path) -> None:
    OPS_DIR.mkdir(mode=0o755, exist_ok=True)
    for directory in DATA_DIRS:
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    installed = {}
    for relative in SCRIPTS:
        destination = OPS_DIR / Path(relative).name
        write_file(workdir / relative, destination, 0o755)
        installed[str(destination)] = sha256(destination)
    unit_paths = []
    for relative in UNITS:
        destination = UNIT_DIR / Path(relative).name
        write_file(workdir / relative, destination, 0o644)
        installed[str(destination)] = sha256(destination)
        unit_paths.append(str(destination))
    record = OPS_DIR / "INSTALLED_REVISION"
    record.write_text(json.dumps({"revision": revision, "files": installed}, indent=2) + "\n")
    os.chmod(record, 0o644)
    run(["systemd-analyze", "verify", *unit_paths])
    run(["systemctl", "daemon-reload"])
    run(["systemctl", "enable", "--now", *TIMERS])
    timers = run(["systemctl", "list-timers", "--all", "--no-pager", *TIMERS])
    emit("installed", revision=revision, files=installed,
         timers=[line for line in timers.splitlines() if "codex-gateway" in line])


def start_and_show(service: str) -> None:
    # oneshot: start returns when the run finishes; show its output either way.
    started = subprocess.run(["systemctl", "start", service], capture_output=True, text=True)
    result = run(["systemctl", "show", "-p", "Result", "--value", service]).strip()
    invocation = run(["systemctl", "show", "-p", "InvocationID", "--value", service]).strip()
    output = run(["journalctl", f"_SYSTEMD_INVOCATION_ID={invocation}", "--no-pager", "-o", "cat"]) if invocation else ""
    emit("service_run", service=service, result=result, output=output.strip().splitlines()[-40:])
    if started.returncode or result != "success":
        raise SystemExit(1)


def relocate(workdir: Path) -> None:
    script = workdir / "scripts/ops/r760-relocate-release-backups.py"
    result = subprocess.run([sys.executable, str(script)], capture_output=True, text=True)
    emit("relocate", returncode=result.returncode,
         output=(result.stdout + result.stderr).strip().splitlines()[-30:])
    if result.returncode:
        raise SystemExit(1)


def main(argv: list[str]) -> int:
    if not argv or not re.fullmatch(r"[0-9a-f]{40}", argv[0]):
        print(__doc__, file=sys.stderr)
        return 2
    revision = argv[0]
    requested = argv[1:] or ["verify"]
    phases = PHASES if "all" in requested else [p for p in PHASES if p in requested]
    unknown = set(requested) - set(PHASES) - {"all"}
    if unknown:
        print(f"unknown phase(s): {sorted(unknown)}", file=sys.stderr)
        return 2
    workdir = verify(revision)
    try:
        for phase in phases:
            if phase == "install":
                install(revision, workdir)
            elif phase == "backup":
                start_and_show("codex-gateway-db-backup.service")
            elif phase == "relocate":
                relocate(workdir)
            elif phase == "report":
                start_and_show("codex-gateway-backup-report.service")
    finally:
        shutil.rmtree(workdir, ignore_errors=True)
    emit("done", phases=phases)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
