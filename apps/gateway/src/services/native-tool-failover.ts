import { GatewayError } from "@codex-gateway/core";
import type { ChatRuntimeContext } from "./chat-runtime-dispatcher.js";
import { emptyResponseCharge, isRecoverableEmptyResponse } from "./empty-response-policy.js";
import { isNativeOutputBudgetFailure, NATIVE_STREAM_RECOVERY_RESERVE_MS } from "./native-output-budget.js";
import {
  attachProviderStreamSummary,
  combineProviderStreamSummaries,
  combineSuccessfulProviderStreamSummaries,
  providerStreamSummaryFromError,
  type ProviderStreamSummary
} from "./provider-stream.js";

/** Shared by initial generation, tool repair and provider failover. */
export class NativeCallBudget {
  used = 0;
  get remaining(): number { return 2 - this.used; }
  consume(): void {
    if (this.remaining <= 0) throw new Error("Native provider call budget exhausted.");
    this.used += 1;
  }
}

export function nativeFailoverEnabled(value: string | undefined): boolean {
  if (!value || value === "disabled") return false;
  if (value === "enforce") return true;
  throw new Error("GATEWAY_GOLDENCODE_NATIVE_FAILOVER_MODE must be disabled or enforce.");
}

export function canFailoverNativeError(error: GatewayError, summary = providerStreamSummaryFromError(error), allowReasoningStream = false): boolean {
  const failure = error.providerFailure;
  if (allowReasoningStream && isRecoverableReasoningStream(error, summary)) return true;
  if (!failure || (summary && (summary.semanticOutputChars > 0 || summary.toolCallCount > 0))) return false;
  if (error.code === "upstream_empty_response") return isRecoverableEmptyResponse(summary);
  if (!["upstream_unavailable", "upstream_timeout", "rate_limited"].includes(error.code)) return false;
  if (failure.origin === "provider" && failure.stage === "after_headers") {
    const status = failure.upstreamStatus;
    return status === 402 || status === 408 || status === 429 || (status !== null && status >= 500 && status <= 599);
  }
  return failure.origin === "network" && failure.stage === "before_headers";
}

/** Positive parser evidence is required; absence of a delivered chunk alone is insufficient. */
export function isRecoverableReasoningStream(error: GatewayError, summary = providerStreamSummaryFromError(error)): boolean {
  const failure = error.providerFailure;
  if (!summary || !failure || summary.completed || summary.finishReason !== null || summary.attempts.length !== 1 ||
      summary.contentChars !== 0 || summary.visibleOutputChars !== 0 || summary.toolCallCount !== 0 ||
      (summary.totalToolArgumentBytes ?? 0) !== 0) return false;
  const progress = summary.streamProgress;
  if (!progress || progress.observedToolCallCount !== 0 || progress.toolArgumentBytes !== 0) return false;
  if (error.code === "upstream_timeout" && isNativeOutputBudgetFailure(failure)) return true;
  if (summary.upstreamHttpStatus !== 200 || progress.reasoningChars <= 0 ||
      failure.stage !== "streaming") return false;
  return (error.code === "upstream_unavailable" && failure.origin === "network" && failure.kind === "connection_reset") ||
    (error.code === "upstream_incomplete_stream" && failure.kind === "stream_incomplete" &&
      summary.terminationKind === "eof_before_terminal");
}

/** Caller retains ownership of the final lease, including when execution throws. */
export async function runNativeToolFailover<T extends { providerSummary: ProviderStreamSummary | null }>(input: {
  runtime: ChatRuntimeContext;
  signal: AbortSignal;
  deadlineAt: Date | null;
  now: () => Date;
  outputCommitted: () => boolean;
  execute: (runtime: ChatRuntimeContext, budget: NativeCallBudget) => Promise<T | GatewayError>;
  selected: (runtime: ChatRuntimeContext) => void;
  onDecision?: (fields: Record<string, unknown>) => void;
}): Promise<T | GatewayError> {
  const budget = new NativeCallBudget();
  const excluded = new Set<string>();
  const summaries: ProviderStreamSummary[] = [];
  const requestEndError = (): GatewayError | null => {
    if (!input.signal.aborted && (!input.deadlineAt || input.now() < input.deadlineAt)) return null;
    return input.signal.reason instanceof GatewayError ? input.signal.reason : new GatewayError({
      code: input.signal.aborted ? "client_aborted" : "upstream_timeout",
      message: "Request ended before native completion could be delivered.",
      httpStatus: input.signal.aborted ? 499 : 504
    });
  };
  let runtime = input.runtime;
  let pendingRetry: { error: GatewayError; minimumRemainingMs: number } | undefined;
  while (true) {
    const beforeCallError = requestEndError();
    if (beforeCallError) return withHistory(beforeCallError, summaries);
    if (pendingRetry && (input.outputCommitted() ||
        (input.deadlineAt && input.deadlineAt.getTime() - input.now().getTime() < pendingRetry.minimumRemainingMs))) {
      input.onDecision?.({ from: runtime.runtime, to: null, calls_used: budget.used,
        unavailable_reason: input.outputCommitted() ? "output_committed" : "insufficient_time_after_selection" });
      return withHistory(pendingRetry.error, summaries, !input.outputCommitted(), budget.used);
    }
    const result = await input.execute(runtime, budget);
    const summary = result instanceof GatewayError ? providerStreamSummaryFromError(result) : result.providerSummary;
    if (summary) summaries.push(summary);
    const afterCallError = requestEndError();
    if (afterCallError) return withHistory(afterCallError, summaries);
    if (!(result instanceof GatewayError)) {
      runtime.recordSuccess();
      const combined = preserveUnknownReasoningUsage(combineSuccessfulProviderStreamSummaries(summaries), summaries);
      if (combined && !input.outputCommitted()) combined.userCharge = emptyResponseCharge(summaries, budget.used);
      return { ...result, providerSummary: combined };
    }
    // Spending our first-output budget is not evidence of an unhealthy provider.
    if (result.code !== "client_aborted" && !isNativeOutputBudgetFailure(result.providerFailure)) {
      runtime.recordError(result);
    }
    const reasoningRecovery = isRecoverableReasoningStream(result);
    const remainingMs = input.deadlineAt ? input.deadlineAt.getTime() - input.now().getTime() : null;
    const minimumRemainingMs = reasoningRecovery ? NATIVE_STREAM_RECOVERY_RESERVE_MS : 1000;
    const canRetry = budget.remaining > 0 && canFailoverNativeError(result, summary, true) &&
      !input.signal.aborted && !input.outputCommitted() &&
      (remainingMs === null ? !reasoningRecovery : remainingMs >= minimumRemainingMs) && runtime.beginRetry;
    if (!canRetry) {
      input.onDecision?.({ from: runtime.runtime, to: null, reason: result.providerFailure,
        calls_used: budget.used, remaining_ms: remainingMs, output_committed: input.outputCommitted(),
        recovery_kind: reasoningRecovery ? "reasoning_stream" : "native",
        unavailable_reason: budget.remaining <= 0 ? "call_budget_exhausted" : input.outputCommitted() ? "output_committed" :
          remainingMs === null && reasoningRecovery ? "finite_deadline_required" :
          remainingMs !== null && remainingMs < minimumRemainingMs ? "insufficient_time" : "ineligible_or_unavailable" });
      return withHistory(result, summaries, !input.outputCommitted(), budget.used);
    }
    excluded.add(runtime.runtimeInstanceId);
    const previous = runtime;
    previous.release();
    const next = previous.beginRetry!({ excludeAccountIds: excluded });
    if (!(next instanceof GatewayError)) {
      runtime = next;
      input.selected(next);
    }
    input.onDecision?.({ from: previous.runtime, to: next instanceof GatewayError ? null : next.runtime,
      reason: result.providerFailure, calls_used: budget.used,
      remaining_ms: remainingMs, recovery_kind: reasoningRecovery ? "reasoning_stream" : "native",
      unavailable_reason: next instanceof GatewayError ? next.code : null });
    if (next instanceof GatewayError) return withHistory(result, summaries, !input.outputCommitted(), budget.used);
    pendingRetry = { error: result, minimumRemainingMs };
  }
}

function withHistory(error: GatewayError, summaries: ProviderStreamSummary[], allowChargeDecision = false, expectedAttempts?: number): GatewayError {
  const combined = preserveUnknownReasoningUsage(combineProviderStreamSummaries(summaries), summaries);
  if (!combined) return error;
  if (allowChargeDecision) combined.userCharge = emptyResponseCharge(summaries, expectedAttempts);
  // Each execution already recorded its outcome. Cancellation must not rewrite that history.
  return attachProviderStreamSummary(error, { ...combined, completed: false, failure: error.providerFailure ?? null },
    { preserveAttemptOutcomes: true });
}

function preserveUnknownReasoningUsage(combined: ProviderStreamSummary | null, summaries: ProviderStreamSummary[]): ProviderStreamSummary | null {
  // A fallback's usage is not the usage of both calls. Keep per-attempt reports,
  // and use the existing reservation's missing-usage policy for the request.
  if (combined && summaries.some(summary =>
    (!summary.usage && (summary.streamProgress?.reasoningChars ?? 0) > 0) ||
    summary.attempts.some(attempt => attempt.totalTokens === null && (attempt.streamProgress?.reasoningChars ?? 0) > 0))) {
    combined.usage = null;
  }
  return combined;
}
