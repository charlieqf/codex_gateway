import type { FastifyRequest } from "fastify";
import type {
  GatewayError,
  ObservationStore,
  RequestTokenUsageSource,
  TokenUsage
} from "@codex-gateway/core";

export function startObservation(request: FastifyRequest): void {
  request.gatewayObservationStartedAt = new Date();
}

export function markGatewayError(request: FastifyRequest, error: GatewayError): void {
  request.gatewayErrorCode = error.code;
  if (error.code === "rate_limited") {
    request.gatewayRateLimited = true;
  }
}

export function markRateLimited(request: FastifyRequest): void {
  request.gatewayErrorCode = "rate_limited";
  request.gatewayRateLimited = true;
}

export function markSession(request: FastifyRequest, sessionId: string | null): void {
  request.gatewaySessionId = sessionId;
}

export function markFirstByte(request: FastifyRequest): void {
  if (!request.gatewayObservationFirstByteAt) {
    request.gatewayObservationFirstByteAt = new Date();
  }
}

export function markTokenUsage(
  request: FastifyRequest,
  usage: TokenUsage | undefined,
  source: RequestTokenUsageSource = "provider"
): void {
  if (!usage) {
    return;
  }

  request.gatewayTokenUsage = usage;
  request.gatewayTokenUsageSource = source;
}

export function recordObservation(
  request: FastifyRequest,
  store: ObservationStore | undefined,
  statusCode?: number
): void {
  if (!store || request.gatewayObservationRecorded || request.routeOptions.config?.public) {
    return;
  }

  const startedAt = request.gatewayObservationStartedAt;
  if (!startedAt) {
    return;
  }

  request.gatewayObservationRecorded = true;
  const completedAt = new Date();
  const context = request.gatewayContext;
  const observedCredential = request.gatewayObservedCredential;
  const credentialId = context?.credential.id ?? observedCredential?.id ?? null;
  const subjectId = context?.subject.id ?? observedCredential?.subjectId ?? null;
  const scope = context?.scope ?? observedCredential?.scope ?? null;
  const subscription = context?.subscription ?? null;
  const tokenUsage = request.gatewayTokenUsage;

  store.insertRequestEvent({
    requestId: request.id,
    credentialId,
    subjectId,
    scope,
    sessionId: request.gatewaySessionId ?? null,
    subscriptionId: subscription?.id ?? null,
    provider: subscription?.provider ?? null,
    startedAt,
    durationMs: completedAt.getTime() - startedAt.getTime(),
    firstByteMs: firstByteMs(request, completedAt),
    status: isErrorResponse(request, statusCode) ? "error" : "ok",
    errorCode: request.gatewayErrorCode ?? null,
    rateLimited: request.gatewayRateLimited === true,
    promptTokens: tokenUsage?.promptTokens ?? null,
    completionTokens: tokenUsage?.completionTokens ?? null,
    totalTokens: tokenUsage?.totalTokens ?? null,
    cachedPromptTokens: tokenUsage?.cachedPromptTokens ?? null,
    estimatedTokens: request.gatewayEstimatedTokens ?? null,
    usageSource: tokenUsage ? request.gatewayTokenUsageSource ?? "provider" : null
  });
}

function firstByteMs(request: FastifyRequest, completedAt: Date): number {
  const startedAt = request.gatewayObservationStartedAt;
  if (!startedAt) {
    return 0;
  }

  const firstByteAt = request.gatewayObservationFirstByteAt ?? completedAt;
  return Math.max(0, firstByteAt.getTime() - startedAt.getTime());
}

function isErrorResponse(request: FastifyRequest, statusCode: number | undefined): boolean {
  return Boolean(request.gatewayErrorCode) || (statusCode ?? 200) >= 400;
}
