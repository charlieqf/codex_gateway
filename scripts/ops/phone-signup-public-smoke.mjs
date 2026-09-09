// Run inside the Gateway container after an authorized release. Credentials
// stay in memory; stdout contains only sanitized checks and request IDs.
import assert from "node:assert/strict";
import { randomInt } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const origin = "https://goldencode.instmarket.com.au:1443";
const admin = process.env.GATEWAY_BILLING_ADMIN_TOKEN;
const provider = process.env.GATEWAY_BILLING_IDENTITY_PROVIDER;
assert.ok(admin && provider, "Billing and signup configuration required");
const db = new DatabaseSync(process.env.GATEWAY_SQLITE_PATH, { readOnly: true });
db.exec("PRAGMA query_only=ON");
const run = `signup_smoke_${Date.now()}`;
const report = { checked_at: new Date().toISOString(), checks: [], cleanup: [] };
const accounts = [];
const version = "2.0.0-beta.47";

async function call(path, { method = "GET", token, body, event, status = 200 } = {}) {
  const response = await fetch(origin + path, {
    method, headers: {
      "x-medevidence-client-version": version,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
      ...(event ? { "idempotency-key": event } : {})
    }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(60_000)
  });
  const json = await response.json();
  const evidence = { path, status: response.status, request_id: response.headers.get("x-request-id") };
  report.checks.push(evidence);
  // Never include the response body (it can contain keys/tokens) in errors.
  assert.equal(response.status, status, `${method} ${path}: ${json.error?.code ?? "unexpected status"}`);
  return json;
}

function unusedPhone() {
  for (let i = 0; i < 100; i++) {
    const value = `199${String(randomInt(100_000_000)).padStart(8, "0")}`;
    if (!db.prepare("SELECT 1 FROM subjects WHERE phone_number IN (?, ?)").get(value, `+86${value}`) &&
        !db.prepare("SELECT 1 FROM external_subject_registrations WHERE phone_number = ?").get(`+86${value}`)) return value;
  }
  throw new Error("Cannot reserve a distinct smoke phone");
}

async function login(account) {
  const session = await call("/gateway/auth/v1/login/start", { method: "POST", body: {
    phone: account.phone, client: "medevidence-desktop", device_id: `${run}_${account.kind}`, contract_version: 1
  } });
  assert.equal(session.subject.id, account.subjectId);
  assert.equal(session.auth_method, "transition_phone_only");
  const bootstrap = await call("/gateway/auth/v1/session/bootstrap", { method: "POST", token: session.access_token, body: {} });
  assert.equal(bootstrap.unified_key.key, account.key);
  const current = await call("/gateway/account/v1/current", { token: session.access_token });
  assert.equal(current.subject.id, account.subjectId);
  const resolved = await call("/gateway/unified-keys/resolve", { method: "POST", token: account.key, body: {} });
  assert.equal(resolved.subject.id, account.subjectId);
  const credential = await call("/gateway/credentials/current", { token: resolved.codex_gateway.api_key });
  return { session, current, resolved, credential };
}

let failure;
try {
  await call("/gateway/health");
  const fresh = { kind: "new", provider, externalId: `medevidence_test_${Date.now()}`, phone: unusedPhone() };
  accounts.push(fresh);
  const association = await call("/gateway/admin/billing/v1/subjects/resolve", { method: "POST", token: admin,
    body: { provider, external_user_id: fresh.externalId, phone: fresh.phone } });
  assert.equal(association.status, "create_ready");
  const createBody = { provider, external_user_id: fresh.externalId, scope_allowlist: ["code"] };
  const issued = await call("/gateway/admin/billing/v1/subjects", { method: "POST", token: admin, body: createBody, event: `${run}:create` });
  fresh.subjectId = issued.subject.id; fresh.key = issued.credential.key;
  const ready = await login(fresh);
  assert.equal(ready.current.identity.plan_id, "plan_free_daily_1m_v1");
  assert.equal(ready.credential.credential.token.tokensPerDay, 1_000_000);
  assert.equal(db.prepare("SELECT name FROM subjects WHERE id = ?").get(fresh.subjectId).name, null);
  const initial = db.prepare("SELECT id FROM entitlements WHERE subject_id = ?").get(fresh.subjectId).id;
  const replay = await call("/gateway/admin/billing/v1/subjects", { method: "POST", token: admin, body: createBody, event: `${run}:create` });
  assert.equal(replay.idempotent_replay, true);
  assert.equal(replay.credential.key, undefined);
  await login(fresh);
  assert.deepEqual(db.prepare("SELECT id FROM entitlements WHERE subject_id = ?").all(fresh.subjectId).map(x => x.id), [initial]);
  const model = await call("/v1/chat/completions", { method: "POST", token: ready.resolved.codex_gateway.api_key,
    body: { model: "goldencode", messages: [{ role: "user", content: "Reply only OK." }], max_tokens: 256, stream: false } });
  assert.ok(model.choices?.length > 0, "Model response missing choices");
  report.new_account = { subject_id: fresh.subjectId, plan_id: ready.current.identity.plan_id,
    daily_tokens: 1_000_000, no_name: true, same_key_on_relogin: true, grant_count: 1, model_http_status: 200 };

  const linked = await call("/gateway/admin/billing/v1/subjects/resolve", { method: "POST", token: admin,
    body: { provider, external_user_id: fresh.externalId, phone: fresh.phone } });
  assert.equal(linked.status, "linked");
  assert.equal(linked.subject.id, fresh.subjectId);
  report.returning_signup_account = { subject_id: fresh.subjectId, same_subject: true, same_key: true };

  const unknown = await call("/gateway/auth/v1/login/start", { method: "POST", status: 403,
    body: { phone: unusedPhone(), client: "medevidence-desktop", device_id: `${run}_unknown`, contract_version: 1 } });
  assert.equal(unknown.error.code, "phone_not_registered");
} catch (error) {
  failure = error;
} finally {
  for (const account of accounts) {
    try {
      if (!account.subjectId) {
        const found = db.prepare("SELECT id FROM subjects WHERE external_provider = ? AND external_user_id = ?")
          .get(account.provider, account.externalId);
        account.subjectId = found?.id;
      }
      if (!account.subjectId) continue;
      if (db.prepare("SELECT 1 FROM phone_auth_identities WHERE subject_id = ?").get(account.subjectId)) {
        await call(`/gateway/admin/billing/v1/phone-auth-identities/${account.subjectId}`, {
          method: "PATCH", token: admin, body: { state: "disabled" }
        });
      }
      await call(`/gateway/admin/billing/v1/subjects/${account.subjectId}/disable`, { method: "POST", token: admin,
        body: { reason: "phone_signup_smoke_cleanup" }, event: `${run}:${account.kind}:disable` });
      const remaining = db.prepare("SELECT COUNT(*) AS count FROM access_credentials WHERE subject_id = ? AND revoked_at IS NULL").get(account.subjectId).count;
      assert.equal(remaining, 0);
      if (account.key) await call("/gateway/unified-keys/resolve", { method: "POST", token: account.key, body: {}, status: 401 });
      report.cleanup.push({ subject_id: account.subjectId, disabled: true, active_credentials: 0 });
    } catch (error) { failure ??= error; }
  }
  db.close();
}
report.assertions = failure ? "failed" : "passed";
if (failure) report.error = failure.message;
process.stdout.write(JSON.stringify(report) + "\n");
if (failure) process.exitCode = 1;
