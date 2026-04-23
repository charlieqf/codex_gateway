import { GatewayError, type StreamEvent, type TokenUsage } from "@codex-gateway/core";

export interface OpenAIChatToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface OpenAIChatUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: {
    cached_tokens: number;
  };
}

export interface ChatCompletionMessage {
  role: string;
  content?: unknown;
  name?: unknown;
  tool_call_id?: unknown;
  tool_calls?: OpenAIChatToolCall[];
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatCompletionMessage[];
  stream: boolean;
  tools?: unknown;
}

export interface ChatCompletionShape {
  id: string;
  created: number;
  model: string;
}

export function parseChatCompletionRequest(
  body: unknown,
  defaultModel: string
): ChatCompletionRequest | GatewayError {
  if (!isRecord(body)) {
    return invalidRequest("Request body must be a JSON object.");
  }

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return invalidRequest("messages must be a non-empty array.");
  }

  const messages: ChatCompletionMessage[] = [];
  for (const [index, message] of body.messages.entries()) {
    if (!isRecord(message)) {
      return invalidRequest(`messages[${index}] must be an object.`);
    }

    if (typeof message.role !== "string" || message.role.length === 0) {
      return invalidRequest(`messages[${index}].role must be a non-empty string.`);
    }

    if (
      !["system", "developer", "user", "assistant", "tool"].includes(message.role)
    ) {
      return invalidRequest(
        `messages[${index}].role must be system, developer, user, assistant, or tool.`
      );
    }

    let toolCalls: OpenAIChatToolCall[] | undefined;
    if (message.tool_calls !== undefined) {
      const parsedToolCalls = parseToolCalls(message.tool_calls, `messages[${index}].tool_calls`);
      if (parsedToolCalls instanceof GatewayError) {
        return parsedToolCalls;
      }
      toolCalls = parsedToolCalls;
    }

    if (message.tool_call_id !== undefined && typeof message.tool_call_id !== "string") {
      return invalidRequest(`messages[${index}].tool_call_id must be a string when provided.`);
    }

    if (
      message.role === "tool" &&
      (typeof message.tool_call_id !== "string" || message.tool_call_id.length === 0)
    ) {
      return invalidRequest(`messages[${index}].tool_call_id must be a non-empty string.`);
    }

    messages.push({
      role: message.role,
      content: message.content,
      name: message.name,
      tool_call_id: message.tool_call_id,
      tool_calls: toolCalls
    });
  }

  const stream = body.stream === true;
  if (body.stream !== undefined && typeof body.stream !== "boolean") {
    return invalidRequest("stream must be a boolean when provided.");
  }

  const model = typeof body.model === "string" && body.model.length > 0 ? body.model : defaultModel;

  return {
    model,
    messages,
    stream,
    tools: body.tools
  };
}

export function chatMessagesToPrompt(request: ChatCompletionRequest): string {
  const lines = [
    "Continue the following conversation as the assistant.",
    "Preserve the user's intent and answer directly.",
    "",
    "<conversation>"
  ];

  for (const message of request.messages) {
    const name = typeof message.name === "string" && message.name.length > 0 ? ` ${message.name}` : "";
    const toolCallId =
      message.role === "tool" && typeof message.tool_call_id === "string"
        ? ` tool_call_id=${message.tool_call_id}`
        : "";
    lines.push(`[${message.role}${name}${toolCallId}]`);
    lines.push(contentToText(message.content));

    if (message.tool_calls !== undefined) {
      lines.push("[assistant tool_calls]");
      lines.push(stableJson(message.tool_calls));
    }
  }

  lines.push("</conversation>");

  if (request.tools !== undefined) {
    lines.push("");
    lines.push(
      "The client supplied OpenAI-style tool definitions. Treat them as application context. If tool results are present in the conversation, use them as observations and do not invent missing tool output."
    );
    lines.push(stableJson(request.tools));
  }

  return lines.join("\n");
}

export function createChatCompletionResponse(input: {
  shape: ChatCompletionShape;
  content: string;
  toolCalls: OpenAIChatToolCall[];
  finishReason: "stop" | "tool_calls";
  usage: OpenAIChatUsage | null;
}) {
  return {
    id: input.shape.id,
    object: "chat.completion",
    created: input.shape.created,
    model: input.shape.model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: input.toolCalls.length > 0 && input.content.length === 0 ? null : input.content,
          tool_calls: input.toolCalls.length > 0 ? input.toolCalls : undefined
        },
        logprobs: null,
        finish_reason: input.finishReason
      }
    ],
    usage: input.usage
  };
}

export function streamEventToChatCompletionChunk(input: {
  shape: ChatCompletionShape;
  event: StreamEvent;
  toolCallIndex: number;
}) {
  if (input.event.type === "message_delta") {
    return createChatCompletionChunk(input.shape, {
      content: input.event.text
    });
  }

  if (input.event.type === "tool_call") {
    return createChatCompletionChunk(input.shape, {
      tool_calls: [
        {
          index: input.toolCallIndex,
          id: input.event.callId,
          type: "function",
          function: {
            name: input.event.name,
            arguments: stableJson(input.event.arguments ?? {})
          }
        }
      ]
    });
  }

  return null;
}

export function createInitialChatCompletionChunk(shape: ChatCompletionShape) {
  return createChatCompletionChunk(shape, {
    role: "assistant"
  });
}

export function createFinalChatCompletionChunk(
  shape: ChatCompletionShape,
  finishReason: "stop" | "tool_calls",
  usage: OpenAIChatUsage | null
) {
  return {
    id: shape.id,
    object: "chat.completion.chunk",
    created: shape.created,
    model: shape.model,
    choices: [
      {
        index: 0,
        delta: {},
        logprobs: null,
        finish_reason: finishReason
      }
    ],
    usage
  };
}

export function openAIUsageFromTokenUsage(usage: TokenUsage | undefined): OpenAIChatUsage | null {
  if (!usage) {
    return null;
  }

  return {
    prompt_tokens: usage.promptTokens,
    completion_tokens: usage.completionTokens,
    total_tokens: usage.totalTokens,
    ...(usage.cachedPromptTokens !== undefined
      ? { prompt_tokens_details: { cached_tokens: usage.cachedPromptTokens } }
      : {})
  };
}

export function openAIErrorPayload(error: GatewayError) {
  return {
    error: {
      message: error.message,
      type: openAIErrorType(error),
      code: error.code,
      param: null,
      retry_after_seconds: error.retryAfterSeconds
    }
  };
}

function createChatCompletionChunk(shape: ChatCompletionShape, delta: Record<string, unknown>) {
  return {
    id: shape.id,
    object: "chat.completion.chunk",
    created: shape.created,
    model: shape.model,
    choices: [
      {
        index: 0,
        delta,
        logprobs: null,
        finish_reason: null
      }
    ]
  };
}

function invalidRequest(message: string): GatewayError {
  return new GatewayError({
    code: "invalid_request",
    message,
    httpStatus: 400
  });
}

function parseToolCalls(value: unknown, path: string): OpenAIChatToolCall[] | GatewayError {
  if (!Array.isArray(value)) {
    return invalidRequest(`${path} must be an array.`);
  }

  const toolCalls: OpenAIChatToolCall[] = [];
  for (const [index, item] of value.entries()) {
    const itemPath = `${path}[${index}]`;
    if (!isRecord(item)) {
      return invalidRequest(`${itemPath} must be an object.`);
    }
    if (typeof item.id !== "string" || item.id.length === 0) {
      return invalidRequest(`${itemPath}.id must be a non-empty string.`);
    }
    if (item.type !== "function") {
      return invalidRequest(`${itemPath}.type must be function.`);
    }
    if (!isRecord(item.function)) {
      return invalidRequest(`${itemPath}.function must be an object.`);
    }
    if (typeof item.function.name !== "string" || item.function.name.length === 0) {
      return invalidRequest(`${itemPath}.function.name must be a non-empty string.`);
    }
    if (typeof item.function.arguments !== "string") {
      return invalidRequest(`${itemPath}.function.arguments must be a string.`);
    }

    toolCalls.push({
      id: item.id,
      type: "function",
      function: {
        name: item.function.name,
        arguments: item.function.arguments
      }
    });
  }

  return toolCalls;
}

function contentToText(content: unknown): string {
  if (content === null || content === undefined) {
    return "";
  }
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content.map(contentPartToText).filter(Boolean).join("\n");
  }
  return stableJson(content);
}

function contentPartToText(part: unknown): string {
  if (!isRecord(part)) {
    return String(part);
  }
  if (part.type === "text" && typeof part.text === "string") {
    return part.text;
  }
  if (part.type === "input_text" && typeof part.text === "string") {
    return part.text;
  }
  if (part.type === "output_text" && typeof part.text === "string") {
    return part.text;
  }
  return stableJson(part);
}

function stableJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function openAIErrorType(error: GatewayError): string {
  if (error.httpStatus === 400) {
    return "invalid_request_error";
  }
  if (error.httpStatus === 401) {
    return "authentication_error";
  }
  if (error.httpStatus === 429) {
    return "rate_limit_error";
  }
  return "server_error";
}
