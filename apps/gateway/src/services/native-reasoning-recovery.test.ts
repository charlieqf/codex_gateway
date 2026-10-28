import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayError, type ModelProgressEvent } from "@codex-gateway/core";
import { runNativeWithFailover } from "./native-client-tools.js";
import { OpenAICompatibleProviderAdapter } from "./openai-compatible-provider.js";
import type { ChatRuntimeContext } from "./chat-runtime-dispatcher.js";
import { providerStreamSummaryFromError } from "./provider-stream.js";
import { createChatRequestDeadline } from "./chat-request-deadline.js";
import { NATIVE_STREAM_RECOVERY_RESERVE_MS, NATIVE_RECOVERY_TEARDOWN_MS } from "./native-output-budget.js";
import type { FastifyRequest } from "fastify";
import { markProviderCallFinished, markProviderEvent } from "../http/observation.js";
import { markProviderStreamSummary } from "../http/provider-telemetry.js";

const reset = () => new TypeError("terminated", { cause: Object.assign(new Error("socket closed"), { code: "UND_ERR_SOCKET" }) });
const delta = (value: object) => ({ choices: [{ delta: value }] });
const NATIVE_NO_OUTPUT_MS = 900_000 - NATIVE_STREAM_RECOVERY_RESERVE_MS - NATIVE_RECOVERY_TEARDOWN_MS;

function fixture(timeoutMs = 900_000, options: { failover?: boolean; model?: string; headersPending?: boolean; setupMs?: number; abortDelayMs?: number; images?: boolean } = {}) {
  const parent = new AbortController();
  const deadline = createChatRequestDeadline({ timeoutMs: timeoutMs - (options.setupMs ?? 0), parentSignals: [parent.signal] });
  const streams: Array<{
    send: (value: object) => void; fail: () => void; eof: () => void; finish: (toolArgs?: string, usage?: boolean) => void;
    signal: AbortSignal; cancelled: boolean;
  }> = [];
  const progress: ModelProgressEvent[] = [];
  const order: string[] = [];
  const requests: Array<Record<string, unknown>> = [];
  const observation = {} as FastifyRequest;
  let committed = false;
  function runtime(id: "tokenswitch" | "tencent"): ChatRuntimeContext {
    const adapter = new OpenAICompatibleProviderAdapter({ providerKind: id, apiKey: "test", apiKeyEnv: "UNUSED",
      baseUrl: "https://synthetic.invalid/v1", upstreamModel: "glm-5.3", timeoutMs,
      reasoningParameterStyle: "effort_field", fetchImpl: async (_url, init) => {
        order.push(`call:${id}`);
        requests.push(JSON.parse(String(init?.body)));
        const signal = init!.signal!;
        if (options.headersPending && requests.length === 1) {
          return new Promise<Response>((_resolve, reject) => {
            if (signal.aborted) reject(signal.reason);
            else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
        }
        let stream!: ReadableStreamDefaultController<Uint8Array>;
        const body = new ReadableStream<Uint8Array>({ start: value => { stream = value; },
          cancel: () => { state.cancelled = true; signal.removeEventListener("abort", abort); } });
        const send = (text: string) => stream.enqueue(new TextEncoder().encode(text));
        const abort = () => { state.cancelled = true; order.push(`abort:${id}`);
          if (options.abortDelayMs) setTimeout(() => stream.error(signal.reason), options.abortDelayMs);
          else stream.error(signal.reason);
          signal.removeEventListener("abort", abort); };
        const state = { signal, cancelled: false,
          send: (value: object) => send(`data: ${JSON.stringify(value)}\n\n`),
          fail: () => { stream.error(reset()); signal.removeEventListener("abort", abort); },
          eof: () => { stream.close(); signal.removeEventListener("abort", abort); },
          finish: (toolArgs?: string, usage = true) => {
            state.send({ choices: [{ delta: toolArgs === undefined ? { content: "answer" } :
              { tool_calls: [{ index: 0, id: "call_test", function: { name: "lookup", arguments: toolArgs } }] },
              finish_reason: toolArgs === undefined ? "stop" : "tool_calls" }],
              ...(usage ? { usage: { prompt_tokens: 7, completion_tokens: 5, total_tokens: 12 } } : {}) });
            send("data: [DONE]\n\n"); stream.close(); signal.removeEventListener("abort", abort);
          } };
        streams.push(state);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
        return new Response(body, { status: 200 });
      } });
    return { publicModelId: options.model ?? "goldencode", runtime: id, runtimeInstanceId: id,
      providerKind: id, upstreamModel: "glm-5.3", reasoningEffort: "high", limits: { contextWindow: 200000, maxOutputTokens: 64000 },
      adapter, adapterInputUpstreamAccount: { id, provider: id, label: id, credentialRef: "ENV:UNUSED", state: "active", lastUsedAt: null, cooldownUntil: null },
      subject: { id: "subject", label: "test", state: "active", createdAt: new Date() }, scope: "code",
      session: { id: "session", subjectId: "subject", upstreamAccountId: id, publicModelId: "goldencode",
        providerSessionRef: null, title: null, state: "active", createdAt: new Date(), updatedAt: new Date() },
      release: vi.fn(() => { order.push(`release:${id}`); }), recordSuccess: vi.fn(), recordError: vi.fn(() => true),
      beginRetry: vi.fn() };
  }
  const first = runtime("tokenswitch"), second = runtime("tencent");
  first.beginRetry = vi.fn(() => { order.push("acquire:tencent"); return second; });
  second.beginRetry = vi.fn(() => { throw new Error("third attempt forbidden"); });
  let selected = first;
  const decisions: Record<string, unknown>[] = [];
  const budgetDecisions: Record<string, unknown>[] = [];
  const promise = runNativeWithFailover({ runtime: first, provider: first.adapter, upstreamAccount: first.adapterInputUpstreamAccount,
    upstreamRuntime: first.runtime, upstreamModel: first.upstreamModel, subject: first.subject, scope: first.scope,
    session: first.session, reasoningEffort: "high", failover: options.failover ?? true,
    signal: deadline.signal, deadlineAt: deadline.deadlineAt, requestTimeoutMs: timeoutMs, now: () => new Date(),
    selected: next => { selected = next; order.push(`select:${next.runtime}`); }, outputCommitted: () => committed,
    onProviderEvent: event => markProviderEvent(observation, event),
    onModelProgress: event => progress.push(event), log: { info: (fields, message) =>
      (message === "Native first-output budget assessed." ? budgetDecisions : decisions).push(fields), warn: vi.fn() },
    request: { model: "goldencode", stream: true, messages: [{ role: "user", content: "Continue after previous tool result" }],
      ...(options.images ? { images: [{ imageUrl: "https://synthetic.invalid/image.png" }] } : {}),
      tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }],
      toolChoice: "auto", maximumOutputTokens: 64000 }, prompt: "Continue after previous tool result",
    nativeToolForceRequiredMode: "disabled",
    nativeFileToolRecoveryPolicy: { mode: "error", softArgumentBytes: 100000, hardArgumentBytes: null, canaryPercent: 100 }
  }).then(result => {
    if (result instanceof GatewayError) observation.gatewayErrorCode = result.code;
    markProviderStreamSummary(observation, result instanceof GatewayError ? providerStreamSummaryFromError(result) : result.providerSummary);
    markProviderCallFinished(observation, deadline.signal);
    return result;
  }).finally(() => { selected.release(); deadline.cleanup(); });
  return { parent, deadline, streams, first, second, progress, order, requests, promise, decisions, budgetDecisions, observation,
    selected: () => selected, commit: () => { committed = true; } };
}
const flush = () => vi.advanceTimersByTimeAsync(0);

describe("native recovery with controlled SSE and the original deadline", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-28T00:00:00Z")); });
  afterEach(() => { vi.useRealTimers(); });

  it.each(["reset", "eof"])("recovers reasoning-only %s once, retains usage uncertainty and effort", async ending => {
    const f = fixture(); await flush();
    f.streams[0]!.send(delta({ reasoning_content: "private reasoning" })); await flush();
    ending === "reset" ? f.streams[0]!.fail() : f.streams[0]!.eof(); await flush();
    expect(f.streams).toHaveLength(2);
    f.streams[1]!.finish();
    const result = await f.promise;
    expect(result).toMatchObject({ content: "answer", usage: { total_tokens: 12 }, providerSummary: { completed: true, usage: { totalTokens: 12 }, failure: null } });
    expect(result).not.toBeInstanceOf(GatewayError);
    if (result instanceof GatewayError) return;
    expect(result.providerSummary?.attempts).toMatchObject([{ errorCode: ending === "reset" ? "upstream_unavailable" : "upstream_incomplete_stream", totalTokens: null }, { errorCode: null, totalTokens: 12 }]);
    expect(result.providerSummary?.userCharge).toBeUndefined();
    expect(f.requests.map(r => r.reasoning_effort)).toEqual(["high", "high"]);
    expect(f.requests.map(r => r.max_tokens)).toEqual([64000, 64000]);
    expect(f.progress.filter(p => p === "attempt_started")).toHaveLength(2);
    expect(f.progress).toContain("retrying");
    expect(f.budgetDecisions).toHaveLength(1);
    expect(f.order.indexOf("release:tokenswitch")).toBeLessThan(f.order.indexOf("call:tencent"));
    expect(f.first.release).toHaveBeenCalledTimes(1); expect(f.second.release).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["text", "partial-tool", "delivered-text", "delivered-tool"])("never retries after %s", async kind => {
    const f = fixture(); await flush();
    f.streams[0]!.send(delta({ reasoning_content: "thinking" }));
    if (kind === "text") f.streams[0]!.send(delta({ content: "partial answer" }));
    if (kind === "partial-tool") f.streams[0]!.send(delta({ tool_calls: [{ index: 0, id: "tool", function: { name: "lookup", arguments: "{" } }] }));
    // The delivery latch is deliberately independent of upstream counters.
    if (kind.startsWith("delivered")) f.commit();
    await flush(); f.streams[0]!.fail();
    expect(await f.promise).toBeInstanceOf(GatewayError);
    expect(f.streams).toHaveLength(1); expect(f.first.beginRetry).not.toHaveBeenCalled();
  });

  it.each(["complete", "deadline", "disconnect"])("preserves active reasoning past the first-output budget: %s", async ending => {
    const f = fixture(); await flush();
    for (let i = 0; i < 83; i++) {
      f.streams[0]!.send(delta({ reasoning_content: "thinking" }));
      await vi.advanceTimersByTimeAsync(10_000);
    }
    await vi.advanceTimersByTimeAsync(4_965);
    f.streams[0]!.send(delta({ reasoning_content: "still progressing" })); await flush();
    await vi.advanceTimersByTimeAsync(35);
    expect(f.streams).toHaveLength(1); expect(f.streams[0]!.signal.aborted).toBe(false);
    expect(f.first.beginRetry).not.toHaveBeenCalled();
    if (ending === "complete") {
      await vi.advanceTimersByTimeAsync(15_000); f.streams[0]!.finish();
      expect(await f.promise).toMatchObject({ content: "answer", usage: { total_tokens: 12 } });
    } else if (ending === "disconnect") {
      f.streams[0]!.fail(); await flush();
      expect(f.streams).toHaveLength(2); f.streams[1]!.finish();
      expect(await f.promise).toMatchObject({ content: "answer", usage: { total_tokens: 12 } });
    } else {
      await vi.advanceTimersByTimeAsync(64_999);
      f.streams[0]!.send(delta({ reasoning_content: "still progressing" })); await flush();
      expect(f.streams[0]!.signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await f.promise).toMatchObject({ code: "upstream_timeout", message: "MedCode service timed out." });
      expect(f.streams).toHaveLength(1); expect(f.first.beginRetry).not.toHaveBeenCalled();
    }
    expect(f.requests.every(r => r.reasoning_effort === "high" && r.max_tokens === 64000)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not invent an idle deadline after a reasoning event", async () => {
    const f = fixture(); await flush();
    f.streams[0]!.send(delta({ reasoning_content: "thinking" })); await flush();
    await vi.advanceTimersByTimeAsync(850_000);
    expect(f.streams[0]!.signal.aborted).toBe(false);
    f.streams[0]!.finish(); expect(await f.promise).not.toBeInstanceOf(GatewayError);
    expect(f.first.beginRetry).not.toHaveBeenCalled();
  });

  it("cuts off a stream with no model activity, cancels the old reader before switching", async () => {
    const f = fixture(); await flush();
    // Transport frames and empty reasoning are not evidence of model progress.
    for (let i = 0; i < 83; i++) {
      f.streams[0]!.send(delta({ role: "assistant", reasoning_content: "" }));
      await vi.advanceTimersByTimeAsync(10_000);
    }
    expect(f.streams).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(NATIVE_NO_OUTPUT_MS - 830_000);
    expect(f.streams[0]!.cancelled).toBe(true); expect(f.streams).toHaveLength(2);
    expect(f.deadline.signal.aborted).toBe(false);
    expect(f.order.indexOf("abort:tokenswitch")).toBeLessThan(f.order.indexOf("select:tencent"));
    expect(f.order.indexOf("acquire:tencent")).toBeLessThan(f.order.indexOf("abort:tokenswitch"));
    f.streams[1]!.finish();
    const result = await f.promise;
    expect(result).toMatchObject({ content: "answer", providerSummary: { attempts: [
      { errorCode: "upstream_timeout", failure: { origin: "gateway", stage: "streaming", upstreamStatus: 200,
        transportCode: "GATEWAY_NO_DELIVERABLE_OUTPUT" } },
      { errorCode: null } ] } });
    expect(f.decisions[0]).toMatchObject({ recovery_kind: "reasoning_stream", remaining_ms: 65000 });
    expect(f.first.recordError).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["cancel", "insufficient", "no-fallback", "fallback-fails", "deadline"])("stops safely on %s", async reason => {
    const f = fixture(reason === "insufficient" ? 59_999 : 900_000); await flush();
    f.streams[0]!.send(delta({ reasoning_content: "thinking" })); await flush();
    if (reason === "no-fallback") vi.mocked(f.first.beginRetry!).mockReturnValue(new GatewayError({ code: "rate_limited", message: "busy", httpStatus: 429 }));
    if (reason === "cancel") f.parent.abort(new GatewayError({ code: "client_aborted", message: "cancelled", httpStatus: 499 }));
    else f.streams[0]!.fail();
    await flush();
    if (reason === "fallback-fails") { f.streams[1]!.send(delta({ reasoning_content: "still thinking" })); await flush(); f.streams[1]!.fail(); }
    if (reason === "deadline") await vi.advanceTimersByTimeAsync(900_000);
    const result = await f.promise;
    expect(result).toBeInstanceOf(GatewayError);
    expect((result as GatewayError).code).toBe(reason === "cancel" ? "client_aborted" : reason === "deadline" ? "upstream_timeout" : "upstream_unavailable");
    expect(f.streams).toHaveLength(["fallback-fails", "deadline"].includes(reason) ? 2 : 1);
    expect(f.second.beginRetry).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    if (reason === "insufficient") expect(f.decisions[0]?.unavailable_reason).toBe("insufficient_time");
    if (reason === "deadline") expect(providerStreamSummaryFromError(result as GatewayError)?.attempts).toHaveLength(2);
  });

  it.each(["committed", "time", "cancel"])("rechecks %s after selecting a backup", async reason => {
    const f = fixture(60_001); await flush();
    vi.mocked(f.first.beginRetry!).mockImplementation(() => {
      if (reason === "committed") f.commit();
      else if (reason === "cancel") f.parent.abort();
      else vi.setSystemTime(new Date(Date.now() + 2));
      return f.second;
    });
    f.streams[0]!.send(delta({ reasoning_content: "thinking" })); await flush(); f.streams[0]!.fail();
    expect(await f.promise).toBeInstanceOf(GatewayError);
    expect(f.streams).toHaveLength(1);
    expect(f.second.release).toHaveBeenCalledTimes(1);
    expect(f.selected()).toBe(f.first);
  });

  it("never replaces an actual request cancellation with the first-output timeout", async () => {
    const f = fixture(); await flush();
    f.streams[0]!.send(delta({ reasoning_content: "thinking" })); await flush();
    await vi.advanceTimersByTimeAsync(NATIVE_NO_OUTPUT_MS - 1);
    f.parent.abort(new GatewayError({ code: "client_aborted", message: "user stopped", httpStatus: 499 }));
    await vi.advanceTimersByTimeAsync(1);
    expect(await f.promise).toMatchObject({ code: "client_aborted" });
    expect(f.streams).toHaveLength(1); expect(f.first.beginRetry).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["814s-reasoning", "880s-generating", "590s-short-budget", "disabled", "other-model", "images"])("preserves normal long task %s", async kind => {
    const f = fixture(kind === "590s-short-budget" ? 600_000 : 900_000,
      { failover: kind !== "disabled", model: kind === "other-model" ? "goldencode-d" : "goldencode", images: kind === "images" });
    await flush(); f.streams[0]!.send(delta({ reasoning_content: "thinking" }));
    if (kind === "880s-generating") f.streams[0]!.send(delta({ content: "partial " }));
    await flush();
    await vi.advanceTimersByTimeAsync(kind === "814s-reasoning" ? 814_250 : kind === "590s-short-budget" ? 590_000 : 880_000);
    expect(f.streams).toHaveLength(1); expect(f.streams[0]!.signal.aborted).toBe(false);
    f.streams[0]!.finish();
    expect(await f.promise).not.toBeInstanceOf(GatewayError);
    if (["disabled", "other-model", "images"].includes(kind)) expect(f.budgetDecisions).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["length", "content_filter", "stop"])("does not retry a received %s terminal reason when DONE stalls", async finishReason => {
    const f = fixture(); await flush();
    f.streams[0]!.send({ choices: [{ delta: {}, finish_reason: finishReason }] });
    await vi.advanceTimersByTimeAsync(NATIVE_NO_OUTPUT_MS);
    const count = f.streams.length;
    if (count > 1) { f.streams[1]!.finish(); }
    const result = await f.promise;
    expect(count).toBe(1);
    expect(result).toBeInstanceOf(GatewayError);
    expect((result as GatewayError).message).toContain("first-attempt budget");
    expect(f.second.release).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])("separates internal cutoff from whole-request cancellation (fallback=%s)", async recover => {
    const f = fixture(); await flush();
    if (!recover) vi.mocked(f.first.beginRetry!).mockReturnValue(new GatewayError({ code: "rate_limited", httpStatus: 429, message: "busy" }));
    await vi.advanceTimersByTimeAsync(NATIVE_NO_OUTPUT_MS);
    if (recover) f.streams[1]!.finish();
    else { await vi.advanceTimersByTimeAsync(15_000); f.streams[0]!.finish(); }
    const result = await f.promise;
    if (result instanceof GatewayError) expect(result.message).not.toBe("");
    expect(f.observation.gatewayCancelObserved).toBe(false);
    expect(f.observation.gatewayCancelRequested).toBe(false);
    expect(f.observation.gatewayTerminalSource).toBe("provider_response");
  });

  it.each([0, 1, -1])("retains usage uncertainty through nested repair summary (missing attempt=%s)", async missing => {
    const f = fixture(); await flush();
    f.streams[0]!.send(delta({ reasoning_content: "thinking" }));
    f.streams[0]!.finish("{", missing !== 0); await flush();
    expect(f.streams).toHaveLength(2);
    f.streams[1]!.send(delta({ reasoning_content: "repair thinking" }));
    f.streams[1]!.finish("{}", missing !== 1);
    const result = await f.promise;
    expect(result).not.toBeInstanceOf(GatewayError);
    if (result instanceof GatewayError) return;
    expect(result.providerSummary?.usage?.totalTokens ?? null).toBe(missing < 0 ? 24 : 12);
    expect(result.providerSummary?.attempts.map(a => a.totalTokens)).toEqual([missing === 0 ? null : 12, missing === 1 ? null : 12]);
    expect(f.first.beginRetry).not.toHaveBeenCalled();
  });

  it("retains the real before-headers stage when the first-output budget expires", async () => {
    const f = fixture(900_000, { headersPending: true }); await flush();
    expect(f.requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(NATIVE_NO_OUTPUT_MS);
    expect(f.requests).toHaveLength(2);
    f.streams[0]!.finish();
    const result = await f.promise;
    expect(result).toMatchObject({ providerSummary: { attempts: [
      { failure: { origin: "gateway", stage: "before_headers", upstreamStatus: null, transportCode: "GATEWAY_NO_DELIVERABLE_OUTPUT" } },
      { errorCode: null } ] } });
    expect(f.observation.gatewayCancelObserved).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps a waiting primary alive when no backup can be acquired", async () => {
    const f = fixture(); await flush();
    vi.mocked(f.first.beginRetry!).mockReturnValue(new GatewayError({ code: "rate_limited", httpStatus: 429, message: "busy" }));
    await vi.advanceTimersByTimeAsync(850_000);
    expect(f.streams[0]!.signal.aborted).toBe(false);
    f.streams[0]!.finish();
    expect(await f.promise).not.toBeInstanceOf(GatewayError);
    expect(f.streams).toHaveLength(1);
    expect(f.budgetDecisions).toContainEqual({ unavailable_reason: "backup_unavailable", primary_continues: true });
  });

  it("releases an unused backup after slow teardown without changing error attribution", async () => {
    const f = fixture(900_000, { abortDelayMs: 6_000 }); await flush();
    await vi.advanceTimersByTimeAsync(NATIVE_NO_OUTPUT_MS + 6_000);
    const result = await f.promise;
    expect(result).toMatchObject({ code: "upstream_timeout", message: "The model did not produce deliverable output within the first-attempt budget." });
    expect(f.selected()).toBe(f.first); expect(f.requests).toHaveLength(1);
    expect(f.second.release).toHaveBeenCalledTimes(1);
    expect(f.second.recordError).not.toHaveBeenCalled(); expect(f.first.recordError).not.toHaveBeenCalled();
    expect(f.decisions.at(-1)).toMatchObject({ from: "tokenswitch", to: null, unavailable_reason: "insufficient_time" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not abort the primary or throw from a timer if backup selection fails unexpectedly", async () => {
    const f = fixture(); await flush();
    vi.mocked(f.first.beginRetry!).mockImplementation(() => { throw new Error("selection failed"); });
    await vi.advanceTimersByTimeAsync(850_000);
    expect(f.streams[0]!.signal.aborted).toBe(false);
    f.streams[0]!.finish(); expect(await f.promise).not.toBeInstanceOf(GatewayError);
    expect(f.budgetDecisions).toContainEqual({ unavailable_reason: "backup_selection_failed", primary_continues: true });
  });

  it.each([[900_000, 10_000], [1_200_000, 0]])("reserves recovery from remaining time (total=%s, setup=%s)", async (total, setupMs) => {
    const f = fixture(total, { setupMs }); await flush();
    const budget = total - setupMs - 60_000 - 5_000;
    expect(f.budgetDecisions[0]).toMatchObject({ first_output_budget_ms: budget, unavailable_reason: null });
    await vi.advanceTimersByTimeAsync(budget - 1);
    expect(f.streams[0]!.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.streams).toHaveLength(2);
    f.streams[1]!.finish();
    expect(await f.promise).not.toBeInstanceOf(GatewayError);
  });
});
