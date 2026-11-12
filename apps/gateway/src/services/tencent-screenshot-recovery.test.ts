import { describe, expect, it } from "vitest";
import { type OpenAIChatToolCall } from "../openai-compat.js";
import { ProviderStreamSummaryCollector, type ProviderStreamSummary } from "./provider-stream.js";
import { recoverTencentScreenshotBatch } from "./tencent-screenshot-recovery.js";

const parameters = { type: "object", properties: {
  file: { type: "string" }, viewport: { type: "object", properties: { width: { type: "integer", maximum: 4096 } },
    required: ["width"], additionalProperties: false }
}, required: ["file", "viewport"], additionalProperties: false };
const args = (i: number) => JSON.stringify({ file: `C:\\synthetic\\页-${i}-"quoted".html`, viewport: { width: 1200 } });
const batch = (): OpenAIChatToolCall[] => Array.from({ length: 4 }, (_, i) => ({
  id: `call_${i}`, type: "function", function: { name: "screenshot", arguments: i === 3 ? args(i) : args(i).slice(0, -1) }
}));
function input() {
  const collector = new ProviderStreamSummaryCollector();
  for (const call of batch()) collector.record({ type: "tool_call", callId: call.id,
    name: call.function.name, argumentsJson: call.function.arguments });
  collector.record({ type: "completed", responseSummary: { finishReason: "tool_calls", upstreamHttpStatus: 200,
    terminationKind: "finish_reason_and_done" } });
  return { provider: "tencent", upstreamRuntime: "tencent", upstreamModel: "glm-5.3", calls: batch(),
    request: { tools: [{ type: "function" as const, function: { name: "screenshot", parameters } }], maximumOutputTokens: 4096 },
    toolChoice: "auto" as const, summary: collector.snapshot() };
}

describe("Tencent screenshot boundary recovery", () => {
  it("preserves IDs, values and order without mutating original evidence", () => {
    const original = input(); const before = structuredClone(original);
    const result = recoverTencentScreenshotBatch(original)!;
    expect(result.repairedIndexes).toEqual([0, 1, 2]);
    expect(result.decision.toolCalls.map(c => c.id)).toEqual(batch().map(c => c.id));
    expect(result.decision.toolCalls.map(c => JSON.parse(c.function.arguments))).toEqual([0, 1, 2, 3].map(i => JSON.parse(args(i))));
    expect(original).toEqual(before);
  });
  it.each([
    { provider: "tiankuan" }, { upstreamRuntime: "tokenswitch" }, { upstreamModel: "glm-4.7" }
  ])("does not affect another provider/model: %j", overrides => {
    expect(recoverTencentScreenshotBatch({ ...input(), ...overrides })).toBeNull();
  });
  it.each([
    { completed: false }, { upstreamHttpStatus: 500 }, { finishReason: "length" },
    { terminationKind: "finish_reason" }, { errorCode: "tool_call_validation_failed" },
    { streamIncomplete: true }, { outputLimitHit: true }, { argumentBudgetExceeded: true },
    { truncationConfidence: "suspected" }, { usage: { promptTokens: 1, completionTokens: 4096, totalTokens: 4097 } }
  ] satisfies Partial<ProviderStreamSummary>[])("does not repair incomplete or capped output: %j", overrides => {
    const original = input(); original.summary = { ...original.summary, ...overrides };
    expect(recoverTencentScreenshotBatch(original)).toBeNull();
  });
  it.each([
    '{"file":"unfinished', '{"file":"bad\\path","viewport":{"width":1200}',
    '{"file":"x","viewport":{"width":1200', '{"file":"x","viewport":{"width":1200},',
    '{"file":"x","viewport":{"width":1200},"caption":1',
    '{"file":"x","viewport":{"width":9999}', '{"file":"x","viewport":{}',
    '{"file":"x","viewport":{"width":1200},"undeclared":{}'
  ])("rejects ambiguous syntax or schema failures atomically: %s", rejected => {
    const original = input(); original.calls[1].function.arguments = rejected;
    expect(recoverTencentScreenshotBatch(original)).toBeNull();
  });
  it("requires a complete final screenshot and more than one call", () => {
    const original = input(); original.calls.at(-1)!.function.arguments = args(3).slice(0, -1);
    expect(recoverTencentScreenshotBatch(original)).toBeNull();
    original.calls = original.calls.slice(0, 1);
    expect(recoverTencentScreenshotBatch(original)).toBeNull();
  });
  it("retains tool choice and all untouched tool validations", () => {
    const original = input(); original.calls[1].function.name = "bash";
    expect(recoverTencentScreenshotBatch(original)).toBeNull();
    expect(recoverTencentScreenshotBatch({ ...input(), toolChoice: "none" })).toBeNull();
    expect(recoverTencentScreenshotBatch({ ...input(), toolChoice: { type: "function", function: { name: "bash" } } })).toBeNull();
  });
  it("preserves a valid non-screenshot call in a mixed batch", () => {
    const original = input();
    original.request.tools.push({ type: "function", function: { name: "bash", parameters } });
    original.calls[1] = { ...original.calls[1], function: { name: "bash", arguments: args(1) } };
    const result = recoverTencentScreenshotBatch(original)!;
    expect(result.repairedIndexes).toEqual([0, 2]);
    expect(result.decision.toolCalls[1]).toEqual(original.calls[1]);
  });
  it("bounds work and leaves already valid calls alone", () => {
    const original = input(); original.calls[0].function.arguments = JSON.stringify({ file: "x".repeat(8192), viewport: { width: 1200 } }).slice(0, -1);
    expect(recoverTencentScreenshotBatch(original)).toBeNull();
    original.calls = Array.from({ length: 33 }, (_, i) => ({ ...batch()[0], id: String(i) }));
    expect(recoverTencentScreenshotBatch(original)).toBeNull();
    original.calls = batch().map((c, i) => ({ ...c, function: { ...c.function, arguments: args(i) } }));
    expect(recoverTencentScreenshotBatch(original)).toBeNull();
  });
});
