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
      "2026-07-14T00:08:49.000Z",
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

it("counts long requests at completion, separates model traffic and emits evidence-backed alerts", () => {
  const directory = mkdtempSync(join(tmpdir(), "gateway-timeout-alerts-"));
  temporaryDirectories.push(directory);
  const dbPath = join(directory, "gateway.db");
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE request_events (
    request_id TEXT PRIMARY KEY, subject_id TEXT, upstream_account_id TEXT, public_model_id TEXT,
    started_at TEXT, duration_ms INTEGER, first_byte_ms INTEGER, status TEXT, error_code TEXT,
    rate_limited INTEGER DEFAULT 0, limit_kind TEXT, upstream_attempts_json TEXT,
    terminal_source TEXT, upstream_runtime TEXT
  )`);
  const insert = db.prepare(`INSERT INTO request_events VALUES (?, ?, 'acct', ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, 'tencent')`);
  const now = new Date("2026-10-12T00:30:00.000Z");
  const add = (id: string, subject: string, model: string | null, start: string, duration: number,
    error: string | null = null) => insert.run(id, subject, model, start, duration, duration,
      error ? "error" : "ok", error, error === "upstream_timeout" ? JSON.stringify([{
        errorCode: error, durationMs: duration, contentChars: 0, toolCallCount: 0,
        failure: { kind: "deadline_exceeded", stage: "streaming" },
        streamProgress: { responseBytes: 100, firstResponseByteMs: 10, lastResponseByteMs: duration - 1,
          reasoningChars: 100, observedToolCallCount: 0, toolArgumentBytes: 0 }
      }]) : null, error === "upstream_timeout" ? "gateway_deadline" : null);
  add("long-1", "u1", "goldencode", "2026-10-12T00:18:00Z", 600000, "upstream_timeout");
  add("long-2", "u1", "goldencode", "2026-10-12T00:04:00Z", 600000, "upstream_timeout");
  add("long-3", "u2", "goldencode", "2026-10-12T00:17:00Z", 600000, "upstream_timeout");
  add("long-4", "u2", "goldencode", "2026-10-12T00:16:00Z", 600000, "upstream_timeout");
  add("not-finished-at-cutoff", "u2", "goldencode", "2026-10-12T00:25:00Z", 600000, "upstream_timeout");
  add("cancelled", "u1", "goldencode", "2026-10-12T00:29:00Z", 2000, "client_aborted");
  add("success", "u1", "goldencode", "2026-10-12T00:29:00Z", 30000);
  add("preflight", "u1", "goldencode", "2026-10-12T00:29:00Z", 4, "context_compaction_required");
  for (let i = 0; i < 100; i++) add(`resolver-${i}`, "u1", null, "2026-10-12T00:29:00Z", 4);
  db.close();
  const result = buildOpsSnapshot({ dbPath, now });
  expect(result.windows["5m"]).toMatchObject({ total: 106, timeBasis: "completed_at_derived",
    modelCalls: { total: 5, ok: 1, errors: 4, timeouts: 3, clientAborted: 1,
      timeoutRateDenominator: 4, timeoutRate: 0.75, p95DurationMs: 600000,
      byTimeoutPhase: { reasoning_only: 3 } } });
  expect(result.timeoutAlerts.filter(a => a.kind === "timeout_event")).toHaveLength(4);
  expect(result.timeoutAlerts.filter(a => a.kind === "repeated_user_timeout")).toHaveLength(2);
  expect(result.timeoutAlerts.find(a => a.kind === "channel_timeouts"))
    .toMatchObject({ requests: 3, affectedUsers: 2 });
  expect(JSON.stringify(result.timeoutAlerts)).not.toContain("not-finished-at-cutoff");
  expect(JSON.stringify(result.timeoutAlerts)).not.toContain("resolver-");
  const more = new DatabaseSync(dbPath);
  for (let i = 0; i < 40; i++) more.prepare(`INSERT INTO request_events
    (request_id, subject_id, public_model_id, upstream_runtime, started_at, duration_ms, status)
    VALUES (?, 'u1', 'goldencode', 'tencent', '2026-10-12T00:29:00Z', 1000, 'ok')`).run(`ok-${i}`);
  more.close();
  expect(buildOpsSnapshot({ dbPath, now }).timeoutAlerts.some(a => a.kind === "channel_timeouts")).toBe(false);
  const updates = new DatabaseSync(dbPath);
  updates.exec(`INSERT INTO request_events (request_id, subject_id, public_model_id, upstream_runtime,
    started_at, duration_ms, status, error_code) VALUES
    ('new-timeout', 'u1', 'goldencode', 'tencent', '2026-10-12T00:29:59Z', 1, 'error', 'upstream_timeout')`);
  updates.close();
  const updated = buildOpsSnapshot({ dbPath, now });
  const repeatedId = (snapshot: typeof result) => snapshot.timeoutAlerts.find(a =>
    a.kind === "repeated_user_timeout" && a.requestIds.includes("long-1"))?.id;
  expect(repeatedId(updated)).toBe(repeatedId(result));
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`ALTER TABLE request_events ADD COLUMN upstream_failure_origin TEXT;
    ALTER TABLE request_events ADD COLUMN upstream_failure_kind TEXT;
    ALTER TABLE request_events ADD COLUMN upstream_failure_stage TEXT;
    DELETE FROM request_events WHERE error_code IS NULL;
    UPDATE request_events SET upstream_runtime=NULL, upstream_account_id=NULL;
    UPDATE request_events SET upstream_attempts_json=NULL, terminal_source=NULL,
      upstream_failure_origin='network', upstream_failure_kind='headers_timeout',
      upstream_failure_stage='before_headers' WHERE request_id='long-1';`);
  legacy.close();
  const unknownRoute = buildOpsSnapshot({ dbPath, now });
  expect(unknownRoute.timeoutAlerts.some(a => a.kind === "channel_timeouts")).toBe(false);
  expect(unknownRoute.timeoutAlerts.find(a => a.id === "timeout:long-1")?.diagnosis)
    .toMatchObject({ trigger: "headers_timeout", phase: "awaiting_headers" });
});
