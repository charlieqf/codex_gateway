import { type FastifyRequest } from "fastify";
import { type ProviderErrorDiagnostic } from "@codex-gateway/core";
import { markRateLimitOrigin, markTokenUsage } from "./observation.js";
import { type ChatCompletionRequest, type OpenAIChatUsage } from "../openai-compat.js";
import {
  type ProviderStreamAttemptContext,
  type ProviderStreamSummary
} from "../services/provider-stream.js";
import { type ChatRuntimeContext } from "../services/chat-runtime-dispatcher.js";
import { serializeToolChoice } from "../services/chat-request-shaping.js";

export function markOpenAITokenUsage(
  request: FastifyRequest,
  usage: OpenAIChatUsage | null
): void {
  if (!usage) {
    return;
  }

  markTokenUsage(request, {
    promptTokens: usage.prompt_tokens,
    completionTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens,
    ...(usage.prompt_tokens_details?.cached_tokens !== undefined
      ? { cachedPromptTokens: usage.prompt_tokens_details.cached_tokens }
      : {}),
    ...(usage.completion_tokens_details?.reasoning_tokens !== undefined
      ? { reasoningTokens: usage.completion_tokens_details.reasoning_tokens }
      : {})
  });
}

export function createProviderErrorLogger(
  request: FastifyRequest
): (diagnostic: ProviderErrorDiagnostic) => void {
  return (diagnostic) => {
    if (diagnostic.rawStatus !== undefined) {
      request.gatewayUpstreamHttpStatus = diagnostic.rawStatus;
    }
    if (diagnostic.code === "rate_limited" || diagnostic.rawStatus === 429) {
      markRateLimitOrigin(request, "upstream");
    }
    request.gatewayProviderFailure = diagnostic.failure;
    request.log.warn(
      {
        request_id: request.id,
        session_id: request.gatewaySessionId ?? null,
        provider:
          request.gatewayObservedUpstreamAccount?.provider ??
          request.gatewayContext?.upstreamAccount.provider ??
          null,
        provider_error: {
          source: diagnostic.source,
          code: diagnostic.code,
          public_message: diagnostic.publicMessage,
          raw_message: diagnostic.rawMessage,
          ...(diagnostic.rawName ? { raw_name: diagnostic.rawName } : {}),
          ...(diagnostic.rawCode ? { raw_code: diagnostic.rawCode } : {}),
          ...(diagnostic.rawStatus !== undefined ? { raw_status: diagnostic.rawStatus } : {}),
          failure_origin: diagnostic.failure.origin,
          failure_kind: diagnostic.failure.kind,
          failure_stage: diagnostic.failure.stage,
          transport_code: diagnostic.failure.transportCode,
          upstream_status: diagnostic.failure.upstreamStatus
        }
      },
      "Provider returned sanitized error."
    );
  };
}

export function applyClientTurnHeaders(
  request: FastifyRequest,
  fallbackClientSessionId?: string | null
): void {
  request.gatewayClientTurnId = readSingleHeader(request, "x-medcode-client-turn-id", 128);
  request.gatewayTurnCode = readSingleHeader(request, "x-medcode-client-turn-code", 64);
  request.gatewayClientSessionId =
    readSingleHeader(request, "x-medcode-client-session-id", 128) ??
    fallbackClientSessionId ??
    null;
  request.gatewayClientMessageId = readSingleHeader(request, "x-medcode-client-message-id", 128);
  request.gatewayClientAppVersion = readSingleHeader(request, "x-medcode-client-app-version", 64);
}

function readSingleHeader(
  request: FastifyRequest,
  name: string,
  maxLength: number
): string | null {
  const raw = request.headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength) {
    return null;
  }
  return trimmed;
}

export function chatRuntimeAttemptContext(
  runtime: ChatRuntimeContext,
  kind: string,
  toolChoice: ChatCompletionRequest["toolChoice"]
): ProviderStreamAttemptContext {
  return {
    kind,
    toolChoice: serializeToolChoice(toolChoice),
    provider: runtime.providerKind,
    upstreamRuntime: runtime.runtime,
    upstreamModel: runtime.upstreamModel,
    upstreamAccountId: runtime.adapterInputUpstreamAccount.id
  };
}

export function markProviderStreamSummary(
  request: FastifyRequest,
  summary: ProviderStreamSummary | null
): void {
  if (!summary) {
    return;
  }
  markTokenUsage(request, summary.usage ?? undefined);
  if (
    summary.errorCode === "rate_limited" ||
    summary.upstreamHttpStatus === 429 ||
    summary.attempts.some(
      (attempt) => attempt.errorCode === "rate_limited" || attempt.upstreamHttpStatus === 429
    )
  ) {
    markRateLimitOrigin(request, "upstream");
  }
  request.gatewayUpstreamFinishReason = summary.finishReason;
  request.gatewayUpstreamRequestId = summary.upstreamRequestId;
  request.gatewayUpstreamHttpStatus = summary.upstreamHttpStatus;
  request.gatewayUpstreamContentChars = summary.contentChars;
  request.gatewayUpstreamToolCallCount = summary.toolCallCount;
  request.gatewayUpstreamToolNames = summary.toolNames;
  request.gatewayUpstreamRawResponseHash = summary.rawResponseHash;
  request.gatewayUpstreamRawResponseChars = summary.rawResponseChars;
  request.gatewayUpstreamEmptyStop = summary.emptyStop;
  request.gatewayUpstreamAttemptCount = summary.attempts.length;
  const vision = request.gatewayVisionRecovery?.snapshot();
  request.gatewayUpstreamAttempts = summary.attempts.map((attempt, index) => ({ ...attempt,
    ...(vision && index === summary.attempts.length - 1 ? { visionRecovery: {
      imageCount: vision.image_count, callsUsed: vision.attempts, maximumCalls: vision.maximum_attempts,
      contentDelivered: vision.content_delivered, stopReason: vision.stop_reason
    } } : {})
  }));
  if (vision) request.log.info({ request_id: request.id, modality: "vision", ...vision }, "Vision request recovery assessed.");
  request.gatewayProviderFailure = summary.failure;
}
