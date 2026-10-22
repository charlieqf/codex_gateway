import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { issueAccessCredential, phoneSignupFreePlan, publicTokenUsage,
  type Entitlement, type GrantTokenCreditsInput } from "@codex-gateway/core";
import { createSqliteStore, createSqliteTokenBudgetLimiter, type SqliteGatewayStore } from "./index.js";
import { migrateGatewaySchema } from "./migrations.js";

const now = new Date("2026-10-23T10:00:00Z");
const end = new Date("2026-11-23T10:00:00Z");
const stores: SqliteGatewayStore[] = [];
const tempDirectories: string[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function fixture(path = ":memory:") {
  const store = createSqliteStore({ path }); stores.push(store);
  store.upsertSubject({ id: "credit-user", label: "Credit fixture", state: "active", createdAt: now });
  const credential = issueAccessCredential({ subjectId: "credit-user", label: "Fixture", scope: "code", expiresAt: new Date("2030-01-01Z") });
  store.insertAccessCredential(credential.record);
  const template = phoneSignupFreePlan(now);
  store.createPlan({ ...template, id: "plan_free_once_fixture_v1", policy: { ...template.policy, tokensTotal: 1000 } });
  store.createPlan({ id: "plan_paid_monthly_v1", displayName: "Paid", scopeAllowlist: ["code"],
    policy: { ...template.policy, tokensTotal: null, tokensPerDay: 2000, tokensPerMonth: 3000 } });
  const free = store.grantEntitlement({ subjectId: "credit-user", planId: "plan_free_once_fixture_v1", periodKind: "unlimited", now });
  const limiter = createSqliteTokenBudgetLimiter({ db: store.database });
  const grant = (overrides: Partial<GrantTokenCreditsInput> = {}) => store.grantTokenCredits({
    idempotencyKey: "gift:1", provider: "billing", externalEventId: "gift:1", subjectId: "credit-user",
    eventType: "gift", tokens: 5000, reason: "Campaign", now, ...overrides });
  const paid = () => store.applyBillingEntitlementEvent({ subjectId: "credit-user", planId: "plan_paid_monthly_v1",
    idempotencyKey: "purchase", payloadHash: "purchase", provider: "billing", externalOrderId: "subscription",
    eventType: "purchase", applyMode: "apply", periodKind: "monthly", periodStart: now, periodEnd: end, now }).entitlement!;
  const usageInput = (ent: Entitlement, at = now) => ({ subjectId: "credit-user", entitlementId: ent.id,
    entitlementPeriodStart: ent.periodStart, entitlementPeriodEnd: ent.periodEnd, policy: ent.policySnapshot, now: at });
  const acquire = (ent: Entitlement, requestId: string, tokens: number, at = now) => limiter.acquire({
    ...usageInput(ent, at), requestId, credentialId: credential.record.id, scope: "code", upstreamAccountId: null,
    provider: null, estimatedPromptTokens: tokens });
  const consume = async (ent: Entitlement, requestId: string, tokens: number, at = now) => {
    const res = await acquire(ent, requestId, tokens, at);
    if (!res.ok) throw res.error;
    await limiter.finalize({ reservationId: res.reservationId, usage: { promptTokens: tokens, completionTokens: 0, totalTokens: tokens }, now: at });
    return res.reservationId;
  };
  return { store, free, paid, limiter, grant, acquire, consume, usageInput,
    wallet: (at = now) => store.getTokenCreditWallet("credit-user", at) };
}

describe("permanent Token grants", () => {
  it("adds arbitrary amounts without changing entitlements, keys, historical usage or the Free allowance", async () => {
    const f = fixture();
    await f.consume(f.free, "old-use", 400);
    const snapshot = JSON.stringify({ ent: f.store.listEntitlements({ subjectId: "credit-user" }),
      keys: f.store.listAccessCredentials({ subjectId: "credit-user" }), usage: await f.limiter.getCurrentUsage(f.usageInput(f.free)) });
    expect(f.grant({ tokens: 12345 }).wallet.balanceTokens).toBe(12345);
    expect(f.grant({ idempotencyKey: "topup:1", externalEventId: "topup:1", externalOrderId: "ORDER-1", eventType: "topup", tokens: 77 }).wallet.balanceTokens).toBe(12422);
    const { tokenCredits, ...usage } = await f.limiter.getCurrentUsage(f.usageInput(f.free));
    expect(JSON.stringify({ ent: f.store.listEntitlements({ subjectId: "credit-user" }),
      keys: f.store.listAccessCredentials({ subjectId: "credit-user" }), usage })).toBe(snapshot);
    expect(tokenCredits?.balanceTokens).toBe(12422);
    expect(f.wallet(new Date("2046-01-01Z")).balanceTokens).toBe(12422);
    migrateGatewaySchema(f.store.database);
    expect(f.wallet().balanceTokens).toBe(12422);
  });
  it("replays exactly once; conflicts on changed body, changed key/business event, or reused paid order", () => {
    const f = fixture(); const first = f.grant();
    expect(f.grant()).toMatchObject({ idempotentReplay: true, event: { id: first.event.id } });
    expect(() => f.grant({ tokens: 1 })).toThrowError(/conflict/);
    expect(() => f.grant({ idempotencyKey: "new-key" })).toThrowError(/conflict/);
    f.grant({ idempotencyKey: "topup", externalEventId: "topup", externalOrderId: "paid-order", eventType: "topup", tokens: 1 });
    expect(() => f.grant({ idempotencyKey: "topup2", externalEventId: "topup2", externalOrderId: "paid-order", eventType: "topup", tokens: 1 })).toThrowError(/conflict/);
    expect(f.wallet().grantedTokens).toBe(5001);
    expect(f.store.listTokenCreditEvents({ subjectId: "credit-user" }).events).toHaveLength(2);
  });
  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity])("rejects invalid amount %s atomically", tokens => {
    const f = fixture(); expect(() => f.grant({ tokens })).toThrow(); expect(f.wallet().grantedTokens).toBe(0);
  });
  it("rejects overflow, missing/disabled subjects, and topups without an order", () => {
    const f = fixture();
    expect(() => f.grant({ eventType: "topup" })).toThrow();
    expect(() => f.grant({ subjectId: "missing" })).toThrow();
    f.grant({ tokens: Number.MAX_SAFE_INTEGER });
    expect(() => f.grant({ idempotencyKey: "overflow", externalEventId: "overflow", tokens: 1 })).toThrow(/safe integer/);
    f.store.database.prepare("UPDATE subjects SET state = 'disabled' WHERE id = ?").run("credit-user");
    expect(() => f.grant({ idempotencyKey: "disabled", externalEventId: "disabled", tokens: 1 })).toThrow(/inactive/);
    expect(f.grant({ tokens: Number.MAX_SAFE_INTEGER }).idempotentReplay).toBe(true);
  });
  it("rolls back the balance with a failed event write, then retries exactly once", () => {
    const f = fixture();
    f.store.database.exec("CREATE TRIGGER fail_credit_event BEFORE INSERT ON token_credit_events BEGIN SELECT RAISE(ABORT, 'injected'); END;");
    expect(() => f.grant()).toThrow(/injected/);
    expect(f.wallet().grantedTokens).toBe(0);
    f.store.database.exec("DROP TRIGGER fail_credit_event");
    expect(f.grant().wallet.grantedTokens).toBe(5000);
    expect(f.grant().wallet.grantedTokens).toBe(5000);
  });
  it("migrates a v42 database without altering old grants, usage or pending requests", async () => {
    const f = fixture(); await f.consume(f.free, "history", 100);
    const pending = await f.acquire(f.free, "pending-before-upgrade", 200); if (!pending.ok) throw pending.error;
    // Reconstruct the exact previous schema on this isolated synthetic fixture.
    f.store.database.exec(`DROP TABLE token_credit_debits; DROP TABLE token_credit_events; DROP TABLE token_credit_accounts;
      DROP INDEX token_credit_pending;
      ALTER TABLE token_reservations DROP COLUMN credit_enabled;
      ALTER TABLE token_reservations DROP COLUMN credit_reserved_tokens;
      ALTER TABLE token_reservations DROP COLUMN final_credit_tokens;
      DELETE FROM schema_migrations WHERE version = 43;`);
    const old = f.store.database.prepare("SELECT * FROM token_reservations ORDER BY id").all();
    const entitlements = f.store.listEntitlements({ subjectId: "credit-user" });
    migrateGatewaySchema(f.store.database); migrateGatewaySchema(f.store.database);
    for (const row of old) {
      expect(f.store.database.prepare("SELECT * FROM token_reservations WHERE id = ?").get(row.id!)).toMatchObject(row);
    }
    expect(f.store.listEntitlements({ subjectId: "credit-user" })).toEqual(entitlements);
    expect(f.store.database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    f.grant();
    await f.limiter.finalize({ reservationId: pending.reservationId, usage: { promptTokens: 200, completionTokens: 0, totalTokens: 200 }, now });
    expect(f.wallet().balanceTokens).toBe(5000);
    expect((await f.limiter.getCurrentUsage(f.usageInput(f.free))).freeAllowance?.total?.used).toBe(300);
  });
});

describe("credit reservation and settlement", () => {
  it("shares grants and reservation locks across independent DB connections and survives reopen", async () => {
    const directory = mkdtempSync(join(tmpdir(), "gateway-credit-test-")); tempDirectories.push(directory);
    const path = join(directory, "fixture.sqlite"); const f = fixture(path); f.grant({ tokens: 500 });
    await f.consume(f.free, "base", 1000);
    const second = createSqliteStore({ path }); stores.push(second);
    const secondLimiter = createSqliteTokenBudgetLimiter({ db: second.database });
    const first = await f.acquire(f.free, "worker-a", 400); if (!first.ok) throw first.error;
    const credential = second.listAccessCredentials({ subjectId: "credit-user" })[0];
    const other = (n: number) => secondLimiter.acquire({ ...f.usageInput(f.free), credentialId: credential.id,
      requestId: "worker-b", scope: "code", upstreamAccountId: null, provider: null, estimatedPromptTokens: n });
    expect(await other(101)).toMatchObject({ ok: false });
    expect(second.getTokenCreditWallet("credit-user", now).reservedTokens).toBe(400);
    const b = await other(100); if (!b.ok) throw b.error;
    await secondLimiter.finalize({ reservationId: first.reservationId, usage: { promptTokens: 400, completionTokens: 0, totalTokens: 400 }, now });
    await f.limiter.finalize({ reservationId: b.reservationId, usage: { promptTokens: 100, completionTokens: 0, totalTokens: 100 }, now });
    second.close(); stores.splice(stores.indexOf(second), 1);
    const reopened = createSqliteStore({ path }); stores.push(reopened);
    expect(reopened.getTokenCreditWallet("credit-user", now)).toMatchObject({ grantedTokens: 500, chargedTokens: 500, availableTokens: 0 });
  });
  it("refuses legacy history import that would omit the wallet ledger", async () => {
    const directory = mkdtempSync(join(tmpdir(), "gateway-credit-transfer-test-")); tempDirectories.push(directory);
    const path = join(directory, "fixture.sqlite"); const f = fixture(path);
    f.store.cancelEntitlement({ id: f.free.id, now });
    f.grant(); await f.consume(f.paid(), "paid-plus-credit", 2500);
    const script = join(process.cwd(), "scripts", "gateway-usage-history-transfer.cjs");
    const exported = spawnSync(process.execPath, [script, "export", "--db", path, "--since", now.toISOString(),
      "--until", new Date(now.getTime() + 86400000).toISOString()], { encoding: "utf8" });
    expect(exported.status, exported.stderr).toBe(0);
    const applied = spawnSync(process.execPath, [script, "apply", "--db", path], { encoding: "utf8", input: exported.stdout });
    expect(applied.status).toBe(1);
    expect(applied.stderr).toContain("wallet-aware recovery");
    expect(f.wallet()).toMatchObject({ grantedTokens: 5000, chargedTokens: 500 });
  });
  it("splits Free then paid then credits when the day cap is reached, retaining full observed usage", async () => {
    const f = fixture(); f.grant(); const paid = f.paid();
    const id = await f.consume(paid, "split", 4500);
    expect(await f.limiter.getCurrentUsage(f.usageInput(paid))).toMatchObject({ minute: { used: 4500 }, day: { used: 2000 },
      month: { used: 2000 }, freeAllowance: { total: { used: 1000 } }, tokenCredits: { chargedTokens: 1500, balanceTokens: 3500 } });
    expect(f.store.database.prepare("SELECT final_free_tokens, final_paid_tokens, final_credit_tokens FROM token_reservations WHERE id = ?").get(id))
      .toMatchObject({ final_free_tokens: 1000, final_paid_tokens: 2000, final_credit_tokens: 1500 });
    const nextDay = new Date(now.getTime() + 86400000);
    await f.consume(paid, "month-cap", 2000, nextDay);
    expect(await f.limiter.getCurrentUsage(f.usageInput(paid, nextDay))).toMatchObject({ day: { used: 1000 }, month: { used: 3000 },
      tokenCredits: { chargedTokens: 2500, balanceTokens: 2500 } });
    const afterExpiry = new Date(end.getTime() + 1000);
    expect(f.store.entitlementAccessForSubject("credit-user", afterExpiry)).toMatchObject({ status: "active", entitlement: { id: f.free.id } });
    await f.consume(f.free, "after-expiry", 500, afterExpiry);
    expect(f.wallet(afterExpiry).balanceTokens).toBe(2000);
  });
  it("keeps legacy daily Free usage classified as Free when credits cover its overflow", async () => {
    const f = fixture(); f.grant();
    const template = phoneSignupFreePlan(now);
    f.store.createPlan({ ...template, id: "plan_free_daily_100k_v1",
      policy: { ...template.policy, tokensTotal: null, tokensPerDay: 2000 } });
    const legacy = f.store.grantEntitlement({ subjectId: "credit-user", planId: "plan_free_daily_100k_v1",
      periodKind: "unlimited", replace: true, now });
    const id = await f.consume(legacy, "legacy-plus-credit", 2500);
    expect(f.store.database.prepare("SELECT final_free_tokens, final_paid_tokens, final_credit_tokens FROM token_reservations WHERE id = ?")
      .get(id)).toMatchObject({ final_free_tokens: 2000, final_paid_tokens: 0, final_credit_tokens: 500 });
    expect(await f.limiter.getCurrentUsage(f.usageInput(legacy))).toMatchObject({
      day: { used: 2000 }, tokenCredits: { chargedTokens: 500 }
    });
  });
  it("protects concurrent reservations and releases unused credits after actual usage", async () => {
    const f = fixture(); f.grant({ tokens: 1000 });
    const a = await f.acquire(f.free, "concurrent-a", 1600);
    if (!a.ok) throw a.error;
    expect(f.wallet()).toMatchObject({ reservedTokens: 600, availableTokens: 400 });
    expect((await f.limiter.getCurrentUsage(f.usageInput(f.free))).freeAllowance?.total?.reserved).toBe(1000);
    expect(await f.acquire(f.free, "concurrent-b", 401)).toMatchObject({ ok: false });
    const b = await f.acquire(f.free, "concurrent-b", 400); if (!b.ok) throw b.error;
    expect(f.wallet().availableTokens).toBe(0);
    await f.limiter.finalize({ reservationId: a.reservationId, usage: { promptTokens: 1200, completionTokens: 0, totalTokens: 1200 }, now });
    await f.limiter.finalize({ reservationId: b.reservationId, usage: { promptTokens: 300, completionTokens: 0, totalTokens: 300 }, now });
    expect(f.wallet()).toMatchObject({ chargedTokens: 500, reservedTokens: 0, availableTokens: 500 });
    await f.limiter.finalize({ reservationId: b.reservationId, usage: { promptTokens: 999, completionTokens: 0, totalTokens: 999 }, now });
    expect(f.wallet().chargedTokens).toBe(500);
  });
  it("preserves credits on waived attempts, quota resets and request retention", async () => {
    const f = fixture(); f.grant(); await f.consume(f.free, "exhaust-free", 1000);
    const r = await f.acquire(f.free, "waived", 500); if (!r.ok) throw r.error;
    await expect(f.limiter.resetUsage({ ...f.usageInput(f.free), windows: ["day"] })).rejects.toMatchObject({ code: "quota_reset_conflict" });
    await f.limiter.finalize({ reservationId: r.reservationId, now,
      usage: { promptTokens: 500, completionTokens: 0, totalTokens: 500 },
      charge: { reason: "empty_response", exemptAttempts: [1], usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } } });
    expect(f.wallet().balanceTokens).toBe(5000);
    await f.consume(f.free, "charged", 600);
    await f.limiter.resetUsage({ ...f.usageInput(f.free), windows: ["day", "month", "minute"] });
    f.store.database.exec("DELETE FROM token_reservations");
    expect(f.wallet().balanceTokens).toBe(4400);
    expect(f.store.database.prepare("SELECT SUM(tokens) AS n FROM token_credit_debits").get()).toEqual({ n: 600 });
  });
  it("corrects provisional credit charges once and records provider overruns as debt", async () => {
    const f = fixture(); f.grant({ tokens: 500 }); await f.consume(f.free, "free", 1000);
    const r = await f.acquire(f.free, "late", 400); if (!r.ok) throw r.error;
    const expired = new Date(now.getTime() + 301000);
    await f.limiter.cleanupExpired(expired);
    expect(f.wallet(expired).chargedTokens).toBe(400);
    await f.limiter.finalize({ reservationId: r.reservationId, now: expired, usage: { promptTokens: 200, completionTokens: 0, totalTokens: 200 } });
    expect(f.wallet(expired).chargedTokens).toBe(200);
    await f.limiter.finalize({ reservationId: r.reservationId, now: expired, usage: { promptTokens: 200, completionTokens: 0, totalTokens: 200 } });
    const overrun = await f.acquire(f.free, "overrun", 300, expired); if (!overrun.ok) throw overrun.error;
    await f.limiter.finalize({ reservationId: overrun.reservationId, now: expired, usage: { promptTokens: 400, completionTokens: 0, totalTokens: 400 } });
    expect(f.wallet(expired)).toMatchObject({ balanceTokens: -100, availableTokens: 0 });
    expect(await f.acquire(f.free, "blocked", 1, expired)).toMatchObject({ ok: false });
    f.grant({ idempotencyKey: "next", externalEventId: "next", tokens: 150, now: expired });
    expect(f.wallet(expired).availableTokens).toBe(50);
  });
  it("rolls back failed settlement and durably recovers a waiver without charging the wallet", async () => {
    const f = fixture(); f.grant(); await f.consume(f.free, "base", 1000);
    const r = await f.acquire(f.free, "failed-settlement", 400); if (!r.ok) throw r.error;
    f.store.database.exec("CREATE TRIGGER fail_credit_debit BEFORE INSERT ON token_credit_debits BEGIN SELECT RAISE(ABORT, 'injected'); END;");
    await expect(f.limiter.finalize({ reservationId: r.reservationId, now,
      usage: { promptTokens: 400, completionTokens: 0, totalTokens: 400 },
      charge: { reason: "empty_response", exemptAttempts: [1], usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } }
    })).rejects.toThrow(/injected/);
    expect(f.wallet()).toMatchObject({ chargedTokens: 0, reservedTokens: 400 });
    f.store.database.exec("DROP TRIGGER fail_credit_debit");
    expect((await f.limiter.cleanupExpired(now)).count).toBe(1);
    expect(f.wallet()).toMatchObject({ chargedTokens: 0, reservedTokens: 0 });
    expect((await f.limiter.getCurrentUsage(f.usageInput(f.free))).minute.used).toBe(1400);
  });
  it("rolls back a failed correction across the wallet and usage ledgers, then corrects exactly once", async () => {
    const f = fixture(); f.grant(); await f.consume(f.free, "base", 1000);
    const r = await f.acquire(f.free, "correction", 400); if (!r.ok) throw r.error;
    const expired = new Date(now.getTime() + 301000);
    await f.limiter.cleanupExpired(expired);
    const before = await f.limiter.getCurrentUsage(f.usageInput(f.free, expired));
    f.store.database.exec(`CREATE TRIGGER fail_credit_correction BEFORE INSERT ON token_credit_debits
      WHEN NEW.phase = 'correction' BEGIN SELECT RAISE(ABORT, 'injected correction failure'); END;`);
    const actual = { reservationId: r.reservationId, now: expired,
      usage: { promptTokens: 200, completionTokens: 0, totalTokens: 200 } };
    await expect(f.limiter.finalize(actual)).rejects.toThrow(/injected correction failure/);
    expect(await f.limiter.getCurrentUsage(f.usageInput(f.free, expired))).toEqual(before);
    expect(f.wallet(expired).chargedTokens).toBe(400);
    f.store.database.exec("DROP TRIGGER fail_credit_correction");
    await f.limiter.finalize(actual);
    await f.limiter.finalize(actual);
    expect(f.wallet(expired).chargedTokens).toBe(200);
    expect(f.store.database.prepare("SELECT phase, tokens FROM token_credit_debits WHERE reservation_id = ? ORDER BY rowid")
      .all(r.reservationId)).toEqual([{ phase: "initial", tokens: 400 }, { phase: "correction", tokens: -200 }]);
  });
  it("keeps minute, per-request and entitlement access controls; reports the new balance separately", async () => {
    const f = fixture(); f.grant({ tokens: 900000 });
    expect(await f.acquire(f.free, "minute-limit", 600001)).toMatchObject({ ok: false, limitKind: "token_minute" });
    expect(await f.acquire({ ...f.free, policySnapshot: { ...f.free.policySnapshot, maxPromptTokensPerRequest: 10 } }, "request-limit", 11))
      .toMatchObject({ ok: false, limitKind: "token_request_prompt" });
    expect(publicTokenUsage(await f.limiter.getCurrentUsage(f.usageInput(f.free)))).toMatchObject({
      accounting_mode: "free_then_plan_then_credits_v1", token_credits: { balance_tokens: 900000, expires_at: null } });
    f.store.cancelEntitlement({ id: f.free.id, now });
    expect(f.store.entitlementAccessForSubject("credit-user", now)).toMatchObject({ status: "inactive" });
    expect(f.wallet().balanceTokens).toBe(900000);
  });
});
