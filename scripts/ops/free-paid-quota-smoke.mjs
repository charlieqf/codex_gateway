// Compiled-route smoke: synthetic loopback provider and in-memory DB only.
import assert from "node:assert/strict";
import http from "node:http";
import { buildGateway } from "../../apps/gateway/dist/index.js";
import { goldencodePoolConfig } from "../../apps/gateway/dist/test-support.js";
import { createSqliteStore } from "@codex-gateway/store-sqlite";
import { issueAccessCredential } from "@codex-gateway/core";

assert(!process.env.GATEWAY_DATABASE_PATH && !process.env.MEDCODE_PUBLIC_MODELS_JSON,
  "Run without production configuration or mounts");
let calls = 0;
const upstream = http.createServer(async (request, response) => {
  for await (const _ of request) { /* drain synthetic request */ }
  calls++;
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end('data: {"choices":[{"delta":{"content":"quota success"},"finish_reason":"stop"}],"usage":{"prompt_tokens":18000,"completion_tokens":2000,"total_tokens":20000}}\n\ndata: [DONE]\n\n');
});
await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
const config = goldencodePoolConfig();
config.pool.members = config.pool.members.filter((member) => member.runtime === "tencent");
process.env.MEDCODE_PUBLIC_MODELS_JSON = JSON.stringify({ goldencode: config });
process.env.MEDCODE_TENCENT_TOKENHUB_API_KEY = "synthetic";
process.env.MEDCODE_TENCENT_TOKENHUB_BASE_URL = `http://127.0.0.1:${upstream.address().port}/v1`;
const now = new Date("2026-09-10T10:00:00Z");
const store = createSqliteStore({ path: ":memory:" });
store.upsertSubject({ id: "subj_quota_smoke", label: "Synthetic", state: "active", createdAt: now });
const issued = issueAccessCredential({ subjectId: "subj_quota_smoke", label: "Synthetic", scope: "code", expiresAt: new Date("2030-01-01Z"), now });
store.insertAccessCredential(issued.record);
const policy = { tokensPerMinute: 300000, tokensPerDay: 10000, tokensPerMonth: null,
  maxPromptTokensPerRequest: null, maxTotalTokensPerRequest: null, reserveTokensPerRequest: 0, missingUsageCharge: "none" };
store.createPlan({ id: "plan_free_daily_10k_v1", displayName: "Free", scopeAllowlist: ["code"], policy });
store.createPlan({ id: "plan_paid_monthly_v1", displayName: "Monthly", scopeAllowlist: ["code"],
  policy: { ...policy, tokensPerDay: 100000, tokensPerMonth: 200000 } });
const free = store.grantEntitlement({ subjectId: issued.record.subjectId, planId: "plan_free_daily_10k_v1", periodKind: "unlimited", now });
const app = buildGateway({ authMode: "credential", sessionStore: store, observationStore: store, logger: false,
  billingAdminToken: "synthetic-billing-admin-token", now: () => now,
  provider: { kind: "fake", async health() { return { state: "healthy", checkedAt: now }; },
    async *message() { throw new Error("Unexpected fallback invocation"); } } });
const headers = { authorization: `Bearer ${issued.token}` };
const billingHeaders = { authorization: "Bearer synthetic-billing-admin-token" };
const cases = [];
try {
  const payload = { provider: "medevidence_billing", external_order_id: "quota_smoke", event_type: "purchase", apply_mode: "apply",
    subject_id: issued.record.subjectId, plan_id: "plan_paid_monthly_v1", period_kind: "monthly",
    period_start: now.toISOString(), period_end: "2026-10-10T10:00:00Z", replace_current: true };
  const purchase = await app.inject({ method: "POST", url: "/gateway/admin/billing/v1/entitlement-events",
    headers: { ...billingHeaders, "Idempotency-Key": "medevidence_billing:quota_smoke:purchase" }, payload });
  assert.equal(purchase.statusCode, 200);
  assert(!purchase.json().cancelled_entitlement_ids.includes(free.id));
  const paidId = purchase.json().entitlement.id;
  for (const url of ["/v1/chat/completions", "/v1/responses"]) {
    for (const stream of [false, true]) {
      const response = await app.inject({ method: "POST", url, headers, payload: url.endsWith("responses")
        ? { model: "goldencode", input: "Say ok.", stream }
        : { model: "goldencode", messages: [{ role: "user", content: "Say ok." }], stream } });
      assert.equal(response.statusCode, 200);
      assert(response.body.includes("quota success"));
      const events = store.listRequestEvents({ requestId: String(response.headers["x-request-id"]) });
      assert.equal(events.length, 1);
      assert.equal(events[0].totalTokens, 20000);
      cases.push({ url, stream, status: response.statusCode });
    }
  }
  assert.equal(calls, 4);
  const current = await app.inject({ method: "GET", url: "/gateway/credentials/current", headers });
  assert.equal(current.statusCode, 200);
  const usage = current.json().token_usage;
  assert.equal(usage.accounting_mode, "free_then_paid_v1");
  assert.equal(usage.free_allowance.entitlement_id, free.id);
  assert.equal(usage.free_allowance.day.used, 10000);
  assert.equal(usage.day.used, 70000);
  assert.equal(usage.month.used, 70000);
  const account = await app.inject({ method: "GET", url: `/gateway/admin/billing/v1/users/${issued.record.subjectId}/entitlements`, headers: billingHeaders });
  assert.equal(account.statusCode, 200);
  assert.equal(account.json().current.id, paidId);
  assert.equal(account.json().free_allowance.id, free.id);
  const replay = await app.inject({ method: "POST", url: "/gateway/admin/billing/v1/entitlement-events",
    headers: { ...billingHeaders, "Idempotency-Key": "medevidence_billing:quota_smoke:purchase" }, payload });
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.json().idempotent_replay, true);
  assert.equal(store.getEntitlement(free.id).state, "active");
  assert.deepEqual(store.database.prepare("PRAGMA foreign_key_check").all(), []);
  console.log(JSON.stringify({ assertions: "passed", compiled_routes: cases, total_usage: 80000, free_usage: 10000,
    paid_usage: 70000, billing_read_and_replay: "passed", cleanup: [], production_accounts_created: 0, external_model_calls: 0 }));
} finally {
  await app.close();
  await new Promise((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
}
