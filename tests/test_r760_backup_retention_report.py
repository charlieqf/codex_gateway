from __future__ import annotations

import datetime as dt
import importlib.util
import io
import json
import os
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "r760_backup_retention_report", ROOT / "scripts/ops/r760-backup-retention-report.py"
)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)

UTC = dt.timezone.utc
NOW = dt.datetime(2026, 9, 23, 19, 30, tzinfo=UTC)
CURRENT = "95e724cc06c07f139d94cd46b0f1f0c3c1a6a3b2"
PREVIOUS = "da97de6567e1e988b7cb12594166f195af0139e7"


def can_symlink(base: Path) -> bool:
    try:
        (base / ".probe-target").mkdir()
        os.symlink(base / ".probe-target", base / ".probe-link", target_is_directory=True)
        return True
    except (OSError, NotImplementedError):
        return False


def backup_dir(root: Path, name: str, receipt: dict | None = None, size: int = 10) -> Path:
    path = root / name
    path.mkdir(parents=True)
    (path / "gateway.db").write_bytes(b"x" * size)
    if receipt is not None:
        (path / "receipt.json").write_text(json.dumps(receipt))
    return path


class ReleaseReviewTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.base = Path(self.tmp.name)
        self.gateway = self.base / "gateway"
        releases = self.gateway / "releases"
        (releases / CURRENT).mkdir(parents=True)
        (releases / PREVIOUS).mkdir(parents=True)
        self.symlinks = can_symlink(self.base)
        if self.symlinks:
            os.symlink(releases / CURRENT, self.gateway / "current", target_is_directory=True)
            os.symlink(releases / PREVIOUS, self.gateway / "previous", target_is_directory=True)
        self.root = self.base / "backups"
        self.root.mkdir()

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def review(self, keep: int = 2, min_age: float = 14) -> dict:
        return MODULE.review_release(self.root, self.gateway, NOW, keep, min_age)

    def by_name(self, result: dict) -> dict[str, dict]:
        return {item["name"]: item for item in result["protected"] + result["candidates"]}

    def test_newest_and_young_entries_are_protected_and_old_ones_are_candidates(self) -> None:
        for day in (1, 2, 3):
            backup_dir(self.root, f"pre-change-202608{day:02d}T010203Z")
        backup_dir(self.root, "pre-change-20260920T0145Z")  # four-digit time form
        backup_dir(self.root, ".relocation-notes")

        result = self.review(keep=1, min_age=14)
        items = self.by_name(result)

        self.assertEqual(result["entries"], 4)
        self.assertNotIn(".relocation-notes", items)
        self.assertEqual(items["pre-change-20260920T0145Z"]["reasons"], ["newest-1", "younger-than-14d"])
        self.assertEqual([c["name"] for c in result["candidates"]],
                         [f"pre-change-202608{day:02d}T010203Z" for day in (3, 2, 1)])
        self.assertEqual(result["candidate_bytes"], sum(c["bytes"] for c in result["candidates"]))

    def test_current_and_previous_release_backups_are_always_protected(self) -> None:
        if not self.symlinks:
            self.skipTest("symlinks unavailable")
        live = backup_dir(self.root, "vision-observation-95e724cc06c0")  # no stamp: dated by mtime
        old = (NOW - dt.timedelta(days=60)).timestamp()
        os.utime(live, (old, old))
        backup_dir(self.root, "ct-progress-20260801T083948Z", receipt={"revision": PREVIOUS})
        backup_dir(self.root, "pre-old-20260801T000000Z", receipt={"revision": "f" * 40})
        for day in (20, 21):
            backup_dir(self.root, f"newer-202609{day}T000000Z")

        items = self.by_name(self.review(keep=2, min_age=0))

        self.assertIn("current-or-previous-release", items["vision-observation-95e724cc06c0"]["reasons"])
        self.assertIn("current-or-previous-release", items["ct-progress-20260801T083948Z"]["reasons"])
        self.assertNotIn("reasons", items["pre-old-20260801T000000Z"])

    def test_symlinks_are_skipped_and_their_container_is_protected(self) -> None:
        if not self.symlinks:
            self.skipTest("symlinks unavailable")
        archive = self.root / "opt-archive-20260801"  # no stamp: dated by mtime
        backup_dir(archive, "phone-signup-07331b498b6c")
        old = (NOW - dt.timedelta(days=60)).timestamp()
        os.utime(archive, (old, old))
        os.symlink(archive / "phone-signup-07331b498b6c", self.root / "phone-signup-07331b498b6c",
                   target_is_directory=True)
        for day in (20, 21):
            backup_dir(self.root, f"newer-202609{day}T000000Z")

        result = self.review(keep=2, min_age=0)
        items = self.by_name(result)

        self.assertEqual(result["symlinks"], 1)
        self.assertNotIn("phone-signup-07331b498b6c", items)
        self.assertEqual(items["opt-archive-20260801"]["reasons"], ["symlink-target"])
        self.assertEqual(result["candidates"], [])


class ControlReviewTests(unittest.TestCase):
    def test_companion_files_form_one_group(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for day in range(1, 6):
                stem = f"r760-control-pre-sync-202607{day:02d}T000000Z-abc.db"
                (root / stem).write_bytes(b"x" * 100)
                (root / f"{stem}-wal").write_bytes(b"y" * 10)
                (root / f"{stem}-shm").write_bytes(b"z" * 10)
            recent = "r760-control-pre-sync-20260920T000000Z-def.db"
            (root / recent).write_bytes(b"x")

            result = MODULE.review_control(root, NOW, keep_newest=2, min_age_days=30)

            self.assertEqual(result["entries"], 6)
            self.assertEqual([p["name"] for p in result["protected"]],
                             [recent, "r760-control-pre-sync-20260705T000000Z-abc.db"])
            self.assertEqual(len(result["candidates"]), 4)
            self.assertTrue(all(not c["name"].endswith(("-wal", "-shm")) for c in result["candidates"]))


class MainTests(unittest.TestCase):
    def test_writes_dated_and_latest_reports_and_never_deletes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            release = base / "release"
            for day in range(1, 4):
                backup_dir(release, f"pre-202607{day:02d}T000000Z")
            daily = base / "daily"
            daily.mkdir()
            (daily / "last-run.json").write_text(json.dumps({"status": "ok", "at": "x", "secret": "no"}))
            before = sorted(str(p) for p in base.rglob("*"))
            out = io.StringIO()
            with redirect_stdout(out):
                code = MODULE.main([
                    "--gateway-root", str(base / "gateway"), "--release-root", str(release),
                    "--control-root", str(base / "absent"), "--daily-root", str(daily),
                    "--output", str(base / "reports"), "--release-keep", "1", "--release-min-age-days", "0",
                ])
            self.assertEqual(code, 0)
            after = sorted(str(p) for p in base.rglob("*") if "reports" not in p.parts)
            self.assertEqual(before, after)
            latest = json.loads((base / "reports" / "latest.json").read_text())
            self.assertEqual(latest["mode"], "report-only")
            self.assertEqual(len(latest["release"]["candidates"]), 2)
            self.assertTrue(latest["control"]["missing"])
            self.assertNotIn("secret", latest["daily"]["last_run"])
            printed = json.loads(out.getvalue())
            self.assertEqual(printed["release"]["candidate_count"], 2)
            self.assertEqual(len(list((base / "reports").glob("report-*.json"))), 1)


if __name__ == "__main__":
    unittest.main()
