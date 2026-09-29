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
             patch.object(drain, "status", side_effect=states) as status, \
             patch.object(drain.time, "sleep") as sleep, patch("sys.argv", ["drain"]), patch("sys.stdout", io.StringIO()):
            drain.main()
            self.assertEqual(status.call_count, 3)
            self.assertTrue(all(call.args == ("pinned-container",) for call in status.call_args_list))
            sleep.assert_called_once_with(1)
            run.assert_any_call(["docker", "kill", "--signal=SIGUSR2", "pinned-container"])

    def test_resume_requires_confirmed_open_admission(self):
        states = [{"draining": True, "active_requests": 0, "active_work": 0},
                  {"draining": False, "active_requests": 1, "active_work": 1}]
        with patch.object(drain, "run", side_effect=[metadata, ""]) as run, \
             patch.object(drain, "status", side_effect=states), patch("sys.argv", ["drain", "--resume"]), patch("sys.stdout", io.StringIO()):
            drain.main()
            run.assert_any_call(["docker", "kill", "--signal=SIGCONT", "pinned-container"])


if __name__ == "__main__":
    unittest.main()
