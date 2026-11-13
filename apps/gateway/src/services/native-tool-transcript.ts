import { GatewayError } from "@codex-gateway/core";
import type { ChatCompletionRequest } from "../openai-compat.js";

type NativeToolText =
  | { kind: "ordinary" }
  | { kind: "standalone"; serialized: string }
  | { kind: "transcript" };

/** Inspect protocol shape, never extract executable calls from a mixed transcript. */
export function inspectNativeToolText(request: ChatCompletionRequest, content: string): NativeToolText {
  if (!request.tools?.length || request.toolChoice === "none" || requestsProtocolExample(request)) {
    return { kind: "ordinary" };
  }
  // Keep the existing whole-response compatibility path. JSON parsing must consume
  // the entire suffix, so fabricated tool results or extra rounds cannot enter it.
  const standalone = content.trim().match(/^\[assistant tool_calls\]\s+([\s\S]+)$/);
  if (standalone) {
    try {
      const calls: unknown = JSON.parse(standalone[1]!);
      if (Array.isArray(calls) && calls.length > 0) {
        return { kind: "standalone", serialized: JSON.stringify({ type: "tool_calls", tool_calls: calls }) };
      }
    } catch { /* Not a complete standalone call array. */ }
    return { kind: "transcript" };
  }
  // A marker alone (e.g. ordinary documentation) is insufficient. Require a
  // JSON opener as well, including a call truncated before its first field.
  return { kind: /\[assistant tool_calls\]\s*(?:```(?:json)?\s*)?[\[{]/.test(content) ? "transcript" : "ordinary" };
}

function requestsProtocolExample(request: ChatCompletionRequest): boolean {
  const latestUser = request.messages.findLast(message => message.role === "user");
  const text = typeof latestUser?.content === "string" ? latestUser.content.trim() : "";
  // Explicitly requested protocol explanations/examples remain text, even if
  // the example is a complete, schema-valid call to an available tool.
  return /\[assistant tool_calls\]|\btool[_ -]calls?\b|工具调用(?:协议|格式)/i.test(text) &&
    /^(?:(?:please|can you|could you)\s+)?(?:explain|illustrate|document|describe|demonstrate|show|give (?:me )?an? example|what (?:does|is|are))\b|^(?:请|请你|帮我|请帮我)?(?:解释|讲解|说明|展示|举例|给出.*示例)/i.test(text);
}

export function textToolProtocolError(): GatewayError {
  return new GatewayError({
    code: "tool_call_validation_failed", httpStatus: 502, contractVersion: 1,
    failureKind: "text_tool_protocol", recoveryOwner: "gateway",
    transformedRetryAllowed: false, recommendedAction: "report_protocol_error",
    message: "The model returned tool protocol in message text instead of structured tool calls. Those text operations were not executed; the task is incomplete."
  });
}
