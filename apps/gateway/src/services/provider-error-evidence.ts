import type { ProviderErrorEvidence } from "@codex-gateway/core";

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function httpStatus(...values: unknown[]): number | undefined {
  for (const value of values) {
    const number = typeof value === "number" ? value
      : typeof value === "string" && /^\d{3}$/.test(value.trim()) ? Number(value) : NaN;
    if (Number.isInteger(number) && number >= 400 && number <= 599) return number;
  }
  return undefined;
}

/** Parse once; only fixed error facts are durable. ID candidates still require credential-aware validation. */
export function parseProviderError(chunk: unknown, httpResponseStatus?: number): {
  evidence: ProviderErrorEvidence;
  requestIds: unknown[];
} {
  const envelope = record(chunk);
  const error = record(envelope?.error) ?? envelope;
  const message = typeof error?.message === "string" ? error.message
    : typeof envelope?.error === "string" ? envelope.error : typeof chunk === "string" ? chunk : "";
  // A URL/path/query containing 'timeout' or '404' is not error evidence.
  const text = message.replace(/https?:\/\/[^\s<>"']+/gi, "[url]");
  const tags = [error?.code, error?.type].filter(value => typeof value === "string").join(" ");
  const download = /\b(?:error while downloading|download(?:ing)? (?:the )?image|fetch(?:ing)? (?:the )?image|image (?:download|fetch))\b/i.test(text);
  const downloadStatus = download ? httpStatus(text.match(/\bstatus(?:\s+code)?\s*[:=]\s*([45]\d{2})\b/i)?.[1]) : undefined;
  const timeout = /\b(?:timeout|timed out)\b/i.test(text) &&
    !/\b(?:parameter|schema|field|must)\b|\b(?:invalid|unsupported)\s+timeout\b/i.test(text);
  const rateLimit = /rate[_ -]?limit|too many requests/i.test(tags + " " + text);
  const invalidRequest = /invalid[_ -]?request|bad request/i.test(tags + " " + text);
  const typedTimeout = [error?.code, error?.type].some(value => typeof value === "string" &&
    /^(?:timeout|timeout_error|request_timeout|gateway_timeout)$/i.test(value));
  // Only an unambiguous image-download timeout outranks a generic invalid-request tag.
  // Explicit numeric status always wins, including 400 on transient-looking messages.
  let category: ProviderErrorEvidence["category"] = "unknown";
  let inferred: number | undefined;
  if (downloadStatus !== undefined) {
    category = "image_download_http";
    inferred = [408, 429, 500, 502, 503, 504].includes(downloadStatus) ? downloadStatus : 400;
  } else if (download && timeout) {
    category = "image_download_timeout";
    inferred = 504;
  } else if (rateLimit) {
    category = "rate_limit";
    inferred = 429;
  } else if (invalidRequest) {
    category = "invalid_request";
    inferred = 400;
  } else if (timeout || typedTimeout) {
    category = "timeout";
    inferred = 504;
  } else if (download) {
    category = "image_download_error";
  }
  const explicit = httpStatus(error?.status, error?.status_code, error?.http_status,
    error?.code, envelope?.status, envelope?.status_code);
  const evidence: ProviderErrorEvidence = {
    source: httpResponseStatus === undefined ? "stream_error_frame" : "http_response",
    statusSource: httpResponseStatus !== undefined ? "http" : explicit !== undefined ? "explicit"
      : inferred !== undefined ? "inferred" : "fallback",
    status: httpResponseStatus ?? explicit ?? inferred ?? 502,
    category,
    ...(downloadStatus !== undefined ? { downloadStatus } : {})
  };
  const embedded = text.match(/\brequest[ _-]?id\s*[:=]\s*([^\s,;]+)/i)?.[1];
  return { evidence, requestIds: [envelope?.request_id, envelope?.requestId, error?.request_id, error?.requestId, embedded] };
}
