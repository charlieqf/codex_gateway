import type { FastifyReply, FastifyRequest } from "fastify";
import { GatewayError } from "@codex-gateway/core";
import type { CredentialRateLimiter } from "../services/rate-limiter.js";
import { openAIErrorPayload } from "../openai-compat.js";
import { markGatewayError, markRateLimited } from "./observation.js";

export async function rateLimitHook(
  request: FastifyRequest,
  reply: FastifyReply,
  limiter: CredentialRateLimiter
) {
  if (request.routeOptions.config?.public || request.routeOptions.config?.skipRateLimit) {
    return;
  }

  const credential = request.gatewayContext?.credential;
  if (!credential?.id || !credential.rate) {
    return;
  }

  const result = limiter.acquire({
    credentialId: credential.id,
    policy: credential.rate
  });
  if (result instanceof GatewayError) {
    markGatewayError(request, result);
    markRateLimited(request);
    reply.code(result.httpStatus).send(errorPayload(request, result));
    return;
  }

  request.gatewayRateLimitRelease = () => {
    result.release();
    request.gatewayRateLimitRelease = undefined;
  };
}

export function releaseRateLimit(request: FastifyRequest): void {
  request.gatewayRateLimitRelease?.();
}

function errorPayload(request: FastifyRequest, error: GatewayError) {
  if (request.url.startsWith("/v1/")) {
    return openAIErrorPayload(error);
  }

  return {
    error: {
      code: error.code,
      message: error.message,
      retry_after_seconds: error.retryAfterSeconds
    }
  };
}
