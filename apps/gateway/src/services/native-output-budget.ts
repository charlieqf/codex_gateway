import { GatewayError, type ModelProgressEvent, type ProviderFailureClassification } from "@codex-gateway/core";
import { createChatRequestDeadline } from "./chat-request-deadline.js";

// 72-hour samples on 2026-10-28 include successful 814s/810s reasoning calls.
// Long requests reserve 60s for recovery plus 5s for teardown. Calculate the
// first attempt's time from the original deadline, including time spent queued.
// This is a first-output budget, not an idle timeout or a new request deadline.
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
  const available = remaining - NATIVE_STREAM_RECOVERY_RESERVE_MS - NATIVE_RECOVERY_TEARDOWN_MS;
  const reason = !input.enabled ? "ineligible" : !input.deadlineAt ? "finite_deadline_required" :
    (input.requestTimeoutMs ?? remaining) < NATIVE_LONG_REQUEST_MS ? "short_request" :
    available <= 0 ? "insufficient_time" : input.signal.aborted ? "request_ended" : null;
  if (input.enabled) input.onDecision?.({ remaining_ms: remaining, first_output_budget_ms: reason ? null : available,
    recovery_reserve_ms: NATIVE_STREAM_RECOVERY_RESERVE_MS, teardown_ms: NATIVE_RECOVERY_TEARDOWN_MS,
    unavailable_reason: reason });
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
    // Stop on even buffered text or partial tools. Never discard generated work
    // merely because validation has not yet allowed client delivery.
    observe: (event: ModelProgressEvent) => { if (event === "generating" || event === "validating") deadline.clearTimeout(); },
    error: () => timeoutError,
    cleanup: deadline.cleanup
  };
}
