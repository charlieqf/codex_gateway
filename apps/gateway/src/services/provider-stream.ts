import { createHash } from "node:crypto";
import {
  GatewayError,
  type GatewaySession,
  type ProviderAdapter,
  type ProviderErrorDiagnostic,
  type ProviderResponseSummary,
  type ProviderStreamTermination,
  type Scope,
  type StreamEvent,
  type Subject,
  type ClientToolChoice,
  type ClientToolDefinition,
  type TokenUsage,
  type UpstreamAccount,
  type UpstreamAttemptSummary
} from "@codex-gateway/core";

const CONTEXT_LENGTH_EXCEEDED_MESSAGE =
  "Current conversation or attached files are too large. Start a new conversation, split large PDFs/files, or clear earlier history before retrying.";

export interface ProviderToolCall {
  id: string;
  name: string;
  arguments?: unknown;
  argumentsJson?: string;
}

export interface CollectedProviderMessage {
  content: string;
  toolCalls: ProviderToolCall[];
  usage?: TokenUsage;
  providerSessionRef?: string;
  providerSummary: ProviderStreamSummary;
}

export interface ProviderStreamSummary {
  completed: boolean;
  finishReason: string | null;
  upstreamRequestId: string | null;
  upstreamHttpStatus: number | null;
  errorCode: string | null;
  contentChars: number;
  semanticOutputChars: number;
  toolCallCount: number;
  toolNames: string[];
  rawResponseHash: string | null;
  rawResponseChars: number | null;
  emptyStop: boolean | null;
  terminationKind: ProviderStreamTermination | null;
  attempts: UpstreamAttemptSummary[];
}

export interface ProviderStreamAttemptContext {
  kind?: string | null;
  toolChoice?: string | null;
  provider?: UpstreamAttemptSummary["provider"];
  upstreamRuntime?: string | null;
  upstreamModel?: string | null;
  upstreamAccountId?: string | null;
}

export class ProviderStreamSummaryCollector {
  private readonly normalizedHash = createHash("sha256");
  private normalizedChars = 0;
  private completed = false;
  private contentChars = 0;
  private semanticOutputChars = 0;
  private toolCallCount = 0;
  private readonly toolNames = new Set<string>();
  private finishReason: string | null = null;
  private upstreamRequestId: string | null = null;
  private upstreamHttpStatus: number | null = null;
  private upstreamRawHash: string | null = null;
  private upstreamRawChars: number | null = null;
  private terminationKind: ProviderStreamTermination | null = null;
  private errorCode: string | null = null;
  private normalizedDigest: string | null = null;

  record(event: StreamEvent): void {
    if (event.type === "message_delta") {
      this.contentChars += event.text.length;
      this.semanticOutputChars += event.text.length;
      this.recordNormalized({ type: event.type, text: event.text });
      return;
    }
    if (event.type === "tool_call") {
      this.toolCallCount += 1;
      this.toolNames.add(event.name);
      this.recordNormalized({
        type: event.type,
        name: event.name,
        arguments_chars: event.argumentsJson?.length ?? safeJson(event.arguments ?? {}).length
      });
      return;
    }
    if (event.type === "completed") {
      this.completed = true;
      this.applyProviderSummary(event.responseSummary);
      this.recordNormalized({
        type: event.type,
        finish_reason: event.responseSummary?.finishReason ?? null,
        termination_kind: event.responseSummary?.terminationKind ?? null
      });
      return;
    }
    if (event.type === "error") {
      this.applyProviderSummary(event.responseSummary);
      this.errorCode = event.code;
      this.recordNormalized({
        type: event.type,
        code: event.code,
        termination_kind: event.responseSummary?.terminationKind ?? null
      });
    }
  }

  snapshot(attempt?: ProviderStreamAttemptContext): ProviderStreamSummary {
    const finishReason = this.finishReason;
    const summary: ProviderStreamSummary = {
      completed: this.completed,
      finishReason,
      upstreamRequestId: this.upstreamRequestId,
      upstreamHttpStatus: this.upstreamHttpStatus,
      errorCode: this.errorCode,
      contentChars: this.contentChars,
      semanticOutputChars: this.semanticOutputChars,
      toolCallCount: this.toolCallCount,
      toolNames: [...this.toolNames].sort(),
      rawResponseHash: this.upstreamRawHash ?? this.normalizedRawHash(),
      rawResponseChars: this.upstreamRawChars ?? this.normalizedChars,
      terminationKind: this.terminationKind,
      emptyStop:
        finishReason === null || this.errorCode !== null
          ? null
          : finishReason === "stop" && this.contentChars === 0 && this.toolCallCount === 0,
      attempts: []
    };
    return withProviderStreamAttempt(summary, attempt);
  }

  private recordNormalized(value: Record<string, unknown>): void {
    if (this.normalizedDigest !== null) {
      return;
    }
    const line = `${safeJson(value)}\n`;
    this.normalizedChars += line.length;
    this.normalizedHash.update(line, "utf8");
  }

  private normalizedRawHash(): string {
    if (this.normalizedDigest === null) {
      this.normalizedDigest = this.normalizedHash.digest("hex");
    }
    return this.normalizedDigest;
  }

  private applyProviderSummary(summary: ProviderResponseSummary | undefined): void {
    if (!summary) {
      return;
    }
    if (summary.finishReason !== undefined) {
      this.finishReason = summary.finishReason;
    }
    if (summary.upstreamRequestId !== undefined) {
      this.upstreamRequestId = summary.upstreamRequestId;
    }
    if (summary.upstreamHttpStatus !== undefined) {
      this.upstreamHttpStatus = summary.upstreamHttpStatus;
    }
    if (
      summary.semanticOutputChars !== undefined &&
      summary.semanticOutputChars !== null
    ) {
      this.semanticOutputChars = summary.semanticOutputChars;
    }
    if (summary.rawResponseHash !== undefined) {
      this.upstreamRawHash = summary.rawResponseHash;
    }
    if (summary.rawResponseChars !== undefined) {
      this.upstreamRawChars = summary.rawResponseChars;
    }
    if (summary.terminationKind !== undefined) {
      this.terminationKind = summary.terminationKind;
    }
  }
}

export interface CollectProviderMessageInput {
  provider: ProviderAdapter;
  upstreamAccount: UpstreamAccount;
  subject: Subject;
  scope: Scope;
  session: GatewaySession;
  message: string;
  reasoningEffort?: string | null;
  maximumOutputTokens?: number;
  clientTools?: ClientToolDefinition[];
  clientToolChoice?: ClientToolChoice;
  signal?: AbortSignal;
  onProviderError?: (diagnostic: ProviderErrorDiagnostic) => void;
  onProviderEvent?: (event: StreamEvent) => void;
  suppressToolCalls?: boolean;
  suppressTextAfterToolCall?: boolean;
  deferEmptyCompletionError?: boolean;
  attemptKind?: string | null;
  attemptToolChoice?: string | null;
  upstreamRuntime?: string | null;
  upstreamModel?: string | null;
}

export async function collectProviderMessage(
  input: CollectProviderMessageInput
): Promise<CollectedProviderMessage | GatewayError> {
  const collector = new ProviderStreamSummaryCollector();
  const result: CollectedProviderMessage = {
    content: "",
    toolCalls: [],
    providerSummary: emptyProviderStreamSummary()
  };
  let hasToolCalls = false;

  for await (const event of input.provider.message({
    upstreamAccount: input.upstreamAccount,
    subject: input.subject,
    scope: input.scope,
    session: input.session,
    message: input.message,
    reasoningEffort: input.reasoningEffort,
    maximumOutputTokens: input.maximumOutputTokens,
    clientTools: input.clientTools,
    clientToolChoice: input.clientToolChoice,
    signal: input.signal,
    onProviderError: input.onProviderError
  })) {
    input.onProviderEvent?.(event);
    collector.record(event);
    if (event.type === "message_delta") {
      if (input.suppressTextAfterToolCall && hasToolCalls) {
        continue;
      }
      result.content += event.text;
      continue;
    }

    if (event.type === "tool_call") {
      if (input.suppressToolCalls) {
        continue;
      }
      hasToolCalls = true;
      result.toolCalls.push({
        id: event.callId,
        name: event.name,
        arguments: event.arguments,
        argumentsJson: event.argumentsJson
      });
      continue;
    }

    if (event.type === "completed") {
      result.usage = event.usage;
      result.providerSessionRef = event.providerSessionRef;
      continue;
    }

    if (event.type === "error") {
      return attachProviderStreamSummary(
        streamErrorToGatewayError(event),
        collector.snapshot(providerAttemptContext(input))
      );
    }
  }

  result.providerSummary = collector.snapshot(providerAttemptContext(input));
  const completionError = providerCompletionError(result.providerSummary);
  if (
    completionError &&
    !(input.deferEmptyCompletionError && completionError.code === "upstream_empty_response")
  ) {
    return completionError;
  }
  return result;
}

export function streamErrorToGatewayError(event: { code: string; message: string }): GatewayError {
  if (event.code === "client_aborted") {
    return new GatewayError({
      code: "client_aborted",
      message: event.message,
      httpStatus: 499
    });
  }
  if (event.code === "rate_limited") {
    return new GatewayError({
      code: "rate_limited",
      message: event.message,
      httpStatus: 429,
      retryAfterSeconds: 60
    });
  }
  if (event.code === "provider_reauth_required") {
    return new GatewayError({
      code: "provider_reauth_required",
      message: event.message,
      httpStatus: 503
    });
  }
  if (event.code === "subscription_unavailable") {
    return new GatewayError({
      code: "subscription_unavailable",
      message: event.message,
      httpStatus: 503
    });
  }
  if (event.code === "context_length_exceeded" || event.code === "context_too_large") {
    return new GatewayError({
      code: "context_length_exceeded",
      message: CONTEXT_LENGTH_EXCEEDED_MESSAGE,
      httpStatus: 413
    });
  }
  if (event.code === "invalid_request") {
    return new GatewayError({
      code: "invalid_request",
      message: event.message,
      httpStatus: 400
    });
  }
  if (event.code === "upstream_timeout") {
    return new GatewayError({
      code: "upstream_timeout",
      message: event.message,
      httpStatus: 504
    });
  }
  if (event.code === "upstream_unavailable") {
    return new GatewayError({
      code: "upstream_unavailable",
      message: event.message,
      httpStatus: 503
    });
  }
  if (event.code === "upstream_incomplete_stream") {
    return new GatewayError({
      code: "upstream_incomplete_stream",
      message: event.message,
      httpStatus: 502
    });
  }
  if (event.code === "upstream_empty_response") {
    return new GatewayError({
      code: "upstream_empty_response",
      message: event.message,
      httpStatus: 502
    });
  }
  if (event.code === "content_policy_violation") {
    return new GatewayError({
      code: "content_policy_violation",
      message: event.message,
      httpStatus: 400
    });
  }
  return new GatewayError({
    code: "service_unavailable",
    message: event.message,
    httpStatus: 503
  });
}

export function combineProviderStreamSummaries(
  summaries: ProviderStreamSummary[]
): ProviderStreamSummary | null {
  const present = summaries.filter(Boolean);
  if (present.length === 0) {
    return null;
  }
  const hash = createHash("sha256");
  let rawChars = 0;
  let hasRawChars = false;
  for (const summary of present) {
    hash.update(summary.rawResponseHash ?? "", "utf8");
    hash.update("\n", "utf8");
    if (summary.rawResponseChars !== null) {
      hasRawChars = true;
      rawChars += summary.rawResponseChars;
    }
  }
  const contentChars = present.reduce((total, summary) => total + summary.contentChars, 0);
  const semanticOutputChars = present.reduce(
    (total, summary) => total + summary.semanticOutputChars,
    0
  );
  const toolCallCount = present.reduce((total, summary) => total + summary.toolCallCount, 0);
  const toolNames = [...new Set(present.flatMap((summary) => summary.toolNames))].sort();
  const finishReason = present[present.length - 1]?.finishReason ?? null;
  const attempts = present.flatMap((summary) =>
    summary.attempts.length > 0 ? summary.attempts : [providerSummaryToAttempt(summary)]
  );
  return {
    completed: present[present.length - 1]?.completed ?? false,
    finishReason,
    upstreamRequestId: present.findLast((summary) => summary.upstreamRequestId)?.upstreamRequestId ?? null,
    upstreamHttpStatus:
      present.findLast((summary) => summary.upstreamHttpStatus !== null)?.upstreamHttpStatus ?? null,
    errorCode: present.findLast((summary) => summary.errorCode !== null)?.errorCode ?? null,
    contentChars,
    semanticOutputChars,
    toolCallCount,
    toolNames,
    rawResponseHash: hash.digest("hex"),
    rawResponseChars: hasRawChars ? rawChars : null,
    terminationKind: present[present.length - 1]?.terminationKind ?? null,
    emptyStop:
      finishReason === null ? null : finishReason === "stop" && contentChars === 0 && toolCallCount === 0,
    attempts: attempts.map((attempt, index) => ({ ...attempt, index: index + 1 }))
  };
}

export function withProviderStreamAttempt(
  summary: ProviderStreamSummary,
  attempt: ProviderStreamAttemptContext | undefined
): ProviderStreamSummary {
  return {
    ...summary,
    attempts: [providerSummaryToAttempt(summary, attempt)]
  };
}

export function attachProviderStreamSummary(
  error: GatewayError,
  summary: ProviderStreamSummary
): GatewayError {
  Object.defineProperty(error, "providerSummary", {
    value: summary,
    configurable: true
  });
  return error;
}

export function providerTruncatedWithoutOutputError(
  summary: ProviderStreamSummary
): GatewayError | null {
  if (
    summary.finishReason !== "length" ||
    summary.semanticOutputChars > 0 ||
    summary.toolCallCount > 0
  ) {
    return null;
  }

  const error = new GatewayError({
    code: "context_length_exceeded",
    message:
      "The model reached its output limit before producing visible content. Start a new conversation, reduce earlier context, or switch to Max before retrying.",
    httpStatus: 413
  });

  return attachProviderStreamSummary(error, {
    ...summary,
    errorCode: error.code,
    attempts: summary.attempts.map((attempt) => ({
      ...attempt,
      errorCode: attempt.errorCode ?? error.code
    }))
  });
}

export function providerCompletionError(summary: ProviderStreamSummary): GatewayError | null {
  if (summary.finishReason === "content_filter") {
    return providerProtocolError(
      summary,
      new GatewayError({
        code: "content_policy_violation",
        message: "MedCode upstream filtered the response for content policy reasons.",
        httpStatus: 400
      })
    );
  }
  if (!summary.completed) {
    return providerProtocolError(
      {
        ...summary,
        terminationKind: summary.terminationKind ?? "eof_before_terminal"
      },
      new GatewayError({
        code: "upstream_incomplete_stream",
        message: "MedCode upstream response ended before completion.",
        httpStatus: 502
      })
    );
  }
  const truncatedWithoutOutputError = providerTruncatedWithoutOutputError(summary);
  if (truncatedWithoutOutputError) {
    return truncatedWithoutOutputError;
  }
  if (
    summary.semanticOutputChars > 0 ||
    summary.toolCallCount > 0
  ) {
    return null;
  }

  return providerProtocolError(
    summary,
    new GatewayError({
      code: "upstream_empty_response",
      message: "MedCode upstream completed without a usable response.",
      httpStatus: 502
    })
  );
}

export function providerStreamSummaryFromError(error: GatewayError): ProviderStreamSummary | null {
  const summary = (error as GatewayError & { providerSummary?: unknown }).providerSummary;
  return isProviderStreamSummary(summary) ? summary : null;
}

function providerAttemptContext(input: CollectProviderMessageInput): ProviderStreamAttemptContext {
  return {
    kind: input.attemptKind ?? "primary",
    toolChoice: input.attemptToolChoice ?? serializeClientToolChoice(input.clientToolChoice),
    provider: input.upstreamAccount.provider,
    upstreamRuntime: input.upstreamRuntime ?? null,
    upstreamModel: input.upstreamModel ?? null,
    upstreamAccountId: input.upstreamAccount.id
  };
}

function providerSummaryToAttempt(
  summary: ProviderStreamSummary,
  attempt: ProviderStreamAttemptContext | undefined = undefined
): UpstreamAttemptSummary {
  return {
    index: 1,
    kind: attempt?.kind ?? null,
    toolChoice: attempt?.toolChoice ?? null,
    provider: attempt?.provider ?? null,
    upstreamRuntime: attempt?.upstreamRuntime ?? null,
    upstreamModel: attempt?.upstreamModel ?? null,
    upstreamAccountId: attempt?.upstreamAccountId ?? null,
    finishReason: summary.finishReason,
    upstreamRequestId: summary.upstreamRequestId,
    upstreamHttpStatus: summary.upstreamHttpStatus,
    errorCode: summary.errorCode,
    contentChars: summary.contentChars,
    toolCallCount: summary.toolCallCount,
    toolNames: [...summary.toolNames],
    rawResponseHash: summary.rawResponseHash,
    rawResponseChars: summary.rawResponseChars,
    emptyStop: summary.emptyStop,
    terminationKind: summary.terminationKind
  };
}

function serializeClientToolChoice(toolChoice: ClientToolChoice | undefined): string | null {
  if (!toolChoice) {
    return null;
  }
  if (typeof toolChoice === "string") {
    return toolChoice;
  }
  return `function:${toolChoice.function.name}`;
}

function isProviderStreamSummary(value: unknown): value is ProviderStreamSummary {
  if (!value || typeof value !== "object") {
    return false;
  }
  const summary = value as Partial<ProviderStreamSummary>;
  return (
    typeof summary.completed === "boolean" &&
    typeof summary.contentChars === "number" &&
    typeof summary.semanticOutputChars === "number" &&
    typeof summary.toolCallCount === "number" &&
    Array.isArray(summary.toolNames) &&
    Array.isArray(summary.attempts)
  );
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function emptyProviderStreamSummary(): ProviderStreamSummary {
  return {
    completed: false,
    finishReason: null,
    upstreamRequestId: null,
    upstreamHttpStatus: null,
    errorCode: null,
    contentChars: 0,
    semanticOutputChars: 0,
    toolCallCount: 0,
    toolNames: [],
    rawResponseHash: null,
    rawResponseChars: null,
    emptyStop: null,
    terminationKind: null,
    attempts: []
  };
}

function providerProtocolError(
  summary: ProviderStreamSummary,
  error: GatewayError
): GatewayError {
  return attachProviderStreamSummary(error, {
    ...summary,
    errorCode: error.code,
    attempts: summary.attempts.map((attempt) => ({
      ...attempt,
      errorCode: attempt.errorCode ?? error.code,
      ...(summary.terminationKind === "eof_before_terminal" &&
      (attempt.terminationKind === null ||
        attempt.terminationKind === undefined)
        ? { terminationKind: "eof_before_terminal" as const }
        : {})
    }))
  });
}
