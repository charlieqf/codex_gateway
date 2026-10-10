import { afterEach, expect, it } from "vitest";
import { issueAccessCredential, type TokenChargeDecision, type TokenLimitPolicy } from "@codex-gateway/core";
import { createSqliteStore, createSqliteTokenBudgetLimiter } from "./index.js";
import { migrateGatewaySchema } from "./migrations.js";

const stores: ReturnType<typeof createSqliteStore>[] = [];
const now = new Date("2026-09-29T01:00:00Z");
const later = (ms: number) => new Date(now.getTime() + ms);
const waiver: TokenChargeDecision = { reason: "empty_response", exemptAttempts: [1],
  usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
const policy: TokenLimitPolicy = { tokensPerMinute: null, tokensPerDay: 10000, tokensPerMonth: 100000,
  tokensTotal: null, maxPromptTokensPerRequest: null, maxTotalTokensPerRequest: null,
  reserveTokensPerRequest: 25, missingUsageCharge: "estimate" };
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
async function fixture() {
  const store = createSqliteStore({ path: ":memory:" }); stores.push(store);
  store.upsertSubject({ id: "s", label: "synthetic", state: "active", createdAt: now });
  const credential = issueAccessCredential({ subjectId: "s", label: "synthetic", scope: "code", now, expiresAt: later(86400000) });
  store.insertAccessCredential(credential.record);
  const limiter = createSqliteTokenBudgetLimiter({ db: store.database });
  const result = await limiter.acquire({ requestId: "r", credentialId: credential.record.id, subjectId: "s",
    scope: "code", upstreamAccountId: null, provider: null, policy, estimatedPromptTokens: 100, now });
  if (!result.ok) throw result.error;
  const usage = () => limiter.getCurrentUsage({ subjectId: "s", policy, now: later(400000) });
  return { store, limiter, id: result.reservationId, usage };
}
it("renews live work beyond five minutes, then recovers a released orphan", async () => {
  const f = await fixture();
  const release = f.limiter.holdReservation(f.id);
  try {
    expect((await f.limiter.cleanupExpired(later(380000))).count).toBe(0);
    expect((await f.usage()).day.reserved).toBe(125);
  } finally { release(); release(); }
  expect((await f.limiter.cleanupExpired(later(800000))).count).toBe(1);
});
it("corrects a provisional estimate once, including window totals and request counts", async () => {
  const f = await fixture();
  await f.limiter.cleanupExpired(later(301000));
  expect((await f.usage()).day.used).toBe(125);
  const result = await f.limiter.finalize({ reservationId: f.id, now: later(380000),
    usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110 } });
  expect(result).toMatchObject({ finalTotalTokens: 110, finalUsageSource: "provider" });
  await f.limiter.finalize({ reservationId: f.id, usage: { promptTokens: 999, completionTokens: 0, totalTokens: 999 } });
  expect((await f.usage()).day.used).toBe(110);
  expect(f.store.database.prepare("SELECT requests FROM token_windows WHERE window_kind='day'").get()).toMatchObject({ requests: 1 });
  expect(f.store.database.prepare("SELECT state FROM token_settlements").get()).toMatchObject({ state: "corrected" });
});
it("does not resurrect a reset window when actual usage arrives late", async () => {
  const f = await fixture();
  await f.limiter.cleanupExpired(later(301000));
  await f.limiter.resetUsage({ subjectId: "s", policy, windows: ["day", "month"], now: later(350000) });
  await f.limiter.finalize({ reservationId: f.id, usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110 } });
  expect((await f.usage()).day.used).toBe(0);
  expect(f.store.database.prepare("SELECT state FROM token_settlements").get()).toMatchObject({ state: "invalidated" });
});

it("migrates 37 to 38 idempotently without altering existing reservations", async () => {
  const f = await fixture();
  const before = JSON.stringify(f.store.database.prepare("SELECT * FROM token_reservations").all());
  f.store.database.exec(`DROP TRIGGER invalidate_settlement_token_windows;
    DROP TRIGGER invalidate_settlement_entitlement_token_windows;
    DROP TABLE token_settlements; DELETE FROM schema_migrations WHERE version=38;`);
  migrateGatewaySchema(f.store.database);
  migrateGatewaySchema(f.store.database);
  expect(JSON.stringify(f.store.database.prepare("SELECT * FROM token_reservations").all())).toBe(before);
  expect(f.store.database.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE version=38").get()).toMatchObject({ n: 1 });
  expect(f.store.database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
});

it.each([false, true])("waives only cumulative usage and finalizes once (provisional=%s)", async provisional => {
  const f = await fixture();
  if (provisional) await f.limiter.cleanupExpired(later(301000));
  await f.limiter.finalize({ reservationId: f.id, charge: waiver, now: later(380000) });
  expect((await f.usage()).day.used).toBe(0);
  expect(f.store.database.prepare("SELECT total_tokens, requests FROM token_windows WHERE window_kind='minute'").get())
    .toMatchObject({ total_tokens: 125, requests: 1 });
  await f.limiter.finalize({ reservationId: f.id, usage: { promptTokens: 999, completionTokens: 0, totalTokens: 999 } });
  expect((await f.usage()).day.used).toBe(0);
  expect(f.store.database.prepare("SELECT COUNT(*) AS n FROM token_charge_decisions").get()).toMatchObject({ n: 1 });
});

it("bills the successful fallback while retaining observed usage", async () => {
  const f = await fixture();
  await f.limiter.finalize({ reservationId: f.id, now,
    usage: { promptTokens: 120, completionTokens: 10, totalTokens: 130 },
    charge: { ...waiver, usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 } } });
  expect((await f.usage()).day.used).toBe(30);
  expect(f.store.database.prepare("SELECT final_total_tokens FROM token_reservations").get()).toMatchObject({ final_total_tokens: 130 });
});

it("uses the missing-usage estimate for a successful fallback, not the failed attempt usage", async () => {
  const f = await fixture();
  await f.limiter.finalize({ reservationId: f.id, now,
    usage: { promptTokens: 20, completionTokens: 0, totalTokens: 20 }, charge: { ...waiver, usage: null } });
  expect((await f.usage()).day.used).toBe(125);
});

it("does not restore or subtract reset balances when a waiver arrives late", async () => {
  const f = await fixture();
  await f.limiter.cleanupExpired(later(301000));
  await f.limiter.resetUsage({ subjectId: "s", policy, windows: ["day", "month"], now: later(350000) });
  await f.limiter.finalize({ reservationId: f.id, charge: waiver, now: later(380000) });
  expect((await f.usage()).day.used).toBe(0);
  expect(f.store.database.prepare("SELECT COUNT(*) AS n FROM token_charge_decisions").get()).toMatchObject({ n: 0 });
});

it("recovers a durable waiver after ledger failure without needing the original request", async () => {
  const f = await fixture();
  f.store.database.exec(`CREATE TRIGGER reject_charge BEFORE INSERT ON token_windows
    BEGIN SELECT RAISE(ABORT, 'simulated ledger failure'); END;`);
  await expect(f.limiter.finalize({ reservationId: f.id, charge: waiver, now })).rejects.toThrow("simulated ledger failure");
  expect(f.store.database.prepare("SELECT finalized_at FROM token_reservations").get()).toMatchObject({ finalized_at: null });
  f.store.database.exec("DROP TRIGGER reject_charge");
  const restarted = createSqliteTokenBudgetLimiter({ db: f.store.database });
  await restarted.cleanupExpired(later(301000));
  expect((await f.usage()).day.used).toBe(0);
  expect(f.store.database.prepare("SELECT state FROM token_charge_decisions").get()).toMatchObject({ state: "applied" });
});

it.each([false, true])("recovers a failed correction once (reset intervenes=%s)", async reset => {
  const f = await fixture();
  await f.limiter.cleanupExpired(later(301000));
  f.store.database.exec(`CREATE TRIGGER reject_charge BEFORE UPDATE ON token_reservations
    BEGIN SELECT RAISE(ABORT, 'simulated ledger failure'); END;`);
  await expect(f.limiter.finalize({ reservationId: f.id, charge: waiver, now: later(320000) })).rejects.toThrow();
  expect((await f.usage()).day.used).toBe(125);
  expect(f.store.database.prepare("SELECT state FROM token_charge_decisions").get()).toMatchObject({ state: "pending" });
  f.store.database.exec("DROP TRIGGER reject_charge");
  if (reset) await f.limiter.resetUsage({ subjectId: "s", policy, windows: ["day", "month"], now: later(350000) });
  const restarted = createSqliteTokenBudgetLimiter({ db: f.store.database });
  expect((await restarted.cleanupExpired(later(380000))).count).toBe(1);
  expect((await restarted.cleanupExpired(later(380000))).count).toBe(0);
  expect((await f.usage()).day.used).toBe(0);
  expect(f.store.database.prepare("SELECT state FROM token_charge_decisions").get())
    .toMatchObject({ state: reset ? "invalidated" : "applied" });
});

it("lets a reset invalidate a pending charged fallback even after the reservation expires", async () => {
  const f = await fixture();
  f.store.database.exec(`CREATE TRIGGER reject_charge BEFORE INSERT ON token_windows
    BEGIN SELECT RAISE(ABORT, 'simulated ledger failure'); END;`);
  await expect(f.limiter.finalize({ reservationId: f.id, now,
    usage: { promptTokens: 40, completionTokens: 0, totalTokens: 40 },
    charge: { ...waiver, usage: { promptTokens: 20, completionTokens: 0, totalTokens: 20 } }
  })).rejects.toThrow();
  f.store.database.exec("DROP TRIGGER reject_charge");
  await f.limiter.resetUsage({ subjectId: "s", policy, windows: ["day", "month"], now: later(350000) });
  await f.limiter.cleanupExpired(later(380000));
  expect((await f.usage()).day.used).toBe(0);
  expect(f.store.database.prepare("SELECT state FROM token_charge_decisions").get()).toMatchObject({ state: "invalidated" });
});

it("preserves observed and charged usage separately when recovering a pending fallback", async () => {
  const f = await fixture();
  f.store.database.exec(`CREATE TRIGGER reject_charge BEFORE INSERT ON token_windows
    BEGIN SELECT RAISE(ABORT, 'simulated ledger failure'); END;`);
  await expect(f.limiter.finalize({ reservationId: f.id, now,
    usage: { promptTokens: 40, completionTokens: 0, totalTokens: 40 },
    charge: { ...waiver, usage: { promptTokens: 20, completionTokens: 0, totalTokens: 20 } }
  })).rejects.toThrow();
  f.store.database.exec("DROP TRIGGER reject_charge");
  const restarted = createSqliteTokenBudgetLimiter({ db: f.store.database });
  await restarted.cleanupExpired(later(1000));
  await restarted.finalize({ reservationId: f.id, usage: { promptTokens: 999, completionTokens: 0, totalTokens: 999 } });
  expect((await f.usage()).day.used).toBe(20);
  expect(f.store.database.prepare("SELECT final_total_tokens FROM token_reservations").get()).toMatchObject({ final_total_tokens: 40 });
});

it("migrates 38 to 39 idempotently without changing historical billing", async () => {
  const f = await fixture();
  await f.limiter.finalize({ reservationId: f.id, now });
  f.store.database.exec("DROP TABLE token_charge_decisions; DELETE FROM schema_migrations WHERE version=39;");
  migrateGatewaySchema(f.store.database); migrateGatewaySchema(f.store.database);
  expect((await f.usage()).day.used).toBe(125);
  expect(f.store.database.prepare("SELECT COUNT(*) AS n FROM token_charge_decisions").get()).toMatchObject({ n: 0 });
  expect(f.store.database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
});
