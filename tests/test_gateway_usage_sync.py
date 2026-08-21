from __future__ import annotations

import json
import sqlite3
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
HELPER = ROOT / "scripts" / "gateway-usage-history-transfer.cjs"
SINCE = "2026-08-04T00:00:00.000Z"
UNTIL = "2026-08-07T00:00:00.000Z"

REQUEST_COLUMNS = [
    "request_id", "credential_id", "subject_id", "scope", "session_id", "upstream_account_id",
    "provider", "started_at", "duration_ms", "first_byte_ms", "status", "error_code",
    "rate_limited", "prompt_tokens", "completion_tokens", "total_tokens", "cached_prompt_tokens",
    "estimated_tokens", "usage_source", "limit_kind", "reservation_id", "over_request_limit",
    "identity_guard_hit", "public_model_id", "upstream_runtime", "upstream_model",
    "reasoning_effort", "reasoning_tokens", "client_turn_id", "turn_code", "client_session_id",
    "client_message_id", "client_app_version", "tool_choice", "upstream_finish_reason",
    "upstream_request_id", "upstream_http_status", "upstream_content_chars",
    "upstream_tool_call_count", "upstream_tool_names_json", "upstream_raw_response_hash",
    "upstream_raw_response_chars", "upstream_empty_stop", "upstream_attempt_count",
    "upstream_attempts_json", "gateway_estimated_prompt_tokens", "gateway_prompt_estimate_method",
    "model_context_tokens", "model_max_output_tokens", "active_tool_count", "client_tool_mode",
    "tool_loop_guard_json", "prompt_chars", "maximum_output_tokens", "gateway_admitted_ms",
    "provider_first_event_ms", "provider_duration_ms", "terminal_source", "cancel_requested",
    "cancel_observed",
]

PHASE0_REQUEST_COLUMNS = [
    "upstream_failure_origin", "upstream_failure_kind", "upstream_failure_stage",
    "upstream_transport_code", "upstream_failure_retry_count",
    "upstream_recovery_attempt_count", "upstream_unclassified_additional_attempt_count",
]

RESERVATION_COLUMNS = [
    "id", "request_id", "kind", "credential_id", "subject_id", "scope", "upstream_account_id",
    "provider", "created_at", "expires_at", "finalized_at", "estimated_prompt_tokens",
    "estimated_total_tokens", "reserved_tokens", "final_prompt_tokens", "final_completion_tokens",
    "final_total_tokens", "final_cached_prompt_tokens", "final_estimated_tokens", "final_usage_source",
    "charge_policy_snapshot", "minute_window_start", "day_window_start", "month_window_start",
    "max_prompt_tokens_per_request", "max_total_tokens_per_request", "over_request_limit",
    "policy_json", "entitlement_id", "public_model_id", "upstream_runtime", "upstream_model",
    "reasoning_effort", "final_reasoning_tokens",
]

AUDIT_COLUMNS = [
    "id", "action", "target_user_id", "target_credential_id", "target_credential_prefix",
    "status", "params_json", "error_message", "created_at",
]


def create_table_sql(name: str, columns: list[str], primary: str, unique: str | None = None) -> str:
    definitions = []
    for column in columns:
        suffix = " PRIMARY KEY" if column == primary else ""
        if unique and column == unique:
            suffix += " UNIQUE"
        definitions.append(f'"{column}" TEXT{suffix}')
    return f'CREATE TABLE "{name}" ({", ".join(definitions)});'


def create_database(path: Path, *, phase0: bool = False) -> None:
    db = sqlite3.connect(path)
    try:
        migration = 26 if phase0 else 24
        db.executescript(
            f"""
            PRAGMA foreign_keys = ON;
            CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
            INSERT INTO schema_migrations VALUES ({migration}, '2026-01-01T00:00:00.000Z');
            CREATE TABLE subjects (id TEXT PRIMARY KEY);
            CREATE TABLE access_credentials (id TEXT PRIMARY KEY);
            CREATE TABLE entitlements (id TEXT PRIMARY KEY);
            CREATE TABLE token_windows (
              subject_id TEXT NOT NULL, window_kind TEXT NOT NULL, window_start TEXT NOT NULL,
              prompt_tokens INTEGER NOT NULL, completion_tokens INTEGER NOT NULL,
              total_tokens INTEGER NOT NULL, cached_prompt_tokens INTEGER NOT NULL,
              estimated_tokens INTEGER NOT NULL, requests INTEGER NOT NULL, updated_at TEXT NOT NULL,
              PRIMARY KEY(subject_id, window_kind, window_start)
            );
            CREATE TABLE entitlement_token_windows (
              entitlement_id TEXT NOT NULL, window_kind TEXT NOT NULL, window_start TEXT NOT NULL,
              prompt_tokens INTEGER NOT NULL, completion_tokens INTEGER NOT NULL,
              total_tokens INTEGER NOT NULL, cached_prompt_tokens INTEGER NOT NULL,
              estimated_tokens INTEGER NOT NULL, requests INTEGER NOT NULL, updated_at TEXT NOT NULL,
              PRIMARY KEY(entitlement_id, window_kind, window_start)
            );
            """
        )
        request_columns = REQUEST_COLUMNS + (PHASE0_REQUEST_COLUMNS if phase0 else [])
        db.execute(create_table_sql("request_events", request_columns, "request_id"))
        db.execute(create_table_sql("token_reservations", RESERVATION_COLUMNS, "id", "request_id"))
        db.execute(create_table_sql("admin_audit_events", AUDIT_COLUMNS, "id"))
        db.executemany("INSERT INTO subjects VALUES (?)", [("subject-1",)])
        db.executemany("INSERT INTO access_credentials VALUES (?)", [("credential-1",)])
        db.executemany("INSERT INTO entitlements VALUES (?)", [("entitlement-1",)])
        db.commit()
    finally:
        db.close()


def insert_request(db: sqlite3.Connection, suffix: str, total: int) -> None:
    row = dict.fromkeys(REQUEST_COLUMNS)
    row.update(
        request_id=f"request-{suffix}", credential_id="credential-1", subject_id="subject-1",
        scope="code", provider="tencent", started_at=f"2026-08-05T00:0{suffix}:00.000Z",
        status="ok", rate_limited=0, total_tokens=total, usage_source="provider",
        reservation_id=f"reservation-{suffix}", over_request_limit=0, identity_guard_hit=0,
        public_model_id="goldencode", upstream_runtime="tencent", upstream_model="glm-5.2",
    )
    db.execute(
        f'INSERT INTO request_events ({", ".join(REQUEST_COLUMNS)}) VALUES ({", ".join("?" for _ in REQUEST_COLUMNS)})',
        [row[column] for column in REQUEST_COLUMNS],
    )


def reservation_row(suffix: str, total: int, *, finalized: bool = True) -> dict[str, object]:
    row: dict[str, object] = dict.fromkeys(RESERVATION_COLUMNS)
    row.update(
        id=f"reservation-{suffix}", request_id=f"request-{suffix}", kind="reservation",
        credential_id="credential-1", subject_id="subject-1", entitlement_id="entitlement-1",
        scope="code", provider="tencent", created_at=f"2026-08-05T00:0{suffix}:00.000Z",
        finalized_at=f"2026-08-05T00:0{suffix}:01.000Z" if finalized else None,
        estimated_prompt_tokens=0, estimated_total_tokens=0, reserved_tokens=total,
        final_prompt_tokens=total - 10 if finalized else 0,
        final_completion_tokens=10 if finalized else 0,
        final_total_tokens=total if finalized else 0,
        final_cached_prompt_tokens=0, final_estimated_tokens=0,
        final_usage_source="provider" if finalized else None, charge_policy_snapshot="reserve",
        minute_window_start=f"2026-08-05T00:0{suffix}:00.000Z",
        day_window_start="2026-08-05T00:00:00.000Z",
        month_window_start="2026-08-01T00:00:00.000Z", over_request_limit=0,
        policy_json="{}", public_model_id="goldencode", upstream_runtime="tencent",
        upstream_model="glm-5.2", reasoning_effort="medium", final_reasoning_tokens=0,
    )
    return row


def insert_reservation(db: sqlite3.Connection, row: dict[str, object]) -> None:
    db.execute(
        f'INSERT INTO token_reservations ({", ".join(RESERVATION_COLUMNS)}) VALUES ({", ".join("?" for _ in RESERVATION_COLUMNS)})',
        [row[column] for column in RESERVATION_COLUMNS],
    )


def seed_baseline(path: Path, *, open_reservation: bool = False) -> None:
    db = sqlite3.connect(path)
    try:
        insert_request(db, "1", 100)
        insert_reservation(db, reservation_row("1", 100, finalized=not open_reservation))
        if not open_reservation:
            for kind, start in (
                ("minute", "2026-08-05T00:01:00.000Z"),
                ("day", "2026-08-05T00:00:00.000Z"),
                ("month", "2026-08-01T00:00:00.000Z"),
            ):
                db.execute("INSERT INTO token_windows VALUES (?, ?, ?, 90, 10, 100, 0, 0, 1, ?)", ("subject-1", kind, start, UNTIL))
                db.execute("INSERT INTO entitlement_token_windows VALUES (?, ?, ?, 90, 10, 100, 0, 0, 1, ?)", ("entitlement-1", kind, start, UNTIL))
        db.commit()
    finally:
        db.close()


def run_helper(command: str, path: Path, *, payload=None, extra=None, check=True):
    completed = subprocess.run(
        ["node", str(HELPER), command, "--db", str(path), *(extra or [])],
        input=json.dumps(payload, separators=(",", ":")) if payload is not None else None,
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    if check and completed.returncode != 0:
        raise AssertionError(completed.stderr)
    return completed


class GatewayUsageSyncTests(unittest.TestCase):
    def test_merge_is_additive_idempotent_and_updates_windows(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.db"
            target = Path(directory) / "target.db"
            create_database(source)
            create_database(target, phase0=True)
            seed_baseline(source)
            seed_baseline(target)
            db = sqlite3.connect(source)
            try:
                insert_request(db, "2", 50)
                insert_reservation(db, reservation_row("2", 50))
                db.commit()
            finally:
                db.close()

            payload = json.loads(run_helper("export", source, extra=["--since", SINCE, "--until", UNTIL]).stdout)
            plan = json.loads(run_helper("plan", target, payload=payload).stdout)
            self.assertEqual(plan["tables"]["request_events"]["insert"], 1)
            self.assertEqual(plan["tables"]["token_reservations"]["insert"], 1)

            applied = json.loads(run_helper(
                "apply", target, payload=payload,
                extra=["--backup-id", "unit.db", "--source-name", "azure", "--target-name", "r760"],
            ).stdout)
            self.assertTrue(applied["applied"])
            db = sqlite3.connect(target)
            try:
                self.assertEqual(db.execute("SELECT COUNT(*) FROM request_events").fetchone()[0], 2)
                self.assertEqual(db.execute("SELECT COUNT(*) FROM token_reservations").fetchone()[0], 2)
                self.assertEqual(
                    db.execute(
                        "SELECT upstream_failure_origin, upstream_failure_kind, upstream_failure_stage, "
                        "upstream_transport_code, upstream_failure_retry_count, "
                        "upstream_recovery_attempt_count, upstream_unclassified_additional_attempt_count "
                        "FROM request_events WHERE request_id='request-2'"
                    ).fetchone(),
                    (None, None, None, None, None, None, None),
                )
                self.assertEqual(
                    db.execute("SELECT total_tokens, requests FROM token_windows WHERE window_kind='day'").fetchone(),
                    (150, 2),
                )
                self.assertEqual(
                    db.execute("SELECT total_tokens, requests FROM entitlement_token_windows WHERE window_kind='day'").fetchone(),
                    (150, 2),
                )
                audit = db.execute("SELECT params_json FROM admin_audit_events WHERE action='gateway-usage-history-sync'").fetchone()
                self.assertIsNotNone(audit)
                self.assertNotIn("credential-1", audit[0])
                self.assertEqual(db.execute("PRAGMA foreign_key_check").fetchall(), [])
            finally:
                db.close()

            second = json.loads(run_helper("plan", target, payload=payload).stdout)
            self.assertEqual(second["changed_rows"], 0)

    def test_finalized_source_can_close_existing_open_target_reservation(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.db"
            target = Path(directory) / "target.db"
            create_database(source)
            create_database(target, phase0=True)
            seed_baseline(source)
            seed_baseline(target, open_reservation=True)
            payload = json.loads(run_helper("export", source, extra=["--since", SINCE, "--until", UNTIL]).stdout)
            plan = json.loads(run_helper("plan", target, payload=payload).stdout)
            self.assertEqual(plan["tables"]["token_reservations"]["update"], 1)
            run_helper("apply", target, payload=payload)
            db = sqlite3.connect(target)
            try:
                self.assertEqual(db.execute("SELECT total_tokens, requests FROM token_windows WHERE window_kind='day'").fetchone(), (100, 1))
            finally:
                db.close()

    def test_missing_control_dependency_fails_before_write(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.db"
            target = Path(directory) / "target.db"
            create_database(source)
            create_database(target, phase0=True)
            seed_baseline(source)
            db = sqlite3.connect(target)
            try:
                db.execute("DELETE FROM access_credentials")
                db.commit()
            finally:
                db.close()
            payload = json.loads(run_helper("export", source, extra=["--since", SINCE, "--until", UNTIL]).stdout)
            failed = run_helper("apply", target, payload=payload, check=False)
            self.assertNotEqual(failed.returncode, 0)
            self.assertIn("sync control state first", failed.stderr)
            db = sqlite3.connect(target)
            try:
                self.assertEqual(db.execute("SELECT COUNT(*) FROM request_events").fetchone()[0], 0)
            finally:
                db.close()


if __name__ == "__main__":
    unittest.main()
