import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createSqliteStore } from "./index.js";
import { SqliteModelCalls, modelCallCapacityBytes } from "./model-calls.js";
import { migrateGatewaySchema } from "./migrations.js";

describe("model call receipt persistence", () => {
  it("upgrades v35 without replacing data and retains success/failure/unknown across reopen", () => {
    const directory = mkdtempSync(join(tmpdir(), "gateway-model-calls-"));
    const path = join(directory, "gateway.db");
    let store = createSqliteStore({ path });
    try {
      store.upsertSubject({ id: "subject", label: "Preserved", state: "active", createdAt: new Date() });
      store.database.exec("DROP TABLE model_calls; DROP TABLE model_call_capacity; DELETE FROM schema_migrations WHERE version IN (36, 37);");
      store.close();
      store = createSqliteStore({ path });
      const calls = new SqliteModelCalls(store.database);
      for (const id of ["success", "failure", "abandoned"]) {
        expect(calls.admit({ subject: "subject", scope: "code", id, fingerprint: "test",
          request: `request-${id}`, owner: "old-process", now: Date.now() })).toBe(true);
      }
      calls.finish("subject", "code", "success", { status: 200, headers: {}, body: "original result" });
      // HTTP 200 is not a success verdict when an SSE error terminates the stream.
      calls.finish("subject", "code", "failure", { status: 200, headers: {}, body: "data: error\n\n" }, "failed");
      calls.finish("subject", "code", "failure");
      store.close();
      store = createSqliteStore({ path });
      const reopened = new SqliteModelCalls(store.database);
      expect(store.getSubject("subject")?.label).toBe("Preserved");
      expect(store.database.prepare("SELECT count(*) AS n FROM schema_migrations WHERE version=36").get()).toEqual({ n: 1 });
      expect(store.database.prepare("SELECT count(*) AS n FROM schema_migrations WHERE version=37").get()).toEqual({ n: 1 });
      expect(store.database.prepare("SELECT response_bytes FROM model_call_capacity").get()).toEqual(
        store.database.prepare("SELECT SUM(response_bytes) AS response_bytes FROM model_calls").get());
      expect(reopened.get("subject", "code", "success")?.state).toBe("completed");
      expect(reopened.get("subject", "code", "failure")?.state).toBe("failed");
      expect(reopened.get("subject", "code", "abandoned")).toMatchObject({ state: "running", owner: "old-process" });
      for (const id of ["success", "failure", "abandoned"]) {
        expect(reopened.admit({ subject: "subject", scope: "code", id, fingerprint: "test",
          request: "new-request", owner: "new-process", now: Date.now() })).toBe(false);
      }
      expect(reopened.get("other-subject", "code", "success")).toBeUndefined();
      expect(reopened.get("subject", "medical", "success")).toBeUndefined();
    } finally {
      store.close();
      if (dirname(resolve(directory)) !== resolve(tmpdir())) throw new Error("Unexpected test directory");
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("backfills v36 receipts once and accounts for expiry and deletion", () => {
    const store = createSqliteStore({ path: ":memory:" });
    try {
      store.database.exec(`DROP TRIGGER model_calls_capacity_insert;
        DROP TRIGGER model_calls_capacity_update; DROP TRIGGER model_calls_capacity_delete;
        DROP TABLE model_call_capacity; DELETE FROM schema_migrations WHERE version=37;`);
      const calls = new SqliteModelCalls(store.database);
      const now = Date.now();
      calls.admit({ subject: "s", scope: "code", id: "legacy", fingerprint: "test", request: "old", owner: "old", now });
      const json = JSON.stringify({ status: 200, headers: {}, body: "old result" });
      store.database.prepare("UPDATE model_calls SET state='completed', response_json=?, response_bytes=?").run(json, Buffer.byteLength(json));
      migrateGatewaySchema(store.database);
      migrateGatewaySchema(store.database);
      const bytes = () => (store.database.prepare("SELECT response_bytes AS n FROM model_call_capacity WHERE id=1").get() as { n: number }).n;
      expect(bytes()).toBe(Buffer.byteLength(json));
      expect(calls.get("s", "code", "legacy")?.response_json).toBe(json);
      calls.prune(now + 86_400_001);
      expect(bytes()).toBe(0);
      expect(calls.get("s", "code", "legacy")?.state).toBe("expired");
      calls.prune(now + 9 * 86_400_000);
      expect(bytes()).toBe(0);
      expect(calls.get("s", "code", "legacy")).toBeUndefined();
    } finally { store.close(); }
  });

  it("shares capacity across connections and rolls back accounting with receipt mutations", () => {
    const directory = mkdtempSync(join(tmpdir(), "gateway-model-calls-"));
    const path = join(directory, "gateway.db");
    const first = createSqliteStore({ path }), second = createSqliteStore({ path });
    try {
      const a = new SqliteModelCalls(first.database), b = new SqliteModelCalls(second.database);
      const now = Date.now();
      for (const id of ["occupancy", "a", "b", "c"]) a.admit({ subject: "s", scope: "code", id,
        fingerprint: "test", request: id, owner: "owner", now });
      const response = { status: 200, headers: {}, body: "new response" };
      const size = Buffer.byteLength(JSON.stringify(response));
      // Synthetic occupancy avoids allocating 256 MiB; the real triggers and
      // admission statement still enforce the exact remaining byte budget.
      first.database.prepare("UPDATE model_calls SET state='completed', response_bytes=? WHERE id='occupancy'").run(modelCallCapacityBytes - size);
      const bytes = () => (second.database.prepare("SELECT response_bytes AS n FROM model_call_capacity WHERE id=1").get() as { n: number }).n;
      expect(a.finish("s", "code", "a", response)).toBe("completed");
      expect(bytes()).toBe(modelCallCapacityBytes);
      expect(b.finish("s", "code", "b", response)).toBe("unknown");
      expect(b.get("s", "code", "b")?.response_json).toBeNull();
      expect(b.finish("s", "code", "a", response)).toBeUndefined();
      expect(bytes()).toBe(modelCallCapacityBytes);
      first.database.exec("BEGIN; DELETE FROM model_calls WHERE id='occupancy'; ROLLBACK;");
      expect(bytes()).toBe(modelCallCapacityBytes);
      first.database.exec("DELETE FROM model_calls WHERE id='a';");
      expect(bytes()).toBe(modelCallCapacityBytes - size);
      expect(b.finish("s", "code", "c", response)).toBe("completed");
      expect(bytes()).toBe(modelCallCapacityBytes);
      b.prune(now + 86_400_001);
      expect(bytes()).toBe(0);
    } finally {
      first.close(); second.close();
      if (dirname(resolve(directory)) !== resolve(tmpdir())) throw new Error("Unexpected test directory");
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
