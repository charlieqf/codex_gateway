import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewayError } from "@codex-gateway/core";
import { VisionRequestRecovery, runVisionRequestRecovery } from "./vision-request-recovery.js";
import type { NativeCallBudget } from "./native-tool-failover.js";
import { attachProviderStreamSummary, ProviderStreamSummaryCollector, providerStreamSummaryFromError } from "./provider-stream.js";

function failure(status = 500) {
  return new GatewayError({ code: status === 429 ? "rate_limited" : "upstream_unavailable", message: "synthetic",
    httpStatus: 503, upstreamStatus: status,
    providerFailure: { origin: "provider", kind: status === 429 ? "http_rate_limit" : "http_server",
      stage: "after_headers", upstreamStatus: status, transportCode: null } });
}

describe("vision recovery shared budget and deadline", () => {
  afterEach(() => vi.useRealTimers());

  it.each(["cancelled", "deadline_exhausted"] as const)("does not start a call after %s", async (reason) => {
    const state = new VisionRequestRecovery(4);
    const controller = new AbortController();
    if (reason === "cancelled") controller.abort();
    const execute = vi.fn(async () => ({ providerSummary: null }));
    const result = await runVisionRequestRecovery({ recovery: state, signal: controller.signal,
      deadlineAt: reason === "deadline_exhausted" ? new Date(0) : null, now: () => new Date(),
      outputCommitted: () => false, execute });
    expect(execute).not.toHaveBeenCalled();
    expect(result).toMatchObject({ code: reason === "cancelled" ? "client_aborted" : "upstream_timeout" });
    expect(state.snapshot()).toMatchObject({ attempts: 0, stop_reason: reason });
  });

  it("replaces a completed result with cancellation without losing its attempt evidence", async () => {
    const state = new VisionRequestRecovery(4);
    const controller = new AbortController();
    const result = await runVisionRequestRecovery({ recovery: state, signal: controller.signal,
      deadlineAt: null, now: () => new Date(), outputCommitted: () => false,
      execute: async (budget) => {
        budget.consume();
        controller.abort();
        return { providerSummary: new ProviderStreamSummaryCollector().snapshot() };
      } });
    expect(result).toMatchObject({ code: "client_aborted", httpStatus: 499 });
    expect(state.snapshot()).toMatchObject({ attempts: 1, stop_reason: "cancelled" });
  });

  it.each([400, 401, 403, 404, 501, 505])("does not replay HTTP %i even under upstream_unavailable", async (status) => {
    const state = new VisionRequestRecovery(4);
    expect(await state.prepareRetry({ error: failure(status), signal: new AbortController().signal,
      deadlineAt: null, now: () => new Date(), outputCommitted: false })).toBe(false);
    expect(state.stopReason).toBe("not_retryable");
  });

  it("counts tool repair against the same two-call budget and retains attempt evidence", async () => {
    const state = new VisionRequestRecovery(4);
    const execute = vi.fn(async (budget: NativeCallBudget) => {
      budget.consume(); // generation
      budget.consume(); // tool repair
      return attachProviderStreamSummary(failure(), new ProviderStreamSummaryCollector().snapshot());
    });
    const result = await runVisionRequestRecovery({ recovery: state, signal: new AbortController().signal,
      deadlineAt: null, now: () => new Date(), outputCommitted: () => false, execute });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(state.snapshot()).toMatchObject({ attempts: 2, stop_reason: "calls_exhausted" });
    expect(result).toBeInstanceOf(GatewayError);
    if (!(result instanceof GatewayError)) throw new Error("Expected terminal failure");
    expect(providerStreamSummaryFromError(result)).not.toBeNull();
  });

  it("requires explicit Retry-After and refuses a wait beyond the remaining deadline", async () => {
    const state = new VisionRequestRecovery(4);
    const options = { signal: new AbortController().signal, deadlineAt: new Date(5000),
      now: () => new Date(0), outputCommitted: false };
    expect(await state.prepareRetry({ ...options, error: failure(429) })).toBe(false);
    expect(state.stopReason).toBe("retry_after_missing");
    const limited = new GatewayError({ ...failure(429), message: "limited", upstreamRetryAfterSeconds: 6 });
    expect(await state.prepareRetry({ ...options, error: limited })).toBe(false);
    expect(state.stopReason).toBe("deadline_insufficient");
  });

  it("honors cancellation during the retry wait without starting another provider call", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const state = new VisionRequestRecovery(4);
    const pending = state.prepareRetry({ error: failure(), signal: controller.signal,
      deadlineAt: new Date(Date.now() + 10000), now: () => new Date(), outputCommitted: false });
    controller.abort(new GatewayError({ code: "client_aborted", message: "cancelled", httpStatus: 499 }));
    expect(await pending).toBe(false);
    expect(state.stopReason).toBe("cancelled");
    expect(state.budget.used).toBe(0);
  });

  it("waits the provider delay and does not reset the request deadline", async () => {
    vi.useFakeTimers();
    const state = new VisionRequestRecovery(4);
    const start = Date.now();
    const pending = state.prepareRetry({ error: new GatewayError({ ...failure(429), message: "limited", upstreamRetryAfterSeconds: 2 }),
      signal: new AbortController().signal, deadlineAt: new Date(start + 5000), now: () => new Date(), outputCommitted: false });
    await vi.advanceTimersByTimeAsync(2000);
    expect(await pending).toBe(true);
    expect(Date.now() - start).toBe(2000);
  });

  it("never replays delivered content or buffered partial output", async () => {
    const state = new VisionRequestRecovery(4);
    const options = { error: failure(), signal: new AbortController().signal,
      deadlineAt: null, now: () => new Date(), outputCommitted: true };
    expect(await state.prepareRetry(options)).toBe(false);
    expect(state.stopReason).toBe("content_delivered");
    const collector = new ProviderStreamSummaryCollector();
    collector.record({ type: "message_delta", text: "partial" });
    const buffered = new VisionRequestRecovery(4);
    expect(await buffered.prepareRetry({ ...options, outputCommitted: false, summary: collector.snapshot() })).toBe(false);
    expect(buffered.stopReason).toBe("response_started");
  });
});
