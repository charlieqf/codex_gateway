import { createHash } from "node:crypto";
import {
  classifyProviderFailure,
  GatewayError,
  resolveUpstreamAttemptPurpose,
  type GatewaySession,
  type MessageImageInput,
  type ProviderChatMessage,
  type ProviderAdapter,
  type ProviderErrorDiagnostic,
  type ProviderFailureClassification,
  type ProviderResponseSummary,
  type ProviderStreamTermination,
  type Scope,
  type StreamEvent,
  type Subject,
  type ClientToolChoice,
  type ClientToolDefinition,
  type TokenUsage,
  type ToolCallValidationFailureKind,
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
  failure: ProviderFailureClassification | null;
  contentChars: number;
  semanticOutputChars: number;
  /** Output the caller can observe; excludes reasoning. */
  visibleOutputChars: number;
  toolCallCount: number;
  toolNames: string[];
  rawResponseHash: string | null;
  rawResponseChars: number | null;
  emptyStop: boolean | null;
  terminationKind: ProviderStreamTermination | null;
  durationMs: number;
  usage: TokenUsage | null;
  maxToolArgumentBytes: number | null;
  totalToolArgumentBytes: number | null;
  maxToolArgumentCodeUnits: number | null;
  outputLimitHit: boolean;
  streamIncomplete: boolean;
  argumentBudgetCandidate: boolean;
  argumentBudgetExceeded: boolean;
  truncationConfidence: "confirmed" | "suspected" | "none";
  gatewayRecoveryAction: UpstreamAttemptSummary["gatewayRecoveryAction"];
  attempts: UpstreamAttemptSummary[];
}

export type OutputTruncationMode = "legacy" | "shadow" | "error" | "chunk";
export type ProviderOutputKind = "auto" | "text" | "tool_call";

export interface ProviderStreamSummaryCollectorOptions {
  softToolArgumentBytes?: number | null;
  hardToolArgumentBytes?: number | null;
  outputTruncationMode?: OutputTruncationMode;
  now?: () => number;
}

export interface ProviderCompletionErrorOptions {
  outputTruncationMode?: OutputTruncationMode;
  outputKind?: ProviderOutputKind;
}

export interface ProviderCompletionAssessment {
  finishReason: string | null;
  toolNames: string[];
  toolCallCount: number;
  maxToolArgumentBytes: number | null;
  totalToolArgumentBytes: number | null;
  maxToolArgumentCodeUnits: number | null;
  validationKind: "none" | ToolCallValidationFailureKind;
  outputLimitHit: boolean;
  streamIncomplete: boolean;
  argumentBudgetCandidate: boolean;
  argumentBudgetExceeded: boolean;
  truncationConfidence: "confirmed" | "suspected" | "none";
}

export interface ProviderStreamAttemptContext {
  kind?: string | null;
  purpose?: UpstreamAttemptSummary["purpose"];
  toolChoice?: string | null;
  provider?: UpstreamAttemptSummary["provider"];
  upstreamRuntime?: string | null;
  upstreamModel?: string | null;
  upstreamAccountId?: string | null;
}

export class ProviderStreamSummaryCollector {
  private readonly normalizedHash = createHash("sha256");
  private readonly now: () => number;
  private readonly startedAtMs: number;
  private readonly softToolArgumentBytes: number | null;
  private readonly hardToolArgumentBytes: number | null;
  private readonly outputTruncationMode: OutputTruncationMode;
  private normalizedChars = 0;
  private completed = false;
  private contentChars = 0;
  private semanticOutputChars = 0;
  private visibleOutputChars = 0;
  private toolCallCount = 0;
  private readonly toolNames = new Set<string>();
  private finishReason: string | null = null;
  private upstreamRequestId: string | null = null;
  private upstreamHttpStatus: number | null = null;
  private upstreamRawHash: string | null = null;
  private upstreamRawChars: number | null = null;
  private terminationKind: ProviderStreamTermination | null = null;
  private errorCode: string | null = null;
  private failure: ProviderFailureClassification | null = null;
  private normalizedDigest: string | null = null;
  private usage: TokenUsage | null = null;
  private maxToolArgumentBytes: number | null = null;
  private totalToolArgumentBytes: number | null = null;
  private maxToolArgumentCodeUnits: number | null = null;

  constructor(options: ProviderStreamSummaryCollectorOptions = {}) {
    this.now = options.now ?? Date.now;
    this.startedAtMs = this.now();
    this.softToolArgumentBytes = options.softToolArgumentBytes ?? null;
    this.hardToolArgumentBytes = options.hardToolArgumentBytes ?? null;
    this.outputTruncationMode = options.outputTruncationMode ?? "legacy";
  }

  record(event: StreamEvent): void {
    if (event.type === "message_delta") {
      this.contentChars += event.text.length;
      this.semanticOutputChars += event.text.length;
      this.visibleOutputChars += event.text.length;
      this.recordNormalized({ type: event.type, text: event.text });
      return;
    }
    if (event.type === "tool_call") {
      const serializedArguments =
        event.argumentsJson ?? safeJson(event.arguments ?? {});
      const argumentCodeUnits = serializedArguments.length;
      const argumentBytes = Buffer.byteLength(serializedArguments, "utf8");
      this.toolCallCount += 1;
      this.toolNames.add(event.name);
      this.maxToolArgumentBytes = Math.max(this.maxToolArgumentBytes ?? 0, argumentBytes);
      this.totalToolArgumentBytes = (this.totalToolArgumentBytes ?? 0) + argumentBytes;
      this.maxToolArgumentCodeUnits = Math.max(
        this.maxToolArgumentCodeUnits ?? 0,
        argumentCodeUnits
      );
      this.recordNormalized({
        type: event.type,
        name: event.name,
        arguments_code_units: argumentCodeUnits,
        arguments_bytes: argumentBytes
      });
      return;
    }
    if (event.type === "completed") {
      this.completed = true;
      this.usage = event.usage ? { ...event.usage } : null;
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
      this.failure = event.providerFailure ?? null;
      this.recordNormalized({
        type: event.type,
        code: event.code,
        termination_kind: event.responseSummary?.terminationKind ?? null
      });
    }
  }

  snapshot(attempt?: ProviderStreamAttemptContext): ProviderStreamSummary {
    const finishReason = this.finishReason;
    const outputLimitHit = finishReason === "length";
    const streamIncomplete =
      this.errorCode === "upstream_incomplete_stream" ||
      this.terminationKind === "eof_before_terminal" ||
      (!this.completed && this.errorCode === null);
    const argumentBudgetCandidate =
      this.softToolArgumentBytes !== null &&
      ((this.maxToolArgumentBytes ?? 0) >= this.softToolArgumentBytes ||
        (this.totalToolArgumentBytes ?? 0) >= this.softToolArgumentBytes);
    const argumentBudgetExceeded =
      this.hardToolArgumentBytes !== null &&
      ((this.maxToolArgumentBytes ?? 0) >= this.hardToolArgumentBytes ||
        (this.totalToolArgumentBytes ?? 0) >= this.hardToolArgumentBytes);
    const truncationConfidence =
      outputLimitHit || streamIncomplete
        ? "confirmed"
        : argumentBudgetExceeded
          ? "suspected"
          : "none";
    const summary: ProviderStreamSummary = {
      completed: this.completed,
      finishReason,
      upstreamRequestId: this.upstreamRequestId,
      upstreamHttpStatus: this.upstreamHttpStatus,
      errorCode: this.errorCode,
      failure: this.failure ? { ...this.failure } : null,
      contentChars: this.contentChars,
      semanticOutputChars: this.semanticOutputChars,
      visibleOutputChars: this.visibleOutputChars,
      toolCallCount: this.toolCallCount,
      toolNames: [...this.toolNames].sort(),
      rawResponseHash: this.upstreamRawHash ?? this.normalizedRawHash(),
      rawResponseChars: this.upstreamRawChars ?? this.normalizedChars,
      terminationKind: this.terminationKind,
      durationMs: Math.max(0, this.now() - this.startedAtMs),
      usage: this.usage ? { ...this.usage } : null,
      maxToolArgumentBytes: this.maxToolArgumentBytes,
      totalToolArgumentBytes: this.totalToolArgumentBytes,
      maxToolArgumentCodeUnits: this.maxToolArgumentCodeUnits,
      outputLimitHit,
      streamIncomplete,
      argumentBudgetCandidate,
      argumentBudgetExceeded,
      truncationConfidence,
      gatewayRecoveryAction: outputLimitHit
        ? this.outputTruncationMode === "chunk"
          ? "error"
          : this.outputTruncationMode
        : null,
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
    if (
      summary.visibleOutputChars !== undefined &&
      summary.visibleOutputChars !== null
    ) {
      this.visibleOutputChars = summary.visibleOutputChars;
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
  chatMessages?: ProviderChatMessage[];
  images?: MessageImageInput[];
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
  outputTruncationMode?: OutputTruncationMode;
  outputKind?: ProviderOutputKind;
  softToolArgumentBytes?: number | null;
  hardToolArgumentBytes?: number | null;
}

export async function collectProviderMessage(
  input: CollectProviderMessageInput
): Promise<CollectedProviderMessage | GatewayError> {
  const collector = new ProviderStreamSummaryCollector({
    softToolArgumentBytes: input.softToolArgumentBytes,
    hardToolArgumentBytes: input.hardToolArgumentBytes,
    outputTruncationMode: input.outputTruncationMode
  });
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
    chatMessages: input.chatMessages,
    images: input.images,
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
  const completionError = providerCompletionError(result.providerSummary, {
    outputTruncationMode: input.outputTruncationMode,
    outputKind: resolveCollectedOutputKind(input.outputKind ?? "auto", result)
  });
  if (
    completionError &&
    !(input.deferEmptyCompletionError && completionError.code === "upstream_empty_response")
  ) {
    return completionError;
  }
  return result;
}

export function streamErrorToGatewayError(event: {
  code: string;
  message: string;
  providerFailure?: ProviderFailureClassification;
}): GatewayError {
  const failure = event.providerFailure;
  if (event.code === "client_aborted") {
    return new GatewayError({
      code: "client_aborted",
      message: event.message,
      httpStatus: 499,
      providerFailure: failure
    });
  }
  if (event.code === "rate_limited") {
    return new GatewayError({
      code: "rate_limited",
      message: event.message,
      httpStatus: 429,
      retryAfterSeconds: 60,
      providerFailure: failure
    });
  }
  if (event.code === "provider_reauth_required") {
    return new GatewayError({
      code: "provider_reauth_required",
      message: event.message,
      httpStatus: 503,
      providerFailure: failure
    });
  }
  if (event.code === "subscription_unavailable") {
    return new GatewayError({
      code: "subscription_unavailable",
      message: event.message,
      httpStatus: 503,
      providerFailure: failure
    });
  }
  if (event.code === "context_length_exceeded" || event.code === "context_too_large") {
    return new GatewayError({
      code: "context_length_exceeded",
      message: CONTEXT_LENGTH_EXCEEDED_MESSAGE,
      httpStatus: 413,
      providerFailure: failure
    });
  }
  if (event.code === "invalid_request") {
    return new GatewayError({
      code: "invalid_request",
      message: event.message,
      httpStatus: 400,
      providerFailure: failure
    });
  }
  if (event.code === "upstream_timeout") {
    return new GatewayError({
      code: "upstream_timeout",
      message: event.message,
      httpStatus: 504,
      providerFailure: failure
    });
  }
  if (event.code === "upstream_unavailable") {
    return new GatewayError({
      code: "upstream_unavailable",
      message: event.message,
      httpStatus: 503,
      providerFailure: failure
    });
  }
  if (event.code === "upstream_incomplete_stream") {
    return new GatewayError({
      code: "upstream_incomplete_stream",
      message: event.message,
      httpStatus: 502,
      providerFailure: failure
    });
  }
  if (event.code === "upstream_empty_response") {
    return new GatewayError({
      code: "upstream_empty_response",
      message: event.message,
      httpStatus: 502,
      providerFailure: failure
    });
  }
  if (event.code === "content_policy_violation") {
    return new GatewayError({
      code: "content_policy_violation",
      message: event.message,
      httpStatus: 400,
      providerFailure: failure
    });
  }
  return new GatewayError({
    code: "service_unavailable",
    message: event.message,
    httpStatus: 503,
    providerFailure: failure
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
  const visibleOutputChars = present.reduce(
    (total, summary) => total + summary.visibleOutputChars,
    0
  );
  const toolCallCount = present.reduce((total, summary) => total + summary.toolCallCount, 0);
  const toolNames = [...new Set(present.flatMap((summary) => summary.toolNames))].sort();
  const usage = combineTokenUsages(present.map((summary) => summary.usage));
  const maxToolArgumentBytes = maxNullable(
    present.map((summary) => summary.maxToolArgumentBytes)
  );
  const totalToolArgumentBytes = sumNullable(
    present.map((summary) => summary.totalToolArgumentBytes)
  );
  const maxToolArgumentCodeUnits = maxNullable(
    present.map((summary) => summary.maxToolArgumentCodeUnits)
  );
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
    failure: present.findLast((summary) => summary.failure !== null)?.failure ?? null,
    contentChars,
    semanticOutputChars,
    visibleOutputChars,
    toolCallCount,
    toolNames,
    rawResponseHash: hash.digest("hex"),
    rawResponseChars: hasRawChars ? rawChars : null,
    terminationKind: present[present.length - 1]?.terminationKind ?? null,
    durationMs: present.reduce((total, summary) => total + summary.durationMs, 0),
    usage,
    maxToolArgumentBytes,
    totalToolArgumentBytes,
    maxToolArgumentCodeUnits,
    outputLimitHit: present.some((summary) => summary.outputLimitHit),
    streamIncomplete: present.some((summary) => summary.streamIncomplete),
    argumentBudgetCandidate: present.some(
      (summary) => summary.argumentBudgetCandidate
    ),
    argumentBudgetExceeded: present.some((summary) => summary.argumentBudgetExceeded),
    truncationConfidence: combinedTruncationConfidence(present),
    gatewayRecoveryAction:
      present.findLast((summary) => summary.gatewayRecoveryAction)?.gatewayRecoveryAction ?? null,
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
  const failure = error.providerFailure ?? summary.failure;
  if (failure && !error.providerFailure) {
    Object.defineProperty(error, "providerFailure", {
      value: failure,
      configurable: true
    });
  }
  const attempts = summary.attempts.map((attempt, index) =>
    index === summary.attempts.length - 1
      ? {
          ...attempt,
          errorCode: error.code,
          failure: failure ?? attempt.failure ?? null,
          ...(isToolCallValidationFailureKind(error.failureKind)
            ? { toolValidationFailureKind: error.failureKind }
            : {}),
          ...(error.recoveryOwner
            ? { gatewayRecoveryOwner: error.recoveryOwner }
            : {}),
          gatewayRecoveryResult: error.code
        }
      : attempt
  );
  Object.defineProperty(error, "providerSummary", {
    value: {
      ...summary,
      errorCode: error.code,
      failure: failure ?? null,
      attempts
    } satisfies ProviderStreamSummary,
    configurable: true
  });
  return error;
}

export function providerTruncatedWithoutOutputError(
  summary: ProviderStreamSummary
): GatewayError | null {
  if (
    summary.finishReason !== "length" ||
    summary.visibleOutputChars > 0 ||
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

  return providerProtocolError(summary, error);
}

export function providerCompletionError(
  summary: ProviderStreamSummary,
  options: ProviderCompletionErrorOptions = {}
): GatewayError | null {
  const assessment = assessProviderCompletion(summary);
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
  if (
    assessment.outputLimitHit &&
    (options.outputTruncationMode === "error" ||
      options.outputTruncationMode === "chunk")
  ) {
    return providerOutputLengthError(summary, options.outputKind ?? "auto");
  }
  const truncatedWithoutOutputError = providerTruncatedWithoutOutputError(summary);
  if (truncatedWithoutOutputError) {
    return truncatedWithoutOutputError;
  }
  if (
    // A completed turn that only reasoned is a legitimate empty answer, so this
    // fallback keeps counting reasoning as a response. Truncation is judged by
    // `providerTruncatedWithoutOutputError` above, which does not.
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

export function assessProviderCompletion(
  summary: ProviderStreamSummary,
  validationKind: ProviderCompletionAssessment["validationKind"] = "none"
): ProviderCompletionAssessment {
  return {
    finishReason: summary.finishReason,
    toolNames: [...summary.toolNames],
    toolCallCount: summary.toolCallCount,
    maxToolArgumentBytes: summary.maxToolArgumentBytes,
    totalToolArgumentBytes: summary.totalToolArgumentBytes,
    maxToolArgumentCodeUnits: summary.maxToolArgumentCodeUnits,
    validationKind,
    outputLimitHit: summary.outputLimitHit,
    streamIncomplete: summary.streamIncomplete,
    argumentBudgetCandidate: summary.argumentBudgetCandidate,
    argumentBudgetExceeded: summary.argumentBudgetExceeded,
    truncationConfidence: summary.truncationConfidence
  };
}

export function providerStreamSummaryFromError(error: GatewayError): ProviderStreamSummary | null {
  const summary = (error as GatewayError & { providerSummary?: unknown }).providerSummary;
  return isProviderStreamSummary(summary) ? summary : null;
}

function providerOutputLengthError(
  summary: ProviderStreamSummary,
  outputKind: ProviderOutputKind
): GatewayError {
  const isToolOutput =
    outputKind === "tool_call" ||
    (outputKind === "auto" && summary.toolCallCount > 0);
  const error = isToolOutput
    ? new GatewayError({
        code: "tool_call_output_truncated",
        message:
          "The generated tool call reached the request output limit and was not delivered.",
        httpStatus: 502,
        contractVersion: 1,
        failureKind: "confirmed_output_limit",
        transformedRetryAllowed: true,
        recommendedAction: "compact_and_generate_in_chunks",
        recoveryOwner: "client"
      })
    : new GatewayError({
        code: "output_length_exceeded",
        message: "The model reached the request output limit before completing its response.",
        httpStatus: 502,
        contractVersion: 1,
        failureKind: "confirmed_output_limit",
        transformedRetryAllowed: true,
        recommendedAction: "continue_with_more_output_budget",
        recoveryOwner: "client"
      });

  return providerProtocolError(summary, error);
}

function resolveCollectedOutputKind(
  requested: ProviderOutputKind,
  collected: Pick<CollectedProviderMessage, "content" | "toolCalls">
): ProviderOutputKind {
  if (requested !== "auto" || collected.toolCalls.length > 0) {
    return requested;
  }
  return /["']type["']\s*:\s*["']tool_calls["']|["']tool_calls["']\s*:/i.test(
    collected.content
  )
    ? "tool_call"
    : "auto";
}

function providerAttemptContext(input: CollectProviderMessageInput): ProviderStreamAttemptContext {
  const kind = input.attemptKind ?? "primary";
  return {
    kind,
    purpose: resolveUpstreamAttemptPurpose({ kind }, 1),
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
    purpose: resolveUpstreamAttemptPurpose(
      { index: 1, kind: attempt?.kind, purpose: attempt?.purpose },
      1
    ),
    failure: summary.failure ? { ...summary.failure } : null,
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
    terminationKind: summary.terminationKind,
    durationMs: summary.durationMs,
    promptTokens: summary.usage?.promptTokens ?? null,
    completionTokens: summary.usage?.completionTokens ?? null,
    totalTokens: summary.usage?.totalTokens ?? null,
    cachedPromptTokens: summary.usage?.cachedPromptTokens ?? null,
    reasoningTokens: summary.usage?.reasoningTokens ?? null,
    maxToolArgumentBytes: summary.maxToolArgumentBytes,
    totalToolArgumentBytes: summary.totalToolArgumentBytes,
    maxToolArgumentCodeUnits: summary.maxToolArgumentCodeUnits,
    toolValidationFailureKind: null,
    outputLimitHit: summary.outputLimitHit,
    streamIncomplete: summary.streamIncomplete,
    argumentBudgetCandidate: summary.argumentBudgetCandidate,
    argumentBudgetExceeded: summary.argumentBudgetExceeded,
    truncationConfidence: summary.truncationConfidence,
    gatewayRecoveryId: null,
    gatewayRecoveryOwner: null,
    gatewayRecoveryAction: summary.gatewayRecoveryAction,
    gatewayRecoveryResult: null,
    turnRecoveryCount: null
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

function isToolCallValidationFailureKind(
  value: GatewayError["failureKind"]
): value is "invalid_json" | "schema_mismatch" | "undeclared_tool" | "tool_choice_mismatch" {
  return (
    value === "invalid_json" ||
    value === "schema_mismatch" ||
    value === "undeclared_tool" ||
    value === "tool_choice_mismatch"
  );
}

function combineTokenUsages(usages: Array<TokenUsage | null | undefined>): TokenUsage | null {
  const present = usages.filter((usage): usage is TokenUsage => usage !== null && usage !== undefined);
  if (present.length === 0) {
    return null;
  }
  const hasCachedPromptTokens = present.some((usage) => usage.cachedPromptTokens !== undefined);
  const hasReasoningTokens = present.some((usage) => usage.reasoningTokens !== undefined);
  return {
    promptTokens: present.reduce((total, usage) => total + usage.promptTokens, 0),
    completionTokens: present.reduce((total, usage) => total + usage.completionTokens, 0),
    totalTokens: present.reduce((total, usage) => total + usage.totalTokens, 0),
    ...(hasCachedPromptTokens
      ? {
          cachedPromptTokens: present.reduce(
            (total, usage) => total + (usage.cachedPromptTokens ?? 0),
            0
          )
        }
      : {}),
    ...(hasReasoningTokens
      ? {
          reasoningTokens: present.reduce(
            (total, usage) => total + (usage.reasoningTokens ?? 0),
            0
          )
        }
      : {})
  };
}

function maxNullable(values: Array<number | null>): number | null {
  const present = values.filter((value): value is number => value !== null);
  return present.length > 0 ? Math.max(...present) : null;
}

function sumNullable(values: Array<number | null>): number | null {
  const present = values.filter((value): value is number => value !== null);
  return present.length > 0 ? present.reduce((total, value) => total + value, 0) : null;
}

function combinedTruncationConfidence(
  summaries: ProviderStreamSummary[]
): ProviderStreamSummary["truncationConfidence"] {
  if (summaries.some((summary) => summary.truncationConfidence === "confirmed")) {
    return "confirmed";
  }
  if (summaries.some((summary) => summary.truncationConfidence === "suspected")) {
    return "suspected";
  }
  return "none";
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
    failure: null,
    contentChars: 0,
    semanticOutputChars: 0,
    visibleOutputChars: 0,
    toolCallCount: 0,
    toolNames: [],
    rawResponseHash: null,
    rawResponseChars: null,
    emptyStop: null,
    terminationKind: null,
    durationMs: 0,
    usage: null,
    maxToolArgumentBytes: null,
    totalToolArgumentBytes: null,
    maxToolArgumentCodeUnits: null,
    outputLimitHit: false,
    streamIncomplete: false,
    argumentBudgetCandidate: false,
    argumentBudgetExceeded: false,
    truncationConfidence: "none",
    gatewayRecoveryAction: null,
    attempts: []
  };
}

function providerProtocolError(
  summary: ProviderStreamSummary,
  error: GatewayError
): GatewayError {
  if (!error.providerFailure && !summary.failure) {
    Object.defineProperty(error, "providerFailure", {
      value: classifyProviderFailure({
        stage: "streaming",
        upstreamStatus: summary.upstreamHttpStatus,
        originHint: "provider",
        kindHint: providerProtocolFailureKind(error.code)
      }),
      configurable: true
    });
  }
  return attachProviderStreamSummary(error, {
    ...summary,
    errorCode: error.code,
    attempts: summary.attempts.map((attempt) => ({
      ...attempt,
      ...(summary.terminationKind === "eof_before_terminal" &&
      (attempt.terminationKind === null ||
        attempt.terminationKind === undefined)
        ? { terminationKind: "eof_before_terminal" as const }
        : {})
    }))
  });
}

function providerProtocolFailureKind(
  code: GatewayError["code"]
): ProviderFailureClassification["kind"] {
  if (code === "upstream_incomplete_stream") {
    return "stream_incomplete";
  }
  if (code === "upstream_empty_response") {
    return "response_body_missing";
  }
  if (code === "content_policy_violation" || code === "context_length_exceeded") {
    return "http_request";
  }
  return "stream_protocol";
}
