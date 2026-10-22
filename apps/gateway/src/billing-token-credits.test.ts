import Fastify from "fastify";
import { afterEach, expect, it, vi } from "vitest";
import { createSqliteStore } from "@codex-gateway/store-sqlite";
import { registerBillingAdminRoutes } from "./billing-admin.js";
import { buildGateway } from "./index.js";
import { issueAccessCredential, phoneSignupFreePlan, type ProviderAdapter } from "@codex-gateway/core";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { try { for (const close of cleanup.splice(0)) await close(); } finally { vi.unstubAllEnvs(); } });
function fixture() {
  const store = createSqliteStore({ path: ":memory:" });
  const app = Fastify({ logger: false });
  cleanup.push(async () => { await app.close(); store.close(); });
  const token = "billing-credit-test-only";
  const headers = { authorization: `Bearer ${token}` };
  registerBillingAdminRoutes(app, { access: { token, nextToken: null }, tokenMode: "env", billingStore: store, planEntitlementStore: store });
  store.upsertSubject({ id: "http-credit-user", label: "Fixture", state: "active", createdAt: new Date() });
  const payload = { subject_id: "http-credit-user", provider: "payment", event_type: "topup", tokens: 2345678,
    external_event_id: "paid-event-1", external_order_id: "paid-order-1", reason: "Purchased Token pack" };
  const root = "/gateway/admin/billing/v1";
  return { app, store, headers, payload, root, post: (body: unknown = payload, key: string | null = "paid:1", auth = headers) =>
    app.inject({ method: "POST", url: `${root}/token-credit-events`, headers: { ...auth, ...(key ? { "idempotency-key": key } : {}) }, payload: body as object }) };
}

it("authenticates all credit routes and never grants through a user credential or missing auth", async () => {
  const f = fixture();
  for (const headers of [{}, { authorization: "Bearer ordinary-user-key" }]) {
    expect((await f.post(f.payload, "paid:1", headers as typeof f.headers)).statusCode).toBe(401);
    for (const path of ["token-credit-events/paid:1", "users/http-credit-user/token-credits", "users/http-credit-user/token-credit-events"]) {
      expect((await f.app.inject({ method: "GET", url: `${f.root}/${path}`, headers })).statusCode).toBe(401);
    }
  }
  expect(f.store.getTokenCreditWallet("http-credit-user").grantedTokens).toBe(0);
});

it("grants, replays, queries and paginates permanent credits without creating a plan or key", async () => {
  const f = fixture();
  const result = await f.post();
  expect(result.statusCode).toBe(200);
  expect(result.headers["cache-control"]).toContain("no-store");
  expect(result.json()).toMatchObject({ applied: true, idempotent_replay: false,
    credit_event: { event_type: "topup", tokens: 2345678, expires_at: null },
    token_credits: { granted_tokens: 2345678, charged_tokens: 0, balance_tokens: 2345678, available_tokens: 2345678, reserved_tokens: 0, expires_at: null } });
  expect((await f.post()).json()).toMatchObject({ idempotent_replay: true, credit_event: result.json().credit_event });
  expect((await f.app.inject({ method: "GET", url: `${f.root}/token-credit-events/paid:1`, headers: f.headers })).json())
    .toEqual({ credit_event: result.json().credit_event });
  expect((await f.post({ ...f.payload, event_type: "gift", external_event_id: "campaign:1", external_order_id: null, tokens: 1 }, "gift:1")).statusCode).toBe(200);
  const get = (path: string) => f.app.inject({ method: "GET", url: `${f.root}/${path}`, headers: f.headers });
  expect((await get("users/http-credit-user/token-credits")).json().token_credits.balance_tokens).toBe(2345679);
  const first = (await get("users/http-credit-user/token-credit-events?limit=1")).json();
  expect(first.credit_events.map((e: { event_type: string }) => e.event_type)).toEqual(["topup"]);
  const second = (await get(`users/http-credit-user/token-credit-events?limit=1&cursor=${first.next_cursor}`)).json();
  expect(second.credit_events.map((e: { event_type: string }) => e.event_type)).toEqual(["gift"]);
  expect(second.next_cursor).toBeNull();
  expect(f.store.listEntitlements({ subjectId: "http-credit-user" })).toHaveLength(0);
  expect(f.store.listAccessCredentials({ subjectId: "http-credit-user" })).toHaveLength(0);
});

it("returns actionable 400/404/409 without partial credit writes", async () => {
  const f = fixture();
  expect((await f.post(f.payload, null)).statusCode).toBe(400);
  for (const patch of [{ tokens: "100" }, { tokens: 0 }, { tokens: -1 }, { tokens: 1.1 }, { expires_at: "2030-01-01" },
    { event_type: "refund" }, { external_order_id: null }, { reason: "" }, { provider: "" },
    { subject_id: {} }, { external_event_id: [] }, { tokens: {} }, { reason: 123 }]) {
    expect((await f.post({ ...f.payload, ...patch })).statusCode).toBe(400);
  }
  expect((await f.post({ ...f.payload, subject_id: "missing" })).statusCode).toBe(404);
  expect(f.store.getTokenCreditWallet("http-credit-user").grantedTokens).toBe(0);
  expect((await f.post()).statusCode).toBe(200);
  for (const [body, key] of [[{ ...f.payload, tokens: 10 }, "paid:1"], [f.payload, "other:key"],
    [{ ...f.payload, external_event_id: "another-event" }, "another:key"]] as const) {
    const response = await f.post(body, key);
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("idempotency_conflict");
  }
  expect(f.store.getTokenCreditWallet("http-credit-user").grantedTokens).toBe(2345678);
  for (const path of ["token-credit-events/missing", "users/missing/token-credits", "users/missing/token-credit-events"]) {
    expect((await f.app.inject({ method: "GET", url: `${f.root}/${path}`, headers: f.headers })).statusCode).toBe(404);
  }
  for (const query of ["limit=0", "limit=201", "limit=NaN", "cursor=invalid"]) {
    expect((await f.app.inject({ method: "GET", url: `${f.root}/users/http-credit-user/token-credit-events?${query}`, headers: f.headers })).statusCode).toBe(400);
  }
});

it("uses HTTP-issued credits in Chat and Responses, streaming and non-streaming, after the plan is exhausted", async () => {
  vi.stubEnv("MEDCODE_PUBLIC_MODEL_ID", "goldencode");
  const at = new Date("2026-10-23T10:00:00Z");
  const store = createSqliteStore({ path: ":memory:" });
  store.upsertSubject({ id: "credit-chat-user", label: "Fixture", state: "active", createdAt: at });
  const issued = issueAccessCredential({ subjectId: "credit-chat-user", label: "Fixture", scope: "code", now: at, expiresAt: new Date("2030-01-01Z") });
  store.insertAccessCredential(issued.record);
  const free = phoneSignupFreePlan(at);
  store.createPlan({ ...free, id: "plan_free_once_fixture_v1", policy: { ...free.policy, tokensTotal: 1000 } });
  store.grantEntitlement({ subjectId: "credit-chat-user", planId: "plan_free_once_fixture_v1", periodKind: "unlimited", now: at });
  store.createPlan({ id: "plan_paid_monthly_v1", displayName: "Paid", scopeAllowlist: ["code"],
    policy: { ...free.policy, tokensTotal: null, tokensPerDay: 1000, tokensPerMonth: 10000 } });
  store.applyBillingEntitlementEvent({ subjectId: "credit-chat-user", planId: "plan_paid_monthly_v1", provider: "billing",
    externalOrderId: "subscription", idempotencyKey: "subscription", payloadHash: "subscription", eventType: "purchase", applyMode: "apply",
    periodKind: "monthly", periodStart: at, periodEnd: new Date("2026-11-23T10:00:00Z"), now: at });
  let calls = 0;
  const provider: ProviderAdapter = { kind: "fake", async health() { return { state: "healthy", checkedAt: at }; },
    async *message() { calls++; yield { type: "message_delta", text: "credit success" };
      yield { type: "completed", providerSessionRef: "credit-fixture", usage: { promptTokens: 900, completionTokens: 100, totalTokens: 1000 } }; } };
  const app = buildGateway({ authMode: "credential", provider, sessionStore: store, observationStore: store,
    billingAdminToken: "credit-integration-billing-token", now: () => at, logger: false });
  cleanup.push(async () => { await app.close(); });
  const headers = { authorization: `Bearer ${issued.token}` };
  const chat = (url = "/v1/chat/completions", stream = false) => app.inject({ method: "POST", url, headers,
    payload: url.endsWith("responses") ? { model: "goldencode", input: "Say ok.", stream }
      : { model: "goldencode", messages: [{ role: "user", content: "Say ok." }], stream } });
  for (let i = 0; i < 2; i++) { const response = await chat(); expect(response.statusCode, response.body).toBe(200); }
  expect((await chat()).statusCode).toBe(429);
  expect(calls).toBe(2);
  const grant = await app.inject({ method: "POST", url: "/gateway/admin/billing/v1/token-credit-events",
    headers: { authorization: "Bearer credit-integration-billing-token", "idempotency-key": "chat:gift" },
    payload: { subject_id: "credit-chat-user", provider: "billing", external_event_id: "chat:gift", event_type: "gift", tokens: 5000, reason: "Fixture" } });
  expect(grant.statusCode, grant.body).toBe(200);
  for (const url of ["/v1/chat/completions", "/v1/responses"]) for (const stream of [false, true]) {
    const response = await chat(url, stream); expect(response.statusCode, response.body).toBe(200);
    expect(response.body).toContain("credit success");
  }
  expect(calls).toBe(6);
  const current = await app.inject({ method: "GET", url: "/gateway/credentials/current", headers });
  expect(current.statusCode).toBe(200);
  expect(current.json()).toMatchObject({ token_usage: { accounting_mode: "free_then_plan_then_credits_v1",
    day: { used: 1000 }, month: { used: 1000 }, free_allowance: { total: { used: 1000 } },
    token_credits: { granted_tokens: 5000, charged_tokens: 4000, available_tokens: 1000, reserved_tokens: 0 } } });
});
