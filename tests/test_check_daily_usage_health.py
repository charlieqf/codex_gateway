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
    def test_timeout_diagnosis_and_live_alert_freshness(self) -> None:
        ops = {
            "generatedAt": "2026-10-12T00:30:00Z", "runtimeSnapshotStatus": "ok",
            "windows": {"15m": {"infrastructureErrors": 3,
                "byErrorCode": {"upstream_timeout": 3},
                "modelCalls": {"timeouts": 3, "byTimeoutPhase": {"reasoning_only": 3}}}},
            "timeoutAlerts": [{"severity": "warning", "message": "repeated user timeout"}],
            "runtime": {"generatedAt": "2026-10-12T00:29:55Z", "alerts": [
                {"kind": "deadline_cleanup_overdue", "requestId": "synthetic", "ageSeconds": 635}]}
        }
        report = {"server": {"ops_snapshot": ops}, "usage": {"errors": {"authenticated": {}}}}
        assess = lambda: MODULE.assess_health(report, disk_warning_percent=90, tls_warning_days=14)
        result = assess()
        self.assertTrue(any("reasoning_only" in item for item in result["warnings"]))
        self.assertIn("repeated user timeout", result["warnings"])
        self.assertFalse(any("non-timeout infrastructure" in item for item in result["warnings"]))
        self.assertTrue(any("deadline_cleanup_overdue" in item for item in result["critical"]))
        ops["runtime"]["generatedAt"] = "2026-10-12T00:20:00Z"
        result = assess()
        self.assertTrue(any("stale" in item for item in result["warnings"]))
        self.assertFalse(any("deadline_cleanup_overdue" in item for item in result["critical"]))
        del ops["windows"]["15m"]["modelCalls"]
        result = assess()
        self.assertTrue(any("3 request timeouts" in item for item in result["warnings"]))
        ops["runtime"]["generatedAt"] = "2026-10-12T00:30:00Z"
        for invalid in [None, {}, [1]]:
            ops["runtime"]["alerts"] = invalid
            result = assess()
            self.assertTrue(any("alerts are invalid" in item for item in result["warnings"]))


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

    def test_rolling_window_uses_elapsed_hours_across_dst(self) -> None:
        now = datetime(2026, 10, 4, 15, 0, tzinfo=timezone.utc)
        for hours in (12, 24):
            with self.subTest(hours=hours):
                since, until, _ = MODULE.reporting_window(None, ZoneInfo("Australia/Sydney"), now, hours=hours)
                self.assertEqual(until, now)
                self.assertEqual((until - since).total_seconds(), hours * 3600)

    def test_rolling_window_rejects_conflicting_date_and_invalid_hours(self) -> None:
        now = datetime(2026, 11, 13, tzinfo=timezone.utc)
        for requested, hours in (("2026-11-12", 12), (None, 0), (None, -1)):
            with self.subTest(requested=requested, hours=hours):
                with self.assertRaises(MODULE.ReportError):
                    MODULE.reporting_window(requested, ZoneInfo("Asia/Shanghai"), now, hours=hours)

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

    def test_reserved_disk_blocks_do_not_hide_low_space_warning(self) -> None:
        disk = {"total_bytes": 100, "used_bytes": 82, "free_bytes": 13}
        report = {"server": {"host": {"disk_root": disk, "disk_data": disk}},
                  "usage": {"errors": {"authenticated": {}}}}
        result = MODULE.assess_health(report, disk_warning_percent=85, tls_warning_days=14)
        self.assertIn("root disk usage is 86.3%", result["warnings"])
        self.assertIn("data disk usage is 86.3%", result["warnings"])
        self.assertIsNone(MODULE.disk_usage_percent({}))
        self.assertIsNone(MODULE.disk_usage_percent({"used_bytes": 1}))
        self.assertEqual(MODULE.disk_usage_percent({"used_bytes": 100, "free_bytes": 0}), 100)

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
