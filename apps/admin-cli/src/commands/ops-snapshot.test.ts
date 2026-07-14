import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { buildOpsSnapshot } from "./ops-snapshot.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("buildOpsSnapshot", () => {
  it("reads request aggregates without mutating the database", () => {
    const directory = mkdtempSync(join(tmpdir(), "gateway-ops-snapshot-"));
    temporaryDirectories.push(directory);
    const dbPath = join(directory, "gateway.db");
    const runtimePath = join(directory, "runtime.json");
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE request_events (
        request_id TEXT PRIMARY KEY,
        subject_id TEXT,
        upstream_account_id TEXT,
        public_model_id TEXT,
        started_at TEXT NOT NULL,
        duration_ms INTEGER,
        first_byte_ms INTEGER,
        status TEXT NOT NULL,
        error_code TEXT,
        rate_limited INTEGER NOT NULL DEFAULT 0,
        limit_kind TEXT,
        upstream_attempts_json TEXT
      );
      CREATE TABLE upstream_accounts (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        state TEXT NOT NULL,
        cooldown_until TEXT,
        last_used_at TEXT
      );
    `);
    const insert = db.prepare(
      `INSERT INTO request_events (
         request_id, subject_id, upstream_account_id, public_model_id, started_at,
         duration_ms, first_byte_ms, status, error_code, rate_limited, limit_kind,
         upstream_attempts_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    insert.run(
      "req-upstream-rate",
      "user-1",
      "account-1",
      "max",
      "2026-07-14T00:09:00.000Z",
      70_000,
      60_000,
      "error",
      "rate_limited",
      1,
      null,
      JSON.stringify([{ kind: "native_initial" }])
    );
    insert.run(
      "req-user-rate",
      "user-2",
      "account-1",
      "max",
      "2026-07-14T00:08:00.000Z",
      2,
      null,
      "error",
      "rate_limited",
      1,
      "concurrency",
      null
    );
    insert.run(
      "req-timeout",
      "user-1",
      "account-2",
      "goldencode",
      "2026-07-14T00:07:00.000Z",
      180_000,
      null,
      "error",
      "upstream_timeout",
      0,
      null,
      null
    );
    insert.run(
      "req-unknown-rate",
      "user-3",
      null,
      "standard",
      "2026-07-14T00:06:00.000Z",
      5,
      null,
      "error",
      "rate_limited",
      1,
      null,
      null
    );
    db.prepare(
      `INSERT INTO upstream_accounts (id, provider, state, cooldown_until, last_used_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run("account-1", "codex", "active", null, "2026-07-14T00:09:00.000Z");
    db.close();
    writeFileSync(runtimePath, JSON.stringify({ schemaVersion: 1, inflightRequests: 2 }));

    const beforeDb = new DatabaseSync(dbPath, { readOnly: true });
    const before = beforeDb.prepare("SELECT COUNT(*) AS count FROM request_events").get() as {
      count: number;
    };
    beforeDb.close();
    const snapshot = buildOpsSnapshot({
      dbPath,
      runtimeSnapshotPath: runtimePath,
      now: new Date("2026-07-14T00:10:00.000Z")
    });
    const afterDb = new DatabaseSync(dbPath, { readOnly: true });
    const after = afterDb.prepare("SELECT COUNT(*) AS count FROM request_events").get() as {
      count: number;
    };
    afterDb.close();

    expect(snapshot.runtimeSnapshotStatus).toBe("ok");
    expect(snapshot.runtime).toMatchObject({ inflightRequests: 2 });
    expect(snapshot.windows["5m"]).toMatchObject({
      total: 4,
      affectedUsers: 3,
      infrastructureAffectedUsers: 1,
      infrastructureErrors: 1,
      upstreamRateLimited: 1,
      userRateLimited: 1,
      rateLimitOriginUnknown: 1,
      p95DurationMs: 180_000,
      p95FirstByteMs: 60_000,
      byModel: { max: 2, goldencode: 1, standard: 1 }
    });
    expect(snapshot.upstreamAccounts).toHaveLength(1);
    expect(after.count).toBe(before.count);
  });

  it("degrades safely when the runtime snapshot and optional tables are absent", () => {
    const directory = mkdtempSync(join(tmpdir(), "gateway-ops-snapshot-empty-"));
    temporaryDirectories.push(directory);
    const dbPath = join(directory, "gateway.db");
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE placeholder (id INTEGER PRIMARY KEY)");
    db.close();

    const snapshot = buildOpsSnapshot({ dbPath });
    expect(snapshot.runtimeSnapshotStatus).toBe("missing");
    expect(snapshot.windows["5m"].total).toBe(0);
    expect(snapshot.upstreamAccounts).toEqual([]);
  });
});
