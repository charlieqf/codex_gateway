from __future__ import annotations

import importlib.util
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "r760_relocate_release_backups", ROOT / "scripts/ops/r760-relocate-release-backups.py"
)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
STAMP = "20260923T010203Z"


def can_symlink(base: Path) -> bool:
    try:
        os.symlink(base, base / ".probe", target_is_directory=True)
        os.unlink(base / ".probe")
        return True
    except (OSError, NotImplementedError):
        return False


class RelocateTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        base = Path(self.tmp.name)
        self.gateway = base / "opt"
        self.source = self.gateway / "backups"
        self.target = base / "data" / "backups"
        self.symlinks = can_symlink(base)

        release = self.source / "vision-observation-95e724cc06c0"
        (release / "nested").mkdir(parents=True)
        (release / "gateway.db").write_bytes(b"gateway-bytes")
        (release / "nested" / "deployment.json").write_text('{"revision": "x"}')
        (self.source / "smoke-cleanup.db").write_bytes(b"loose-file")
        archive = self.target / "opt-archive-20260911" / "phone-signup-07331b498b6c"
        archive.mkdir(parents=True)
        (archive / "gateway.db").write_bytes(b"archived")
        if self.symlinks:
            os.symlink(archive, self.source / "phone-signup-07331b498b6c", target_is_directory=True)
            os.symlink("gateway.db", release / "alias.db")
        if os.name != "nt":
            os.chmod(release, 0o700)
            os.chmod(release / "gateway.db", 0o600)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def require_symlinks(self) -> None:
        if not self.symlinks:
            self.skipTest("symlinks unavailable")

    def test_relocates_verifies_swaps_and_removes_only_the_retired_original(self) -> None:
        self.require_symlinks()
        before = {name: MODULE.inventory(str(self.source / name)) for name in os.listdir(self.source)}

        result = MODULE.relocate(self.source, self.target, STAMP, require_cross_device=False)

        self.assertEqual(result["status"], "relocated")
        self.assertEqual(result["entries"], 3)
        self.assertTrue(self.source.is_symlink())
        self.assertEqual(self.source.resolve(), self.target.resolve())
        for name, tree in before.items():
            self.assertEqual(MODULE.inventory(str(self.source / name)), tree, name)
        self.assertEqual((self.source / "phone-signup-07331b498b6c" / "gateway.db").read_bytes(), b"archived")
        self.assertEqual(os.readlink(self.target / "vision-observation-95e724cc06c0" / "alias.db"), "gateway.db")
        self.assertFalse((self.gateway / f"backups.pre-relocate-{STAMP}").exists())
        self.assertFalse((self.target / f".relocating-{STAMP}").exists())
        self.assertTrue(Path(result["receipt"]).is_file())
        self.assertTrue((self.target / "opt-archive-20260911" / "phone-signup-07331b498b6c").is_dir())

    def test_second_run_is_a_no_op(self) -> None:
        self.require_symlinks()
        MODULE.relocate(self.source, self.target, STAMP, require_cross_device=False)
        again = MODULE.relocate(self.source, self.target, "20260923T020000Z", require_cross_device=False)
        self.assertEqual(again["status"], "already-relocated")

    def test_name_collision_aborts_before_copying(self) -> None:
        (self.target / "smoke-cleanup.db").write_bytes(b"other")
        with self.assertRaisesRegex(MODULE.RelocationError, "already has"):
            MODULE.relocate(self.source, self.target, STAMP, require_cross_device=False)
        self.assertTrue(self.source.is_dir() and not self.source.is_symlink())
        self.assertFalse((self.target / f".relocating-{STAMP}").exists())

    def test_verification_failure_leaves_the_original_untouched(self) -> None:
        real_copy = MODULE.copy_entry

        def corrupting_copy(source: str, destination: str) -> None:
            real_copy(source, destination)
            if os.path.isdir(destination) and not os.path.islink(destination):
                Path(destination, "gateway.db").write_bytes(b"corrupted")

        with mock.patch.object(MODULE, "copy_entry", corrupting_copy):
            with self.assertRaisesRegex(MODULE.RelocationError, "verification failed"):
                MODULE.relocate(self.source, self.target, STAMP, require_cross_device=False)
        self.assertFalse(self.source.is_symlink())
        self.assertFalse((self.gateway / f"backups.pre-relocate-{STAMP}").exists())
        self.assertEqual((self.source / "vision-observation-95e724cc06c0" / "gateway.db").read_bytes(), b"gateway-bytes")
        self.assertFalse((self.target / "vision-observation-95e724cc06c0").exists())

    def test_same_filesystem_is_refused_by_default(self) -> None:
        with self.assertRaisesRegex(MODULE.RelocationError, "same filesystem"):
            MODULE.relocate(self.source, self.target, STAMP)


if __name__ == "__main__":
    unittest.main()
