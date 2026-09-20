import type { RateLimitPolicy } from "@codex-gateway/core";
import type { RouteOptions } from "fastify";

export const visionReadUrlRoute = "/gateway/vision/assets/:assetId/read-url";
export type VisionReadUrlPolicy = RateLimitPolicy & {
  requestsPerDay: number;
  concurrentRequests: number;
};

// Independent resource protection, not a multiplication of the caller's key policy.
export const defaultVisionReadUrlPolicy: Readonly<VisionReadUrlPolicy> = Object.freeze({
  requestsPerMinute: 1920,
  requestsPerDay: 80000,
  concurrentRequests: 20
});

export function resolveVisionReadUrlPolicy(
  env: NodeJS.ProcessEnv,
  override?: VisionReadUrlPolicy
): Readonly<VisionReadUrlPolicy> {
  const fields = {
    requestsPerMinute: "GATEWAY_VISION_READ_URL_REQUESTS_PER_MINUTE",
    requestsPerDay: "GATEWAY_VISION_READ_URL_REQUESTS_PER_DAY",
    concurrentRequests: "GATEWAY_VISION_READ_URL_CONCURRENT_REQUESTS"
  } as const;
  const policy = { ...defaultVisionReadUrlPolicy };
  for (const field of Object.keys(fields) as Array<keyof typeof fields>) {
    const raw = override ? override[field] : env[fields[field]];
    if (raw === undefined && !override) continue;
    if ((typeof raw !== "number" && (typeof raw !== "string" || !/^[1-9][0-9]*$/u.test(raw))) ||
        !Number.isSafeInteger(Number(raw)) || Number(raw) <= 0) {
      throw new Error(`${fields[field]} must be a finite positive safe integer.`);
    }
    policy[field] = Number(raw);
  }
  return Object.freeze(policy);
}

export function validateRateLimitProfile(route: RouteOptions): void {
  const profile = route.config?.rateLimitProfile;
  if (profile === undefined) return;
  if (profile !== "vision_read_url" || route.method !== "POST" || route.url !== visionReadUrlRoute ||
      route.config?.public || route.config?.skipAuth || route.config?.skipRateLimit) {
    throw new Error("vision_read_url rate limit profile requires its authenticated POST read-url route.");
  }
}
