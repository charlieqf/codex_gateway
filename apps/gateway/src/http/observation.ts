import type { FastifyRequest } from "fastify";
import type {
  GatewayError,
  LimitDetails,
  LimitKind,
  LimitRejection,
  ObservationStore,
  RateLimitOrigin,
  RequestTokenUsageSource,
  StreamEvent,
  TokenUsage
} from "@codex-gateway/core";

export function startObservation(request: FastifyRequest): void {
  request.gatewayObservationStartedAt = new Date();
}

export function markGatewayError(request: FastifyRequest, error: GatewayError): void {
  request.gatewayErrorCode = error.code;
  if (error.code === "rate_limited") {
    request.gatewayRateLimited = true;
    request.gatewayRateLimitOrigin ??= "unknown";
  }
}

export function markClientAborted(request: FastifyRequest): void {
  request.gatewayErrorCode = "client_aborted";
}

export function markRateLimited(request: FastifyRequest): void {
  request.gatewayErrorCode = "rate_limited";
  request.gatewayRateLimited = true;
}

export function markRateLimitOrigin(
  request: FastifyRequest,
  origin: RateLimitOrigin
): void {
  request.gatewayRateLimitOrigin = origin;
}

export function markLimitKind(
  request: FastifyRequest,
  limitKind: LimitKind,
  details?: LimitDetails
): void {
  request.gatewayLimitKind = limitKind;
  request.gatewayLimitDetails = details;
}

export function markRateLimitRejection(
  request: FastifyRequest,
  rejection: LimitRejection
): void {
  markGatewayError(request, rejection.error);
  markRateLimited(request);
  markLimitKind(request, rejection.limitKind, rejection.details);
  markRateLimitOrigin(request, "gateway");
}

export function markSession(request: FastifyRequest, sessionId: string | null): void {
  request.gatewaySessionId = sessionId;
}

export function markFirstByte(request: FastifyRequest): void {
  if (!request.gatewayObservationFirstByteAt) {
    request.gatewayObservationFirstByteAt = new Date();
  }
}

export function markProviderCallStarted(
  request: FastifyRequest,
  at = new Date()
): void {
  if (request.gatewayProviderStartedAt) {
    return;
  }
  request.gatewayProviderStartedAt = at;
  const requestStartedAt = request.gatewayObservationStartedAt;
  request.gatewayAdmittedMs = requestStartedAt
    ? Math.max(0, at.getTime() - requestStartedAt.getTime())
    : null;
}

export function markProviderEvent(
  request: FastifyRequest,
  event: StreamEvent,
  at = new Date()
): void {
  const providerStartedAt = request.gatewayProviderStartedAt;
  if (providerStartedAt && request.gatewayProviderFirstEventMs === undefined) {
    request.gatewayProviderFirstEventMs = Math.max(
      0,
      at.getTime() - providerStartedAt.getTime()
    );
  }
  if (
    event.type === "error" &&
    (event.code === "client_aborted" || event.code === "upstream_timeout")
  ) {
    request.gatewayCancelObserved = true;
  }
}

export function markProviderCallFinished(
  request: FastifyRequest,
  signal: AbortSignal,
  at = new Date()
): void {
  const providerStartedAt = request.gatewayProviderStartedAt;
  request.gatewayProviderDurationMs = providerStartedAt
    ? Math.max(0, at.getTime() - providerStartedAt.getTime())
    : null;
  request.gatewayCancelRequested = signal.aborted;
  // Migration-era rows remain nullable for rollback compatibility, but every
  // new provider attempt must record the negative case explicitly. A provider
  // error event may already have set this to true.
  request.gatewayCancelObserved ??= false;
  const reason = signal.reason;
  const reasonCode =
    reason && typeof reason === "object" && "code" in reason
      ? String(reason.code)
      : null;
  if (reasonCode === "client_aborted") {
    request.gatewayTerminalSource = "client_abort";
  } else if (reasonCode === "upstream_timeout") {
    request.gatewayTerminalSource = "gateway_deadline";
  } else if (request.gatewayErrorCode) {
    request.gatewayTerminalSource =
      request.gatewayUpstreamHttpStatus !== null &&
      request.gatewayUpstreamHttpStatus !== undefined
        ? "provider_response"
        : "transport_error";
  } else {
    request.gatewayTerminalSource = "provider_response";
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
  statusCode?: number,
  options: { refresh?: boolean } = {}
): void {
  if (
    !store ||
    (request.gatewayObservationRecorded && !options.refresh) ||
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
  const observedUpstreamAccount = request.gatewayObservedUpstreamAccount;
  const tokenUsage = request.gatewayTokenUsage;

  store.insertRequestEvent({
    requestId: request.id,
    credentialId,
    subjectId,
    scope,
    sessionId: request.gatewaySessionId ?? null,
    upstreamAccountId:
      observedUpstreamAccount !== undefined
        ? observedUpstreamAccount.id
        : upstreamAccount?.id ?? null,
    provider:
      observedUpstreamAccount !== undefined
        ? observedUpstreamAccount.provider
        : upstreamAccount?.provider ?? null,
    publicModelId: request.gatewayPublicModelId ?? null,
    upstreamRuntime: request.gatewayUpstreamRuntime ?? null,
    upstreamModel: request.gatewayUpstreamModel ?? null,
    reasoningEffort: request.gatewayReasoningEffort ?? null,
    reasoningTokens: tokenUsage?.reasoningTokens ?? null,
    clientTurnId: request.gatewayClientTurnId ?? null,
    turnCode: request.gatewayTurnCode ?? null,
    clientSessionId: request.gatewayClientSessionId ?? null,
    clientMessageId: request.gatewayClientMessageId ?? null,
    clientAppVersion: request.gatewayClientAppVersion ?? null,
    toolChoice: request.gatewayToolChoice ?? null,
    upstreamFinishReason: request.gatewayUpstreamFinishReason ?? null,
    upstreamRequestId: request.gatewayUpstreamRequestId ?? null,
    upstreamHttpStatus: request.gatewayUpstreamHttpStatus ?? null,
    upstreamContentChars: request.gatewayUpstreamContentChars ?? null,
    upstreamToolCallCount: request.gatewayUpstreamToolCallCount ?? null,
    upstreamToolNames: request.gatewayUpstreamToolNames ?? null,
    upstreamRawResponseHash: request.gatewayUpstreamRawResponseHash ?? null,
    upstreamRawResponseChars: request.gatewayUpstreamRawResponseChars ?? null,
    upstreamEmptyStop: request.gatewayUpstreamEmptyStop ?? null,
    upstreamAttemptCount: request.gatewayUpstreamAttemptCount ?? null,
    upstreamAttempts: request.gatewayUpstreamAttempts ?? null,
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
    gatewayEstimatedPromptTokens: request.gatewayEstimatedPromptTokens ?? null,
    gatewayPromptEstimateMethod: request.gatewayPromptEstimateMethod ?? null,
    modelContextTokens: request.gatewayModelContextTokens ?? null,
    modelMaxOutputTokens: request.gatewayModelMaxOutputTokens ?? null,
    promptChars: request.gatewayPromptChars ?? null,
    maximumOutputTokens: request.gatewayMaximumOutputTokens ?? null,
    gatewayAdmittedMs: request.gatewayAdmittedMs ?? null,
    providerFirstEventMs: request.gatewayProviderFirstEventMs ?? null,
    providerDurationMs: request.gatewayProviderDurationMs ?? null,
    terminalSource: request.gatewayTerminalSource ?? null,
    cancelRequested: request.gatewayCancelRequested,
    cancelObserved: request.gatewayCancelObserved,
    activeToolCount: request.gatewayActiveToolCount ?? null,
    clientToolMode: request.gatewayClientToolMode ?? null,
    toolLoopGuard: request.gatewayToolLoopGuard ?? null,
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
