// Run inside the Gateway container after a backed-up, authorized release.
// Synthetic phone/account only; no provider calls or bootstrap request.
import assert from "node:assert/strict";
import { randomInt, randomUUID } from "node:crypto";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { encryptSecret, issueAccessCredential, issueUnifiedClientKey, validateFeaturePolicy } from "@codex-gateway/core";
import { createSqliteStore } from "@codex-gateway/store-sqlite";
import { PhoneAuthService, resolvePhoneAuthServiceOptions, phoneAuthGatewayOrigin, phoneAuthMedevidenceOrigin } from "../../apps/gateway/dist/services/phone-auth-service.js";

const origin = phoneAuthGatewayOrigin;
const store = createSqliteStore({ path: process.env.GATEWAY_SQLITE_PATH });
const service = new PhoneAuthService(resolvePhoneAuthServiceOptions(process.env, { store, credentialStore: store, unifiedKeyStore: store, entitlementStore: store }));
const eventsPath = process.env.GATEWAY_CLIENT_EVENTS_SQLITE_PATH || join(dirname(process.env.GATEWAY_SQLITE_PATH), "client-events.db");
const events = new DatabaseSync(eventsPath);
const run = randomUUID(), subject = "subj_support_smoke_" + run, plan = "plan_support_smoke_" + run;
const result = { run, at: new Date().toISOString(), checks: [] };
const reportIds = [];
let backing, unified, access, entitlement, failed;
const adminToken = process.env.GATEWAY_ADMIN_MESSAGES_TOKEN;
assert(adminToken, "Admin token is not configured");
async function request(label, path, body, token, expected) {
  const response = await fetch(origin + path, { method: body === undefined ? "GET" : "POST", redirect: "error",
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }), signal: AbortSignal.timeout(15_000) });
  const json = await response.json();
  result.checks.push({ label, http: response.status, request_id: response.headers.get("x-request-id") });
  assert.equal(response.status, expected, `${label}: unexpected status`);
  return json;
}
function body(kind, account) {
  const report_id = randomUUID(); reportIds.push(report_id);
  return { schema_version: 1, report_id, failure_id: run, kind, occurred_at: new Date().toISOString(),
    app_name: "goldencode", app_version: "2.0.0-beta.152", platform: "win32", process: "main", operation: "bootstrap",
    error_code: "request_timeout", final_state: "failed", network_type: "unknown",
    ...(account ? { account_subject_id: account } : {}), ...(kind === "manual" ? { diagnostics: [] } : {}) };
}
try {
  const now = new Date(), expiresAt = new Date(Date.now() + 3_600_000);
  let phone;
  for (let attempt = 0; attempt < 20; attempt++) {
    const candidate = "+86199000" + String(randomInt(10000, 99999));
    if (!store.listSubjects({ includeArchived: true }).some(item => item.phoneNumber === candidate) &&
        !store.getPhoneAuthIdentityByPhoneHash(service.phoneHash(candidate))) { phone = candidate; break; }
  }
  assert(phone, "No unused synthetic phone available");
  store.upsertSubject({ id: subject, label: "Support reporting release smoke", state: "active", createdAt: now, phoneNumber: phone });
  store.createPlan({ id: plan, displayName: "Synthetic support reporting smoke", scopeAllowlist: ["code"], now,
    policy: { tokensPerMinute: null, tokensPerDay: 1000, tokensPerMonth: null, tokensTotal: null, maxPromptTokensPerRequest: 1024,
      maxTotalTokensPerRequest: 1024, reserveTokensPerRequest: 0, missingUsageCharge: "none" },
    featurePolicy: validateFeaturePolicy({ capabilities: ["chat", "tools"], medcode_models: { allowed: ["goldencode", "goldencode-d", "goldencode-local"] } }) });
  entitlement = store.grantEntitlement({ subjectId: subject, planId: plan, periodKind: "unlimited", now });
  backing = issueAccessCredential({ subjectId: subject, label: "Support smoke", scope: "code", credentialClass: "desktop", expiresAt, now,
    allowedPublicModels: ["goldencode", "goldencode-d", "goldencode-local"], knownPublicModelIds: ["goldencode", "goldencode-d", "goldencode-local"] });
  store.insertAccessCredential(backing.record);
  const secret = process.env.GATEWAY_API_KEY_ENCRYPTION_SECRET;
  unified = issueUnifiedClientKey({ subjectId: subject, label: "Support smoke", expiresAt, now,
    codexCredentialId: backing.record.id, codexCredentialPrefix: backing.record.prefix, codexKeyCiphertext: encryptSecret(backing.token, secret),
    medevidenceKeyCiphertext: encryptSecret("synthetic-unused-runtime-key", secret), medevidenceKeyPrefix: "synthetic-unused",
    metadata: { medevidence_base_url: phoneAuthMedevidenceOrigin } });
  store.insertUnifiedClientKey(unified.record);
  service.prepareIdentity({ phone, subjectId: subject, unifiedKey: unified.token, requestId: "req-support-prepare-" + run });
  access = service.login({ phone, deviceId: "support-smoke-" + run, requestId: "req-support-login-" + run }).response.access_token;

  const automatic = body("automatic");
  const created = await request("anonymous summary", "/gateway/client-events/support", automatic, undefined, 201);
  assert.equal(created.stored, true); assert.equal(created.report_id, automatic.report_id);
  const duplicate = await request("lost ACK replay", "/gateway/client-events/support", automatic, undefined, 200);
  assert.equal(duplicate.received_at, created.received_at);
  await request("ID conflict", "/gateway/client-events/support", { ...automatic, final_state: "unknown" }, undefined, 409);
  await request("invalid credentials", "/gateway/client-events/support", body("automatic"), "invalid-support-smoke", 401);
  await request("private fields rejected", "/gateway/client-events/support", { ...body("automatic"), prompt: "synthetic private text" }, undefined, 400);
  const manual = body("manual", subject);
  manual.diagnostics.push({ occurred_at: manual.occurred_at, account_subject_id: subject, process: "main", operation_id: randomUUID(), event: "error",
    operation: "bootstrap", method: "POST", path: "/gateway/auth/v1/session/bootstrap", transport: { phase: "before_socket", error_codes: ["UND_ERR_CONNECT_TIMEOUT"] } });
  await request("phone access before bootstrap", "/gateway/client-events/support", manual, access, 201);
  await request("verified then anonymous replay", "/gateway/client-events/support", manual, undefined, 200);
  assert.equal(events.prepare("SELECT subject_id FROM client_support_reports WHERE report_id=?").get(manual.report_id).subject_id, subject);
  const found = await request("admin phone search", "/gateway/admin/client-support/query", { phone }, adminToken, 200);
  assert.equal(found.reports.length, 1); assert.equal(found.reports[0].report_id, manual.report_id);
  const detail = await request("admin correlation", "/gateway/admin/client-support/query", { report_id: manual.report_id }, adminToken, 200);
  assert.equal(detail.reports[0].correlation.status, "unlinked");
  const download = await request("download diagnostics", `/gateway/admin/client-support/${manual.report_id}/diagnostics`, undefined, adminToken, 200);
  assert.deepEqual(download, manual);
  await request("anonymous read denied", "/gateway/admin/client-support/query", {}, undefined, 401);
  await request("anonymous download denied", `/gateway/admin/client-support/${manual.report_id}/diagnostics`, undefined, undefined, 401);
  service.logout(access, "req-support-logout-" + run);
  await request("revoked access denied", "/gateway/client-events/support", manual, access, 401);
  await request("anonymous retry after logout", "/gateway/client-events/support", manual, undefined, 200);
  await request("automatic byte limit", "/gateway/client-events/support", JSON.stringify(body("automatic")) + " ".repeat(16 * 1024), undefined, 413);
  assert.equal(store.listRequestEvents({ subjectId: subject }).length, 0);
  assert.equal(store.database.prepare("SELECT COUNT(*) n FROM token_reservations WHERE subject_id=?").get(subject).n, 0);
  result.model_requests = 0;
} catch (error) {
  failed = { name: error.name, message: error.message?.slice(0, 200) };
} finally {
  if (access) service.logout(access, "req-support-cleanup-" + run);
  service.setIdentityState(subject, "disabled", "req-support-cleanup-" + run);
  if (unified) store.revokeUnifiedClientKeyByPrefix(unified.record.prefix);
  if (backing) store.revokeAccessCredentialByPrefix(backing.record.prefix);
  if (entitlement) store.cancelEntitlement(entitlement.id, "Support smoke cleanup");
  if (store.getPlan(plan)) store.deprecatePlan(plan);
  if (store.getSubject(subject)) store.setSubjectState(subject, "disabled");
  for (const id of reportIds) {
    const row = events.prepare("SELECT content_hash FROM client_support_reports WHERE report_id=?").get(id);
    if (row) {
      const file = join(dirname(eventsPath), "client-support", `${id}-${row.content_hash}.json`);
      if (existsSync(file)) unlinkSync(file);
      events.prepare("DELETE FROM client_support_reports WHERE report_id=?").run(id);
    }
  }
  result.cleanup = { subject_disabled: store.getSubject(subject)?.state === "disabled",
    active_credentials: store.listAccessCredentials({ subjectId: subject }).filter(item => !item.revokedAt).length,
    remaining_reports: events.prepare("SELECT COUNT(*) n FROM client_support_reports WHERE failure_id=?").get(run).n };
  events.close(); store.close();
}
result.status = failed ? "failed" : "passed";
if (failed) result.failure = failed;
writeFileSync("/tmp/client-support-smoke.json", JSON.stringify(result, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ status: result.status, checks: result.checks.length, model_requests: result.model_requests, cleanup: result.cleanup, failure: failed }));
if (failed) process.exitCode = 1;
