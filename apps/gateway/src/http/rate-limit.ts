import type { FastifyReply, FastifyRequest } from "fastify";
import { GatewayError, type RateLimitPolicy } from "@codex-gateway/core";
import type { RequestRateLimiter, RateLimitInput } from "../services/rate-limiter.js";
import { RateLimitLease } from "./rate-limit-lease.js";
import { openAIErrorPayload } from "../openai-compat.js";
import { applyGatewayErrorHeaders, gatewayErrorMetadata } from "./error-response.js";
import { markRateLimitRejection } from "./observation.js";

export async function rateLimitHook(
  request: FastifyRequest,
  reply: FastifyReply,
  limiter: RequestRateLimiter,
  visionReadUrl: { limiter: RequestRateLimiter; policy: RateLimitPolicy }
) {
  if (request.routeOptions.config?.public || request.routeOptions.config?.skipRateLimit) {
    return;
  }

  // Authentication may have awaited I/O while the client disconnected.
  request.gatewayClientDisconnect?.signal.throwIfAborted();
  const context = request.gatewayContext;
  let selected: RateLimitInput & { limiter: RequestRateLimiter };
  if (request.routeOptions.config?.rateLimitProfile === "vision_read_url") {
    if (!context?.subject.id) {
      throw new GatewayError({ code: "invalid_credential", message: "Authenticated subject required.", httpStatus: 401 });
    }
    request.gatewayRateLimitStartedAt = performance.now();
    reply.header("cache-control", "no-store");
    selected = { limiter: visionReadUrl.limiter, key: context.subject.id, scope: "subject" as const, policy: visionReadUrl.policy };
  } else {
    const credential = context?.credential;
    if (!credential?.id || !credential.rate) return;
    selected = { limiter, key: credential.id, scope: "credential" as const, policy: credential.rate };
  }

  const { limiter: selectedLimiter, ...input } = selected;
  const result = selectedLimiter.acquire(input);
  if (!("release" in result)) {
    markRateLimitRejection(request, result);
    applyGatewayErrorHeaders(reply, result.error, {
      requestId: request.id,
      limitKind: result.limitKind,
      limitDetails: result.details,
      rateLimitOrigin: "gateway"
    });
    reply.code(result.error.httpStatus).send(errorPayload(request, result.error));
    return;
  }

  const lease = new RateLimitLease(result);
  request.gatewayRateLimitLease = lease;
  request.gatewayRateLimitRelease = () => lease.release();
  // Protect also custom/injected limiters which synchronously trigger cancellation.
  if (request.gatewayClientDisconnect?.signal.aborted) {
    lease.release();
    request.gatewayClientDisconnect.signal.throwIfAborted();
  }
}

export function releaseRateLimit(request: FastifyRequest): void {
  request.gatewayRateLimitRelease?.();
}

export async function withRateLimitWork<T>(request: FastifyRequest, work: () => Promise<T>): Promise<T> {
  request.gatewayClientDisconnect?.signal.throwIfAborted();
  const end = request.gatewayRateLimitLease?.hold();
  try {
    return await work();
  } finally {
    end?.();
  }
}

export function recordRateLimitOutcome(request: FastifyRequest, statusCode: number): void {
  if (request.gatewayRateLimitStartedAt === undefined || request.gatewayRateLimitObserved) return;
  request.gatewayRateLimitObserved = true;
  request.log.info({
    request_id: request.id,
    rate_limit_profile: "vision_read_url",
    route: request.routeOptions.url,
    subject_id: request.gatewayContext?.subject.id,
    status_code: statusCode,
    limit_kind: request.gatewayLimitKind ?? null,
    limit: request.gatewayLimitDetails ?? null,
    duration_ms: performance.now() - request.gatewayRateLimitStartedAt,
    cancelled: request.gatewayClientDisconnect?.signal.aborted ?? false,
    rejected: request.gatewayRateLimited ?? false
  }, "Vision read URL request completed.");
}

function errorPayload(request: FastifyRequest, error: GatewayError) {
  if (request.url.startsWith("/v1/")) {
    return openAIErrorPayload(
      error,
      {
        requestId: request.id,
        limitKind: request.gatewayLimitKind,
        limitDetails: request.gatewayLimitDetails,
        rateLimitOrigin: request.gatewayRateLimitOrigin
      }
    );
  }

  return {
    error: {
      code: error.code,
      message: error.message,
      ...gatewayErrorMetadata(error, {
        requestId: request.id,
        limitKind: request.gatewayLimitKind,
        limitDetails: request.gatewayLimitDetails,
        rateLimitOrigin: request.gatewayRateLimitOrigin
      })
    }
  };
}
