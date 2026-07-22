import { createHash, randomUUID } from "node:crypto";
import {
  GatewayError,
  type MessageInput,
  type ProviderAdapter,
  type ProviderErrorDiagnostic,
  type ProviderHealth,
  type ProviderKind,
  type ProviderResponseSummary,
  type ProviderStreamTermination,
  type StreamEvent,
  type TokenUsage,
  type UpstreamAccount
} from "@codex-gateway/core";
import { buildOpenRouterIdentityGuardPrompt } from "./openrouter-identity-guard.js";

export interface OpenAICompatibleProviderOptions {
  providerKind: Extract<ProviderKind, "openrouter" | "qianfan" | "aliyun" | "tencent">;
  baseUrl: string;
  apiKey: string;
  apiKeyEnv: string;
  upstreamModel: string;
  reasoning?: Record<string, unknown>;
  reasoningParameterStyle?: "object" | "effort_field";
  timeoutMs: number;
  siteUrl?: string;
  appTitle?: string;
  fetchImpl?: typeof fetch;
}

export class OpenAICompatibleProviderAdapter implements ProviderAdapter {
  readonly kind: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: OpenAICompatibleProviderOptions) {
    this.kind = options.providerKind;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async health(_upstreamAccount: UpstreamAccount): Promise<ProviderHealth> {
    return {
      state: this.options.apiKey ? "healthy" : "unhealthy",
      checkedAt: new Date(),
      detail: this.options.apiKey
        ? `${this.options.providerKind} API key is configured.`
        : `${this.options.apiKeyEnv} is missing.`
    };
  }

  async *message(input: MessageInput): AsyncIterable<StreamEvent> {
    const abort = createAbortSignal(input.signal, this.options.timeoutMs);
    try {
      const response = await this.fetchImpl(chatCompletionsUrl(this.options.baseUrl), {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(this.requestBody(input)),
        signal: abort.signal
      });

      if (!response.ok) {
        const normalized = await this.errorFromResponse(response, input);
        yield {
          type: "error",
          code: normalized.code,
          message: normalized.message
        };
        return;
      }

      if (!response.body) {
        yield {
          type: "error",
          code: "upstream_unavailable",
          message: "MedCode service is temporarily unavailable."
        };
        return;
      }

      let usage: TokenUsage | undefined;
      let finishReason: string | null = null;
      let semanticOutputChars = 0;
      let sawDone = false;
      let sawFinishReason = false;
      const rawResponseHash = createHash("sha256");
      let rawResponseChars = 0;
      const nativeToolCalls = nativeToolCallsEnabled(input)
        ? new NativeToolCallAccumulator()
        : null;
      for await (const chunk of parseOpenAISse(response.body)) {
        if (chunk.type === "done") {
          sawDone = true;
          break;
        }
        rawResponseHash.update(chunk.rawData, "utf8");
        rawResponseChars += chunk.rawData.length;
        const upstreamStreamError = openAIStreamError(chunk.value);
        if (upstreamStreamError) {
          const normalized = this.normalizeAndReport(
            upstreamStreamError,
            "stream_error_frame",
            input
          );
          yield {
            type: "error",
            code: normalized.code,
            message: normalized.message,
            responseSummary: {
              finishReason,
              upstreamRequestId: upstreamRequestId(response.headers),
              upstreamHttpStatus: response.status,
              semanticOutputChars,
              rawResponseHash: rawResponseHash.digest("hex"),
              rawResponseChars,
              terminationKind: "error"
            }
          };
          return;
        }
        const event = mapOpenAIStreamChunk(chunk.value, nativeToolCalls);
        semanticOutputChars += event.semanticOutputChars;
        for (const mappedEvent of event.events) {
          yield mappedEvent;
        }
        if (event.usage) {
          usage = event.usage;
        }
        if (event.finishReason !== null) {
          finishReason = event.finishReason;
          sawFinishReason = true;
        }
      }
      const terminationKind = providerStreamTermination(sawDone, sawFinishReason);
      const responseSummary: ProviderResponseSummary = {
        finishReason,
        upstreamRequestId: upstreamRequestId(response.headers),
        upstreamHttpStatus: response.status,
        semanticOutputChars,
        rawResponseHash: rawResponseHash.digest("hex"),
        rawResponseChars,
        terminationKind
      };

      if (terminationKind === "eof_before_terminal") {
        const normalized = this.normalizeAndReport(
          new GatewayError({
            code: "upstream_incomplete_stream",
            message: "MedCode upstream response ended before completion.",
            httpStatus: 502,
            upstreamStatus: response.status
          }),
          "incomplete_sse_eof",
          input
        );
        yield {
          type: "error",
          code: normalized.code,
          message: normalized.message,
          responseSummary
        };
        return;
      }

      if (nativeToolCalls) {
        for (const event of nativeToolCalls.drain()) {
          yield event;
        }
      }

      yield {
        type: "completed",
        ...(usage ? { usage } : {}),
        responseSummary
      };
    } catch (err) {
      const normalized = this.normalizeAndReport(err, "exception", input);
      yield {
        type: "error",
        code: normalized.code,
        message: normalized.message
      };
    } finally {
      abort.cleanup();
    }
  }

  private requestBody(input: MessageInput): Record<string, unknown> {
    return {
      model: this.options.upstreamModel,
      messages: [
        {
          role: "system",
          content: buildOpenRouterIdentityGuardPrompt()
        },
        {
          role: "user",
          content: input.message
        }
      ],
      stream: true,
      stream_options: {
        include_usage: true
      },
      ...(input.maximumOutputTokens === undefined
        ? {}
        : { max_tokens: input.maximumOutputTokens }),
      ...this.reasoningPayload(input),
      ...(nativeToolCallsEnabled(input)
        ? {
            tools: input.clientTools,
            tool_choice: input.clientToolChoice ?? "auto"
          }
        : {})
    };
  }

  private reasoningPayload(input: MessageInput): Record<string, unknown> {
    const reasoning = this.reasoningForInput(input);
    if (!reasoning) {
      return {};
    }
    if (this.options.reasoningParameterStyle !== "effort_field") {
      return { reasoning };
    }
    const effort = reasoning.effort;
    return typeof effort === "string" && effort.length > 0
      ? { reasoning_effort: effort }
      : {};
  }

  private reasoningForInput(input: MessageInput): Record<string, unknown> | undefined {
    if (input.reasoningEffort) {
      return {
        ...(this.options.reasoning ?? {}),
        effort: input.reasoningEffort
      };
    }
    return this.options.reasoning;
  }

  private headers(): HeadersInit {
    return {
      authorization: `Bearer ${this.options.apiKey}`,
      "content-type": "application/json",
      ...(this.options.providerKind === "openrouter" && this.options.siteUrl
        ? { "HTTP-Referer": this.options.siteUrl }
        : {}),
      ...(this.options.providerKind === "openrouter" && this.options.appTitle
        ? { "X-OpenRouter-Title": this.options.appTitle }
        : {})
    };
  }

  private async errorFromResponse(
    response: Response,
    input: MessageInput
  ): Promise<GatewayError> {
    const body = await response.text().catch(() => "");
    return this.normalizeAndReport(
      new UpstreamHttpError(response.status, body || response.statusText),
      "http_response",
      input
    );
  }

  private normalizeAndReport(err: unknown, source: string, input: MessageInput): GatewayError {
    const normalized =
      input.signal?.aborted && input.signal.reason instanceof GatewayError
        ? input.signal.reason
        : this.normalize(err);
    if (input.onProviderError) {
      try {
        input.onProviderError(createProviderErrorDiagnostic(err, source, normalized));
      } catch {
        // Diagnostic hooks must not mask provider errors.
      }
    }
    return normalized;
  }

  private normalize(err: unknown): GatewayError {
    if (err instanceof GatewayError) {
      return err;
    }
    if (err instanceof UpstreamHttpError) {
      if (err.status === 429) {
        return new GatewayError({
          code: "rate_limited",
          message: "MedCode service rate limit reached.",
          httpStatus: 429,
          retryAfterSeconds: 60,
          upstreamStatus: err.status
        });
      }
      if (err.status === 400) {
        return new GatewayError({
          code: "invalid_request",
          message: "MedCode upstream rejected the request.",
          httpStatus: 400,
          upstreamStatus: err.status
        });
      }
      if (err.status === 408 || err.status === 504) {
        return new GatewayError({
          code: "upstream_timeout",
          message: "MedCode service timed out.",
          httpStatus: 504,
          upstreamStatus: err.status
        });
      }
      return new GatewayError({
        code: "upstream_unavailable",
        message: "MedCode service is temporarily unavailable.",
        httpStatus: err.status >= 500 ? 503 : 502,
        upstreamStatus: err.status
      });
    }

    if (isAbortError(err)) {
      return new GatewayError({
        code: "upstream_timeout",
        message: "MedCode service timed out.",
        httpStatus: 504
      });
    }

    return new GatewayError({
      code: "upstream_unavailable",
      message: "MedCode service is temporarily unavailable.",
      httpStatus: 503
    });
  }
}

interface ParsedOpenAIChunk {
  events: StreamEvent[];
  usage?: TokenUsage;
  finishReason: string | null;
  semanticOutputChars: number;
}

interface ParsedOpenAISseData {
  type: "data";
  value: unknown;
  rawData: string;
}

interface ParsedOpenAISseDone {
  type: "done";
}

async function* parseOpenAISse(
  body: ReadableStream<Uint8Array>
): AsyncIterable<ParsedOpenAISseData | ParsedOpenAISseDone> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) {
          continue;
        }
        const data = trimmed.slice("data:".length).trim();
        if (!data) {
          continue;
        }
        if (data === "[DONE]") {
          yield { type: "done" };
          return;
        }
        yield {
          type: "data",
          value: JSON.parse(data) as unknown,
          rawData: data
        };
      }
    }
    const tail = buffer.trim();
    if (tail.startsWith("data:")) {
      const data = tail.slice("data:".length).trim();
      if (data === "[DONE]") {
        yield { type: "done" };
        return;
      }
      if (data) {
        yield {
          type: "data",
          value: JSON.parse(data) as unknown,
          rawData: data
        };
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function providerStreamTermination(
  sawDone: boolean,
  sawFinishReason: boolean
): ProviderStreamTermination {
  if (sawDone && sawFinishReason) {
    return "finish_reason_and_done";
  }
  if (sawDone) {
    return "done";
  }
  return "eof_before_terminal";
}

function mapOpenAIStreamChunk(
  chunk: unknown,
  nativeToolCalls: NativeToolCallAccumulator | null = null
): ParsedOpenAIChunk {
  if (!isRecord(chunk)) {
    return { events: [], finishReason: null, semanticOutputChars: 0 };
  }
  const usage = mapUsage(chunk.usage);
  const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
  const choice = choices[0];
  if (!isRecord(choice)) {
    return usage
      ? { events: [], usage, finishReason: null, semanticOutputChars: 0 }
      : { events: [], finishReason: null, semanticOutputChars: 0 };
  }

  const events: StreamEvent[] = [];
  const delta = choice.delta;
  let semanticOutputChars = 0;
  if (isRecord(delta)) {
    const content = delta.content;
    if (typeof content === "string" && content.length > 0) {
      events.push({ type: "message_delta", text: content });
      semanticOutputChars += content.length;
    }
    const refusal = delta.refusal;
    if (typeof refusal === "string" && refusal.length > 0) {
      events.push({ type: "message_delta", text: refusal });
      semanticOutputChars += refusal.length;
    }
    const reasoningContent =
      typeof delta.reasoning_content === "string"
        ? delta.reasoning_content
        : typeof delta.reasoning === "string"
          ? delta.reasoning
          : "";
    if (reasoningContent.length > 0) {
      semanticOutputChars += reasoningContent.length;
    }
    if (nativeToolCalls === null) {
      semanticOutputChars += structuredOutputChars(delta.tool_calls);
      semanticOutputChars += structuredOutputChars(delta.function_call);
    }
    nativeToolCalls?.append(delta.tool_calls);
  }

  return {
    events,
    ...(usage ? { usage } : {}),
    finishReason:
      typeof choice.finish_reason === "string" ? choice.finish_reason : null,
    semanticOutputChars
  };
}

function structuredOutputChars(value: unknown): number {
  if (value === undefined || value === null) {
    return 0;
  }
  try {
    return JSON.stringify(value).length;
  } catch {
    return 0;
  }
}

function openAIStreamError(
  chunk: unknown
): GatewayError | UpstreamHttpError | null {
  if (!isRecord(chunk) || chunk.error === undefined || chunk.error === null) {
    return null;
  }
  const error = chunk.error;
  const errorRecord = isRecord(error) ? error : null;
  const rawText = safeJson(error);
  const status =
    firstHttpStatus(
      errorRecord?.status,
      errorRecord?.status_code,
      errorRecord?.http_status,
      errorRecord?.code,
      chunk.status,
      chunk.status_code
    ) ?? inferredErrorStatus(errorRecord, rawText);
  const classifierText = [
    errorRecord?.code,
    errorRecord?.type,
    errorRecord?.message,
    rawText
  ]
    .map((value) => (typeof value === "string" ? value : ""))
    .join(" ");

  if (/content[_ -]?filter|content[_ -]?policy|moderation|safety/i.test(classifierText)) {
    return new GatewayError({
      code: "content_policy_violation",
      message: "MedCode upstream filtered the response for content policy reasons.",
      httpStatus: 400,
      ...(status !== null ? { upstreamStatus: status } : {})
    });
  }
  return new UpstreamHttpError(status ?? 502, rawText);
}

function firstHttpStatus(...values: unknown[]): number | null {
  for (const value of values) {
    const numeric =
      typeof value === "number"
        ? value
        : typeof value === "string" && /^\d{3}$/.test(value.trim())
          ? Number(value)
          : NaN;
    if (Number.isInteger(numeric) && numeric >= 400 && numeric <= 599) {
      return numeric;
    }
  }
  return null;
}

function inferredErrorStatus(
  error: Record<string, unknown> | null,
  rawText: string
): number | null {
  const classifierText = [
    error?.code,
    error?.type,
    error?.message,
    rawText
  ]
    .map((value) => (typeof value === "string" ? value : ""))
    .join(" ");
  if (/rate[_ -]?limit|too many requests/i.test(classifierText)) {
    return 429;
  }
  if (/invalid[_ -]?request|bad request/i.test(classifierText)) {
    return 400;
  }
  if (/timeout|timed out/i.test(classifierText)) {
    return 504;
  }
  return null;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

interface PendingNativeToolCall {
  index: number;
  id: string | null;
  name: string;
  argumentsJson: string;
}

class NativeToolCallAccumulator {
  private readonly pending = new Map<number, PendingNativeToolCall>();

  append(value: unknown): void {
    if (!Array.isArray(value)) {
      return;
    }
    for (const [fallbackIndex, item] of value.entries()) {
      if (!isRecord(item)) {
        continue;
      }
      const index =
        typeof item.index === "number" && Number.isInteger(item.index)
          ? item.index
          : fallbackIndex;
      const current =
        this.pending.get(index) ??
        ({
          index,
          id: null,
          name: "",
          argumentsJson: ""
        } satisfies PendingNativeToolCall);

      if (typeof item.id === "string" && item.id.length > 0) {
        current.id = item.id;
      }

      if (isRecord(item.function)) {
        if (typeof item.function.name === "string" && item.function.name.length > 0) {
          current.name += item.function.name;
        }
        if (typeof item.function.arguments === "string") {
          current.argumentsJson += item.function.arguments;
        }
      }

      this.pending.set(index, current);
    }
  }

  drain(): StreamEvent[] {
    if (this.pending.size === 0) {
      return [];
    }

    const events = [...this.pending.values()]
      .sort((a, b) => a.index - b.index)
      .filter((item) => item.name.length > 0)
      .map((item) => {
        const argumentsJson = item.argumentsJson || "{}";
        return {
          type: "tool_call" as const,
          callId: item.id ?? `call_${randomUUID().replaceAll("-", "")}`,
          name: item.name,
          arguments: parseToolArguments(argumentsJson),
          argumentsJson
        };
      });
    this.pending.clear();
    return events;
  }
}

function parseToolArguments(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function nativeToolCallsEnabled(input: MessageInput): boolean {
  return (
    input.clientTools !== undefined &&
    input.clientTools.length > 0 &&
    input.clientToolChoice !== "none"
  );
}

function mapUsage(value: unknown): TokenUsage | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const promptTokens = tokenCount(value.prompt_tokens);
  const completionTokens = tokenCount(value.completion_tokens);
  const totalTokens = tokenCount(value.total_tokens);
  const promptDetails = isRecord(value.prompt_tokens_details)
    ? value.prompt_tokens_details
    : null;
  const completionDetails = isRecord(value.completion_tokens_details)
    ? value.completion_tokens_details
    : null;
  const cachedPromptTokens = tokenCount(promptDetails?.cached_tokens);
  const reasoningTokens = tokenCount(completionDetails?.reasoning_tokens);
  return {
    promptTokens,
    completionTokens,
    totalTokens: totalTokens || promptTokens + completionTokens,
    ...(cachedPromptTokens > 0 ? { cachedPromptTokens } : {}),
    ...(completionDetails && "reasoning_tokens" in completionDetails
      ? { reasoningTokens }
      : {})
  };
}

function createAbortSignal(
  inputSignal: AbortSignal | undefined,
  timeoutMs: number
): { signal: AbortSignal; cleanup(): void } {
  const controller = new AbortController();
  const abortFromInput = () => controller.abort(inputSignal?.reason);
  if (inputSignal?.aborted) {
    abortFromInput();
  } else {
    inputSignal?.addEventListener("abort", abortFromInput, { once: true });
  }
  const timeout = setTimeout(() => {
    controller.abort(new Error("upstream_timeout"));
  }, timeoutMs);

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeout);
      inputSignal?.removeEventListener("abort", abortFromInput);
    }
  };
}

function chatCompletionsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
}

function upstreamRequestId(headers: Headers): string | null {
  return (
    headers.get("x-request-id") ??
    headers.get("x-openrouter-request-id") ??
    headers.get("x-bce-request-id") ??
    headers.get("openai-request-id") ??
    headers.get("x-zai-request-id") ??
    headers.get("x-ds-request-id")
  );
}

class UpstreamHttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "UpstreamHttpError";
  }
}

function createProviderErrorDiagnostic(
  err: unknown,
  source: string,
  normalized: GatewayError
): ProviderErrorDiagnostic {
  return {
    source,
    code: normalized.code,
    publicMessage: normalized.message,
    rawMessage: sanitizeProviderErrorText(errorMessage(err)),
    ...(err instanceof UpstreamHttpError ? { rawStatus: err.status } : {})
  };
}

function tokenCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.trunc(value);
}

function isAbortError(err: unknown): boolean {
  if (err instanceof Error && err.message === "upstream_timeout") {
    return true;
  }
  return err instanceof DOMException && err.name === "AbortError";
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

function sanitizeProviderErrorText(value: string): string {
  const redacted = value
    .replace(/\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer <redacted>")
    .replace(/\bbce-v3\/[A-Za-z0-9_-]+\/[A-Za-z0-9]+\b/g, "bce-v3/<redacted>")
    .replace(
      /\b(authorization|api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|id[-_ ]?token|cookie|set-cookie|password)\s*[:=]\s*["']?[^"',\s;}]+/gi,
      "$1=<redacted>"
    )
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "sk-<redacted>");
  return redacted.length > 2048 ? `${redacted.slice(0, 2048)}...[truncated]` : redacted;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
