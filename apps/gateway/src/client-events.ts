import { createHash } from "node:crypto";
import { GatewayError, isRecord } from "@codex-gateway/core";

export const CLIENT_MESSAGE_TEXT_LIMIT_BYTES = 64 * 1024;
export const CLIENT_MESSAGE_BODY_LIMIT_BYTES = 512 * 1024;

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

interface NormalizedAttachment {
  type: string;
  filename: string | null;
  mime: string | null;
  size: number | null;
}

const forbiddenAttachmentKeys = new Set(["content", "data", "base64", "text", "path"]);
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
