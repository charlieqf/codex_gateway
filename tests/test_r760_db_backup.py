from __future__ import annotations

import datetime as dt
import importlib.util
import io
import json
import os
import sqlite3
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("r760_db_backup", ROOT / "scripts/ops/r760-db-backup.py")
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)

UTC = dt.timezone.utc
NOW = dt.datetime(2026, 9, 23, 18, 30, 0, tzinfo=UTC)


def make_wal_db(path: Path, *, schema_version: int | None = 35, fk_violation: bool = False) -> sqlite3.Connection:
    """Create a WAL database and return an open writer whose commits stay in the WAL."""
    db = sqlite3.connect(path)
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA wal_autocheckpoint=0")
    db.execute("CREATE TABLE parent (id INTEGER PRIMARY KEY)")
    db.execute("CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id))")
    if schema_version is not None:
        db.execute("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT)")
        db.execute("INSERT INTO schema_migrations VALUES (?, 'x')", (schema_version,))
    db.execute("INSERT INTO parent VALUES (1)")
    db.execute("INSERT INTO child VALUES (1, ?)", (99 if fk_violation else 1,))
    db.commit()
    return db


def write_manifest(directory: Path, producer: str = MODULE.PRODUCER, status: str = "ok") -> None:
    directory.mkdir(parents=True)
    (directory / MODULE.MANIFEST_FILE).write_text(json.dumps({"producer": producer, "status": status}))


class CreateBackupTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.base = Path(self.tmp.name)
        self.root = self.base / "daily"
        self.writers: list[sqlite3.Connection] = []

    def tearDown(self) -> None:
        for writer in self.writers:
            writer.close()
        self.tmp.cleanup()

    def source(self, name: str, **kwargs) -> Path:
        path = self.base / name
        self.writers.append(make_wal_db(path, **kwargs))
        return path

    def test_copies_uncheckpointed_wal_into_a_verified_self_contained_file(self) -> None:
        gateway = self.source("gateway.db")
        self.writers[0].execute("INSERT INTO parent VALUES (2)")
        self.writers[0].commit()
        self.assertGreater(gateway.with_name("gateway.db-wal").stat().st_size, 0)

        result = MODULE.create_backup(self.root, {"gateway.db": gateway}, NOW)

        final = self.root / "20260923T183000Z"
        self.assertEqual(result["path"], str(final))
        self.assertFalse((self.root / ".partial-20260923T183000Z").exists())
        copy = final / "gateway.db"
        self.assertFalse(copy.with_name("gateway.db-wal").exists())
        self.assertEqual(copy.read_bytes()[18:20], b"\x01\x01")  # rollback-journal file format
        check = sqlite3.connect(copy.as_uri() + "?mode=ro", uri=True)
        try:
            self.assertEqual(check.execute("SELECT COUNT(*) FROM parent").fetchone()[0], 2)
        finally:
            check.close()
        entry = result["files"][0]
        self.assertEqual(entry["schema_version"], 35)
        self.assertEqual(entry["sha256"], MODULE.sha256_file(copy))
        manifest = json.loads((final / "manifest.json").read_text())
        self.assertEqual((manifest["producer"], manifest["status"]), (MODULE.PRODUCER, "ok"))
        if os.name != "nt":
            self.assertEqual(copy.stat().st_mode & 0o777, 0o600)

    def test_database_without_migrations_table_records_no_schema_version(self) -> None:
        events = self.source("client-events.db", schema_version=None)
        result = MODULE.create_backup(self.root, {"client-events.db": events}, NOW)
        self.assertIsNone(result["files"][0]["schema_version"])

    def test_a_failed_verification_is_never_published(self) -> None:
        good = self.source("gateway.db")
        bad = self.source("imaging-control.db", fk_violation=True)
        with self.assertRaisesRegex(MODULE.BackupError, "foreign key"):
            MODULE.create_backup(self.root, {"gateway.db": good, "imaging-control.db": bad}, NOW)
        self.assertFalse((self.root / "20260923T183000Z").exists())
        self.assertTrue((self.root / ".partial-20260923T183000Z").is_dir())
        self.assertEqual(MODULE.completed_backups(self.root), [])

    def test_missing_source_fails_before_creating_anything(self) -> None:
        with self.assertRaisesRegex(MODULE.BackupError, "missing"):
            MODULE.create_backup(self.root, {"gateway.db": self.base / "absent.db"}, NOW)
        self.assertEqual(list(self.root.iterdir()), [])

    def test_refuses_to_overwrite_an_existing_backup(self) -> None:
        gateway = self.source("gateway.db")
        MODULE.create_backup(self.root, {"gateway.db": gateway}, NOW)
        with self.assertRaisesRegex(MODULE.BackupError, "already exists"):
            MODULE.create_backup(self.root, {"gateway.db": gateway}, NOW)


class RetentionTests(unittest.TestCase):
    def test_keeps_newest_per_day_and_per_week(self) -> None:
        start = dt.datetime(2026, 8, 1, 18, 30, tzinfo=UTC)
        backups = [(MODULE.stamp(start + dt.timedelta(days=i)), start + dt.timedelta(days=i)) for i in range(40)]
        extra = start + dt.timedelta(days=39, hours=2)  # a second run on the newest day
        backups.append((MODULE.stamp(extra), extra))

        keep, delete = MODULE.plan_retention(backups, keep_daily=7, keep_weekly=4)

        newest_days = {(start + dt.timedelta(days=39 - i)).date() for i in range(7)}
        daily_kept = [name for name in keep if MODULE.parse_stamp(name).date() in newest_days]
        self.assertEqual(len(daily_kept), 7)
        self.assertIn(MODULE.stamp(extra), keep)
        self.assertNotIn(MODULE.stamp(start + dt.timedelta(days=39)), keep)
        weeks = {tuple(MODULE.parse_stamp(name).isocalendar())[:2] for name in keep}
        self.assertEqual(len(weeks), 4)
        self.assertEqual(len(keep) + len(delete), len(backups))
        self.assertLessEqual(len(keep), 7 + 4)

    def test_newest_is_always_kept(self) -> None:
        moment = NOW
        keep, delete = MODULE.plan_retention([(MODULE.stamp(moment), moment)], keep_daily=1, keep_weekly=0)
        self.assertEqual((keep, delete), ([MODULE.stamp(moment)], []))

    def test_prune_only_touches_its_own_completed_backups(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for day in range(1, 5):
                write_manifest(root / f"202609{day:02d}T183000Z")
            write_manifest(root / "20260801T183000Z", producer="someone-else")
            write_manifest(root / "20260802T183000Z", status="failed")
            (root / "20260803T183000Z").mkdir()  # no manifest
            (root / "notes.txt").write_text("keep me")
            stale = root / ".partial-20260901T183000Z"
            stale.mkdir()
            old = (NOW - dt.timedelta(days=3)).timestamp()
            os.utime(stale, (old, old))
            fresh = root / ".partial-20260923T183000Z"
            fresh.mkdir()

            result = MODULE.prune(root, keep_daily=2, keep_weekly=0, now=NOW, apply=True)

            self.assertEqual(result["kept"], ["20260904T183000Z", "20260903T183000Z"])
            self.assertEqual(result["deleted"], ["20260902T183000Z", "20260901T183000Z"])
            self.assertEqual(result["stale_partials_deleted"], [stale.name])
            remaining = sorted(entry.name for entry in root.iterdir())
            self.assertEqual(remaining, sorted([
                ".partial-20260923T183000Z", "20260801T183000Z", "20260802T183000Z",
                "20260803T183000Z", "20260903T183000Z", "20260904T183000Z", "notes.txt",
            ]))

    def test_prune_report_mode_deletes_nothing(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for day in range(1, 4):
                write_manifest(root / f"202609{day:02d}T183000Z")
            result = MODULE.prune(root, keep_daily=1, keep_weekly=0, now=NOW, apply=False)
            self.assertEqual(len(result["would_delete"]), 2)
            self.assertEqual(len(list(root.iterdir())), 3)


class MainTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.base = Path(self.tmp.name)
        self.root = self.base / "daily"
        self.writer = make_wal_db(self.base / "gateway.db")
        self.args = ["--root", str(self.root), "--source", f"gateway.db={self.base / 'gateway.db'}",
                     "--lock-file", str(self.base / "lock")]

    def tearDown(self) -> None:
        self.writer.close()
        self.tmp.cleanup()

    def run_main(self, args: list[str]) -> tuple[int, str, str]:
        out, err = io.StringIO(), io.StringIO()
        with mock.patch.object(MODULE, "acquire_lock", return_value=io.StringIO()), \
                redirect_stdout(out), redirect_stderr(err):
            code = MODULE.main(args)
        return code, out.getvalue(), err.getvalue()

    def test_success_writes_status_and_prints_no_database_content(self) -> None:
        code, out, _ = self.run_main(self.args)
        self.assertEqual(code, 0)
        status = json.loads((self.root / "last-run.json").read_text())
        self.assertEqual(status["status"], "ok")
        self.assertEqual(json.loads(out)["path"], status["path"])
        self.assertIn("gateway.db", status["files"])

    def test_failure_records_failed_status(self) -> None:
        self.root.mkdir()
        args = self.args[:2] + ["--source", f"gateway.db={self.base / 'absent.db'}"] + self.args[4:]
        code, _, err = self.run_main(args)
        self.assertEqual(code, 1)
        self.assertEqual(json.loads((self.root / "last-run.json").read_text())["status"], "failed")
        self.assertIn("missing", err)

    def test_dry_run_writes_nothing(self) -> None:
        code, out, _ = self.run_main(self.args + ["--dry-run"])
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out)["mode"], "dry-run")
        self.assertFalse(self.root.exists())

    def test_rejects_duplicate_or_malformed_sources(self) -> None:
        with self.assertRaises(MODULE.BackupError):
            MODULE.resolve_sources(["gateway.db=/a", "gateway.db=/b"])
        with self.assertRaises(MODULE.BackupError):
            MODULE.resolve_sources(["../evil=/a"])


if __name__ == "__main__":
    unittest.main()
