import { describe, expect, it } from "vitest";
import { type OpenAIChatToolCall } from "../openai-compat.js";
import { ProviderStreamSummaryCollector, type ProviderStreamSummary } from "./provider-stream.js";
import { recoverTencentScreenshotBatch } from "./tencent-screenshot-recovery.js";

const parameters = { type: "object", properties: {
  file: { type: "string" }, viewport: { type: "object", properties: { width: { type: "integer", maximum: 4096 } },
    required: ["width"], additionalProperties: false }
}, required: ["file", "viewport"], additionalProperties: false };
const args = (i: number) => JSON.stringify({ file: `C:\\synthetic\\页-${i}-"quoted".html`, viewport: { width: 1200 } });
const batch = (count = 4): OpenAIChatToolCall[] => Array.from({ length: count }, (_, i) => ({
  id: `call_${i}`, type: "function", function: { name: "screenshot", arguments: i === count - 1 ? args(i) : args(i).slice(0, -1) }
}));
function input(calls = batch()) {
  const collector = new ProviderStreamSummaryCollector();
  for (const call of calls) collector.record({ type: "tool_call", callId: call.id,
    name: call.function.name, argumentsJson: call.function.arguments });
  collector.record({ type: "completed", responseSummary: { finishReason: "tool_calls", upstreamHttpStatus: 200,
    terminationKind: "finish_reason_and_done" } });
  return { provider: "tencent", upstreamRuntime: "tencent", upstreamModel: "glm-5.3", calls,
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
    expect(recoverTencentScreenshotBatch(input(batch(1)))).toBeNull();
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
  it("enforces the call limit with otherwise recoverable, consistent batches", () => {
    expect(recoverTencentScreenshotBatch(input(batch(32)))?.repairedIndexes).toHaveLength(31);
    expect(recoverTencentScreenshotBatch(input(batch(33)))).toBeNull();
  });
  it.each([8192, 8193])("enforces the UTF-8 argument limit at %i bytes", bytes => {
    const original = input();
    const empty = JSON.stringify({ file: "", viewport: { width: 1200 } }).slice(0, -1);
    const padding = bytes - Buffer.byteLength(empty);
    const file = "中".repeat(Math.floor(padding / 3)) + "x".repeat(padding % 3);
    original.calls[0].function.arguments = JSON.stringify({ file, viewport: { width: 1200 } }).slice(0, -1);
    expect(Buffer.byteLength(original.calls[0].function.arguments)).toBe(bytes);
    expect(recoverTencentScreenshotBatch(original) !== null).toBe(bytes === 8192);
  });
  it("leaves already valid calls alone", () => {
    const calls = batch().map((c, i) => ({ ...c, function: { ...c.function, arguments: args(i) } }));
    expect(recoverTencentScreenshotBatch(input(calls))).toBeNull();
  });
});
