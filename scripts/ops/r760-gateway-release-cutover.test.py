"""Exercise the release script with a temporary host root and mocked Docker/SQLite."""
import hashlib
import json
import pathlib
import runpy
import subprocess
import tempfile
import types
import unittest
from unittest.mock import MagicMock, patch


SCRIPT = pathlib.Path(__file__).with_name("r760-gateway-release-20260923-cutover.py")
REV = "f" * 40


class CutoverTests(unittest.TestCase):
    def exercise(self, *, recovery_fails=False, replacement_fails=False, interrupt=False):
        commands = []
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            backup = root / "backups" / f"release-{REV[:12]}"
            backup.mkdir(parents=True)
            override = root / "shared/config/compose.r760.override.yml"
            override.parent.mkdir(parents=True)
            original = "services:\n  gateway:\n    image: old-image\n"
            override.write_text(original)
            state = {"revision": REV, "old_container_id": "old-id", "old_current": str((root / "current").resolve()),
                     "override_sha256": hashlib.sha256(override.read_bytes()).hexdigest(),
                     "release_links": [], "old_image": "old-image"}
            (backup / "deployment.json").write_text(json.dumps(state))
            old = {"Id": "old-id", "Mounts": [{"Destination": "/var/lib/codex-gateway", "Source": str(root)}]}
            candidate = {"Id": "candidate-id", "Config": {"Labels": {"org.opencontainers.image.revision": REV}}}

            def run(args, **kwargs):
                commands.append(args)
                if args[:2] == ["docker", "inspect"]:
                    return subprocess.CompletedProcess(args, 0, json.dumps([old if args[2].endswith("gateway-1") else candidate]), "")
                if args[0] == "python3":
                    if "--resume" in args:
                        return subprocess.CompletedProcess(args, int(recovery_fails), "", "synthetic resume failure" if recovery_fails else "")
                    if interrupt:
                        raise KeyboardInterrupt()
                    return subprocess.CompletedProcess(args, int(not replacement_fails), "", "synthetic post-signal drain failure")
                if args[:2] == ["docker", "compose"]:
                    # Fail the new release up, but allow rollback to the old release.
                    failed = replacement_fails and "up" in args and any(REV in arg for arg in args)
                    return subprocess.CompletedProcess(args, int(failed), "", "synthetic replacement failure" if failed else "")
                raise AssertionError(f"Unexpected command: {args}")

            real_path = pathlib.Path

            def host_path(value):
                return root if value == "/opt/codex-gateway-r760" else real_path(value)

            database = MagicMock()
            database.__enter__.return_value.execute.return_value.fetchone.return_value = (37,)
            # Production releases this lock on process exit; this test runs in-process.
            locking = types.SimpleNamespace(flock=lambda handle, *_: handle.close(), LOCK_EX=1, LOCK_NB=2)
            with patch("pathlib.Path", side_effect=host_path), patch("subprocess.run", side_effect=run), \
                 patch("sqlite3.connect", return_value=database), patch.dict("sys.modules", {"fcntl": locking}), \
                 patch("sys.argv", [str(SCRIPT), REV, "38"]):
                with self.assertRaises(KeyboardInterrupt if interrupt else RuntimeError) as raised:
                    runpy.run_path(str(SCRIPT), run_name="__main__")
            self.assertEqual(override.read_text(), original)
            return commands, str(raised.exception)

    def test_drain_failure_resumes_original_instance_without_recreating(self):
        commands, _ = self.exercise()
        drain, resume = [args for args in commands if args[0] == "python3"]
        self.assertEqual(drain[-2:], ["--container", "old-id"])
        self.assertEqual(resume, drain + ["--resume", "--timeout", "30"])
        self.assertFalse(any(args[:2] == ["docker", "compose"] for args in commands))

    def test_failed_resume_is_not_reported_as_recovered(self):
        _, message = self.exercise(recovery_fails=True)
        self.assertIn("could not verify recovery", message)

    def test_interrupted_drain_also_resumes(self):
        commands, _ = self.exercise(interrupt=True)
        self.assertTrue(any("--resume" in args for args in commands))

    def test_replacement_failure_uses_rollback_not_resume(self):
        commands, _ = self.exercise(replacement_fails=True)
        self.assertFalse(any("--resume" in args for args in commands))
        ups = [args for args in commands if args[:2] == ["docker", "compose"] and "up" in args]
        self.assertEqual(len(ups), 2)
        self.assertTrue(any(REV in arg for arg in ups[0]))
        self.assertFalse(any(REV in arg for arg in ups[1]))


if __name__ == "__main__":
    unittest.main()
