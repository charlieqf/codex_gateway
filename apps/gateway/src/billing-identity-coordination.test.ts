import Fastify from "fastify";
import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultFeaturePolicy, decryptSecret, encryptSecret, issueAccessCredential, issueUnifiedClientKey, phoneSignupFreePlan, phoneSignupFreePlanId, type Subject } from "@codex-gateway/core";
import { createSqliteStore, SqliteTokenBudgetLimiter } from "@codex-gateway/store-sqlite";
import { registerBillingAdminRoutes } from "./billing-admin.js";
import { PhoneAuthService, phoneAuthGatewayOrigin } from "./services/phone-auth-service.js";

const now = new Date("2026-09-09T00:00:00Z");
const expiresAt = new Date("2027-09-09T00:00:00Z");
const provider = "medevidence_billing_test";
const recoverySecret = "recovery-integration-test-secret-not-live";
const encryptionSecret = "backing-integration-test-secret-not-live";
const adminToken = "billing-admin-integration-test-only";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

function fixture() {
  const store = createSqliteStore({ path: ":memory:" });
  const app = Fastify({ logger: false });
  const { privateKey } = generateKeyPairSync("ed25519");
  const phoneAuth = new PhoneAuthService({
    mode: "transition", store, credentialStore: store, unifiedKeyStore: store, entitlementStore: store,
    publicGatewayBaseUrl: phoneAuthGatewayOrigin, issuer: `${phoneAuthGatewayOrigin}/gateway/auth/v1`,
    audience: "codex-gateway", activeKid: "signup-test-only",
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    phoneLookupSecret: "phone-lookup-signup-test-only-secret",
    phoneEncryptionSecret: "phone-encryption-signup-test-only-secret",
    unifiedKeyRecoverySecret: recoverySecret, apiKeyEncryptionSecret: encryptionSecret, now: () => now
  });
  app.addHook("onRequest", async (request, reply) => { reply.header("x-request-id", request.id); });
  const createUser = vi.fn(async (_input: unknown) => ({
    status: "created" as const, user: { id: "v2_test" },
    key: { id: "v2_key_test", key: "medevidence-integration-test-key", keyPrefix: "medevidence-test" }
  }));
  registerBillingAdminRoutes(app, {
    access: { token: adminToken, nextToken: null }, tokenMode: "env", billingStore: store,
    credentialStore: store, planEntitlementStore: store,
    externalIdentityStore: store, externalIdentityProvider: provider,
    phoneAuthService: phoneAuth,
    unifiedKeyRecoverySecret: recoverySecret, apiKeyEncryptionSecret: encryptionSecret,
    upstreamV2Client: {
      createUser,
      revokeKey: async () => ({ revoked: true, key: { id: "v2_key_test" } }),
      disableUser: async () => ({ disabled: true, user: { id: "v2_test" } })
    }, now: () => now
  });
  store.createPlan({
    id: "plan_test", displayName: "Test", scopeAllowlist: ["code"],
    featurePolicy: { ...defaultFeaturePolicy(), capabilities: ["chat", "tools"] },
    policy: { tokensPerMinute: null, tokensPerDay: null, tokensPerMonth: 50_000_000,
      maxPromptTokensPerRequest: null, maxTotalTokensPerRequest: null, reserveTokensPerRequest: 0, missingUsageCharge: "none" }, now
  });
  const pay = (subjectId: string) => store.grantEntitlement({ subjectId, planId: "plan_test", periodKind: "unlimited", now });
  const resolve = (id: string, phone = "13800138000") => app.inject({
    method: "POST", url: "/gateway/admin/billing/v1/subjects/resolve", headers: { authorization: `Bearer ${adminToken}` },
    payload: { provider, external_user_id: id, phone }
  });
  const create = (id: string, idempotencyKey = `signup:${id}`, phone?: string) => app.inject({
    method: "POST", url: "/gateway/admin/billing/v1/subjects",
    headers: { authorization: `Bearer ${adminToken}`, "idempotency-key": idempotencyKey },
    payload: { provider, external_user_id: id, scope_allowlist: ["code"], ...(phone === undefined ? {} : { phone }) }
  });
  const seed = (id = "subj_existing", phone = "13800138000") => {
    const subject: Subject = { id, label: "Existing phone user", phoneNumber: phone, externalProvider: "manual_trial", externalUserId: `manual_${id}`, state: "active", createdAt: now };
    store.upsertSubject(subject);
    const backing = issueAccessCredential({ subjectId: id, label: "Desktop", scope: "code", expiresAt, credentialClass: "desktop", allowedPublicModels: ["goldencode"], knownPublicModelIds: ["goldencode"], now });
    store.insertAccessCredential(backing.record);
    const unified = issueUnifiedClientKey({ subjectId: id, label: "Desktop", expiresAt, codexCredentialId: backing.record.id, codexCredentialPrefix: backing.record.prefix,
      codexKeyCiphertext: encryptSecret(backing.token, encryptionSecret), medevidenceKeyCiphertext: encryptSecret("test-medevidence-key", encryptionSecret),
      medevidenceKeyPrefix: "medevidence-test", metadata: { medevidence_base_url: "https://r760.instmarket.com.au:1443" }, credentialClass: "desktop", isCurrent: true, now });
    unified.record.tokenCiphertext = encryptSecret(unified.token, recoverySecret);
    store.insertUnifiedClientKey(unified.record);
    return { subject, backing, unified };
  };
  cleanups.push(async () => { await app.close(); store.close(); });
  return { app, store, createUser, resolve, create, seed, pay, phoneAuth };
}

describe("Billing phone-account coordination and key lifecycle", () => {
  it("keeps production and non-production external IDs separate in billing lookups", async () => {
    const f = fixture();
    const production = f.seed("subj_production_fixture", "13900139000");
    const testAccount = f.seed();
    await f.resolve("21", "13900139000");
    expect(f.store.getSubjectByExternalIdentity({ provider, externalUserId: "medevidence_test_21" })).toBeNull();
    await f.resolve("medevidence_test_21");
    expect(f.store.getSubjectByExternalIdentity({ provider, externalUserId: "21" })?.id).toBe(production.subject.id);
    expect(f.store.getSubjectByExternalIdentity({ provider, externalUserId: "medevidence_test_21" })?.id).toBe(testAccount.subject.id);
  });

  it("links a legacy phone account without changing its primary identity, key or entitlement", async () => {
    const f = fixture();
    const old = f.seed();
    const entitlement = f.pay(old.subject.id);
    expect((await f.resolve("21")).json()).toMatchObject({ status: "linked", subject: { id: old.subject.id } });
    expect(f.store.getSubject(old.subject.id)?.externalProvider).toBe("manual_trial");
    expect(f.store.getEntitlement(entitlement.id)).toEqual(entitlement);
    expect(f.store.listUnifiedClientKeys()).toEqual([old.unified.record]);
    const lookup = await f.app.inject({ url: `/gateway/admin/billing/v1/subjects?provider=${provider}&external_user_id=21`, headers: { authorization: `Bearer ${adminToken}` } });
    expect(lookup.json().subject.id).toBe(old.subject.id);
    expect((await f.create("21")).json().error.code).toBe("subject_already_exists");
    expect(f.createUser).not.toHaveBeenCalled();
  });

  it("atomically creates a nameless phone account, free grant and recoverable key ready for login", async () => {
    const f = fixture();
    expect((await f.resolve("22")).json().status).toBe("create_ready");
    const created = await f.create("22");
    expect(created.statusCode).toBe(200);
    const { subject, credential } = created.json();
    expect(subject.id).toMatch(/^subj_/);
    expect(f.store.getSubject(subject.id)?.phoneNumber).toBe("+8613800138000");
    expect(f.store.getSubject(subject.id)?.name).toBeNull();
    const current = f.store.listUnifiedClientKeys({ subjectId: subject.id })[0]!;
    expect(decryptSecret(current.tokenCiphertext!, recoverySecret)).toBe(credential.key);
    expect(current).toMatchObject({ isCurrent: true, credentialClass: "desktop" });
    expect(f.store.entitlementAccessForSubject(subject.id, now).status).toBe("active");
    const grants = f.store.listEntitlements({ subjectId: subject.id });
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({ planId: phoneSignupFreePlanId, periodKind: "unlimited", periodEnd: null,
      policySnapshot: { tokensPerDay: 100_000, tokensPerMonth: null }, state: "active" });
    const session = f.phoneAuth.login({ phone: "13800138000", deviceId: "sms-desktop-test-device", requestId: "login" });
    expect(f.phoneAuth.bootstrap(session.access_token, "bootstrap").unified_key.key).toBe(credential.key);
    expect(f.store.listUnifiedClientKeys({ subjectId: subject.id })).toEqual([current]);
    const replay = await f.create("22");
    expect(replay.json()).toMatchObject({ idempotent_replay: true, subject: { id: subject.id } });
    expect(replay.json().credential.key).toBeUndefined();
    expect(f.createUser).toHaveBeenCalledTimes(1);
    expect(f.store.listEntitlements({ subjectId: subject.id })).toEqual(grants);
    expect(f.store.database.prepare("SELECT COUNT(*) AS count FROM phone_auth_identities").get()?.count).toBe(1);
  });

  it("rolls back the entire local signup on phone preparation failure and resumes the same event", async () => {
    const f = fixture();
    await f.resolve("22");
    f.store.database.exec(`CREATE TRIGGER fail_signup_phone BEFORE INSERT ON phone_auth_identities
      BEGIN SELECT RAISE(ABORT, 'injected signup failure'); END;`);
    expect((await f.create("22")).statusCode).toBe(503);
    expect(f.store.listSubjects()).toHaveLength(0);
    expect(f.store.listEntitlements()).toHaveLength(0);
    expect(f.store.listUnifiedClientKeys()).toHaveLength(0);
    expect(f.store.replayBillingSubjectCreate("signup:22", "unused")).toBeNull();
    expect((await f.resolve("22")).json().status).toBe("account_pending");
    f.store.database.exec("DROP TRIGGER fail_signup_phone");
    expect((await f.create("22")).statusCode).toBe(200);
    expect(f.store.listSubjects()).toHaveLength(1);
    expect(f.store.listEntitlements()).toHaveLength(1);
    expect(f.createUser.mock.calls[0]![0]).toEqual(f.createUser.mock.calls[1]![0]);
  });

  it("does not re-enable a disabled identity or replace paid rights when signup is replayed", async () => {
    const f = fixture();
    await f.resolve("22");
    const subjectId = (await f.create("22")).json().subject.id;
    const paid = f.store.grantEntitlement({ subjectId, planId: "plan_test", periodKind: "unlimited", replace: true, now });
    f.phoneAuth.setIdentityState(subjectId, "disabled", "operator-disable");
    expect((await f.create("22")).json().idempotent_replay).toBe(true);
    expect((await f.resolve("22")).json().status).toBe("linked");
    expect(f.store.getPhoneAuthIdentityBySubjectId(subjectId)?.state).toBe("disabled");
    expect(f.store.entitlementAccessForSubject(subjectId, now)).toMatchObject({ entitlement: { id: paid.id, planId: "plan_test" } });
  });

  it("upgrades the free grant using the existing purchase replacement contract without changing the key", async () => {
    const f = fixture();
    await f.resolve("22");
    const created = (await f.create("22")).json();
    const subjectId = created.subject.id;
    const request = {
      method: "POST" as const, url: "/gateway/admin/billing/v1/entitlement-events",
      headers: { authorization: `Bearer ${adminToken}`, "idempotency-key": "first-paid-order" },
      payload: { event_type: "purchase", apply_mode: "apply", provider, external_order_id: "first-paid-order",
        subject_id: subjectId, plan_id: "plan_test", period_kind: "monthly",
        period_start: "2026-09-09T00:00:00Z", period_end: "2026-10-09T00:00:00Z", replace_current: true }
    };
    expect((await f.app.inject(request)).statusCode).toBe(200);
    expect((await f.app.inject(request)).json().idempotent_replay).toBe(true);
    expect(f.store.listEntitlements({ subjectId, state: "active" })[0]?.planId).toBe("plan_test");
    expect(f.store.listEntitlements({ subjectId, state: "cancelled" })[0]?.planId).toBe(phoneSignupFreePlanId);
    expect((await f.create("22")).json().idempotent_replay).toBe(true);
    const session = f.phoneAuth.login({ phone: "13800138000", deviceId: "paid-desktop-test-device", requestId: "paid-login" });
    expect(f.phoneAuth.bootstrap(session.access_token, "paid-bootstrap").unified_key.key).toBe(created.credential.key);
    expect(f.store.listEntitlements({ subjectId, state: "active" })[0]?.planId).toBe("plan_test");
  });

  it("enforces the daily 100k across retries, sessions and key rotation, and resets at UTC midnight", async () => {
    const f = fixture();
    await f.resolve("22");
    const subjectId = (await f.create("22")).json().subject.id;
    const entitlement = f.store.listEntitlements({ subjectId })[0]!;
    let key = f.store.listUnifiedClientKeys({ subjectId })[0]!;
    const limiter = new SqliteTokenBudgetLimiter({ db: f.store.database });
    const acquire = (requestId: string, at: Date, tokens: number) => limiter.acquire({
      requestId, credentialId: key.codexCredentialId, subjectId, entitlementId: entitlement.id,
      scope: "code", upstreamAccountId: null, provider: null, policy: entitlement.policySnapshot,
      estimatedPromptTokens: tokens, now: at
    });
    for (let i = 0; i < 4; i++) {
      const at = new Date(now.getTime() + i * 60_000);
      const result = await acquire(`use-${i}`, at, 25_000);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("unexpected budget rejection");
      await limiter.finalize({ reservationId: result.reservationId,
        usage: { promptTokens: 20_000, completionTokens: 5_000, totalTokens: 25_000 }, now: at });
    }
    expect((await f.create("22")).json().idempotent_replay).toBe(true);
    const session = f.phoneAuth.login({ phone: "13800138000", deviceId: "second-desktop-device", requestId: "relogin" });
    expect(session.subject.id).toBe(subjectId);
    const rotated = await f.app.inject({ method: "POST", url: `/gateway/admin/billing/v1/subjects/${subjectId}/keys`,
      headers: { authorization: `Bearer ${adminToken}`, "idempotency-key": "signup-budget-rotate" },
      payload: { revoke_previous: true, grace_period_seconds: 0 } });
    expect(rotated.statusCode).toBe(200);
    key = f.store.listUnifiedClientKeys({ subjectId }).find(item => item.isCurrent)!;
    expect(await acquire("over-budget", new Date("2026-09-09T23:59:59Z"), 1)).toMatchObject({ ok: false, limitKind: "token_day" });
    const nextDay = await acquire("next-day", new Date("2026-09-10T00:00:00Z"), 1);
    expect(nextDay.ok).toBe(true);
    expect(f.store.listEntitlements({ subjectId })).toEqual([entitlement]);
  });

  it("requires backend authorization for linking and direct phone creation", async () => {
    const f = fixture();
    const response = await f.app.inject({ method: "POST", url: "/gateway/admin/billing/v1/subjects/resolve", headers: { authorization: `Bearer external-access-token-test-only` }, payload: { provider, external_user_id: "21", phone: "13800138000" } });
    expect(response.statusCode).toBe(401);
    const create = await f.app.inject({ method: "POST", url: "/gateway/admin/billing/v1/subjects", headers: { authorization: "Bearer external-access-token-test-only", "idempotency-key": "untrusted-create" }, payload: { provider, external_user_id: "21", phone: "13800138000" } });
    expect(create.statusCode).toBe(401);
    expect(f.createUser).not.toHaveBeenCalled();
    expect(f.store.listSubjects()).toHaveLength(0);
  });

  it("accepts May's unchanged create payload for the configured provider without resolve", async () => {
    const f = fixture();
    const request = { method: "POST" as const, url: "/gateway/admin/billing/v1/subjects",
      headers: { authorization: `Bearer ${adminToken}`, "idempotency-key": `${provider}:bu_abc123:create_subject` },
      payload: { provider, external_user_id: "bu_abc123", display_name: "Alice", scope_allowlist: ["code"], metadata: { signup_source: "web", locale: "zh-CN" } } };
    const response = await f.app.inject(request);
    expect(response.statusCode).toBe(200);
    const created = response.json();
    expect(created).toMatchObject({ created: true, idempotent_replay: false,
      subject: { external_user_id: "bu_abc123", display_name: "Alice", state: "active" },
      credential: { state: "active", issued_at: now.toISOString() } });
    expect(created.subject.id).toMatch(/^subj_/);
    expect(created.credential.key).toMatch(/^cgu_live_/);
    expect(created.credential.expires_at).toBeDefined();
    expect(created.subject_id).toBeUndefined();
    expect(f.store.getSubject(created.subject.id)?.phoneNumber).toBeNull();
    expect(f.store.listEntitlements({ subjectId: created.subject.id })).toHaveLength(0);
    expect(f.store.database.prepare("SELECT COUNT(*) AS count FROM phone_auth_identities").get()?.count).toBe(0);
    expect(f.store.getExternalSubjectRegistrationState({ provider, externalUserId: "bu_abc123" })).toBeNull();
    const replay = (await f.app.inject(request)).json();
    expect(replay).toMatchObject({ created: false, idempotent_replay: true, subject: { id: created.subject.id } });
    expect(replay.credential.key).toBeUndefined();
    expect((await f.app.inject({ ...request, payload: { ...request.payload, display_name: "Changed" } })).json().error.code).toBe("idempotency_conflict");
    expect((await f.app.inject({ ...request, headers: { ...request.headers, "idempotency-key": "different-event" } })).json().error.code).toBe("subject_already_exists");
    expect(f.createUser).toHaveBeenCalledTimes(1);
  });

  it("creates and enrolls a new phone in one request and replays without resetting the grant", async () => {
    const f = fixture();
    const response = await f.create("22", "direct:22", "13800138000");
    expect(response.statusCode).toBe(200);
    const { subject, credential } = response.json();
    const grants = f.store.listEntitlements({ subjectId: subject.id });
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({ planId: phoneSignupFreePlanId, policySnapshot: { tokensPerDay: 100_000 }, state: "active" });
    const session = f.phoneAuth.login({ phone: "13800138000", deviceId: "direct-phone-test-device", requestId: "login-direct" });
    expect(f.phoneAuth.bootstrap(session.access_token, "bootstrap-direct").unified_key.key).toBe(credential.key);
    const replay = (await f.create("22", "direct:22", "13800138000")).json();
    expect(replay.idempotent_replay).toBe(true);
    expect(replay.credential.key).toBeUndefined();
    expect(f.store.listEntitlements({ subjectId: subject.id })).toEqual(grants);
    expect((await f.create("22", "direct:22", "13900139000")).json().error.code).toBe("idempotency_conflict");
    expect(f.createUser).toHaveBeenCalledTimes(1);
  });

  it("grants new users 100k/day while retaining the old 1M plan, entitlement, key and usage on linking", async () => {
    const f = fixture();
    const template = phoneSignupFreePlan(now);
    const oldPlan = f.store.createPlan({ ...template, id: "plan_free_daily_1m_v1",
      displayName: "Free · 1,000,000 tokens/day", policy: { ...template.policy, tokensPerDay: 1_000_000 } });
    const old = f.seed();
    const grant = f.store.grantEntitlement({ subjectId: old.subject.id, planId: oldPlan.id, periodKind: "unlimited", now });
    const limiter = new SqliteTokenBudgetLimiter({ db: f.store.database });
    const used = await limiter.acquire({ requestId: "old-free-usage", credentialId: old.backing.record.id,
      subjectId: old.subject.id, entitlementId: grant.id, scope: "code", upstreamAccountId: null,
      provider: null, policy: grant.policySnapshot, estimatedPromptTokens: 20_000, now });
    expect(used.ok).toBe(true);
    if (!used.ok) throw new Error("Old free grant unexpectedly reduced");
    await limiter.finalize({ reservationId: used.reservationId,
      usage: { promptTokens: 19_000, completionTokens: 1_000, totalTokens: 20_000 }, now });
    const oldUsage = f.store.database.prepare("SELECT * FROM entitlement_token_windows WHERE entitlement_id=? ORDER BY window_kind,window_start").all(grant.id);
    expect((await f.create("old-free", "link:old-free", "13800138000")).json().error.code).toBe("subject_already_exists");
    const created = await f.create("new-free", "create:new-free", "13900139000");
    expect(created.statusCode).toBe(200);
    const newId = created.json().subject.id;
    expect(f.store.listEntitlements({ subjectId: newId })[0]).toMatchObject({
      planId: phoneSignupFreePlanId, policySnapshot: { tokensPerDay: 100_000 } });
    expect(f.store.getPlan(oldPlan.id)).toEqual(oldPlan);
    expect(f.store.listEntitlements({ subjectId: old.subject.id })).toEqual([grant]);
    expect(f.store.listUnifiedClientKeys({ subjectId: old.subject.id })).toEqual([old.unified.record]);
    expect(f.store.database.prepare("SELECT * FROM entitlement_token_windows WHERE entitlement_id=? ORDER BY window_kind,window_start").all(grant.id)).toEqual(oldUsage);
  });

  it("links an existing phone internally and preserves May's existing-subject recovery contract", async () => {
    const f = fixture();
    const old = f.seed();
    const grant = f.pay(old.subject.id);
    const before = f.store.getSubject(old.subject.id);
    const response = await f.create("21", "direct:existing", "13800138000");
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("subject_already_exists");
    const lookup = await f.app.inject({ url: `/gateway/admin/billing/v1/subjects?provider=${provider}&external_user_id=21`, headers: { authorization: `Bearer ${adminToken}` } });
    expect(lookup.json().subject.id).toBe(old.subject.id);
    expect(f.store.getSubject(old.subject.id)).toEqual(before);
    expect(f.store.listUnifiedClientKeys()).toEqual([old.unified.record]);
    expect(f.store.listEntitlements()).toEqual([grant]);
    expect(f.createUser).not.toHaveBeenCalled();
  });

  it("rejects invalid phone extensions and another provider before provisioning", async () => {
    const f = fixture();
    for (const phone of [null, 13800138000, "", "invalid"]) {
      const response = await f.app.inject({ method: "POST", url: "/gateway/admin/billing/v1/subjects", headers: { authorization: `Bearer ${adminToken}`, "idempotency-key": "bad-phone" }, payload: { provider, external_user_id: "22", phone } });
      expect(response.statusCode).toBe(400);
    }
    const other = await f.app.inject({ method: "POST", url: "/gateway/admin/billing/v1/subjects", headers: { authorization: `Bearer ${adminToken}`, "idempotency-key": "other-provider" }, payload: { provider: "other", external_user_id: "22", phone: "13800138000" } });
    expect(other.statusCode).toBe(400);
    expect(f.store.getExternalSubjectRegistrationState({ provider, externalUserId: "22" })).toBeNull();
    expect(f.createUser).not.toHaveBeenCalled();
  });

  it("resumes a failed direct phone event without falling back to legacy or changing payload", async () => {
    const f = fixture();
    f.createUser.mockRejectedValueOnce(new Error("upstream test failure"));
    expect((await f.create("22", "direct:22", "13800138000")).statusCode).toBe(503);
    expect((await f.create("22", "different-event", "13800138000")).json().error.code).toBe("account_pending");
    expect((await f.create("22", "direct:22")).json().error.code).toBe("idempotency_conflict");
    expect((await f.create("22", "direct:22", "13800138000")).statusCode).toBe(200);
    expect(f.store.listSubjects()).toHaveLength(1);
    expect(f.store.listEntitlements()).toHaveLength(1);
  });

  it("does not consume a new phone reservation during an in-flight legacy create", async () => {
    const f = fixture();
    f.createUser.mockImplementationOnce(async () => {
      await f.resolve("22");
      return { status: "created", user: { id: "v2_test" }, key: { id: "v2_key_test", key: "test-key", keyPrefix: "test-prefix" } };
    });
    expect((await f.create("22")).json().error.code).toBe("account_pending");
    expect(f.store.listSubjects()).toHaveLength(0);
    expect((await f.create("22")).statusCode).toBe(200);
    expect(f.store.listEntitlements()).toHaveLength(1);
  });

  it("rejects ambiguous or disabled phone accounts and conflicting external bindings", async () => {
    const f = fixture();
    f.seed("subj_one");
    f.seed("subj_two");
    expect((await f.resolve("21")).json().error.code).toBe("identity_conflict");
    f.store.updateSubject("subj_two", { phoneNumber: "13900139000" });
    f.store.setSubjectState("subj_one", "disabled");
    expect((await f.resolve("21")).json().error.code).toBe("account_disabled");
    expect((await f.resolve("22", "13900139000")).json().status).toBe("linked");
    expect((await f.resolve("23", "13900139000")).json().error.code).toBe("identity_conflict");
    expect(f.createUser).not.toHaveBeenCalled();
  });

  it("keeps the stable external association when a caller presents another phone", async () => {
    const f = fixture();
    f.seed("subj_one");
    f.seed("subj_two", "13900139000");
    await f.resolve("21");
    expect((await f.resolve("21", "13900139000")).json().subject.id).toBe("subj_one");
    expect(f.store.getSubjectByExternalIdentity({ provider: "another_environment", externalUserId: "21" })).toBeNull();
  });

  it("holds the creation decision across an upstream failure and only resumes the same event", async () => {
    const f = fixture();
    await f.resolve("22");
    f.createUser.mockRejectedValueOnce(new Error("upstream test failure"));
    expect((await f.create("22")).statusCode).toBe(503);
    expect((await f.resolve("22")).json().status).toBe("account_pending");
    expect((await f.resolve("23")).json().error.code).toBe("identity_conflict");
    expect((await f.create("22", "replacement-event")).json().error.code).toBe("account_pending");
    const changedBody = await f.app.inject({
      method: "POST", url: "/gateway/admin/billing/v1/subjects",
      headers: { authorization: `Bearer ${adminToken}`, "idempotency-key": "signup:22" },
      payload: { provider, external_user_id: "22", scope_allowlist: ["code"], display_name: "Changed after failure" }
    });
    expect(changedBody.json().error.code).toBe("idempotency_conflict");
    expect((await f.create("22")).statusCode).toBe(200);
    expect(f.store.listSubjects()).toHaveLength(1);
    expect(f.createUser).toHaveBeenCalledTimes(2);
  });

  it("rejects a competing manual account created while upstream provisioning was in flight", async () => {
    const f = fixture();
    await f.resolve("22");
    f.createUser.mockImplementationOnce(async () => {
      f.seed();
      return { status: "created", user: { id: "v2_test" }, key: { id: "v2_key_test", key: "test-key", keyPrefix: "test-prefix" } };
    });
    expect((await f.create("22")).json().error.code).toBe("identity_conflict");
    expect(f.store.listSubjects().map(subject => subject.id)).toEqual(["subj_existing"]);
    expect(f.store.listEntitlements()).toHaveLength(0);
  });

  it("does not disclose a second generated key during concurrent idempotent creation", async () => {
    const f = fixture();
    await f.resolve("22");
    let release!: () => void;
    const ready = new Promise<void>(resolve => { release = resolve; });
    let entered = 0;
    f.createUser.mockImplementation(async () => {
      if (++entered === 2) release();
      await ready;
      return { status: "created", user: { id: "v2_test" }, key: { id: "v2_key_test", key: "test-key", keyPrefix: "test-prefix" } };
    });
    const responses = await Promise.all([f.create("22"), f.create("22")]);
    expect(responses.map(response => response.statusCode)).toEqual([200, 200]);
    const bodies = responses.map(response => response.json());
    expect(bodies.filter(body => typeof body.credential.key === "string")).toHaveLength(1);
    expect(bodies.filter(body => body.idempotent_replay)).toHaveLength(1);
    const current = f.store.listUnifiedClientKeys()[0]!;
    expect(decryptSecret(current.tokenCiphertext!, recoverySecret)).toBe(bodies.find(body => body.credential.key)?.credential.key);
    expect(f.store.listSubjects()).toHaveLength(1);
  });

  it("rotates a prepared key atomically, preserves grace and updates the enrolled phone identity", async () => {
    const f = fixture();
    const old = f.seed();
    f.pay(old.subject.id);
    f.store.preparePhoneAuthIdentity({ phoneHash: "hmac-sha256:test", phoneCiphertext: "test-encrypted-phone", subjectId: old.subject.id,
      unifiedKeyId: old.unified.record.id, unifiedKeyTokenCiphertext: old.unified.record.tokenCiphertext!,
      unifiedKeyMetadata: old.unified.record.metadata!, backingAllowedPublicModels: ["goldencode"], requestId: "prepare", now });
    await f.resolve("21");
    const headers = { authorization: `Bearer ${adminToken}`, "idempotency-key": "rotate:one" };
    const request = { method: "POST" as const, url: `/gateway/admin/billing/v1/subjects/${old.subject.id}/keys`, headers,
      payload: { reason: "test_rotation", revoke_previous: true, grace_period_seconds: 60 } };
    const rotated = await f.app.inject(request);
    expect(rotated.statusCode).toBe(200);
    const current = f.store.listUnifiedClientKeys({ subjectId: old.subject.id }).find(key => key.isCurrent)!;
    expect(decryptSecret(current.tokenCiphertext!, recoverySecret)).toBe(rotated.json().credential.key);
    expect(rotated.json().credential.key).not.toBe(old.unified.token);
    expect(f.store.getPhoneAuthIdentityByPhoneHash("hmac-sha256:test")?.unifiedKeyId).toBe(rotated.json().credential.id);
    expect(f.store.getUnifiedClientKeyByPrefix(old.unified.record.prefix)).toMatchObject({ isCurrent: false, revokedAt: null, expiresAt: new Date(now.getTime() + 60_000) });
    expect((await f.app.inject(request)).json().credential.key).toBeUndefined();
  });
});
