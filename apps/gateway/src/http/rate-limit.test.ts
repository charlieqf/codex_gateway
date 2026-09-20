import { describe, expect, it, vi } from "vitest";
import type { FastifyReply, FastifyRequest } from "fastify";
import { GatewayError } from "@codex-gateway/core";
import { rateLimitHook, releaseRateLimit, withRateLimitWork } from "./rate-limit.js";

function fixture() {
  const controller = new AbortController();
  const release = vi.fn();
  const ordinary = { acquire: vi.fn(() => ({ release })) };
  const images = { limiter: { acquire: vi.fn(() => ({ release })) }, policy: { requestsPerMinute: 100, requestsPerDay: 1000, concurrentRequests: 20 } };
  const request = {
    routeOptions: { config: { rateLimitProfile: "vision_read_url" } },
    gatewayContext: { subject: { id: "subject" }, credential: { id: null, rate: null } },
    gatewayClientDisconnect: { signal: controller.signal }
  } as unknown as FastifyRequest;
  const reply = { header: vi.fn() } as unknown as FastifyReply;
  return { controller, release, ordinary, images, request, reply };
}

describe("request rate limit admission races", () => {
  it("applies the subject budget even when the authenticated context has no credential rate", async () => {
    const f = fixture();
    await rateLimitHook(f.request, f.reply, f.ordinary, f.images);
    expect(f.ordinary.acquire).not.toHaveBeenCalled();
    expect(f.images.limiter.acquire).toHaveBeenCalledExactlyOnceWith({ key: "subject", scope: "subject", policy: f.images.policy });
    releaseRateLimit(f.request); releaseRateLimit(f.request);
    expect(f.release).toHaveBeenCalledOnce();
  });

  it("does not acquire after an earlier disconnect", async () => {
    const f = fixture(); const reason = new Error("cancelled");
    f.controller.abort(reason);
    await expect(rateLimitHook(f.request, f.reply, f.ordinary, f.images)).rejects.toBe(reason);
    expect(f.images.limiter.acquire).not.toHaveBeenCalled();
  });

  it("releases a permit when disconnect happens inside acquisition", async () => {
    const f = fixture(); const reason = new Error("cancelled");
    f.images.limiter.acquire.mockImplementation(() => {
      f.controller.abort(reason); releaseRateLimit(f.request);
      return { release: f.release };
    });
    await expect(rateLimitHook(f.request, f.reply, f.ordinary, f.images)).rejects.toBe(reason);
    releaseRateLimit(f.request);
    expect(f.release).toHaveBeenCalledOnce();
  });

  it("never starts work after disconnect or an already-ended lease", async () => {
    const f = fixture(); const work = vi.fn(async () => true);
    await rateLimitHook(f.request, f.reply, f.ordinary, f.images);
    releaseRateLimit(f.request);
    await expect(withRateLimitWork(f.request, work)).rejects.toThrow("ended");
    f.controller.abort(new Error("cancelled"));
    await expect(withRateLimitWork(f.request, work)).rejects.toThrow("cancelled");
    expect(work).not.toHaveBeenCalled();
    expect(f.release).toHaveBeenCalledOnce();
  });

  it("fails closed without an authenticated subject", async () => {
    const f = fixture(); f.request.gatewayContext = undefined;
    await expect(rateLimitHook(f.request, f.reply, f.ordinary, f.images)).rejects.toBeInstanceOf(GatewayError);
    expect(f.images.limiter.acquire).not.toHaveBeenCalled();
  });
});
