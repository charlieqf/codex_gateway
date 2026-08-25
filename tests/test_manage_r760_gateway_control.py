from __future__ import annotations

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
