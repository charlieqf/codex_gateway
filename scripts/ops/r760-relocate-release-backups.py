#!/usr/bin/env python3
"""Move the R760 release backups off the root disk (one-off, idempotent).

/opt/codex-gateway-r760/backups lives on the 98G root volume and every release
adds ~2 GiB to it. This replaces it with a symlink to
/data/codex-gateway-r760/backups, so existing paths (including those recorded
in receipts) and release scripts that write root/'backups'/<name> keep working.

Every top-level entry is copied into a staging directory on /data with its
mode and ownership, verified against the original (types, modes, owners, sizes,
sha256 of every file, symlink text), and published by rename. Only after the
swap and a second verification through the new path is the original removed.
A failure before the swap leaves the original untouched. Holds the deploy lock.

Runs on the R760 host (Python 3.10); prints names and sizes only.
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import shutil
import sys
from pathlib import Path
from typing import Any

DEFAULT_GATEWAY_ROOT = Path("/opt/codex-gateway-r760")
DEFAULT_TARGET = Path("/data/codex-gateway-r760/backups")


class RelocationError(RuntimeError):
    pass


def sha256_file(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def describe(path: str) -> dict[str, Any]:
    st = os.lstat(path)
    record: dict[str, Any] = {"mode": st.st_mode & 0o7777, "uid": st.st_uid, "gid": st.st_gid}
    if os.path.islink(path):
        record.update(type="link", target=os.readlink(path))
    elif os.path.isdir(path):
        record.update(type="dir")
    else:
        record.update(type="file", size=st.st_size, sha256=sha256_file(path))
    return record


def inventory(entry: str) -> dict[str, dict[str, Any]]:
    """Relative path -> metadata for an entry and, if it is a real directory, its tree."""
    tree = {".": describe(entry)}
    if tree["."]["type"] == "dir":
        for base, dirs, files in os.walk(entry, followlinks=False):
            for name in dirs + files:
                full = os.path.join(base, name)
                tree[os.path.relpath(full, entry).replace(os.sep, "/")] = describe(full)
    return tree


def entry_bytes(tree: dict[str, dict[str, Any]]) -> int:
    return sum(item.get("size", 0) for item in tree.values())


def copy_entry(source: str, destination: str) -> None:
    if os.path.islink(source):
        os.symlink(os.readlink(source), destination)
    elif os.path.isdir(source):
        shutil.copytree(source, destination, symlinks=True, copy_function=shutil.copy2)
    else:
        shutil.copy2(source, destination, follow_symlinks=False)
    for relative, meta in inventory(source).items():
        path = destination if relative == "." else os.path.join(destination, relative)
        if hasattr(os, "lchown"):
            os.lchown(path, meta["uid"], meta["gid"])
        if meta["type"] != "link":
            os.chmod(path, meta["mode"])  # chown can clear set-id bits; restore exactly


def ensure_same(expected: dict, actual: dict, name: str) -> None:
    if expected != actual:
        differing = sorted(k for k in set(expected) | set(actual) if expected.get(k) != actual.get(k))
        raise RelocationError(f"verification failed for {name}: {len(differing)} path(s) differ, e.g. {differing[:3]}")


def acquire_lock(path: Path):
    import fcntl  # POSIX only; the script runs on the R760 host.

    handle = path.open("a")
    try:
        fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        handle.close()
        raise RelocationError(f"deploy lock is held: {path}")
    return handle


def relocate(source: Path, target: Path, stamp: str, *, require_cross_device: bool = True) -> dict[str, Any]:
    if source.is_symlink():
        if source.resolve() == target.resolve():
            return {"status": "already-relocated", "source": str(source), "target": str(target)}
        raise RelocationError(f"{source} is already a symlink to {source.resolve()}")
    if not source.is_dir() or target.is_symlink() or not target.is_dir():
        raise RelocationError("source and target must both be real directories")
    if require_cross_device and os.stat(source).st_dev == os.stat(target).st_dev:
        raise RelocationError("source and target are on the same filesystem; nothing to gain")

    names = sorted(os.listdir(source))
    collisions = [name for name in names if os.path.lexists(target / name)]
    if collisions:
        raise RelocationError(f"target already has {len(collisions)} of these names, e.g. {collisions[:3]}")
    originals = {name: inventory(str(source / name)) for name in names}
    total = sum(entry_bytes(tree) for tree in originals.values())
    if total > 0.9 * shutil.disk_usage(target).free:
        raise RelocationError(f"not enough free space on target for {total} bytes")

    # 1. Copy and verify into staging on the target filesystem.
    staging = target / f".relocating-{stamp}"
    staging.mkdir(mode=0o700)
    for name in names:
        copy_entry(str(source / name), str(staging / name))
        ensure_same(originals[name], inventory(str(staging / name)), name)

    # 2. Publish on the target filesystem (same-device renames).
    for name in names:
        os.rename(staging / name, target / name)
    staging.rmdir()

    # 3. Swap the source directory for a symlink; keep the original until verified.
    retired = source.with_name(f"{source.name}.pre-relocate-{stamp}")
    link = source.with_name(f".{source.name}-link-{stamp}")
    os.symlink(target, link, target_is_directory=True)
    os.rename(source, retired)
    os.rename(link, source)

    # 4. Verify every original name through the new path before removing anything.
    try:
        for name in names:
            ensure_same(originals[name], inventory(str(source / name)), name)
    except Exception:
        os.rename(source, link)
        os.rename(retired, source)
        os.unlink(link)
        raise

    receipt = {
        "relocated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "source": str(source),
        "target": str(target),
        "entries": [{"name": name, "type": originals[name]["."]["type"],
                     "paths": len(originals[name]), "bytes": entry_bytes(originals[name]),
                     "tree_sha256": hashlib.sha256(
                         json.dumps(originals[name], sort_keys=True).encode()).hexdigest()}
                    for name in names],
        "total_bytes": total,
    }
    receipt_path = target / f".relocation-{source.name}-{stamp}.json"
    receipt_path.write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    os.chmod(receipt_path, 0o600)

    # 5. The verified copies are published; remove the retired originals.
    shutil.rmtree(retired)
    return {"status": "relocated", "receipt": str(receipt_path),
            "entries": len(names), "total_bytes": total}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--gateway-root", type=Path, default=DEFAULT_GATEWAY_ROOT)
    parser.add_argument("--target", type=Path, default=DEFAULT_TARGET)
    args = parser.parse_args(sys.argv[1:] if argv is None else argv)
    stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    root_before = shutil.disk_usage("/").used
    lock = acquire_lock(args.gateway_root / ".deploy.lock")
    try:
        result = relocate(args.gateway_root / "backups", args.target, stamp)
    except RelocationError as error:
        print(json.dumps({"status": "failed", "error": str(error)}, indent=2), file=sys.stderr)
        return 1
    finally:
        lock.close()
    result["root_disk_freed_bytes"] = root_before - shutil.disk_usage("/").used
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
