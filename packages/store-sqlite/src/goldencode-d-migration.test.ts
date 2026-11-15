import { describe, expect, it } from "vitest";
import { issueAccessCredential, type CredentialClass } from "@codex-gateway/core";
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

describe("Desktop long-document model migration", () => {
  it("extends standard Desktop credentials only, preserves other fields and is idempotent", () => {
    const store = createSqliteStore({ path: ":memory:" });
    const now = new Date("2026-11-15T00:00:00Z");
    const standard = ["goldencode", "goldencode-d", "goldencode-local"];
    const extended = ["goldencode", "goldencode-d", "goldencode-d-long", "goldencode-local"];
    const cases: Array<{ kind: CredentialClass; models: string[] | null; extend?: boolean; revoked?: boolean }> = [
      { kind: "desktop", models: standard, extend: true },
      { kind: "desktop", models: [...standard].reverse(), extend: true },
      { kind: "unknown", models: standard, extend: true },
      { kind: "service", models: standard },
      { kind: "operator", models: standard },
      { kind: "desktop", models: ["goldencode-d"] },
      { kind: "desktop", models: ["goldencode", "goldencode-d", "custom"] },
      { kind: "desktop", models: null },
      { kind: "desktop", models: standard, revoked: true },
      { kind: "desktop", models: extended }
    ];
    try {
      store.upsertSubject({ id: "long-migration", label: "Long migration", state: "active", createdAt: now });
      for (const [i, item] of cases.entries()) {
        const issued = issueAccessCredential({ subjectId: "long-migration", scope: "code", label: String(i).padStart(2, "0"), now,
          expiresAt: new Date("2027-01-01T00:00:00Z"), credentialClass: item.kind, allowedPublicModels: item.models,
          rate: { requestsPerMinute: 17, concurrentRequests: 2, token: {
            tokensPerMinute: null, tokensPerDay: null, tokensPerMonth: null, tokensTotal: null,
            maxPromptTokensPerRequest: 12345, maxTotalTokensPerRequest: null,
            reserveTokensPerRequest: 8192, missingUsageCharge: "estimate"
          } },
          knownPublicModelIds: [...extended, "custom"] });
        store.insertAccessCredential(issued.record);
        if (item.revoked) store.revokeAccessCredentialByPrefix(issued.record.prefix, now);
      }
      const rows = () => store.database.prepare("SELECT * FROM access_credentials ORDER BY label").all();
      const before = rows();
      store.database.exec("DELETE FROM schema_migrations WHERE version=45");
      migrateGatewaySchema(store.database);
      const after = rows();
      for (const [i, row] of after.entries()) {
        expect(row).toEqual({ ...before[i], allowed_public_models_json: cases[i].extend
          ? JSON.stringify(extended) : before[i].allowed_public_models_json });
      }
      migrateGatewaySchema(store.database);
      expect(rows()).toEqual(after);
      expect(store.database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally { store.close(); }
  });
});
