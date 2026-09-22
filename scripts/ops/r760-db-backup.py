#!/usr/bin/env python3
"""Scheduled online backup of the R760 Gateway SQLite databases.

Each run copies every source with the SQLite online-backup API from a read-only
connection (one consistent snapshot per database; WAL writers are not blocked),
converts the copy to a self-contained rollback-journal file, verifies it with
quick_check and foreign_key_check, and records a manifest. A run is published by
renaming its staging directory, so a completed directory always holds a
verified backup.

Retention only ever removes completed backups this script produced, and only
after a successful run: the newest backup of each of the latest --keep-daily UTC
days and of each of the latest --keep-weekly ISO weeks are kept.

Runs on the R760 host (Python 3.10). Prints paths, sizes and hashes only.
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import re
import shutil
import socket
import sqlite3
import sys
import time
from pathlib import Path
from typing import Any

PRODUCER = "r760-db-backup"
FORMAT_VERSION = 1
NAME_RE = re.compile(r"^\d{8}T\d{6}Z$")
PARTIAL_PREFIX = ".partial-"
STALE_PARTIAL_SECONDS = 48 * 3600
STATUS_FILE = "last-run.json"
MANIFEST_FILE = "manifest.json"

DEFAULT_ROOT = Path("/data/backups/codex-gateway-daily")
DEFAULT_LOCK = Path("/run/lock/codex-gateway-db-backup.lock")
_STATE = "/data/docker/volumes/codex_gateway_r760_gateway_state/_data"
DEFAULT_SOURCES = {
    "gateway.db": Path(f"{_STATE}/gateway.db"),
    "client-events.db": Path(f"{_STATE}/client-events.db"),
    "imaging-control.db": Path(f"{_STATE}/imaging/control.db"),
}


class BackupError(RuntimeError):
    pass


def utc_now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def stamp(moment: dt.datetime) -> str:
    return moment.strftime("%Y%m%dT%H%M%SZ")


def parse_stamp(name: str) -> dt.datetime:
    return dt.datetime.strptime(name, "%Y%m%dT%H%M%SZ").replace(tzinfo=dt.timezone.utc)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def fsync_path(path: Path) -> None:
    """fsync a file, or a directory where the platform allows it."""
    flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) if path.is_dir() else os.O_RDWR
    try:
        fd = os.open(path, flags)
    except OSError:
        if path.is_dir():
            return  # Windows cannot open directories; only relevant for tests.
        raise
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def write_json_atomic(path: Path, payload: dict[str, Any]) -> None:
    tmp = path.with_name(f".{path.name}.tmp")
    tmp.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    os.chmod(tmp, 0o600)
    fsync_path(tmp)
    os.replace(tmp, path)


def source_bytes(path: Path) -> int:
    total = path.stat().st_size
    wal = path.with_name(path.name + "-wal")
    return total + (wal.stat().st_size if wal.exists() else 0)


def backup_one(name: str, source: Path, dest_dir: Path) -> dict[str, Any]:
    if source.is_symlink() or not source.is_file():
        raise BackupError(f"source {name} is not a regular file: {source}")
    destination = dest_dir / name
    started = time.monotonic()
    src = sqlite3.connect(source.as_uri() + "?mode=ro", uri=True)
    try:
        src.execute("PRAGMA query_only=ON")
        dst = sqlite3.connect(destination)
        try:
            src.backup(dst)  # pages=-1: one step, one consistent snapshot
            mode = dst.execute("PRAGMA journal_mode=DELETE").fetchone()[0]
            if str(mode).lower() != "delete":
                raise BackupError(f"{name}: copy kept journal_mode={mode}")
        finally:
            dst.close()
    finally:
        src.close()
    copy_seconds = time.monotonic() - started

    check = sqlite3.connect(destination.as_uri() + "?mode=ro", uri=True)
    try:
        check.execute("PRAGMA query_only=ON")
        quick = [row[0] for row in check.execute("PRAGMA quick_check").fetchall()]
        fk_violations = len(check.execute("PRAGMA foreign_key_check").fetchall())
        user_version = check.execute("PRAGMA user_version").fetchone()[0]
        has_migrations = check.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'"
        ).fetchone()
        schema_version = (
            check.execute("SELECT MAX(version) FROM schema_migrations").fetchone()[0]
            if has_migrations else None
        )
    finally:
        check.close()
    if quick != ["ok"]:
        raise BackupError(f"{name}: quick_check failed on the copy ({len(quick)} rows)")
    if fk_violations:
        raise BackupError(f"{name}: {fk_violations} foreign key violation(s) on the copy")
    for leftover in (destination.with_name(name + "-wal"), destination.with_name(name + "-journal")):
        if leftover.exists():
            raise BackupError(f"{name}: copy is not self-contained ({leftover.name} present)")

    os.chmod(destination, 0o600)
    fsync_path(destination)
    return {
        "name": name,
        "source": str(source),
        "bytes": destination.stat().st_size,
        "sha256": sha256_file(destination),
        "quick_check": "ok",
        "foreign_key_violations": 0,
        "user_version": user_version,
        "schema_version": schema_version,
        "copy_seconds": round(copy_seconds, 3),
    }


def create_backup(root: Path, sources: dict[str, Path], now: dt.datetime) -> dict[str, Any]:
    if not root.exists():
        root.mkdir(mode=0o700)
    if root.is_symlink() or not root.is_dir():
        raise BackupError(f"backup root must be a real directory: {root}")
    for name, path in sources.items():
        if not path.is_file():
            raise BackupError(f"source {name} is missing: {path}")
    needed = 2 * sum(source_bytes(path) for path in sources.values())
    free = shutil.disk_usage(root).free
    if free < needed:
        raise BackupError(f"insufficient space: need {needed} bytes free, have {free}")

    name = stamp(now)
    final = root / name
    if final.exists():
        raise BackupError(f"backup already exists: {final}")
    staging = root / f"{PARTIAL_PREFIX}{name}"
    staging.mkdir(mode=0o700)
    started = time.monotonic()
    files = [backup_one(db_name, path, staging) for db_name, path in sources.items()]
    manifest = {
        "producer": PRODUCER,
        "format_version": FORMAT_VERSION,
        "status": "ok",
        "created_at": now.isoformat(),
        "host": socket.gethostname(),
        "total_bytes": sum(item["bytes"] for item in files),
        "duration_seconds": round(time.monotonic() - started, 3),
        "files": files,
    }
    write_json_atomic(staging / MANIFEST_FILE, manifest)
    fsync_path(staging)
    os.rename(staging, final)
    fsync_path(root)
    return {**manifest, "path": str(final)}


def completed_backups(root: Path) -> list[tuple[str, dt.datetime]]:
    """Backups this script produced and completed; anything else is ignored."""
    found = []
    for entry in root.iterdir() if root.is_dir() else []:
        if not NAME_RE.match(entry.name) or entry.is_symlink() or not entry.is_dir():
            continue
        try:
            manifest = json.loads((entry / MANIFEST_FILE).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if manifest.get("producer") == PRODUCER and manifest.get("status") == "ok":
            found.append((entry.name, parse_stamp(entry.name)))
    return sorted(found, key=lambda item: item[1], reverse=True)


def plan_retention(
    backups: list[tuple[str, dt.datetime]], keep_daily: int, keep_weekly: int
) -> tuple[list[str], list[str]]:
    """Return (keep, delete) names. `backups` may be in any order."""
    ordered = sorted(backups, key=lambda item: item[1], reverse=True)
    keep: set[str] = set()
    if ordered:
        keep.add(ordered[0][0])
    days: list[dt.date] = []
    weeks: list[tuple[int, int]] = []
    for name, moment in ordered:  # newest first: first hit is the newest of its period
        day = moment.date()
        if day not in days:
            days.append(day)
            if len(days) <= keep_daily:
                keep.add(name)
        week = tuple(moment.isocalendar())[:2]
        if week not in weeks:
            weeks.append(week)
            if len(weeks) <= keep_weekly:
                keep.add(name)
    kept = [name for name, _ in ordered if name in keep]
    delete = [name for name, _ in ordered if name not in keep]
    return kept, delete


def stale_partials(root: Path, now: dt.datetime) -> list[Path]:
    cutoff = now.timestamp() - STALE_PARTIAL_SECONDS
    return sorted(
        entry for entry in (root.iterdir() if root.is_dir() else [])
        if entry.name.startswith(PARTIAL_PREFIX) and not entry.is_symlink()
        and entry.is_dir() and entry.stat().st_mtime < cutoff
    )


def prune(root: Path, keep_daily: int, keep_weekly: int, now: dt.datetime, apply: bool) -> dict[str, Any]:
    kept, delete = plan_retention(completed_backups(root), keep_daily, keep_weekly)
    partials = stale_partials(root, now)
    if apply:
        for name in delete:
            shutil.rmtree(root / name)
        for partial in partials:
            shutil.rmtree(partial)
        fsync_path(root)
    return {
        "kept": kept,
        "deleted" if apply else "would_delete": delete,
        "stale_partials_" + ("deleted" if apply else "found"): [p.name for p in partials],
    }


def acquire_lock(path: Path):
    import fcntl  # POSIX only; the script runs on the R760 host.

    handle = path.open("a")
    try:
        fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        handle.close()
        raise BackupError(f"another backup run holds {path}")
    return handle


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--root", type=Path, default=DEFAULT_ROOT)
    parser.add_argument("--source", action="append", default=[], metavar="NAME=PATH",
                        help="database to back up; defaults to the three Gateway databases")
    parser.add_argument("--keep-daily", type=int, default=7)
    parser.add_argument("--keep-weekly", type=int, default=4)
    parser.add_argument("--lock-file", type=Path, default=DEFAULT_LOCK)
    parser.add_argument("--dry-run", action="store_true",
                        help="report sources and the retention plan without writing")
    args = parser.parse_args(argv)
    if args.keep_daily < 1 or args.keep_weekly < 0:
        parser.error("--keep-daily must be >= 1 and --keep-weekly >= 0")
    return args


def resolve_sources(values: list[str]) -> dict[str, Path]:
    if not values:
        return dict(DEFAULT_SOURCES)
    sources: dict[str, Path] = {}
    for value in values:
        name, sep, path = value.partition("=")
        if not sep or not re.fullmatch(r"[A-Za-z0-9._-]+\.db", name) or name in sources:
            raise BackupError(f"invalid --source {value!r}; expected unique NAME.db=PATH")
        sources[name] = Path(path)
    return sources


def main(argv: list[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    now = utc_now()
    try:
        sources = resolve_sources(args.source)
        if args.dry_run:
            print(json.dumps({
                "mode": "dry-run",
                "root": str(args.root),
                "sources": {name: {"path": str(path), "bytes": source_bytes(path)}
                            for name, path in sources.items()},
                "retention": prune(args.root, args.keep_daily, args.keep_weekly, now, apply=False),
            }, indent=2))
            return 0
        lock = acquire_lock(args.lock_file)
        try:
            result = create_backup(args.root, sources, now)
            result["retention"] = prune(args.root, args.keep_daily, args.keep_weekly, now, apply=True)
        finally:
            lock.close()
    except Exception as error:  # record every failure for the status file
        status = {"producer": PRODUCER, "status": "failed", "at": now.isoformat(),
                  "error": f"{type(error).__name__}: {error}"}
        if args.root.is_dir() and not args.dry_run:
            write_json_atomic(args.root / STATUS_FILE, status)
        print(json.dumps(status, indent=2), file=sys.stderr)
        return 1
    status = {"producer": PRODUCER, "status": "ok", "at": now.isoformat(),
              "path": result["path"], "total_bytes": result["total_bytes"],
              "duration_seconds": result["duration_seconds"],
              "files": {item["name"]: {"bytes": item["bytes"], "sha256": item["sha256"],
                                       "schema_version": item["schema_version"]}
                        for item in result["files"]},
              "retention": result["retention"]}
    write_json_atomic(args.root / STATUS_FILE, status)
    print(json.dumps(status, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
