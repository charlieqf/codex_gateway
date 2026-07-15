import type { FastifyReply } from "fastify";
import type {
  GatewayError,
  LimitDetails,
  LimitKind,
  RateLimitOrigin
} from "@codex-gateway/core";

export interface GatewayErrorResponseContext {
  requestId?: string | null;
  limitKind?: LimitKind | null;
  limitDetails?: LimitDetails | null;
  rateLimitOrigin?: RateLimitOrigin | null;
}

export function applyGatewayErrorHeaders(
  reply: FastifyReply,
  error: GatewayError,
  context: GatewayErrorResponseContext = {}
): void {
  if (error.retryAfterSeconds !== undefined) {
    reply.header("retry-after", String(error.retryAfterSeconds));
  }
  if (context.limitKind) {
    reply.header("x-gateway-limit-kind", context.limitKind);
  }
  if (error.code === "rate_limited") {
    reply.header("x-gateway-rate-limit-origin", rateLimitOrigin(context));
  }
}

export function gatewayErrorMetadata(
  error: GatewayError,
  context: GatewayErrorResponseContext = {}
) {
  const isRateLimited = error.code === "rate_limited";
  const retryAfterSeconds =
    error.retryAfterSeconds ?? (isRateLimited && error.httpStatus === 429 ? null : undefined);

  return {
    ...(context.requestId && isRateLimited ? { request_id: context.requestId } : {}),
    ...(retryAfterSeconds !== undefined
      ? { retry_after_seconds: retryAfterSeconds }
      : {}),
    ...(isRateLimited
      ? {
          rate_limit_contract_version: 1,
          limit_kind: context.limitKind ?? null,
          rate_limit_origin: rateLimitOrigin(context)
        }
      : {}),
    ...(context.limitDetails
      ? {
          limit: {
            scope: context.limitDetails.scope,
            window: context.limitDetails.window,
            maximum: context.limitDetails.limit,
            used: context.limitDetails.used,
            ...(context.limitDetails.requested !== undefined
              ? { requested: context.limitDetails.requested }
              : {})
          }
        }
      : {})
  };
}

function rateLimitOrigin(context: GatewayErrorResponseContext): RateLimitOrigin {
  return context.rateLimitOrigin ?? (context.limitKind ? "gateway" : "unknown");
}
