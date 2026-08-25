import json
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
HELPER = ROOT / "scripts" / "gateway-control-state-transfer.cjs"
if str(ROOT / "scripts") not in sys.path:
    sys.path.insert(0, str(ROOT / "scripts"))
import gateway_state_sync as STATE_SYNC


SCHEMA = """
PRAGMA foreign_keys = ON;
CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
INSERT INTO schema_migrations VALUES (25, '2026-01-01T00:00:00.000Z');
CREATE TABLE plans (
  id TEXT PRIMARY KEY, display_name TEXT NOT NULL, policy_json TEXT NOT NULL,
  scope_allowlist_json TEXT NOT NULL, priority_class INTEGER NOT NULL,
  team_pool_id TEXT, state TEXT NOT NULL, created_at TEXT NOT NULL,
  metadata_json TEXT, feature_policy_json TEXT NOT NULL
);
CREATE TRIGGER trg_plans_policy_immutable BEFORE UPDATE OF policy_json ON plans
BEGIN SELECT RAISE(ABORT, 'plans.policy_json is immutable'); END;
CREATE TRIGGER trg_plans_feature_policy_immutable BEFORE UPDATE OF feature_policy_json ON plans
BEGIN SELECT RAISE(ABORT, 'plans.feature_policy_json is immutable'); END;
CREATE TABLE subjects (
  id TEXT PRIMARY KEY, label TEXT NOT NULL, state TEXT NOT NULL,
  created_at TEXT NOT NULL, name TEXT, phone_number TEXT,
  external_provider TEXT, external_user_id TEXT, display_name TEXT
);
CREATE UNIQUE INDEX idx_subjects_external_provider_user
  ON subjects(external_provider, external_user_id)
  WHERE external_provider IS NOT NULL AND external_user_id IS NOT NULL;
CREATE TABLE access_credentials (
  id TEXT PRIMARY KEY, prefix TEXT NOT NULL UNIQUE, hash TEXT NOT NULL,
  subject_id TEXT NOT NULL, label TEXT NOT NULL, scope TEXT NOT NULL,
  expires_at TEXT NOT NULL, revoked_at TEXT, rate_json TEXT NOT NULL,
  created_at TEXT NOT NULL, rotates_id TEXT, token_ciphertext TEXT,
  allowed_public_models_json TEXT, credential_class TEXT NOT NULL DEFAULT 'unknown',
  FOREIGN KEY(subject_id) REFERENCES subjects(id),
  FOREIGN KEY(rotates_id) REFERENCES access_credentials(id)
);
CREATE TABLE entitlements (
  id TEXT PRIMARY KEY, subject_id TEXT NOT NULL, plan_id TEXT NOT NULL,
  policy_snapshot_json TEXT NOT NULL, scope_allowlist_json TEXT NOT NULL,
  period_kind TEXT NOT NULL, period_start TEXT NOT NULL, period_end TEXT,
  state TEXT NOT NULL, team_seat_id TEXT, created_at TEXT NOT NULL,
  cancelled_at TEXT, cancelled_reason TEXT, notes TEXT,
  feature_policy_snapshot_json TEXT NOT NULL,
  FOREIGN KEY(subject_id) REFERENCES subjects(id), FOREIGN KEY(plan_id) REFERENCES plans(id)
);
CREATE TABLE unified_client_keys (
  id TEXT PRIMARY KEY, prefix TEXT NOT NULL UNIQUE, hash TEXT NOT NULL UNIQUE,
  subject_id TEXT NOT NULL, label TEXT NOT NULL, expires_at TEXT NOT NULL,
  revoked_at TEXT, codex_credential_id TEXT NOT NULL,
  codex_credential_prefix TEXT NOT NULL, codex_key_ciphertext TEXT NOT NULL,
  medevidence_key_ciphertext TEXT NOT NULL, medevidence_key_prefix TEXT,
  created_at TEXT NOT NULL, metadata_json TEXT, token_ciphertext TEXT,
  credential_class TEXT NOT NULL DEFAULT 'unknown', is_current INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY(subject_id) REFERENCES subjects(id),
  FOREIGN KEY(codex_credential_id) REFERENCES access_credentials(id)
);
CREATE TABLE upstream_v2_bindings (
  subject_id TEXT PRIMARY KEY, v2_user_id TEXT NOT NULL UNIQUE, v2_key_id TEXT,
  state TEXT NOT NULL, last_synced_at TEXT, metadata_json TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  FOREIGN KEY(subject_id) REFERENCES subjects(id)
);
CREATE TABLE billing_events (
  id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE,
  payload_hash TEXT NOT NULL, provider TEXT NOT NULL,
  external_order_id TEXT NOT NULL, external_event_id TEXT,
  event_type TEXT NOT NULL, apply_mode TEXT NOT NULL, subject_id TEXT NOT NULL,
  plan_id TEXT, entitlement_id TEXT, status TEXT NOT NULL, amount_minor INTEGER,
  currency TEXT, period_kind TEXT, period_start TEXT, period_end TEXT,
  applied_at TEXT, error_message TEXT, metadata_json TEXT, created_at TEXT NOT NULL,
  FOREIGN KEY(subject_id) REFERENCES subjects(id), FOREIGN KEY(plan_id) REFERENCES plans(id),
  FOREIGN KEY(entitlement_id) REFERENCES entitlements(id)
);
CREATE TABLE billing_subject_events (
  id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE,
  payload_hash TEXT NOT NULL, event_type TEXT NOT NULL, provider TEXT NOT NULL,
  external_user_id TEXT NOT NULL, subject_id TEXT NOT NULL, credential_id TEXT,
  credential_prefix TEXT, unified_key_id TEXT, unified_key_prefix TEXT,
  status TEXT NOT NULL, error_message TEXT, metadata_json TEXT, applied_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(subject_id) REFERENCES subjects(id),
  FOREIGN KEY(credential_id) REFERENCES access_credentials(id),
  FOREIGN KEY(unified_key_id) REFERENCES unified_client_keys(id)
);
CREATE TABLE admin_audit_events (
  id TEXT PRIMARY KEY, action TEXT NOT NULL, target_user_id TEXT,
  target_credential_id TEXT, target_credential_prefix TEXT, status TEXT NOT NULL,
  params_json TEXT, error_message TEXT, created_at TEXT NOT NULL
);
CREATE TABLE request_events (request_id TEXT PRIMARY KEY, status TEXT NOT NULL);
"""


def insert_user_chain(connection: sqlite3.Connection, suffix: str) -> None:
    created = f"2026-01-0{suffix}T00:00:00.000Z"
    connection.execute(
        "INSERT INTO subjects VALUES (?, ?, 'active', ?, ?, ?, 'manual', ?, ?)",
        (f"subject-{suffix}", f"label-{suffix}", created, f"name-{suffix}",
         f"phone-{suffix}", f"external-{suffix}", f"display-{suffix}"),
    )
    connection.execute(
        "INSERT INTO access_credentials VALUES (?, ?, ?, ?, ?, 'code', ?, NULL, ?, ?, NULL, ?, ?, 'desktop')",
        (f"credential-{suffix}", f"prefix-{suffix}", f"hash-{suffix}",
         f"subject-{suffix}", f"credential-label-{suffix}",
         "2027-01-01T00:00:00.000Z", '{"requestsPerMinute":10}', created,
         f"ciphertext-{suffix}", '["goldencode"]'),
    )
    connection.execute(
        "INSERT INTO entitlements VALUES (?, ?, 'plan-1', ?, '[\"code\"]', 'one_off', ?, ?, "
        "'active', NULL, ?, NULL, NULL, NULL, ?)",
        (f"entitlement-{suffix}", f"subject-{suffix}", '{"tokensPerDay":1000}', created,
         "2027-01-01T00:00:00.000Z", created, '{"capabilities":["chat","image_generation"]}'),
    )
    connection.execute(
        "INSERT INTO unified_client_keys VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, 'desktop', 1)",
        (f"unified-{suffix}", f"unified-prefix-{suffix}", f"unified-hash-{suffix}",
         f"subject-{suffix}", f"unified-label-{suffix}", "2027-01-01T00:00:00.000Z",
         f"credential-{suffix}", f"prefix-{suffix}", f"codex-cipher-{suffix}",
         f"med-cipher-{suffix}", f"med-prefix-{suffix}", created, '{}',
         f"unified-token-cipher-{suffix}"),
    )
    connection.execute(
        "INSERT INTO upstream_v2_bindings VALUES (?, ?, ?, 'active', ?, '{}', ?, ?)",
        (f"subject-{suffix}", f"v2-user-{suffix}", f"v2-key-{suffix}", created, created, created),
    )
    connection.execute(
        "INSERT INTO billing_events VALUES (?, ?, ?, 'manual', ?, ?, 'purchase', 'apply', ?, "
        "'plan-1', ?, 'applied', 0, 'USD', 'one_off', ?, ?, ?, NULL, '{}', ?)",
        (f"billing-{suffix}", f"billing-idempotency-{suffix}", f"payload-{suffix}",
         f"order-{suffix}", f"event-{suffix}", f"subject-{suffix}", f"entitlement-{suffix}",
         created, "2027-01-01T00:00:00.000Z", created, created),
    )
    connection.execute(
        "INSERT INTO billing_subject_events VALUES (?, ?, ?, 'create', 'manual', ?, ?, ?, ?, ?, ?, "
        "'applied', NULL, '{}', ?, ?)",
        (f"subject-event-{suffix}", f"subject-idempotency-{suffix}", f"subject-payload-{suffix}",
         f"external-{suffix}", f"subject-{suffix}", f"credential-{suffix}", f"prefix-{suffix}",
         f"unified-{suffix}", f"unified-prefix-{suffix}", created, created),
    )


def create_database(path: Path, *, with_initial_user: bool = True) -> None:
    connection = sqlite3.connect(path)
    try:
        connection.executescript(SCHEMA)
        connection.execute(
            "INSERT INTO plans VALUES ('plan-1', 'Plan 1', ?, '[\"code\"]', 5, NULL, "
            "'active', '2026-01-01T00:00:00.000Z', '{}', ?)",
            ('{"tokensPerDay":1000}', '{"capabilities":["chat","image_generation"]}'),
        )
        if with_initial_user:
            insert_user_chain(connection, "1")
        connection.commit()
    finally:
        connection.close()


def run_helper(command: str, db_path: Path, *, payload=None, extra=None, check=True):
    completed = subprocess.run(
        ["node", str(HELPER), command, "--db", str(db_path), *(extra or [])],
        input=json.dumps(payload, separators=(",", ":")) if payload is not None else None,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if check and completed.returncode != 0:
        raise AssertionError(completed.stderr)
    return completed


class GatewayStateSyncTests(unittest.TestCase):
    def test_dual_validation_compares_runtime_credentials_without_returning_them(self):
        endpoint = {
            "subject_id": "subject-1",
            "unified_prefix": "unified-prefix",
            "codex_prefix": "codex-prefix",
            "medevidence_prefix": "medevidence-prefix",
            "codex_key": "cgw.secret-value",
            "medevidence_key": "mev2_live_secret-value",
            "capabilities": ["chat", "image_generation"],
        }
        with mock.patch.object(
            STATE_SYNC, "_validate_endpoint", side_effect=[dict(endpoint), dict(endpoint)]
        ):
            result = STATE_SYNC.validate_unified_key_pair(
                "cgu_live_" + "A" * 64,
                expected_subject_id="subject-1",
            )
        rendered = json.dumps(result)
        self.assertTrue(result["runtime_credentials_match"])
        self.assertNotIn("secret-value", rendered)

    def test_dual_validation_rejects_runtime_credential_mismatch(self):
        azure = {
            "subject_id": "subject-1",
            "unified_prefix": "unified-prefix",
            "codex_prefix": "codex-prefix",
            "medevidence_prefix": "medevidence-prefix",
            "codex_key": "cgw.azure-secret",
            "medevidence_key": "mev2_live_shared",
            "capabilities": ["chat", "image_generation"],
        }
        r760 = dict(azure, codex_key="cgw.r760-secret")
        with mock.patch.object(STATE_SYNC, "_validate_endpoint", side_effect=[azure, r760]):
            with self.assertRaisesRegex(STATE_SYNC.SyncError, "runtime credentials differ"):
                STATE_SYNC.validate_unified_key_pair("cgu_live_" + "A" * 64)

    def test_apply_is_additive_transactional_and_idempotent(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.db"
            target = root / "target.db"
            backup = root / "backup.db"
            create_database(source)
            create_database(target)

            source_db = sqlite3.connect(source)
            try:
                source_db.execute(
                    "UPDATE plans SET display_name = 'Authoritative plan', state = 'deprecated' "
                    "WHERE id = 'plan-1'"
                )
                source_db.execute("UPDATE subjects SET state = 'disabled' WHERE id = 'subject-1'")
                source_db.execute(
                    "UPDATE access_credentials SET revoked_at = '2026-02-01T00:00:00.000Z' "
                    "WHERE id = 'credential-1'"
                )
                source_db.execute(
                    "UPDATE entitlements SET state = 'cancelled', "
                    "cancelled_at = '2026-02-01T00:00:00.000Z', "
                    "cancelled_reason = 'unit-test' WHERE id = 'entitlement-1'"
                )
                source_db.execute(
                    "UPDATE unified_client_keys SET revoked_at = '2026-02-01T00:00:00.000Z' "
                    "WHERE id = 'unified-1'"
                )
                source_db.execute(
                    "UPDATE upstream_v2_bindings SET state = 'disabled' WHERE subject_id = 'subject-1'"
                )
                insert_user_chain(source_db, "2")
                source_db.commit()
            finally:
                source_db.close()

            target_db = sqlite3.connect(target)
            try:
                target_db.execute(
                    "INSERT INTO subjects VALUES ('target-only', 'target-only', 'active', "
                    "'2026-01-09T00:00:00.000Z', NULL, NULL, 'local', 'target-only', 'target-only')"
                )
                target_db.execute("INSERT INTO request_events VALUES ('request-1', 'ok')")
                target_db.commit()
            finally:
                target_db.close()

            exported = json.loads(run_helper("export", source).stdout)
            plan = json.loads(run_helper("plan", target, payload=exported).stdout)
            self.assertTrue(plan["apply_required"])
            self.assertGreater(plan["changed_rows"], 0)
            self.assertEqual(plan["tables"]["subjects"]["target_only"], 1)

            backup_result = json.loads(
                run_helper("backup", target, extra=["--output", str(backup)]).stdout
            )
            self.assertEqual(backup_result["integrity"]["quick_check"], "ok")
            self.assertTrue(backup.is_file())

            applied = json.loads(
                run_helper(
                    "apply",
                    target,
                    payload=exported,
                    extra=["--backup-id", "unit-test-backup.db"],
                ).stdout
            )
            self.assertTrue(applied["applied"])

            target_db = sqlite3.connect(target)
            try:
                self.assertEqual(
                    target_db.execute("SELECT display_name FROM plans WHERE id = 'plan-1'").fetchone()[0],
                    "Authoritative plan",
                )
                self.assertEqual(
                    target_db.execute("SELECT state FROM plans WHERE id = 'plan-1'").fetchone()[0],
                    "deprecated",
                )
                self.assertEqual(
                    target_db.execute("SELECT state FROM subjects WHERE id = 'subject-1'").fetchone()[0],
                    "disabled",
                )
                self.assertEqual(
                    target_db.execute(
                        "SELECT revoked_at FROM access_credentials WHERE id = 'credential-1'"
                    ).fetchone()[0],
                    "2026-02-01T00:00:00.000Z",
                )
                self.assertEqual(
                    target_db.execute(
                        "SELECT state FROM entitlements WHERE id = 'entitlement-1'"
                    ).fetchone()[0],
                    "cancelled",
                )
                self.assertEqual(
                    target_db.execute(
                        "SELECT revoked_at FROM unified_client_keys WHERE id = 'unified-1'"
                    ).fetchone()[0],
                    "2026-02-01T00:00:00.000Z",
                )
                self.assertEqual(
                    target_db.execute(
                        "SELECT state FROM upstream_v2_bindings WHERE subject_id = 'subject-1'"
                    ).fetchone()[0],
                    "disabled",
                )
                self.assertEqual(
                    target_db.execute("SELECT COUNT(*) FROM subjects WHERE id = 'target-only'").fetchone()[0],
                    1,
                )
                self.assertEqual(target_db.execute("SELECT COUNT(*) FROM request_events").fetchone()[0], 1)
                audit = target_db.execute(
                    "SELECT params_json FROM admin_audit_events "
                    "WHERE action = 'gateway-control-state-sync'"
                ).fetchone()
                self.assertIsNotNone(audit)
                self.assertNotIn("ciphertext-", audit[0])
                self.assertEqual(target_db.execute("PRAGMA foreign_key_check").fetchall(), [])
            finally:
                target_db.close()

            second_plan = json.loads(run_helper("plan", target, payload=exported).stdout)
            self.assertEqual(second_plan["changed_rows"], 0)
            self.assertFalse(second_plan["apply_required"])

    def test_unique_identity_conflict_fails_without_writes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.db"
            target = root / "target.db"
            create_database(source)
            create_database(target, with_initial_user=False)
            target_db = sqlite3.connect(target)
            try:
                target_db.execute(
                    "INSERT INTO subjects VALUES ('different-id', 'conflict', 'active', "
                    "'2026-01-01T00:00:00.000Z', NULL, NULL, 'manual', 'external-1', 'conflict')"
                )
                target_db.commit()
            finally:
                target_db.close()

            exported = json.loads(run_helper("export", source).stdout)
            before = target.stat().st_size
            completed = run_helper("apply", target, payload=exported, check=False)
            self.assertNotEqual(completed.returncode, 0)
            self.assertIn("Unique identity conflict", completed.stderr)

            target_db = sqlite3.connect(target)
            try:
                self.assertEqual(target_db.execute("SELECT COUNT(*) FROM subjects").fetchone()[0], 1)
                self.assertEqual(target_db.execute("SELECT COUNT(*) FROM access_credentials").fetchone()[0], 0)
                self.assertEqual(target_db.execute("SELECT COUNT(*) FROM admin_audit_events").fetchone()[0], 0)
            finally:
                target_db.close()
            self.assertGreaterEqual(target.stat().st_size, before)

    def test_immutable_ciphertext_conflict_fails_without_writes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.db"
            target = root / "target.db"
            create_database(source)
            create_database(target)
            target_db = sqlite3.connect(target)
            try:
                target_db.execute(
                    "UPDATE unified_client_keys SET codex_key_ciphertext = 'different' "
                    "WHERE id = 'unified-1'"
                )
                target_db.commit()
            finally:
                target_db.close()

            exported = json.loads(run_helper("export", source).stdout)
            completed = run_helper("apply", target, payload=exported, check=False)
            self.assertNotEqual(completed.returncode, 0)
            self.assertIn("Immutable identity conflict", completed.stderr)
            target_db = sqlite3.connect(target)
            try:
                self.assertEqual(
                    target_db.execute(
                        "SELECT codex_key_ciphertext FROM unified_client_keys WHERE id = 'unified-1'"
                    ).fetchone()[0],
                    "different",
                )
                self.assertEqual(target_db.execute("SELECT COUNT(*) FROM admin_audit_events").fetchone()[0], 0)
            finally:
                target_db.close()


if __name__ == "__main__":
    unittest.main()
