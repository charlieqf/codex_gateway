import { describe, expect, it } from "vitest";
import { type LimitRejection, type RateLimitPolicy } from "@codex-gateway/core";
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
    expect(rejection(limited).limitKind).toBe("request_minute");
    expect(rejection(limited).error.code).toBe("rate_limited");
    expect(rejection(limited).error.retryAfterSeconds).toBe(60);

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
    expect(rejection(limited).limitKind).toBe("request_day");
    expect(rejection(limited).error.retryAfterSeconds).toBe(60);

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
    expect(rejection(limited).limitKind).toBe("concurrency");
    expect(rejection(limited).error.retryAfterSeconds).toBe(1);

    first.release();
    permit(limiter.acquire({ credentialId: "cred_1", policy: concurrencyPolicy })).release();
  });

  it("does not prune active state after windows expire", () => {
    let now = new Date("2026-01-01T00:00:00Z");
    const limiter = new InMemoryCredentialRateLimiter({ now: () => now });
    const concurrencyPolicy = {
      requestsPerMinute: 100,
      requestsPerDay: 100,
      concurrentRequests: 1
    };

    const first = permit(limiter.acquire({ credentialId: "cred_1", policy: concurrencyPolicy }));
    now = new Date("2026-01-02T00:00:00Z");

    const limited = limiter.acquire({ credentialId: "cred_1", policy: concurrencyPolicy });

    expect(rejection(limited).limitKind).toBe("concurrency");
    expect(stateCount(limiter)).toBe(1);

    first.release();
  });

  it("prunes released state after minute and day windows expire", () => {
    let now = new Date("2026-01-01T00:00:00Z");
    const limiter = new InMemoryCredentialRateLimiter({ now: () => now });
    const generousPolicy = {
      requestsPerMinute: 100,
      requestsPerDay: 100,
      concurrentRequests: null
    };

    const first = permit(limiter.acquire({ credentialId: "cred_1", policy: generousPolicy }));
    expect(stateCount(limiter)).toBe(1);

    now = new Date("2026-01-02T00:00:00Z");
    first.release();

    expect(stateCount(limiter)).toBe(0);
  });
});

function permit(result: RateLimitPermit | LimitRejection): RateLimitPermit {
  expect("release" in result).toBe(true);
  return result as RateLimitPermit;
}

function rejection(result: RateLimitPermit | LimitRejection): LimitRejection {
  expect("release" in result).toBe(false);
  return result as LimitRejection;
}

function stateCount(limiter: InMemoryCredentialRateLimiter): number {
  return (limiter as unknown as { states: Map<string, unknown> }).states.size;
}
