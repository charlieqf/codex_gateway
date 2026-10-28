import importlib.util
import pathlib
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("vision_preflight", pathlib.Path(__file__).with_name("run-vision-preflight-r760.py"))
preflight = importlib.util.module_from_spec(spec)
spec.loader.exec_module(preflight)


class ProviderMountTest(unittest.TestCase):
    def test_mounts_only_required_files_including_indirect_keys(self):
        with tempfile.TemporaryDirectory() as folder:
            root = pathlib.Path(folder)
            for name in ("xai.txt", "gateway.db", "fallback.txt"):
                (root / name).write_text("fixture-only")
            meta = {"Config": {"Env": ["MEDCODE_VISION_XAI_API_KEY_ENV=XAI_KEY",
                    "XAI_KEY_FILE=/state/xai.txt", "GATEWAY_SQLITE_PATH=/state/gateway.db",
                    "MEDCODE_IMAGE_BILLING_FALLBACK_KEYS_FILE=/secrets/fallback.txt"]},
                    "Mounts": [{"Source": str(root), "Destination": "/state"},
                               {"Source": str(root / "fallback.txt"), "Destination": "/secrets/fallback.txt"}]}
            self.assertEqual(preflight.provider_file_mounts(meta), {
                "/state/xai.txt": str(root / "xai.txt"), "/secrets/fallback.txt": str(root / "fallback.txt")})

    def test_missing_unmapped_or_directory_secrets_fail_before_start(self):
        with tempfile.TemporaryDirectory() as folder:
            for filename in ("/unmapped/key", "/state/missing", "/state"):
                with self.subTest(filename=filename), self.assertRaises(RuntimeError):
                    preflight.provider_file_mounts({"Config": {"Env": ["MEDCODE_VISION_XAI_API_KEY_FILE=" + filename]},
                        "Mounts": [{"Source": folder, "Destination": "/state"}]})


if __name__ == "__main__":
    unittest.main()
