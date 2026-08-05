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

    def test_authority_write_happens_before_compatibility_mirror(self) -> None:
        args = SimpleNamespace(
            admin_args=["enable-user", "user-1"],
            what_if=False,
            timeout_seconds=60,
            sync_max_passes=3,
            compatibility_backup_root="/backup",
            r760_host="r760",
            r760_user="root",
            r760_ssh_key="r760-key",
            r760_container="r760-gateway",
            r760_port=7723,
            azure_host="azure",
            azure_user="qian",
            azure_ssh_key="azure-key",
            azure_container="azure-gateway",
            azure_port=22,
        )
        order: list[str] = []

        def write(*_args, **_kwargs):
            order.append("write")
            return {"user": {"id": "user-1", "state": "active"}}

        def mirror(*_args, **_kwargs):
            order.append("mirror")
            return {
                "converged": True,
                "passes": 1,
                "initial_plan": {"changed_rows": 1},
                "backup": {"backup_path": "/backup/azure.db"},
            }

        with (
            mock.patch.object(MODULE, "run_remote_admin", side_effect=write),
            mock.patch.object(MODULE, "sync_r760_to_azure", side_effect=mirror),
        ):
            result = MODULE.execute(args)

        self.assertEqual(order, ["write", "mirror"])
        self.assertEqual(result["authority"], "r760")
        self.assertTrue(result["azure_compatibility_mirror"]["converged"])


if __name__ == "__main__":
    unittest.main()
