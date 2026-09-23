import { afterEach, describe, expect, it } from "vitest";
import { issueAccessCredential, issueUnifiedClientKey, type ApplyBillingEntitlementEventInput } from "@codex-gateway/core";
import { createSqliteStore, createSqliteTokenBudgetLimiter, type SqliteGatewayStore } from "./index.js";

const stores: SqliteGatewayStore[] = [];
const now = new Date("2026-09-14T03:28:48.323Z");
const start = new Date("2026-09-14T03:41:27.867Z");
const end = new Date("2027-09-14T03:41:27.867Z");
const monthly = "plan_paid_monthly_v1";
const yearly = "plan_paid_yearly_v1";
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

function fixture() {
  const store = createSqliteStore({ path: ":memory:" });
  stores.push(store);
  store.upsertSubject({ id: "retail_user", label: "Retail fixture", state: "active", createdAt: now });
  const credential = issueAccessCredential({ subjectId: "retail_user", label: "Desktop", scope: "code",
    credentialClass: "desktop", expiresAt: new Date("2027-09-14T03:28:48.323Z"), now });
  store.insertAccessCredential(credential.record);
  const key = issueUnifiedClientKey({ subjectId: "retail_user", label: "Desktop", credentialClass: "desktop", isCurrent: true,
    expiresAt: credential.record.expiresAt, codexCredentialId: credential.record.id, codexCredentialPrefix: credential.record.prefix,
    codexKeyCiphertext: "fixture-ciphertext", medevidenceKeyCiphertext: "fixture-ciphertext", medevidenceKeyPrefix: "fixture", now });
  store.insertUnifiedClientKey(key.record);
  for (const id of [monthly, yearly, "plan_internal_trial"]) {
    store.createPlan({ id, displayName: id, scopeAllowlist: ["code"], now,
      policy: { tokensPerMinute: 300_000, tokensPerDay: 6_000_000, tokensPerMonth: 200_000_000, tokensTotal: null,
        maxPromptTokensPerRequest: null, maxTotalTokensPerRequest: null, reserveTokensPerRequest: 0, missingUsageCharge: "none" } });
  }
  const input: ApplyBillingEntitlementEventInput = { idempotencyKey: "retail:order:purchase", payloadHash: "fixture-payload",
    provider: "medevidence_billing", externalOrderId: "order", eventType: "purchase", applyMode: "apply",
    subjectId: "retail_user", planId: yearly, periodKind: "one_off", periodStart: start, periodEnd: end, now: start };
  const event = (overrides: Partial<ApplyBillingEntitlementEventInput> = {}) => store.applyBillingEntitlementEvent({ ...input, ...overrides });
  return { store, credential, key, input, event };
}

describe("retail Billing periods and current Desktop credential coverage", () => {
  it.each([
    { planId: yearly, periodKind: "monthly", periodEnd: end },
    { planId: yearly, periodKind: "one_off", periodEnd: new Date("2026-10-14T03:41:27.867Z") },
    { planId: yearly, periodKind: "unlimited", periodEnd: null },
    { planId: monthly, periodKind: "one_off", periodEnd: new Date("2026-10-14T03:41:27.867Z") },
    { planId: monthly, periodKind: "monthly", periodEnd: end },
    { planId: monthly, periodKind: "monthly", periodEnd: new Date("2026-09-15T03:41:27.867Z") },
    { planId: yearly, periodKind: "one_off", periodEnd: new Date("2028-09-14T03:41:27.867Z") }
  ] as const)("rejects invalid public product periods before writes: $planId / $periodKind / $periodEnd", (period) => {
    const f = fixture();
    const before = f.store.listAdminAuditEvents();
    expect(() => f.event({ ...period, replaceCurrent: true })).toThrow(expect.objectContaining({ code: "invalid_period", httpStatus: 400 }));
    expect(f.store.listEntitlements({ subjectId: "retail_user" })).toEqual([]);
    expect(f.store.listBillingEvents().events).toEqual([]);
    expect(f.store.listAdminAuditEvents()).toEqual(before);
    expect(f.store.getAccessCredentialByPrefix(f.credential.record.prefix)?.expiresAt).toEqual(f.credential.record.expiresAt);
  });

  it.each([
    [monthly, "monthly", "2027-01-31T00:00:00+08:00", "2027-02-28T00:00:00+08:00"],
    [monthly, "monthly", "2028-01-31T00:00:00Z", "2028-02-29T00:00:00Z"],
    [monthly, "monthly", "2027-02-28T00:00:00Z", "2027-03-31T00:00:00Z"],
    [monthly, "monthly", "2027-03-01T12:00:00+11:00", "2027-04-01T12:00:00+10:00"],
    [yearly, "one_off", "2027-09-14T00:00:00Z", "2028-09-14T00:00:00Z"],
    [yearly, "one_off", "2028-02-29T00:00:00Z", "2029-02-28T00:00:00Z"]
  ] as const)("preserves payment-owned dates including month-end/leap-year/DST: %s %s %s", (planId, periodKind, from, to) => {
    const f = fixture();
    const result = f.event({ planId, periodKind, periodStart: new Date(from), periodEnd: new Date(to) });
    expect(result.entitlement).toMatchObject({ periodKind, periodStart: new Date(from), periodEnd: new Date(to) });
  });

  it("keeps internal trial durations and log-only historical events compatible", () => {
    const f = fixture();
    const logged = f.event({ applyMode: "log_only", periodKind: "monthly" });
    expect(logged.billingEvent.status).toBe("ignored");
    expect(f.store.listEntitlements({ subjectId: "retail_user" })).toEqual([]);
    const trial = f.event({ idempotencyKey: "internal:trial", planId: "plan_internal_trial", periodKind: "one_off",
      periodEnd: new Date("2026-09-15T03:41:27.867Z") });
    expect(trial.applied).toBe(true);
    expect(f.store.getAccessCredentialByPrefix(f.credential.record.prefix)?.expiresAt).toEqual(f.credential.record.expiresAt);
  });

  it("covers a purchased year with the same current Key and audits both previous expiry times once", () => {
    const f = fixture();
    const beforeCredential = f.store.getAccessCredentialByPrefix(f.credential.record.prefix)!;
    const beforeKey = f.store.getUnifiedClientKeyByPrefix(f.key.record.prefix)!;
    const result = f.event();
    const savedCredential = f.store.getAccessCredentialByPrefix(f.credential.record.prefix)!;
    const savedKey = f.store.getUnifiedClientKeyByPrefix(f.key.record.prefix)!;
    expect(savedCredential).toEqual({ ...beforeCredential, expiresAt: end });
    expect(savedKey).toEqual({ ...beforeKey, expiresAt: end });
    const audits = f.store.listAdminAuditEvents({ action: "entitlement-grant" });
    expect(audits[0]?.params?.credential_expiry_extensions).toEqual([{
      unified_key_id: f.key.record.id, credential_id: f.credential.record.id,
      unified_key_previous_expires_at: f.key.record.expiresAt.toISOString(),
      credential_previous_expires_at: f.credential.record.expiresAt.toISOString(), required_expires_at: end.toISOString()
    }]);
    expect(f.event().idempotentReplay).toBe(true);
    expect(f.store.listEntitlements({ subjectId: "retail_user" })).toHaveLength(1);
    expect(f.store.listAdminAuditEvents({ action: "entitlement-grant" })).toEqual(audits);
    expect(result.entitlement?.id).toBe(f.event().entitlement?.id);
  });

  it("extends coverage for an early scheduled renewal and rejects a wrong renewal period without replacing it", () => {
    const f = fixture();
    f.event();
    const renewalEnd = new Date("2028-09-14T03:41:27.867Z");
    const renewal = f.event({ idempotencyKey: "retail:renew", eventType: "renew", periodStart: end, periodEnd: renewalEnd });
    expect(renewal.entitlement?.state).toBe("scheduled");
    expect(f.store.getUnifiedClientKeyByPrefix(f.key.record.prefix)?.expiresAt).toEqual(renewalEnd);
    expect(() => f.event({ idempotencyKey: "retail:bad-renew", eventType: "renew", periodKind: "monthly",
      periodStart: end, periodEnd: renewalEnd, replaceScheduled: true })).toThrow(expect.objectContaining({ code: "invalid_period" }));
    expect(f.store.getEntitlement(renewal.entitlement!.id)?.state).toBe("scheduled");
  });

  it.each([
    ["key", "unified_client_keys"], ["credential", "access_credentials"], ["key and credential", null]
  ] as const)("restores a current %s that lapsed within 90 days and audits the revival", (_name, table) => {
    const f = fixture();
    const lapsed = new Date(start.getTime() - 89 * 86_400_000).toISOString();
    for (const t of table ? [table] : ["unified_client_keys", "access_credentials"]) {
      f.store.database.prepare(`UPDATE ${t} SET expires_at=?`).run(lapsed);
    }
    const beforeKey = f.store.getUnifiedClientKeyByPrefix(f.key.record.prefix)!;
    f.event();
    expect(f.store.getUnifiedClientKeyByPrefix(f.key.record.prefix)).toEqual({ ...beforeKey, expiresAt: end });
    expect(f.store.getAccessCredentialByPrefix(f.credential.record.prefix)?.expiresAt).toEqual(end);
    const [extension] = f.store.listAdminAuditEvents({ action: "entitlement-grant" })[0]?.params
      ?.credential_expiry_extensions as Array<Record<string, unknown>>;
    expect(extension).toMatchObject({ unified_key_id: f.key.record.id, revived_after_expiry: true, required_expires_at: end.toISOString() });
  });

  it("does not mark an unexpired extension as a revival", () => {
    const f = fixture();
    f.event();
    const [extension] = f.store.listAdminAuditEvents({ action: "entitlement-grant" })[0]?.params
      ?.credential_expiry_extensions as Array<Record<string, unknown>>;
    expect(extension).not.toHaveProperty("revived_after_expiry");
  });

  it.each(["revoked_key", "revoked_credential", "key_lapsed_beyond_window", "credential_lapsed_beyond_window", "non_current", "non_desktop"])(
    "does not revive or extend excluded credentials: %s", (condition) => {
      const f = fixture();
      const tooOld = new Date(start.getTime() - 91 * 86_400_000).toISOString();
      if (condition === "revoked_key") f.store.database.prepare("UPDATE unified_client_keys SET revoked_at=?").run(now.toISOString());
      if (condition === "revoked_credential") f.store.database.prepare("UPDATE access_credentials SET revoked_at=?").run(now.toISOString());
      if (condition === "key_lapsed_beyond_window") f.store.database.prepare("UPDATE unified_client_keys SET expires_at=?").run(tooOld);
      if (condition === "credential_lapsed_beyond_window") f.store.database.prepare("UPDATE access_credentials SET expires_at=?").run(tooOld);
      if (condition === "non_current") f.store.database.exec("UPDATE unified_client_keys SET is_current=0");
      if (condition === "non_desktop") f.store.database.exec("UPDATE unified_client_keys SET credential_class='unknown'");
      const beforeKey = f.store.getUnifiedClientKeyByPrefix(f.key.record.prefix);
      const beforeCredential = f.store.getAccessCredentialByPrefix(f.credential.record.prefix);
      f.event();
      expect(f.store.getUnifiedClientKeyByPrefix(f.key.record.prefix)).toEqual(beforeKey);
      expect(f.store.getAccessCredentialByPrefix(f.credential.record.prefix)).toEqual(beforeCredential);
    });

  it("never shortens an existing expiry and does not extend other Subjects", () => {
    const f = fixture();
    const longer = "2030-01-01T00:00:00.000Z";
    f.store.database.prepare("UPDATE unified_client_keys SET expires_at=?").run(longer);
    f.store.upsertSubject({ id: "other", label: "Other", state: "active", createdAt: now });
    const other = issueAccessCredential({ subjectId: "other", label: "Other", scope: "code", credentialClass: "desktop", expiresAt: f.credential.record.expiresAt, now });
    f.store.insertAccessCredential(other.record);
    const otherBefore = f.store.getAccessCredentialByPrefix(other.record.prefix);
    f.event();
    expect(f.store.getUnifiedClientKeyByPrefix(f.key.record.prefix)?.expiresAt.toISOString()).toBe(longer);
    expect(f.store.getAccessCredentialByPrefix(f.credential.record.prefix)?.expiresAt).toEqual(end);
    expect(f.store.getAccessCredentialByPrefix(other.record.prefix)).toEqual(otherBefore);
  });

  it("rolls back the grant and expiry extensions when the transaction audit fails", () => {
    const f = fixture();
    f.store.database.exec("CREATE TRIGGER reject_grant_audit BEFORE INSERT ON admin_audit_events WHEN NEW.action='entitlement-grant' BEGIN SELECT RAISE(ABORT, 'test audit failure'); END");
    expect(() => f.event()).toThrow(expect.objectContaining({ code: "service_unavailable" }));
    expect(f.store.listEntitlements({ subjectId: "retail_user" })).toEqual([]);
    expect(f.store.getAccessCredentialByPrefix(f.credential.record.prefix)?.expiresAt).toEqual(f.credential.record.expiresAt);
    expect(f.store.getUnifiedClientKeyByPrefix(f.key.record.prefix)?.expiresAt).toEqual(f.key.record.expiresAt);
  });

  it("books a valid yearly purchase into a UTC calendar month and starts a fresh month in October", async () => {
    const f = fixture();
    const entitlement = f.event().entitlement!;
    const limiter = createSqliteTokenBudgetLimiter({ db: f.store.database });
    const input = { subjectId: "retail_user", entitlementId: entitlement.id, entitlementPeriodStart: start, entitlementPeriodEnd: end, policy: entitlement.policySnapshot };
    const reservation = await limiter.acquire({ ...input, requestId: "yearly-use", credentialId: f.credential.record.id, scope: "code", upstreamAccountId: null, provider: null, estimatedPromptTokens: 4000, now: start });
    expect(reservation.ok).toBe(true);
    if (!reservation.ok) throw reservation.error;
    await limiter.finalize({ reservationId: reservation.reservationId, usage: { totalTokens: 4000, promptTokens: 3990, completionTokens: 10 }, now: start });
    expect((await limiter.getCurrentUsage({ ...input, now: start })).month).toMatchObject({ used: 4000, limit: 200_000_000, windowStart: "2026-09-01T00:00:00.000Z" });
    expect((await limiter.getCurrentUsage({ ...input, now: new Date("2026-10-01T00:00:00Z") })).month).toMatchObject({ used: 0, limit: 200_000_000, windowStart: "2026-10-01T00:00:00.000Z" });
  });
});
