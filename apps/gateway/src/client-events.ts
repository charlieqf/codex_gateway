import { createHash } from "node:crypto";
import { GatewayError, isRecord } from "@codex-gateway/core";

export const CLIENT_MESSAGE_TEXT_LIMIT_BYTES = 64 * 1024;
export const CLIENT_MESSAGE_BODY_LIMIT_BYTES = 512 * 1024;
export const CLIENT_DIAGNOSTIC_BODY_LIMIT_BYTES = 128 * 1024;
export const CLIENT_DIAGNOSTIC_METADATA_LIMIT_BYTES = 16 * 1024;

export interface ParsedClientMessageEventRequest {
  eventId: string;
  sessionId: string;
  messageId: string;
  createdAt: Date;
  appName: string;
  appVersion: string | null;
  agent: string | null;
  providerId: string | null;
  modelId: string | null;
  engine: string | null;
  text: string;
  textSha256: string;
  attachmentsJson: string;
}

export interface ParsedClientDiagnosticEventRequest {
  eventId: string;
  sessionId: string | null;
  messageId: string | null;
  toolCallId: string | null;
  providerId: string | null;
  modelId: string | null;
  createdAt: Date;
  appName: string;
  appVersion: string | null;
  category: string;
  action: string;
  status: "started" | "ok" | "error" | "aborted" | "timeout" | "queued" | "dropped";
  method: string | null;
  path: string | null;
  monoMs: number | null;
  durationMs: number | null;
  httpStatus: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  metadataJson: string;
}

interface NormalizedAttachment {
  type: string;
  filename: string | null;
  mime: string | null;
  size: number | null;
}

const forbiddenAttachmentKeys = new Set(["content", "data", "base64", "text", "path"]);
const forbiddenDiagnosticKeys = new Set([
  "access_token",
  "accesstoken",
  "authorization",
  "auth",
  "api_key",
  "api-key",
  "apikey",
  "bearer",
  "bearer_token",
  "bearertoken",
  "body",
  "client_secret",
  "clientsecret",
  "content",
  "credential",
  "credentials",
  "cookie",
  "data",
  "id_token",
  "idtoken",
  "key",
  "password",
  "prompt",
  "refresh_token",
  "refreshtoken",
  "request",
  "response",
  "secret",
  "text",
  "token",
  "x_api_key",
  "x-api-key",
  "xapikey"
]);
const diagnosticCategories = new Set([
  "http",
  "sse",
  "medevidence",
  "ui",
  "network",
  "agent_turn",
  "provider_stream",
  "tool",
  "fs",
  "sidecar",
  "renderer",
  "user_action",
  "system",
  "storage",
  "diagnostic_upload"
]);
const diagnosticStatuses = new Set([
  "started",
  "ok",
  "error",
  "aborted",
  "timeout",
  "queued",
  "dropped"
]);
const isoDateTimePattern =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

export function parseClientMessageEventRequest(
  body: unknown
): ParsedClientMessageEventRequest | GatewayError {
  if (!isRecord(body)) {
    return invalid("Request body must be a JSON object.");
  }

  const schema = readRequiredString(body, "schema", 64);
  if (schema instanceof GatewayError) {
    return schema;
  }
  if (schema !== "client_message.v1") {
    return invalid("schema must be client_message.v1.");
  }

  const eventId = readRequiredString(body, "event_id", 128);
  if (eventId instanceof GatewayError) {
    return eventId;
  }
  const sessionId = readRequiredString(body, "session_id", 128);
  if (sessionId instanceof GatewayError) {
    return sessionId;
  }
  const messageId = readRequiredString(body, "message_id", 128);
  if (messageId instanceof GatewayError) {
    return messageId;
  }
  const createdAt = readIsoDateTime(body, "created_at");
  if (createdAt instanceof GatewayError) {
    return createdAt;
  }

  const app = readApp(body.app);
  if (app instanceof GatewayError) {
    return app;
  }
  const agent = readOptionalString(body, "agent", 128);
  if (agent instanceof GatewayError) {
    return agent;
  }
  const providerId = readOptionalString(body, "provider_id", 128);
  if (providerId instanceof GatewayError) {
    return providerId;
  }
  const modelId = readOptionalString(body, "model_id", 128);
  if (modelId instanceof GatewayError) {
    return modelId;
  }
  const engine = readOptionalString(body, "engine", 64);
  if (engine instanceof GatewayError) {
    return engine;
  }
  if (engine !== null && engine !== "agent" && engine !== "medevidence-direct") {
    return invalid("engine must be agent or medevidence-direct.");
  }

  const text = readRequiredString(body, "text", Number.MAX_SAFE_INTEGER);
  if (text instanceof GatewayError) {
    return text;
  }
  if (Buffer.byteLength(text, "utf8") > CLIENT_MESSAGE_TEXT_LIMIT_BYTES) {
    return invalid("text exceeds 64KB UTF-8 byte length.", 413);
  }

  const attachments = readAttachments(body.attachments);
  if (attachments instanceof GatewayError) {
    return attachments;
  }

  return {
    eventId,
    sessionId,
    messageId,
    createdAt,
    appName: app.name,
    appVersion: app.version,
    agent,
    providerId,
    modelId,
    engine,
    text,
    textSha256: clientMessageTextSha256(text),
    attachmentsJson: JSON.stringify(attachments)
  };
}

export function clientMessageTextSha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function parseClientDiagnosticEventRequest(
  body: unknown
): ParsedClientDiagnosticEventRequest | GatewayError {
  if (!isRecord(body)) {
    return invalid("Request body must be a JSON object.");
  }

  const schema = readRequiredString(body, "schema", 64);
  if (schema instanceof GatewayError) {
    return schema;
  }
  if (schema !== "client_diagnostic.v1") {
    return invalid("schema must be client_diagnostic.v1.");
  }

  const eventId = readRequiredString(body, "event_id", 128);
  if (eventId instanceof GatewayError) {
    return eventId;
  }
  const createdAt = readIsoDateTime(body, "created_at");
  if (createdAt instanceof GatewayError) {
    return createdAt;
  }
  const app = readApp(body.app);
  if (app instanceof GatewayError) {
    return app;
  }

  const sessionId = readOptionalString(body, "session_id", 128);
  if (sessionId instanceof GatewayError) {
    return sessionId;
  }
  const messageId = readOptionalString(body, "message_id", 128);
  if (messageId instanceof GatewayError) {
    return messageId;
  }
  const topLevelToolCallId = readOptionalDiagnosticString(body, "tool_call_id", 128);
  if (topLevelToolCallId instanceof GatewayError) {
    return topLevelToolCallId;
  }
  const topLevelProviderId = readOptionalDiagnosticString(body, "provider_id", 128);
  if (topLevelProviderId instanceof GatewayError) {
    return topLevelProviderId;
  }
  const topLevelModelId = readOptionalDiagnosticString(body, "model_id", 128);
  if (topLevelModelId instanceof GatewayError) {
    return topLevelModelId;
  }
  const category = readRequiredString(body, "category", 64);
  if (category instanceof GatewayError) {
    return category;
  }
  if (!diagnosticCategories.has(category)) {
    return invalid("category must be a supported client_diagnostic.v1 category.");
  }
  const action = readRequiredDiagnosticString(body, "action", 128);
  if (action instanceof GatewayError) {
    return action;
  }
  const status = readRequiredString(body, "status", 32);
  if (status instanceof GatewayError) {
    return status;
  }
  if (!diagnosticStatuses.has(status)) {
    return invalid("status must be a supported client_diagnostic.v1 status.");
  }

  const method = readOptionalString(body, "method", 16);
  if (method instanceof GatewayError) {
    return method;
  }
  const path = readOptionalDiagnosticPath(body, "path", 512);
  if (path instanceof GatewayError) {
    return path;
  }
  const monoMs = readOptionalDiagnosticNumber(body.mono_ms, "mono_ms", Number.MAX_SAFE_INTEGER);
  if (monoMs instanceof GatewayError) {
    return monoMs;
  }
  const durationMs = readOptionalInteger(body.duration_ms, "duration_ms", 86_400_000);
  if (durationMs instanceof GatewayError) {
    return durationMs;
  }
  const httpStatus = readOptionalInteger(body.http_status, "http_status", 599, 100);
  if (httpStatus instanceof GatewayError) {
    return httpStatus;
  }
  const errorCode = readOptionalString(body, "error_code", 128);
  if (errorCode instanceof GatewayError) {
    return errorCode;
  }
  const errorMessage = readOptionalDiagnosticString(body, "error_message", 2048);
  if (errorMessage instanceof GatewayError) {
    return errorMessage;
  }
  const metadata = readMetadata(body.metadata);
  if (metadata instanceof GatewayError) {
    return metadata;
  }
  const toolCallId = topLevelToolCallId ?? readMetadataString(metadata.value, "tool_call_id", 128);
  const providerId = topLevelProviderId ?? readMetadataString(metadata.value, "provider_id", 128);
  const modelId = topLevelModelId ?? readMetadataString(metadata.value, "model_id", 128);

  return {
    eventId,
    sessionId,
    messageId,
    toolCallId,
    providerId,
    modelId,
    createdAt,
    appName: app.name,
    appVersion: app.version,
    category,
    action,
    status: status as ParsedClientDiagnosticEventRequest["status"],
    method,
    path,
    monoMs,
    durationMs,
    httpStatus,
    errorCode,
    errorMessage,
    metadataJson: metadata.json
  };
}

function readApp(value: unknown): { name: string; version: string | null } | GatewayError {
  if (!isRecord(value)) {
    return invalid("app must be a JSON object.");
  }
  const name = readRequiredString(value, "name", 64);
  if (name instanceof GatewayError) {
    return name;
  }
  if (name !== "medevidence-desktop") {
    return invalid("app.name must be medevidence-desktop.");
  }
  const version = readOptionalString(value, "version", 64);
  if (version instanceof GatewayError) {
    return version;
  }
  return { name, version };
}

function readAttachments(value: unknown): NormalizedAttachment[] | GatewayError {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    return invalid("attachments must be an array.");
  }
  if (value.length > 20) {
    return invalid("attachments must contain at most 20 items.");
  }

  const normalized: NormalizedAttachment[] = [];
  for (const [index, item] of value.entries()) {
    if (!isRecord(item)) {
      return invalid(`attachments[${index}] must be a JSON object.`);
    }
    for (const key of Object.keys(item)) {
      if (forbiddenAttachmentKeys.has(key.toLowerCase())) {
        return invalid(`attachments[${index}].${key} is not allowed.`);
      }
    }

    const type = readRequiredString(item, "type", 64, `attachments[${index}].type`);
    if (type instanceof GatewayError) {
      return type;
    }
    const filename = readOptionalString(
      item,
      "filename",
      255,
      `attachments[${index}].filename`
    );
    if (filename instanceof GatewayError) {
      return filename;
    }
    if (filename !== null && hasPathSeparator(filename)) {
      return invalid(`attachments[${index}].filename must not contain a path separator.`);
    }
    const mime = readOptionalString(item, "mime", 128, `attachments[${index}].mime`);
    if (mime instanceof GatewayError) {
      return mime;
    }
    const size = readOptionalSize(item.size, `attachments[${index}].size`);
    if (size instanceof GatewayError) {
      return size;
    }

    normalized.push({
      type,
      filename,
      mime,
      size
    });
  }

  return normalized;
}

function readRequiredString(
  source: Record<string, unknown>,
  key: string,
  maxLength: number,
  label = key
): string | GatewayError {
  const value = source[key];
  if (typeof value !== "string" || value.length === 0) {
    return invalid(`${label} must be a non-empty string.`);
  }
  if (value.trim().length === 0) {
    return invalid(`${label} must not be blank.`);
  }
  if (value.length > maxLength) {
    return invalid(`${label} is too long.`);
  }
  return value;
}

function readOptionalString(
  source: Record<string, unknown>,
  key: string,
  maxLength: number,
  label = key
): string | null | GatewayError {
  const value = source[key];
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    return invalid(`${label} must be a string.`);
  }
  if (value.length === 0) {
    return null;
  }
  if (value.trim().length === 0) {
    return invalid(`${label} must not be blank.`);
  }
  if (value.length > maxLength) {
    return invalid(`${label} is too long.`);
  }
  return value;
}

function readRequiredDiagnosticString(
  source: Record<string, unknown>,
  key: string,
  maxLength: number,
  label = key
): string | GatewayError {
  const value = readRequiredString(source, key, maxLength, label);
  if (value instanceof GatewayError) {
    return value;
  }
  return validateDiagnosticString(value, label);
}

function readOptionalDiagnosticString(
  source: Record<string, unknown>,
  key: string,
  maxLength: number,
  label = key
): string | null | GatewayError {
  const value = readOptionalString(source, key, maxLength, label);
  if (value instanceof GatewayError || value === null) {
    return value;
  }
  return validateDiagnosticString(value, label);
}

function readOptionalDiagnosticPath(
  source: Record<string, unknown>,
  key: string,
  maxLength: number,
  label = key
): string | null | GatewayError {
  const value = readOptionalString(source, key, maxLength, label);
  if (value instanceof GatewayError || value === null) {
    return value;
  }
  if (!value.startsWith("/")) {
    return invalid(`${label} must be a path beginning with /.`);
  }
  if (value.includes("?") || value.includes("#")) {
    return invalid(`${label} must not include a query string or fragment.`);
  }
  return validateDiagnosticString(value, label);
}

function validateDiagnosticString(value: string, label: string): string | GatewayError {
  if (containsSensitiveDiagnosticText(value)) {
    return invalid(`${label} must not contain credentials or secrets.`);
  }
  return value;
}

function readIsoDateTime(
  source: Record<string, unknown>,
  key: string
): Date | GatewayError {
  const value = readRequiredString(source, key, 64);
  if (value instanceof GatewayError) {
    return value;
  }
  if (!isoDateTimePattern.test(value)) {
    return invalid(`${key} must be a valid ISO datetime.`);
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return invalid(`${key} must be a valid ISO datetime.`);
  }
  return date;
}

function readOptionalSize(value: unknown, label: string): number | null | GatewayError {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return invalid(`${label} must be a non-negative integer or null.`);
  }
  return value;
}

function readOptionalInteger(
  value: unknown,
  label: string,
  max: number,
  min = 0
): number | null | GatewayError {
  if (value === undefined || value === null) {
    return null;
  }
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  ) {
    return invalid(`${label} must be an integer from ${min} to ${max}.`);
  }
  return value;
}

function readOptionalDiagnosticNumber(
  value: unknown,
  label: string,
  max: number,
  min = 0
): number | null | GatewayError {
  if (value === undefined || value === null) {
    return null;
  }
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < min ||
    value > max
  ) {
    return invalid(`${label} must be a finite number from ${min} to ${max}.`);
  }
  return value;
}

function readMetadata(
  value: unknown
): { json: string; value: Record<string, unknown> } | GatewayError {
  if (value === undefined || value === null) {
    return { json: "{}", value: {} };
  }
  if (!isRecord(value)) {
    return invalid("metadata must be a JSON object.");
  }
  const forbidden = findForbiddenMetadataKey(value);
  if (forbidden) {
    return invalid(`metadata.${forbidden} is not allowed.`);
  }
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json, "utf8") > CLIENT_DIAGNOSTIC_METADATA_LIMIT_BYTES) {
    return invalid("metadata exceeds 16KB UTF-8 byte length.", 413);
  }
  return { json, value };
}

function readMetadataString(
  metadata: Record<string, unknown>,
  key: string,
  maxLength: number
): string | null {
  const value = metadata[key];
  if (typeof value !== "string" || value.length === 0 || value.trim().length === 0) {
    return null;
  }
  if (value.length > maxLength) {
    return null;
  }
  return value;
}

function findForbiddenMetadataKey(value: unknown, prefix = ""): string | null {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const found = findForbiddenMetadataKey(item, `${prefix}[${index}]`);
      if (found) {
        return found;
      }
    }
    return null;
  }
  if (!isRecord(value)) {
    return null;
  }
  for (const [key, item] of Object.entries(value)) {
    const next = prefix ? `${prefix}.${key}` : key;
    if (isForbiddenDiagnosticKey(key)) {
      return next;
    }
    if (typeof item === "string" && containsSensitiveDiagnosticText(item)) {
      return next;
    }
    const found = findForbiddenMetadataKey(item, next);
    if (found) {
      return found;
    }
  }
  return null;
}

function isForbiddenDiagnosticKey(key: string): boolean {
  const normalized = key.toLowerCase();
  const compact = normalized.replace(/[^a-z0-9]/g, "");
  return forbiddenDiagnosticKeys.has(normalized) || forbiddenDiagnosticKeys.has(compact);
}

function containsSensitiveDiagnosticText(value: string): boolean {
  return (
    /\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/i.test(value) ||
    /\b(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|password|secret)\b\s*[:=]\s*["']?[^"'\s&]{4,}/i.test(value)
  );
}

function hasPathSeparator(value: string): boolean {
  return value.includes("/") || value.includes("\\") || value === "." || value === "..";
}

function invalid(message: string, httpStatus = 400): GatewayError {
  return new GatewayError({
    code: "invalid_request",
    message,
    httpStatus
  });
}
