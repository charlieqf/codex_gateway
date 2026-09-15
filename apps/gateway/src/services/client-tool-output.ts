import { randomUUID } from "node:crypto";
import { type OpenAIChatToolCall, type OpenAIChatUsage } from "../openai-compat.js";
import { type ProviderToolCall } from "./provider-stream.js";

export function createToolCallId(): string {
  return `call_${randomUUID().replaceAll("-", "")}`;
}

export function openAIToolCallToStreamEvent(toolCall: OpenAIChatToolCall) {
  let parsedArguments: unknown = {};
  try {
    parsedArguments = JSON.parse(toolCall.function.arguments) as unknown;
  } catch {
    parsedArguments = {};
  }

  return {
    type: "tool_call" as const,
    callId: toolCall.id,
    name: toolCall.function.name,
    arguments: parsedArguments,
    argumentsJson: toolCall.function.arguments
  };
}

export function providerToolCallToOpenAI(toolCall: ProviderToolCall): OpenAIChatToolCall {
  return {
    id: toolCall.id,
    type: "function",
    function: {
      name: toolCall.name,
      arguments: toolCall.argumentsJson ?? JSON.stringify(toolCall.arguments ?? {})
    }
  };
}

export function addOpenAIUsage(
  first: OpenAIChatUsage | null,
  second: OpenAIChatUsage | null
): OpenAIChatUsage | null {
  if (!first) {
    return second;
  }
  if (!second) {
    return first;
  }
  const cachedTokens =
    (first.prompt_tokens_details?.cached_tokens ?? 0) +
    (second.prompt_tokens_details?.cached_tokens ?? 0);
  const reasoningTokens =
    (first.completion_tokens_details?.reasoning_tokens ?? 0) +
    (second.completion_tokens_details?.reasoning_tokens ?? 0);
  return {
    prompt_tokens: first.prompt_tokens + second.prompt_tokens,
    completion_tokens: first.completion_tokens + second.completion_tokens,
    total_tokens: first.total_tokens + second.total_tokens,
    ...(first.prompt_tokens_details || second.prompt_tokens_details
      ? { prompt_tokens_details: { cached_tokens: cachedTokens } }
      : {}),
    ...(first.completion_tokens_details || second.completion_tokens_details
      ? { completion_tokens_details: { reasoning_tokens: reasoningTokens } }
      : {})
  };
}
