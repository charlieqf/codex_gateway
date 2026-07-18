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

export type ResearchErrorCode = "research_quota_exceeded";

export interface ResearchErrorResponseContext extends GatewayErrorResponseContext {
  researchCode?: ResearchErrorCode | null;
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

export function gatewayErrorRetryable(error: GatewayError): boolean {
  return (
    error.code === "rate_limited" ||
    error.code === "upstream_timeout" ||
    error.code === "upstream_unavailable" ||
    error.code === "upstream_incomplete_stream" ||
    error.code === "upstream_empty_response" ||
    error.code === "research_worker_unavailable" ||
    error.code === "research_storage_unavailable" ||
    error.code === "service_unavailable"
  );
}

export function researchErrorPayload(
  error: GatewayError,
  context: ResearchErrorResponseContext
) {
  const { request_id: _requestId, ...rateLimitMetadata } =
    error.code === "rate_limited" || error.retryAfterSeconds !== undefined
      ? gatewayErrorMetadata(error, context)
      : {};
  return {
    schema_version: "doctor_research_error.v1",
    request_id: context.requestId ?? null,
    error: {
      code: error.code,
      ...(context.researchCode ? { research_code: context.researchCode } : {}),
      message: error.message,
      ...rateLimitMetadata
    }
  };
}

function rateLimitOrigin(context: GatewayErrorResponseContext): RateLimitOrigin {
  return context.rateLimitOrigin ?? (context.limitKind ? "gateway" : "unknown");
}
