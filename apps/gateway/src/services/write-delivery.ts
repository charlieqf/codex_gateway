import { createHash, randomUUID } from "node:crypto";
import { Ajv } from "ajv";
import { GatewayError, isRecord, type ToolValidationDetails } from "@codex-gateway/core";
import {
  createInitialChatCompletionChunk, createFinalChatCompletionChunk, toolArgumentValidation,
  type ChatCompletionRequest, type ChatCompletionShape, type OpenAIChatToolCall,
  type OpenAIChatToolDefinition, type OpenAIChatUsage
} from "../openai-compat.js";
import { writeDeliverySchemaJson, writeDeliverySchemaSha256 } from "./write-delivery-schema.js";

export { writeDeliverySchemaSha256 } from "./write-delivery-schema.js";
export const writeDeliveryToolName = "write_delivery_v1";
export const writeDeliveryCapability = "write-delivery-v1";
export const writeDeliveryLimits = Object.freeze({
  chunk_utf16_units: 4000,
  chunk_json_utf8_bytes: 32768,
  chunk_count: 256,
  payload_utf8_bytes: 1048576,
  arguments_utf8_bytes: 8388608,
  response_body_bytes: 12582912
});
export type WriteDeliveryLimits = { -readonly [K in keyof typeof writeDeliveryLimits]: number };
export interface BoundedWritePolicy {
  mode: "disabled" | "error" | "delivery";
  subjectIds?: readonly string[];
  limits?: Partial<WriteDeliveryLimits>;
  maxConcurrent?: number;
}
export function boundedWritePolicyFromEnv(env: NodeJS.ProcessEnv): BoundedWritePolicy {
  const mode = env.GATEWAY_BOUNDED_WRITE_MODE ?? "disabled";
  if (!["disabled", "error", "delivery"].includes(mode)) throw new Error("Invalid GATEWAY_BOUNDED_WRITE_MODE.");
  const maxConcurrent = Number(env.GATEWAY_WRITE_DELIVERY_MAX_CONCURRENT ?? 4);
  if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1) throw new Error("Invalid GATEWAY_WRITE_DELIVERY_MAX_CONCURRENT.");
  return {
    mode: mode as BoundedWritePolicy["mode"], maxConcurrent,
    subjectIds: (env.GATEWAY_BOUNDED_WRITE_SUBJECT_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean)
  };
}

/** No waiting queue or global file lock. A busy slot declines S, retaining A. */
export class WriteDeliveryAdmission {
  private active = 0;
  constructor(private readonly maximum: number) {
    if (!Number.isSafeInteger(maximum) || maximum < 1) throw new Error("Invalid write delivery concurrency.");
  }
  acquire(): (() => void) | undefined {
    if (this.active >= this.maximum) return;
    this.active += 1;
    let released = false;
    return () => { if (!released) { released = true; this.active -= 1; } };
  }
}
export function boundedWriteEnabled(policy: BoundedWritePolicy, subjectId: string): boolean {
  return policy.mode !== "disabled" && (!policy.subjectIds?.length || policy.subjectIds.includes(subjectId));
}

export interface WriteDeliveryNegotiation {
  requestId: string;
  subjectId: string;
  sessionId: string;
  turnId: string;
  nonce: string;
  limits: WriteDeliveryLimits;
}
type RequestHeaders = Record<string, string | string[] | undefined>;
function header(headers: RequestHeaders, key: string, max = 128): string | undefined {
  const value = headers[key];
  return typeof value === "string" && value.length > 0 && value.length <= max && !/[\r\n]/.test(value) ? value : undefined;
}
function base64url(value: string, maximum: number): Buffer | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length > Math.ceil(maximum * 4 / 3)) return;
  const bytes = Buffer.from(value, "base64url");
  return bytes.length <= maximum && bytes.toString("base64url") === value ? bytes : undefined;
}
const limitKeys = Object.keys(writeDeliveryLimits) as Array<keyof WriteDeliveryLimits>;
function effectiveLimits(value: unknown, local: Partial<WriteDeliveryLimits>): WriteDeliveryLimits | undefined {
  if (!isRecord(value) || Object.keys(value).length !== limitKeys.length || !limitKeys.every((key) => Object.hasOwn(value, key))) return;
  const result = { ...writeDeliveryLimits } as WriteDeliveryLimits;
  for (const key of limitKeys) {
    const offered = value[key];
    const configured = local[key] ?? writeDeliveryLimits[key];
    if (!Number.isSafeInteger(offered) || (offered as number) <= 0 || !Number.isSafeInteger(configured) || configured <= 0) return;
    result[key] = Math.min(offered as number, configured, writeDeliveryLimits[key]);
  }
  return result;
}

/** Receiver definitions and choices must never reach any model, including old paths. */
export function reservedWriteDeliveryRequestError(request: ChatCompletionRequest): GatewayError | undefined {
  if (request.tools?.some((tool) => tool.function.name.toLowerCase() === writeDeliveryToolName) ||
      (typeof request.toolChoice === "object" && request.toolChoice.function.name.toLowerCase() === writeDeliveryToolName) ||
      request.messages.some((message) => message.tool_calls?.some((call) => call.function.name.toLowerCase() === writeDeliveryToolName))) {
    return new GatewayError({ code: "invalid_request", httpStatus: 400,
      message: "write_delivery_v1 is a local delivery receiver and must not appear in model tools, tool_choice or replayed tool calls." });
  }
}
export function negotiateWriteDelivery(input: {
  headers: RequestHeaders; request: ChatCompletionRequest; requestId: string; subjectId: string;
  policy: BoundedWritePolicy;
}): WriteDeliveryNegotiation | undefined {
  if (input.policy.mode !== "delivery" || !boundedWriteEnabled(input.policy, input.subjectId) ||
      !input.request.stream || input.request.model !== "goldencode" || input.request.images?.length ||
      !ordinaryWriteTool(input.request)) return;
  const caps = header(input.headers, "x-medcode-client-capabilities", 1024)?.split(",").map((s) => s.trim());
  if (!caps?.includes(writeDeliveryCapability) || header(input.headers, "x-medcode-write-delivery-version") !== "1" ||
      header(input.headers, "x-medcode-write-delivery-schema-sha256") !== writeDeliverySchemaSha256) return;
  const nonce = header(input.headers, "x-medcode-write-delivery-nonce", 64);
  const nonceBytes = nonce && base64url(nonce, 48);
  const sessionId = header(input.headers, "x-medcode-client-session-id");
  const turnId = header(input.headers, "x-medcode-client-turn-id");
  const encodedLimits = header(input.headers, "x-medcode-write-delivery-limits", 2731);
  if (!nonce || !nonceBytes || nonceBytes.length < 16 || !sessionId || !turnId || !encodedLimits ||
      !input.subjectId || !input.requestId || input.requestId.length > 128) return;
  try {
    const bytes = base64url(encodedLimits, 2048);
    const limits = bytes && effectiveLimits(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), input.policy.limits ?? {});
    if (!limits) return;
    return { requestId: input.requestId, subjectId: input.subjectId, sessionId, turnId, nonce, limits };
  } catch { return; }
}

/** Recognize the ordinary Desktop write, excluding branch-dependent content schemas. */
function ordinaryWriteTool(request: ChatCompletionRequest): OpenAIChatToolDefinition | undefined {
  if (request.toolChoice === "none" || (typeof request.toolChoice === "object" && request.toolChoice.function.name !== "write")) return;
  const tools = request.tools?.filter((tool) => tool.function.name === "write");
  if (tools?.length !== 1) return;
  const tool = tools[0];
  const schema = tool.function.parameters;
  if (!schema || schema.type !== "object" || schema.additionalProperties !== false || !isRecord(schema.properties) ||
      !Array.isArray(schema.required) || !schema.required.includes("filePath") || !schema.required.includes("content") ||
      schema.required.some((key) => !["filePath", "content", "mode", "chunk"].includes(String(key)))) return;
  if (!Object.keys(schema).every((key) => ["$schema", "$id", "$comment", "$defs", "definitions", "type", "title", "description", "properties", "required", "additionalProperties"].includes(key))) return;
  if (!Object.keys(schema.properties).every((key) => ["filePath", "content", "mode", "chunk", "artifact"].includes(key))) return;
  const content = schema.properties.content;
  if (!isRecord(content) || content.type !== "string" || !Number.isSafeInteger(content.maxLength) || (content.maxLength as number) < 1 ||
      !Object.keys(content).every((key) => ["type", "minLength", "maxLength", "title", "description", "$comment"].includes(key))) return;
  return tool;
}
export interface OversizedWrite {
  callId: string;
  content: string;
  originalArguments: { filePath: string; mode?: "overwrite" | "append"; chunk?: { index: number; total?: number } };
  details: Omit<ToolValidationDetails, "gateway_retry_attempted" | "remaining_budget_ms" | "stop_reason">;
}
export function classifyOversizedWrite(request: ChatCompletionRequest, calls: OpenAIChatToolCall[]): OversizedWrite | undefined {
  const tool = ordinaryWriteTool(request);
  // Unknown/mixed tool operations retain their existing validation/repair behavior.
  if (!tool || calls.length !== 1 || calls[0].function.name !== "write") return;
  const call = calls[0];
  let value: unknown;
  try { value = JSON.parse(call.function.arguments); } catch { return; }
  if (!isRecord(value) || typeof value.content !== "string" || typeof value.filePath !== "string" ||
      !Object.keys(value).every((key) => ["filePath", "content", "mode", "chunk"].includes(key))) return;
  if (!value.filePath.length || (Object.hasOwn(value, "mode") && value.mode !== "overwrite" && value.mode !== "append")) return;
  if (Object.hasOwn(value, "chunk")) {
    const chunk = value.chunk;
    if (!isRecord(chunk) || !Number.isSafeInteger(chunk.index) || (chunk.index as number) < 1 ||
        Object.keys(chunk).some((key) => key !== "index" && key !== "total") ||
        (Object.hasOwn(chunk, "total") && (!Number.isSafeInteger(chunk.total) || (chunk.total as number) < (chunk.index as number)))) return;
  }
  const failure = toolArgumentValidation(tool, value);
  if (!failure?.errors.length || !failure.errors.every((error) => error.keyword === "maxLength" &&
      error.instancePath === "/content" && error.schemaPath === "#/properties/content/maxLength")) return;
  let points = 0;
  for (const _ of value.content) points += 1;
  const { content, ...originalArguments } = value;
  return {
    callId: call.id || `call_${randomUUID()}`, content,
    originalArguments: originalArguments as OversizedWrite["originalArguments"],
    details: {
      kind: "content_too_long", tool_name: "write", keyword: "maxLength", instance_path: "/content",
      schema_path: "#/properties/content/maxLength", limit_code_points: failure.errors[0].params.limit as number,
      actual_code_points: points, actual_utf16_units: content.length, actual_utf8_bytes: byteLength(content),
      arguments_utf8_bytes: byteLength(call.function.arguments)
    }
  };
}
export function oversizedWriteError(input: {
  original: GatewayError; write: OversizedWrite; stopReason: string; remainingMs: number | null; retried: boolean;
}): GatewayError {
  return new GatewayError({
    code: "tool_call_validation_failed", httpStatus: 502, message: input.original.message,
    contractVersion: 1, failureKind: "schema_mismatch", transformedRetryAllowed: false,
    recommendedAction: "use_bounded_file_write",
    toolValidationDetails: { ...input.write.details, gateway_retry_attempted: input.retried,
      remaining_budget_ms: input.remainingMs, stop_reason: input.stopReason }
  });
}

const hash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const byteLength = (value: string) => Buffer.byteLength(value, "utf8");
const encode = (value: unknown) => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
if (hash(writeDeliverySchemaJson) !== writeDeliverySchemaSha256) throw new Error("Frozen write-delivery schema digest mismatch.");
const validateEnvelope = new Ajv({ allErrors: true, strict: false }).compile(JSON.parse(writeDeliverySchemaJson));
export function validWriteUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}
function safeEnd(value: string, end: number): number {
  const code = value.charCodeAt(end - 1);
  return end < value.length && code >= 0xd800 && code <= 0xdbff ? end - 1 : end;
}
export interface WriteDeliveryResponse {
  headers: Record<string, string>;
  frames: unknown[];
  toolCall: OpenAIChatToolCall;
  deliveryId: string;
  payloadBytes: number;
  argumentsBytes: number;
  responseBytes: number;
  chunkCount: number;
}
export function buildWriteDelivery(input: {
  write: OversizedWrite; negotiation: WriteDeliveryNegotiation; shape: ChatCompletionShape;
  content: string; usage: OpenAIChatUsage | null;
}): WriteDeliveryResponse | { stopReason: string } {
  const { write, negotiation: accepted, shape } = input;
  const limits = accepted.limits;
  if (!validWriteUnicode(write.content) || !validWriteUnicode(write.originalArguments.filePath)) return { stopReason: "write_delivery_invalid_unicode" };
  if (write.details.actual_utf8_bytes > limits.payload_utf8_bytes) return { stopReason: "write_delivery_payload_limit" };
  // Bound text carried beside the tool before constructing additional representations.
  if (byteLength(input.content) > limits.response_body_bytes) return { stopReason: "write_delivery_response_limit" };
  const chunks: Array<{ transport_chunk_index: number; offset_bytes: number; content: string }> = [];
  let position = 0, offset = 0;
  while (position < write.content.length) {
    if (chunks.length >= limits.chunk_count) return { stopReason: "write_delivery_chunk_count_limit" };
    let end = safeEnd(write.content, Math.min(write.content.length, position + limits.chunk_utf16_units));
    let chunk = { transport_chunk_index: chunks.length, offset_bytes: offset, content: write.content.slice(position, end) };
    while (end > position && byteLength(JSON.stringify(chunk)) > limits.chunk_json_utf8_bytes) {
      end = safeEnd(write.content, position + Math.floor((end - position) / 2));
      chunk = { ...chunk, content: write.content.slice(position, end) };
    }
    if (end <= position) return { stopReason: "write_delivery_chunk_limit" };
    chunks.push(chunk); offset += byteLength(chunk.content); position = end;
  }
  const deliveryId = `wdl_${randomUUID()}`;
  const envelope = {
    version: 1, delivery_id: deliveryId, original_tool_call_id: write.callId, original_tool_name: "write",
    original_arguments: write.originalArguments, operation: write.originalArguments.mode ?? "overwrite",
    payload_utf8_bytes: offset, payload_sha256: hash(write.content), transport_chunk_count: chunks.length, chunks
  };
  if (!validateEnvelope(envelope) || (write.originalArguments.chunk?.total !== undefined &&
      write.originalArguments.chunk.index > write.originalArguments.chunk.total)) return { stopReason: "write_delivery_envelope_invalid" };
  const argumentsJson = JSON.stringify(envelope);
  const argumentsBytes = byteLength(argumentsJson);
  if (argumentsBytes > limits.arguments_utf8_bytes) return { stopReason: "write_delivery_arguments_limit" };
  const toolCall: OpenAIChatToolCall = { id: write.callId, type: "function", function: { name: writeDeliveryToolName, arguments: argumentsJson } };
  const frames: unknown[] = [createInitialChatCompletionChunk(shape)];
  const event = (delta: unknown) => ({ ...shape, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] });
  if (input.content) frames.push(event({ content: input.content }));
  for (let start = 0; start < argumentsJson.length;) {
    const end = safeEnd(argumentsJson, Math.min(argumentsJson.length, start + 16384));
    frames.push(event({ tool_calls: [{ index: 0, ...(start === 0 ? { id: write.callId, type: "function" } : {}),
      function: { ...(start === 0 ? { name: writeDeliveryToolName } : {}), arguments: argumentsJson.slice(start, end) } }] }));
    start = end;
  }
  frames.push(createFinalChatCompletionChunk(shape, "tool_calls", null));
  if (input.usage) frames.push({ ...shape, object: "chat.completion.chunk", choices: [], usage: input.usage });
  const responseBytes = frames.reduce<number>((sum, frame) => sum + byteLength(`data: ${JSON.stringify(frame)}\n\n`), byteLength("data: [DONE]\n\n"));
  if (responseBytes > limits.response_body_bytes) return { stopReason: "write_delivery_response_limit" };
  const manifest = { version: 1, request_id: accepted.requestId, request_nonce: accepted.nonce,
    client_session_id: accepted.sessionId, client_turn_id: accepted.turnId, delivery_id: deliveryId,
    tool_call_id: write.callId, tool_name: writeDeliveryToolName, arguments_sha256: hash(argumentsJson) };
  return {
    headers: {
      "x-request-id": accepted.requestId,
      "x-medcode-accepted-capabilities": writeDeliveryCapability,
      "x-medcode-accepted-write-delivery-version": "1",
      "x-medcode-accepted-write-delivery-limits": encode(limits),
      "x-medcode-write-delivery-manifest": encode(manifest)
    }, frames, toolCall, deliveryId, payloadBytes: offset, argumentsBytes, responseBytes, chunkCount: chunks.length
  };
}
