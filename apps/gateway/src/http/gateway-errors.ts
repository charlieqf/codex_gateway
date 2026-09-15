import { type FastifyReply, type FastifyRequest } from "fastify";
import { credentialAllowsPublicModel, GatewayError, type PublicModelAliasGroup } from "@codex-gateway/core";
import { getGatewayContext } from "./context.js";
import {
  applyGatewayErrorHeaders,
  gatewayErrorMetadata,
  researchErrorPayload,
  type GatewayErrorResponseContext
} from "./error-response.js";
import { markGatewayError, markRateLimitOrigin } from "./observation.js";
import { type SseHandle } from "./sse.js";
import { openAIErrorPayload } from "../openai-compat.js";
import { type ResponsesSseEvent } from "../responses-compat.js";

interface ChatCompletionExecutionFailure {
  __chatCompletionExecutionFailure: true;
  error: GatewayError;
}

export function sendError(request: FastifyRequest, reply: FastifyReply, error: GatewayError) {
  markGatewayError(request, error);
  const errorContext = gatewayErrorResponseContext(request, error);
  applyGatewayErrorHeaders(reply, error, errorContext);
  reply.code(error.httpStatus);
  if (request.routeOptions.config?.responseDialect === "research") {
    return researchErrorPayload(error, errorContext);
  }
  return {
    error: {
      code: error.code,
      message: error.message,
      ...gatewayErrorMetadata(error, errorContext)
    }
  };
}

export function writeOpenAIStreamError(
  request: FastifyRequest,
  reply: FastifyReply,
  sse: SseHandle,
  error: GatewayError
): boolean {
  const errorContext = gatewayErrorResponseContext(request, error);
  const payload = openAIErrorPayload(error, errorContext);
  if (reply.raw.headersSent) {
    return sse.writeData(payload);
  }

  applyGatewayErrorHeaders(reply, error, errorContext);
  reply.raw.statusCode = error.httpStatus;
  reply.raw.setHeader("content-type", "application/json; charset=utf-8");
  reply.raw.setHeader("cache-control", "no-store");
  try {
    return reply.raw.write(JSON.stringify(payload));
  } catch {
    return false;
  }
}

export function credentialPublicModelAccessError(
  request: FastifyRequest,
  canonicalPublicModelId: string,
  aliasGroups: readonly PublicModelAliasGroup[]
): GatewayError | null {
  const { credential } = getGatewayContext(request);
  if (
    credentialAllowsPublicModel(
      credential.allowedPublicModels,
      canonicalPublicModelId,
      aliasGroups
    )
  ) {
    return null;
  }
  return new GatewayError({
    code: "model_not_allowed_for_credential",
    message: "Credential is not allowed to use this model.",
    httpStatus: 403
  });
}

export function gatewayErrorResponseContext(
  request: FastifyRequest,
  error: GatewayError
): GatewayErrorResponseContext {
  inferUpstreamRateLimitOrigin(request, error);
  if (request.gatewayVisionRecovery && request.gatewayVisionRecovery.stopReason === null) {
    request.gatewayVisionRecovery.stopReason = error.code === "client_aborted" ? "cancelled" :
      error.code === "upstream_timeout" ? "deadline_exhausted" :
      error.code === "service_unavailable" && request.gatewayVisionRecovery.budget.used === 0 ? "no_available_service" : "not_retryable";
  }
  return {
    visionRecovery: request.gatewayVisionRecovery?.snapshot(),
    requestId: request.id,
    providerFailoverEnabled: request.gatewayProviderFailoverEnabled,
    limitKind: request.gatewayLimitKind,
    limitDetails: request.gatewayLimitDetails,
    rateLimitOrigin: request.gatewayRateLimitOrigin
  };
}

function inferUpstreamRateLimitOrigin(
  request: FastifyRequest,
  error: GatewayError
): void {
  if (error.code !== "rate_limited" || request.gatewayLimitKind) {
    return;
  }
  if (
    error.upstreamStatus === 429 ||
    request.gatewayUpstreamHttpStatus === 429 ||
    request.gatewayUpstreamAttempts?.some(
      (attempt) => attempt.errorCode === "rate_limited" || attempt.upstreamHttpStatus === 429
    )
  ) {
    markRateLimitOrigin(request, "upstream");
  }
}

export function sendImageError(request: FastifyRequest, reply: FastifyReply, error: GatewayError) {
  markGatewayError(request, error);
  const errorContext = gatewayErrorResponseContext(request, error);
  applyGatewayErrorHeaders(reply, error, errorContext);
  reply.code(error.httpStatus);
  return {
    error: {
      code: error.code,
      message: error.message,
      request_id: request.id,
      ...gatewayErrorMetadata(error, errorContext)
    }
  };
}

export function sendOpenAIError(request: FastifyRequest, reply: FastifyReply, error: GatewayError) {
  markGatewayError(request, error);
  if (error.imageLimitDetails) {
    request.log.info({ request_id: request.id, image_limit: error.imageLimitDetails, upstream_attempt_count: 0 },
      "Model request input limit rejected.");
  }
  if (error.upstreamStatus !== undefined) {
    request.gatewayUpstreamHttpStatus = error.upstreamStatus;
  }
  const errorContext = gatewayErrorResponseContext(request, error);
  applyGatewayErrorHeaders(reply, error, errorContext);
  reply.code(error.httpStatus);
  return openAIErrorPayload(error, errorContext);
}

export function chatCompletionExecutionFailure(
  error: GatewayError
): ChatCompletionExecutionFailure {
  return {
    __chatCompletionExecutionFailure: true,
    error
  };
}

export function isChatCompletionExecutionFailure(
  value: unknown
): value is ChatCompletionExecutionFailure {
  return (
    typeof value === "object" &&
    value !== null &&
    "__chatCompletionExecutionFailure" in value &&
    (value as ChatCompletionExecutionFailure).__chatCompletionExecutionFailure === true
  );
}

export function chatCompletionErrorFromUnknown(err: unknown): GatewayError {
  return err instanceof GatewayError
    ? err
    : new GatewayError({
        code: "service_unavailable",
        message: "GoldenCode service is temporarily unavailable.",
        httpStatus: 503
      });
}

export function writeResponsesFailure(
  request: FastifyRequest,
  sse: SseHandle,
  frame: ResponsesSseEvent,
  error: GatewayError
): void {
  markGatewayError(request, error);
  request.gatewayErrorCode = error.code;
  if (!sse.isClosed()) {
    sse.writeEvent(frame.event, frame.data);
  }
}

export function sendGatewayErrorResponse(
  request: FastifyRequest,
  reply: FastifyReply,
  error: GatewayError
): FastifyReply {
  markGatewayError(request, error);
  return reply.code(error.httpStatus).send({
    error: {
      code: error.code,
      message: error.message,
      retry_after_seconds: error.retryAfterSeconds
    }
  });
}
