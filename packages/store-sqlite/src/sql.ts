import type { DatabaseSync } from "node:sqlite";

export function runInTransaction<T>(
  db: DatabaseSync,
  begin: "BEGIN" | "BEGIN IMMEDIATE",
  fn: () => T
): T {
  db.exec(begin);
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
