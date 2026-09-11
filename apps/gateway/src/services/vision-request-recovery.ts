import { setTimeout as delay } from "node:timers/promises";
import { GatewayError } from "@codex-gateway/core";
import { NativeCallBudget } from "./native-tool-failover.js";
import {
  attachProviderStreamSummary, combineProviderStreamSummaries, combineSuccessfulProviderStreamSummaries,
  providerStreamSummaryFromError, type ProviderStreamSummary
} from "./provider-stream.js";

export const visionRecoveryRequestHeader = "x-medcode-vision-recovery-contract";
export type VisionRetryStopReason = "calls_exhausted" | "deadline_exhausted" | "deadline_insufficient" | "content_delivered" |
  "response_started" | "cancelled" | "not_retryable" | "retry_after_missing" | "no_available_service";

export class VisionRequestRecovery {
  readonly budget = new NativeCallBudget();
  contentDelivered = false;
  stopReason: VisionRetryStopReason | null = null;

  constructor(readonly imageCount: number) {}

  snapshot() {
    return { image_count: this.imageCount, attempts: this.budget.used, maximum_attempts: 2,
      content_delivered: this.contentDelivered, stop_reason: this.stopReason };
  }

  endError(input: { signal: AbortSignal; deadlineAt: Date | null; now: () => Date }): GatewayError | null {
    if (!input.signal.aborted && (!input.deadlineAt || input.now() < input.deadlineAt)) return null;
    const reason = input.signal.reason;
    const cancelled = input.signal.aborted && !(reason instanceof GatewayError && reason.code === "upstream_timeout");
    this.stopReason = cancelled ? "cancelled" : "deadline_exhausted";
    return reason instanceof GatewayError ? reason : new GatewayError({
      code: cancelled ? "client_aborted" : "upstream_timeout", httpStatus: cancelled ? 499 : 504,
      message: cancelled ? "本次图片分析已取消。" : "图片分析响应超时，本次请求未完成。"
    });
  }

  async prepareRetry(input: {
    error: GatewayError; summary?: ProviderStreamSummary | null; signal: AbortSignal;
    deadlineAt: Date | null; now: () => Date; outputCommitted: boolean;
  }): Promise<boolean> {
    this.contentDelivered ||= input.outputCommitted;
    const stop = (reason: VisionRetryStopReason) => { this.stopReason = reason; return false; };
    if (this.endError(input)) return false;
    if (this.contentDelivered) return stop("content_delivered");
    const failure = input.error.providerFailure;
    const retryable = ["upstream_unavailable", "upstream_timeout", "rate_limited"].includes(input.error.code) && failure && (
      failure.origin === "provider" && ["after_headers", "streaming"].includes(failure.stage) &&
        [408, 429, 500, 502, 503, 504].includes(failure.upstreamStatus ?? 0) ||
      failure.origin === "network" && failure.stage === "before_headers" &&
        ["connect", "connection_reset", "headers_timeout"].includes(failure.kind)
    );
    if (!retryable) return stop("not_retryable");
    if (this.budget.remaining <= 0) return stop("calls_exhausted");
    if (input.summary && (input.summary.semanticOutputChars > 0 || input.summary.toolCallCount > 0)) {
      return stop("response_started");
    }
    const rateLimited = failure?.upstreamStatus === 429;
    if (rateLimited && input.error.upstreamRetryAfterSeconds === undefined) return stop("retry_after_missing");
    const waitMs = rateLimited ? Math.max(250, input.error.upstreamRetryAfterSeconds! * 1000) : 250;
    // Reserve at least one second for the next call; waiting never resets the deadline.
    if (input.deadlineAt && input.deadlineAt.getTime() - input.now().getTime() < waitMs + 1000) {
      return stop(input.now() >= input.deadlineAt ? "deadline_exhausted" : "deadline_insufficient");
    }
    try { await delay(waitMs, undefined, { signal: input.signal }); }
    catch { return stop(input.signal.reason instanceof GatewayError &&
      input.signal.reason.code === "upstream_timeout" ? "deadline_exhausted" : "cancelled"); }
    if (this.endError(input)) return false;
    if (input.deadlineAt && input.deadlineAt.getTime() - input.now().getTime() < 1000) return stop("deadline_insufficient");
    this.stopReason = null;
    return true;
  }
}

// The same budget is passed to tool repair and every repeated execution. A retry
// reuses this vision runtime instead of excluding its only provider account.
export async function runVisionRequestRecovery<T extends { providerSummary: ProviderStreamSummary | null }>(input: {
  recovery: VisionRequestRecovery; signal: AbortSignal; deadlineAt: Date | null; now: () => Date;
  outputCommitted: () => boolean; execute: (budget: NativeCallBudget, retry: boolean) => Promise<T | GatewayError>;
}): Promise<T | GatewayError> {
  const summaries: ProviderStreamSummary[] = [];
  const finish = (error: GatewayError) => {
    const finalError = input.signal.aborted && input.signal.reason instanceof GatewayError ? input.signal.reason : error;
    const summary = combineProviderStreamSummaries(summaries);
    return summary ? attachProviderStreamSummary(finalError, { ...summary, completed: false, failure: finalError.providerFailure ?? null },
      { preserveAttemptOutcomes: true }) : finalError;
  };
  while (true) {
    const beforeCallError = input.recovery.endError(input);
    if (beforeCallError) return finish(beforeCallError);
    const result = await input.execute(input.recovery.budget, summaries.length > 0);
    const summary = result instanceof GatewayError ? providerStreamSummaryFromError(result) : result.providerSummary;
    if (summary) summaries.push(summary);
    const afterCallError = input.recovery.endError(input);
    if (afterCallError) return finish(afterCallError);
    if (!(result instanceof GatewayError)) return { ...result, providerSummary: combineSuccessfulProviderStreamSummaries(summaries) };
    if (!await input.recovery.prepareRetry({ error: result, summary, signal: input.signal,
      deadlineAt: input.deadlineAt, now: input.now, outputCommitted: input.outputCommitted() })) {
      return finish(input.recovery.endError(input) ?? result);
    }
  }
}
