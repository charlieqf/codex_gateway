import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createSqliteStore } from "./index.js";
import { SqliteModelCalls } from "./model-calls.js";

describe("model call receipt persistence", () => {
  it("upgrades v35 without replacing data and retains success/failure/unknown across reopen", () => {
    const directory = mkdtempSync(join(tmpdir(), "gateway-model-calls-"));
    const path = join(directory, "gateway.db");
    let store = createSqliteStore({ path });
    try {
      store.upsertSubject({ id: "subject", label: "Preserved", state: "active", createdAt: new Date() });
      store.database.exec("DROP TABLE model_calls; DELETE FROM schema_migrations WHERE version=36;");
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
});
