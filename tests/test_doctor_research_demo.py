import contextlib
import hashlib
import importlib.util
import io
import json
import os
import stat
import sys
import tempfile
import threading
import unittest
from unittest import mock
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "doctor-research-demo.py"
SPEC = importlib.util.spec_from_file_location("doctor_research_demo", SCRIPT)
assert SPEC and SPEC.loader
DEMO = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = DEMO
SPEC.loader.exec_module(DEMO)


RUN_ID = "drr_" + "a" * 32
TOKEN = "cgw_test_doctor_research_demo_token"
DOCTOR_NAME = "陆清声"
FILES = {
    "profile": ("陆清声_基础信息与研究方向.md", b"# profile\n"),
    "review": ("陆清声_相关领域前沿综述.md", b"# review\n"),
    "questions": (
        "陆清声_医生可能问机器人问题.txt",
        "问题一\n问题二\n问题三\n问题四\n问题五\n".encode(),
    ),
    "answers": ("陆清声_问题与答案.md", b"# answers\n"),
}


class DemoHandler(BaseHTTPRequestHandler):
    artifacts = {}
    rate_limit_result_remaining = 0
    rate_limit_download_remaining = 0

    def do_POST(self):
        if self.path != "/gateway/research/v1/doctor-runs":
            self.send_error(404)
            return
        self.assert_auth()
        assert self.headers["Idempotency-Key"].startswith("research:")
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        assert body["doctor"]["name"] == DOCTOR_NAME
        assert body["doctor"]["literature_identity"] == {
            "name": "Lu Qingsheng",
            "hospital": "Changhai Hospital",
            "department": "Vascular Surgery",
        }
        self.send_json({"run_id": RUN_ID, "status": "queued"}, status=202)

    def do_GET(self):
        self.assert_auth()
        if self.path == f"/gateway/research/v1/doctor-runs/{RUN_ID}":
            self.send_json(
                {
                    "run_id": RUN_ID,
                    "status": "succeeded",
                    "stage": "complete",
                    "progress": {"percent": 100},
                }
            )
            return
        if self.path == f"/gateway/research/v1/doctor-runs/{RUN_ID}/result":
            if self.rate_limit_result_remaining > 0:
                type(self).rate_limit_result_remaining -= 1
                self.send_rate_limit()
                return
            self.send_json(
                {
                    "schema_version": "doctor_research_result.v1",
                    "run_id": RUN_ID,
                    "artifacts": list(self.artifacts.values()),
                }
            )
            return
        for artifact in self.artifacts.values():
            if self.path == artifact["download_url"]:
                if self.rate_limit_download_remaining > 0:
                    type(self).rate_limit_download_remaining -= 1
                    self.send_rate_limit()
                    return
                content = FILES[artifact["kind"]][1]
                self.send_response(200)
                self.send_header("Content-Type", artifact["content_type"])
                self.send_header("Content-Length", str(len(content)))
                self.send_header("Cache-Control", "private, no-store")
                self.send_header("X-Content-Type-Options", "nosniff")
                self.end_headers()
                self.wfile.write(content)
                return
        self.send_error(404)

    def assert_auth(self):
        assert self.headers["Authorization"] == f"Bearer {TOKEN}"

    def send_json(self, value, status=200):
        payload = json.dumps(value, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def send_rate_limit(self):
        payload = json.dumps(
            {
                "error": {
                    "code": "rate_limit_exceeded",
                    "message": "Read rate limit exceeded.",
                }
            }
        ).encode()
        self.send_response(429)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Retry-After", "1")
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, format, *args):
        pass


def artifact_manifest():
    result = {}
    for index, (kind, (filename, content)) in enumerate(FILES.items()):
        artifact_id = f"dra_{index:032x}"
        content_type = (
            "text/plain; charset=utf-8"
            if kind == "questions"
            else "text/markdown; charset=utf-8"
        )
        result[kind] = {
            "artifact_id": artifact_id,
            "kind": kind,
            "filename": filename,
            "content_type": content_type,
            "size_bytes": len(content),
            "sha256": hashlib.sha256(content).hexdigest(),
            "download_url": (
                f"/gateway/research/v1/artifacts/{artifact_id}/download"
            ),
        }
    return result


class DoctorResearchDemoTests(unittest.TestCase):
    def setUp(self):
        DemoHandler.artifacts = artifact_manifest()
        DemoHandler.rate_limit_result_remaining = 0
        DemoHandler.rate_limit_download_remaining = 0

    def test_end_to_end_preserves_four_localized_filenames(self):
        server = ThreadingHTTPServer(("127.0.0.1", 0), DemoHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                key_file = root / "research.key"
                key_file.write_text(TOKEN, encoding="utf-8")
                if os.name != "nt":
                    key_file.chmod(stat.S_IRUSR | stat.S_IWUSR)
                output = root / "output"
                stdout = io.StringIO()
                with contextlib.redirect_stdout(stdout):
                    status = DEMO.main(
                        [
                            "--doctor-name",
                            DOCTOR_NAME,
                            "--hospital",
                            "上海长海医院",
                            "--department",
                            "血管外科",
                            "--literature-name",
                            "Lu Qingsheng",
                            "--literature-hospital",
                            "Changhai Hospital",
                            "--literature-department",
                            "Vascular Surgery",
                            "--official-profile-url",
                            "https://hospital.example/doctor/lu",
                            "--api-key-file",
                            str(key_file),
                            "--base-url",
                            f"http://127.0.0.1:{server.server_port}",
                            "--output-dir",
                            str(output),
                            "--poll-seconds",
                            "2",
                        ]
                    )
                self.assertEqual(status, 0, stdout.getvalue())
                run_directory = output / RUN_ID
                self.assertEqual(
                    sorted(path.name for path in run_directory.iterdir()),
                    sorted(filename for filename, _ in FILES.values()),
                )
                final = json.loads(stdout.getvalue().splitlines()[-1])
                self.assertEqual(final["outcome"], "succeeded")
                self.assertNotIn(TOKEN, stdout.getvalue())
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)

    def test_requires_all_three_literature_identity_anchors(self):
        args = DEMO.parse_args(
            [
                "--doctor-name",
                DOCTOR_NAME,
                "--hospital",
                "上海长海医院",
                "--department",
                "血管外科",
                "--literature-name",
                "Lu Qingsheng",
                "--official-profile-url",
                "https://hospital.example/doctor/lu",
            ]
        )
        with self.assertRaisesRegex(
            DEMO.DemoError, "must be supplied together"
        ):
            DEMO.build_payload(args)

    def test_retries_bounded_result_and_artifact_gets_after_429(self):
        DemoHandler.rate_limit_result_remaining = 1
        DemoHandler.rate_limit_download_remaining = 1
        server = ThreadingHTTPServer(("127.0.0.1", 0), DemoHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                key_file = root / "research.key"
                key_file.write_text(TOKEN, encoding="utf-8")
                if os.name != "nt":
                    key_file.chmod(stat.S_IRUSR | stat.S_IWUSR)
                stdout = io.StringIO()
                with (
                    contextlib.redirect_stdout(stdout),
                    mock.patch.object(DEMO.time, "sleep", return_value=None),
                ):
                    status = DEMO.main(
                        [
                            "--doctor-name",
                            DOCTOR_NAME,
                            "--hospital",
                            "上海长海医院",
                            "--department",
                            "血管外科",
                            "--literature-name",
                            "Lu Qingsheng",
                            "--literature-hospital",
                            "Changhai Hospital",
                            "--literature-department",
                            "Vascular Surgery",
                            "--official-profile-url",
                            "https://hospital.example/doctor/lu",
                            "--api-key-file",
                            str(key_file),
                            "--base-url",
                            f"http://127.0.0.1:{server.server_port}",
                            "--output-dir",
                            str(root / "output"),
                        ]
                    )
                self.assertEqual(status, 0, stdout.getvalue())
                events = [
                    json.loads(line) for line in stdout.getvalue().splitlines()
                ]
                retries = [
                    event
                    for event in events
                    if event.get("event") == "rate_limit_retry"
                ]
                self.assertEqual(len(retries), 2)
                self.assertTrue((root / "output" / RUN_ID).is_dir())
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)

    def test_rejects_traversal_in_server_filename(self):
        manifest = artifact_manifest()
        manifest["profile"]["filename"] = "../陆清声_基础信息与研究方向.md"
        with self.assertRaisesRegex(DEMO.DemoError, "unsafe"):
            DEMO.validate_manifest(
                {
                    "schema_version": "doctor_research_result.v1",
                    "run_id": RUN_ID,
                    "artifacts": list(manifest.values()),
                },
                run_id=RUN_ID,
                doctor_name=DOCTOR_NAME,
            )

    def test_rejects_non_loopback_plain_http(self):
        with self.assertRaisesRegex(DEMO.DemoError, "literal loopback"):
            DEMO.validate_base_url("http://example.com")

    def test_requires_exact_three_markdown_and_one_text_contract(self):
        manifest = artifact_manifest()
        manifest["questions"]["filename"] = "陆清声_问题.md"
        with self.assertRaisesRegex(DEMO.DemoError, "unsafe"):
            DEMO.validate_manifest(
                {
                    "schema_version": "doctor_research_result.v1",
                    "run_id": RUN_ID,
                    "artifacts": list(manifest.values()),
                },
                run_id=RUN_ID,
                doctor_name=DOCTOR_NAME,
            )


if __name__ == "__main__":
    unittest.main()
