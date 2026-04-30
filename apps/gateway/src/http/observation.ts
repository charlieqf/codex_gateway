import type { FastifyRequest } from "fastify";
import type {
  GatewayError,
  LimitKind,
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

export function markLimitKind(request: FastifyRequest, limitKind: LimitKind): void {
  request.gatewayLimitKind = limitKind;
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

export function markTokenReservation(
  request: FastifyRequest,
  reservationId: string,
  kind: "reservation" | "soft_write"
): void {
  request.gatewayTokenReservationId = reservationId;
  request.gatewayTokenReservationKind = kind;
}

export function markTokenFinalizeResult(
  request: FastifyRequest,
  result: { finalTotalTokens: number; finalUsageSource: RequestTokenUsageSource | "soft_write"; overRequestLimit: boolean }
): void {
  request.gatewayOverRequestLimit = result.overRequestLimit;
  if (!request.gatewayTokenUsage && result.finalTotalTokens > 0) {
    // No provider usage was recorded, so observation falls back to the finalized charge amount.
    request.gatewayEstimatedTokens = result.finalTotalTokens;
    request.gatewayTokenUsageSource =
      result.finalUsageSource === "soft_write" ? "provider" : result.finalUsageSource;
  }
}

export function markIdentityGuardHit(request: FastifyRequest): void {
  request.gatewayIdentityGuardHit = true;
  request.gatewayTokenUsage = {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cachedPromptTokens: 0
  };
  request.gatewayTokenUsageSource = "none";
}

export function recordObservation(
  request: FastifyRequest,
  store: ObservationStore | undefined,
  statusCode?: number
): void {
  if (
    !store ||
    request.gatewayObservationRecorded ||
    request.routeOptions.config?.public ||
    request.routeOptions.config?.skipObservation
  ) {
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
  const upstreamAccount = context?.upstreamAccount ?? null;
  const tokenUsage = request.gatewayTokenUsage;

  store.insertRequestEvent({
    requestId: request.id,
    credentialId,
    subjectId,
    scope,
    sessionId: request.gatewaySessionId ?? null,
    upstreamAccountId: upstreamAccount?.id ?? null,
    provider: upstreamAccount?.provider ?? null,
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
    estimatedTokens: tokenUsage ? null : request.gatewayEstimatedTokens ?? null,
    usageSource: requestUsageSource(request, tokenUsage),
    limitKind: request.gatewayLimitKind ?? null,
    reservationId: request.gatewayTokenReservationId ?? null,
    overRequestLimit: request.gatewayOverRequestLimit === true,
    identityGuardHit: request.gatewayIdentityGuardHit === true
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

function requestUsageSource(
  request: FastifyRequest,
  tokenUsage: TokenUsage | undefined
): RequestTokenUsageSource | null {
  if (request.gatewayTokenUsageSource) {
    return request.gatewayTokenUsageSource;
  }
  if (tokenUsage) {
    return "provider";
  }
  return null;
}
