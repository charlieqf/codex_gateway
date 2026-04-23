import { Ajv } from "ajv";
import { GatewayError, type StreamEvent, type TokenUsage } from "@codex-gateway/core";

const toolSchemaValidator = new Ajv({
  allErrors: true,
  strict: false
});

export interface OpenAIChatToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface OpenAIChatToolDefinition {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
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
  tools?: OpenAIChatToolDefinition[];
  toolChoice: ChatCompletionToolChoice;
}

export type ChatCompletionToolChoice =
  | "auto"
  | "none"
  | "required"
  | {
      type: "function";
      function: {
        name: string;
      };
    };

export type StrictToolDecision =
  | { type: "message"; content: string }
  | { type: "tool_calls"; toolCalls: OpenAIChatToolCall[] };

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

  let tools: OpenAIChatToolDefinition[] | undefined;
  if (body.tools !== undefined) {
    const parsedTools = parseToolDefinitions(body.tools);
    if (parsedTools instanceof GatewayError) {
      return parsedTools;
    }
    tools = parsedTools;
  }

  const toolChoice = parseToolChoice(body.tool_choice, tools ?? []);
  if (toolChoice instanceof GatewayError) {
    return toolChoice;
  }

  return {
    model,
    messages,
    stream,
    tools,
    toolChoice
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

  if (request.tools !== undefined && request.toolChoice !== "none") {
    lines.push("");
    lines.push(
      "The client supplied OpenAI-style tool definitions. Treat them as application context. If tool results are present in the conversation, use them as observations and do not invent missing tool output."
    );
    lines.push(stableJson(request.tools));
  } else if (request.toolChoice === "none") {
    lines.push("");
    lines.push("The client set tool_choice=none. Do not call tools; answer directly.");
  }

  return lines.join("\n");
}

export function hasStrictClientTools(request: ChatCompletionRequest): boolean {
  return (
    request.tools !== undefined &&
    request.tools.length > 0 &&
    request.toolChoice !== "none"
  );
}

export function chatMessagesToStrictToolPrompt(request: ChatCompletionRequest): string {
  const lines = [
    "Continue the following conversation as the assistant.",
    "You are operating in strict client-defined tools mode.",
    "Do not call or assume any native server-side tools.",
    "If a tool is needed, choose only from the client-declared tools below.",
    "Return only one JSON object and no markdown.",
    "",
    "Allowed output shapes:",
    '{"type":"message","content":"final answer text"}',
    '{"type":"tool_calls","tool_calls":[{"id":"call_optional","name":"tool_name","arguments":{}}]}',
    "",
    "Rules:",
    "- Tool names must exactly match one of the client-declared function.name values.",
    "- Tool arguments must satisfy that tool's JSON Schema.",
    "- If no tool is needed, return type=message.",
    strictToolChoiceInstruction(request.toolChoice),
    "",
    "<client_tools>",
    stableJson(request.tools ?? []),
    "</client_tools>",
    "",
    "<conversation>"
  ];

  appendMessages(lines, request);
  lines.push("</conversation>");

  return lines.join("\n");
}

export function chatMessagesToStrictToolRepairPrompt(input: {
  originalPrompt: string;
  invalidOutput: string;
  validationError: string;
}): string {
  return [
    input.originalPrompt,
    "",
    "Your previous output was invalid for strict client-defined tools mode.",
    "Return only a corrected JSON object using the allowed output shapes.",
    "",
    "<validation_error>",
    input.validationError,
    "</validation_error>",
    "",
    "<invalid_output>",
    input.invalidOutput,
    "</invalid_output>"
  ].join("\n");
}

export function parseStrictToolDecision(input: {
  text: string;
  tools: OpenAIChatToolDefinition[];
  toolChoice: ChatCompletionToolChoice;
  createToolCallId: () => string;
}): StrictToolDecision | GatewayError {
  const parsed = parseJsonObject(input.text);
  if (parsed instanceof GatewayError) {
    return parsed;
  }

  if (parsed.type === "message") {
    if (input.toolChoice === "required") {
      return toolCallValidationFailed("tool_choice=required requires a tool_calls output.");
    }
    const forcedToolName = forcedToolChoiceName(input.toolChoice);
    if (forcedToolName) {
      return toolCallValidationFailed(
        `tool_choice requires tool '${forcedToolName}' to be called.`
      );
    }
    if (typeof parsed.content !== "string") {
      return toolCallValidationFailed("Strict message output must include string content.");
    }
    return {
      type: "message",
      content: parsed.content
    };
  }

  if (parsed.type !== "tool_calls" || !Array.isArray(parsed.tool_calls)) {
    return toolCallValidationFailed("Strict output must be type=message or type=tool_calls.");
  }

  const registry = new Map(input.tools.map((tool) => [tool.function.name, tool]));
  const forcedToolName = forcedToolChoiceName(input.toolChoice);
  const toolCalls: OpenAIChatToolCall[] = [];
  for (const [index, item] of parsed.tool_calls.entries()) {
    if (!isRecord(item)) {
      return toolCallValidationFailed(`tool_calls[${index}] must be an object.`);
    }

    const name = strictToolCallName(item);
    if (typeof name !== "string" || name.length === 0) {
      return toolCallValidationFailed(`tool_calls[${index}].name must be a non-empty string.`);
    }

    const tool = registry.get(name);
    if (!tool) {
      return toolCallValidationFailed(`Tool '${name}' was not declared by the client.`);
    }
    if (forcedToolName && name !== forcedToolName) {
      return toolCallValidationFailed(
        `tool_choice requires tool '${forcedToolName}', but tool_calls[${index}] used '${name}'.`
      );
    }

    const rawArguments = strictToolCallArguments(item);
    const argumentValue =
      typeof rawArguments === "string" ? parseJsonObject(rawArguments) : rawArguments;
    if (argumentValue instanceof GatewayError) {
      return argumentValue;
    }
    if (!isJsonSerializable(argumentValue)) {
      return toolCallValidationFailed(`Tool '${name}' arguments must be JSON serializable.`);
    }

    const validationError = validateAgainstToolSchema(tool, argumentValue);
    if (validationError) {
      return toolCallValidationFailed(`Tool '${name}' arguments invalid: ${validationError}`);
    }

    const id = typeof item.id === "string" && item.id.length > 0 ? item.id : input.createToolCallId();
    toolCalls.push({
      id,
      type: "function",
      function: {
        name,
        arguments: JSON.stringify(argumentValue)
      }
    });
  }

  if (toolCalls.length === 0) {
    return toolCallValidationFailed("type=tool_calls requires at least one tool call.");
  }

  return {
    type: "tool_calls",
    toolCalls
  };
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
          content: input.toolCalls.length > 0 ? null : input.content,
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

function parseToolChoice(
  value: unknown,
  tools: OpenAIChatToolDefinition[]
): ChatCompletionToolChoice | GatewayError {
  if (value === undefined) {
    return "auto";
  }

  if (typeof value === "string") {
    if (value === "auto" || value === "none") {
      return value;
    }
    if (value === "required") {
      if (tools.length === 0) {
        return invalidRequest("tool_choice=required requires at least one tool.");
      }
      return value;
    }
    return invalidRequest("tool_choice must be auto, none, required, or a function choice.");
  }

  if (!isRecord(value)) {
    return invalidRequest("tool_choice must be a string or an object when provided.");
  }
  if (value.type !== "function") {
    return invalidRequest("tool_choice.type must be function.");
  }
  if (!isRecord(value.function)) {
    return invalidRequest("tool_choice.function must be an object.");
  }
  const toolChoiceFunction = value.function;
  if (typeof toolChoiceFunction.name !== "string" || toolChoiceFunction.name.length === 0) {
    return invalidRequest("tool_choice.function.name must be a non-empty string.");
  }
  if (!tools.some((tool) => tool.function.name === toolChoiceFunction.name)) {
    return invalidRequest(
      `tool_choice.function.name '${toolChoiceFunction.name}' was not declared in tools.`
    );
  }

  return {
    type: "function",
    function: {
      name: toolChoiceFunction.name
    }
  };
}

function parseToolDefinitions(value: unknown): OpenAIChatToolDefinition[] | GatewayError {
  if (!Array.isArray(value)) {
    return invalidRequest("tools must be an array when provided.");
  }

  const tools: OpenAIChatToolDefinition[] = [];
  const names = new Set<string>();
  for (const [index, item] of value.entries()) {
    const itemPath = `tools[${index}]`;
    if (!isRecord(item)) {
      return invalidRequest(`${itemPath} must be an object.`);
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
    if (names.has(item.function.name)) {
      return invalidRequest(`Duplicate tool function.name '${item.function.name}'.`);
    }
    names.add(item.function.name);

    if (
      item.function.description !== undefined &&
      typeof item.function.description !== "string"
    ) {
      return invalidRequest(`${itemPath}.function.description must be a string when provided.`);
    }

    let parameters: Record<string, unknown> | undefined;
    if (item.function.parameters !== undefined) {
      if (!isRecord(item.function.parameters)) {
        return invalidRequest(`${itemPath}.function.parameters must be an object when provided.`);
      }
      const schemaError = compileSchema(item.function.parameters);
      if (schemaError) {
        return invalidRequest(`${itemPath}.function.parameters is not valid JSON Schema: ${schemaError}`);
      }
      parameters = item.function.parameters;
    }

    tools.push({
      type: "function",
      function: {
        name: item.function.name,
        ...(item.function.description !== undefined
          ? { description: item.function.description }
          : {}),
        ...(parameters !== undefined ? { parameters } : {})
      }
    });
  }

  return tools;
}

function appendMessages(lines: string[], request: ChatCompletionRequest): void {
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

function parseJsonObject(value: string): Record<string, unknown> | GatewayError {
  const trimmed = stripJsonFence(value.trim());
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!isRecord(parsed)) {
      return toolCallValidationFailed("Expected a JSON object.");
    }
    return parsed;
  } catch {
    return toolCallValidationFailed("Expected valid JSON object output.");
  }
}

function stripJsonFence(value: string): string {
  const match = value.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return match ? match[1].trim() : value;
}

function strictToolCallName(item: Record<string, unknown>): unknown {
  if (typeof item.name === "string") {
    return item.name;
  }
  if (isRecord(item.function) && typeof item.function.name === "string") {
    return item.function.name;
  }
  return undefined;
}

function strictToolCallArguments(item: Record<string, unknown>): unknown {
  if ("arguments" in item) {
    return item.arguments;
  }
  if (isRecord(item.function) && "arguments" in item.function) {
    return item.function.arguments;
  }
  return {};
}

function validateAgainstToolSchema(
  tool: OpenAIChatToolDefinition,
  value: unknown
): string | null {
  const schema = tool.function.parameters ?? {
    type: "object",
    additionalProperties: true
  };
  const validate = toolSchemaValidator.compile(schema);
  if (validate(value)) {
    return null;
  }
  return toolSchemaValidator.errorsText(validate.errors, { separator: "; " });
}

function forcedToolChoiceName(toolChoice: ChatCompletionToolChoice): string | null {
  return typeof toolChoice === "object" ? toolChoice.function.name : null;
}

function strictToolChoiceInstruction(toolChoice: ChatCompletionToolChoice): string {
  if (toolChoice === "required") {
    return "- tool_choice=required: return type=tool_calls with at least one client-declared tool call.";
  }
  if (toolChoice === "none") {
    return "- tool_choice=none: return type=message and do not call tools.";
  }
  const forcedToolName = forcedToolChoiceName(toolChoice);
  if (forcedToolName) {
    return `- tool_choice requires function.name=${forcedToolName}: return type=tool_calls and call only that tool.`;
  }
  return "- tool_choice=auto: call a tool only when it is needed; otherwise return type=message.";
}

function compileSchema(schema: Record<string, unknown>): string | null {
  try {
    toolSchemaValidator.compile(schema);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

function isJsonSerializable(value: unknown): boolean {
  try {
    JSON.stringify(value);
    return true;
  } catch {
    return false;
  }
}

function toolCallValidationFailed(message: string): GatewayError {
  return new GatewayError({
    code: "tool_call_validation_failed",
    message,
    httpStatus: 502
  });
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
  if (error.httpStatus === 400 || error.httpStatus === 404) {
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
