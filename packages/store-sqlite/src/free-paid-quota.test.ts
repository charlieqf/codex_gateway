import { afterEach, describe, expect, it } from "vitest";
import { issueAccessCredential, publicTokenUsage, type ApplyBillingEntitlementEventInput, type Entitlement } from "@codex-gateway/core";
import { createSqliteStore, createSqliteTokenBudgetLimiter, type SqliteGatewayStore } from "./index.js";
import { migrateGatewaySchema } from "./migrations.js";

const stores: SqliteGatewayStore[] = [];
const start = new Date("2026-09-10T10:00:00Z");
const nextDay = new Date("2026-09-11T10:00:00Z");
const end = new Date("2026-10-10T10:00:00Z");
const freePlan = "plan_free_daily_10k_v1";
const paidPlan = "plan_paid_monthly_v1";
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

function fixture(freeLimit = 10_000, oldFree = false) {
  const store = createSqliteStore({ path: ":memory:" });
  stores.push(store);
  store.upsertSubject({ id: "subj_quota", label: "Quota fixture", state: "active", createdAt: start });
  const credential = issueAccessCredential({ subjectId: "subj_quota", label: "Quota fixture", scope: "code", expiresAt: new Date("2030-01-01Z") });
  store.insertAccessCredential(credential.record);
  const policy = { tokensPerMinute: 300_000, tokensPerDay: freeLimit, tokensPerMonth: null,
    maxPromptTokensPerRequest: null, maxTotalTokensPerRequest: null, reserveTokensPerRequest: 0, missingUsageCharge: "none" as const };
  store.createPlan({ id: freePlan, displayName: "Free", policy: { ...policy, tokensPerDay: 10_000 }, scopeAllowlist: ["code"] });
  const freeId = oldFree ? "plan_free_daily_1m_v1" : freePlan;
  if (oldFree) store.createPlan({ id: freeId, displayName: "Old Free", policy, scopeAllowlist: ["code"] });
  store.createPlan({ id: paidPlan, displayName: "Monthly", policy: { ...policy, tokensPerDay: 50_000, tokensPerMonth: 100_000 }, scopeAllowlist: ["code"] });
  store.createPlan({ id: "plan_paid_yearly_v1", displayName: "Yearly", policy: { ...policy, tokensPerDay: null, tokensPerMonth: null }, scopeAllowlist: ["code"] });
  const free = store.grantEntitlement({ subjectId: "subj_quota", planId: freeId, periodKind: "unlimited", now: start });
  const limiter = createSqliteTokenBudgetLimiter({ db: store.database });
  function event(overrides: Partial<ApplyBillingEntitlementEventInput> = {}) {
    return store.applyBillingEntitlementEvent({ idempotencyKey: "quota:purchase", payloadHash: "purchase-v1",
      provider: "medevidence_billing", externalOrderId: "QUOTA_ORDER", eventType: "purchase", applyMode: "apply",
      subjectId: "subj_quota", planId: paidPlan, periodKind: "monthly", periodStart: start, periodEnd: end,
      now: start, ...overrides });
  }
  async function acquire(entitlement: Entitlement, id: string, estimate: number, now = start) {
    return limiter.acquire({ requestId: id, credentialId: credential.record.id, subjectId: "subj_quota",
      entitlementId: entitlement.id, entitlementPeriodStart: entitlement.periodStart, entitlementPeriodEnd: entitlement.periodEnd,
      scope: "code", upstreamAccountId: null, provider: null, policy: entitlement.policySnapshot, estimatedPromptTokens: estimate, now });
  }
  async function consume(entitlement: Entitlement, id: string, total: number, now = start) {
    const acquired = await acquire(entitlement, id, total, now);
    if (!acquired.ok) throw acquired.error;
    await limiter.finalize({ reservationId: acquired.reservationId, usage: { promptTokens: total - 2, completionTokens: 2, totalTokens: total }, now });
    return acquired.reservationId;
  }
  function usage(entitlement: Entitlement, now = start) {
    return limiter.getCurrentUsage({ subjectId: "subj_quota", entitlementId: entitlement.id,
      entitlementPeriodStart: entitlement.periodStart, entitlementPeriodEnd: entitlement.periodEnd, policy: entitlement.policySnapshot, now });
  }
  return { store, free, limiter, event, acquire, consume, usage };
}

describe("independent daily Free and paid balances", () => {
  it.each([false, true])("retains Free on purchase (replace_current=%s), splits a request and replays without resetting either balance", async (replaceCurrent) => {
    const f = fixture();
    await f.consume(f.free, "before-purchase", 4_000);
    const purchase = f.event({ replaceCurrent });
    const paid = purchase.entitlement!;
    expect(purchase.cancelledEntitlementIds).not.toContain(f.free.id);
    expect(f.store.getEntitlement(f.free.id)?.state).toBe("active");
    const reservationId = await f.consume(paid, "after-purchase", 20_000);
    expect(await f.usage(paid)).toMatchObject({ minute: { used: 20_000 }, day: { used: 14_000 }, month: { used: 14_000 },
      freeAllowance: { entitlementId: f.free.id, day: { used: 10_000, remaining: 0 } } });
    expect(f.store.database.prepare("SELECT final_total_tokens, final_free_tokens, final_paid_tokens FROM token_reservations WHERE id = ?").get(reservationId))
      .toMatchObject({ final_total_tokens: 20_000, final_free_tokens: 6_000, final_paid_tokens: 14_000 });
    await f.limiter.finalize({ reservationId, usage: { promptTokens: 999, completionTokens: 0, totalTokens: 999 }, now: start });
    expect(f.event({ replaceCurrent }).idempotentReplay).toBe(true);
    expect((await f.usage(paid)).month.used).toBe(14_000);
    expect(f.store.entitlementAccessForSubject("subj_quota", start)).toMatchObject({ status: "active", entitlement: { id: paid.id } });
  });

  it("resets only the Free daily allowance across UTC midnight and continues paid period usage", async () => {
    const f = fixture();
    const paid = f.event().entitlement!;
    await f.consume(paid, "day1", 20_000);
    await f.consume(paid, "day2", 20_000, nextDay);
    expect(await f.usage(paid, nextDay)).toMatchObject({ day: { used: 10_000 }, month: { used: 20_000 },
      freeAllowance: { day: { used: 10_000 }, month: { used: 20_000 } } });
    expect(publicTokenUsage(await f.usage(paid, nextDay))).toMatchObject({ accounting_mode: "free_then_paid_v1",
      free_allowance: { entitlement_id: f.free.id, day: { used: 10_000 } } });
  });

  it("protects concurrent free reservations, releases failures and uses reported completion beyond the estimate", async () => {
    const f = fixture();
    const paid = f.event().entitlement!;
    const [a, b] = await Promise.all([f.acquire(paid, "concurrent-a", 8_000), f.acquire(paid, "concurrent-b", 8_000)]);
    if (!a.ok || !b.ok) throw new Error("reservation failed");
    expect(await f.usage(paid)).toMatchObject({ day: { reserved: 6_000 }, freeAllowance: { day: { reserved: 10_000 } } });
    await f.limiter.finalize({ reservationId: a.reservationId, now: start });
    await f.limiter.finalize({ reservationId: b.reservationId, usage: { promptTokens: 8_000, completionTokens: 12_000, totalTokens: 20_000 }, now: start });
    expect(await f.usage(paid)).toMatchObject({ day: { used: 10_000, reserved: 0 }, freeAllowance: { day: { used: 10_000, reserved: 0 } } });
  });

  it("shares Free reservations across an upgrade while a Free-only request is in flight", async () => {
    const f = fixture();
    const pending = await f.acquire(f.free, "free-before-upgrade", 8_000);
    const paid = f.event().entitlement!;
    const next = await f.acquire(paid, "paid-after-upgrade", 8_000);
    if (!pending.ok || !next.ok) throw new Error("reservation failed");
    expect(await f.usage(paid)).toMatchObject({ day: { reserved: 6_000 }, freeAllowance: { day: { reserved: 10_000 } } });
    await f.limiter.finalize({ reservationId: next.reservationId, usage: { promptTokens: 8_000, completionTokens: 0, totalTokens: 8_000 }, now: start });
    await f.limiter.finalize({ reservationId: pending.reservationId, usage: { promptTokens: 8_000, completionTokens: 0, totalTokens: 8_000 }, now: start });
    expect(await f.usage(paid)).toMatchObject({ day: { used: 6_000 }, freeAllowance: { day: { used: 10_000 } } });
  });

  it("allows daily Free after the paid period balance is exhausted and rejects only requests requiring paid tokens", async () => {
    const f = fixture();
    const paid = f.event().entitlement!;
    await f.consume(paid, "fill-month-1", 60_000);
    await f.consume(paid, "fill-month-2", 60_000, nextDay);
    const thirdDay = new Date("2026-09-12T10:00:00Z");
    await f.consume(paid, "free-after-paid-exhausted", 10_000, thirdDay);
    expect((await f.acquire(paid, "paid-exhausted", 1, thirdDay)).ok).toBe(false);
    expect((await f.usage(paid, thirdDay)).month.used).toBe(100_000);
  });

  it("keeps a request on its original day even when it finishes after midnight", async () => {
    const f = fixture();
    const paid = f.event().entitlement!;
    const before = new Date("2026-09-10T23:59:59Z");
    const a = await f.acquire(paid, "midnight", 20_000, before);
    if (!a.ok) throw a.error;
    await f.limiter.finalize({ reservationId: a.reservationId, usage: { promptTokens: 20_000, completionTokens: 0, totalTokens: 20_000 }, now: new Date("2026-09-11T00:00:01Z") });
    expect((await f.usage(paid, nextDay)).freeAllowance?.day.used).toBe(0);
    expect((await f.usage(paid, before)).freeAllowance?.day.used).toBe(10_000);
  });

  it("expires reservations without charging missing usage and makes their allowance available again", async () => {
    const f = fixture();
    const paid = f.event().entitlement!;
    await f.acquire(paid, "expires", 20_000);
    await f.limiter.cleanupExpired(new Date(start.getTime() + 6 * 60_000));
    expect(await f.usage(paid)).toMatchObject({ day: { used: 0, reserved: 0 }, freeAllowance: { day: { used: 0, reserved: 0 } } });
  });

  it("preserves the old 1M daily Free snapshot through monthly and yearly purchases", async () => {
    const f = fixture(1_000_000, true);
    const paid = f.event().entitlement!;
    await f.consume(paid, "old-free", 200_000);
    expect((await f.usage(paid)).day.used).toBe(0);
    const yearly = f.event({ idempotencyKey: "quota:year", payloadHash: "year", planId: "plan_paid_yearly_v1",
      replaceCurrent: true, periodKind: "one_off", periodEnd: new Date("2027-09-10T10:00:00Z") }).entitlement!;
    expect(await f.usage(yearly)).toMatchObject({ day: { limit: null }, month: { limit: null },
      freeAllowance: { entitlementId: f.free.id, day: { limit: 1_000_000, used: 200_000 } } });
  });

  it("activates scheduled renewal alongside Free and falls back to the same Free entitlement at final expiry", async () => {
    const f = fixture();
    const paid = f.event().entitlement!;
    const renewal = f.event({ idempotencyKey: "quota:renew", payloadHash: "renew", eventType: "renew",
      periodStart: end, periodEnd: new Date("2026-11-10T10:00:00Z") }).entitlement!;
    expect(renewal.state).toBe("scheduled");
    expect(f.store.entitlementAccessForSubject("subj_quota", end)).toMatchObject({ status: "active", entitlement: { id: renewal.id } });
    expect(f.store.getEntitlement(paid.id)?.state).toBe("expired");
    expect(f.store.entitlementAccessForSubject("subj_quota", new Date("2026-11-10T10:00:00Z")))
      .toMatchObject({ status: "active", entitlement: { id: f.free.id } });
  });

  it("preserves explicit Free suspension and does not grant an internal plan an extra Free balance", async () => {
    const f = fixture();
    f.store.pauseEntitlement({ id: f.free.id, now: start });
    const paid = f.event().entitlement!;
    expect((await f.usage(paid)).freeAllowance).toBeUndefined();
    expect(f.store.getEntitlement(f.free.id)?.state).toBe("paused");
    f.store.createPlan({ id: "plan_internal", displayName: "Internal", policy: paid.policySnapshot, scopeAllowlist: ["code"] });
    const internal = f.store.grantEntitlement({ subjectId: "subj_quota", planId: "plan_internal", periodKind: "unlimited", replace: true, now: start });
    expect((await f.usage(internal)).freeAllowance).toBeUndefined();
  });

  it("pauses and cancels paid membership without accidentally targeting the remaining Free allowance", () => {
    const f = fixture();
    const paid = f.event().entitlement!;
    f.event({ idempotencyKey: "quota:pause", payloadHash: "pause", eventType: "pause" });
    expect(f.store.entitlementAccessForSubject("subj_quota", start)).toMatchObject({ entitlement: { id: f.free.id } });
    f.event({ idempotencyKey: "quota:cancel", payloadHash: "cancel", eventType: "cancel" });
    expect(f.store.getEntitlement(paid.id)?.state).toBe("cancelled");
    expect(f.store.getEntitlement(f.free.id)?.state).toBe("active");
  });

  it("resets the selected free window and releases linked reservations without erasing paid usage", async () => {
    const f = fixture();
    const paid = f.event().entitlement!;
    await f.consume(paid, "settled-before-reset", 20_000);
    await f.acquire(paid, "pending-reset", 2_000);
    const reset = await f.limiter.resetUsage({ subjectId: "subj_quota", entitlementId: f.free.id,
      policy: f.free.policySnapshot, windows: ["month"], now: start });
    expect(reset.expiredReservations).toBe(1);
    expect((await f.usage(paid)).month.used).toBe(10_000);
  });

  it("does not copy already-used Free quota into the paid ledger through an operator carry-usage grant", async () => {
    const f = fixture();
    await f.consume(f.free, "free-before-carry", 5_000);
    expect(() => f.store.grantEntitlement({ subjectId: "subj_quota", planId: paidPlan, periodKind: "one_off",
      periodStart: start, periodEnd: end, replace: true, carryCurrentUsage: true, now: start }))
      .toThrow("Free usage remains in its own ledger");
    expect(f.store.getEntitlement(f.free.id)?.state).toBe("active");
    expect((await f.usage(f.free)).day.used).toBe(5_000);
  });

  it("migrates a replaced historical Free allowance without changing its usage or restoring manual cancellations", async () => {
    const f = fixture(1_000_000, true);
    await f.consume(f.free, "before-migration", 20_000);
    f.event({ periodEnd: new Date("2099-01-01Z") });
    f.store.database.prepare("UPDATE entitlements SET state = 'cancelled', cancelled_reason = 'replaced' WHERE id = ?").run(f.free.id);
    // Re-run only the schema-29 data repair against this isolated old-state fixture.
    f.store.database.exec("DELETE FROM schema_migrations WHERE version = 29; DROP INDEX idx_token_reservations_free_active");
    migrateGatewaySchema(f.store.database);
    expect(f.store.getEntitlement(f.free.id)).toMatchObject({ state: "active", policySnapshot: { tokensPerDay: 1_000_000 } });
    expect((await f.usage(f.free)).day.used).toBe(20_000);
    f.store.cancelEntitlement({ id: f.free.id, reason: "admin-disabled", now: start });
    f.store.database.exec("DELETE FROM schema_migrations WHERE version = 29; DROP INDEX idx_token_reservations_free_active");
    migrateGatewaySchema(f.store.database);
    expect(f.store.getEntitlement(f.free.id)?.state).toBe("cancelled");
    expect(f.store.database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});
