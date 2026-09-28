import type { DatabaseSync } from "node:sqlite";

export const modelCallMaxResponseBytes = 8 * 1024 * 1024;
export const modelCallCapacityBytes = 256 * 1024 * 1024;

export const modelCallSchema = `
  CREATE TABLE model_calls (
    subject_id TEXT NOT NULL, scope TEXT NOT NULL, id TEXT NOT NULL,
    fingerprint TEXT NOT NULL, request_id TEXT NOT NULL, owner TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('running', 'completed', 'failed', 'unknown', 'expired')),
    response_json TEXT, response_bytes INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
    PRIMARY KEY(subject_id, scope, id)
  );
  CREATE INDEX idx_model_calls_expiry ON model_calls(expires_at);
`;

// Backfill once at migration. Triggers keep the counter in the same SQLite
// transaction as each receipt mutation, including expiry and legacy writers.
export const modelCallCapacitySchema = `
  CREATE TABLE model_call_capacity (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    response_bytes INTEGER NOT NULL CHECK (response_bytes >= 0)
  );
  INSERT INTO model_call_capacity
    SELECT 1, COALESCE(SUM(response_bytes), 0) FROM model_calls;
  CREATE TRIGGER model_calls_capacity_insert AFTER INSERT ON model_calls
    WHEN NEW.response_bytes != 0 BEGIN
      UPDATE model_call_capacity SET response_bytes = response_bytes + NEW.response_bytes WHERE id = 1;
    END;
  CREATE TRIGGER model_calls_capacity_update AFTER UPDATE OF response_bytes ON model_calls
    WHEN OLD.response_bytes != NEW.response_bytes BEGIN
      UPDATE model_call_capacity SET response_bytes = response_bytes + NEW.response_bytes - OLD.response_bytes WHERE id = 1;
    END;
  CREATE TRIGGER model_calls_capacity_delete AFTER DELETE ON model_calls
    WHEN OLD.response_bytes != 0 BEGIN
      UPDATE model_call_capacity SET response_bytes = response_bytes - OLD.response_bytes WHERE id = 1;
    END;
`;

export type ModelCallResponse = {
  status: number;
  headers: Record<string, string>;
  body: string;
};
export type ModelCall = {
  id: string;
  fingerprint: string;
  request_id: string;
  owner: string;
  state: "running" | "completed" | "failed" | "unknown" | "expired";
  response_json: string | null;
  expires_at: number;
};

export class SqliteModelCalls {
  constructor(private readonly db: DatabaseSync) {}

  get(subject: string, scope: string, id: string): ModelCall | undefined {
    return this.db
      .prepare(
        "SELECT id, fingerprint, request_id, owner, state, response_json, expires_at FROM model_calls WHERE subject_id=? AND scope=? AND id=?",
      )
      .get(subject, scope, id) as ModelCall | undefined;
  }

  admit(input: {
    subject: string;
    scope: string;
    id: string;
    fingerprint: string;
    request: string;
    owner: string;
    now: number;
  }) {
    return (
      this.db
        .prepare(
          `INSERT OR IGNORE INTO model_calls
      (subject_id, scope, id, fingerprint, request_id, owner, state, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?)`,
        )
        .run(
          input.subject,
          input.scope,
          input.id,
          input.fingerprint,
          input.request,
          input.owner,
          input.now,
          input.now + 86_400_000,
        ).changes === 1
    );
  }

  finish(
    subject: string,
    scope: string,
    id: string,
    response?: ModelCallResponse,
    outcome?: "completed" | "failed",
  ) {
    const json = response ? JSON.stringify(response) : undefined;
    const size = json ? Buffer.byteLength(json) : 0;
    if (json && size <= modelCallMaxResponseBytes) {
      // Admission and the trigger's counter increment are one atomic write.
      // No read/check/write race or history-sized scan on the response path.
      const saved = this.db.prepare(`
        UPDATE model_calls SET state=?, response_json=?, response_bytes=?
        WHERE subject_id=? AND scope=? AND id=? AND state='running'
          AND ? <= (SELECT ? - response_bytes FROM model_call_capacity WHERE id=1)
        RETURNING state
      `).get(outcome ?? (response!.status < 400 ? "completed" : "failed"),
        json, size, subject, scope, id, size, modelCallCapacityBytes) as Pick<ModelCall, "state"> | undefined;
      if (saved) return saved.state;
    }
    return (this.db.prepare(`
      UPDATE model_calls SET state='unknown', response_json=NULL, response_bytes=0
      WHERE subject_id=? AND scope=? AND id=? AND state='running' RETURNING state
    `).get(subject, scope, id) as Pick<ModelCall, "state"> | undefined)?.state;
  }

  prune(now: number) {
    this.db
      .prepare(
        "UPDATE model_calls SET state='expired', response_json=NULL, response_bytes=0 WHERE expires_at<=? AND state!='expired'",
      )
      .run(now);
    // New IDs older than five minutes are never admitted, even after tombstone removal.
    this.db
      .prepare("DELETE FROM model_calls WHERE expires_at<?")
      .run(now - 7 * 86_400_000);
  }
}
