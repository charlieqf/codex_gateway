// Authorized production smoke: one synthetic Billing account, one small model
// request, public APIs for writes, read-only SQL for that account's settlement.
// Never print response bodies, credentials, or model content.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";

const origin = "https://goldencode.instmarket.com.au:1443";
const admin = process.env.GATEWAY_BILLING_ADMIN_TOKEN;
const provider = process.env.GATEWAY_BILLING_IDENTITY_PROVIDER;
assert.ok(admin && provider, "Billing configuration required");
const db = new DatabaseSync(process.env.GATEWAY_SQLITE_PATH, { readOnly: true });
db.exec("PRAGMA query_only=ON");
const run = `quota_review_${Date.now()}`;
const externalId = `medevidence_test_${run}`;
const report = { checked_at: new Date().toISOString(), checks: [], cleanup: [] };
let subjectId, key, modelTask, failure;

async function call(path, { method = "GET", token = admin, body, event, status = 200 } = {}) {
  const response = await fetch(origin + path, {
    method, headers: {
      "x-medevidence-client-version": "2.0.0-beta.47",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
      ...(event ? { "idempotency-key": event } : {})
    }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(60_000)
  });
  const json = await response.json();
  const evidence = { path, status: response.status, request_id: response.headers.get("x-request-id") };
  if (json.error?.code) evidence.error_code = json.error.code;
  report.checks.push(evidence);
  assert.equal(response.status, status, `${method} ${path}: ${json.error?.code ?? "unexpected status"}`);
  return { json, requestId: evidence.request_id };
}

async function event(name, body, status = 200) {
  return (await call("/gateway/admin/billing/v1/entitlement-events", {
    method: "POST", status, event: `${run}:${name}`, body: {
      provider, subject_id: subjectId, external_order_id: `${run}_${name}`,
      external_event_id: `${run}_${name}`, apply_mode: "apply", ...body
    }
  })).json;
}

const history = async () => (await call(`/gateway/admin/billing/v1/users/${subjectId}/entitlements`)).json;
const reset = async (status) => (await call(`/gateway/admin/billing/v1/users/${subjectId}/quota-reset`, {
  method: "POST", status, body: { request_windows: [], token_windows: ["day"], reason: run }
})).json;

try {
  await call("/gateway/health", { token: null });
  const created = (await call("/gateway/admin/billing/v1/subjects", {
    method: "POST", event: `${run}:create`, body: { provider, external_user_id: externalId,
      display_name: "Gateway quota review smoke", scope_allowlist: ["code"], metadata: { signup_source: run } }
  })).json;
  subjectId = created.subject.id; key = created.credential.key;
  assert.ok(key?.startsWith("cgu_live_"), "May create contract must issue a unified key");
  const resolved = (await call("/gateway/unified-keys/resolve", { method: "POST", token: key, body: {} })).json;
  const runtimeKey = resolved.codex_gateway.api_key;
  const start = new Date();
  const end = new Date(start); end.setUTCMonth(end.getUTCMonth() + 1);
  const nextEnd = new Date(end); nextEnd.setUTCMonth(nextEnd.getUTCMonth() + 1);
  const monthly = await event("purchase", { event_type: "purchase", plan_id: "plan_paid_monthly_v1",
    period_kind: "monthly", period_start: start.toISOString(), period_end: end.toISOString() });
  const paidId = monthly.entitlement.id;
  const initial = await history();
  const freeId = initial.free_allowance.id;
  assert.equal(initial.free_allowance.plan_id, "plan_free_daily_100k_v1");
  assert.equal(initial.current.id, paidId);
  const future = await event("renew", { event_type: "renew", plan_id: "plan_paid_monthly_v1",
    period_kind: "monthly", period_start: end.toISOString(), period_end: nextEnd.toISOString() });
  assert.equal(future.entitlement.state, "scheduled");

  // Observe an actual in-flight request before exercising the reset conflict.
  // Attach the rejection handler immediately so cleanup never leaves a task.
  let modelFinished = false;
  modelTask = call("/v1/chat/completions", { method: "POST", token: runtimeKey,
    body: { model: "goldencode", messages: [{ role: "user", content:
      "List the integers from 1 to 120 separated by spaces. No commentary." }], max_tokens: 1024, stream: false }
  }).then(value => ({ value }), error => ({ error })).finally(() => { modelFinished = true; });
  let pending;
  for (let attempt = 0; attempt < 100 && !modelFinished; attempt++) {
    pending = db.prepare("SELECT id FROM token_reservations WHERE subject_id = ? AND finalized_at IS NULL AND free_entitlement_id = ?")
      .get(subjectId, freeId);
    if (pending) break;
    await delay(50);
  }
  assert.ok(pending, "Did not observe a live dual-ledger reservation");
  await event("pause", { event_type: "pause" });
  assert.equal((await reset(409)).error.code, "quota_reset_conflict");
  const outcome = await modelTask;
  if (outcome.error) throw outcome.error;
  const total = outcome.value.json.usage?.total_tokens;
  assert.ok(total > 0, "Actual model usage missing");
  const ledger = db.prepare("SELECT finalized_at, final_total_tokens, final_free_tokens, final_paid_tokens FROM token_reservations WHERE id = ? AND subject_id = ?")
    .get(pending.id, subjectId);
  assert.ok(ledger.finalized_at, "Model request not finalized");
  assert.equal(ledger.final_total_tokens, total);
  assert.equal(ledger.final_free_tokens + ledger.final_paid_tokens, total);
  const freeCurrent = (await call("/gateway/credentials/current", { token: runtimeKey })).json;
  assert.equal(freeCurrent.token_usage.day.used, ledger.final_free_tokens);
  report.settlement = { subject_id: subjectId, request_id: outcome.value.requestId, total_tokens: total,
    free_tokens: ledger.final_free_tokens, paid_tokens: ledger.final_paid_tokens, reset_conflict: true, late_usage_preserved: true };

  const cancelled = await event("cancel_current", { event_type: "cancel" });
  assert.equal(cancelled.entitlement.id, paidId);
  const afterCancel = await history();
  assert.equal(afterCancel.current.id, freeId);
  assert.equal(afterCancel.history.find(item => item.id === future.entitlement.id)?.state, "scheduled");
  assert.equal((await event("cancel_no_current", { event_type: "cancel" }, 404)).error.code, "entitlement_not_found");
  await event("cancel_future", { event_type: "cancel", entitlement_id: future.entitlement.id });
  const completedReset = await reset(200);
  assert.equal(completedReset.token_reset.usage_after.day.used, 0);

  const annualStart = new Date();
  const annualEnd = new Date(annualStart); annualEnd.setUTCFullYear(annualEnd.getUTCFullYear() + 1);
  await event("yearly", { event_type: "purchase", plan_id: "plan_paid_yearly_v1", period_kind: "one_off",
    period_start: annualStart.toISOString(), period_end: annualEnd.toISOString() });
  const annual = (await call("/gateway/credentials/current", { token: runtimeKey })).json.token_usage;
  assert.equal(annual.accounting_mode, "free_then_paid_v1");
  assert.equal(annual.day.limit, 6000000); assert.equal(annual.month.limit, 200000000);
  assert.equal(annual.month.remaining, 200000000);
  assert.equal(annual.free_allowance.entitlement_id, freeId);
  assert.equal(annual.free_allowance.day.used, 0);
  report.billing = { default_cancel_targets_current_paused: true, scheduled_renewal_preserved: true,
    future_cancel_requires_id: true, completed_reset: true, yearly_daily_monthly_limits: true, same_free_entitlement: true };

  const dashboard = await fetch(`${origin}/gateway/admin/quota-dashboard`, { signal: AbortSignal.timeout(20_000) });
  assert.equal(dashboard.status, 200);
  const html = await dashboard.text();
  assert.ok(html.includes("免费日") && html.includes("付费周期") && html.includes("quota_exhausted") && html.includes("不限；已用"));
  report.dashboard = { public_html_updated: true };
} catch (error) {
  failure = error;
} finally {
  if (modelTask) await modelTask;
  try {
    subjectId ??= db.prepare("SELECT id FROM subjects WHERE external_provider = ? AND external_user_id = ?").get(provider, externalId)?.id;
    if (subjectId) {
      await call(`/gateway/admin/billing/v1/subjects/${subjectId}/disable`, { method: "POST", body: { reason: run }, event: `${run}:disable` });
      const credentials = db.prepare("SELECT COUNT(*) AS count FROM access_credentials WHERE subject_id = ? AND revoked_at IS NULL").get(subjectId).count;
      const unfinished = db.prepare("SELECT COUNT(*) AS count FROM token_reservations WHERE subject_id = ? AND finalized_at IS NULL").get(subjectId).count;
      assert.equal(credentials, 0); assert.equal(unfinished, 0);
      if (key) await call("/gateway/unified-keys/resolve", { method: "POST", token: key, body: {}, status: 401 });
      report.cleanup.push({ subject_id: subjectId, disabled: true, active_credentials: credentials, unfinished_reservations: unfinished });
    }
  } catch (error) { failure ??= error; }
  db.close();
}
report.assertions = failure ? "failed" : "passed";
if (failure) report.error = failure.message;
process.stdout.write(JSON.stringify(report) + "\n");
if (failure) process.exitCode = 1;
