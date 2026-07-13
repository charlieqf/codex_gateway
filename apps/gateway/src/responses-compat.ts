import { randomUUID } from "node:crypto";
import { GatewayError, isRecord } from "@codex-gateway/core";
import type {
  ChatCompletionMessage,
  ChatCompletionToolChoice,
  OpenAIChatToolCall,
  OpenAIChatToolDefinition
} from "./openai-compat.js";

export interface ParsedResponsesRequest {
  model: string;
  stream: boolean;
  instructions: string | null;
  reasoningEffort?: string;
  promptCacheKey: string | null;
  tools: OpenAIChatToolDefinition[];
  toolChoice: ChatCompletionToolChoice;
  chatBody: Record<string, unknown>;
}

export interface ResponsesSseEvent {
  event: string;
  data: Record<string, unknown>;
}

export interface ResponsesResult {
  response: Record<string, unknown>;
  events: ResponsesSseEvent[];
}

export function parseResponsesRequest(
  body: unknown,
  requiredModel = "goldencode"
): ParsedResponsesRequest | GatewayError {
  if (!isRecord(body)) {
    return invalidRequest("Request body must be a JSON object.");
  }

  const model = typeof body.model === "string" ? body.model.trim() : "";
  if (!model) {
    return invalidRequest("model must be a non-empty string.");
  }
  if (model !== requiredModel) {
    return invalidRequest(`This Responses endpoint requires model=${requiredModel}.`);
  }

  if (body.stream !== undefined && typeof body.stream !== "boolean") {
    return invalidRequest("stream must be a boolean when provided.");
  }
  const stream = body.stream === true;

  let instructions: string | null = null;
  if (body.instructions !== undefined && body.instructions !== null) {
    if (typeof body.instructions !== "string") {
      return invalidRequest("instructions must be a string when provided.");
    }
    instructions = body.instructions;
  }

  const messages: ChatCompletionMessage[] = [];
  if (instructions?.trim()) {
    messages.push({ role: "developer", content: instructions });
  }
  const inputError = appendResponsesInput(messages, body.input);
  if (inputError) {
    return inputError;
  }
  if (messages.length === 0) {
    return invalidRequest("input must contain at least one supported message or tool item.");
  }

  const tools = parseResponsesTools(body.tools);
  if (tools instanceof GatewayError) {
    return tools;
  }
  const toolChoice = parseResponsesToolChoice(body.tool_choice, tools);
  if (toolChoice instanceof GatewayError) {
    return toolChoice;
  }

  let reasoningEffort: string | undefined;
  if (body.reasoning !== undefined && body.reasoning !== null) {
    if (!isRecord(body.reasoning)) {
      return invalidRequest("reasoning must be an object when provided.");
    }
    if (body.reasoning.effort !== undefined && body.reasoning.effort !== null) {
      if (
        typeof body.reasoning.effort !== "string" ||
        body.reasoning.effort.trim().length === 0
      ) {
        return invalidRequest("reasoning.effort must be a non-empty string when provided.");
      }
      reasoningEffort = body.reasoning.effort.trim();
    }
  }

  let promptCacheKey: string | null = null;
  if (body.prompt_cache_key !== undefined && body.prompt_cache_key !== null) {
    if (
      typeof body.prompt_cache_key !== "string" ||
      body.prompt_cache_key.trim().length === 0 ||
      body.prompt_cache_key.trim().length > 128
    ) {
      return invalidRequest("prompt_cache_key must be a string between 1 and 128 characters.");
    }
    promptCacheKey = body.prompt_cache_key.trim();
  }

  const chatBody: Record<string, unknown> = {
    model,
    messages,
    stream: false,
    tools,
    tool_choice: toolChoice
  };
  if (reasoningEffort !== undefined) {
    chatBody.reasoning_effort = reasoningEffort;
  }

  return {
    model,
    stream,
    instructions,
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    promptCacheKey,
    tools,
    toolChoice,
    chatBody
  };
}

export function createResponsesResult(
  request: ParsedResponsesRequest,
  chatCompletion: unknown,
  now = new Date()
): ResponsesResult | GatewayError {
  if (!isRecord(chatCompletion)) {
    return upstreamShapeError();
  }
  const choices = chatCompletion.choices;
  if (!Array.isArray(choices) || !isRecord(choices[0]) || !isRecord(choices[0].message)) {
    return upstreamShapeError();
  }

  const message = choices[0].message;
  const output: Array<Record<string, unknown>> = [];
  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    for (const rawToolCall of message.tool_calls) {
      const toolCall = parseChatToolCall(rawToolCall);
      if (toolCall instanceof GatewayError) {
        return toolCall;
      }
      output.push({
        id: `fc_${randomUUID().replaceAll("-", "")}`,
        type: "function_call",
        status: "completed",
        call_id: toolCall.id,
        name: toolCall.function.name,
        arguments: toolCall.function.arguments
      });
    }
  } else {
    const content = typeof message.content === "string" ? message.content : "";
    output.push({
      id: `msg_${randomUUID().replaceAll("-", "")}`,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: content, annotations: [] }]
    });
  }

  const responseId = `resp_${randomUUID().replaceAll("-", "")}`;
  const createdAt = Math.floor(now.getTime() / 1000);
  const usage = responsesUsage(chatCompletion.usage);
  const response = baseResponse({
    id: responseId,
    createdAt,
    status: "completed",
    model: request.model,
    output,
    instructions: request.instructions,
    reasoningEffort: request.reasoningEffort ?? null,
    toolChoice: request.toolChoice,
    tools: request.tools,
    usage
  });

  return {
    response,
    events: responsesEvents(response, output, request, createdAt, usage)
  };
}

function appendResponsesInput(
  messages: ChatCompletionMessage[],
  input: unknown
): GatewayError | null {
  if (typeof input === "string") {
    messages.push({ role: "user", content: input });
    return null;
  }
  if (!Array.isArray(input)) {
    return invalidRequest("input must be a string or an array.");
  }

  for (const [index, item] of input.entries()) {
    if (!isRecord(item) || typeof item.type !== "string") {
      return invalidRequest(`input[${index}] must be an object with a type.`);
    }
    if (item.type === "reasoning") {
      continue;
    }
    if (item.type === "message") {
      if (
        typeof item.role !== "string" ||
        !["system", "developer", "user", "assistant"].includes(item.role)
      ) {
        return invalidRequest(`input[${index}].role is not supported.`);
      }
      const text = responsesContentText(item.content, `input[${index}].content`);
      if (text instanceof GatewayError) {
        return text;
      }
      messages.push({ role: item.role, content: text });
      continue;
    }
    if (item.type === "function_call") {
      if (
        typeof item.call_id !== "string" ||
        !item.call_id ||
        typeof item.name !== "string" ||
        !item.name ||
        typeof item.arguments !== "string"
      ) {
        return invalidRequest(`input[${index}] is not a valid function_call item.`);
      }
      const call: OpenAIChatToolCall = {
        id: item.call_id,
        type: "function",
        function: { name: item.name, arguments: item.arguments }
      };
      const previous = messages.at(-1);
      if (
        previous?.role === "assistant" &&
        previous.content === null &&
        Array.isArray(previous.tool_calls)
      ) {
        previous.tool_calls.push(call);
      } else {
        messages.push({ role: "assistant", content: null, tool_calls: [call] });
      }
      continue;
    }
    if (item.type === "function_call_output") {
      if (typeof item.call_id !== "string" || !item.call_id) {
        return invalidRequest(`input[${index}].call_id must be a non-empty string.`);
      }
      const output = toolOutputText(item.output, `input[${index}].output`);
      if (output instanceof GatewayError) {
        return output;
      }
      messages.push({ role: "tool", tool_call_id: item.call_id, content: output });
      continue;
    }
    return invalidRequest(`input[${index}].type=${item.type} is not supported.`);
  }
  return null;
}

function responsesContentText(value: unknown, path: string): string | GatewayError {
  if (typeof value === "string") {
    return value;
  }
  if (!Array.isArray(value)) {
    return invalidRequest(`${path} must be a string or an array.`);
  }
  const parts: string[] = [];
  for (const [index, part] of value.entries()) {
    if (
      !isRecord(part) ||
      !["input_text", "output_text", "text"].includes(String(part.type)) ||
      typeof part.text !== "string"
    ) {
      return invalidRequest(`${path}[${index}] must be a supported text part.`);
    }
    parts.push(part.text);
  }
  return parts.join("");
}

function toolOutputText(value: unknown, path: string): string | GatewayError {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return responsesContentText(value, path);
  }
  if (value === null || value === undefined) {
    return "";
  }
  try {
    return JSON.stringify(value);
  } catch {
    return invalidRequest(`${path} must be serializable.`);
  }
}

function parseResponsesTools(value: unknown): OpenAIChatToolDefinition[] | GatewayError {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    return invalidRequest("tools must be an array when provided.");
  }
  const tools: OpenAIChatToolDefinition[] = [];
  for (const [index, item] of value.entries()) {
    if (!isRecord(item) || typeof item.type !== "string") {
      return invalidRequest(`tools[${index}] must be an object with a type.`);
    }
    if (item.type !== "function") {
      continue;
    }
    if (typeof item.name !== "string" || !item.name) {
      return invalidRequest(`tools[${index}].name must be a non-empty string.`);
    }
    if (item.parameters !== undefined && !isRecord(item.parameters)) {
      return invalidRequest(`tools[${index}].parameters must be an object.`);
    }
    tools.push({
      type: "function",
      function: {
        name: item.name,
        ...(typeof item.description === "string" ? { description: item.description } : {}),
        ...(isRecord(item.parameters) ? { parameters: item.parameters } : {})
      }
    });
  }
  return tools;
}

function parseResponsesToolChoice(
  value: unknown,
  tools: OpenAIChatToolDefinition[]
): ChatCompletionToolChoice | GatewayError {
  if (value === undefined || value === null) {
    return "auto";
  }
  if (value === "auto" || value === "none" || value === "required") {
    return value;
  }
  if (isRecord(value) && value.type === "function" && typeof value.name === "string") {
    if (!tools.some((tool) => tool.function.name === value.name)) {
      return invalidRequest(`tool_choice references unknown function ${value.name}.`);
    }
    return { type: "function", function: { name: value.name } };
  }
  return invalidRequest("tool_choice is not supported.");
}

function parseChatToolCall(value: unknown): OpenAIChatToolCall | GatewayError {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    value.type !== "function" ||
    !isRecord(value.function) ||
    typeof value.function.name !== "string" ||
    typeof value.function.arguments !== "string"
  ) {
    return upstreamShapeError();
  }
  return {
    id: value.id,
    type: "function",
    function: { name: value.function.name, arguments: value.function.arguments }
  };
}

function responsesEvents(
  completedResponse: Record<string, unknown>,
  output: Array<Record<string, unknown>>,
  request: ParsedResponsesRequest,
  createdAt: number,
  usage: Record<string, unknown> | null
): ResponsesSseEvent[] {
  const responseId = String(completedResponse.id);
  const created = baseResponse({
    id: responseId,
    createdAt,
    status: "in_progress",
    model: request.model,
    output: [],
    instructions: request.instructions,
    reasoningEffort: request.reasoningEffort ?? null,
    toolChoice: request.toolChoice,
    tools: request.tools,
    usage: null
  });
  const events: ResponsesSseEvent[] = [
    event("response.created", { response: created })
  ];

  output.forEach((item, outputIndex) => {
    if (item.type === "function_call") {
      const pending = { ...item, status: "in_progress", arguments: "" };
      events.push(event("response.output_item.added", { output_index: outputIndex, item: pending }));
      events.push(
        event("response.function_call_arguments.delta", {
          item_id: item.id,
          output_index: outputIndex,
          delta: item.arguments
        })
      );
      events.push(
        event("response.function_call_arguments.done", {
          item_id: item.id,
          output_index: outputIndex,
          arguments: item.arguments
        })
      );
      events.push(event("response.output_item.done", { output_index: outputIndex, item }));
      return;
    }

    const content = Array.isArray(item.content) && isRecord(item.content[0])
      ? item.content[0]
      : { type: "output_text", text: "", annotations: [] };
    const text = typeof content.text === "string" ? content.text : "";
    events.push(
      event("response.output_item.added", {
        output_index: outputIndex,
        item: { ...item, status: "in_progress", content: [] }
      })
    );
    events.push(
      event("response.content_part.added", {
        item_id: item.id,
        output_index: outputIndex,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] }
      })
    );
    events.push(
      event("response.output_text.delta", {
        item_id: item.id,
        output_index: outputIndex,
        content_index: 0,
        delta: text
      })
    );
    events.push(
      event("response.output_text.done", {
        item_id: item.id,
        output_index: outputIndex,
        content_index: 0,
        text
      })
    );
    events.push(
      event("response.content_part.done", {
        item_id: item.id,
        output_index: outputIndex,
        content_index: 0,
        part: content
      })
    );
    events.push(event("response.output_item.done", { output_index: outputIndex, item }));
  });

  events.push(
    event("response.completed", {
      response: { ...completedResponse, usage }
    })
  );
  return events;
}

function baseResponse(input: {
  id: string;
  createdAt: number;
  status: "in_progress" | "completed";
  model: string;
  output: Array<Record<string, unknown>>;
  instructions: string | null;
  reasoningEffort: string | null;
  toolChoice: ChatCompletionToolChoice;
  tools: OpenAIChatToolDefinition[];
  usage: Record<string, unknown> | null;
}): Record<string, unknown> {
  return {
    id: input.id,
    object: "response",
    created_at: input.createdAt,
    completed_at: input.status === "completed" ? input.createdAt : null,
    status: input.status,
    error: null,
    incomplete_details: null,
    instructions: input.instructions,
    max_output_tokens: null,
    model: input.model,
    output: input.output,
    parallel_tool_calls: false,
    previous_response_id: null,
    reasoning: { effort: input.reasoningEffort, summary: null },
    store: false,
    temperature: null,
    text: { format: { type: "text" } },
    tool_choice: responsesToolChoice(input.toolChoice),
    tools: input.tools.map((tool) => ({ type: "function", ...tool.function })),
    top_p: null,
    truncation: "disabled",
    usage: input.usage,
    user: null,
    metadata: {}
  };
}

function responsesToolChoice(value: ChatCompletionToolChoice): unknown {
  if (typeof value === "string") {
    return value;
  }
  return { type: "function", name: value.function.name };
}

function responsesUsage(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) {
    return null;
  }
  const inputTokens = numberOrZero(value.prompt_tokens);
  const outputTokens = numberOrZero(value.completion_tokens);
  const totalTokens = numberOrZero(value.total_tokens) || inputTokens + outputTokens;
  const inputDetails = isRecord(value.prompt_tokens_details) ? value.prompt_tokens_details : {};
  const outputDetails = isRecord(value.completion_tokens_details)
    ? value.completion_tokens_details
    : {};
  return {
    input_tokens: inputTokens,
    input_tokens_details: { cached_tokens: numberOrZero(inputDetails.cached_tokens) },
    output_tokens: outputTokens,
    output_tokens_details: { reasoning_tokens: numberOrZero(outputDetails.reasoning_tokens) },
    total_tokens: totalTokens
  };
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function event(eventName: string, payload: Record<string, unknown>): ResponsesSseEvent {
  return { event: eventName, data: { type: eventName, ...payload } };
}

function invalidRequest(message: string): GatewayError {
  return new GatewayError({ code: "invalid_request", message, httpStatus: 400 });
}

function upstreamShapeError(): GatewayError {
  return new GatewayError({
    code: "service_unavailable",
    message: "GoldenCode returned an invalid compatibility response.",
    httpStatus: 503
  });
}
