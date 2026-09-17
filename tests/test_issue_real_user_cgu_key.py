import importlib.util
import io
import json
import sys
import tempfile
import unittest
from contextlib import redirect_stderr
from pathlib import Path
from types import SimpleNamespace
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))
SPEC = importlib.util.spec_from_file_location(
    "issue_real_user_cgu_key", SCRIPTS / "issue-real-user-cgu-key.py"
)
assert SPEC and SPEC.loader
ISSUE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ISSUE)


def arguments(output_dir: str, **overrides):
    values = {
        "name": "Test User",
        "phone": "13800138000",
        "external_user_id": "test-user-1",
        "provider": "manual_trial",
        "gateway_base_url": "https://goldencode.instmarket.com.au:1443",
        "client_version": "1.2.3",
        "plan_id": "plan_internal_high_quota_image_v1",
        "scope": "code",
        "entitlement_end": "2027-01-15T00:00:00.000Z",
        "key_expires_at": "2027-01-15T00:00:00.000Z",
        "rpm": 20,
        "rpd": 200,
        "concurrent": 4,
        "output_dir": output_dir,
        "billing_admin_token_env": "GATEWAY_BILLING_ADMIN_TOKEN",
        "vm_host": "r760.test",
        "vm_user": "root",
        "vm_port": 7723,
        "ssh_key": "r760-key",
        "remote_repo": "/unused",
        "compose_project": "unused",
        "compose_file": "unused.yml",
        "gateway_service": "gateway",
        "gateway_container": "r760-gateway",
        "timeout_seconds": 45,
        "skip_credential_validation": False,
        "no_require_image_capability": False,
        "disable_on_failure": True,
        "what_if": False,
    }
    values.update(overrides)
    return SimpleNamespace(**values)


def job_response():
    return {
        "job_id": "rui_" + "a" * 32, "state": "succeeded", "external_user_id": "test-user-1",
        "display_name": "Test User", "created_at": "2026-09-17T00:00:00Z",
        "unified_key": "cgu_live_test-only-value",
        "result": {"subject_id": "subject-1", "key_prefix": "safe-unified-prefix",
                   "codex_gateway_prefix": "cgw.safe-cgw-prefix", "medevidence_prefix": "safe-med-prefix",
                   "plan_id": "plan_internal_high_quota_image_v1", "entitlement_state": "active",
                   "backing_key_expires_at": "2027-01-15T00:00:00.000Z", "entitlement_end": "2027-01-15T00:00:00.000Z",
                   "capabilities": ["chat", "image_generation"],
                   "rate": {"requestsPerMinute": 20, "requestsPerDay": 200, "concurrentRequests": 4}}
    }


class IssueRealUserKeyTests(unittest.TestCase):
    def test_cli_defaults_new_real_users_to_20_rpm(self):
        args = ISSUE.parse_args(
            [
                "--name",
                "Test User",
                "--phone",
                "13800138000",
                "--client-version",
                "1.2.3",
            ]
        )
        self.assertEqual(args.rpm, 20)

    def test_cli_rejects_real_user_rpm_below_20(self):
        with redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit):
                ISSUE.parse_args(
                    [
                        "--name",
                        "Test User",
                        "--phone",
                        "13800138000",
                        "--client-version",
                        "1.2.3",
                        "--rpm",
                        "10",
                    ]
                )

    def test_success_uses_only_durable_gateway_task_and_writes_handoff(self):
        with tempfile.TemporaryDirectory() as directory:
            args = arguments(directory)
            job = job_response()
            with (
                mock.patch.object(ISSUE, "get_billing_admin_token", return_value="admin-token"),
                mock.patch.object(ISSUE, "http_json", side_effect=[{"job_id": job["job_id"], "state": "running"}, job]) as http,
                mock.patch.object(ISSUE.time, "sleep"),
                mock.patch.object(ISSUE, "tighten_file_permissions"),
            ):
                result = ISSUE.issue_key(args)
            self.assertEqual(result["issued"], "ok")
            self.assertEqual(result["authority_mode"], "r760_only")
            self.assertEqual(result["r760_validation"], "ok")
            self.assertEqual(result["codex_gateway_prefix"], "cgw.safe-cgw-prefix")
            self.assertEqual(http.call_count, 2)
            self.assertEqual(http.call_args_list[0].args[2][ISSUE.DESKTOP_VERSION_HEADER], "1.2.3")
            self.assertTrue(http.call_args_list[0].args[1].endswith("/real-user-issue"))
            self.assertEqual(http.call_args_list[0].args[3]["phone"], "+8613800138000")
            handoff = json.loads(Path(result["handoff_path"]).read_text(encoding="utf-8"))
            self.assertEqual(handoff["key"], job["unified_key"])
            self.assertEqual(handoff["entitlement_period_end"], job["result"]["entitlement_end"])
            self.assertNotIn("13800138000", Path(result["handoff_path"]).name)

    def test_compensation_failure_leaves_gateway_as_recovery_owner(self):
        with tempfile.TemporaryDirectory() as directory:
            args = arguments(directory)
            job = {"job_id": "rui_" + "a" * 32, "state": "compensation_failed",
                   "compensation_error": {"code": "upstream_unavailable"}, "recovery_action": "retry-disable"}
            with (
                mock.patch.object(ISSUE, "get_billing_admin_token", return_value="admin-token"),
                mock.patch.object(ISSUE, "http_json", return_value=job) as http,
            ):
                with self.assertRaisesRegex(ISSUE.IssueError, "retry-disable"):
                    ISSUE.issue_key(args)
            http.assert_called_once()
            self.assertEqual(list(Path(directory).glob("*.json")), [])

    def test_resume_does_not_create_a_second_task(self):
        with tempfile.TemporaryDirectory() as directory:
            job = job_response()
            args = arguments(directory, resume_job=job["job_id"])
            with (
                mock.patch.object(ISSUE, "get_billing_admin_token", return_value="admin-token"),
                mock.patch.object(ISSUE, "http_json", side_effect=[
                    {**job, "state": "retryable"}, {**job, "state": "running"}, job]) as http,
                mock.patch.object(ISSUE.time, "sleep"),
                mock.patch.object(ISSUE, "tighten_file_permissions"),
            ):
                ISSUE.issue_key(args)
            posts = [call for call in http.call_args_list if call.args[0] == "POST"]
            self.assertEqual(len(posts), 1)
            self.assertTrue(posts[0].args[1].endswith("/resume"))

    def test_invalid_phone_or_provider_is_rejected_before_external_work(self):
        with tempfile.TemporaryDirectory() as directory:
            for overrides in ({"phone": "138-0013-8000"}, {"provider": "medevidence_billing"}):
                with mock.patch.object(ISSUE, "get_billing_admin_token") as token:
                    with self.assertRaises(ISSUE.IssueError):
                        ISSUE.issue_key(arguments(directory, **overrides))
                    token.assert_not_called()

    def test_resume_does_not_acknowledge_manual_review_automatically(self):
        with tempfile.TemporaryDirectory() as directory:
            job = {**job_response(), "state": "retryable", "requires_review": True}
            with (
                mock.patch.object(ISSUE, "get_billing_admin_token", return_value="admin-token"),
                mock.patch.object(ISSUE, "http_json", return_value=job) as http,
            ):
                with self.assertRaisesRegex(ISSUE.IssueError, "requires manual review"):
                    ISSUE.issue_key(arguments(directory, resume_job=job["job_id"]))
            http.assert_called_once()
            self.assertEqual(http.call_args.args[0], "GET")

    def test_skip_validation_is_rejected_before_issuance(self):
        with tempfile.TemporaryDirectory() as directory:
            args = arguments(directory, skip_credential_validation=True)
            with mock.patch.object(ISSUE, "get_billing_admin_token") as token:
                with self.assertRaisesRegex(ISSUE.IssueError, "no longer permitted"):
                    ISSUE.issue_key(args)
            token.assert_not_called()

    def test_what_if_does_not_echo_name_or_phone(self):
        with tempfile.TemporaryDirectory() as directory:
            args = arguments(directory, what_if=True, external_user_id=None)
            result = ISSUE.issue_key(args)
            rendered = json.dumps(result, ensure_ascii=False)
            self.assertNotIn(args.name, rendered)
            self.assertNotIn(args.phone, rendered)
            self.assertEqual(result["authority_mode"], "r760_only")
            self.assertEqual(result["r760_validation"], "required")

    def test_invalid_client_version_is_rejected_before_issuance(self):
        with tempfile.TemporaryDirectory() as directory:
            args = arguments(directory, client_version="1.2")
            with mock.patch.object(ISSUE, "get_billing_admin_token") as token:
                with self.assertRaisesRegex(ISSUE.IssueError, "strict SemVer"):
                    ISSUE.issue_key(args)
            token.assert_not_called()

    def test_operator_cannot_disable_gateway_compensation(self):
        with tempfile.TemporaryDirectory() as directory:
            with mock.patch.object(ISSUE, "get_billing_admin_token") as token:
                with self.assertRaisesRegex(ISSUE.IssueError, "Gateway-owned"):
                    ISSUE.issue_key(arguments(directory, disable_on_failure=False))
                token.assert_not_called()


if __name__ == "__main__":
    unittest.main()
