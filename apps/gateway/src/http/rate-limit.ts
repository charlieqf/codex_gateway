import type { FastifyReply, FastifyRequest } from "fastify";
import type { GatewayError } from "@codex-gateway/core";
import type { CredentialRateLimiter } from "../services/rate-limiter.js";
import { openAIErrorPayload } from "../openai-compat.js";
import { applyGatewayErrorHeaders, gatewayErrorMetadata } from "./error-response.js";
import { markRateLimitRejection } from "./observation.js";

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
