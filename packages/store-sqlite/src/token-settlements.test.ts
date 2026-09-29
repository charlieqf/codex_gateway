import { afterEach, expect, it } from "vitest";
import { issueAccessCredential, type TokenLimitPolicy } from "@codex-gateway/core";
import { createSqliteStore, createSqliteTokenBudgetLimiter } from "./index.js";
import { migrateGatewaySchema } from "./migrations.js";

const stores: ReturnType<typeof createSqliteStore>[] = [];
const now = new Date("2026-09-29T01:00:00Z");
const later = (ms: number) => new Date(now.getTime() + ms);
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
