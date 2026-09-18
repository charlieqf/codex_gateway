import { afterEach, describe, expect, it } from "vitest";
import { createSqliteStore, type SqliteGatewayStore } from "./index.js";
import { migrateGatewaySchema } from "./migrations.js";
import type { IdentityRequestEvent, IdentityRateLimitEvent } from "@codex-gateway/core";

const stores: SqliteGatewayStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
function fixture() { const store = createSqliteStore({ path: ":memory:" }); stores.push(store); return store; }
const event = (patch: Partial<IdentityRequestEvent> = {}): IdentityRequestEvent => ({
  requestId: "req-audit-test", operation: "phone_login", method: "POST", routeTemplate: "/gateway/auth/v1/login/start",
  startedAt: "2026-09-18T00:00:00.000Z", completedAt: "2026-09-18T00:00:00.010Z", durationMs: 10,
  httpStatus: 403, transportOutcome: "responded", outcome: "rejected", errorCode: "phone_not_registered",
  reasonCode: "phone_not_registered", stage: "account_readiness", phoneInput: "13800138000", phoneNormalized: "+8613800138000",
  phoneCaptureStatus: "captured", provider: null, externalUserId: null, subjectId: null, targetSubjectId: null,
  conflictingSubjectId: null, resolvedPhone: null, sessionId: null, jobId: null, clientVersion: "2.0.0-beta.76", ...patch
});
const limited = (patch: Partial<IdentityRateLimitEvent> = {}): IdentityRateLimitEvent => ({
  requestId: "req-limited", operation: "phone_login", limitDimension: "ip", limitKind: "request_minute",
  origin: "gateway", errorCode: "auth_rate_limited", completedAt: "2026-09-18T00:00:30.000Z",
  phoneInput: "13800138000", phoneNormalized: "+8613800138000", ...patch
});

describe("identity audit storage", () => {
  it("adds migration 34 to schema 33 without modifying existing data and can repeat", () => {
    const store = fixture();
    store.upsertSubject({ id: "test-preserved", label: "Preserved", state: "active", createdAt: new Date() });
    const before = store.listSubjects();
    store.database.exec("DROP TABLE identity_request_events; DROP TABLE identity_rate_limit_minutes; DELETE FROM schema_migrations WHERE version=34;");
    migrateGatewaySchema(store.database);
    migrateGatewaySchema(store.database);
    expect(store.listSubjects()).toEqual(before);
    expect(store.database.prepare("SELECT count(*) AS n FROM schema_migrations WHERE version=34").get()).toEqual({ n: 1 });
    expect(store.database.prepare("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" });
    expect(store.database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
  it("deduplicates request IDs and rejects oversized fields", () => {
    const store = fixture();
    store.recordIdentityRequestEvent(event());
    store.recordIdentityRequestEvent(event());
    expect(store.database.prepare("SELECT count(*) AS n FROM identity_request_events").get()).toEqual({ n: 1 });
    expect(() => store.recordIdentityRequestEvent(event({ requestId: "too-long", phoneInput: "1".repeat(65) }))).toThrow();
  });
  it("indexes only present identity selectors without dropping request evidence", () => {
    const store = fixture();
    store.recordIdentityRequestEvent(event());
    store.recordIdentityRequestEvent(event({ requestId: "early-gate", phoneInput: null, phoneNormalized: null,
      phoneCaptureStatus: "not_available", httpStatus: 426, errorCode: "client_upgrade_required" }));
    const indexes = store.database.prepare("PRAGMA index_list(identity_request_events)").all() as Array<{ name: string; partial: number }>;
    for (const name of ["phone", "resolved_phone", "external", "subject", "job"]) {
      expect(indexes.find(index => index.name === `idx_identity_request_${name}`)?.partial).toBe(1);
    }
    expect(store.database.prepare("SELECT request_id FROM identity_request_events WHERE phone_normalized=?").all("+8613800138000"))
      .toEqual([{ request_id: "req-audit-test" }]);
    expect(store.database.prepare("SELECT count(*) AS n FROM identity_request_events").get()).toEqual({ n: 2 });
  });
  it("bounds cardinality for rotating request identities and keeps first/last samples", () => {
    const store = fixture();
    for (let i = 0; i < 1_000; i++) store.recordIdentityRateLimit(limited({ requestId: `req-${i}` }));
    expect(store.database.prepare("SELECT count(*) AS n,sum(rejection_count) AS requests FROM identity_rate_limit_minutes").get())
      .toEqual({ n: 1, requests: 1_000 });
    expect(store.database.prepare("SELECT first_request_id,last_request_id FROM identity_rate_limit_minutes").get())
      .toEqual({ first_request_id: "req-0", last_request_id: "req-999" });
    store.recordIdentityRateLimit(limited({ completedAt: "2026-09-18T00:01:00.000Z" }));
    expect(store.database.prepare("SELECT count(*) AS n FROM identity_rate_limit_minutes").get()).toEqual({ n: 2 });
  });
  it("prunes only expired audit rows with a bounded batch", () => {
    const store = fixture();
    for (let i = 0; i < 3; i++) store.recordIdentityRequestEvent(event({ requestId: `old-${i}`, completedAt: "2026-08-01T00:00:00.000Z" }));
    store.recordIdentityRequestEvent(event());
    store.recordIdentityRateLimit(limited({ completedAt: "2026-09-01T00:00:00.000Z" }));
    store.recordIdentityRateLimit(limited());
    expect(store.pruneIdentityRequestAudit(new Date("2026-09-18T00:00:31Z"), 2)).toEqual({ requests: 2, minutes: 1 });
    expect(store.database.prepare("SELECT count(*) AS n FROM identity_request_events").get()).toEqual({ n: 2 });
    expect(() => store.pruneIdentityRequestAudit(new Date(), 0)).toThrow();
  });
});
