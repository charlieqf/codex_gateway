import os
import sqlite3
import subprocess
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path


REPOSITORY = Path(__file__).resolve().parents[1]


class ResearchHealthScriptTests(unittest.TestCase):
    def test_beta_smoke_rejects_localhost_before_reading_any_secret(self):
        environment = {
            **os.environ,
            "RESEARCH_SMOKE_BASE_URL": "http://localhost:18788",
            "RESEARCH_SMOKE_USER_TOKEN_FILE": "must-not-be-read",
            "RESEARCH_SMOKE_REQUEST_FILE": "must-not-be-read",
            "RESEARCH_SMOKE_OUTPUT_DIR": "must-not-be-created",
        }
        result = subprocess.run(
            ["node", "scripts/research-beta-smoke.mjs"],
            cwd=REPOSITORY,
            env=environment,
            check=False,
            capture_output=True,
            text=True,
            timeout=10,
        )
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, "")
        self.assertIn("literal HTTP loopback", result.stderr)
        self.assertFalse((REPOSITORY / "must-not-be-created").exists())

    def test_worker_health_requires_current_ready_heartbeat(self):
        with tempfile.TemporaryDirectory() as directory:
            database_path = Path(directory) / "research.db"
            connection = sqlite3.connect(database_path)
            connection.execute(
                """
                CREATE TABLE research_worker_heartbeats (
                  worker_id TEXT PRIMARY KEY,
                  state TEXT NOT NULL,
                  last_seen_at TEXT NOT NULL
                )
                """
            )
            now = datetime.now(timezone.utc)
            connection.execute(
                """
                INSERT INTO research_worker_heartbeats (
                  worker_id, state, last_seen_at
                ) VALUES (?, ?, ?)
                """,
                ("worker-health-test", "ready", iso(now)),
            )
            connection.commit()
            connection.close()

            self.assertEqual(
                run_health(
                    "scripts/research-worker-health.mjs",
                    database_path,
                    {
                        "RESEARCH_WORKER_ID": "worker-health-test",
                        "RESEARCH_HEARTBEAT_STALE_SECONDS": "45",
                    },
                ),
                0,
            )

            connection = sqlite3.connect(database_path)
            connection.execute(
                """
                UPDATE research_worker_heartbeats
                SET last_seen_at = ?
                WHERE worker_id = ?
                """,
                (iso(now + timedelta(minutes=5)), "worker-health-test"),
            )
            connection.commit()
            connection.close()
            self.assertEqual(
                run_health(
                    "scripts/research-worker-health.mjs",
                    database_path,
                    {
                        "RESEARCH_WORKER_ID": "worker-health-test",
                        "RESEARCH_HEARTBEAT_STALE_SECONDS": "45",
                    },
                ),
                1,
            )

    def test_maintenance_health_requires_fresh_non_future_backup(self):
        with tempfile.TemporaryDirectory() as directory:
            database_path = Path(directory) / "research.db"
            connection = sqlite3.connect(database_path)
            connection.execute(
                """
                CREATE TABLE research_backup_runs (
                  backup_id TEXT PRIMARY KEY,
                  state TEXT NOT NULL,
                  completed_at TEXT
                )
                """
            )
            now = datetime.now(timezone.utc)
            connection.execute(
                """
                INSERT INTO research_backup_runs (
                  backup_id, state, completed_at
                ) VALUES (?, ?, ?)
                """,
                ("backup-health-test", "succeeded", iso(now)),
            )
            connection.commit()
            connection.close()

            health_environment = {
                "RESEARCH_BACKUP_MAX_AGE_SECONDS": "7200"
            }
            self.assertEqual(
                run_health(
                    "scripts/research-maintenance-health.mjs",
                    database_path,
                    health_environment,
                ),
                0,
            )

            connection = sqlite3.connect(database_path)
            connection.execute(
                """
                UPDATE research_backup_runs
                SET completed_at = ?
                WHERE backup_id = ?
                """,
                (iso(now + timedelta(minutes=5)), "backup-health-test"),
            )
            connection.commit()
            connection.close()
            self.assertEqual(
                run_health(
                    "scripts/research-maintenance-health.mjs",
                    database_path,
                    health_environment,
                ),
                1,
            )


def run_health(
    script: str,
    database_path: Path,
    extra_environment: dict[str, str],
) -> int:
    environment = {
        **os.environ,
        "RESEARCH_DB_PATH": str(database_path),
        **extra_environment,
    }
    return subprocess.run(
        ["node", script],
        cwd=REPOSITORY,
        env=environment,
        check=False,
        capture_output=True,
        text=True,
        timeout=10,
    ).returncode


def iso(value: datetime) -> str:
    return value.isoformat(timespec="milliseconds").replace("+00:00", "Z")


if __name__ == "__main__":
    unittest.main()
