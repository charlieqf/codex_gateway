import { GatewayError, type ModelProgressEvent, type ProviderFailureClassification } from "@codex-gateway/core";

// 72-hour samples on 2026-10-28 include successful 814s/810s reasoning calls.
// A 900s request leaves about 60s for recovery plus 5s for teardown.
// Require at least 1s teardown slack when the request has a shorter deadline.
// This is a first-output budget, not an idle timeout or a new request deadline.
export const NATIVE_NO_OUTPUT_MS = 835_000;
export const NATIVE_STREAM_RECOVERY_RESERVE_MS = 60_000;
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
  outputCommitted: () => boolean;
}) {
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(input.signal.reason);
  if (input.signal.aborted) forwardAbort();
  else input.signal.addEventListener("abort", forwardAbort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timeoutError: GatewayError | undefined;
  const clear = () => { if (timer) clearTimeout(timer); timer = undefined; };
  const remaining = input.deadlineAt ? input.deadlineAt.getTime() - input.now().getTime() : 0;
  if (input.enabled && !controller.signal.aborted &&
      remaining >= NATIVE_NO_OUTPUT_MS + NATIVE_STREAM_RECOVERY_RESERVE_MS + 1_000) {
    timer = setTimeout(() => {
      if (controller.signal.aborted || input.outputCommitted()) return;
      timeoutError = new GatewayError({ code: "upstream_timeout", httpStatus: 504,
        message: "The model did not produce deliverable output within the first-attempt budget.",
        providerFailure: { origin: "gateway", kind: "deadline_exceeded", stage: "unknown",
          upstreamStatus: null, transportCode: NATIVE_NO_OUTPUT_CODE } });
      controller.abort(timeoutError);
    }, NATIVE_NO_OUTPUT_MS);
    timer.unref?.();
  }
  return {
    signal: controller.signal,
    // Stop on even buffered text or partial tools. Never discard generated work
    // merely because validation has not yet allowed client delivery.
    observe: (event: ModelProgressEvent) => { if (event === "generating" || event === "validating") clear(); },
    error: () => timeoutError,
    cleanup: () => { clear(); input.signal.removeEventListener("abort", forwardAbort); }
  };
}
