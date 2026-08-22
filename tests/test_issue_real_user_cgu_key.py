import importlib.util
import json
import sys
import tempfile
import unittest
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
        "phone": "0400000000",
        "external_user_id": "test-user-1",
        "provider": "manual_trial",
        "gateway_base_url": "https://goldencode.instmarket.com.au:1443",
        "client_version": "1.2.3",
        "plan_id": "plan_internal_high_quota_image_v1",
        "scope": "code",
        "entitlement_end": "2027-01-15T00:00:00.000Z",
        "key_expires_at": "2027-01-15T00:00:00.000Z",
        "rpm": 10,
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


def create_response():
    return {
        "created": True,
        "idempotent_replay": False,
        "subject": {"id": "subject-1"},
        "credential": {
            "key": "cgu_live_test-only-value",
            "key_prefix": "safe-unified-prefix",
            "issued_at": "2026-08-05T00:00:00.000Z",
            "expires_at": "2027-01-15T00:00:00.000Z",
        },
    }


def entitlement_response():
    return {
        "applied": True,
        "entitlement": {
            "id": "entitlement-1",
            "plan_id": "plan_internal_high_quota_image_v1",
            "state": "active",
            "period_start": "2026-08-05T00:00:00.000Z",
            "period_end": "2027-01-15T00:00:00.000Z",
        },
    }


def resolved_response():
    return {
        "valid": True,
        "subject": {"id": "subject-1"},
        "codex_gateway": {
            "api_key": "cgw.safe-cgw-prefix.test-only",
            "key_prefix": "cgw.safe-cgw-prefix",
            "endpoint_base_url": "https://goldencode.instmarket.com.au:1443/v1",
            "credential_validation_url": (
                "https://goldencode.instmarket.com.au:1443/gateway/credentials/current"
            ),
        },
        "medevidence": {"api_key": "mev2_test-only", "key_prefix": "safe-med-prefix"},
    }


def current_response():
    return {
        "valid": True,
        "subject": {"id": "subject-1"},
        "credential": {
            "id": "credential-1",
            "prefix": "cgw.safe-cgw-prefix",
            "scope": "code",
            "expires_at": "2027-01-15T00:00:00.000Z",
            "status": "active",
            "rate": {},
        },
        "entitlement": {
            "state": "active",
            "feature_policy": {"capabilities": ["chat", "image_generation"]},
        },
    }


class IssueRealUserKeyTests(unittest.TestCase):
    def test_success_validates_r760_and_writes_r760_handoff(self):
        with tempfile.TemporaryDirectory() as directory:
            args = arguments(directory)
            with (
                mock.patch.object(ISSUE, "get_billing_admin_token", return_value="admin-token"),
                mock.patch.object(ISSUE, "create_subject", return_value=create_response()),
                mock.patch.object(ISSUE, "grant_entitlement", return_value=entitlement_response()),
                mock.patch.object(ISSUE, "resolve_opaque_key", return_value=resolved_response()),
                mock.patch.object(ISSUE, "current_credential", return_value=current_response()),
                mock.patch.object(ISSUE, "update_user", return_value={}),
                mock.patch.object(ISSUE, "update_key", return_value={}) as update_key,
                mock.patch.object(ISSUE, "tighten_file_permissions"),
            ):
                result = ISSUE.issue_key(args)

            self.assertEqual(result["issued"], "ok")
            self.assertEqual(result["authority_mode"], "r760_only")
            self.assertEqual(result["r760_validation"], "ok")
            self.assertEqual(result["client_version"], "1.2.3")
            self.assertEqual(result["codex_gateway_prefix"], "cgw.safe-cgw-prefix")
            update_key.assert_called_once()
            self.assertEqual(update_key.call_args.args[1], "safe-cgw-prefix")
            self.assertNotIn("azure", json.dumps(result).lower())
            handoff = json.loads(Path(result["handoff_path"]).read_text(encoding="utf-8"))
            self.assertEqual(handoff["authority_mode"], "r760_only")
            self.assertEqual(handoff["client_version"], "1.2.3")
            self.assertEqual(handoff["base_url"], "https://goldencode.instmarket.com.au:1443")
            self.assertEqual(
                handoff["openai_compatible_base_url"],
                "https://goldencode.instmarket.com.au:1443/v1",
            )
            self.assertNotIn("0400000000", Path(result["handoff_path"]).name)

    def test_r760_resolution_failure_disables_new_subject_without_handoff(self):
        with tempfile.TemporaryDirectory() as directory:
            args = arguments(directory)
            resolved = resolved_response()
            resolved["codex_gateway"]["endpoint_base_url"] = "https://wrong.example/v1"
            with (
                mock.patch.object(ISSUE, "get_billing_admin_token", return_value="admin-token"),
                mock.patch.object(ISSUE, "create_subject", return_value=create_response()),
                mock.patch.object(ISSUE, "grant_entitlement", return_value=entitlement_response()),
                mock.patch.object(ISSUE, "resolve_opaque_key", return_value=resolved),
                mock.patch.object(ISSUE, "current_credential", return_value=current_response()),
                mock.patch.object(ISSUE, "update_user", return_value={}),
                mock.patch.object(ISSUE, "update_key", return_value={}),
                mock.patch.object(ISSUE, "disable_subject_best_effort", return_value=True) as disable,
            ):
                with self.assertRaisesRegex(ISSUE.IssueError, "unexpected Gateway endpoint"):
                    ISSUE.issue_key(args)

            disable.assert_called_once()
            self.assertEqual(list(Path(directory).glob("*.json")), [])

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

    def test_desktop_validation_requests_send_the_client_version(self):
        args = arguments("unused")
        with mock.patch.object(ISSUE, "http_json", return_value={}) as http:
            ISSUE.resolve_opaque_key(args, args.gateway_base_url, "cgu_live_test")
            ISSUE.current_credential(args, args.gateway_base_url, "cgw.test")

        resolve_headers = http.call_args_list[0].args[2]
        current_headers = http.call_args_list[1].args[2]
        self.assertEqual(resolve_headers[ISSUE.DESKTOP_VERSION_HEADER], "1.2.3")
        self.assertEqual(current_headers[ISSUE.DESKTOP_VERSION_HEADER], "1.2.3")


if __name__ == "__main__":
    unittest.main()
