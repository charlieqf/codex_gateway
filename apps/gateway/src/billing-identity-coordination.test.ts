import Fastify from "fastify";
import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultFeaturePolicy, decryptSecret, encryptSecret, issueAccessCredential, issueUnifiedClientKey, phoneSignupFreePlan, phoneSignupFreePlanId, type Subject } from "@codex-gateway/core";
import { createSqliteStore, SqliteTokenBudgetLimiter } from "@codex-gateway/store-sqlite";
import { registerBillingAdminRoutes, type BillingAdminRouteOptions } from "./billing-admin.js";
import { PhoneAuthService, phoneAuthGatewayOrigin } from "./services/phone-auth-service.js";
import type { UpstreamV2CreateUserResult } from "./upstream-v2-client.js";

const now = new Date("2026-09-09T00:00:00Z");
const expiresAt = new Date("2027-09-09T00:00:00Z");
const provider = "medevidence_billing_test";
const recoverySecret = "recovery-integration-test-secret-not-live";
const encryptionSecret = "backing-integration-test-secret-not-live";
const adminToken = "billing-admin-integration-test-only";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); vi.unstubAllGlobals(); });

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
  const createUser = vi.fn(async (_input: unknown): Promise<UpstreamV2CreateUserResult> => ({
    status: "created" as const, user: { id: "v2_test" },
    key: { id: "v2_key_test", key: "medevidence-integration-test-key", keyPrefix: "medevidence-test" }
  }));
  const disableUser = vi.fn(async (_input: unknown) => ({ disabled: true, user: { id: "v2_test" } }));
  const routeOptions: BillingAdminRouteOptions = {
    access: { token: adminToken, nextToken: null }, tokenMode: "env", billingStore: store,
    credentialStore: store, planEntitlementStore: store,
    subjectMetadataStore: store, publicBaseUrl: phoneAuthGatewayOrigin, adminAuditStore: store,
    externalIdentityStore: store, externalIdentityProvider: provider,
    phoneAuthService: phoneAuth,
    unifiedKeyRecoverySecret: recoverySecret, apiKeyEncryptionSecret: encryptionSecret,
    upstreamV2Client: {
      createUser,
      revokeKey: async () => ({ revoked: true, key: { id: "v2_key_test" } }),
      disableUser
    }, now: () => now
  };
  registerBillingAdminRoutes(app, routeOptions);
  store.createPlan({
    id: "plan_test", displayName: "Test", scopeAllowlist: ["code"],
    featurePolicy: { ...defaultFeaturePolicy(), capabilities: ["chat", "tools"] },
    policy: { tokensPerMinute: null, tokensPerDay: null, tokensPerMonth: 50_000_000,
    tokensTotal: null,
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
  return { app, store, createUser, disableUser, routeOptions, resolve, create, seed, pay, phoneAuth };
}

describe("issuance recovery against the billing ledger", () => {
  const headers = {authorization: `Bearer ${adminToken}`};
  async function waitJob(app: ReturnType<typeof Fastify>, jobId: string) {
    for (let attempt = 0; attempt < 50; attempt++) {
      const response = await app.inject({url: `/gateway/admin/billing/v1/real-user-issue/${jobId}`, headers});
      const job = response.json();
      if (!["queued", "running", "compensating"].includes(job.state)) return job;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error("Task did not settle");
  }
  function validation(f: ReturnType<typeof fixture>, valid = true) {
    vi.stubGlobal("fetch", async (url: string) => {
      const keys = f.store.listUnifiedClientKeys();
      const key = keys.find(candidate => candidate.metadata?.issuance_task_id) ?? keys[0]!;
      return new Response(JSON.stringify(url.endsWith("/resolve") ? {
        valid: true, subject: {id: key.subjectId},
        codex_gateway: {api_key: decryptSecret(key.codexKeyCiphertext, encryptionSecret), key_prefix: `cgw.${key.codexCredentialPrefix}`,
          endpoint_base_url: `${phoneAuthGatewayOrigin}/v1`, credential_validation_url: `${phoneAuthGatewayOrigin}/gateway/credentials/current`},
        medevidence: {api_key: "test-runtime-key", key_prefix: "test-runtime-prefix"}
      } : {valid, subject: {id: key.subjectId}, entitlement: {state: "active", feature_policy: {capabilities: ["chat", "tools"]}}}), {status: 200});
    });
  }
  const payload = {name: "Test User", phone: "13800138000", plan_id: "plan_test"};

  it.each(["active", "disabled", "archived"] as const)("rejects a phone owned by a %s account without linking or changing it", async state => {
    const f = fixture();
    const existing = f.seed();
    f.store.setSubjectState(existing.subject.id, state);
    const beforeSubjects = f.store.listSubjects({includeArchived: true});
    const beforeKeys = f.store.listUnifiedClientKeys();
    const beforePhone = f.store.database.prepare("SELECT * FROM phone_auth_identities").all();
    const accepted = await f.app.inject({method: "POST", url: "/gateway/admin/billing/v1/real-user-issue", headers, payload});
    expect(accepted.statusCode).toBe(202);
    const job = await waitJob(f.app, accepted.json().job_id);
    expect(job).toMatchObject({state: "failed", error: {code: "subject_already_exists"}});
    expect(job.error.message).toContain(existing.subject.id);
    expect(f.createUser).not.toHaveBeenCalled();
    expect(f.disableUser).not.toHaveBeenCalled();
    expect(f.store.listSubjects({includeArchived: true})).toEqual(beforeSubjects);
    expect(f.store.listUnifiedClientKeys()).toEqual(beforeKeys);
    expect(f.store.database.prepare("SELECT * FROM phone_auth_identities").all()).toEqual(beforePhone);
    expect(f.store.getExternalSubjectRegistration({provider: "manual_trial", externalUserId: "phone_13800138000"})).toBeNull();
    expect((await f.app.inject({method: "POST", url: `/gateway/admin/billing/v1/real-user-issue/${job.job_id}/resume`, headers})).statusCode).toBe(409);
    // A failed preflight must not permanently consume the task identity.
    validation(f);
    const corrected = await f.app.inject({method: "POST", url: "/gateway/admin/billing/v1/real-user-issue", headers,
      payload: {...payload, external_user_id: "phone_13800138000", phone: "13900139000"}});
    expect(corrected.statusCode).toBe(202);
    expect((await waitJob(f.app, corrected.json().job_id)).state).toBe("succeeded");
    expect(f.createUser).toHaveBeenCalledTimes(1);
  });

  it("checks phone identity ownership even when Subject contact metadata is absent", async () => {
    const f = fixture();
    const existing = f.seed(); f.pay(existing.subject.id);
    f.phoneAuth.prepareIdentity({phone: "13800138000", subjectId: existing.subject.id, unifiedKey: existing.unified.token, requestId: "test"});
    f.store.updateSubject(existing.subject.id, {phoneNumber: null});
    expect(f.store.getSubject(existing.subject.id)?.phoneNumber).toBeNull();
    const before = f.store.database.prepare("SELECT * FROM phone_auth_identities").all();
    const accepted = await f.app.inject({method: "POST", url: "/gateway/admin/billing/v1/real-user-issue", headers, payload});
    expect((await waitJob(f.app, accepted.json().job_id)).state).toBe("failed");
    expect(f.createUser).not.toHaveBeenCalled();
    expect(f.store.database.prepare("SELECT * FROM phone_auth_identities").all()).toEqual(before);
  });

  it("keeps a post-upstream identity conflict recoverable rather than discarding its orphan evidence", async () => {
    const f = fixture();
    const createUser = f.createUser.getMockImplementation()!;
    f.createUser.mockImplementationOnce(async input => {
      const result = await createUser(input);
      f.seed("racing-owner");
      return result;
    });
    const accepted = await f.app.inject({method: "POST", url: "/gateway/admin/billing/v1/real-user-issue", headers, payload});
    const job = await waitJob(f.app, accepted.json().job_id);
    expect(job).toMatchObject({state: "retryable", error: {code: "identity_conflict"}});
    expect(f.store.getExternalSubjectRegistration({provider: "manual_trial", externalUserId: "phone_13800138000"}))
      .toMatchObject({state: "creating", upstreamUserId: "v2_test", upstreamKeyId: "v2_key_test"});
    expect(f.store.hasBillingProvisioningAttempt({provider: "manual_trial", externalUserId: "phone_13800138000"})).toBe(true);
  });

  it("terminates an original create task after its orphan is confirmed disabled", async () => {
    const f = fixture();
    const failure = vi.spyOn(f.store, "createBillingSubject").mockImplementationOnce(() => { throw new Error("local commit failed"); });
    const accepted = await f.app.inject({method: "POST", url: "/gateway/admin/billing/v1/real-user-issue", headers, payload});
    const jobId = accepted.json().job_id;
    expect((await waitJob(f.app, jobId)).state).toBe("retryable");
    failure.mockRestore();
    const identity = {provider: "manual_trial", externalUserId: "phone_13800138000"};
    const registration = f.store.getExternalSubjectRegistration(identity)!;
    const compensation = {...identity, idempotencyKey: registration.idempotencyKey!, payloadHash: registration.payloadHash!,
      upstreamUserId: registration.upstreamUserId!, upstreamKeyId: registration.upstreamKeyId!, actorId: "test", requestId: "test"};
    f.store.beginExternalSubjectCompensation(compensation);
    f.store.completeExternalSubjectCompensation(compensation);
    expect((await f.app.inject({method: "POST", url: `/gateway/admin/billing/v1/real-user-issue/${jobId}/resume`, headers})).statusCode).toBe(202);
    expect((await waitJob(f.app, jobId))).toMatchObject({state: "failed", error: {code: "account_disabled"}});
    expect(f.createUser).toHaveBeenCalledTimes(1);
  });

  it("recovers after entitlement commit without creating another subject, key or entitlement", async () => {
    const f = fixture();
    validation(f);
    const apply = f.store.applyBillingEntitlementEvent.bind(f.store);
    const fault = vi.spyOn(f.store, "applyBillingEntitlementEvent").mockImplementationOnce(input => {
      apply(input); throw new Error("crash after grant commit");
    });
    const accepted = await f.app.inject({method: "POST", url: "/gateway/admin/billing/v1/real-user-issue", headers, payload});
    expect(accepted.statusCode).toBe(202);
    const jobId = accepted.json().job_id;
    expect((await waitJob(f.app, jobId)).state).toBe("retryable");
    const originalKey = f.store.listUnifiedClientKeys()[0]!;
    const originalEntitlements = f.store.listEntitlements({subjectId: originalKey.subjectId});
    fault.mockRestore();
    const restarted = Fastify({logger: false});
    registerBillingAdminRoutes(restarted, f.routeOptions);
    try {
      const denied = await restarted.inject({method: "POST", url: `/gateway/admin/billing/v1/real-user-issue/${jobId}/retry-disable`, headers});
      expect(denied.statusCode).toBe(409);
      const resumed = await restarted.inject({method: "POST", url: `/gateway/admin/billing/v1/real-user-issue/${jobId}/resume`, headers,
        payload: {plan_id: "ignored", key_expires_at: "2030-01-01T00:00:00Z"}});
      expect(resumed.statusCode).toBe(202);
      const finished = await waitJob(restarted, jobId);
      expect(finished.state).toBe("succeeded");
      expect(finished.unified_key).toBe(decryptSecret(originalKey.tokenCiphertext!, recoverySecret));
      expect(f.store.listSubjects()).toHaveLength(1);
      expect(f.store.listUnifiedClientKeys()).toHaveLength(1);
      expect(f.store.listEntitlements({subjectId: originalKey.subjectId})).toEqual(originalEntitlements);
      expect(f.createUser).toHaveBeenCalledTimes(1);
      expect(f.disableUser).not.toHaveBeenCalled();
    } finally { await restarted.close(); }
  });

  it("keeps upstream disable pending and retries only compensation", async () => {
    const f = fixture(); validation(f, false);
    const log = vi.spyOn(f.app.log, "error");
    f.disableUser.mockRejectedValueOnce(new Error("upstream unreachable"));
    const accepted = await f.app.inject({method: "POST", url: "/gateway/admin/billing/v1/real-user-issue", headers, payload});
    const jobId = accepted.json().job_id;
    const failed = await waitJob(f.app, jobId);
    expect(failed.state).toBe("compensation_failed");
    expect(log).toHaveBeenCalledWith(expect.objectContaining({event: "issuance_compensation_pending", job_id: jobId}), expect.any(String));
    expect(f.store.getBillingSubject(failed.subject_id)).toMatchObject({subject: {state: "disabled"}, upstreamV2Binding: {state: "pending"}});
    expect(f.store.getPhoneAuthIdentityBySubjectId(failed.subject_id)?.state).toBe("disabled");
    expect((await f.app.inject({method: "POST", url: `/gateway/admin/billing/v1/real-user-issue/${jobId}/resume`, headers})).statusCode).toBe(409);
    expect((await f.app.inject({method: "POST", url: `/gateway/admin/billing/v1/real-user-issue/${jobId}/retry-disable`, headers})).statusCode).toBe(202);
    expect((await waitJob(f.app, jobId)).state).toBe("failed");
    expect(f.store.getBillingSubject(failed.subject_id)?.upstreamV2Binding?.state).toBe("disabled");
    expect(f.createUser).toHaveBeenCalledTimes(1);
    expect(f.disableUser).toHaveBeenCalledTimes(2);
  });

  it("does not recover a revoked original key or disable a changed account", async () => {
    const f = fixture();
    vi.stubGlobal("fetch", async () => { throw new Error("network interrupted"); });
    const response = await f.app.inject({method: "POST", url: "/gateway/admin/billing/v1/real-user-issue", headers, payload});
    const jobId = response.json().job_id;
    expect((await waitJob(f.app, jobId)).state).toBe("retryable");
    const key = f.store.listUnifiedClientKeys()[0]!;
    f.store.database.prepare("UPDATE unified_client_keys SET revoked_at = ? WHERE id = ?").run(now.toISOString(), key.id);
    expect((await f.app.inject({method: "POST", url: `/gateway/admin/billing/v1/real-user-issue/${jobId}/resume`, headers})).statusCode).toBe(202);
    expect((await waitJob(f.app, jobId)).error.code).toBe("issue_recovery_requires_review");
    expect(f.disableUser).not.toHaveBeenCalled();
    expect(f.createUser).toHaveBeenCalledTimes(1);
    expect(f.store.getSubject(key.subjectId)?.state).toBe("active");
  });

  it.each(["binding-user", "binding-key", "restored-account", "new-credential"])(
    "refuses compensation replay after %s changes, including after restart", async change => {
      const f = fixture(); validation(f, false);
      f.disableUser.mockRejectedValueOnce(new Error("upstream unavailable"));
      const accepted = await f.app.inject({method: "POST", url: "/gateway/admin/billing/v1/real-user-issue", headers, payload});
      const jobId = accepted.json().job_id;
      const pending = await waitJob(f.app, jobId);
      expect(pending.state).toBe("compensation_failed");
      const subjectId = pending.subject_id;
      if (change === "binding-user") f.store.database.prepare("UPDATE upstream_v2_bindings SET v2_user_id='replacement' WHERE subject_id=?").run(subjectId);
      if (change === "binding-key") f.store.database.prepare("UPDATE upstream_v2_bindings SET v2_key_id='replacement' WHERE subject_id=?").run(subjectId);
      if (change === "restored-account") { f.store.setSubjectState(subjectId, "active"); f.pay(subjectId); }
      if (change === "new-credential") f.store.insertAccessCredential(issueAccessCredential({subjectId, label: "later operator key", scope: "code", expiresAt, now}).record);
      const beforeSubject = f.store.getSubject(subjectId);
      const beforeCredentials = f.store.listAccessCredentials({subjectId});
      const beforeEntitlements = f.store.listEntitlements({subjectId});
      const restarted = Fastify({logger: false}); registerBillingAdminRoutes(restarted, f.routeOptions);
      try {
        expect((await restarted.inject({method: "POST", url: `/gateway/admin/billing/v1/real-user-issue/${jobId}/retry-disable`, headers})).statusCode).toBe(202);
        expect(await waitJob(restarted, jobId)).toMatchObject({state: "compensation_failed", requires_review: true,
          compensation_error: {code: "issue_recovery_requires_review"}});
        expect(f.disableUser).toHaveBeenCalledTimes(1);
        expect(f.store.getSubject(subjectId)).toEqual(beforeSubject);
        expect(f.store.listAccessCredentials({subjectId})).toEqual(beforeCredentials);
        expect(f.store.listEntitlements({subjectId})).toEqual(beforeEntitlements);
        expect((await restarted.inject({method: "POST", url: `/gateway/admin/billing/v1/real-user-issue/${jobId}/retry-disable`, headers})).statusCode).toBe(409);
        await restarted.inject({method: "POST", url: `/gateway/admin/billing/v1/real-user-issue/${jobId}/retry-disable`, headers,
          payload: {acknowledge_review: true}});
        expect(await waitJob(restarted, jobId)).toMatchObject({requires_review: true});
        expect(f.disableUser).toHaveBeenCalledTimes(1);
      } finally { await restarted.close(); }
    }
  );

  it.each(["phone-disabled", "phone-rebound", "expiry-extended", "rate-changed", "scope-changed"])(
    "preserves an operator's %s change when resuming an interrupted task", async change => {
      const f = fixture();
      vi.stubGlobal("fetch", async () => { throw new Error("network interrupted"); });
      const accepted = await f.app.inject({method: "POST", url: "/gateway/admin/billing/v1/real-user-issue", headers,
        payload: {...payload, key_expires_at: new Date(now.getTime() + 90 * 86400_000).toISOString()}});
      const jobId = accepted.json().job_id;
      expect((await waitJob(f.app, jobId)).state).toBe("retryable");
      const key = f.store.listUnifiedClientKeys()[0]!;
      if (change === "phone-disabled") f.phoneAuth.setIdentityState(key.subjectId, "disabled", "operator-disable");
      if (change === "phone-rebound") f.store.database.prepare("UPDATE phone_auth_identities SET phone_hash='operator-rebound' WHERE subject_id=?").run(key.subjectId);
      if (change === "expiry-extended") {
        const renewed = new Date(now.getTime() + 92 * 86400_000);
        f.store.updateAccessCredentialByPrefix(key.codexCredentialPrefix, {expiresAt: renewed});
        f.store.database.prepare("UPDATE unified_client_keys SET expires_at=? WHERE id=?").run(renewed.toISOString(), key.id);
      }
      if (change === "rate-changed") f.store.updateAccessCredentialByPrefix(key.codexCredentialPrefix,
        {rate: {requestsPerMinute: 50, requestsPerDay: 400, concurrentRequests: 8}});
      if (change === "scope-changed") f.store.updateAccessCredentialByPrefix(key.codexCredentialPrefix, {scope: "medical"});
      const beforeKey = f.store.listUnifiedClientKeys();
      const beforeCredentials = f.store.listAccessCredentials();
      const beforePhone = f.store.getPhoneAuthIdentityBySubjectId(key.subjectId);
      validation(f);
      const restart = Fastify({logger: false}); registerBillingAdminRoutes(restart, f.routeOptions);
      try {
        await restart.inject({method: "POST", url: `/gateway/admin/billing/v1/real-user-issue/${jobId}/resume`, headers});
        expect(await waitJob(restart, jobId)).toMatchObject({state: "retryable", requires_review: true, error: {code: "issue_recovery_requires_review"}});
        expect(f.store.listUnifiedClientKeys()).toEqual(beforeKey);
        expect(f.store.listAccessCredentials()).toEqual(beforeCredentials);
        expect(f.store.getPhoneAuthIdentityBySubjectId(key.subjectId)).toEqual(beforePhone);
        expect(f.disableUser).not.toHaveBeenCalled();
        await restart.inject({method: "POST", url: `/gateway/admin/billing/v1/real-user-issue/${jobId}/resume`, headers,
          payload: {acknowledge_review: true}});
        expect(await waitJob(restart, jobId)).toMatchObject({requires_review: true});
        expect(f.store.listAccessCredentials()).toEqual(beforeCredentials);
        expect(f.store.getPhoneAuthIdentityBySubjectId(key.subjectId)).toEqual(beforePhone);
        expect(f.disableUser).not.toHaveBeenCalled();
      } finally { await restart.close(); }
    }
  );

  it.each(["phone", "expiry"])("rechecks %s changes made while public validation is awaiting", async change => {
    const f = fixture(); validation(f);
    const fetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (...args: Parameters<typeof fetch>) => {
      const response = await fetch(...args);
      const key = f.store.listUnifiedClientKeys()[0]!;
      if (change === "phone") f.phoneAuth.setIdentityState(key.subjectId, "disabled", "mid-await-disable");
      else f.store.updateAccessCredentialByPrefix(key.codexCredentialPrefix, {expiresAt});
      return response;
    });
    const accepted = await f.app.inject({method: "POST", url: "/gateway/admin/billing/v1/real-user-issue", headers, payload});
    expect(await waitJob(f.app, accepted.json().job_id)).toMatchObject({requires_review: true, error: {code: "issue_recovery_requires_review"}});
    expect(f.disableUser).not.toHaveBeenCalled();
    const key = f.store.listUnifiedClientKeys()[0]!;
    if (change === "phone") expect(f.store.getPhoneAuthIdentityBySubjectId(key.subjectId)?.state).toBe("disabled");
    else expect(f.store.getAccessCredentialByPrefix(key.codexCredentialPrefix)?.expiresAt).toEqual(expiresAt);
  });

  it.each([401, 403, 409, 426, 429, 503])("classifies public HTTP %i without disabling the account or losing the error", async status => {
    const f = fixture();
    const code = status === 409 ? "account_migration_required" : status === 429 ? "rate_limited" : "issue_validation_failed";
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({error: {code, message: "private upstream details"}}), {status}));
    const accepted = await f.app.inject({method: "POST", url: "/gateway/admin/billing/v1/real-user-issue", headers, payload});
    const jobId = accepted.json().job_id;
    const failed = await waitJob(f.app, jobId);
    const review = status < 500 && status !== 429;
    expect(failed).toMatchObject({state: "retryable", requires_review: review, error: {code}});
    expect(failed.error.message).not.toContain("private upstream details");
    expect(f.disableUser).not.toHaveBeenCalled();
    expect(f.store.listSubjects()[0]?.state).toBe("active");
    if (review) expect((await f.app.inject({method: "POST", url: `/gateway/admin/billing/v1/real-user-issue/${jobId}/resume`, headers})).statusCode).toBe(409);
    // Operator reconciliation followed by explicit acknowledgement still uses
    // the original account/key/grant; the flag never bypasses the state fences.
    validation(f);
    expect((await f.app.inject({method: "POST", url: `/gateway/admin/billing/v1/real-user-issue/${jobId}/resume`, headers,
      payload: {acknowledge_review: review}})).statusCode).toBe(202);
    expect(await waitJob(f.app, jobId)).toMatchObject({state: "succeeded", requires_review: false});
    expect(f.createUser).toHaveBeenCalledTimes(1);
    expect(f.store.listEntitlements()).toHaveLength(1);
  });

  it("does not replace a later purchased entitlement when recovering an earlier task", async () => {
    const f = fixture();
    vi.stubGlobal("fetch", async () => { throw new Error("network interrupted"); });
    const response = await f.app.inject({method: "POST", url: "/gateway/admin/billing/v1/real-user-issue", headers, payload});
    const jobId = response.json().job_id;
    expect((await waitJob(f.app, jobId)).state).toBe("retryable");
    const subjectId = f.store.listSubjects()[0]!.id;
    const original = f.store.listEntitlements({subjectId})[0]!;
    f.store.cancelEntitlement({id: original.id, now});
    const purchased = f.pay(subjectId);
    await f.app.inject({method: "POST", url: `/gateway/admin/billing/v1/real-user-issue/${jobId}/resume`, headers});
    expect((await waitJob(f.app, jobId)).error.code).toBe("issue_recovery_requires_review");
    expect(f.store.getEntitlement(purchased.id)).toEqual(purchased);
    expect(f.disableUser).not.toHaveBeenCalled();
  });

  it("isolates env token owners and rejects unsupported provider before provisioning", async () => {
    const f = fixture(); validation(f);
    f.routeOptions.access!.nextToken = "billing-admin-next-test-secret-only";
    expect((await f.app.inject({method: "POST", url: "/gateway/admin/billing/v1/real-user-issue", headers,
      payload: {...payload, provider: "medevidence_billing_test"}})).statusCode).toBe(400);
    expect(f.createUser).not.toHaveBeenCalled();
    const accepted = await f.app.inject({method: "POST", url: "/gateway/admin/billing/v1/real-user-issue", headers, payload});
    const jobId = accepted.json().job_id;
    expect((await waitJob(f.app, jobId)).unified_key).toMatch(/^cgu_live_/);
    const nextHeaders = {authorization: `Bearer ${f.routeOptions.access!.nextToken}`};
    const read = await f.app.inject({url: `/gateway/admin/billing/v1/real-user-issue/${jobId}`, headers: nextHeaders});
    expect(read.json().unified_key).toBeUndefined();
    expect((await f.app.inject({method: "POST", url: `/gateway/admin/billing/v1/real-user-issue/${jobId}/resume`, headers: nextHeaders})).statusCode).toBe(404);
  });

  it("fences in-flight creation while reconciling an orphan and retains its reservation", async () => {
    const f = fixture();
    await f.resolve("orphan");
    const fault = vi.spyOn(f.store, "createBillingSubject").mockImplementationOnce(() => { throw new Error("local commit failed"); });
    await f.create("orphan");
    fault.mockRestore();
    const base = `/gateway/admin/billing/v1/subject-registrations/${provider}/orphan`;
    const registration = (await f.app.inject({url: base, headers})).json();
    expect(registration).toMatchObject({state: "creating", compensation_state: "none"});
    expect(registration.phone).toBeUndefined();
    expect(registration.phone_number).toBeUndefined();
    let release!: () => void, entered!: () => void;
    const remote = new Promise<void>(resolve => { release = resolve; });
    const began = new Promise<void>(resolve => { entered = resolve; });
    f.createUser.mockImplementationOnce(async () => {
      entered(); await remote;
      return {status: "idempotent_replay", user: {id: "v2_test"}, key: {id: "v2_key_test", key: "test-original-key"}};
    });
    const pending = f.create("orphan").then(result => result);
    await began;
    const confirmation = {idempotency_key: registration.idempotency_key, upstream_user_id: registration.upstream_user_id, upstream_key_id: registration.upstream_key_id};
    const call = () => f.app.inject({method: "POST", url: `${base}/retry-disable`, headers, payload: confirmation});
    f.disableUser.mockRejectedValueOnce(new Error("network interrupted"));
    try {
      expect((await call()).statusCode).toBe(503);
      expect(f.store.getExternalSubjectRegistration({provider, externalUserId: "orphan"})?.compensationState).toBe("pending");
      expect((await call()).json()).toMatchObject({disabled: true, phone_reservation_retained: true});
    } finally { release(); }
    expect((await pending).statusCode).toBe(409);
    expect(f.store.listSubjects()).toHaveLength(0);
    expect(f.store.listUnifiedClientKeys()).toHaveLength(0);
    expect(f.store.getExternalSubjectRegistration({provider, externalUserId: "orphan"})).toMatchObject({compensationState: "disabled", lastErrorCode: null});
    expect((await f.create("orphan")).json().error.code).toBe("account_disabled");
    expect(f.createUser).toHaveBeenCalledTimes(2);
    expect(f.store.listAdminAuditEvents({action: "disable-user"}).length).toBeGreaterThanOrEqual(2);
  });
});

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
    const session = f.phoneAuth.login({phone:"13800138000",deviceId:"linked-old-device",requestId:"linked-old-login"});
    expect(f.phoneAuth.bootstrap(session.response.access_token).response.unified_key.key).toBe(old.unified.token);
  });

  it("enrolls a legacy Billing subject atomically and preserves keys, entitlement snapshots and usage", async () => {
    const f = fixture();
    const created = await f.create("legacy-registered");
    expect(created.statusCode).toBe(200);
    const {subject,credential} = created.json();
    const grant = f.pay(subject.id);
    const beforeSubject = f.store.getSubject(subject.id)!;
    const keys = f.store.listUnifiedClientKeys({subjectId:subject.id});
    const credentials = f.store.listAccessCredentials({subjectId:subject.id});
    const limiter = new SqliteTokenBudgetLimiter({db:f.store.database});
    const reservation = await limiter.acquire({requestId:"legacy-used",credentialId:keys[0]!.codexCredentialId,
      subjectId:subject.id,entitlementId:grant.id,scope:"code",upstreamAccountId:null,provider:null,
      policy:grant.policySnapshot,estimatedPromptTokens:400,now});
    expect(reservation.ok).toBe(true);
    if (!reservation.ok) throw new Error("Reservation failed");
    await limiter.finalize({reservationId:reservation.reservationId,usage:{promptTokens:300,completionTokens:100,totalTokens:400},now});
    const usage = f.store.database.prepare("SELECT * FROM entitlement_token_windows ORDER BY window_kind,window_start").all();
    const response = await f.resolve("legacy-registered");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({status:"linked",subject:{id:subject.id}});
    expect(response.json().credential).toBeUndefined();
    expect(f.store.getSubject(subject.id)).toEqual({...beforeSubject,phoneNumber:"+8613800138000"});
    expect(f.store.listUnifiedClientKeys({subjectId:subject.id})).toEqual(keys);
    expect(f.store.listAccessCredentials({subjectId:subject.id})).toEqual(credentials);
    expect(f.store.listEntitlements({subjectId:subject.id})).toEqual([grant]);
    expect(f.store.database.prepare("SELECT * FROM entitlement_token_windows ORDER BY window_kind,window_start").all()).toEqual(usage);
    const identity = f.store.getPhoneAuthIdentityBySubjectId(subject.id)!;
    const audit = f.store.database.prepare("SELECT * FROM phone_auth_audit_events WHERE subject_id=? ORDER BY id").all(subject.id);
    expect(audit).toHaveLength(2);
    expect((await f.resolve("legacy-registered")).statusCode).toBe(200);
    expect(f.store.getPhoneAuthIdentityBySubjectId(subject.id)).toEqual(identity);
    expect(f.store.database.prepare("SELECT * FROM phone_auth_audit_events WHERE subject_id=? ORDER BY id").all(subject.id)).toEqual(audit);
    const session = f.phoneAuth.login({phone:"13800138000",deviceId:"legacy-recovered-device",requestId:"legacy-recovered-login"});
    expect(f.phoneAuth.bootstrap(session.response.access_token).response.unified_key.key).toBe(credential.key);
    expect(f.createUser).toHaveBeenCalledTimes(1);
  });

  it("enrolls through direct create's existing-subject 409 without issuing a replacement key", async () => {
    const f = fixture();
    const original = await f.create("legacy-direct");
    const {subject,credential} = original.json();
    f.pay(subject.id);
    const result = await f.create("legacy-direct","link:legacy-direct","13800138000");
    expect(result.statusCode).toBe(409);
    expect(result.json().error.code).toBe("subject_already_exists");
    const session = f.phoneAuth.login({phone:"13800138000",deviceId:"direct-device",requestId:"direct-login"});
    expect(f.phoneAuth.bootstrap(session.response.access_token).response.unified_key.key).toBe(credential.key);
    expect(f.store.listSubjects()).toHaveLength(1);
    expect(f.createUser).toHaveBeenCalledTimes(1);
    expect((await f.create("legacy-direct","signup:legacy-direct","13800138000")).json().error.code).toBe("idempotency_conflict");
  });

  it("does not grant free or paid access while enrolling an existing subject without an entitlement", async () => {
    const f = fixture();
    const original = await f.create("legacy-unpaid");
    const subjectId = original.json().subject.id;
    expect((await f.resolve("legacy-unpaid")).statusCode).toBe(200);
    expect(f.store.getPhoneAuthIdentityBySubjectId(subjectId)?.state).toBe("active");
    expect(f.store.listEntitlements({subjectId})).toEqual([]);
    expect(() => f.phoneAuth.login({phone:"13800138000",deviceId:"unpaid-device",requestId:"unpaid-login"})).toThrowError(
      expect.objectContaining({code:"capability_not_allowed"}));
  });

  it.each([
    ["expired key", "UPDATE unified_client_keys SET expires_at='2026-09-08T00:00:00.000Z'"],
    ["revoked key", "UPDATE unified_client_keys SET revoked_at='2026-09-08T00:00:00.000Z'"],
    ["no current key", "UPDATE unified_client_keys SET is_current=0"],
    ["non-Desktop key", "UPDATE unified_client_keys SET credential_class='unknown'"],
    ["unrecoverable key", "UPDATE unified_client_keys SET token_ciphertext=NULL"],
    ["corrupt recovery", "UPDATE unified_client_keys SET token_ciphertext='corrupt'"],
    ["corrupt upstream key", "UPDATE unified_client_keys SET medevidence_key_ciphertext='corrupt'"],
    ["revoked backing", "UPDATE access_credentials SET revoked_at='2026-09-08T00:00:00.000Z'"],
    ["expired backing", "UPDATE access_credentials SET expires_at='2026-09-08T00:00:00.000Z'"],
    ["non-Desktop backing", "UPDATE access_credentials SET credential_class='unknown'"],
    ["restricted models", "UPDATE access_credentials SET allowed_public_models_json='[\"goldencode-local\"]'"]
  ])("leaves the original subject untouched when enrollment finds %s", async (_name,sql) => {
    const f = fixture();
    const original = await f.create("legacy-invalid");
    const subjectId = original.json().subject.id;
    f.store.database.exec(sql);
    const before = f.store.getSubject(subjectId);
    const keys = f.store.listUnifiedClientKeys();
    const response = await f.resolve("legacy-invalid");
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("account_migration_required");
    expect(f.store.getSubject(subjectId)).toEqual(before);
    expect(f.store.getPhoneAuthIdentityBySubjectId(subjectId)).toBeNull();
    expect(f.store.listUnifiedClientKeys()).toEqual(keys);
    expect(f.store.database.prepare("SELECT COUNT(*) AS n FROM phone_auth_audit_events").get()).toEqual({n:0});
    expect(f.createUser).toHaveBeenCalledTimes(1);
  });

  it("rolls back the contact, identity and external association when the enrollment audit fails", async () => {
    const f = fixture();
    const old = f.seed();
    const before = f.store.getSubject(old.subject.id);
    f.store.database.exec("CREATE TRIGGER fail_enrollment_audit BEFORE INSERT ON phone_auth_audit_events BEGIN SELECT RAISE(ABORT,'audit unavailable'); END");
    expect((await f.resolve("legacy-audit-failure")).statusCode).toBe(503);
    expect(f.store.getSubject(old.subject.id)).toEqual(before);
    expect(f.store.getPhoneAuthIdentityBySubjectId(old.subject.id)).toBeNull();
    expect(f.store.getSubjectByExternalIdentity({provider,externalUserId:"legacy-audit-failure"})).toBeNull();
    expect(f.store.getExternalSubjectRegistrationState({provider,externalUserId:"legacy-audit-failure"})).toBeNull();
    expect(f.store.listUnifiedClientKeys()).toEqual([old.unified.record]);
    const created = await f.create("legacy-no-phone");
    const subjectId = created.json().subject.id;
    expect((await f.resolve("legacy-no-phone","13900139000")).statusCode).toBe(503);
    expect(f.store.getSubject(subjectId)?.phoneNumber).toBeNull();
    expect(f.store.getPhoneAuthIdentityBySubjectId(subjectId)).toBeNull();
  });

  it("does not revive a disabled phone identity or account", async () => {
    const f = fixture();
    const old = f.seed();
    await f.resolve("disabled-identity");
    f.phoneAuth.setIdentityState(old.subject.id,"disabled","disable-phone");
    const identity = f.store.getPhoneAuthIdentityBySubjectId(old.subject.id);
    expect((await f.resolve("disabled-identity")).json().error.code).toBe("phone_login_disabled");
    expect(f.store.getPhoneAuthIdentityBySubjectId(old.subject.id)).toEqual(identity);
    f.store.setSubjectState(old.subject.id,"disabled");
    expect((await f.resolve("disabled-identity")).json().error.code).toBe("account_disabled");
  });

  it("refuses to register a legacy subject with another subject's or pending signup's phone", async () => {
    const f = fixture();
    const original = await f.create("legacy-conflict");
    const subjectId = original.json().subject.id;
    f.seed("other-owner","13800138000");
    expect((await f.resolve("legacy-conflict")).json().error.code).toBe("identity_conflict");
    expect((await f.resolve("pending-owner","13900139000")).json().status).toBe("create_ready");
    expect((await f.resolve("legacy-conflict","13900139000")).json().error.code).toBe("identity_conflict");
    expect(f.store.getSubject(subjectId)?.phoneNumber).toBeNull();
    expect(f.store.getPhoneAuthIdentityBySubjectId(subjectId)).toBeNull();
  });

  it("refuses a phone already owned by an identity even if its Subject contact is missing", async () => {
    const f = fixture();
    const owner = f.seed();
    expect((await f.resolve("phone-owner")).statusCode).toBe(200);
    f.store.updateSubject(owner.subject.id,{phoneNumber:null});
    const original = await f.create("legacy-phone-collision");
    const subjectId = original.json().subject.id;
    const response = await f.resolve("legacy-phone-collision");
    // The external reservation also guards this phone; either guard must reject before changes.
    expect(response.statusCode).toBe(409);
    expect(f.store.getSubject(subjectId)?.phoneNumber).toBeNull();
    expect(f.store.getPhoneAuthIdentityBySubjectId(subjectId)).toBeNull();
    expect(f.store.getPhoneAuthIdentityByPhoneHash(f.phoneAuth.phoneHash("13800138000"))?.subjectId).toBe(owner.subject.id);
  });

  it("does not bind a second phone to a Subject whose identity survived loss of contact metadata", async () => {
    const f = fixture();
    const original = await f.create("legacy-changed-phone");
    const subjectId = original.json().subject.id;
    await f.resolve("legacy-changed-phone");
    f.store.updateSubject(subjectId,{phoneNumber:null});
    const identity = f.store.getPhoneAuthIdentityBySubjectId(subjectId);
    const response = await f.resolve("legacy-changed-phone","13900139000");
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("phone_identity_conflict");
    expect(f.store.getSubject(subjectId)?.phoneNumber).toBeNull();
    expect(f.store.getPhoneAuthIdentityBySubjectId(subjectId)).toEqual(identity);
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
      policySnapshot: { tokensPerDay: null, tokensPerMonth: null, tokensTotal: 1_000_000 }, state: "active" });
    const session = f.phoneAuth.login({ phone: "13800138000", deviceId: "sms-desktop-test-device", requestId: "login" });
    expect(f.phoneAuth.bootstrap(session.response.access_token).response.unified_key.key).toBe(credential.key);
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
    const {signal: firstSignal, ...firstRequest} = f.createUser.mock.calls[0]![0] as Record<string, unknown>;
    const {signal: retrySignal, ...retryRequest} = f.createUser.mock.calls[1]![0] as Record<string, unknown>;
    expect(firstRequest).toEqual(retryRequest);
    expect(firstSignal).toBeInstanceOf(AbortSignal);
    expect(retrySignal).toBeInstanceOf(AbortSignal);
  });

  it("does not re-enable a disabled identity or replace paid rights when signup is replayed", async () => {
    const f = fixture();
    await f.resolve("22");
    const subjectId = (await f.create("22")).json().subject.id;
    const paid = f.store.grantEntitlement({ subjectId, planId: "plan_test", periodKind: "unlimited", replace: true, now });
    f.phoneAuth.setIdentityState(subjectId, "disabled", "operator-disable");
    expect((await f.create("22")).json().idempotent_replay).toBe(true);
    expect((await f.resolve("22")).json().error.code).toBe("phone_login_disabled");
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
    expect(f.phoneAuth.bootstrap(session.response.access_token).response.unified_key.key).toBe(created.credential.key);
    expect(f.store.listEntitlements({ subjectId, state: "active" })[0]?.planId).toBe("plan_test");
  });

  it("enforces the one-off 1M allowance across retries, sessions and key rotation with no midnight reset", async () => {
    const f = fixture();
    await f.resolve("22");
    const subjectId = (await f.create("22")).json().subject.id;
    const entitlement = f.store.listEntitlements({ subjectId })[0]!;
    let key = f.store.listUnifiedClientKeys({ subjectId })[0]!;
    const limiter = new SqliteTokenBudgetLimiter({ db: f.store.database });
    const acquire = (requestId: string, at: Date, tokens: number) => limiter.acquire({
      requestId, credentialId: key.codexCredentialId, subjectId, entitlementId: entitlement.id,
      entitlementPeriodStart: entitlement.periodStart, entitlementPeriodEnd: entitlement.periodEnd,
      scope: "code", upstreamAccountId: null, provider: null, policy: entitlement.policySnapshot,
      estimatedPromptTokens: tokens, now: at
    });
    for (let i = 0; i < 4; i++) {
      const at = new Date(now.getTime() + i * 60_000);
      const result = await acquire(`use-${i}`, at, 250_000);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("unexpected budget rejection");
      await limiter.finalize({ reservationId: result.reservationId,
        usage: { promptTokens: 200_000, completionTokens: 50_000, totalTokens: 250_000 }, now: at });
    }
    expect((await f.create("22")).json().idempotent_replay).toBe(true);
    const session = f.phoneAuth.login({ phone: "13800138000", deviceId: "second-desktop-device", requestId: "relogin" });
    expect(session.response.subject.id).toBe(subjectId);
    const rotated = await f.app.inject({ method: "POST", url: `/gateway/admin/billing/v1/subjects/${subjectId}/keys`,
      headers: { authorization: `Bearer ${adminToken}`, "idempotency-key": "signup-budget-rotate" },
      payload: { revoke_previous: true, grace_period_seconds: 0 } });
    expect(rotated.statusCode).toBe(200);
    key = f.store.listUnifiedClientKeys({ subjectId }).find(item => item.isCurrent)!;
    // The one-off allowance is spent: no retry hint and no midnight recovery.
    const exhausted = await acquire("exhausted", new Date("2026-09-09T23:59:59Z"), 1);
    expect(exhausted.ok).toBe(false);
    if (!exhausted.ok) {
      expect(exhausted.limitKind).toBe("token_total");
      expect(exhausted.error.code).toBe("free_quota_exhausted");
      expect(exhausted.error.retryAfterSeconds).toBeUndefined();
    }
    const nextDay = await acquire("next-day", new Date("2026-09-10T00:00:00Z"), 1);
    expect(nextDay.ok).toBe(false);
    if (!nextDay.ok) expect(nextDay.error.code).toBe("free_quota_exhausted");
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
    expect(grants[0]).toMatchObject({ planId: phoneSignupFreePlanId, policySnapshot: { tokensTotal: 1_000_000, tokensPerDay: null }, state: "active" });
    const session = f.phoneAuth.login({ phone: "13800138000", deviceId: "direct-phone-test-device", requestId: "login-direct" });
    expect(f.phoneAuth.bootstrap(session.response.access_token).response.unified_key.key).toBe(credential.key);
    const replay = (await f.create("22", "direct:22", "13800138000")).json();
    expect(replay.idempotent_replay).toBe(true);
    expect(replay.credential.key).toBeUndefined();
    expect(f.store.listEntitlements({ subjectId: subject.id })).toEqual(grants);
    expect((await f.create("22", "direct:22", "13900139000")).json().error.code).toBe("idempotency_conflict");
    expect(f.createUser).toHaveBeenCalledTimes(1);
  });

  it("grants new users the one-off 1M allowance while retaining the old daily plan, entitlement, key and usage on linking", async () => {
    const f = fixture();
    const template = phoneSignupFreePlan(now);
    const oldPlan = f.store.createPlan({ ...template, id: "plan_free_daily_1m_v1",
      displayName: "Free · 1,000,000 tokens/day", policy: { ...template.policy, tokensPerDay: 1_000_000, tokensTotal: null } });
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
      planId: phoneSignupFreePlanId, policySnapshot: { tokensTotal: 1_000_000, tokensPerDay: null } });
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
    expect(f.store.getExternalSubjectRegistration({ provider, externalUserId: "22" })).toMatchObject({
      state: "creating",
      upstreamUserId: null,
      upstreamKeyId: null,
      lastErrorCode: "upstream_create_failed",
      lastErrorAt: now
    });
    expect((await f.create("22", "different-event", "13800138000")).json().error.code).toBe("account_pending");
    expect((await f.create("22", "direct:22")).json().error.code).toBe("idempotency_conflict");
    expect((await f.create("22", "direct:22", "13800138000")).statusCode).toBe(200);
    expect(f.store.listSubjects()).toHaveLength(1);
    expect(f.store.listEntitlements()).toHaveLength(1);
    expect(f.store.getExternalSubjectRegistration({ provider, externalUserId: "22" })).toMatchObject({
      state: "linked",
      upstreamUserId: "v2_test",
      upstreamKeyId: "v2_key_test",
      lastErrorCode: null,
      lastErrorAt: null
    });
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

  it("rejects another phone while preserving the stable external association", async () => {
    const f = fixture();
    f.seed("subj_one");
    f.seed("subj_two", "13900139000");
    await f.resolve("21");
    expect((await f.resolve("21", "13900139000")).json().error.code).toBe("identity_conflict");
    expect(f.store.getSubjectByExternalIdentity({ provider, externalUserId:"21" })?.id).toBe("subj_one");
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
    expect(f.store.getExternalSubjectRegistration({ provider, externalUserId: "22" })).toMatchObject({
      state: "creating",
      upstreamUserId: "v2_test",
      upstreamKeyId: "v2_key_test",
      lastErrorCode: "identity_conflict",
      lastErrorAt: now
    });
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
    const bodies = responses.map(response => response.json());
    expect(responses.map(response => response.statusCode)).toEqual([200, 200]);
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
    f.store.preparePhoneAuthIdentity({ phoneHash: f.phoneAuth.phoneHash("13800138000"), phoneCiphertext: "test-encrypted-phone", subjectId: old.subject.id,
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
    expect(f.store.getPhoneAuthIdentityByPhoneHash(f.phoneAuth.phoneHash("13800138000"))?.unifiedKeyId).toBe(rotated.json().credential.id);
    expect(f.store.getUnifiedClientKeyByPrefix(old.unified.record.prefix)).toMatchObject({ isCurrent: false, revokedAt: null, expiresAt: new Date(now.getTime() + 60_000) });
    expect((await f.app.inject(request)).json().credential.key).toBeUndefined();
  });
});
