import type { FastifyRequest } from "fastify";
import {
  GatewayError,
  publicTokenPolicy,
  type PlanEntitlementStore,
  type TokenBudgetLimiter,
  type TokenLimitPolicy,
  type TokenUsage
} from "@codex-gateway/core";
import { getGatewayContext } from "../http/context.js";
import {
  markGatewayError,
  markLimitKind,
  markRateLimited,
  markTokenFinalizeResult,
  markTokenReservation
} from "../http/observation.js";
import {
  resolveEntitlementAccessForChat,
  type ResolvedEntitlementAccess
} from "./entitlement-access.js";

export { publicTokenPolicy, publicTokenUsage } from "@codex-gateway/core";

export async function cleanupExpiredTokenReservations(
  limiter: TokenBudgetLimiter | undefined,
  logger: TokenBudgetLogger,
  now: Date = new Date()
): Promise<void> {
  if (!limiter) {
    return;
  }
  try {
    await limiter.cleanupExpired(now);
  } catch (err) {
    logger.warn(
      { error: err instanceof Error ? err.message : String(err) },
      "Token reservation cleanup failed."
    );
  }
}

export async function beginTokenBudget(
  request: FastifyRequest,
  limiter: TokenBudgetLimiter | undefined,
  estimatedPromptTokens: number,
  options: {
    entitlementStore?: PlanEntitlementStore;
    requireEntitlement?: boolean;
    resolvedAccess?: ResolvedEntitlementAccess;
    now?: () => Date;
  } = {}
): Promise<GatewayError | null> {
  const { subject, upstreamAccount, scope, credential } = getGatewayContext(request);
  if (!credential.id) {
    return null;
  }

  let entitlementId: string | null = null;
  let entitlementPeriodStart: Date | null = null;
  let entitlementPeriodEnd: Date | null = null;
  let tokenPolicy = credential.rate?.token ?? null;
  const now = options.now?.() ?? new Date();
  try {
    if (options.resolvedAccess) {
      entitlementId = options.resolvedAccess.entitlementId;
      entitlementPeriodStart = options.resolvedAccess.entitlementPeriodStart;
      entitlementPeriodEnd = options.resolvedAccess.entitlementPeriodEnd;
      tokenPolicy = options.resolvedAccess.tokenPolicy;
    } else {
      const access = resolveEntitlementAccessForChat({
        context: { subject, scope, credential },
        entitlementStore: options.entitlementStore,
        requireEntitlement: options.requireEntitlement,
        now
      });
      if (access instanceof GatewayError) {
        return access;
      }
      entitlementId = access.entitlementId;
      entitlementPeriodStart = access.entitlementPeriodStart;
      entitlementPeriodEnd = access.entitlementPeriodEnd;
      tokenPolicy = access.tokenPolicy;
    }
  } catch (err) {
    request.log.error(
      {
        request_id: request.id,
        credential_id: credential.id,
        error: err instanceof Error ? err.message : String(err)
      },
      "Plan entitlement check failed."
    );
    return new GatewayError({
      code: "service_unavailable",
      message: "Plan entitlement service is unavailable.",
      httpStatus: 503
    });
  }

  if (!limiter) {
    return null;
  }

  if (!tokenPolicy) {
    try {
      const softWrite = await limiter.beginSoftWrite({
        requestId: request.id,
        credentialId: credential.id,
        subjectId: subject.id,
        entitlementId,
        entitlementPeriodStart,
        entitlementPeriodEnd,
        scope,
        upstreamAccountId: upstreamAccount.id,
        provider: upstreamAccount.provider,
        publicModelId: request.gatewayPublicModelId ?? null,
        upstreamRuntime: request.gatewayUpstreamRuntime ?? null,
        upstreamModel: request.gatewayUpstreamModel ?? null,
        reasoningEffort: request.gatewayReasoningEffort ?? null,
        now
      });
      markTokenReservation(request, softWrite.reservationId, "soft_write");
    } catch (err) {
      request.log.warn(
        {
          request_id: request.id,
          credential_id: credential.id,
          error: err instanceof Error ? err.message : String(err)
        },
        "Soft token usage ledger write failed; continuing request for credential without token policy."
      );
    }
    return null;
  }

  try {
    const result = await limiter.acquire({
      requestId: request.id,
      credentialId: credential.id,
      subjectId: subject.id,
      entitlementId,
      entitlementPeriodStart,
      entitlementPeriodEnd,
      scope,
      upstreamAccountId: upstreamAccount.id,
      provider: upstreamAccount.provider,
      publicModelId: request.gatewayPublicModelId ?? null,
      upstreamRuntime: request.gatewayUpstreamRuntime ?? null,
      upstreamModel: request.gatewayUpstreamModel ?? null,
      reasoningEffort: request.gatewayReasoningEffort ?? null,
      policy: tokenPolicy,
      estimatedPromptTokens,
      now
    });
    if (!result.ok) {
      markGatewayError(request, result.error);
      markRateLimited(request);
      markLimitKind(request, result.limitKind);
      return result.error;
    }
    markTokenReservation(request, result.reservationId, "reservation");
    return null;
  } catch (err) {
    request.log.error(
      {
        request_id: request.id,
        credential_id: credential.id,
        error: err instanceof Error ? err.message : String(err)
      },
      "Token budget acquire failed."
    );
    return new GatewayError({
      code: "service_unavailable",
      message: "Token budget service is unavailable.",
      httpStatus: 503
    });
  }
}

export async function finalizeTokenBudget(
  request: FastifyRequest,
  limiter: TokenBudgetLimiter | undefined,
  options: {
    now?: () => Date;
  } = {}
): Promise<void> {
  if (!limiter || !request.gatewayTokenReservationId || !request.gatewayTokenReservationKind) {
    return;
  }

  const usage = request.gatewayTokenUsage as TokenUsage | undefined;
  const now = options.now?.() ?? new Date();
  try {
    const result =
      request.gatewayTokenReservationKind === "soft_write"
        ? await limiter.finalizeSoftWrite({
            reservationId: request.gatewayTokenReservationId,
            requestId: request.id,
            usage,
            now
          })
        : await limiter.finalize({
            reservationId: request.gatewayTokenReservationId,
            requestId: request.id,
            usage,
            now
          });
    markTokenFinalizeResult(request, result);
  } catch (err) {
    const tokenPolicy = getGatewayContext(request).credential.rate?.token ?? null;
    const level = tokenPolicy ? "error" : "warn";
    request.log[level](
      {
        request_id: request.id,
        reservation_id: request.gatewayTokenReservationId,
        error: err instanceof Error ? err.message : String(err)
      },
      "Token reservation finalization failed."
    );
  }
}

export function publicRatePolicy<T extends { token?: TokenLimitPolicy | null }>(
  policy: T | null
) {
  if (!policy) {
    return policy;
  }
  const { token, ...rest } = policy;
  return {
    ...rest,
    ...(token ? { token: publicTokenPolicy(token) } : {})
  };
}

export function estimatePromptTokens(text: string, extraText = ""): number {
  return Math.max(1, Math.ceil((text.length + extraText.length) / 3));
}

interface TokenBudgetLogger {
  warn: (obj: Record<string, unknown>, msg: string) => void;
}
