import copy
import importlib.util
import json
import pathlib
import subprocess
import sys
import tempfile
import unittest
from unittest import mock


spec = importlib.util.spec_from_file_location("prepare_vision", pathlib.Path(__file__).with_name("prepare-deepseek-vision.py"))
prepare = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prepare)


class PrepareVisionTest(unittest.TestCase):
    def setUp(self):
        self.registry = {
            "goldencode": {"vision": {"runtime": "xai", "upstreamModel": "live-vision-model",
                                       "contextWindow": 200000, "maxOutputTokens": 128000,
                                       "enabled": True, "reasoning": {"effort": "medium"}}},
            "goldencode-d": {"runtime": "pool", "pool": {"members": [{"id": "deepseek"}]}},
            "goldencode-local": {"enabled": True},
        }

    def env(self):
        return ("# preserved\r\nSECRET=fixture-only\r\nMEDCODE_PUBLIC_MODELS_JSON='" +
                json.dumps(self.registry) + "'\r\nANOTHER=value\r\n").encode()

    def test_only_target_vision_changes_and_other_env_bytes_survive(self):
        original = self.env()
        result, changed = prepare.prepare_env(original)
        self.assertTrue(changed)
        self.assertEqual(result.splitlines(keepends=True)[:2], original.splitlines(keepends=True)[:2])
        self.assertEqual(result.splitlines(keepends=True)[3:], original.splitlines(keepends=True)[3:])
        expected = copy.deepcopy(self.registry)
        expected["goldencode-d"]["vision"] = copy.deepcopy(expected["goldencode"]["vision"])
        self.assertEqual(json.loads(result.splitlines()[2].split(b"=", 1)[1]), expected)
        self.assertEqual(prepare.prepare_env(result), (result, False))

    def test_preserves_inherited_and_custom_reasoning_without_injecting_defaults(self):
        for reasoning in (None, {"effort": "xhigh", "supportedEfforts": ["low", "xhigh"]},
                          {"effort": "high", "supported_efforts": ["low", "high"],
                           "legacy_aliases": {"max": "high"}}):
            if reasoning is None:
                self.registry["goldencode"]["vision"].pop("reasoning", None)
            else:
                self.registry["goldencode"]["vision"]["reasoning"] = reasoning
            result, _ = prepare.prepare_env(self.env())
            registry = json.loads(result.splitlines()[2].split(b"=", 1)[1])
            self.assertEqual(registry["goldencode-d"]["vision"], registry["goldencode"]["vision"])

    def test_rejects_conflicting_or_disabled_target_route(self):
        for value in ({"enabled": False}, {"runtime": "xai", "upstreamModel": "different"}):
            self.registry["goldencode-d"]["vision"] = value
            with self.assertRaises(ValueError):
                prepare.prepare_env(self.env())

    def test_rejects_unusable_source(self):
        for key, value in (("enabled", False), ("runtime", "other"), ("upstreamModel", ""),
                           ("contextWindow", 0), ("maxOutputTokens", True)):
            with self.subTest(key=key):
                original = self.registry["goldencode"]["vision"][key]
                self.registry["goldencode"]["vision"][key] = value
                with self.assertRaises(ValueError):
                    prepare.prepare_env(self.env())
                self.registry["goldencode"]["vision"][key] = original

    def test_rejects_missing_duplicate_or_shadowed_registry(self):
        for value in (b"SECRET=fixture", self.env() + self.env(),
                      self.env() + b"MEDCODE_PUBLIC_MODELS_JSON_FILE=/protected/registry.json\n"):
            with self.assertRaises(ValueError):
                prepare.prepare_env(value)

    def test_cli_dry_run_preserves_source_and_never_overwrites_output(self):
        with tempfile.TemporaryDirectory() as folder:
            source = pathlib.Path(folder) / "source.env"
            candidate = pathlib.Path(folder) / "candidate.env"
            source.write_bytes(self.env())
            command = [sys.executable, str(pathlib.Path(prepare.__file__)), "--env-file", str(source)]
            dry = subprocess.run(command, capture_output=True, text=True, check=True)
            self.assertFalse(json.loads(dry.stdout)["candidate_written"])
            self.assertNotIn("fixture-only", dry.stdout + dry.stderr)
            self.assertEqual(source.read_bytes(), self.env())
            subprocess.run(command + ["--output", str(candidate)], capture_output=True, check=True)
            expected = candidate.read_bytes()
            again = subprocess.run(command + ["--output", str(candidate)], capture_output=True)
            self.assertNotEqual(again.returncode, 0)
            self.assertEqual(candidate.read_bytes(), expected)
            self.assertEqual(source.read_bytes(), self.env())

    def test_candidate_is_not_published_when_flush_fails(self):
        with tempfile.TemporaryDirectory() as folder:
            candidate = pathlib.Path(folder) / "candidate.env"
            with mock.patch.object(prepare.os, "fsync", side_effect=OSError("simulated disk failure")):
                with self.assertRaises(OSError):
                    prepare.write_candidate(candidate, self.env())
            self.assertFalse(candidate.exists())
            self.assertEqual(list(pathlib.Path(folder).iterdir()), [])


if __name__ == "__main__":
    unittest.main()
