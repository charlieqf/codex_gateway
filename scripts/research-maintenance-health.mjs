import { DatabaseSync } from "node:sqlite";

const databasePath = process.env.RESEARCH_DB_PATH;
const maximumAgeSeconds = Number(
  process.env.RESEARCH_BACKUP_MAX_AGE_SECONDS
);

if (
  !databasePath ||
  !Number.isSafeInteger(maximumAgeSeconds) ||
  maximumAgeSeconds <= 0
) {
  process.exit(1);
}

let database;
try {
  database = new DatabaseSync(databasePath, { readOnly: true });
  const row = database
    .prepare(
      `SELECT completed_at
       FROM research_backup_runs
       WHERE state = 'succeeded'
         AND completed_at IS NOT NULL
       ORDER BY completed_at DESC, backup_id DESC
       LIMIT 1`
    )
    .get();
  const completedAt =
    row && typeof row.completed_at === "string"
      ? Date.parse(row.completed_at)
      : Number.NaN;
  const ageMs = Date.now() - completedAt;
  process.exitCode =
    Number.isFinite(completedAt) &&
    ageMs >= 0 &&
    ageMs <= maximumAgeSeconds * 1_000
      ? 0
      : 1;
} catch {
  process.exitCode = 1;
} finally {
  database?.close();
}
