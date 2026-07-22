import { request as requestHttp } from "node:http";
import { request as requestHttps } from "node:https";
import { readBoundedResponseBody } from "./safe-http.js";

export interface ResearchModelUsage {
  promptTokens: number | null;
  completionTokens: number | null;
  reasoningTokens?: number | null;
  totalTokens: number | null;
}

export interface ResearchModelCallTelemetry {
  promptChars: number;
  maximumOutputTokens: number;
  admissionWaitMs: number;
  requestSentAt: Date | null;
  clientTotalMs: number;
  terminalSource:
    | "provider_response"
    | "provider_deadline"
    | "transport_error"
    | "client_abort"
    | "worker_deadline"
    | "worker_abort";
  cancelRequested: boolean;
  cancelObserved: boolean;
}

export interface ResearchModelResponse {
  text: string;
  gatewayRequestId: string | null;
  usage: ResearchModelUsage;
  telemetry?: ResearchModelCallTelemetry;
}

export interface ResearchModelClient {
  readonly model: string;
  generate(input: {
    runId: string;
    stage: string;
    attempt: number;
    system: string;
    prompt: string;
    signal: AbortSignal;
    maximumOutputTokens?: number;
  }): Promise<ResearchModelResponse>;
}

export class GatewayResearchModelClient implements ResearchModelClient {
  readonly model: string;
  private readonly endpoint: URL;
  private readonly readinessEndpoint: URL;
  private readonly timeoutMs: number;
  private readonly maximumResponseBytes: number;
  private readonly maximumOutputTokensPerCall: number;
  private readonly now: () => Date;
  private readonly monotonicNow: () => number;

  constructor(
    private readonly options: {
      baseUrl: string;
      allowedHosts: readonly string[];
      model: string;
      reasoningEffort: "none" | "low" | "medium" | "high";
      bearerToken: string;
      timeoutMs: number;
      maximumResponseBytes: number;
      readinessRequirements: {
        maximumPromptTokensPerCall: number;
        maximumOutputTokensPerCall: number;
        callsPerRun: number;
        concurrentCalls?: number;
        maximumTokensPerRun: number;
      };
      fetchImpl?: typeof fetch;
      now?: () => Date;
      monotonicNow?: () => number;
    }
  ) {
    this.model = requiredIdentifier(options.model, "model");
    if (!["none", "low", "medium", "high"].includes(options.reasoningEffort)) {
      throw new Error("Research LLM reasoning effort is invalid.");
    }
    if (
      options.bearerToken !== options.bearerToken.trim() ||
      options.bearerToken.length < 8 ||
      options.bearerToken.length > 8_192 ||
      /[\r\n\u0000]/u.test(options.bearerToken)
    ) {
      throw new Error("Research LLM bearer token is missing or invalid.");
    }
    this.timeoutMs = positiveInteger(options.timeoutMs, "timeoutMs");
    this.maximumResponseBytes = positiveInteger(
      options.maximumResponseBytes,
      "maximumResponseBytes"
    );
    const readiness = options.readinessRequirements;
    positiveInteger(
      readiness.maximumPromptTokensPerCall,
      "readinessRequirements.maximumPromptTokensPerCall"
    );
    positiveInteger(
      readiness.maximumOutputTokensPerCall,
      "readinessRequirements.maximumOutputTokensPerCall"
    );
    this.maximumOutputTokensPerCall =
      readiness.maximumOutputTokensPerCall;
    this.now = options.now ?? (() => new Date());
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
    positiveInteger(
      readiness.callsPerRun,
      "readinessRequirements.callsPerRun"
    );
    const concurrentCalls = readiness.concurrentCalls ?? 1;
    positiveInteger(
      concurrentCalls,
      "readinessRequirements.concurrentCalls"
    );
    positiveInteger(
      readiness.maximumTokensPerRun,
      "readinessRequirements.maximumTokensPerRun"
    );
    if (
      readiness.callsPerRun > 5 ||
      concurrentCalls > readiness.callsPerRun ||
      !Number.isSafeInteger(
        readiness.maximumPromptTokensPerCall +
          readiness.maximumOutputTokensPerCall
      ) ||
      readiness.maximumTokensPerRun <
        readiness.maximumPromptTokensPerCall +
          readiness.maximumOutputTokensPerCall
    ) {
      throw new Error("Research LLM readiness requirements are inconsistent.");
    }
    const baseUrl = new URL(options.baseUrl);
    if (
      (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") ||
      baseUrl.username ||
      baseUrl.password ||
      baseUrl.search ||
      baseUrl.hash
    ) {
      throw new Error("Research LLM base URL is invalid.");
    }
    const normalizedHost = baseUrl.hostname.toLowerCase().replace(/\.$/u, "");
    if (
      baseUrl.protocol === "http:" &&
      !["127.0.0.1", "localhost", "[::1]"].includes(normalizedHost) &&
      !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(normalizedHost)
    ) {
      throw new Error(
        "Research LLM cleartext HTTP is limited to loopback or a single-label private service name."
      );
    }
    if (
      options.allowedHosts.length === 0 ||
      options.allowedHosts.length > 20 ||
      !options.allowedHosts.some(
        (host) => host.toLowerCase().replace(/\.$/u, "") === normalizedHost
      )
    ) {
      throw new Error("Research LLM base URL host is not allowlisted.");
    }
    this.endpoint = new URL("/v1/chat/completions", baseUrl);
    this.readinessEndpoint = new URL(
      `/gateway/research/v1/worker/llm-readiness/${encodeURIComponent(this.model)}`,
      baseUrl
    );
    this.readinessEndpoint.searchParams.set(
      "maximum_prompt_tokens_per_call",
      String(readiness.maximumPromptTokensPerCall)
    );
    this.readinessEndpoint.searchParams.set(
      "maximum_output_tokens_per_call",
      String(readiness.maximumOutputTokensPerCall)
    );
    this.readinessEndpoint.searchParams.set(
      "calls_per_run",
      String(readiness.callsPerRun)
    );
    this.readinessEndpoint.searchParams.set(
      "concurrent_calls",
      String(concurrentCalls)
    );
    this.readinessEndpoint.searchParams.set(
      "maximum_tokens_per_run",
      String(readiness.maximumTokensPerRun)
    );
  }

  async assertModelAvailable(signal: AbortSignal): Promise<void> {
    const response = await (this.options.fetchImpl ?? fetch)(this.readinessEndpoint, {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${this.options.bearerToken}`
      },
      redirect: "error",
      signal: AbortSignal.any([
        signal,
        AbortSignal.timeout(this.timeoutMs)
      ])
    });
    const requestId = boundedHeader(response.headers.get("x-request-id"));
    const bytes = await readBoundedResponseBody(
      response.body,
      this.maximumResponseBytes
    );
    let payload: unknown;
    try {
      payload = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new ResearchModelClientError(
        "invalid_response",
        response.status,
        requestId
      );
    }
    if (
      !response.ok ||
      !isRecord(payload) ||
      payload.authorized !== true ||
      payload.model !== this.model
    ) {
      throw new ResearchModelClientError(
        response.status === 429 ? "rate_limited" : "upstream_error",
        response.status,
        requestId
      );
    }
  }

  async generate(input: {
    runId: string;
    stage: string;
    attempt: number;
    system: string;
    prompt: string;
    signal: AbortSignal;
    maximumOutputTokens?: number;
  }): Promise<ResearchModelResponse> {
    if (!/^drr_[a-f0-9]{32}$/.test(input.runId)) {
      throw new Error("Research LLM run ID is invalid.");
    }
    const stage = requiredIdentifier(input.stage, "stage");
    if (!Number.isSafeInteger(input.attempt) || input.attempt < 1 || input.attempt > 9) {
      throw new Error("Research LLM attempt is invalid.");
    }
    if (
      input.system.length === 0 ||
      input.system.length > 30_000 ||
      input.prompt.length === 0 ||
      input.prompt.length > 500_000
    ) {
      throw new Error("Research LLM prompt is empty or exceeds its bound.");
    }
    const maximumOutputTokens =
      input.maximumOutputTokens ?? this.maximumOutputTokensPerCall;
    if (
      !Number.isSafeInteger(maximumOutputTokens) ||
      maximumOutputTokens <= 0 ||
      maximumOutputTokens > this.maximumOutputTokensPerCall
    ) {
      throw new Error(
        "Research LLM request output token limit is invalid."
      );
    }
    const clientStartedAt = this.monotonicNow();
    let admissionWaitMs = 0;
    let requestSentAt: Date | null = null;
    let activeSignal: AbortSignal | null = null;
    let terminalSource: ResearchModelCallTelemetry["terminalSource"] =
      "transport_error";
    let cancelObserved = false;
    const telemetry = (): ResearchModelCallTelemetry => ({
      promptChars: input.system.length + input.prompt.length,
      maximumOutputTokens,
      admissionWaitMs,
      requestSentAt,
      clientTotalMs: elapsedMonotonicMilliseconds(
        clientStartedAt,
        this.monotonicNow()
      ),
      terminalSource,
      cancelRequested:
        input.signal.aborted || activeSignal?.aborted === true,
      cancelObserved
    });
    try {
      for (let admissionRetry = 0; ; admissionRetry += 1) {
        const signal = AbortSignal.any([
          input.signal,
          AbortSignal.timeout(this.timeoutMs)
        ]);
        activeSignal = signal;
        requestSentAt ??= this.now();
        let response: Response;
        try {
          const headers = {
            accept: "application/json",
            authorization: `Bearer ${this.options.bearerToken}`,
            "content-type": "application/json",
            "x-medcode-client-session-id":
              `${input.runId}:${stage}:${input.attempt}`,
            "x-medcode-client-turn-code": `research:${stage}:${input.attempt}`
          };
          const body = JSON.stringify({
            model: this.model,
            stream: false,
            max_tokens: maximumOutputTokens,
            reasoning_effort: this.options.reasoningEffort,
            messages: [
              { role: "system", content: input.system },
              { role: "user", content: input.prompt }
            ]
          });
          response = this.options.fetchImpl
            ? await this.options.fetchImpl(this.endpoint, {
                method: "POST",
                headers,
                body,
                redirect: "error",
                signal
              })
            : await requestBoundedModelResponse({
                url: this.endpoint,
                headers,
                body,
                signal,
                timeoutMs: this.timeoutMs,
                maximumBytes: this.maximumResponseBytes
              });
        } catch (error) {
          if (input.signal.aborted) {
            cancelObserved = true;
            terminalSource = abortTerminalSource(input.signal.reason);
            throw input.signal.reason ?? error;
          }
          if (signal.aborted) {
            cancelObserved = true;
            terminalSource = "provider_deadline";
            throw signal.reason ?? error;
          }
          terminalSource = "transport_error";
          throw new ResearchModelClientError("upstream_error", 0, null);
        }
        terminalSource = "provider_response";
        const requestId = boundedHeader(
          response.headers.get("x-request-id")
        );
        const bytes = await readBoundedResponseBody(
          response.body,
          this.maximumResponseBytes
        );
        let payload: unknown;
        try {
          payload = JSON.parse(bytes.toString("utf8"));
        } catch {
          throw new ResearchModelClientError(
            "invalid_response",
            response.status,
            requestId
          );
        }
        if (!response.ok) {
          const retryAfterSeconds =
            response.status === 429
              ? modelRetryAfterSeconds(response.headers, payload)
              : null;
          if (
            response.status === 429 &&
            admissionRetry < 6 &&
            !input.signal.aborted
          ) {
            const waitStartedAt = this.monotonicNow();
            try {
              await waitForModelAdmission({
                retryIndex: admissionRetry,
                retryAfterSeconds,
                attempt: input.attempt,
                signal: input.signal
              });
            } finally {
              admissionWaitMs += elapsedMonotonicMilliseconds(
                waitStartedAt,
                this.monotonicNow()
              );
            }
            continue;
          }
          throw new ResearchModelClientError(
            response.status === 429 ? "rate_limited" : "upstream_error",
            response.status,
            requestId,
            retryAfterSeconds
          );
        }
        if (!isRecord(payload)) {
          throw new ResearchModelClientError(
            "invalid_response",
            response.status,
            requestId
          );
        }
        const choices = payload.choices;
        const first =
          Array.isArray(choices) &&
          choices.length === 1 &&
          isRecord(choices[0])
            ? choices[0]
            : null;
        const message =
          first && isRecord(first.message) ? first.message : null;
        const text =
          typeof message?.content === "string" ? message.content : null;
        if (text === null || text.trim() === "") {
          throw new ResearchModelClientError(
            "empty_response",
            response.status,
            requestId
          );
        }
        const usage = isRecord(payload.usage) ? payload.usage : null;
        const completionDetails =
          usage && isRecord(usage.completion_tokens_details)
            ? usage.completion_tokens_details
            : null;
        return {
          text,
          gatewayRequestId: requestId,
          usage: {
            promptTokens: nonNegativeIntegerOrNull(usage?.prompt_tokens),
            completionTokens: nonNegativeIntegerOrNull(
              usage?.completion_tokens
            ),
            reasoningTokens: nonNegativeIntegerOrNull(
              completionDetails?.reasoning_tokens
            ),
            totalTokens: nonNegativeIntegerOrNull(usage?.total_tokens)
          },
          telemetry: telemetry()
        };
      }
    } catch (error) {
      if (input.signal.aborted) {
        cancelObserved = true;
        terminalSource = abortTerminalSource(input.signal.reason);
      } else if (activeSignal?.aborted) {
        cancelObserved = true;
        terminalSource = "provider_deadline";
      }
      throw attachResearchModelCallTelemetry(error, telemetry());
    }
  }
}

async function requestBoundedModelResponse(input: {
  url: URL;
  headers: Readonly<Record<string, string>>;
  body: string;
  signal: AbortSignal;
  timeoutMs: number;
  maximumBytes: number;
}): Promise<Response> {
  const request = input.url.protocol === "https:" ? requestHttps : requestHttp;
  return await new Promise<Response>((resolve, reject) => {
    let settled = false;
    const finishReject = (error: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      reject(error);
    };
    const outgoing = request(
      input.url,
      {
        method: "POST",
        headers: {
          ...input.headers,
          "content-length": String(Buffer.byteLength(input.body, "utf8"))
        },
        signal: input.signal
      },
      (incoming) => {
        const chunks: Buffer[] = [];
        let size = 0;
        incoming.on("data", (value: Buffer | string) => {
          if (settled) {
            return;
          }
          const chunk = Buffer.isBuffer(value)
            ? value
            : Buffer.from(value);
          size += chunk.length;
          if (size > input.maximumBytes) {
            incoming.destroy(
              new Error("Research LLM response exceeded its byte bound.")
            );
            return;
          }
          chunks.push(chunk);
        });
        incoming.once("error", finishReject);
        incoming.once("aborted", () =>
          finishReject(new Error("Research LLM response was aborted."))
        );
        incoming.once("end", () => {
          if (settled) {
            return;
          }
          const status = incoming.statusCode;
          if (
            status === undefined ||
            status < 100 ||
            status > 599
          ) {
            finishReject(
              new Error("Research LLM response status is invalid.")
            );
            return;
          }
          const headers = new Headers();
          for (const [name, rawValue] of Object.entries(
            incoming.headers
          )) {
            for (const value of Array.isArray(rawValue)
              ? rawValue
              : rawValue === undefined
                ? []
                : [rawValue]) {
              headers.append(name, value);
            }
          }
          settled = true;
          resolve(
            new Response(Buffer.concat(chunks, size), {
              status,
              headers
            })
          );
        });
      }
    );
    outgoing.setTimeout(input.timeoutMs, () => {
      outgoing.destroy(
        new DOMException("Research LLM request timed out.", "TimeoutError")
      );
    });
    outgoing.once("error", finishReject);
    outgoing.end(input.body);
  });
}

export class ResearchModelClientError extends Error {
  constructor(
    readonly code:
      | "rate_limited"
      | "upstream_error"
      | "invalid_response"
      | "empty_response",
    readonly statusCode: number,
    readonly gatewayRequestId: string | null,
    readonly retryAfterSeconds: number | null = null
  ) {
    super("Research LLM request failed.");
    this.name = "ResearchModelClientError";
  }
}

const researchModelCallTelemetry = Symbol("researchModelCallTelemetry");

export function researchModelCallTelemetryFromError(
  error: unknown
): ResearchModelCallTelemetry | null {
  if (
    (typeof error !== "object" && typeof error !== "function") ||
    error === null
  ) {
    return null;
  }
  const value = (
    error as { [researchModelCallTelemetry]?: ResearchModelCallTelemetry }
  )[researchModelCallTelemetry];
  return value ?? null;
}

function attachResearchModelCallTelemetry(
  error: unknown,
  telemetry: ResearchModelCallTelemetry
): unknown {
  if (
    (typeof error !== "object" && typeof error !== "function") ||
    error === null
  ) {
    return error;
  }
  try {
    Object.defineProperty(error, researchModelCallTelemetry, {
      configurable: true,
      value: telemetry
    });
  } catch {
    // Preserve the original error even when it is non-extensible.
  }
  return error;
}

function abortTerminalSource(
  reason: unknown
): "client_abort" | "worker_deadline" | "worker_abort" {
  if (
    isRecord(reason) &&
    (reason.code === "client_aborted" || reason.code === "client_abort")
  ) {
    return "client_abort";
  }
  if (
    reason instanceof DOMException &&
    reason.name === "TimeoutError"
  ) {
    return "worker_deadline";
  }
  return "worker_abort";
}

function elapsedMonotonicMilliseconds(start: number, end: number): number {
  return Math.max(0, Math.round(end - start));
}

function modelRetryAfterSeconds(
  headers: Headers,
  payload: unknown
): number | null {
  if (isRecord(payload)) {
    const nestedError = isRecord(payload.error) ? payload.error : null;
    const value =
      payload.retry_after_seconds ?? nestedError?.retry_after_seconds;
    if (
      typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value >= 0 &&
      value <= 3_600
    ) {
      return value;
    }
  }
  const value = headers.get("retry-after")?.trim();
  if (value && /^[0-9]{1,4}$/u.test(value)) {
    const seconds = Number.parseInt(value, 10);
    return seconds <= 3_600 ? seconds : null;
  }
  return null;
}

async function waitForModelAdmission(input: {
  retryIndex: number;
  retryAfterSeconds: number | null;
  attempt: number;
  signal: AbortSignal;
}): Promise<void> {
  const exponentialMs = Math.min(
    15_000,
    250 * 2 ** input.retryIndex
  );
  const serverMs = Math.min(
    15_000,
    (input.retryAfterSeconds ?? 0) * 1_000
  );
  const staggerMs = Math.min(750, input.attempt * 100);
  const delayMs = Math.max(exponentialMs, serverMs) + staggerMs;
  if (input.signal.aborted) {
    throw input.signal.reason;
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      input.signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      reject(input.signal.reason);
    };
    input.signal.addEventListener("abort", onAbort, { once: true });
    if (input.signal.aborted) {
      onAbort();
    }
  });
}

export function estimateResearchInputTokens(value: string): number {
  return Math.max(1, Math.ceil(Buffer.byteLength(value, "utf8") / 3));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonNegativeIntegerOrNull(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
    ? value
    : null;
}

function boundedHeader(value: string | null): string | null {
  return value && value.length <= 200 ? value : null;
}

function requiredIdentifier(value: string, name: string): string {
  const normalized = value.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/u.test(normalized)) {
    throw new Error(`${name} is invalid.`);
  }
  return normalized;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer.`);
  }
  return value;
}
