import type { FastifyRequest } from "fastify";
import {
  GatewayError,
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

export async function cleanupExpiredTokenReservations(
  limiter: TokenBudgetLimiter | undefined,
  logger: TokenBudgetLogger
): Promise<void> {
  if (!limiter) {
    return;
  }
  try {
    await limiter.cleanupExpired();
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
  estimatedPromptTokens: number
): Promise<GatewayError | null> {
  if (!limiter) {
    return null;
  }

  const { subject, upstreamAccount, scope, credential } = getGatewayContext(request);
  if (!credential.id) {
    return null;
  }

  const tokenPolicy = credential.rate?.token ?? null;
  if (!tokenPolicy) {
    try {
      const softWrite = await limiter.beginSoftWrite({
        requestId: request.id,
        credentialId: credential.id,
        subjectId: subject.id,
        scope,
        upstreamAccountId: upstreamAccount.id,
        provider: upstreamAccount.provider
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
      scope,
      upstreamAccountId: upstreamAccount.id,
      provider: upstreamAccount.provider,
      policy: tokenPolicy,
      estimatedPromptTokens
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
    return new GatewayError({
      code: "service_unavailable",
      message: "Token budget service is unavailable.",
      httpStatus: 503
    });
  }
}

export async function finalizeTokenBudget(
  request: FastifyRequest,
  limiter: TokenBudgetLimiter | undefined
): Promise<void> {
  if (!limiter || !request.gatewayTokenReservationId || !request.gatewayTokenReservationKind) {
    return;
  }

  const usage = request.gatewayTokenUsage as TokenUsage | undefined;
  try {
    const result =
      request.gatewayTokenReservationKind === "soft_write"
        ? await limiter.finalizeSoftWrite({
            reservationId: request.gatewayTokenReservationId,
            requestId: request.id,
            usage
          })
        : await limiter.finalize({
            reservationId: request.gatewayTokenReservationId,
            requestId: request.id,
            usage
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

export function publicTokenPolicy(policy: TokenLimitPolicy) {
  return {
    tokensPerMinute: policy.tokensPerMinute,
    tokensPerDay: policy.tokensPerDay,
    tokensPerMonth: policy.tokensPerMonth,
    maxPromptTokensPerRequest: policy.maxPromptTokensPerRequest,
    maxTotalTokensPerRequest: policy.maxTotalTokensPerRequest
  };
}

export function publicTokenUsage(
  usage: Awaited<ReturnType<TokenBudgetLimiter["getCurrentUsage"]>>
) {
  return {
    minute: publicWindowUsage(usage.minute),
    day: publicWindowUsage(usage.day),
    month: publicWindowUsage(usage.month)
  };
}

export function estimatePromptTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

interface TokenBudgetLogger {
  warn: (obj: Record<string, unknown>, msg: string) => void;
}

function publicWindowUsage(input: {
  limit: number | null;
  used: number;
  reserved: number;
  remaining: number | null;
  windowStart: string;
}) {
  return {
    limit: input.limit,
    used: input.used,
    reserved: input.reserved,
    remaining: input.remaining,
    window_start: input.windowStart
  };
}
