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
        "gateway_base_url": "https://gw.instmarket.com.au",
        "r760_base_url": "https://goldencode.instmarket.com.au:1443",
        "plan_id": "plan_internal_high_quota_image_v1",
        "scope": "code",
        "entitlement_end": "2027-01-15T00:00:00.000Z",
        "key_expires_at": "2027-01-15T00:00:00.000Z",
        "rpm": 10,
        "rpd": 200,
        "concurrent": 4,
        "output_dir": output_dir,
        "billing_admin_token_env": "GATEWAY_BILLING_ADMIN_TOKEN",
        "vm_host": "azure.test",
        "vm_user": "qian",
        "vm_port": 22,
        "ssh_key": "azure-key",
        "remote_repo": "/unused",
        "compose_project": "unused",
        "compose_file": "unused.yml",
        "gateway_service": "gateway",
        "gateway_container": "azure-gateway",
        "r760_vm_host": "r760.test",
        "r760_vm_user": "root",
        "r760_vm_port": 7723,
        "r760_ssh_key": "r760-key",
        "r760_gateway_container": "r760-gateway",
        "r760_backup_root": "/data/backups/codex-gateway",
        "sync_max_passes": 3,
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
        "codex_gateway": {"api_key": "cgw.test-only", "key_prefix": "safe-cgw-prefix"},
        "medevidence": {"api_key": "mev2_test-only", "key_prefix": "safe-med-prefix"},
    }


def current_response():
    return {
        "valid": True,
        "subject": {"id": "subject-1"},
        "credential": {
            "id": "credential-1",
            "prefix": "safe-cgw-prefix",
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
    def test_success_syncs_then_validates_and_handoff_points_to_r760(self):
        with tempfile.TemporaryDirectory() as directory:
            args = arguments(directory)
            order = []

            def sync(_args):
                order.append("sync")
                return {
                    "converged": True,
                    "passes": 1,
                    "initial_plan": {"changed_rows": 8},
                    "backup": {"backup_path": "/data/backups/test.db"},
                }

            def validate(*_args, **_kwargs):
                order.append("validate")
                return {
                    "azure": "ok",
                    "r760": "ok",
                    "runtime_credentials_match": True,
                    "image_generation": True,
                }

            with (
                mock.patch.object(ISSUE, "get_billing_admin_token", return_value="admin-token"),
                mock.patch.object(ISSUE, "create_subject", return_value=create_response()),
                mock.patch.object(ISSUE, "grant_entitlement", return_value=entitlement_response()),
                mock.patch.object(ISSUE, "resolve_opaque_key", return_value=resolved_response()),
                mock.patch.object(ISSUE, "current_credential", return_value=current_response()),
                mock.patch.object(ISSUE, "update_user", return_value={}),
                mock.patch.object(ISSUE, "update_key", return_value={}),
                mock.patch.object(ISSUE, "sync_issued_state", side_effect=sync),
                mock.patch.object(ISSUE, "validate_unified_key_pair", side_effect=validate),
                mock.patch.object(ISSUE, "tighten_file_permissions"),
            ):
                result = ISSUE.issue_key(args)

            self.assertEqual(order, ["sync", "validate"])
            self.assertEqual(result["issued"], "ok")
            self.assertEqual(result["azure_validation"], "ok")
            self.assertEqual(result["r760_validation"], "ok")
            handoff = json.loads(Path(result["handoff_path"]).read_text(encoding="utf-8"))
            self.assertEqual(handoff["base_url"], "https://goldencode.instmarket.com.au:1443")
            self.assertEqual(
                handoff["openai_compatible_base_url"],
                "https://goldencode.instmarket.com.au:1443/v1",
            )
            self.assertNotIn("0400000000", Path(result["handoff_path"]).name)

    def test_dual_validation_failure_disables_and_reconciles_without_handoff(self):
        with tempfile.TemporaryDirectory() as directory:
            args = arguments(directory)
            with (
                mock.patch.object(ISSUE, "get_billing_admin_token", return_value="admin-token"),
                mock.patch.object(ISSUE, "create_subject", return_value=create_response()),
                mock.patch.object(ISSUE, "grant_entitlement", return_value=entitlement_response()),
                mock.patch.object(ISSUE, "resolve_opaque_key", return_value=resolved_response()),
                mock.patch.object(ISSUE, "current_credential", return_value=current_response()),
                mock.patch.object(ISSUE, "update_user", return_value={}),
                mock.patch.object(ISSUE, "update_key", return_value={}),
                mock.patch.object(
                    ISSUE,
                    "sync_issued_state",
                    return_value={"converged": True, "initial_plan": {"changed_rows": 8}},
                ),
                mock.patch.object(
                    ISSUE,
                    "validate_unified_key_pair",
                    side_effect=ISSUE.SyncError("target validation failed"),
                ),
                mock.patch.object(ISSUE, "disable_subject_best_effort", return_value=True) as disable,
                mock.patch.object(ISSUE, "reconcile_failed_issue_best_effort") as reconcile,
            ):
                with self.assertRaises(ISSUE.IssueError):
                    ISSUE.issue_key(args)

            disable.assert_called_once()
            reconcile.assert_called_once_with(args)
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
            self.assertEqual(result["dual_endpoint_validation"], "required")


if __name__ == "__main__":
    unittest.main()
