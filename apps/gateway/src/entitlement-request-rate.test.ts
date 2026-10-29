import { describe, expect, it } from "vitest";
import { issueAccessCredential, issueUnifiedClientKey, type ProviderAdapter, type TokenLimitPolicy } from "@codex-gateway/core";
import { createSqliteStore } from "@codex-gateway/store-sqlite";
import { buildGateway } from "./index.js";
import { InMemoryRequestRateLimiter } from "./services/rate-limiter.js";

const now = new Date("2026-10-29T08:00:00Z");
const policy: TokenLimitPolicy = { tokensPerMinute: null, tokensPerDay: null, tokensPerMonth: null,
  tokensTotal: null, maxPromptTokensPerRequest: null, maxTotalTokensPerRequest: null,
  reserveTokensPerRequest: 0, missingUsageCharge: "none" };
const provider: ProviderAdapter = {
  kind: "fake", async health() { return { state: "healthy", checkedAt: now }; },
  async *message() { yield { type: "completed", providerSessionRef: "fixture" }; }
};

function fixture(daily: number | null = 600) {
  const store = createSqliteStore({ path: ":memory:" });
  store.upsertSubject({ id: "internal", label: "internal", state: "active", createdAt: now });
  store.createPlan({ id: "internal-plan", displayName: "Internal", policy, scopeAllowlist: ["code"], now });
  const entitlement = store.grantEntitlement({ subjectId: "internal", planId: "internal-plan",
    periodKind: "one_off", periodStart: now, periodEnd: new Date("2027-01-01"), now });
  const issued = issueAccessCredential({ subjectId: "internal", label: "test", scope: "code",
    rate: { requestsPerDay: daily, requestsPerMinute: 10000, concurrentRequests: 3, token: policy },
    expiresAt: new Date("2027-01-01"), now });
  store.insertAccessCredential(issued.record);
  const unified = issueUnifiedClientKey({ subjectId: "internal", label: "test",
    expiresAt: issued.record.expiresAt, codexCredentialId: issued.record.id,
    codexCredentialPrefix: issued.record.prefix, codexKeyCiphertext: "unused", medevidenceKeyCiphertext: "unused", now });
  store.insertUnifiedClientKey(unified.record);
  const limiter = new InMemoryRequestRateLimiter({ now: () => now });
  const app = buildGateway({ authMode: "credential", provider, sessionStore: store,
    rateLimiter: limiter, now: () => now, logger: false });
  app.get("/request-floor-test", async request => ({ rate: request.gatewayContext?.credential.rate }));
  const setFloor = (value: unknown = 1000) => store.database.prepare("UPDATE plans SET metadata_json=? WHERE id='internal-plan'")
    .run(JSON.stringify({ requestRateFloor: { requestsPerDay: value } }));
  const get = (url = "/gateway/credentials/current", token = issued.token) =>
    app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });
  return { store, app, limiter, issued, unified, entitlement, setFloor, get,
    close: async () => { await app.close(); } };
}

describe("live Plan daily request benefit", () => {
  it("unblocks an exhausted 600 counter for both key types, preserves usage, and stops at 1000", async () => {
    const f = fixture();
    try {
      for (let n = 0; n < 600; n++) {
        const permit = f.limiter.acquire({ key: f.issued.record.id, scope: "credential", policy: f.issued.record.rate });
        if (!("release" in permit)) throw new Error("Fixture admission failed");
        permit.release();
      }
      expect((await f.get("/request-floor-test")).statusCode).toBe(429);
      f.setFloor();
      for (const token of [f.issued.token, f.unified.token]) {
        const current = await f.get(undefined, token);
        expect(current.statusCode).toBe(200);
        expect(current.json().credential.rate.requestsPerDay).toBe(1000);
      }
      for (let n = 0; n < 400; n++) {
        const response = await f.get("/request-floor-test", n % 2 ? f.unified.token : f.issued.token);
        expect(response.statusCode).toBe(200);
        expect(response.json().rate).toEqual({ ...f.issued.record.rate, requestsPerDay: 1000 });
      }
      const capped = await f.get("/request-floor-test");
      expect(capped.statusCode).toBe(429);
      expect(JSON.stringify(capped.json())).toContain("1000");
      expect(f.store.getAccessCredentialByPrefix(f.issued.record.prefix)?.rate).toEqual(f.issued.record.rate);
      expect(f.store.getEntitlement(f.entitlement.id)?.policySnapshot).toEqual(policy);
    } finally { await f.close(); }
  });

  it.each([1000, 5000, null])("keeps a pre-existing daily limit of %s", async daily => {
    const f = fixture(daily);
    try { f.setFloor(); expect((await f.get()).json().credential.rate.requestsPerDay).toBe(daily); }
    finally { await f.close(); }
  });

  it("applies to new grants and disappears when the internal entitlement is replaced", async () => {
    const f = fixture();
    try {
      f.setFloor();
      f.store.cancelEntitlement({ id: f.entitlement.id, now });
      const renewed = f.store.grantEntitlement({ subjectId: "internal", planId: "internal-plan",
        periodKind: "one_off", periodStart: now, periodEnd: new Date("2027-01-01"), now });
      expect((await f.get()).json().credential.rate.requestsPerDay).toBe(1000);
      f.store.pauseEntitlement({ id: renewed.id, now });
      expect((await f.get()).json().credential.rate.requestsPerDay).toBe(600);
      f.store.cancelEntitlement({ id: renewed.id, now });
      f.store.createPlan({ id: "retail", displayName: "Retail", policy, scopeAllowlist: ["code"], now });
      f.store.grantEntitlement({ subjectId: "internal", planId: "retail", periodKind: "one_off",
        periodStart: now, periodEnd: new Date("2027-01-01"), now });
      expect((await f.get()).json().credential.rate.requestsPerDay).toBe(600);
    } finally { await f.close(); }
  });

  it.each(["1000", -1, 1.5, null])("ignores malformed optional floor %s", async value => {
    const f = fixture();
    try { f.setFloor(value); expect((await f.get()).json().credential.rate.requestsPerDay).toBe(600); }
    finally { await f.close(); }
  });
});
