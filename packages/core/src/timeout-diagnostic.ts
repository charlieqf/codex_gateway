import type { ProviderFailureClassification } from "./provider-failure.js";

export interface TimeoutDiagnosticInput {
  errorCode: string | null;
  terminalSource?: string | null;
  failure?: ProviderFailureClassification | null;
  attempts?: unknown;
}

/** Admin-only evidence. Does not change public errors, retry eligibility or billing. */
export function diagnoseTimeout(input: TimeoutDiagnosticInput) {
  if (input.errorCode !== "upstream_timeout") return null;
  const attempts = Array.isArray(input.attempts) ? input.attempts : [];
  const last = record(attempts.at(-1));
  // Never explain a failed request with progress from an earlier successful attempt.
  const attempt = last?.errorCode === "upstream_timeout" ? last : null;
  const progress = record(attempt?.streamProgress);
  const failure = input.failure ?? record(attempt?.failure);
  const trigger = input.terminalSource === "gateway_deadline" ? "gateway_deadline"
    : input.terminalSource === "gateway_output_budget" ? "gateway_output_budget"
    : failure?.kind === "http_timeout" ? "provider_http_timeout"
    : failure?.kind === "headers_timeout" ? "headers_timeout"
    : failure?.kind === "body_timeout" ? "body_timeout"
    : failure?.kind === "connect" && ["ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT"].includes(String(failure.transportCode))
      ? "connect_timeout"
    : "unknown";
  const bytes = count(progress?.responseBytes);
  const reasoning = count(progress?.reasoningChars);
  const content = count(attempt?.contentChars);
  const argumentsBytes = count(progress?.toolArgumentBytes);
  const observedTools = count(progress?.observedToolCallCount);
  const completedTools = count(attempt?.toolCallCount);
  const phase = failure?.stage === "before_headers" ? "awaiting_headers"
    : bytes === 0 && (failure?.stage === "after_headers" || failure?.stage === "streaming") &&
      failure?.kind !== "http_timeout" ? "awaiting_body"
    : observedTools !== null && completedTools !== null && observedTools > completedTools && !attempt?.finishReason
      ? "tool_arguments_incomplete"
    : content !== null && content > 0 ? "content_incomplete"
    : reasoning !== null && reasoning > 0 && content === 0 && observedTools === 0 && argumentsBytes === 0
      ? "reasoning_only"
    : bytes !== null && bytes > 0 && reasoning === 0 && content === 0 && observedTools === 0 && argumentsBytes === 0
      ? "stream_without_semantic_output"
    : "unknown";
  const duration = count(attempt?.durationMs);
  const lastByte = count(progress?.lastResponseByteMs);
  const gap = duration !== null && lastByte !== null && lastByte <= duration ? duration - lastByte : null;
  return {
    version: 1 as const,
    trigger,
    phase,
    // A recent byte is not proof of uninterrupted progress; it could be a heartbeat.
    activity: gap === null ? "unknown" : gap <= 30_000 ? "recent_bytes" : "no_recent_bytes",
    first_upstream_byte_ms: count(progress?.firstResponseByteMs),
    last_upstream_byte_ms: lastByte,
    last_byte_gap_ms: gap,
    response_bytes: bytes,
    reasoning_chars: reasoning,
    content_chars: content,
    observed_tool_calls: observedTools,
    completed_tool_calls: completedTools,
    tool_argument_bytes: argumentsBytes,
    // Upstream content/firstByteMs (which may be an error frame) cannot prove delivery.
    client_delivery: "unknown" as const
  };
}

export type TimeoutDiagnostic = NonNullable<ReturnType<typeof diagnoseTimeout>>;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
