from __future__ import annotations

import argparse
import importlib.util
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
sys.path.insert(0, str(SCRIPTS))
SPEC = importlib.util.spec_from_file_location(
    "manage_r760_gateway_control", SCRIPTS / "manage-r760-gateway-control.py"
)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class ManageR760GatewayControlTests(unittest.TestCase):
    def test_registration_release_is_preview_then_backup_then_revision_guarded_write(self) -> None:
        revision = "a" * 64
        args = MODULE.parse_args(["--", "release-registration", "manual_trial", "test-id", "operator", "abandoned", revision])
        order = []
        def admin(_endpoint, command, **_kwargs):
            if "--apply" in command:
                self.assertEqual(command[-2:], ["--expected-revision", revision])
                order.append("write")
                return {"applied": True}
            self.assertEqual(command[-1], "--dry-run")
            order.append("preview")
            return {"revision": revision, "applied": False}
        with (
            mock.patch.object(MODULE, "run_remote_admin", side_effect=admin),
            mock.patch.object(MODULE, "install_helper"),
            mock.patch.object(MODULE, "run_helper_json", return_value={
                "migration": 33, "integrity": {"quick_check": "ok", "foreign_key_violations": 0}}),
            mock.patch.object(MODULE, "create_target_backup", side_effect=lambda *a, **kw: order.append("backup") or {}),
            mock.patch.object(MODULE, "remove_helper_best_effort"),
        ):
            self.assertTrue(MODULE.execute(args)["authority_result"]["applied"])
        self.assertEqual(order, ["preview", "backup", "write"])

    def test_registration_release_what_if_and_bad_revision_never_backup_or_write(self) -> None:
        base = ["release-registration", "manual_trial", "test-id", "operator", "abandoned"]
        with (
            mock.patch.object(MODULE, "run_remote_admin", return_value={"revision": "a" * 64, "applied": False}) as admin,
            mock.patch.object(MODULE, "create_target_backup") as backup,
            mock.patch.object(MODULE, "install_helper") as install,
        ):
            self.assertFalse(MODULE.execute(MODULE.parse_args(["--what-if", "--", *base]))["plan"]["applied"])
            for suffix in ([], ["b" * 64]):
                with self.assertRaises(MODULE.ManagementError):
                    MODULE.execute(MODULE.parse_args(["--", *base, *suffix]))
            backup.assert_not_called()
            install.assert_not_called()
            self.assertTrue(all(call.args[1][-1] == "--dry-run" for call in admin.call_args_list))
        for bad in ([*base, "--apply"], [*base, "a" * 64, "--db", "wrong.db"]):
            with self.assertRaises(MODULE.ManagementError):
                MODULE.validate_admin_args(bad)

    def test_rejects_commands_that_can_reveal_a_key(self) -> None:
        for command in (["issue", "--user", "x"], ["rotate", "cgw.prefix"], ["reveal-key", "x"]):
            with self.subTest(command=command):
                with self.assertRaises(MODULE.ManagementError):
                    MODULE.validate_admin_args(command)

    def test_accepts_user_and_plan_writes(self) -> None:
        self.assertEqual(MODULE.validate_admin_args(["disable-user", "user-1"]), ("disable-user", None))
        self.assertEqual(MODULE.validate_admin_args(["plan", "deprecate", "plan-1"]), ("plan", "deprecate"))
        self.assertEqual(
            MODULE.validate_admin_args(["entitlement", "renew", "ent-1", "--end", "2027-01-01T00:00:00Z"]),
            ("entitlement", "renew"),
        )

    def test_plan_token_limits_validation(self) -> None:
        command = MODULE.PLAN_TOKEN_LIMITS_COMMAND
        self.assertEqual(
            MODULE.validate_admin_args([command, "plan_paid_monthly_v1", "50000000", "150000000"]),
            (command, None),
        )
        self.assertEqual(
            MODULE.validate_admin_args(
                [command, "plan_paid_yearly_v1", "none", "200000000", "none", "6000000"]
            ),
            (command, None),
        )
        for bad in (
            [command, "plan_paid_monthly_v1", "50000000"],
            [command, "plan_paid_monthly_v1", "50000000", "150000000", "none"],
            [command, "plan_paid_monthly_v1", "50000000", "150000000", "none", "6000000", "extra"],
            [command, "bad plan!", "none", "200000000"],
            [command, "plan_paid_monthly_v1", "0", "150000000"],
            [command, "plan_paid_monthly_v1", "50000000", "not-a-number"],
        ):
            with self.subTest(command=bad):
                with self.assertRaises(
                    (MODULE.ManagementError, ValueError, argparse.ArgumentTypeError)
                ):
                    MODULE.validate_admin_args(bad)

    def test_free_total_reset_validation(self) -> None:
        valid = [MODULE.FREE_TOTAL_RESET_COMMAND, "subj_test", "ent_test", "985925", "1000000", "user authorized"]
        self.assertEqual(MODULE.validate_admin_args(valid), (MODULE.FREE_TOTAL_RESET_COMMAND, None))
        for bad in (valid[:-1], valid + ["extra"], [*valid[:3], "0", *valid[4:]],
                    [*valid[:4], "none", valid[5]], [*valid[:5], " "],
                    [valid[0], "bad subject", *valid[2:]]):
            with self.subTest(command=bad):
                with self.assertRaises((MODULE.ManagementError, ValueError, argparse.ArgumentTypeError)):
                    MODULE.validate_admin_args(bad)

    def test_free_total_reset_uses_backup_before_apply(self) -> None:
        args = MODULE.parse_args(["--", MODULE.FREE_TOTAL_RESET_COMMAND,
                                  "subj_test", "ent_test", "985925", "1000000", "authorized"])
        order = []
        def reset(_endpoint, _args, *, apply):
            order.append("write" if apply else "preview")
            return {"applied": apply}
        with (
            mock.patch.object(MODULE, "run_free_total_reset", side_effect=reset),
            mock.patch.object(MODULE, "install_helper"),
            mock.patch.object(MODULE, "run_helper_json", return_value={
                "migration": 30, "integrity": {"quick_check": "ok", "foreign_key_violations": 0}}),
            mock.patch.object(MODULE, "create_target_backup", side_effect=lambda *a, **kw: order.append("backup") or {}),
            mock.patch.object(MODULE, "remove_helper_best_effort"),
            mock.patch.object(MODULE, "run_remote_admin") as admin,
        ):
            result = MODULE.execute(args)
            self.assertTrue(result["authority_result"]["applied"])
            self.assertEqual(order, ["preview", "backup", "write"])
            admin.assert_not_called()

    def test_user_rpm_plan_only_selects_below_minimum_reenableable_user_keys(self) -> None:
        inventory = {
            "credentials": [
                credential("desktop-low", 10, "active", "desktop"),
                credential("unknown-low", 5, "user_disabled", "unknown"),
                credential("desktop-equal", 20, "active", "desktop"),
                credential("desktop-high", 30, "active", "desktop"),
                credential("service-low", 1, "active", "service"),
                credential("expired-low", 1, "expired", "unknown"),
                credential("revoked-low", 1, "revoked", "unknown", revoked=True),
            ]
        }

        plan, prefixes = MODULE.user_rpm_plan(inventory, 20)

        self.assertEqual(prefixes, ["desktop-low", "unknown-low"])
        self.assertEqual(plan["eligible_user_credentials"], 4)
        self.assertEqual(plan["credentials_below_minimum"], 2)
        self.assertEqual(plan["credentials_unchanged"], 2)
        self.assertEqual(plan["before_rpm_distribution"], {"10": 1, "5": 1, "20": 1, "30": 1})

    def test_bulk_user_rpm_write_is_r760_only_and_backup_first(self) -> None:
        args = SimpleNamespace(
            admin_args=[MODULE.BULK_USER_RPM_COMMAND, "20"],
            what_if=False,
            timeout_seconds=60,
            backup_root="/backup",
            r760_host="r760",
            r760_user="root",
            r760_ssh_key="r760-key",
            r760_container="r760-gateway",
            r760_port=7723,
        )
        order: list[str] = []
        inventories = [
            {"credentials": [credential("desktop-low", 10, "active", "desktop")]},
            {"credentials": [credential("desktop-low", 20, "active", "desktop")]},
        ]

        def admin(_endpoint, admin_args, **_kwargs):
            if admin_args == [MODULE.BULK_USER_RPM_COMMAND, "20"]:
                order.append("write")
                return {"updated_credentials": 1}
            return inventories.pop(0)

        def inspect(*_args, **_kwargs):
            order.append("inspect")
            return {"migration": 26, "integrity": {"quick_check": "ok", "foreign_key_violations": 0}}

        with (
            mock.patch.object(MODULE, "run_remote_admin", side_effect=admin),
            mock.patch.object(MODULE, "install_helper", side_effect=lambda *_args, **_kwargs: order.append("install")),
            mock.patch.object(MODULE, "run_helper_json", side_effect=inspect),
            mock.patch.object(
                MODULE,
                "create_target_backup",
                side_effect=lambda *_args, **_kwargs: order.append("backup") or {
                    "backup_path": "/backup/r760.db",
                    "sha256": "a" * 64,
                    "integrity": {"quick_check": "ok", "foreign_key_violations": 0},
                },
            ),
            mock.patch.object(MODULE, "remove_helper_best_effort", side_effect=lambda *_args, **_kwargs: order.append("cleanup")),
        ):
            result = MODULE.execute(args)

        self.assertEqual(order, ["install", "inspect", "backup", "write", "inspect", "cleanup"])
        self.assertEqual(result["authority"], "r760")
        self.assertEqual(result["authority_mode"], "r760_only")
        self.assertEqual(result["updated_credentials"], 1)
        self.assertEqual(result["post_write"]["credentials_below_minimum"], 0)


def credential(prefix: str, rpm: int, status: str, credential_class: str, *, revoked: bool = False):
    return {
        "prefix": prefix,
        "credential_class": credential_class,
        "status": status,
        "revoked_at": "2026-01-01T00:00:00.000Z" if revoked else None,
        "rate": {"requestsPerMinute": rpm},
    }


if __name__ == "__main__":
    unittest.main()
