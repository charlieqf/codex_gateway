import Fastify from "fastify";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewayError } from "@codex-gateway/core";
import { createSqliteStore } from "@codex-gateway/store-sqlite";
import { registerBillingAdminRoutes } from "./billing-admin.js";
import { registerPhoneAuthRoutes } from "./phone-auth-routes.js";
import { PhoneAuthService, phoneAuthGatewayOrigin } from "./services/phone-auth-service.js";
import { InMemoryRequestRateLimiter } from "./services/rate-limiter.js";
import { installIdentityRequestAudit, captureIdentityInput } from "./http/identity-request-audit.js";
import { markGatewayError } from "./http/observation.js";
import { buildGateway } from "./index.js";

const admin = { authorization: "Bearer audit-test-admin-only" };
const version = { "x-medevidence-client-version": "2.0.0-beta.76" };
const phone = "13800138000";
const device = "audit-device-example-01";
const base = "/gateway/admin/billing/v1";
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); vi.restoreAllMocks(); });
function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function fixture(limits: { phone?: number; ip?: number; device?: number } = {}) {
  let clock = new Date("2026-09-18T00:00:00.000Z");
  const now = () => clock;
  const store = createSqliteStore({ path: ":memory:" });
  const logs: Array<Record<string, unknown>> = [];
  const app = Fastify({ logger: { level: "error", stream: { write: (line: string) => { logs.push(JSON.parse(line)); } } },
    genReqId: () => `req-${randomUUID()}` });
  cleanup.push(async () => { await app.close(); store.close(); });
  const audit = installIdentityRequestAudit(app, store, now);
  app.addHook("onRequest", async (request, reply) => { reply.header("x-request-id", request.id); });
  const { privateKey } = generateKeyPairSync("ed25519");
  const service = new PhoneAuthService({ mode: "transition", store, credentialStore: store,
    unifiedKeyStore: store, entitlementStore: store, publicGatewayBaseUrl: phoneAuthGatewayOrigin,
    issuer: `${phoneAuthGatewayOrigin}/gateway/auth/v1`, audience: "codex-gateway", activeKid: "audit-test",
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    phoneLookupSecret: "audit-phone-lookup-integration-test-secret", phoneEncryptionSecret: "audit-phone-encryption-integration-test-secret",
    unifiedKeyRecoverySecret: "audit-recovery-integration-test-secret", apiKeyEncryptionSecret: "audit-api-integration-test-secret", now });
  const createUser = vi.fn(async () => ({ status: "created" as const, user: { id: `test-v2-${randomUUID()}` },
    key: { id: `test-key-${randomUUID()}`, key: "audit-test-upstream-secret", keyPrefix: "test-upstream" } }));
  registerBillingAdminRoutes(app, { access: { token: "audit-test-admin-only", nextToken: null }, tokenMode: "env",
    billingStore: store, credentialStore: store, planEntitlementStore: store, adminAuditStore: store,
    subjectMetadataStore: store, externalIdentityStore: store, externalIdentityProvider: "audit_test",
    publicBaseUrl: phoneAuthGatewayOrigin, phoneAuthService: service,
    unifiedKeyRecoverySecret: "audit-recovery-integration-test-secret", apiKeyEncryptionSecret: "audit-api-integration-test-secret",
    upstreamV2Client: { createUser, disableUser: async () => ({ disabled: true, user: { id: "test" } }),
      revokeKey: async () => ({ revoked: true, key: { id: "test" } }) }, now });
  registerPhoneAuthRoutes(app, { service, loginRateLimiter: new InMemoryRequestRateLimiter({ now }),
    phoneRequestsPerMinute: limits.phone ?? 100, ipRequestsPerMinute: limits.ip ?? 100,
    deviceRequestsPerMinute: limits.device ?? 100,
    versionGate: { mode: "auth_only", minimumVersion: "2.0.0-beta.76", downloadUrl: "https://example.test/download/" } });
  const create = (id = "audit-user", suppliedPhone = phone, event = id) => app.inject({ method: "POST", url: `${base}/subjects`,
    headers: { ...admin, "idempotency-key": `audit:${event}` },
    payload: { provider: "audit_test", external_user_id: id, phone: suppliedPhone, scope_allowlist: ["code"] } });
  const login = (suppliedPhone = phone, deviceId = device, remoteAddress = "127.0.0.1") => app.inject({ method: "POST",
    url: "/gateway/auth/v1/login/start", headers: version, remoteAddress,
    payload: { phone: suppliedPhone, device_id: deviceId, client: "medevidence-desktop", contract_version: 1 } });
  const events = () => store.database.prepare("SELECT * FROM identity_request_events ORDER BY rowid").all();
  const minutes = () => store.database.prepare("SELECT * FROM identity_rate_limit_minutes ORDER BY minute_start").all();
  return { app, audit, store, service, createUser, create, login, events, minutes, logs, advance: (ms: number) => { clock = new Date(clock.getTime() + ms); } };
}

describe("identity request audit integration", () => {
  it("attributes an existing-account 409 without changing its public contract", async () => {
    const f = fixture();
    const created = await f.create();
    expect(created.statusCode).toBe(200);
    const repeated = await f.create("audit-user", phone, "second-create");
    expect(repeated.statusCode).toBe(409);
    expect(repeated.json().error.code).toBe("subject_already_exists");
    expect(Object.keys(repeated.json().error).sort()).toEqual(["code", "message", "request_id"]);
    expect(f.events()).toHaveLength(2);
    expect(f.events()[1]).toMatchObject({ request_id: repeated.json().error.request_id, phone_input: phone,
      phone_normalized: `+86${phone}`, provider: "audit_test", external_user_id: "audit-user",
      subject_id: created.json().subject.id, outcome: "rejected", reason_code: "existing_subject", http_status: 409 });
    expect(f.createUser).toHaveBeenCalledTimes(1);
  });

  it("records an identity conflict after rollback rather than guessing from HTTP 409", async () => {
    const f = fixture();
    for (const id of ["audit-owner-a", "audit-owner-b"]) f.store.upsertSubject({ id, label: id,
      phoneNumber: `+86${phone}`, state: "active", createdAt: new Date() });
    const failed = await f.create();
    expect(failed.statusCode).toBe(409);
    expect(f.events()[0]).toMatchObject({ error_code: "identity_conflict", reason_code: "phone_multiple_subjects",
      phone_input: phone, subject_id: null, conflicting_subject_id: null });
    expect(f.store.getExternalSubjectRegistration({ provider: "audit_test", externalUserId: "audit-user" })).toBeNull();
    expect(f.createUser).not.toHaveBeenCalled();
  });

  it.each([
    ["reserved", "phone_reserved_by_other_identity"],
    ["registration-phone", "registration_phone_mismatch"],
    ["linked-phone", "linked_subject_phone_mismatch"],
    ["external-binding", "external_identity_binding_conflict"]
  ] as const)("records the exact %s conflict without exposing private facts", async (scenario, reason) => {
    const f = fixture();
    if (scenario === "reserved" || scenario === "registration-phone") {
      f.store.resolveExternalSubject({ provider: "audit_test", externalUserId: scenario === "reserved" ? "another-registration" : "audit-user",
        phone, requestId: "fixture-registration", now: new Date("2026-09-18T00:00:00Z") });
    } else expect((await f.create()).statusCode).toBe(200);
    const response = await f.create(scenario === "external-binding" ? "another-identity" : "audit-user",
      scenario === "registration-phone" || scenario === "linked-phone" ? "13900139000" : phone, "conflicting-request");
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("identity_conflict");
    expect(f.events().at(-1)).toMatchObject({ request_id: response.json().error.request_id,
      error_code: "identity_conflict", reason_code: reason, outcome: "rejected" });
    expect(response.body).not.toContain(reason);
    expect(response.body).not.toContain(phone);
  });

  it("covers phone lifecycle without persisting any returned credential", async () => {
    const f = fixture();
    expect((await f.create()).statusCode).toBe(200);
    const loggedIn = await f.login();
    expect(loggedIn.statusCode).toBe(200);
    const token = loggedIn.json().access_token;
    const headers = { ...version, authorization: `Bearer ${token}` };
    const boot = await f.app.inject({ method: "POST", url: "/gateway/auth/v1/session/bootstrap", headers, payload: {} });
    expect(boot.statusCode).toBe(200);
    expect((await f.app.inject({ url: "/gateway/account/v1/current", headers })).statusCode).toBe(200);
    const refresh = await f.app.inject({ method: "POST", url: "/gateway/auth/v1/token/refresh", headers: version,
      payload: { refresh_token: loggedIn.json().refresh_token, device_id: device, client: "medevidence-desktop", contract_version: 1 } });
    expect(refresh.statusCode).toBe(200);
    expect((await f.app.inject({ method: "POST", url: "/gateway/auth/v1/logout", headers, payload: {} })).statusCode).toBe(204);
    expect(f.events().map(event => event.operation)).toEqual(["subject_create", "phone_login", "phone_bootstrap", "phone_account", "phone_refresh", "phone_logout"]);
    expect(f.events().slice(1).every(event => typeof event.session_id === "string")).toBe(true);
    expect(f.events().slice(1, 5).every(event => event.resolved_phone === `+86${phone}`)).toBe(true);
    const serialized = JSON.stringify(f.events());
    for (const secret of [token, loggedIn.json().refresh_token, boot.json().unified_key.key, "audit-test-upstream-secret", device]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("distinguishes 202 acceptance from background issuance completion", async () => {
    const f = fixture();
    f.app.post("/test-accepted", { config: { identityAuditOperation: "issuance_create" } }, async (_request, reply) => reply.code(202).send({ accepted: true }));
    expect((await f.app.inject({ method: "POST", url: "/test-accepted" })).statusCode).toBe(202);
    expect(f.events()[0]).toMatchObject({ outcome: "accepted", http_status: 202 });
  });

  it("does not inspect unauthenticated Billing input or fabricate phone for early errors", async () => {
    const f = fixture();
    expect((await f.app.inject({ method: "POST", url: `${base}/subjects`, payload: { phone } })).statusCode).toBe(401);
    expect(f.events()[0]).toMatchObject({ phone_input: null, phone_capture_status: "not_available", error_code: "missing_credential" });
    expect((await f.app.inject({ method: "POST", url: "/gateway/auth/v1/login/start", payload: { phone } })).statusCode).toBe(426);
    expect(f.events()[1]).toMatchObject({ http_status: 426, error_code: "client_upgrade_required", phone_capture_status: "not_available" });
    expect((await f.app.inject({ method: "POST", url: "/gateway/auth/v1/login/start", headers: { ...version, "content-type": "application/json" }, payload: "{" })).statusCode).toBe(400);
    expect(f.events()[2]).toMatchObject({ http_status: 400, error_code: "invalid_request", phone_input: null });
  });

  it.each(["phone", "ip", "device"] as const)("aggregates %s limits with bounded samples and accurate public code", async dimension => {
    const f = fixture({ [dimension]: 1 });
    expect((await f.login()).statusCode).toBe(403);
    for (let i = 0; i < 10; i++) {
      const response = await f.login(dimension === "phone" ? phone : "13900139000",
        dimension === "device" ? device : `${device}-${i}`);
      expect(response.statusCode).toBe(429);
      expect(response.json().error.code).toBe("auth_rate_limited");
      expect(response.headers["retry-after"]).toBe("60");
    }
    expect(f.events()).toHaveLength(1);
    expect(f.minutes()).toHaveLength(1);
    expect(f.minutes()[0]).toMatchObject({ rejection_count: 10, limit_dimension: dimension, error_code: "auth_rate_limited" });
    f.advance(60_000);
    expect((await f.login()).statusCode).toBe(403);
    expect((await f.login()).statusCode).toBe(429);
    expect(f.minutes()).toHaveLength(2);
  });

  it("keeps business responses and emits bounded safe alerts when request audit writes fail", async () => {
    const f = fixture();
    const log = vi.spyOn(f.app.log, "error");
    const recovery = vi.spyOn(f.app.log, "warn");
    const writer = vi.spyOn(f.store, "recordIdentityRequestEvent").mockImplementation(() => { throw new Error(`do not print ${phone}`); });
    expect((await f.create()).statusCode).toBe(200);
    expect((await f.login()).statusCode).toBe(200);
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(log.mock.calls)).not.toContain(phone);
    writer.mockRestore();
    expect((await f.login()).statusCode).toBe(200);
    expect(recovery).toHaveBeenCalledWith(expect.objectContaining({ event: "identity_request_audit_recovered", lost_requests: 2 }), expect.any(String));
  });

  it("terminates once across disconnect and response hooks without claiming a 499 response", async () => {
    const f = fixture();
    f.app.post("/test-aborted", { config: { identityAuditOperation: "subject_create" } }, async request => {
      captureIdentityInput(request);
      f.audit.complete(request, null);
      f.audit.complete(request, 200);
      return { ok: true };
    });
    await f.app.inject({ method: "POST", url: "/test-aborted", payload: { phone } });
    expect(f.events()).toHaveLength(1);
    expect(f.events()[0]).toMatchObject({ outcome: "aborted", http_status: null, transport_outcome: "aborted" });
  });

  it("keeps 429 and retry headers when the minute writer fails", async () => {
    const f = fixture({ phone: 1 });
    expect((await f.login()).statusCode).toBe(403);
    vi.spyOn(f.store, "recordIdentityRateLimit").mockImplementation(() => { throw new Error(`private ${phone}`); });
    for (let i = 0; i < 3; i++) {
      const response = await f.login();
      expect(response.statusCode).toBe(429);
      expect(response.json().error.code).toBe("auth_rate_limited");
      expect(response.headers["retry-after"]).toBe("60");
    }
    expect(f.logs.filter(row => row.event === "identity_request_audit_write_failed")).toHaveLength(1);
    expect(JSON.stringify(f.logs)).not.toContain(phone);
    expect(f.events()).toHaveLength(1);
  });

  it("uses the real Gateway disconnect callback for an actual closed HTTP socket", async () => {
    const store = createSqliteStore({ path: ":memory:" });
    const app = buildGateway({ authMode: "dev", accessToken: "audit-test-only", logger: false, sessionStore: store,
      provider: { kind: "audit-test", health: async () => ({ state: "healthy", checkedAt: new Date() }),
        async *message() { yield { type: "completed", providerSessionRef: "audit-test" }; } } });
    cleanup.push(async () => { await app.close(); });
    const entered = signal();
    const release = signal();
    const finished = signal();
    app.post("/audit-test-disconnect", { config: { public: true, identityAuditOperation: "subject_create" } }, async request => {
      captureIdentityInput(request);
      entered.resolve();
      await release.promise;
      finished.resolve();
      return { ok: true };
    });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const client = httpRequest(`${address}/audit-test-disconnect`, { method: "POST", headers: { "content-type": "application/json" } });
    client.on("error", () => {});
    client.end(JSON.stringify({ phone }));
    try {
      await entered.promise;
      client.destroy();
      await vi.waitFor(() => expect(store.database.prepare("SELECT count(*) AS n FROM identity_request_events").get()).toEqual({ n: 1 }));
      release.resolve();
      await finished.promise;
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(store.database.prepare("SELECT http_status,transport_outcome,outcome,phone_input FROM identity_request_events").all())
        .toEqual([{ http_status: null, transport_outcome: "aborted", outcome: "aborted", phone_input: phone }]);
    } finally {
      release.resolve();
      client.destroy();
    }
  });

  it("preserves 5xx operational logging independently of request storage", async () => {
    const f = fixture();
    vi.spyOn(f.service, "login").mockImplementation(() => { throw new Error("private backend exception"); });
    const failed = await f.login();
    expect(failed.statusCode).toBe(503);
    expect(f.events()[0]).toMatchObject({ outcome: "failed", error_code: "service_unavailable" });
    expect(f.logs).toEqual([expect.objectContaining({ level: 50, msg: "Phone auth request failed." })]);
    expect(failed.json().error.message).not.toContain("private backend exception");
  });

  it("ignores non-identity routes and does not serialize arbitrary error properties", async () => {
    const f = fixture();
    f.app.get("/ordinary", async () => ({ phone }));
    f.app.get("/identity-error", { config: { identityAuditOperation: "subject_get" } }, async (request, reply) => {
      const error = new GatewayError({ code: "identity_conflict", message: "private message", httpStatus: 409,
        identityFailure: { reasonCode: "phone_reserved_by_other_identity", resolvedPhone: `+86${phone}` } });
      expect(JSON.stringify(error)).not.toContain(phone);
      expect(Object.keys(error)).not.toContain("identityFailure");
      markGatewayError(request, error);
      return reply.code(409).send({ error: { code: error.code } });
    });
    await f.app.inject({ url: "/ordinary" });
    await f.app.inject({ url: "/identity-error" });
    expect(f.events()).toHaveLength(1);
    expect(f.events()[0]).toMatchObject({ reason_code: "phone_reserved_by_other_identity" });
    expect(JSON.stringify(f.events())).not.toContain("private message");
  });

  it("records a failed refresh even after successful rotation and preserves transactional revocation", async () => {
    const f = fixture();
    const created = await f.create();
    const login = await f.login();
    f.store.setSubjectState(created.json().subject.id, "disabled");
    const failed = await f.app.inject({ method: "POST", url: "/gateway/auth/v1/token/refresh", headers: version,
      payload: { refresh_token: login.json().refresh_token, device_id: device, client: "medevidence-desktop", contract_version: 1 } });
    expect(failed.statusCode).toBe(403);
    const requestId = String(failed.headers["x-request-id"]);
    expect(f.events().at(-1)).toMatchObject({ request_id: requestId, subject_id: created.json().subject.id,
      operation: "phone_refresh", outcome: "rejected", error_code: "account_disabled" });
    expect(f.store.database.prepare("SELECT outcome,reason_code FROM phone_auth_audit_events WHERE request_id=? ORDER BY rowid").all(requestId))
      .toEqual([{ outcome: "ok", reason_code: null }, { outcome: "error", reason_code: "account_not_ready" }]);
    expect(f.store.database.prepare("SELECT state FROM phone_auth_sessions").all()).toEqual([{ state: "revoked" }]);
  });

  it("keeps malformed-phone capture bounded and does not store secrets supplied in a phone field", async () => {
    const f = fixture();
    for (const value of [123, '1'.repeat(100), 'Bearer forbidden', '13800138000\n']) {
      const response = await f.app.inject({ method: "POST", url: "/gateway/auth/v1/login/start", headers: version,
        payload: { phone: value, device_id: device, client: "medevidence-desktop", contract_version: 1 } });
      expect(response.statusCode).toBe(400);
    }
    expect(f.events().every(row => row.phone_input === null && row.phone_normalized === null)).toBe(true);
    expect(f.events().map(row => row.phone_capture_status)).toEqual(['invalid_type','unsafe_value','unsafe_value','unsafe_value']);
  });

  it("rolls back transactional enrollment audit failure but retains the final HTTP failure", async () => {
    const f = fixture();
    const created = await f.create();
    const subjectId = created.json().subject.id;
    f.store.database.exec("DELETE FROM phone_auth_identities");
    f.store.updateSubject(subjectId, { phoneNumber: null });
    const before = f.store.database.prepare("SELECT * FROM external_subject_registrations").all();
    f.store.database.exec("CREATE TRIGGER fail_test_security_audit BEFORE INSERT ON phone_auth_audit_events BEGIN SELECT RAISE(ABORT,'test security audit failure'); END;");
    const failed = await f.create("audit-user", phone, "enrollment-retry");
    expect(failed.statusCode).toBe(503);
    expect(f.store.getSubject(subjectId)?.phoneNumber).toBeNull();
    expect(f.store.database.prepare("SELECT * FROM phone_auth_identities").all()).toEqual([]);
    expect(f.store.database.prepare("SELECT * FROM external_subject_registrations").all()).toEqual(before);
    expect(f.events().at(-1)).toMatchObject({ outcome: "failed", phone_input: phone, error_code: "service_unavailable", http_status: 503 });
  });
});
