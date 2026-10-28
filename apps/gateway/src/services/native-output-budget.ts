import { GatewayError, type ModelProgressEvent, type ProviderFailureClassification } from "@codex-gateway/core";
import { createChatRequestDeadline } from "./chat-request-deadline.js";

// Long requests with no model activity wait at most 835s from attempt start.
// The original deadline (including time spent queued) further limits that wait
// to the remaining request budget minus 60s recovery and 5s teardown.
// A longer total budget must not delay recovery beyond the 835s attempt cap.
// T:38T3AH0N still received reasoning at 834.965s: elapsed time alone is not
// evidence that an active stream should be discarded. Once reasoning starts,
// leave it under the original deadline; actual stream failures can still recover.
// No idle threshold is inferred from these sparse samples.
export const NATIVE_LONG_REQUEST_MS = 900_000;
export const NATIVE_STREAM_RECOVERY_RESERVE_MS = 60_000;
export const NATIVE_RECOVERY_TEARDOWN_MS = 5_000;
export const NATIVE_NO_OUTPUT_CODE = "GATEWAY_NO_DELIVERABLE_OUTPUT";

export function isNativeOutputBudgetFailure(failure: ProviderFailureClassification | null | undefined): boolean {
  return failure?.origin === "gateway" && failure.kind === "deadline_exceeded" &&
    failure.transportCode === NATIVE_NO_OUTPUT_CODE;
}

export function createNativeOutputBudget(input: {
  signal: AbortSignal;
  deadlineAt: Date | null;
  now: () => Date;
  enabled: boolean;
  requestTimeoutMs?: number;
  prepareRetry: () => boolean;
  onDecision?: (fields: Record<string, unknown>) => void;
  outputCommitted: () => boolean;
}) {
  let timeoutError: GatewayError | undefined;
  const remaining = input.deadlineAt ? input.deadlineAt.getTime() - input.now().getTime() : 0;
  const available = Math.min(remaining, NATIVE_LONG_REQUEST_MS) -
    NATIVE_STREAM_RECOVERY_RESERVE_MS - NATIVE_RECOVERY_TEARDOWN_MS;
  const reason = !input.enabled ? "ineligible" : !input.deadlineAt ? "finite_deadline_required" :
    (input.requestTimeoutMs ?? remaining) < NATIVE_LONG_REQUEST_MS ? "short_request" :
    available <= 0 ? "insufficient_time" : input.signal.aborted ? "request_ended" : null;
  if (input.enabled) input.onDecision?.({ remaining_ms: remaining, first_output_budget_ms: reason ? null : available,
    recovery_reserve_ms: NATIVE_STREAM_RECOVERY_RESERVE_MS, teardown_ms: NATIVE_RECOVERY_TEARDOWN_MS,
    preserve_reasoning: true, unavailable_reason: reason });
  const deadline = createChatRequestDeadline({ timeoutMs: reason ? 0 : available,
    parentSignals: [input.signal], now: input.now(), onTimeout: () => {
      if (input.signal.aborted || input.outputCommitted()) return null;
      // Acquire a backup while the primary is still alive. If selection fails,
      // let it keep progressing under the original request deadline.
      let prepared = false;
      try { prepared = input.prepareRetry(); }
      catch {
        input.onDecision?.({ unavailable_reason: "backup_selection_failed", primary_continues: true });
        return null;
      }
      if (!prepared) {
        input.onDecision?.({ unavailable_reason: "backup_unavailable", primary_continues: true });
        return null;
      }
      timeoutError = new GatewayError({ code: "upstream_timeout", httpStatus: 504,
        message: "The model did not produce deliverable output within the first-attempt budget.",
        providerFailure: { origin: "gateway", kind: "deadline_exceeded", stage: "unknown",
          upstreamStatus: null, transportCode: NATIVE_NO_OUTPUT_CODE } });
      return timeoutError;
    } });
  return {
    signal: deadline.signal,
    // Reasoning is upstream work, not client delivery. Disarm only this local
    // cutoff; keep the parent's deadline/cancellation and failure recovery intact.
    // Buffered text and partial tools also remain protected before delivery.
    observe: (event: ModelProgressEvent) => {
      if (event === "reasoning" || event === "generating" || event === "validating") deadline.clearTimeout();
    },
    error: () => timeoutError,
    cleanup: deadline.cleanup
  };
}
