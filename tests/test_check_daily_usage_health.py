from __future__ import annotations

import importlib.util
import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo


SCRIPT_PATH = Path(__file__).resolve().parents[1] / "scripts" / "check-daily-usage-health.py"
sys.path.insert(0, str(SCRIPT_PATH.parent))
SPEC = importlib.util.spec_from_file_location("check_daily_usage_health", SCRIPT_PATH)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class DailyUsageHealthTest(unittest.TestCase):
    def test_reporting_window_uses_sydney_calendar_day(self) -> None:
        reporting_tz = ZoneInfo("Australia/Sydney")
        now = datetime(2026, 7, 16, 7, 30, tzinfo=timezone.utc)

        since, until, local_day = MODULE.reporting_window(None, reporting_tz, now)

        self.assertEqual(local_day.isoformat(), "2026-07-16")
        self.assertEqual(since.isoformat(), "2026-07-15T14:00:00+00:00")
        self.assertEqual(until, now)

    def test_past_reporting_window_honors_dst_boundary(self) -> None:
        reporting_tz = ZoneInfo("Australia/Sydney")
        now = datetime(2026, 10, 5, 0, 0, tzinfo=timezone.utc)

        since, until, _ = MODULE.reporting_window("2026-10-04", reporting_tz, now)

        self.assertEqual(since.isoformat(), "2026-10-03T14:00:00+00:00")
        self.assertEqual(until.isoformat(), "2026-10-04T13:00:00+00:00")
        self.assertEqual((until - since).total_seconds(), 23 * 3600)

    def test_usage_summary_keeps_unattributed_events_out_of_user_count(self) -> None:
        usage = {
            "rows": [
                {
                    "subject_id": "user-1",
                    "public_model_id": "max",
                    "upstream_account_id": "codex-pro-1",
                    "requests": 3,
                    "ok": 2,
                    "errors": 1,
                    "rate_limited": 0,
                    "total_tokens": 120,
                },
                {
                    "subject_id": None,
                    "public_model_id": None,
                    "upstream_account_id": None,
                    "requests": 7,
                    "ok": 0,
                    "errors": 7,
                    "rate_limited": 0,
                },
            ]
        }
        users = {"users": [{"id": "user-1", "name": "Test User", "state": "active"}]}
        errors = {
            "rows": [
                {"audience": "authenticated", "error_code": "client_aborted", "limit_kind": "", "count": 1},
                {"audience": "unattributed", "error_code": "missing_credential", "limit_kind": "", "count": 7},
            ]
        }

        result = MODULE.summarize_usage(usage, users, errors)

        self.assertEqual(result["authenticated"]["distinct_users"], 1)
        self.assertEqual(result["authenticated"]["requests"], 3)
        self.assertEqual(result["unattributed"]["requests"], 7)
        self.assertEqual(result["all_events"]["requests"], 10)
        self.assertEqual(result["users"][0]["name"], "Test User")
        self.assertEqual(result["by_model_authenticated"], {"max": 3})
        self.assertEqual(result["errors"]["unattributed"], {"missing_credential": 7})

    def test_gateway_port_must_be_exact_loopback_binding(self) -> None:
        good = {"8787/tcp": [{"HostIp": "127.0.0.1", "HostPort": "18787"}]}
        public = {"8787/tcp": [{"HostIp": "0.0.0.0", "HostPort": "18787"}]}
        custom = {"9000/tcp": [{"HostIp": "::1", "HostPort": "29000"}]}

        self.assertTrue(MODULE.ports_are_loopback_only(good))
        self.assertTrue(
            MODULE.ports_are_loopback_only(
                custom,
                loopback_health_url="http://[::1]:29000/gateway/health",
            )
        )
        self.assertFalse(MODULE.ports_are_loopback_only(public))
        self.assertFalse(
            MODULE.ports_are_loopback_only(
                good,
                loopback_health_url="http://127.0.0.1:29000/gateway/health",
            )
        )
        self.assertFalse(MODULE.ports_are_loopback_only({}))

    def test_ssh_key_expansion_only_treats_a_leading_tilde_as_home(self) -> None:
        short_path = r"C:\Users\RDPUSE~1\.ssh\key"

        self.assertEqual(MODULE.expanded_ssh_key(short_path), Path(short_path))
        self.assertEqual(
            MODULE.expanded_ssh_key(r"~\.ssh\key"),
            Path.home() / ".ssh" / "key",
        )

    def test_secret_redaction(self) -> None:
        value = "Bearer abc.def ghi cgu_live_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890"
        redacted = MODULE.redact_secrets(value)

        self.assertNotIn("abc.def", redacted)
        self.assertNotIn("ABCDEFGHIJKLMNOPQRSTUVWXYZ", redacted)


if __name__ == "__main__":
    unittest.main()
