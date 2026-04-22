import { describe, expect, it } from "vitest";
import { GatewayError, type RateLimitPolicy } from "@codex-gateway/core";
import { InMemoryCredentialRateLimiter, type RateLimitPermit } from "./rate-limiter.js";

const policy: RateLimitPolicy = {
  requestsPerMinute: 1,
  requestsPerDay: null,
  concurrentRequests: 1
};

describe("InMemoryCredentialRateLimiter", () => {
  it("limits requests per minute and returns retry_after_seconds", () => {
    let now = new Date("2026-01-01T00:00:00Z");
    const limiter = new InMemoryCredentialRateLimiter({ now: () => now });

    const first = permit(limiter.acquire({ credentialId: "cred_1", policy }));
    first.release();

    const limited = limiter.acquire({ credentialId: "cred_1", policy });
    expect(limited).toBeInstanceOf(GatewayError);
    expect((limited as GatewayError).code).toBe("rate_limited");
    expect((limited as GatewayError).retryAfterSeconds).toBe(60);

    now = new Date("2026-01-01T00:01:00Z");
    permit(limiter.acquire({ credentialId: "cred_1", policy })).release();
  });

  it("limits requests per UTC day", () => {
    let now = new Date("2026-01-01T23:59:00Z");
    const limiter = new InMemoryCredentialRateLimiter({ now: () => now });
    const dailyPolicy = {
      requestsPerMinute: 100,
      requestsPerDay: 1,
      concurrentRequests: null
    };

    permit(limiter.acquire({ credentialId: "cred_1", policy: dailyPolicy })).release();
    const limited = limiter.acquire({ credentialId: "cred_1", policy: dailyPolicy });
    expect(limited).toBeInstanceOf(GatewayError);
    expect((limited as GatewayError).retryAfterSeconds).toBe(60);

    now = new Date("2026-01-02T00:00:00Z");
    permit(limiter.acquire({ credentialId: "cred_1", policy: dailyPolicy })).release();
  });

  it("limits concurrent requests until a permit is released", () => {
    const limiter = new InMemoryCredentialRateLimiter({
      now: () => new Date("2026-01-01T00:00:00Z")
    });
    const concurrencyPolicy = {
      requestsPerMinute: 100,
      requestsPerDay: null,
      concurrentRequests: 1
    };

    const first = permit(limiter.acquire({ credentialId: "cred_1", policy: concurrencyPolicy }));
    const limited = limiter.acquire({ credentialId: "cred_1", policy: concurrencyPolicy });
    expect(limited).toBeInstanceOf(GatewayError);
    expect((limited as GatewayError).retryAfterSeconds).toBe(1);

    first.release();
    permit(limiter.acquire({ credentialId: "cred_1", policy: concurrencyPolicy })).release();
  });
});

function permit(result: RateLimitPermit | GatewayError): RateLimitPermit {
  expect(result).not.toBeInstanceOf(GatewayError);
  return result as RateLimitPermit;
}
