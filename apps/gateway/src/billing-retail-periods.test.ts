import Fastify from "fastify";
import { afterEach, expect, it } from "vitest";
import { createSqliteStore } from "@codex-gateway/store-sqlite";
import { registerBillingAdminRoutes } from "./billing-admin.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); });

it("returns invalid_period over Billing HTTP without applying a year tagged monthly, then accepts the corrected request", async () => {
  const store = createSqliteStore({ path: ":memory:" });
  const app = Fastify({ logger: false });
  cleanups.push(async () => { await app.close(); store.close(); });
  const token = "billing-period-test-token-only";
  registerBillingAdminRoutes(app, { access: { token, nextToken: null }, tokenMode: "env", billingStore: store, planEntitlementStore: store });
  store.upsertSubject({ id: "period-http-user", label: "Fixture", state: "active", createdAt: new Date() });
  store.createPlan({ id: "plan_paid_yearly_v1", displayName: "Yearly", scopeAllowlist: ["code"],
    policy: { tokensPerMinute: 300_000, tokensPerDay: 6_000_000, tokensPerMonth: 200_000_000, tokensTotal: null,
      maxPromptTokensPerRequest: null, maxTotalTokensPerRequest: null, reserveTokensPerRequest: 0, missingUsageCharge: "none" } });
  const request = (periodKind: string) => app.inject({ method: "POST", url: "/gateway/admin/billing/v1/entitlement-events",
    headers: { authorization: `Bearer ${token}`, "idempotency-key": "period:year:purchase" },
    payload: { provider: "medevidence_billing", external_order_id: "period-order", subject_id: "period-http-user",
      event_type: "purchase", plan_id: "plan_paid_yearly_v1", period_kind: periodKind,
      period_start: "2030-09-14T03:41:27.867Z", period_end: "2031-09-14T03:41:27.867Z" } });
  const bad = await request("monthly");
  expect(bad.statusCode).toBe(400);
  expect(bad.json()).toMatchObject({ error: { code: "invalid_period" } });
  expect(store.listBillingEvents().events).toHaveLength(0);
  expect(store.listEntitlements({ subjectId: "period-http-user" })).toHaveLength(0);
  const valid = await request("one_off");
  expect(valid.statusCode).toBe(200);
  expect(valid.json()).toMatchObject({ applied: true, entitlement: { period_kind: "one_off" } });
  expect((await request("one_off")).json()).toMatchObject({ applied: true, idempotent_replay: true });
});
