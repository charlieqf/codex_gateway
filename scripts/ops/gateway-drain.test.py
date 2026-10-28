import importlib.util
import io
import json
import pathlib
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("gateway_drain", pathlib.Path(__file__).with_name("gateway-drain.py"))
drain = importlib.util.module_from_spec(spec)
spec.loader.exec_module(drain)
metadata = json.dumps({"id": "pinned-container", "command": ["node", "/app/apps/gateway/dist/index.js"]})


class DrainTests(unittest.TestCase):
    def test_unsupported_runtime_never_receives_signal(self):
        with patch.object(drain, "run", side_effect=[metadata, "null"]) as run, patch("sys.argv", ["drain"]):
            with self.assertRaisesRegex(RuntimeError, "no drain protocol"):
                drain.main()
            self.assertFalse(any("kill" in call.args[0] for call in run.call_args_list))

    def test_waits_for_background_work_and_pins_instance(self):
        states = [{"draining": False, "active_requests": 1, "active_work": 1},
                  {"draining": True, "active_requests": 0, "active_work": 1},
                  {"draining": True, "active_requests": 0, "active_work": 0}]
        with patch.object(drain, "run", side_effect=[metadata, ""]) as run, \
             patch.object(drain, "wait_for_natural_idle"), \
             patch.object(drain, "status", side_effect=states) as status, \
             patch.object(drain.time, "sleep") as sleep, patch("sys.argv", ["drain"]), patch("sys.stdout", io.StringIO()):
            drain.main()
            self.assertEqual(status.call_count, 3)
            self.assertTrue(all(call.args == ("pinned-container",) for call in status.call_args_list))
            sleep.assert_called_once_with(1)
            run.assert_any_call(["docker", "kill", "--signal=SIGUSR2", "pinned-container"])

    def exercise_shared_gate(self, *, busy=False, racing=False, interrupt=False, resume_failure=False, timeout=900, idle_seconds=30):
        clock = [0]
        signals = []
        closed = [False]

        def run(args):
            if args[1] == "inspect":
                return metadata
            signal = args[2]
            signals.append((clock[0], signal))
            if signal == "--signal=SIGUSR2":
                closed[0] = True
                if interrupt:
                    raise KeyboardInterrupt()
            elif not resume_failure:
                closed[0] = False
            return ""

        def status(container):
            self.assertEqual(container, "pinned-container")
            work = int(busy or clock[0] < 10 or (closed[0] and racing))
            return dict(draining=closed[0], active_requests=0, active_work=work)

        with patch.object(drain, "run", side_effect=run), patch.object(drain, "status", side_effect=status), \
             patch.object(drain.time, "monotonic", side_effect=lambda: clock[0]), \
             patch.object(drain.time, "sleep", side_effect=lambda seconds: clock.__setitem__(0, clock[0] + seconds)), \
             patch("sys.argv", ["drain", "--timeout", str(timeout), "--idle-timeout", "60", "--idle-stable-seconds", str(idle_seconds)]), \
             patch("sys.stdout", io.StringIO()) as stdout, patch("sys.stderr", io.StringIO()) as stderr:
            if resume_failure:
                with self.assertRaisesRegex(RuntimeError, "could not verify recovery"):
                    drain.main()
            elif busy or racing or interrupt:
                with self.assertRaises(KeyboardInterrupt if interrupt else RuntimeError):
                    drain.main()
            else:
                drain.main()
                self.assertTrue(json.loads(stdout.getvalue())["draining"])
            if timeout > 30:
                self.assertIn(f"requested --timeout {timeout}s", stderr.getvalue())
                self.assertIn("using 30s", stderr.getvalue())
            else:
                self.assertEqual(stderr.getvalue(), "")
        return signals, closed[0]

    def test_busy_traffic_times_out_without_closing_admission(self):
        signals, closed = self.exercise_shared_gate(busy=True)
        self.assertEqual(signals, [])
        self.assertFalse(closed)

    def test_every_caller_waits_for_background_work_and_stable_idle(self):
        signals, closed = self.exercise_shared_gate()
        self.assertEqual(signals, [(40, "--signal=SIGUSR2")])
        self.assertTrue(closed)

    def test_explicit_short_window_still_waits_for_zero_work(self):
        signals, closed = self.exercise_shared_gate(idle_seconds=5)
        self.assertEqual(signals, [(16, "--signal=SIGUSR2")])
        self.assertTrue(closed)

    def test_short_window_retains_30_second_drain_and_resume_on_race(self):
        signals, closed = self.exercise_shared_gate(idle_seconds=5, racing=True)
        self.assertEqual(signals, [(16, "--signal=SIGUSR2"), (46, "--signal=SIGCONT")])
        self.assertFalse(closed)

    def test_short_window_never_signals_while_work_remains(self):
        signals, closed = self.exercise_shared_gate(idle_seconds=5, busy=True)
        self.assertEqual(signals, [])
        self.assertFalse(closed)

    def test_long_timeout_cannot_hold_admission_closed_for_900_seconds(self):
        signals, closed = self.exercise_shared_gate(racing=True)
        self.assertEqual(signals, [(40, "--signal=SIGUSR2"), (70, "--signal=SIGCONT")])
        self.assertFalse(closed)

    def test_legacy_timeout_warns_without_corrupting_json_output(self):
        self.exercise_shared_gate(timeout=180)

    def test_supported_timeout_has_no_warning(self):
        self.exercise_shared_gate(timeout=30)

    def test_interrupted_signal_is_resumed_on_the_pinned_instance(self):
        signals, closed = self.exercise_shared_gate(interrupt=True)
        self.assertEqual(signals[-1], (40, "--signal=SIGCONT"))
        self.assertFalse(closed)

    def test_resume_failure_is_not_reported_as_recovery(self):
        _, closed = self.exercise_shared_gate(racing=True, resume_failure=True)
        self.assertTrue(closed)

    def test_resume_requires_confirmed_open_admission(self):
        states = [{"draining": True, "active_requests": 0, "active_work": 0},
                  {"draining": False, "active_requests": 1, "active_work": 1}]
        with patch.object(drain, "run", side_effect=[metadata, ""]) as run, \
             patch.object(drain, "status", side_effect=states), patch("sys.argv", ["drain", "--resume"]), patch("sys.stdout", io.StringIO()):
            drain.main()
            run.assert_any_call(["docker", "kill", "--signal=SIGCONT", "pinned-container"])


if __name__ == "__main__":
    unittest.main()
