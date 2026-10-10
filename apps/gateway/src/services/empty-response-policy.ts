import type { TokenChargeDecision, TokenUsage } from "@codex-gateway/core";
import type { ProviderStreamSummary } from "./provider-stream.js";

/** Require positive terminal evidence, not merely an absence of received bytes. */
export function isRecoverableEmptyResponse(summary: ProviderStreamSummary | null | undefined): boolean {
  if (!summary) return false;
  const progress = summary.streamProgress ?? summary.attempts[0]?.streamProgress;
  return summary.completed && summary.errorCode === "upstream_empty_response" &&
    summary.failure?.origin === "provider" && summary.failure.kind === "response_body_missing" &&
    summary.failure.stage === "streaming" && summary.upstreamHttpStatus === 200 &&
    (summary.finishReason === "network_error" || summary.finishReason === "stop") &&
    summary.terminationKind === "finish_reason_and_done" && summary.attempts.length === 1 &&
    summary.contentChars === 0 && summary.semanticOutputChars === 0 && summary.visibleOutputChars === 0 && summary.toolCallCount === 0 &&
    (summary.totalToolArgumentBytes ?? 0) === 0 && !summary.streamIncomplete && !summary.outputLimitHit &&
    !summary.argumentBudgetExceeded && progress !== undefined &&
    progress.reasoningChars === 0 && progress.observedToolCallCount === 0 && progress.toolArgumentBytes === 0;
}

/** Called only by native text recovery, after checking cancellation/delivery. */
export function emptyResponseCharge(summaries: ProviderStreamSummary[], expectedAttempts?: number): TokenChargeDecision | undefined {
  const exemptAttempts: number[] = [];
  let offset = 0;
  for (const summary of summaries) {
    if (isRecoverableEmptyResponse(summary)) exemptAttempts.push(offset + 1);
    offset += summary.attempts.length;
  }
  if (!exemptAttempts.length || (expectedAttempts !== undefined && offset !== expectedAttempts)) return undefined;
  const billable = summaries.filter(summary => !isRecoverableEmptyResponse(summary));
  // Unknown or partially delivered failures keep existing accounting rules.
  if (billable.some(summary => summary.errorCode || !summary.completed)) return undefined;
  const usage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0,
    cachedPromptTokens: 0, reasoningTokens: 0 };
  for (const summary of billable) {
    if (!summary.usage) return { reason: "empty_response", exemptAttempts, usage: null };
    usage.promptTokens += summary.usage.promptTokens;
    usage.completionTokens += summary.usage.completionTokens;
    usage.totalTokens += summary.usage.totalTokens;
    usage.cachedPromptTokens! += summary.usage.cachedPromptTokens ?? 0;
    usage.reasoningTokens! += summary.usage.reasoningTokens ?? 0;
  }
  return { reason: "empty_response", exemptAttempts, usage };
}
