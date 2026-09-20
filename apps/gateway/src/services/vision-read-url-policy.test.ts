import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { defaultVisionReadUrlPolicy, resolveVisionReadUrlPolicy, validateRateLimitProfile, visionReadUrlRoute } from "./vision-read-url-policy.js";

describe("vision read URL policy", () => {
  it("uses immutable independent defaults and explicit configuration", () => {
    expect(resolveVisionReadUrlPolicy({})).toEqual(defaultVisionReadUrlPolicy);
    const policy = resolveVisionReadUrlPolicy({ GATEWAY_VISION_READ_URL_CONCURRENT_REQUESTS: "7" });
    expect(policy.concurrentRequests).toBe(7);
    expect(Object.isFrozen(policy)).toBe(true);
    expect(defaultVisionReadUrlPolicy.concurrentRequests).toBe(20);
  });

  it.each(["", " ", "0", "-1", "1.2", "20abc", "1e3", "Infinity", "NaN", "9007199254740992"])("rejects invalid configuration %j", (value) => {
    for (const name of ["REQUESTS_PER_MINUTE", "REQUESTS_PER_DAY", "CONCURRENT_REQUESTS"]) {
      expect(() => resolveVisionReadUrlPolicy({ [`GATEWAY_VISION_READ_URL_${name}`]: value })).toThrow("positive safe integer");
    }
  });

  it("validates injected policies too", () => {
    for (const value of [0, null, undefined, NaN, Infinity, 1.1]) {
      expect(() => resolveVisionReadUrlPolicy({}, { ...defaultVisionReadUrlPolicy, requestsPerDay: value as number })).toThrow();
    }
  });

  it.each([
    { method: "GET", url: visionReadUrlRoute },
    { method: "POST", url: "/gateway/vision/assets/:assetId/complete" },
    { method: "POST", url: visionReadUrlRoute, config: { public: true } },
    { method: "POST", url: visionReadUrlRoute, config: { skipAuth: true } },
    { method: "POST", url: visionReadUrlRoute, config: { skipRateLimit: true } },
    { method: "POST", url: visionReadUrlRoute, config: { rateLimitProfile: "typo" } }
  ])("rejects unsafe route metadata %j", async (input) => {
    const app = Fastify();
    app.addHook("onRoute", validateRateLimitProfile);
    try {
      expect(() => app.route({ ...input, config: { rateLimitProfile: "vision_read_url", ...input.config }, handler: async () => ({}) } as never)).toThrow("authenticated POST");
    } finally { await app.close(); }
  });

  it("accepts only the explicitly registered refresh route", async () => {
    const app = Fastify();
    app.addHook("onRoute", validateRateLimitProfile);
    app.post(visionReadUrlRoute, { config: { rateLimitProfile: "vision_read_url" } }, async () => ({}));
    app.get("/unrelated", async () => ({}));
    await app.ready();
    await app.close();
  });
});
