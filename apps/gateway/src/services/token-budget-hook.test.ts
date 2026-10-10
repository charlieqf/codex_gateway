import { expect, it, vi } from "vitest";
import type { FastifyRequest } from "fastify";
import type { TokenBudgetLimiter, TokenChargeDecision } from "@codex-gateway/core";
import { finalizeTokenBudget } from "./token-budget-hook.js";

it.each(["reservation", "soft_write"] as const)("passes the server charge decision through %s finalization", async kind => {
  const charge: TokenChargeDecision = { reason: "empty_response", exemptAttempts: [1],
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
  const finalize = vi.fn(async () => ({ reservationId: "reservation", kind, finalTotalTokens: 10,
    finalUsageSource: "provider" as const, overRequestLimit: false }));
  const limiter = { finalize, finalizeSoftWrite: finalize } as unknown as TokenBudgetLimiter;
  const request = { id: "request", gatewayTokenReservationId: "reservation", gatewayTokenReservationKind: kind,
    gatewayUserCharge: charge, gatewayTokenUsage: { promptTokens: 10, completionTokens: 0, totalTokens: 10 }
  } as unknown as FastifyRequest;
  await finalizeTokenBudget(request, limiter);
  expect(finalize).toHaveBeenLastCalledWith(expect.objectContaining({ charge, usage: { totalTokens: 10, promptTokens: 10, completionTokens: 0 } }));
  for (const state of [
    { gatewayCancelRequested: true },
    { gatewayErrorCode: "client_aborted" },
    { gatewayErrorCode: "upstream_timeout" },
    { gatewayClientDisconnect: { signal: AbortSignal.abort() } }
  ]) {
    await finalizeTokenBudget({ ...request, ...state } as FastifyRequest, limiter);
    expect(finalize).toHaveBeenLastCalledWith(expect.objectContaining({ charge: undefined }));
  }
});
