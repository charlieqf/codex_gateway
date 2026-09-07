import { GatewayError } from "@codex-gateway/core";
import type { ChatRuntimeContext } from "./chat-runtime-dispatcher.js";
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

export function canFailoverNativeError(error: GatewayError, summary = providerStreamSummaryFromError(error)): boolean {
  const failure = error.providerFailure;
  if (!failure || (summary && (summary.semanticOutputChars > 0 || summary.toolCallCount > 0))) return false;
  if (!["upstream_unavailable", "upstream_timeout", "rate_limited"].includes(error.code)) return false;
  if (failure.origin === "provider" && failure.stage === "after_headers") {
    const status = failure.upstreamStatus;
    return status === 402 || status === 408 || status === 429 || (status !== null && status >= 500 && status <= 599);
  }
  return failure.origin === "network" && failure.stage === "before_headers";
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
  while (true) {
    const beforeCallError = requestEndError();
    if (beforeCallError) return withHistory(beforeCallError, summaries);
    const result = await input.execute(runtime, budget);
    const summary = result instanceof GatewayError ? providerStreamSummaryFromError(result) : result.providerSummary;
    if (summary) summaries.push(summary);
    const afterCallError = requestEndError();
    if (afterCallError) return withHistory(afterCallError, summaries);
    if (!(result instanceof GatewayError)) {
      runtime.recordSuccess();
      return { ...result, providerSummary: combineSuccessfulProviderStreamSummaries(summaries) };
    }
    if (result.code !== "client_aborted") runtime.recordError(result);
    const canRetry = budget.remaining > 0 && canFailoverNativeError(result) &&
      !input.signal.aborted && !input.outputCommitted() &&
      (!input.deadlineAt || input.deadlineAt.getTime() - input.now().getTime() >= 1000) && runtime.beginRetry;
    if (!canRetry) return withHistory(result, summaries);
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
      unavailable_reason: next instanceof GatewayError ? next.code : null });
    if (next instanceof GatewayError) return withHistory(result, summaries);
  }
}

function withHistory(error: GatewayError, summaries: ProviderStreamSummary[]): GatewayError {
  const combined = combineProviderStreamSummaries(summaries);
  if (!combined) return error;
  // Each execution already recorded its outcome. Cancellation must not rewrite that history.
  return attachProviderStreamSummary(error, { ...combined, completed: false, failure: error.providerFailure ?? null },
    { preserveAttemptOutcomes: true });
}
