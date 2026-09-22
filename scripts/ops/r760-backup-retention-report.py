#!/usr/bin/env python3
"""Report-only retention review for R760 Gateway backups. It deletes nothing.

Reviews three roots and writes a dated JSON report plus latest.json:

- release: pre-change backups made by release/operation scripts. Protected: the
  newest --release-keep entries, entries younger than --release-min-age-days,
  backups whose name or top-level receipt names the current or previous Gateway
  release, and any entry that a symlink in the root points into (the
  2026-09-11 cold archive is such a container).
- control: pre-write snapshots from the local control wrapper. A snapshot and
  its -wal/-shm/-journal companions form one group. Protected: the newest
  --control-keep groups and groups younger than --control-min-age-days.
- daily: the scheduled database backups (their own retention prunes them);
  reported for size and last-run status only.

Candidates are what a future apply mode would remove under these rules. Runs on
the R760 host (Python 3.10); prints and records names, sizes and ages only.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import shutil
import sys
from pathlib import Path
from typing import Any

PRODUCER = "r760-backup-retention-report"
DEFAULT_GATEWAY_ROOT = Path("/opt/codex-gateway-r760")
DEFAULT_RELEASE_ROOT = Path("/data/codex-gateway-r760/backups")
DEFAULT_CONTROL_ROOT = Path("/data/backups/codex-gateway")
DEFAULT_DAILY_ROOT = Path("/data/backups/codex-gateway-daily")
DEFAULT_OUTPUT = Path("/data/backups/codex-gateway-retention")
STAMP_RE = re.compile(r"(\d{8}T\d{4}(?:\d{2})?Z)")
COMPANION_RE = re.compile(r"-(wal|shm|journal)$")
RECEIPT_NAMES = ("deployment.json", "receipt.json")
MAX_RECEIPT_BYTES = 1 << 20


def utc_now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def entry_time(path: Path) -> dt.datetime:
    """Timestamp embedded in the name, else the entry's own mtime."""
    match = STAMP_RE.search(path.name)
    if match:
        raw = match.group(1)
        fmt = "%Y%m%dT%H%M%SZ" if len(raw) == 16 else "%Y%m%dT%H%MZ"
        return dt.datetime.strptime(raw, fmt).replace(tzinfo=dt.timezone.utc)
    return dt.datetime.fromtimestamp(path.lstat().st_mtime, dt.timezone.utc)


def disk_bytes(path: Path) -> int:
    """Allocated bytes of a file or tree, never following symlinks."""
    def one(st: os.stat_result) -> int:
        blocks = getattr(st, "st_blocks", None)
        return blocks * 512 if blocks is not None else st.st_size

    st = path.lstat()
    if not path.is_dir() or path.is_symlink():
        return one(st)
    total = one(st)
    for base, dirs, files in os.walk(path, followlinks=False):
        for name in dirs + files:
            try:
                total += one(os.lstat(os.path.join(base, name)))
            except OSError:
                pass
    return total


def revisions(gateway_root: Path) -> set[str]:
    found = set()
    for link in ("current", "previous"):
        target = gateway_root / link
        if target.exists():
            name = target.resolve().name
            if re.fullmatch(r"[0-9a-f]{40}", name):
                found.add(name)
    return found


def names_live_release(entry: Path, live: set[str]) -> bool:
    if any(revision[:12] in entry.name for revision in live):
        return True
    if not entry.is_dir() or entry.is_symlink():
        return False
    for receipt in RECEIPT_NAMES:
        path = entry / receipt
        try:
            if path.is_file() and path.stat().st_size <= MAX_RECEIPT_BYTES:
                if json.loads(path.read_text(encoding="utf-8")).get("revision") in live:
                    return True
        except (OSError, ValueError, AttributeError):
            continue
    return False


def symlink_containers(root: Path, entries: list[Path]) -> set[str]:
    """Top-level entries that a symlink in `root` resolves into."""
    real_root = root.resolve()
    containers = set()
    for entry in entries:
        if not entry.is_symlink():
            continue
        target = Path(os.path.realpath(entry))
        try:
            relative = target.relative_to(real_root)
        except ValueError:
            continue
        if relative.parts:
            containers.add(relative.parts[0])
    return containers


def age_days(moment: dt.datetime, now: dt.datetime) -> float:
    return round((now - moment).total_seconds() / 86400, 1)


def classify(items: list[dict[str, Any]], keep_newest: int, min_age_days: float,
             extra_reasons: dict[str, list[str]]) -> dict[str, Any]:
    """items: dicts with name, time, bytes. Newest first after sorting."""
    ordered = sorted(items, key=lambda item: item["time"], reverse=True)
    protected, candidates = [], []
    for rank, item in enumerate(ordered):
        reasons = list(extra_reasons.get(item["name"], []))
        if rank < keep_newest:
            reasons.append(f"newest-{keep_newest}")
        if item["age_days"] < min_age_days:
            reasons.append(f"younger-than-{min_age_days:g}d")
        record = {"name": item["name"], "bytes": item["bytes"], "age_days": item["age_days"],
                  "time": item["time"].isoformat()}
        if reasons:
            protected.append({**record, "reasons": reasons})
        else:
            candidates.append(record)
    return {
        "entries": len(ordered),
        "total_bytes": sum(item["bytes"] for item in ordered),
        "protected_bytes": sum(item["bytes"] for item in protected),
        "candidate_bytes": sum(item["bytes"] for item in candidates),
        "protected": protected,
        "candidates": candidates,
    }


def review_release(root: Path, gateway_root: Path, now: dt.datetime,
                   keep_newest: int, min_age_days: float) -> dict[str, Any]:
    if not root.is_dir():
        return {"path": str(root), "missing": True}
    entries = sorted(p for p in root.iterdir() if not p.name.startswith("."))
    live = revisions(gateway_root)
    containers = symlink_containers(root, entries)
    extra: dict[str, list[str]] = {}
    items = []
    links = 0
    for entry in entries:
        if entry.is_symlink():
            links += 1  # a link frees nothing; its target is protected below
            continue
        reasons = []
        if names_live_release(entry, live):
            reasons.append("current-or-previous-release")
        if entry.name in containers:
            reasons.append("symlink-target")
        if reasons:
            extra[entry.name] = reasons
        moment = entry_time(entry)
        items.append({"name": entry.name, "time": moment, "age_days": age_days(moment, now),
                      "bytes": disk_bytes(entry)})
    result = classify(items, keep_newest, min_age_days, extra)
    return {"path": str(root), "symlinks": links, "live_revisions": sorted(live), **result}


def review_control(root: Path, now: dt.datetime, keep_newest: int, min_age_days: float) -> dict[str, Any]:
    if not root.is_dir():
        return {"path": str(root), "missing": True}
    groups: dict[str, list[Path]] = {}
    for entry in root.iterdir():
        if entry.name.startswith(".") or entry.is_symlink():
            continue
        groups.setdefault(COMPANION_RE.sub("", entry.name), []).append(entry)
    items = []
    for name, members in groups.items():
        anchor = next((m for m in members if m.name == name), members[0])
        moment = entry_time(anchor)
        items.append({"name": name, "time": moment, "age_days": age_days(moment, now),
                      "bytes": sum(disk_bytes(m) for m in members)})
    return {"path": str(root), **classify(items, keep_newest, min_age_days, {})}


def review_daily(root: Path) -> dict[str, Any]:
    if not root.is_dir():
        return {"path": str(root), "missing": True}
    status = None
    try:
        raw = json.loads((root / "last-run.json").read_text(encoding="utf-8"))
        status = {key: raw.get(key) for key in ("status", "at", "path", "total_bytes", "error")}
    except (OSError, ValueError):
        pass
    backups = [p for p in root.iterdir() if re.fullmatch(r"\d{8}T\d{6}Z", p.name) and p.is_dir()]
    return {"path": str(root), "backups": len(backups), "total_bytes": disk_bytes(root),
            "last_run": status}


def disk_usage(paths: list[str]) -> dict[str, Any]:
    usage = {}
    for path in paths:
        if os.path.exists(path):
            total, used, free = shutil.disk_usage(path)
            usage[path] = {"total": total, "used": used, "free": free,
                           "used_percent": round(100 * used / total, 1)}
    return usage


def build_report(args: argparse.Namespace, now: dt.datetime) -> dict[str, Any]:
    return {
        "producer": PRODUCER,
        "mode": "report-only",
        "generated_at": now.isoformat(),
        "policy": {
            "release": {"keep_newest": args.release_keep, "min_age_days": args.release_min_age_days,
                        "always": ["current-or-previous-release", "symlink-target"]},
            "control": {"keep_newest": args.control_keep, "min_age_days": args.control_min_age_days},
        },
        "disk": disk_usage(["/", "/data"]),
        "release": review_release(args.release_root, args.gateway_root, now,
                                  args.release_keep, args.release_min_age_days),
        "control": review_control(args.control_root, now, args.control_keep, args.control_min_age_days),
        "daily": review_daily(args.daily_root),
    }


def write_report(output: Path, report: dict[str, Any], now: dt.datetime) -> Path:
    output.mkdir(mode=0o700, parents=True, exist_ok=True)
    text = json.dumps(report, indent=2, sort_keys=True) + "\n"
    dated = output / f"report-{now.strftime('%Y%m%dT%H%M%SZ')}.json"
    for path in (dated, output / "latest.json"):
        tmp = path.with_name(f".{path.name}.tmp")
        tmp.write_text(text, encoding="utf-8")
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)
    return dated


def summary(report: dict[str, Any], path: Path | None) -> dict[str, Any]:
    def brief(section: dict[str, Any]) -> dict[str, Any]:
        keys = ("entries", "total_bytes", "protected_bytes", "candidate_bytes", "missing", "symlinks")
        out = {k: section[k] for k in keys if k in section}
        if "candidates" in section:
            out["candidate_count"] = len(section["candidates"])
        return out
    return {
        "report": str(path) if path else None,
        "disk": {k: v["used_percent"] for k, v in report["disk"].items()},
        "release": brief(report["release"]),
        "control": brief(report["control"]),
        "daily": {k: report["daily"].get(k) for k in ("backups", "total_bytes", "last_run", "missing")},
    }


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--gateway-root", type=Path, default=DEFAULT_GATEWAY_ROOT)
    parser.add_argument("--release-root", type=Path, default=DEFAULT_RELEASE_ROOT)
    parser.add_argument("--control-root", type=Path, default=DEFAULT_CONTROL_ROOT)
    parser.add_argument("--daily-root", type=Path, default=DEFAULT_DAILY_ROOT)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--release-keep", type=int, default=10)
    parser.add_argument("--release-min-age-days", type=float, default=14)
    parser.add_argument("--control-keep", type=int, default=20)
    parser.add_argument("--control-min-age-days", type=float, default=30)
    parser.add_argument("--stdout-only", action="store_true", help="print the summary without writing files")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    now = utc_now()
    report = build_report(args, now)
    path = None if args.stdout_only else write_report(args.output, report, now)
    print(json.dumps(summary(report, path), indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
