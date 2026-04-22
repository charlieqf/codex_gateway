import type { FastifyReply, FastifyRequest } from "fastify";
import { GatewayError } from "@codex-gateway/core";
import type { CredentialRateLimiter } from "../services/rate-limiter.js";
import { markGatewayError, markRateLimited } from "./observation.js";

export async function rateLimitHook(
  request: FastifyRequest,
  reply: FastifyReply,
  limiter: CredentialRateLimiter
) {
  if (request.routeOptions.config?.public) {
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
    reply.code(result.httpStatus).send({
      error: {
        code: result.code,
        message: result.message,
        retry_after_seconds: result.retryAfterSeconds
      }
    });
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
