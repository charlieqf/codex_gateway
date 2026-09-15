import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ChatCompletionRequest, OpenAIChatToolCall } from "../openai-compat.js";
import {
  boundedWritePolicyFromEnv, boundedWriteEnabled, classifyOversizedWrite, buildWriteDelivery,
  negotiateWriteDelivery, reservedWriteDeliveryRequestError, WriteDeliveryAdmission,
  writeDeliveryLimits, writeDeliverySchemaSha256, type WriteDeliveryLimits
} from "./write-delivery.js";
import { writeDeliverySchemaJson } from "./write-delivery-schema.js";

const root = new URL("../../../../artifacts/write-delivery-contract-r3-2026-09-15/", import.meta.url);
const example = JSON.parse(readFileSync(new URL("success.example.json", root), "utf8"));
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const request = (): ChatCompletionRequest => ({ model: "goldencode", stream: true, toolChoice: "auto",
  messages: [{ role: "user", content: "Write a fixture." }], tools: structuredClone(example.request_body.tools) });
const headers = (): Record<string, string> => Object.fromEntries(Object.entries(example.request_headers).map(([k, v]) => [k.toLowerCase(), v as string]));
const call = (content = "x".repeat(14000), extra: Record<string, unknown> = {}): OpenAIChatToolCall => ({
  id: "call_fixture", type: "function", function: { name: "write", arguments: JSON.stringify({ filePath: "fixture.md", content, ...extra }) }
});
const negotiation = (limits: Partial<WriteDeliveryLimits> = {}) => negotiateWriteDelivery({
  request: request(), headers: headers(), requestId: "req_fixture", subjectId: "subj-contract-fixture",
  policy: { mode: "delivery", limits }
})!;

describe("bounded ordinary write classification", () => {
  it("keeps the fixed UTF-8 schema bytes identical to the reviewed registry", () => {
    const bytes = readFileSync(new URL("write-delivery-v1.parameters.schema.json", root));
    expect(writeDeliverySchemaJson).toBe(bytes.toString("utf8"));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(writeDeliverySchemaSha256);
  });
  it.each([1, 100, 3999, 4000, 4001, 5000, 11999, 12000])("does not transform a valid %i character write", (size) => {
    expect(classifyOversizedWrite(request(), [call("x".repeat(size))])).toBeUndefined();
  });
  it.each([12000, 32000])("classifies only maxLength at the %i boundary", (maxLength) => {
    const req = request();
    (req.tools![0].function.parameters!.properties as Record<string, any>).content.maxLength = maxLength;
    expect(classifyOversizedWrite(req, [call("x".repeat(maxLength + 1))])?.details).toMatchObject({
      limit_code_points: maxLength, actual_code_points: maxLength + 1, actual_utf16_units: maxLength + 1
    });
  });
  it("counts code points, UTF-16, UTF-8 and serialized arguments separately", () => {
    const value = classifyOversizedWrite(request(), [call("😀".repeat(12001))])!;
    expect(value.details).toMatchObject({ actual_code_points: 12001, actual_utf16_units: 24002, actual_utf8_bytes: 48004 });
    expect(value.details.arguments_utf8_bytes).toBeGreaterThan(48004);
  });
  it.each(["missing_path", "wrong_mode", "bad_chunk", "unknown_field", "artifact", "done", "broken_json", "mixed_calls", "none", "other_choice", "nested_schema"])("preserves existing repair for %s", (scenario) => {
    const req = request(); const calls = [call()];
    const args = JSON.parse(calls[0].function.arguments);
    if (scenario === "missing_path") delete args.filePath;
    if (scenario === "wrong_mode") args.mode = "invalid";
    if (scenario === "bad_chunk") args.chunk = { index: 3, total: 1 };
    if (scenario === "unknown_field") args.extra = 1;
    if (scenario === "artifact") args.artifact = {};
    if (scenario === "done") args.done = true;
    calls[0].function.arguments = scenario === "broken_json" ? '{"content":' : JSON.stringify(args);
    if (scenario === "mixed_calls") calls.push(call());
    if (scenario === "none") req.toolChoice = "none";
    if (scenario === "other_choice") req.toolChoice = { type: "function", function: { name: "read" } };
    if (scenario === "nested_schema") req.tools![0].function.parameters!.allOf = [{ required: ["filePath"] }];
    expect(classifyOversizedWrite(req, calls)).toBeUndefined();
  });
});

describe("S request admission", () => {
  it("is off by default and supports independent A plus subject canaries", () => {
    expect(boundedWritePolicyFromEnv({}).mode).toBe("disabled");
    expect(boundedWriteEnabled({ mode: "error", subjectIds: ["s1"] }, "s2")).toBe(false);
    expect(boundedWriteEnabled({ mode: "error", subjectIds: ["s1"] }, "s1")).toBe(true);
    expect(() => boundedWritePolicyFromEnv({ GATEWAY_BOUNDED_WRITE_MODE: "on" })).toThrow();
    expect(() => new WriteDeliveryAdmission(0)).toThrow();
  });
  it("clamps every negotiated limit to request, local and frozen schema", () => {
    const h = headers(); h["x-medcode-write-delivery-limits"] = encode({ ...writeDeliveryLimits, payload_utf8_bytes: 99999999, chunk_count: 3 });
    const accepted = negotiateWriteDelivery({ request: request(), headers: h, requestId: "req", subjectId: "s",
      policy: { mode: "delivery", limits: { arguments_utf8_bytes: 40000 } } })!;
    expect(accepted.limits).toMatchObject({ payload_utf8_bytes: 1048576, chunk_count: 3, arguments_utf8_bytes: 40000 });
  });
  it.each(["unknown_schema", "version", "capability", "nonce", "session", "turn", "limits", "extra_limit", "missing_limit", "duplicate_header", "nonstream", "disabled_write"])("declines %s without mutating the ordinary request", (scenario) => {
    const req = request(); const h: Record<string, string | string[] | undefined> = headers();
    if (scenario === "unknown_schema") h["x-medcode-write-delivery-schema-sha256"] = "a".repeat(64);
    if (scenario === "version") h["x-medcode-write-delivery-version"] = "2";
    if (scenario === "capability") delete h["x-medcode-client-capabilities"];
    if (scenario === "nonce") h["x-medcode-write-delivery-nonce"] = "AAAA";
    if (scenario === "session") delete h["x-medcode-client-session-id"];
    if (scenario === "turn") delete h["x-medcode-client-turn-id"];
    if (scenario === "limits") h["x-medcode-write-delivery-limits"] = encode({ ...writeDeliveryLimits, chunk_count: 0 });
    if (scenario === "extra_limit") h["x-medcode-write-delivery-limits"] = encode({ ...writeDeliveryLimits, extra: 1 });
    if (scenario === "missing_limit") h["x-medcode-write-delivery-limits"] = encode({ chunk_count: 1 });
    if (scenario === "duplicate_header") h["x-medcode-write-delivery-version"] = ["1", "1"];
    if (scenario === "nonstream") req.stream = false;
    if (scenario === "disabled_write") req.toolChoice = "none";
    const before = JSON.stringify(req);
    expect(negotiateWriteDelivery({ request: req, headers: h, requestId: "req", subjectId: "s", policy: { mode: "delivery" } })).toBeUndefined();
    expect(JSON.stringify(req)).toBe(before);
  });
  it("releases bounded admission idempotently without queuing ordinary work", () => {
    const admission = new WriteDeliveryAdmission(1); const release = admission.acquire()!;
    expect(admission.acquire()).toBeUndefined(); release(); release();
    const next = admission.acquire(); expect(next).toBeTypeOf("function");
    expect(admission.acquire()).toBeUndefined(); next!();
  });
  it("rejects the reserved receiver in network definitions, choices and replay", () => {
    const req = request(); req.tools![0].function.name = "write_delivery_v1";
    expect(reservedWriteDeliveryRequestError(req)?.httpStatus).toBe(400);
    req.tools = []; req.toolChoice = { type: "function", function: { name: "write_delivery_v1" } };
    expect(reservedWriteDeliveryRequestError(req)?.httpStatus).toBe(400);
    req.toolChoice = "auto"; const history = call(); history.function.name = "write_delivery_v1";
    req.messages.push({ role: "assistant", tool_calls: [history] });
    expect(reservedWriteDeliveryRequestError(req)?.httpStatus).toBe(400);
  });
});

describe("S complete response construction", () => {
  it.each([{}, { mode: "append" }, { mode: "append", chunk: { index: 2, total: 3 } }])("preserves Unicode, original omitted fields and operation %j", async (extra) => {
    const payload = "\uFEFF" + '中文😀"\\\n\r\t'.repeat(3000);
    const write = classifyOversizedWrite(request(), [call(payload, extra)])!;
    const accepted = negotiation();
    const result = buildWriteDelivery({ write, negotiation: accepted, shape: { id: "chatcmpl-fixture", created: 1, model: "goldencode" },
      content: "Here is the file.", usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } });
    expect(result).not.toHaveProperty("stopReason");
    if ("stopReason" in result) throw new Error(result.stopReason);
    const body = result.frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n";
    expect(Buffer.byteLength(body)).toBe(result.responseBytes);
    // Shared independent R3 receiver fixture validates actual production encoding.
    const checker = await import(new URL("contract-checks.mjs", root).href);
    const decoded = checker.responseCheck({ request: { ...example.request_context, headers: headers() },
      response: { ...example.response_context, headers: { ...result.headers, "content-type": "text/event-stream" }, body },
      trust: example.trust_context, sse: body });
    expect(decoded.payload).toBe(payload);
    expect(decoded.envelope.original_arguments).toEqual({ filePath: "fixture.md", ...extra });
    expect(decoded.envelope).not.toHaveProperty("done");
    expect(decoded.usage.total_tokens).toBe(150);
  });
  it.each([
    ["payload_utf8_bytes", 13000, "write_delivery_payload_limit"],
    ["arguments_utf8_bytes", 13000, "write_delivery_arguments_limit"],
    ["response_body_bytes", 13000, "write_delivery_response_limit"],
    ["chunk_count", 1, "write_delivery_chunk_count_limit"],
    ["chunk_json_utf8_bytes", 1, "write_delivery_chunk_limit"]
  ] as const)("enforces smaller effective %s", (key, limit, stopReason) => {
    expect(buildWriteDelivery({ write: classifyOversizedWrite(request(), [call()])!, negotiation: negotiation({ [key]: limit }),
      shape: { id: "c", created: 1, model: "goldencode" }, content: "", usage: null })).toEqual({ stopReason });
  });
  it("declines malformed Unicode instead of silently replacing it", () => {
    expect(buildWriteDelivery({ write: classifyOversizedWrite(request(), [call("x".repeat(14000) + "\ud800")])!, negotiation: negotiation(),
      shape: { id: "c", created: 1, model: "goldencode" }, content: "", usage: null })).toEqual({ stopReason: "write_delivery_invalid_unicode" });
  });
});
