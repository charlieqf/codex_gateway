export type ResearchLeaseRenewalDecision =
  | { outcome: "continue" }
  | { outcome: "cancel_requested" }
  | { outcome: "lease_lost" };

export type ResearchLeaseGuardResult<T> =
  | { outcome: "completed"; value: T }
  | { outcome: "cancel_requested" | "lease_lost" };

export async function runWithResearchLeaseGuard<T>(input: {
  renewalIntervalMs: number;
  renew: () =>
    | ResearchLeaseRenewalDecision
    | Promise<ResearchLeaseRenewalDecision>;
  operation: (signal: AbortSignal) => Promise<T>;
  signal?: AbortSignal;
}): Promise<ResearchLeaseGuardResult<T>> {
  if (
    !Number.isSafeInteger(input.renewalIntervalMs) ||
    input.renewalIntervalMs <= 0
  ) {
    throw new Error("renewalIntervalMs must be a positive safe integer.");
  }
  const controller = new AbortController();
  let abortOutcome: "cancel_requested" | "lease_lost" | null = null;
  let renewalInFlight = false;
  let operationSettled = false;
  let removeCallerAbort: (() => void) | undefined;
  if (input.signal) {
    const callerAbort = () => {
      abortOutcome = "lease_lost";
      controller.abort(input.signal?.reason);
    };
    if (input.signal.aborted) {
      callerAbort();
    } else {
      input.signal.addEventListener("abort", callerAbort, { once: true });
      removeCallerAbort = () =>
        input.signal?.removeEventListener("abort", callerAbort);
    }
  }

  let wakeAborted: (() => void) | undefined;
  const aborted = new Promise<void>((resolve) => {
    wakeAborted = resolve;
  });
  controller.signal.addEventListener(
    "abort",
    () => wakeAborted?.(),
    { once: true }
  );
  if (controller.signal.aborted) {
    wakeAborted?.();
  }
  const timer = setInterval(() => {
    if (renewalInFlight || operationSettled || controller.signal.aborted) {
      return;
    }
    renewalInFlight = true;
    void Promise.resolve()
      .then(() => input.renew())
      .then((decision) => {
        if (
          decision.outcome === "cancel_requested" ||
          decision.outcome === "lease_lost"
        ) {
          abortOutcome = decision.outcome;
          controller.abort(
            new Error(
              decision.outcome === "cancel_requested"
                ? "Research cancellation requested."
                : "Research lease lost."
            )
          );
        }
      })
      .catch(() => {
        abortOutcome = "lease_lost";
        controller.abort(new Error("Research lease renewal failed."));
      })
      .finally(() => {
        renewalInFlight = false;
      });
  }, input.renewalIntervalMs);

  const operation = Promise.resolve().then(() =>
    input.operation(controller.signal)
  );
  try {
    const winner = await Promise.race([
      operation.then((value) => ({ kind: "completed" as const, value })),
      aborted.then(() => ({ kind: "aborted" as const }))
    ]);
    if (winner.kind === "completed") {
      operationSettled = true;
      return { outcome: "completed", value: winner.value };
    }
    return { outcome: abortOutcome ?? "lease_lost" };
  } finally {
    operationSettled = true;
    clearInterval(timer);
    removeCallerAbort?.();
  }
}
