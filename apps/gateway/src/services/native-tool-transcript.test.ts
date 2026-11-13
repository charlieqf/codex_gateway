import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { GatewayError, type MessageInput, type ProviderAdapter, type StreamEvent } from "@codex-gateway/core";
import { chatMessagesToPrompt, type ChatCompletionRequest, type OpenAIChatToolCall } from "../openai-compat.js";
import { gatewayErrorMetadata } from "../http/error-response.js";
import { runNativeWithFailover } from "./native-client-tools.js";
import { NativeCallBudget } from "./native-tool-failover.js";
import { inspectNativeToolText, textToolProtocolError } from "./native-tool-transcript.js";
import { providerStreamSummaryFromError } from "./provider-stream.js";
import type { ChatRuntimeContext } from "./chat-runtime-dispatcher.js";

const call = (name = "inspect_file", args = { path: "example.py" }): OpenAIChatToolCall => ({
  id: `call_${name}`, type: "function", function: { name, arguments: JSON.stringify(args) }
});
const serialized = "[assistant tool_calls]\n" + JSON.stringify([call()]);
const prefixed = "I will inspect the file now.\n" + serialized;
const fabricated = "Continuing the task.\n" + serialized + "\n[tool tool_call_id=call_inspect_file]\nFile changed successfully.";
const request = (): ChatCompletionRequest => ({
  model: "goldencode", stream: true, messages: [{ role: "user", content: "Inspect example.py" }],
  tools: [{ type: "function", function: { name: "inspect_file", parameters: {
    type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false
  } } }], toolChoice: "auto", maximumOutputTokens: 64000
});
type Output = { text?: string; calls?: OpenAIChatToolCall[]; end?: () => void };

function fixture(outputs: Output[]) {
  const inputs: MessageInput[] = [];
  const controller = new AbortController();
  const budget = new NativeCallBudget();
  let now = new Date(0);
  let committed = false;
  const provider: ProviderAdapter = {
    kind: "tiankuan",
    async health() { return { state: "healthy", checkedAt: new Date(0) }; },
    async *message(input: MessageInput): AsyncIterable<StreamEvent> {
      inputs.push(input);
      const output = outputs[inputs.length - 1];
      if (!output) throw new Error("Unexpected extra provider attempt");
      if (output.text) yield { type: "message_delta", text: output.text };
      for (const c of output.calls ?? []) yield {
        type: "tool_call", callId: c.id, name: c.function.name, argumentsJson: c.function.arguments
      };
      yield { type: "completed", usage: { promptTokens: 7, completionTokens: 5, totalTokens: 12 },
        responseSummary: { finishReason: output.calls?.length ? "tool_calls" : "stop", upstreamHttpStatus: 200,
          terminationKind: "finish_reason_and_done" } };
      output.end?.();
    }
  };
  const runtime = { adapter: provider, runtime: "tiankuan", runtimeInstanceId: "synthetic",
    publicModelId: "goldencode", upstreamModel: "official/glm-5.3", reasoningEffort: "high",
    adapterInputUpstreamAccount: { id: "synthetic" }, subject: { id: "synthetic" }, scope: "code",
    session: { id: "synthetic" }, limits: { maxOutputTokens: 64000 },
    release: vi.fn(), recordSuccess: vi.fn(), recordError: vi.fn(), beginRetry: vi.fn()
  } as unknown as ChatRuntimeContext;
  const input: Parameters<typeof runNativeWithFailover>[0] = {
    provider, runtime, failover: false, deadlineAt: new Date(5000), now: () => now,
    callBudget: budget, signal: controller.signal, selected: vi.fn(), outputCommitted: () => committed,
    upstreamAccount: runtime.adapterInputUpstreamAccount, upstreamRuntime: "tiankuan", upstreamModel: "official/glm-5.3",
    subject: runtime.subject, scope: "code", session: runtime.session, reasoningEffort: "high",
    request: request(), prompt: "Inspect example.py", nativeToolForceRequiredMode: "disabled",
    nativeFileToolRecoveryPolicy: { mode: "error", softArgumentBytes: 100000, hardArgumentBytes: null, canaryPercent: 100 }
  };
  return { inputs, input, controller, budget, runtime, setNow: (date: Date) => { now = date; },
    commit: () => { committed = true; }, run: () => runNativeWithFailover(input) };
}

describe("native text tool protocol containment", () => {
  it("retains only the whole-response schema-validated compatibility path", async () => {
    const f = fixture([{ text: serialized }]);
    expect(await f.run()).toMatchObject({ content: "", toolCalls: [call()] });
    expect(f.inputs).toHaveLength(1);
  });

  it.each([
    ["prefixed", prefixed], ["fabricated_result", fabricated],
    ["flat", 'Continuing.\n[assistant tool_calls]\n[{"name":"inspect_file","arguments":{"path":"example.py"}}]'],
    ["multiple rounds", fabricated + "\n[assistant]\nContinuing.\n" + fabricated],
    ["truncated", 'Continuing.\n[assistant tool_calls]\n[{"function":{"name":"inspect_file","arguments":"{'],
    ["marker-only truncated", '[assistant tool_calls]\n[{"name":"inspect_file","arguments":'],
    ["truncated before fields", 'Continuing.\n[assistant tool_calls]\n[{'],
    ["malformed standalone", '[assistant tool_calls]\nnot JSON'],
    ["empty standalone", '[assistant tool_calls]\n[]'],
    ["fenced", "Continuing.\n```text\n" + fabricated + "\n```"],
    ["marker-first fabricated", serialized + "\n[tool tool_call_id=call_inspect_file]\nChanged."]
  ])("rejects %s after one correction, without delivering any text calls", async (_name, text) => {
    const f = fixture([{ text }, { text }]);
    const result = await f.run();
    expect(result).toBeInstanceOf(GatewayError);
    expect(result).toMatchObject({ code: "tool_call_validation_failed", failureKind: "text_tool_protocol",
      httpStatus: 502, transformedRetryAllowed: false, recoveryOwner: "gateway" });
    expect(f.inputs).toHaveLength(2);
    expect(f.inputs[1]?.message).toContain("Do not repeat completed write operations");
    expect(f.inputs[1]?.message).not.toContain("File changed successfully");
    expect(providerStreamSummaryFromError(result as GatewayError)?.attempts).toMatchObject([
      { kind: "native_initial", errorCode: "tool_call_validation_failed", toolValidationFailureKind: "text_tool_protocol" },
      { kind: "validation_failed_to_same", errorCode: "tool_call_validation_failed", toolValidationFailureKind: "text_tool_protocol" }
    ]);
  });

  it.each(["Done; changes verified.", serialized, ""])("does not accept textual recovery: %s", async text => {
    const f = fixture([{ text: fabricated }, { text }]);
    expect(await f.run()).toMatchObject({ failureKind: "text_tool_protocol" });
    expect(f.inputs).toHaveLength(2);
  });

  it.each([false, true])("recovers with actual structured calls and retains usage; failover=%s", async failover => {
    const f = fixture([{ text: prefixed }, { calls: [call()] }]);
    f.input.failover = failover;
    const result = await f.run();
    expect(result).toMatchObject({ content: "", toolCalls: [call()], usage: { total_tokens: 24 },
      providerSummary: { errorCode: null, failure: null } });
    expect(f.inputs).toHaveLength(2);
    expect(f.inputs.map(i => i.clientToolChoice)).toEqual(["auto", "auto"]);
    expect(f.inputs[1]?.clientTools).toEqual(f.inputs[0]?.clientTools);
    expect(f.runtime.beginRetry).not.toHaveBeenCalled();
    if (result instanceof GatewayError) throw result;
    expect(result.providerSummary?.attempts).toMatchObject([
      { toolValidationFailureKind: "text_tool_protocol", errorCode: "tool_call_validation_failed" },
      { toolCallCount: 1, errorCode: null }
    ]);
  });

  it("does not duplicate real calls when the same response also contains a fake transcript", async () => {
    const f = fixture([{ text: fabricated, calls: [call()] }]);
    expect(await f.run()).toMatchObject({ content: "", toolCalls: [call()] });
    expect(f.inputs).toHaveLength(1);
  });

  it.each(["Explain the [assistant tool_calls] protocol with an example.", "请解释工具调用协议并给出示例。"]) (
    "keeps explicitly requested examples as text: %s", async user => {
      for (const text of [serialized, "Example:\n```text\n" + fabricated + "\n```", fabricated]) {
        const f = fixture([{ text }]);
        f.input.request.messages = [{ role: "user", content: user }];
        expect(await f.run()).toMatchObject({ content: text, toolCalls: [] });
        expect(f.inputs).toHaveLength(1);
      }
    });

  it.each(["The [assistant tool_calls] marker is a transcript label, not a tool invocation.", "Inspection complete."]) (
    "allows ordinary answers and marker mentions", async text => {
      const f = fixture([{ text }]);
      expect(await f.run()).toMatchObject({ content: text, toolCalls: [] });
      expect(f.inputs).toHaveLength(1);
    });

  it("does not disable the guard because a bug report mentions examples", async () => {
    const f = fixture([{ text: prefixed }, { text: prefixed }]);
    f.input.request.messages = [{ role: "user", content: "Fix tool_calls being printed in example.py, then explain what changed." }];
    expect(await f.run()).toMatchObject({ failureKind: "text_tool_protocol" });
  });

  it.each(["cancel", "deadline", "budget", "committed"])("does not start recovery after %s", async reason => {
    const f = fixture([{ text: fabricated, end: () => {
      if (reason === "cancel") f.controller.abort();
      if (reason === "deadline") f.setNow(new Date(5000));
      if (reason === "committed") f.commit();
    } }]);
    if (reason === "budget") f.budget.consume();
    const result = await f.run();
    expect(result).toMatchObject({ code: reason === "cancel" ? "client_aborted" :
      reason === "deadline" ? "upstream_timeout" : "tool_call_validation_failed" });
    expect(f.inputs).toHaveLength(1);
  });

  it.each(["cancel", "deadline"])("does not deliver a corrected tool call after %s", async reason => {
    const f = fixture([{ text: fabricated }, { calls: [call()], end: () => {
      if (reason === "cancel") f.controller.abort();
      else f.setNow(new Date(5000));
    } }]);
    expect(await f.run()).toMatchObject({ code: reason === "cancel" ? "client_aborted" : "upstream_timeout" });
    expect(f.inputs).toHaveLength(2);
  });

  it("keeps request ID and a terminal retry contract on the public error", () => {
    expect(gatewayErrorMetadata(textToolProtocolError(), { requestId: "req_protocol" })).toMatchObject({
      failure_kind: "text_tool_protocol", request_id: "req_protocol", automatic_retry_allowed: false,
      transformed_retry_allowed: false, recovery_owner: "gateway", recommended_action: "report_protocol_error"
    });
  });

  it("does not interpret tool text when tools are disabled", () => {
    expect(inspectNativeToolText({ ...request(), toolChoice: "none" }, serialized)).toEqual({ kind: "ordinary" });
  });

  it("continues a bounded file workflow without a user follow-up or repeated writes", async () => {
    const directory = mkdtempSync(join(tmpdir(), "gateway-protocol-"));
    const history = request();
    history.messages = [{ role: "user", content: "Update both files, check omissions, fix them and verify." }];
    history.tools = ["write_file", "inspect_file"].map(name => ({ type: "function", function: { name, parameters: {
      type: "object", properties: { path: { type: "string", enum: ["a.txt", "b.txt"] }, content: { type: "string" } },
      required: ["path"], additionalProperties: false
    } } }));
    let writeIndex = 0;
    const write = (path: string, content: string) => ({ ...call("write_file", { path }), id: `write_${++writeIndex}`,
      function: { name: "write_file", arguments: JSON.stringify({ path, content }) } });
    const rounds: Output[][] = [
      [{ calls: [write("a.txt", "updated"), write("b.txt", "missing detail")] }],
      [{ text: fabricated }, { calls: [call("inspect_file", { path: "b.txt" })] }],
      [{ calls: [write("b.txt", "updated")] }],
      [{ calls: [call("inspect_file", { path: "a.txt" }), call("inspect_file", { path: "b.txt" })] }],
      [{ text: "Both files verified." }]
    ];
    const executed: string[] = [];
    let providerAttempts = 0;
    try {
      for (const outputs of rounds) {
        const f = fixture(outputs);
        f.input.request = structuredClone(history);
        f.input.prompt = chatMessagesToPrompt(history, { includeToolsContext: false });
        const result = await f.run();
        if (result instanceof GatewayError) throw result;
        providerAttempts += f.inputs.length;
        history.messages.push({ role: "assistant", content: result.content, tool_calls: result.toolCalls });
        for (const tool of result.toolCalls) {
          const args = JSON.parse(tool.function.arguments) as { path: string; content?: string };
          expect(["a.txt", "b.txt"]).toContain(args.path);
          executed.push(`${tool.function.name}:${args.path}`);
          if (tool.function.name === "write_file") writeFileSync(join(directory, args.path), args.content!);
          const actual = readFileSync(join(directory, args.path), "utf8");
          history.messages.push({ role: "tool", tool_call_id: tool.id, content: actual });
        }
        if (outputs.length === 2) expect(f.inputs[1]?.message).toContain("missing detail");
      }
      expect(providerAttempts).toBe(6);
      expect(executed).toEqual(["write_file:a.txt", "write_file:b.txt", "inspect_file:b.txt", "write_file:b.txt",
        "inspect_file:a.txt", "inspect_file:b.txt"]);
      expect(readFileSync(join(directory, "a.txt"), "utf8")).toBe("updated");
      expect(readFileSync(join(directory, "b.txt"), "utf8")).toBe("updated");
      expect(history.messages.filter(m => m.role === "user")).toHaveLength(1);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
