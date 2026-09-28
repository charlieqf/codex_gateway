import type { DatabaseSync } from "node:sqlite";

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
    const total = json
      ? (this.db
          .prepare(
            "SELECT COALESCE(SUM(response_bytes), 0) AS bytes FROM model_calls",
          )
          .get() as { bytes: number })
      : { bytes: 0 };
    const saved =
      json &&
      size <= 8 * 1024 * 1024 &&
      total.bytes + size <= 256 * 1024 * 1024;
    const state = saved ? (outcome ?? (response!.status < 400 ? "completed" : "failed")) : "unknown";
    const result = this.db
      .prepare(
        `UPDATE model_calls SET state=?, response_json=?, response_bytes=?
      WHERE subject_id=? AND scope=? AND id=? AND state='running'`,
      )
      .run(
        state,
        saved ? json : null,
        saved ? size : 0,
        subject,
        scope,
        id,
      );
    return result.changes ? state : undefined;
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
