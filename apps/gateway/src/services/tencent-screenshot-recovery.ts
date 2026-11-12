import { GatewayError, isRecord } from "@codex-gateway/core";
import {
  parseStrictToolDecision,
  type ChatCompletionRequest,
  type OpenAIChatToolCall,
  type StrictToolDecision
} from "../openai-compat.js";
import { providerToolOutputReachedTokenLimit, type ProviderStreamSummary } from "./provider-stream.js";

export const tencentScreenshotRecoveryResult = "tencent_screenshot_outer_object_closed";

/**
 * Tencent GLM-5.3 can omit the outer '}' at a boundary between screenshot calls.
 * Captured SSE proves the non-final calls lose one brace while the final call is
 * complete. This is deliberately not general JSON repair: no values, quotes,
 * arrays, incomplete scalar tokens, or final calls may be completed here.
 */
export function recoverTencentScreenshotBatch(input: {
  provider: string;
  upstreamRuntime: string;
  upstreamModel: string;
  request: Pick<ChatCompletionRequest, "tools" | "maximumOutputTokens">;
  toolChoice: ChatCompletionRequest["toolChoice"];
  calls: readonly OpenAIChatToolCall[];
  summary: ProviderStreamSummary;
}): { decision: Extract<StrictToolDecision, { type: "tool_calls" }>; repairedIndexes: number[] } | null {
  const { summary, calls } = input;
  if (input.provider !== "tencent" || input.upstreamRuntime !== "tencent" || input.upstreamModel !== "glm-5.3" ||
      input.toolChoice === "none" || calls.length < 2 || calls.length > 32 || summary.toolCallCount !== calls.length ||
      calls.some(call => !call.id || Buffer.byteLength(call.function.arguments, "utf8") > 8192) ||
      !summary.completed || summary.upstreamHttpStatus !== 200 ||
      summary.finishReason !== "tool_calls" || summary.terminationKind !== "finish_reason_and_done" ||
      summary.errorCode || summary.failure || summary.streamIncomplete || summary.outputLimitHit ||
      summary.argumentBudgetExceeded || summary.truncationConfidence !== "none" ||
      providerToolOutputReachedTokenLimit(summary, input.request.maximumOutputTokens)) return null;

  // A complete final screenshot is part of the observed boundary-loss shape.
  const last = calls.at(-1)!;
  if (last.function.name !== "screenshot" || !jsonObject(last.function.arguments)) return null;
  const repairedIndexes: number[] = [];
  const corrected = calls.map((call, index) => {
    if (index === calls.length - 1 || call.function.name !== "screenshot") return call;
    const args = call.function.arguments;
    const trimmed = args.trim();
    // Ending in a closed nested object excludes truncated paths, strings and
    // numbers. Parsing after exactly one addition proves only the root is open.
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}") || !jsonObject(args + "}")) return call;
    repairedIndexes.push(index);
    return { ...call, function: { ...call.function, arguments: args + "}" } };
  });
  if (!repairedIndexes.length) return null;

  // Validate the entire batch atomically, including untouched calls, exact
  // client schemas, declared tool names and tool_choice. Never deliver a subset.
  const decision = parseStrictToolDecision({
    text: JSON.stringify({ type: "tool_calls", tool_calls: corrected }),
    tools: input.request.tools ?? [], toolChoice: input.toolChoice,
    createToolCallId: () => { throw new Error("Collected native tool calls must already have IDs."); }
  });
  return decision instanceof GatewayError || decision.type !== "tool_calls"
    ? null : { decision, repairedIndexes };
}

function jsonObject(text: string): boolean {
  try { return isRecord(JSON.parse(text)); } catch { return false; }
}
