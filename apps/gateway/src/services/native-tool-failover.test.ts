import { describe, expect, it, vi } from "vitest";
import { GatewayError } from "@codex-gateway/core";
import { canFailoverNativeError, NativeCallBudget, nativeFailoverEnabled, runNativeToolFailover } from "./native-tool-failover.js";
import type { ChatRuntimeContext } from "./chat-runtime-dispatcher.js";
import { attachProviderStreamSummary, providerStreamSummaryFromError, ProviderStreamSummaryCollector } from "./provider-stream.js";

describe("native failover eligibility", () => {
  it.each([402, 408, 429, 500, 502, 503, 504])("allows provider HTTP %i", (status) => {
    expect(canFailoverNativeError(new GatewayError({ code: "upstream_unavailable", message: "failed", httpStatus: 502,
      providerFailure: { origin: "provider", kind: "http_request", stage: "after_headers", upstreamStatus: status, transportCode: null }
    }))).toBe(true);
  });
  it.each([400, 401, 403, 404])("does not switch for provider HTTP %i", (status) => {
    expect(canFailoverNativeError(new GatewayError({ code: "upstream_unavailable", message: "failed", httpStatus: 502,
      providerFailure: { origin: "provider", kind: "http_request", stage: "after_headers", upstreamStatus: status, transportCode: null }
    }))).toBe(false);
  });
  it("does not treat local admission or already generated content as retryable", () => {
    expect(canFailoverNativeError(new GatewayError({ code: "rate_limited", message: "user limit", httpStatus: 429 }))).toBe(false);
    const error = new GatewayError({ code: "upstream_unavailable", message: "reset", httpStatus: 503,
      providerFailure: { origin: "network", kind: "connection_reset", stage: "before_headers", upstreamStatus: null, transportCode: "ECONNRESET" } });
    expect(canFailoverNativeError(error)).toBe(true);
    const collector = new ProviderStreamSummaryCollector();
    collector.record({ type: "message_delta", text: "partial" });
    expect(canFailoverNativeError(attachProviderStreamSummary(error, collector.snapshot()))).toBe(false);
  });
  it("counts actual calls and rejects invalid configuration", () => {
    const budget = new NativeCallBudget();
    budget.consume(); budget.consume();
    expect(budget.remaining).toBe(0);
    expect(() => budget.consume()).toThrow();
    expect(nativeFailoverEnabled(undefined)).toBe(false);
    expect(nativeFailoverEnabled("enforce")).toBe(true);
    expect(() => nativeFailoverEnabled("true")).toThrow();
  });
  it("does not enable failover for a classified body timeout during streaming", () => {
    expect(canFailoverNativeError(new GatewayError({ code: "upstream_timeout", message: "timed out", httpStatus: 504,
      providerFailure: { origin: "network", kind: "body_timeout", stage: "streaming", upstreamStatus: 200, transportCode: "UND_ERR_BODY_TIMEOUT" }
    }))).toBe(false);
  });
});

describe("native failover request lifecycle", () => {
  const failure = () => new GatewayError({ code: "upstream_unavailable", message: "reset", httpStatus: 503,
    providerFailure: { origin: "network", kind: "connection_reset", stage: "before_headers", upstreamStatus: null, transportCode: "ECONNRESET" } });
  const context = () => ({ runtime: "tiankuan", runtimeInstanceId: "tiankuan",
    release: vi.fn(), recordError: vi.fn(() => true), recordSuccess: vi.fn(), beginRetry: vi.fn()
  } as unknown as ChatRuntimeContext);

  it.each(["cancel", "deadline", "committed", "short-deadline"])("does not dispatch another call after %s", async (reason) => {
    const runtime = context();
    const controller = new AbortController();
    let now = new Date(0);
    const execute = vi.fn(async (_runtime, budget: NativeCallBudget) => {
      budget.consume();
      if (reason === "cancel") controller.abort(new GatewayError({ code: "client_aborted", message: "cancelled", httpStatus: 499 }));
      if (reason === "deadline") now = new Date(5000);
      return failure();
    });
    const result = await runNativeToolFailover({ runtime, signal: controller.signal,
      deadlineAt: new Date(reason === "short-deadline" ? 999 : 5000), now: () => now,
      outputCommitted: () => reason === "committed", execute, selected: vi.fn() });
    expect(result).toBeInstanceOf(GatewayError);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(runtime.beginRetry).not.toHaveBeenCalled();
    expect(runtime.recordSuccess).not.toHaveBeenCalled();
    if (reason === "cancel") expect((result as GatewayError).code).toBe("client_aborted");
    if (reason === "deadline") expect((result as GatewayError).code).toBe("upstream_timeout");
  });

  it("does not dispatch a selected fallback when cancellation arrives during selection", async () => {
    const runtime = context();
    const next = context();
    const controller = new AbortController();
    vi.mocked(runtime.beginRetry!).mockReturnValue(next);
    const collector = new ProviderStreamSummaryCollector();
    collector.record({ type: "error", code: "upstream_unavailable", message: "reset", providerFailure: failure().providerFailure });
    const firstFailure = attachProviderStreamSummary(failure(), collector.snapshot());
    const execute = vi.fn(async (_runtime, budget: NativeCallBudget) => { budget.consume(); return firstFailure; });
    let current = runtime;
    try {
      const result = await runNativeToolFailover({ runtime, signal: controller.signal, deadlineAt: null,
        now: () => new Date(), outputCommitted: () => false, execute,
        selected: (value) => { current = value; controller.abort(); } });
      expect((result as GatewayError).code).toBe("client_aborted");
      expect(providerStreamSummaryFromError(result as GatewayError)?.attempts).toMatchObject([
        { errorCode: "upstream_unavailable", failure: { origin: "network", kind: "connection_reset" } }
      ]);
      expect(execute).toHaveBeenCalledTimes(1);
    } finally { current.release(); }
    expect(runtime.release).toHaveBeenCalledTimes(1);
    expect(next.release).toHaveBeenCalledTimes(1);
  });

  it("preserves the original failure when no fallback can acquire a lease", async () => {
    const runtime = context();
    const original = failure();
    vi.mocked(runtime.beginRetry!).mockReturnValue(new GatewayError({ code: "rate_limited", message: "busy", httpStatus: 429 }));
    const execute = vi.fn(async (_runtime, budget: NativeCallBudget) => { budget.consume(); return original; });
    const result = await runNativeToolFailover({ runtime, signal: new AbortController().signal, deadlineAt: null,
      now: () => new Date(), outputCommitted: () => false, execute, selected: vi.fn() });
    expect(result).toBe(original);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(runtime.release).toHaveBeenCalledTimes(1);
  });

  it("does not mark a late success healthy after cancellation", async () => {
    const runtime = context();
    const controller = new AbortController();
    const result = await runNativeToolFailover({ runtime, signal: controller.signal, deadlineAt: null,
      now: () => new Date(), outputCommitted: () => false, selected: vi.fn(), execute: async (_runtime, budget) => {
        budget.consume(); controller.abort(); return { providerSummary: null };
      } });
    expect((result as GatewayError).code).toBe("client_aborted");
    expect(runtime.recordSuccess).not.toHaveBeenCalled();
  });
});
