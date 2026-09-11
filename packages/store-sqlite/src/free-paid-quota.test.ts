import { afterEach, describe, expect, it } from "vitest";
import { issueAccessCredential, phoneSignupFreePlan, phoneSignupFreePlanId, publicTokenUsage, type ApplyBillingEntitlementEventInput, type Entitlement } from "@codex-gateway/core";
import { buildQuotaDashboardData, createSqliteStore, createSqliteTokenBudgetLimiter, type SqliteGatewayStore } from "./index.js";
import { migrateDailyFreeAllowancesToOnce } from "./free-allowance.js";
import { migrateGatewaySchema } from "./migrations.js";

const stores: SqliteGatewayStore[] = [];
const start = new Date("2026-09-10T10:00:00Z");
const nextDay = new Date("2026-09-11T10:00:00Z");
const end = new Date("2026-10-10T10:00:00Z");
const paidPlan = "plan_paid_monthly_v1";
const fixtureFreePlanId = "plan_free_once_fixture_v1";
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

function fixture(freeTotal = 10_000) {
  const store = createSqliteStore({ path: ":memory:" });
  stores.push(store);
  store.upsertSubject({ id: "subj_quota", label: "Quota fixture", state: "active", createdAt: start });
  const credential = issueAccessCredential({ subjectId: "subj_quota", label: "Quota fixture", scope: "code", expiresAt: new Date("2030-01-01Z") });
  store.insertAccessCredential(credential.record);
  const paidPolicy = { tokensPerMinute: 300_000, tokensPerDay: 50_000, tokensPerMonth: 100_000,
    tokensTotal: null,
    maxPromptTokensPerRequest: null, maxTotalTokensPerRequest: null, reserveTokensPerRequest: 0, missingUsageCharge: "none" as const };
  const freeTemplate = phoneSignupFreePlan(start);
  // A dedicated fixture plan so the migration-created default template does not
  // override the test's explicit allowance.
  store.createPlan({ ...freeTemplate, id: fixtureFreePlanId, policy: { ...freeTemplate.policy, tokensTotal: freeTotal } });
  store.createPlan({ id: paidPlan, displayName: "Monthly", policy: paidPolicy, scopeAllowlist: ["code"] });
  store.createPlan({ id: "plan_paid_yearly_v1", displayName: "Yearly", policy: { ...paidPolicy, tokensPerDay: 6_000_000, tokensPerMonth: 200_000_000 }, scopeAllowlist: ["code"] });
  const free = store.grantEntitlement({ subjectId: "subj_quota", planId: fixtureFreePlanId, periodKind: "unlimited", now: start });
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

describe("one-off Free and paid balances", () => {
  it.each([false, true])("retains the one-off Free on purchase (replace_current=%s), splits a request and replays without resetting either balance", async (replaceCurrent) => {
    const f = fixture();
    await f.consume(f.free, "before-purchase", 4_000);
    const purchase = f.event({ replaceCurrent });
    const paid = purchase.entitlement!;
    expect(purchase.cancelledEntitlementIds).not.toContain(f.free.id);
    expect(f.store.getEntitlement(f.free.id)?.state).toBe("active");
    const reservationId = await f.consume(paid, "after-purchase", 20_000);
    // 10k of the request borrows the remaining one-off allowance; the rest is paid.
    expect(await f.usage(paid)).toMatchObject({ minute: { used: 20_000 }, day: { used: 14_000 }, month: { used: 14_000 },
      freeAllowance: { entitlementId: f.free.id, total: { used: 10_000, remaining: 0 } } });
    expect(f.store.database.prepare("SELECT final_total_tokens, final_free_tokens, final_paid_tokens FROM token_reservations WHERE id = ?").get(reservationId))
      .toMatchObject({ final_total_tokens: 20_000, final_free_tokens: 6_000, final_paid_tokens: 14_000 });
    await f.limiter.finalize({ reservationId, usage: { promptTokens: 999, completionTokens: 0, totalTokens: 999 }, now: start });
    expect(f.event({ replaceCurrent }).idempotentReplay).toBe(true);
    expect((await f.usage(paid)).month.used).toBe(14_000);
    expect(f.store.entitlementAccessForSubject("subj_quota", start)).toMatchObject({ status: "active", entitlement: { id: paid.id } });
  });

  it("does not reset the one-off Free allowance across UTC midnight; paid period usage continues", async () => {
    const f = fixture();
    const paid = f.event().entitlement!;
    await f.consume(paid, "day1", 20_000);
    await f.consume(paid, "day2", 20_000, nextDay);
    // Day 1 borrowed 10k free; day 2 gets no free tokens: the allowance never resets.
    expect(await f.usage(paid, nextDay)).toMatchObject({ day: { used: 20_000 }, month: { used: 30_000 },
      freeAllowance: { total: { used: 10_000, remaining: 0 } } });
    expect(publicTokenUsage(await f.usage(paid, nextDay))).toMatchObject({ accounting_mode: "free_then_paid_v1",
      free_allowance: { total: { used: 10_000 } } });
  });

  it("rejects a Free-only request that exceeds the remaining one-off allowance, not only a fully spent one", async () => {
    const f = fixture(1_000);
    const overSpill = await f.acquire(f.free, "overshoot", 50_000);
    expect(overSpill.ok).toBe(false);
    if (!overSpill.ok) {
      expect(overSpill.error.code).toBe("free_quota_exhausted");
      expect(overSpill.limitKind).toBe("token_total");
    }
    // A request that fits the remainder still succeeds.
    expect((await f.acquire(f.free, "fits", 1_000)).ok).toBe(true);
  });

  it("rejects a Free-only request with free_quota_exhausted and no retry hint once the one-off allowance is spent", async () => {
    const f = fixture(1_000);
    await f.consume(f.free, "spend", 1_000);
    const rejected = await f.acquire(f.free, "exhausted", 1);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.error.code).toBe("free_quota_exhausted");
      expect(rejected.error.retryAfterSeconds).toBeUndefined();
      expect(rejected.limitKind).toBe("token_total");
    }
    // A paid request from the same account still succeeds after purchase.
    const paid = f.event().entitlement!;
    expect((await f.acquire(paid, "paid-ok", 1_000)).ok).toBe(true);
  });

  it("protects concurrent free reservations, releases failures and uses reported completion beyond the estimate", async () => {
    const f = fixture();
    const paid = f.event().entitlement!;
    const [a, b] = await Promise.all([f.acquire(paid, "concurrent-a", 8_000), f.acquire(paid, "concurrent-b", 8_000)]);
    if (!a.ok || !b.ok) throw new Error("reservation failed");
    expect(await f.usage(paid)).toMatchObject({ day: { reserved: 6_000 }, freeAllowance: { total: { reserved: 10_000 } } });
    await f.limiter.finalize({ reservationId: a.reservationId, now: start });
    await f.limiter.finalize({ reservationId: b.reservationId, usage: { promptTokens: 8_000, completionTokens: 12_000, totalTokens: 20_000 }, now: start });
    expect(await f.usage(paid)).toMatchObject({ day: { used: 10_000, reserved: 0 }, freeAllowance: { total: { used: 10_000, reserved: 0 } } });
  });

  it("shares Free reservations across an upgrade while a Free-only request is in flight", async () => {
    const f = fixture();
    const pending = await f.acquire(f.free, "free-before-upgrade", 8_000);
    const paid = f.event().entitlement!;
    const next = await f.acquire(paid, "paid-after-upgrade", 8_000);
    if (!pending.ok || !next.ok) throw new Error("reservation failed");
    expect(await f.usage(paid)).toMatchObject({ day: { reserved: 6_000 }, freeAllowance: { total: { reserved: 10_000 } } });
    await f.limiter.finalize({ reservationId: next.reservationId, usage: { promptTokens: 8_000, completionTokens: 0, totalTokens: 8_000 }, now: start });
    await f.limiter.finalize({ reservationId: pending.reservationId, usage: { promptTokens: 8_000, completionTokens: 0, totalTokens: 8_000 }, now: start });
    expect(await f.usage(paid)).toMatchObject({ day: { used: 6_000 }, freeAllowance: { total: { used: 10_000 } } });
  });

  it("allows no free tokens after the one-off allowance is exhausted and rejects only requests requiring paid tokens", async () => {
    const f = fixture(10_000);
    const paid = f.event().entitlement!;
    await f.consume(paid, "fill-month-1", 40_000);
    await f.consume(paid, "fill-month-2", 40_000, nextDay);
    const thirdDay = new Date("2026-09-12T10:00:00Z");
    // Free was fully borrowed on day 1 (10k); later days have no free tokens,
    // but the paid day/month windows still allow requests.
    expect((await f.acquire(paid, "paid-still-works", 5_000, thirdDay)).ok).toBe(true);
    const freeOnly = await f.acquire(f.free, "free-only-exhausted", 1, thirdDay);
    expect(freeOnly.ok).toBe(false);
    if (!freeOnly.ok) expect(freeOnly.error.code).toBe("free_quota_exhausted");
  });

  it("keeps a request on its original day even when it finishes after midnight", async () => {
    const f = fixture();
    const paid = f.event().entitlement!;
    const before = new Date("2026-09-10T23:59:59Z");
    const a = await f.acquire(paid, "midnight", 20_000, before);
    if (!a.ok) throw a.error;
    await f.limiter.finalize({ reservationId: a.reservationId, usage: { promptTokens: 20_000, completionTokens: 0, totalTokens: 20_000 }, now: new Date("2026-09-11T00:00:01Z") });
    expect((await f.usage(paid, nextDay)).freeAllowance?.total?.used).toBe(10_000);
    expect((await f.usage(paid, before)).freeAllowance?.total?.used).toBe(10_000);
  });

  it("expires reservations without charging missing usage and makes their allowance available again", async () => {
    const f = fixture();
    const paid = f.event().entitlement!;
    await f.acquire(paid, "expires", 20_000);
    await f.limiter.cleanupExpired(new Date(start.getTime() + 6 * 60_000));
    expect(await f.usage(paid)).toMatchObject({ day: { used: 0, reserved: 0 }, freeAllowance: { total: { used: 0, reserved: 0 } } });
  });

  it("preserves an old daily-snapshot Free entitlement through monthly and yearly purchases", async () => {
    const store = createSqliteStore({ path: ":memory:" });
    stores.push(store);
    store.upsertSubject({ id: "subj_legacy", label: "Legacy free", state: "active", createdAt: start });
    const credential = issueAccessCredential({ subjectId: "subj_legacy", label: "Legacy free", scope: "code", expiresAt: new Date("2030-01-01Z") });
    store.insertAccessCredential(credential.record);
    const template = phoneSignupFreePlan(start);
    // Legacy snapshot: daily 1M, no tokensTotal; retained until migrated.
    store.createPlan({ ...template, id: "plan_free_daily_1m_v1", displayName: "Free · 1,000,000 tokens/day",
      policy: { ...template.policy, tokensPerDay: 1_000_000, tokensTotal: null } });
    store.createPlan({ id: paidPlan, displayName: "Monthly", policy: { tokensPerMinute: 300_000, tokensPerDay: null, tokensPerMonth: 100_000, tokensTotal: null,
      maxPromptTokensPerRequest: null, maxTotalTokensPerRequest: null, reserveTokensPerRequest: 0, missingUsageCharge: "none" }, scopeAllowlist: ["code"] });
    store.createPlan({ id: "plan_paid_yearly_v1", displayName: "Yearly", policy: { tokensPerMinute: 300_000, tokensPerDay: 6_000_000, tokensPerMonth: 200_000_000, tokensTotal: null,
      maxPromptTokensPerRequest: null, maxTotalTokensPerRequest: null, reserveTokensPerRequest: 0, missingUsageCharge: "none" }, scopeAllowlist: ["code"] });
    const legacy = store.grantEntitlement({ subjectId: "subj_legacy", planId: "plan_free_daily_1m_v1", periodKind: "unlimited", now: start });
    const limiter = createSqliteTokenBudgetLimiter({ db: store.database });
    const purchase = store.applyBillingEntitlementEvent({ idempotencyKey: "legacy:purchase", payloadHash: "purchase-v1",
      provider: "medevidence_billing", externalOrderId: "LEGACY_ORDER", eventType: "purchase", applyMode: "apply",
      subjectId: "subj_legacy", planId: paidPlan, periodKind: "monthly", periodStart: start, periodEnd: end, now: start });
    const paid = purchase.entitlement!;
    const acquired = await limiter.acquire({ requestId: "old-free", credentialId: credential.record.id, subjectId: "subj_legacy",
      entitlementId: paid.id, entitlementPeriodStart: paid.periodStart, entitlementPeriodEnd: paid.periodEnd,
      scope: "code", upstreamAccountId: null, provider: null, policy: paid.policySnapshot, estimatedPromptTokens: 200_000, now: start });
    if (!acquired.ok) throw acquired.error;
    await limiter.finalize({ reservationId: acquired.reservationId,
      usage: { promptTokens: 199_998, completionTokens: 2, totalTokens: 200_000 }, now: start });
    expect((await limiter.getCurrentUsage({ subjectId: "subj_legacy", entitlementId: paid.id,
      entitlementPeriodStart: paid.periodStart, entitlementPeriodEnd: paid.periodEnd, policy: paid.policySnapshot, now: start })).day.used)
      .toBe(0);
    const yearly = store.applyBillingEntitlementEvent({ idempotencyKey: "legacy:year", payloadHash: "year",
      provider: "medevidence_billing", externalOrderId: "LEGACY_YEAR", eventType: "purchase", applyMode: "apply",
      subjectId: "subj_legacy", planId: "plan_paid_yearly_v1", replaceCurrent: true, periodKind: "one_off",
      periodStart: start, periodEnd: new Date("2027-09-10T10:00:00Z"), now: start }).entitlement!;
    const usage = await limiter.getCurrentUsage({ subjectId: "subj_legacy", entitlementId: yearly.id,
      entitlementPeriodStart: yearly.periodStart, entitlementPeriodEnd: yearly.periodEnd, policy: yearly.policySnapshot, now: start });
    expect(usage).toMatchObject({ day: { limit: 6_000_000 }, month: { limit: 200_000_000 },
      freeAllowance: { entitlementId: legacy.id, day: { limit: 1_000_000, used: 200_000 } } });
  });

  it("migrates legacy daily Free allowances carrying month-window usage exactly once", async () => {
    const store = createSqliteStore({ path: ":memory:" });
    stores.push(store);
    store.upsertSubject({ id: "subj_migrate", label: "Migrate", state: "active", createdAt: start });
    const template = phoneSignupFreePlan(start);
    store.createPlan({ ...template, id: "plan_free_daily_10k_v1", displayName: "Free · 10,000 tokens/day",
      policy: { ...template.policy, tokensPerDay: 10_000, tokensTotal: null } });
    const legacy = store.grantEntitlement({ subjectId: "subj_migrate", planId: "plan_free_daily_10k_v1", periodKind: "unlimited", now: start });
    // Settled usage is booked into BOTH a day and a month window row; the
    // migration must count it once (30,000 used), not twice.
    for (const [kind, windowStart] of [["day", "2026-09-10T00:00:00.000Z"], ["month", "2026-09-01T00:00:00.000Z"]] as const) {
      store.database.prepare(`INSERT INTO entitlement_token_windows (
          entitlement_id, window_kind, window_start, prompt_tokens, completion_tokens,
          total_tokens, cached_prompt_tokens, estimated_tokens, requests, updated_at
        ) VALUES (?, ?, ?, 25000, 5000, 30000, 0, 0, 1, ?)`)
        .run(legacy.id, kind, windowStart, start.toISOString());
    }
    const result = migrateDailyFreeAllowancesToOnce(store.database, start);
    expect(result.migrated).toBe(1);
    const migrated = store.getEntitlement(legacy.id)!;
    expect(migrated.planId).toBe(phoneSignupFreePlanId);
    expect(migrated.policySnapshot).toMatchObject({ tokensTotal: 1_000_000, tokensPerDay: null, tokensPerMonth: null });
    const period = store.database.prepare(`SELECT total_tokens FROM entitlement_token_windows
      WHERE entitlement_id = ? AND window_kind = 'period' AND window_start = ?`)
      .get(legacy.id, legacy.periodStart.toISOString()) as { total_tokens: number };
    expect(period.total_tokens).toBe(30_000);
    const usage = await createSqliteTokenBudgetLimiter({ db: store.database }).getCurrentUsage({
      subjectId: "subj_migrate", entitlementId: legacy.id,
      entitlementPeriodStart: legacy.periodStart, entitlementPeriodEnd: legacy.periodEnd,
      policy: migrated.policySnapshot, now: start });
    expect(usage.freeAllowance?.total).toMatchObject({ used: 30_000, remaining: 970_000 });
  });

  it("does not create the once Free template when no legacy allowances need migration", () => {
    const store = createSqliteStore({ path: ":memory:" });
    stores.push(store);
    expect(store.getPlan(phoneSignupFreePlanId)).toBeNull();
    const result = migrateDailyFreeAllowancesToOnce(store.database, start);
    expect(result.migrated).toBe(0);
    expect(store.getPlan(phoneSignupFreePlanId)).toBeNull();
  });

  it("anchors a monthly entitlement's month window to its billing period across calendar months", async () => {
    const store = createSqliteStore({ path: ":memory:" });
    stores.push(store);
    store.upsertSubject({ id: "subj_month_window", label: "Month window", state: "active", createdAt: start });
    const credential = issueAccessCredential({ subjectId: "subj_month_window", label: "Month window", scope: "code", expiresAt: new Date("2030-01-01Z") });
    store.insertAccessCredential(credential.record);
    store.createPlan({ id: "plan_month_window_v1", displayName: "Monthly window", scopeAllowlist: ["code"],
      policy: { tokensPerMinute: 300_000, tokensPerDay: null, tokensPerMonth: 80_000, tokensTotal: null,
        maxPromptTokensPerRequest: null, maxTotalTokensPerRequest: null, reserveTokensPerRequest: 0, missingUsageCharge: "none" } });
    const entitlement = store.applyBillingEntitlementEvent({ idempotencyKey: "window:purchase", payloadHash: "purchase-v1",
      provider: "medevidence_billing", externalOrderId: "WINDOW_ORDER", eventType: "purchase", applyMode: "apply",
      subjectId: "subj_month_window", planId: "plan_month_window_v1", periodKind: "monthly",
      periodStart: start, periodEnd: end, now: start }).entitlement!;
    const limiter = createSqliteTokenBudgetLimiter({ db: store.database });
    const consume = async (id: string, total: number, at: Date) => {
      const acquired = await limiter.acquire({ requestId: id, credentialId: credential.record.id, subjectId: "subj_month_window",
        entitlementId: entitlement.id, entitlementPeriodStart: entitlement.periodStart, entitlementPeriodEnd: entitlement.periodEnd,
        scope: "code", upstreamAccountId: null, provider: null, policy: entitlement.policySnapshot, estimatedPromptTokens: total, now: at });
      if (acquired.ok) {
        await limiter.finalize({ reservationId: acquired.reservationId,
          usage: { promptTokens: total - 2, completionTokens: 2, totalTokens: total }, now: at });
      }
      return acquired;
    };
    expect((await consume("september", 50_000, start)).ok).toBe(true);
    const october = new Date("2026-10-05T10:00:00Z");
    const rejected = await consume("october-inside-period", 50_000, october);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.limitKind).toBe("token_month");
    const usage = await limiter.getCurrentUsage({ subjectId: "subj_month_window", entitlementId: entitlement.id,
      entitlementPeriodStart: entitlement.periodStart, entitlementPeriodEnd: entitlement.periodEnd,
      policy: entitlement.policySnapshot, now: october });
    expect(usage.month).toMatchObject({ limit: 80_000, used: 50_000, windowStart: start.toISOString() });
  });

  it("resets a one-off yearly entitlement's month window at UTC calendar-month boundaries", async () => {
    const store = createSqliteStore({ path: ":memory:" });
    stores.push(store);
    store.upsertSubject({ id: "subj_year_window", label: "Year window", state: "active", createdAt: start });
    const credential = issueAccessCredential({ subjectId: "subj_year_window", label: "Year window", scope: "code", expiresAt: new Date("2030-01-01Z") });
    store.insertAccessCredential(credential.record);
    store.createPlan({ id: "plan_year_window_v1", displayName: "Yearly window", scopeAllowlist: ["code"],
      policy: { tokensPerMinute: 300_000, tokensPerDay: 50_000, tokensPerMonth: 80_000, tokensTotal: null,
        maxPromptTokensPerRequest: null, maxTotalTokensPerRequest: null, reserveTokensPerRequest: 0, missingUsageCharge: "none" } });
    const entitlement = store.grantEntitlement({ subjectId: "subj_year_window", planId: "plan_year_window_v1",
      periodKind: "one_off", periodStart: start, periodEnd: new Date("2027-09-10T10:00:00Z"), now: start });
    const limiter = createSqliteTokenBudgetLimiter({ db: store.database });
    const consume = async (id: string, total: number, at: Date) => {
      const acquired = await limiter.acquire({ requestId: id, credentialId: credential.record.id, subjectId: "subj_year_window",
        entitlementId: entitlement.id, entitlementPeriodStart: entitlement.periodStart, entitlementPeriodEnd: entitlement.periodEnd,
        scope: "code", upstreamAccountId: null, provider: null, policy: entitlement.policySnapshot, estimatedPromptTokens: total, now: at });
      if (acquired.ok) {
        await limiter.finalize({ reservationId: acquired.reservationId,
          usage: { promptTokens: total - 2, completionTokens: 2, totalTokens: total }, now: at });
      }
      return acquired;
    };
    expect((await consume("september-a", 50_000, start)).ok).toBe(true);
    const septemberUsage = await limiter.getCurrentUsage({ subjectId: "subj_year_window", entitlementId: entitlement.id,
      entitlementPeriodStart: entitlement.periodStart, entitlementPeriodEnd: entitlement.periodEnd,
      policy: entitlement.policySnapshot, now: start });
    expect(septemberUsage.month).toMatchObject({ limit: 80_000, used: 50_000, windowStart: "2026-09-01T00:00:00.000Z" });
    const rejected = await consume("september-b", 50_000, nextDay);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.limitKind).toBe("token_month");
    const october = new Date("2026-10-01T10:00:00Z");
    expect((await consume("october", 50_000, october)).ok).toBe(true);
    const octoberUsage = await limiter.getCurrentUsage({ subjectId: "subj_year_window", entitlementId: entitlement.id,
      entitlementPeriodStart: entitlement.periodStart, entitlementPeriodEnd: entitlement.periodEnd,
      policy: entitlement.policySnapshot, now: october });
    expect(octoberUsage.month).toMatchObject({ limit: 80_000, used: 50_000, windowStart: "2026-10-01T00:00:00.000Z" });
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

  it.each(["day", "month"] as const)("rejects a paid %s reset while shared usage is pending, then preserves the late settlement", async (window) => {
    const f = fixture(10_000);
    const paid = f.event().entitlement!;
    // Exhaust the one-off Free first so the pending request is paid-only.
    await f.consume(paid, "spend-free", 20_000);
    await f.consume(paid, "settled-before-reset", 20_000);
    const pending = await f.acquire(paid, "pending-reset", 5_000);
    if (!pending.ok) throw pending.error;
    expect(f.limiter.listReservations()[0].freeReservedTokens).toBe(0);
    const before = await f.usage(paid);
    const resetInput = { subjectId: "subj_quota", entitlementId: paid.id,
      entitlementPeriodStart: paid.periodStart, entitlementPeriodEnd: paid.periodEnd,
      policy: paid.policySnapshot, windows: [window], now: start };
    await expect(f.limiter.resetUsage(resetInput)).rejects.toMatchObject({ code: "quota_reset_conflict", httpStatus: 409 });
    expect(await f.usage(paid)).toEqual(before);
    await f.limiter.finalize({ reservationId: pending.reservationId,
      usage: { promptTokens: 5_000, completionTokens: 0, totalTokens: 5_000 }, now: start });
    await f.limiter.resetUsage(resetInput);
    expect(await f.usage(paid)).toMatchObject({ [window]: { used: 0 } });
    expect((await f.usage(paid)).freeAllowance?.total?.used).toBe(10_000);
  });

  it("reconciles nothing new for an already-settled request and keeps the one-off Free balance stable", async () => {
    const f = fixture();
    const paid = f.event().entitlement!;
    await f.consume(paid, "settled", 20_000);
    expect(await f.usage(paid)).toMatchObject({ day: { used: 10_000 }, freeAllowance: { total: { used: 10_000 } } });
    expect(f.store.database.prepare("SELECT COUNT(*) AS n FROM token_reservations WHERE finalized_at IS NULL").get())
      .toMatchObject({ n: 0 });
  });

  it("uses the actual signup Free missing-usage policy instead of a hand-written test substitute", async () => {
    const f = fixture();
    const pending = await f.acquire(f.free, "free-without-usage", 7_000);
    if (!pending.ok) throw pending.error;
    expect(f.free.policySnapshot.missingUsageCharge).toBe("estimate");
    const result = await f.limiter.finalize({ reservationId: pending.reservationId, now: start });
    expect(result).toMatchObject({ finalTotalTokens: 7_000, finalUsageSource: "estimate" });
    expect((await f.usage(f.free)).freeAllowance?.total).toMatchObject({ used: 7_000, remaining: 3_000 });
  });

  it("keeps users with unspent one-off Free out of the exhausted dashboard filter", async () => {
    const f = fixture(1_000_000);
    const paid = f.event().entitlement!;
    await f.consume(paid, "dashboard-day1", 20_000);
    await f.consume(paid, "dashboard-day2", 20_000, nextDay);
    const thirdDay = new Date("2026-09-12T10:00:00Z");
    const dashboard = await buildQuotaDashboardData(f.store, { now: thirdDay });
    const entry = dashboard.users.find((item) => item.user.id === "subj_quota")!;
    const freeTotal = entry.token_usage?.free_allowance?.total;
    expect(freeTotal?.used).toBe(40_000);
    expect(freeTotal?.remaining).toBeGreaterThan(0);
    expect(entry.quota_exhausted).toBe(false);
    expect(dashboard.summary.exhausted_users).toBe(0);
  });
});
