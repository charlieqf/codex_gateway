import { describe, expect, it } from "vitest";
import { issueAccessCredential, normalizeCredentialRatePolicy } from "@codex-gateway/core";
import { createSqliteStore } from "./index.js";
import { migrateGatewaySchema } from "./migrations.js";

describe("credential daily request floor", () => {
  it.each([10, 200, 500, 600, 5000, null])("preserves other limits and normalizes %s", (daily) => {
    const rate = { requestsPerMinute: 20, requestsPerDay: daily, concurrentRequests: 4 };
    const expected = daily === null ? null : Math.max(500, daily);
    expect(normalizeCredentialRatePolicy(rate)).toEqual({ ...rate, requestsPerDay: expected });
    expect(rate.requestsPerDay).toBe(daily);
    expect(issueAccessCredential({ subjectId: "s", label: "floor", scope: "code",
      expiresAt: new Date("2030-01-01"), rate }).record.rate.requestsPerDay).toBe(expected);
  });

  it("migrates existing finite quotas once and enforces the floor on insert/update", () => {
    const store = createSqliteStore({ path: ":memory:" });
    try {
      store.database.prepare("INSERT INTO subjects(id,label,state,created_at) VALUES(?,?,?,?)")
        .run("s", "floor test", "active", new Date().toISOString());
      const fixtures = [200, 500, 600, null, 10].map((daily, index) => {
        const record = issueAccessCredential({ subjectId: "s", label: `test-${index}`, scope: "code",
          expiresAt: new Date("2030-01-01"), rate: { requestsPerMinute: 20, requestsPerDay: daily, concurrentRequests: 4 } }).record;
        store.insertAccessCredential(record);
        expect(store.getAccessCredentialByPrefix(record.prefix)?.rate.requestsPerDay)
          .toBe(daily === null ? null : Math.max(500, daily));
        // Simulate a pre-floor database, including a historical revoked key.
        store.database.prepare("UPDATE access_credentials SET rate_json=?, revoked_at=? WHERE id=?")
          .run(JSON.stringify({ requestsPerMinute: 20, requestsPerDay: daily, concurrentRequests: 4 }),
            index === 4 ? new Date().toISOString() : null, record.id);
        return record;
      });
      store.database.exec("DELETE FROM schema_migrations WHERE version=42");
      migrateGatewaySchema(store.database);
      migrateGatewaySchema(store.database);
      const stored = fixtures.map(r => JSON.parse((store.database.prepare("SELECT rate_json FROM access_credentials WHERE id=?")
        .get(r.id) as { rate_json: string }).rate_json));
      expect(stored).toEqual([500, 500, 600, null, 10].map(requestsPerDay => ({ requestsPerMinute: 20, requestsPerDay, concurrentRequests: 4 })));
      expect(store.updateAccessCredentialByPrefix(fixtures[0]!.prefix, {
        rate: { requestsPerMinute: 30, requestsPerDay: 100, concurrentRequests: 8 }
      })?.rate).toEqual({ requestsPerMinute: 30, requestsPerDay: 500, concurrentRequests: 8 });
      expect(store.database.prepare("SELECT COUNT(*) n FROM schema_migrations WHERE version=42").get()).toEqual({ n: 1 });
      expect(store.database.prepare("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" });
      expect(store.database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally { store.close(); }
  });
});
