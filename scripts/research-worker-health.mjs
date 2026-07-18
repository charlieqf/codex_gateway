import { DatabaseSync } from "node:sqlite";

const databasePath = process.env.RESEARCH_DB_PATH;
const workerId = process.env.RESEARCH_WORKER_ID;
const staleSeconds = Number(process.env.RESEARCH_HEARTBEAT_STALE_SECONDS);

if (
  !databasePath ||
  !workerId ||
  !Number.isSafeInteger(staleSeconds) ||
  staleSeconds <= 0
) {
  process.exit(1);
}

let database;
try {
  database = new DatabaseSync(databasePath, { readOnly: true });
  const row = database
    .prepare(
      `SELECT state, last_seen_at
       FROM research_worker_heartbeats
       WHERE worker_id = ?`
    )
    .get(workerId);
  const lastSeenAt =
    row && typeof row.last_seen_at === "string"
      ? Date.parse(row.last_seen_at)
      : Number.NaN;
  const healthy =
    row?.state === "ready" &&
    Number.isFinite(lastSeenAt) &&
    Date.now() - lastSeenAt >= 0 &&
    Date.now() - lastSeenAt <= staleSeconds * 1_000;
  process.exitCode = healthy ? 0 : 1;
} catch {
  process.exitCode = 1;
} finally {
  database?.close();
}
