import { expect, it } from "vitest";
import { emptyResponseCharge, isRecoverableEmptyResponse } from "./empty-response-policy.js";
import { providerCompletionError, providerStreamSummaryFromError, ProviderStreamSummaryCollector,
  type ProviderStreamSummary } from "./provider-stream.js";

function empty(): ProviderStreamSummary {
  const collector = new ProviderStreamSummaryCollector();
  collector.record({ type: "completed", responseSummary: {
    finishReason: "network_error", upstreamHttpStatus: 200, terminationKind: "finish_reason_and_done",
    streamProgress: { responseBytes: 100, responseChunks: 1, firstResponseByteMs: 180000,
      lastResponseByteMs: 180000, sseDataEvents: 1, reasoningChars: 0, observedToolCallCount: 0, toolArgumentBytes: 0 }
  } });
  return providerStreamSummaryFromError(providerCompletionError(collector.snapshot())!)!;
}

it("requires positive evidence of a terminal empty response", () => {
  expect(isRecoverableEmptyResponse(empty())).toBe(true);
  expect(isRecoverableEmptyResponse({ ...empty(), finishReason: "stop" })).toBe(true);
});

it.each<Partial<ProviderStreamSummary>>([
  { completed: false }, { upstreamHttpStatus: null }, { finishReason: "content_filter" },
  { finishReason: "length" }, { finishReason: "unknown" }, { terminationKind: "done" },
  { terminationKind: "eof_before_terminal" }, { semanticOutputChars: 1 }, { visibleOutputChars: 1 },
  { toolCallCount: 1 }, { totalToolArgumentBytes: 1 }, { streamIncomplete: true },
  { outputLimitHit: true }, { argumentBudgetExceeded: true }, { errorCode: "upstream_timeout" }
])("does not waive or recover ambiguous/partial output: %j", patch => {
  const summary = { ...empty(), ...patch };
  expect(isRecoverableEmptyResponse(summary)).toBe(false);
  expect(emptyResponseCharge([summary])).toBeUndefined();
});

it("rejects missing progress, reasoning and unassembled tool fragments", () => {
  const summary = empty();
  delete summary.streamProgress;
  summary.attempts = summary.attempts.map(attempt => ({ ...attempt, streamProgress: undefined }));
  expect(isRecoverableEmptyResponse(summary)).toBe(false);
  for (const field of ["reasoningChars", "observedToolCallCount", "toolArgumentBytes"] as const) {
    const partial = empty();
    partial.streamProgress = { ...partial.streamProgress!, [field]: 1 };
    expect(isRecoverableEmptyResponse(partial)).toBe(false);
  }
});

it("separates reported provider usage from user charges, preserving missing-usage policy", () => {
  const failed = { ...empty(), usage: { promptTokens: 20, completionTokens: 0, totalTokens: 20 } };
  const successful = { ...empty(), errorCode: null, failure: null, semanticOutputChars: 5,
    usage: { promptTokens: 7, completionTokens: 5, totalTokens: 12 } };
  expect(emptyResponseCharge([failed, successful])).toMatchObject({ exemptAttempts: [1], usage: { totalTokens: 12 } });
  expect(emptyResponseCharge([failed, empty()])).toMatchObject({ exemptAttempts: [1, 2], usage: { totalTokens: 0 } });
  expect(emptyResponseCharge([failed, { ...successful, usage: null }])).toMatchObject({ usage: null });
  expect(emptyResponseCharge([failed, { ...successful, errorCode: "client_aborted" }])).toBeUndefined();
});
