import { describe, expect, it } from "vitest";
import { issueAccessCredential } from "@codex-gateway/core";
import { createSqliteStore } from "./index.js";
import { migrateGatewaySchema } from "./migrations.js";

describe("DeepSeek model entitlement migration", () => {
  it("extends only the old standard set, preserves all other fields and is idempotent", () => {
    const store = createSqliteStore({ path: ":memory:" });
    const now = new Date("2026-10-23T00:00:00Z");
    try {
      store.upsertSubject({ id: "migration-test", label: "Migration test", state: "active", createdAt: now });
      const allowlists = [["goldencode", "goldencode-local"], ["goldencode-local", "goldencode"],
        ["goldencode"], ["goldencode-local"], ["goldencode", "custom"], null];
      for (const [i, models] of allowlists.entries()) {
        const issued = issueAccessCredential({ subjectId: "migration-test", scope: "code", label: String(i), now,
          expiresAt: new Date("2027-01-01T00:00:00Z"), allowedPublicModels: models,
          knownPublicModelIds: ["goldencode", "goldencode-local", "custom"] });
        store.insertAccessCredential(issued.record);
      }
      const rows = () => store.database.prepare("SELECT * FROM access_credentials ORDER BY label").all();
      const before = rows();
      store.database.exec("DELETE FROM schema_migrations WHERE version=44");
      migrateGatewaySchema(store.database);
      const after = rows();
      for (let i = 0; i < after.length; i++) {
        expect(after[i]).toEqual({ ...before[i], allowed_public_models_json: i < 2
          ? '["goldencode","goldencode-d","goldencode-local"]' : before[i].allowed_public_models_json });
      }
      migrateGatewaySchema(store.database);
      expect(rows()).toEqual(after);
      expect(store.database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally { store.close(); }
  });
});
