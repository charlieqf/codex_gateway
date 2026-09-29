import type { RateLimitPolicy } from "@codex-gateway/core";
import { InMemoryRequestRateLimiter, type RateLimitInput, type RequestRateLimiter } from "./rate-limiter.js";
import { parsePositiveIntegerEnv } from "../runtime/env.js";

// Conservative initial caps: full-object verification has substantially more
// cost than read-url signing. Keep both a per-subject and process-wide bound.
export function createVisionUploadLimits(now: () => Date, env: NodeJS.ProcessEnv = process.env) {
  const make = (concurrentRequests: number, globalConcurrent: number) => {
    const subject = new InMemoryRequestRateLimiter({ now });
    const global = new InMemoryRequestRateLimiter({ now });
    const policy: RateLimitPolicy = { requestsPerMinute: 60, requestsPerDay: null, concurrentRequests };
    const limiter: RequestRateLimiter = {
      acquire(input: RateLimitInput) {
        const permit = global.acquire({ key: "all", scope: "request", policy: {
          requestsPerMinute: Number.MAX_SAFE_INTEGER, requestsPerDay: null, concurrentRequests: globalConcurrent
        } });
        if (!("release" in permit)) return permit;
        const local = subject.acquire(input);
        if (!("release" in local)) { permit.release(); return local; }
        return { release() { local.release(); permit.release(); } };
      }
    };
    return { limiter, policy };
  };
  const subject = parsePositiveIntegerEnv(env.GATEWAY_VISION_COMPLETE_CONCURRENT_REQUESTS, 4, "GATEWAY_VISION_COMPLETE_CONCURRENT_REQUESTS");
  const global = parsePositiveIntegerEnv(env.GATEWAY_VISION_COMPLETE_GLOBAL_CONCURRENT_REQUESTS, 4, "GATEWAY_VISION_COMPLETE_GLOBAL_CONCURRENT_REQUESTS");
  return { vision_upload: make(subject, global), vision_control: make(4, 16) };
}

export type VisionUploadLimits = ReturnType<typeof createVisionUploadLimits>;
