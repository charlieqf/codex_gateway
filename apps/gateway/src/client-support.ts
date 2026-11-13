import { createHash } from "node:crypto";
import { Ajv } from "ajv";

export const supportAutomaticBytes = 16 * 1024;
export const supportManualBytes = 1024 * 1024;
export const supportUuidPattern = "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";
const string = (pattern: string, maxLength = 100) => ({ type: "string", pattern, maxLength });
const enumeration = (...values: string[]) => ({ type: "string", enum: values });
const integer = (maximum: number, minimum = 0) => ({ type: "integer", minimum, maximum });
const object = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object", properties, required, additionalProperties: false
});
const uuid = string(supportUuidPattern, 36);
const timestamp = string("^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,3})?Z$", 24);
const processSchema = enumeration("main", "renderer", "sidecar");
const operation = enumeration("login", "bootstrap", "credential_install", "model_call", "model_recovery", "startup", "sidecar", "user_report");
const ids = {
  account_subject_id: string("^subj_[A-Za-z0-9_-]{1,80}$"),
  request_id: string("^req[-_][A-Za-z0-9_-]{1,80}$"),
  model_call_id: string("^\\d{13}_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"),
  session_id: string("^ses_[A-Za-z0-9_-]{1,80}$"),
  message_id: string("^msg_[A-Za-z0-9_-]{1,80}$")
};
const transport = { ...object({
  phase: enumeration("before_socket", "sending", "waiting_headers", "response_body", "unknown"),
  duration_ms: integer(86_400_000), body_sent_ms: integer(86_400_000), headers_ms: integer(86_400_000),
  request_body_bytes: integer(1_073_741_824), body_bytes_sent: integer(1_073_741_824),
  http_status: integer(599, 100),
  error_codes: { type: "array", maxItems: 8, items: enumeration(
    "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "ECONNREFUSED", "ECONNRESET", "EPIPE", "ENETUNREACH", "EHOSTUNREACH",
    "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET", "UND_ERR_ABORTED", "ABORT_ERR",
    "ERR_TLS_CERT_ALTNAME_INVALID", "CERT_HAS_EXPIRED", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "DEPTH_ZERO_SELF_SIGNED_CERT",
    "SELF_SIGNED_CERT_IN_CHAIN", "AbortError", "TimeoutError", "unknown"
  ) }
}), minProperties: 1 };
const diagnostic = object({
  ...ids, occurred_at: timestamp, process: processSchema, operation_id: uuid,
  event: enumeration("start", "complete", "error"), operation, method: enumeration("GET", "POST"), transport,
  path: enumeration("/v1/chat/completions", "/v1/responses", "/gateway/model-calls/:id",
    "/gateway/auth/v1/login/start", "/gateway/auth/v1/session/bootstrap", "/gateway/auth/v1/token/refresh",
    "/gateway/auth/v1/logout", "/gateway/account/v1/current", "/gateway/unified-keys/resolve", "/gateway/credentials/current")
}, ["occurred_at", "process", "operation_id", "event"]);

export interface SupportDiagnostic {
  occurred_at: string;
  process: string;
  operation_id: string;
  event: string;
  account_subject_id?: string;
  operation?: string;
  method?: string;
  path?: string;
  request_id?: string;
  model_call_id?: string;
  session_id?: string;
  message_id?: string;
  transport?: Record<string, unknown>;
}
export interface SupportReport {
  schema_version: 1;
  report_id: string;
  failure_id: string;
  kind: "automatic" | "manual";
  occurred_at: string;
  app_name: string;
  app_version: string;
  platform: string;
  process: string;
  operation: string;
  error_code: string;
  final_state: string;
  account_subject_id?: string;
  operation_id?: string;
  request_id?: string;
  model_call_id?: string;
  session_id?: string;
  message_id?: string;
  turn_code?: string;
  network_type?: string;
  truncated?: boolean;
  transport?: Record<string, unknown>;
  diagnostics?: SupportDiagnostic[];
}
const validate = new Ajv({ strict: true, allErrors: false }).compile<SupportReport>(object({
  ...ids, schema_version: { const: 1 }, report_id: uuid, failure_id: uuid, kind: enumeration("automatic", "manual"),
  occurred_at: timestamp, app_name: enumeration("medevidence", "goldencode"),
  app_version: string("^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(?:-[A-Za-z0-9.-]+)?(?:\\+[A-Za-z0-9.-]+)?$", 40),
  platform: enumeration("win32", "darwin", "linux"), process: processSchema, operation,
  error_code: string("^[a-z][a-z0-9_]{0,63}$", 64),
  final_state: enumeration("failed", "unconfirmed", "incomplete", "aborted", "unknown"),
  operation_id: uuid, turn_code: string("^T:[A-Z0-9]{8}$", 10),
  network_type: enumeration("wifi", "ethernet", "other", "unknown"), truncated: { type: "boolean" }, transport,
  diagnostics: { type: "array", maxItems: 256, items: diagnostic }
}, ["schema_version", "report_id", "failure_id", "kind", "occurred_at", "app_name", "app_version", "platform", "process", "operation", "error_code", "final_state"]));

export function parseSupportReport(value: unknown): SupportReport | null {
  if (!validate(value)) return null;
  if (value.kind === "automatic" && value.diagnostics !== undefined) return null;
  // No free text is accepted. Reject recognizable credentials/phones even in otherwise valid IDs/codes.
  if (/(?:cgu_live_|sk_live_|sk-|rft_|bearer_|eyJ[A-Za-z0-9_-]{16}|(?<!\d)1[3-9]\d{9}(?!\d))/i.test(JSON.stringify(value))) return null;
  const times = [value.occurred_at, ...(value.diagnostics ?? []).map(item => item.occurred_at)];
  if (times.some(time => {
    const normalized = time.replace(/(?:\.(\d{1,3}))?Z$/, (_, fraction: string | undefined) => `.${(fraction ?? "").padEnd(3, "0")}Z`);
    return !Number.isFinite(Date.parse(time)) || new Date(time).toISOString() !== normalized;
  })) return null;
  const occurredAt = Date.parse(value.occurred_at);
  const diagnosticTimes = (value.diagnostics ?? []).map(item => Date.parse(item.occurred_at));
  if (diagnosticTimes.some(time => Math.abs(time - occurredAt) > 600_000) ||
      (diagnosticTimes.length && Math.max(...diagnosticTimes) - Math.min(...diagnosticTimes) > 600_000)) return null;
  for (const item of value.diagnostics ?? []) {
    if (item.account_subject_id === value.account_subject_id) continue;
    if (item.account_subject_id || !["startup", "sidecar"].includes(item.operation ?? "") ||
        item.path || item.method || item.request_id || item.model_call_id || item.session_id || item.message_id) return null;
  }
  return value;
}

export function canonicalSupportJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalSupportJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalSupportJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
export function supportHash(json: string): string { return createHash("sha256").update(json).digest("hex"); }
