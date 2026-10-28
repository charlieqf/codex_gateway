import pathlib
import runpy
import sys
import types
import unittest
from unittest.mock import patch

from gateway_release_idle import wait_for_natural_idle


class ReleaseIdleTests(unittest.TestCase):
    def exercise(self, status, timeout=60, stable_seconds=30):
        self.now = 0

        def sleep(seconds):
            self.now += seconds

        wait_for_natural_idle(lambda: status(self.now), timeout=timeout,
                              stable_seconds=stable_seconds,
                              monotonic=lambda: self.now, sleep=sleep)

    def test_keeps_admission_open_until_stable_idle(self):
        self.exercise(lambda _: dict(draining=False, active_requests=0, active_work=0))
        self.assertEqual(self.now, 30)

    def test_new_work_restarts_idle_window(self):
        self.exercise(lambda now: dict(draining=False, active_requests=int(now == 20), active_work=0))
        self.assertEqual(self.now, 52)

    def test_background_work_alone_blocks_release(self):
        with self.assertRaisesRegex(RuntimeError, "production unchanged"):
            self.exercise(lambda _: dict(draining=False, active_requests=0, active_work=1))
        self.assertEqual(self.now, 60)

    def test_busy_traffic_never_forces_a_drain(self):
        with self.assertRaisesRegex(RuntimeError, "production unchanged"):
            self.exercise(lambda _: dict(draining=False, active_requests=1, active_work=1))

    def test_invalid_or_draining_runtime_is_not_idle(self):
        for state in [dict(draining=True, active_requests=0, active_work=0),
                      dict(draining=False, active_requests=False, active_work=0),
                      dict(draining=False, active_requests=0)]:
            with self.subTest(state=state), self.assertRaises(RuntimeError):
                self.exercise(lambda _: state)

    def test_bypass_and_shortened_window_are_rejected_before_host_access(self):
        script = pathlib.Path(__file__).with_name("deploy-goldencode-d-r760.py")
        for flag in ("--drain-without-idle", "--idle-stable-seconds=5"):
            with self.subTest(flag=flag), patch.dict(sys.modules, {"fcntl": types.SimpleNamespace()}), \
                 patch.object(sys, "argv", [str(script), "f" * 40, flag]), \
                 patch("subprocess.run") as run, patch("pathlib.Path.open") as opening:
                with self.assertRaisesRegex(ValueError, "bypassing"):
                    runpy.run_path(str(script), run_name="__main__")
                run.assert_not_called()
                opening.assert_not_called()


if __name__ == "__main__":
    unittest.main()
