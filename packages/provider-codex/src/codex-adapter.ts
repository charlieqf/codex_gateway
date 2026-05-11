import { existsSync, mkdirSync } from "node:fs";
import {
  Codex,
  type ModelReasoningEffort,
  type ThreadEvent,
  type ThreadOptions,
  type TurnOptions
} from "@openai/codex-sdk";
import {
  GatewayError,
  type MessageInput,
  type ProviderAdapter,
  type ProviderErrorDiagnostic,
  type ProviderHealth,
  type StreamEvent,
  type UpstreamAccount,
  type TokenUsage
} from "@codex-gateway/core";

export interface CodexProviderOptions {
  codexHome: string;
  codexPath?: string;
  model?: string;
  modelReasoningEffort?: ModelReasoningEffort;
  workingDirectory?: string;
  skipGitRepoCheck?: boolean;
  networkAccessEnabled?: boolean;
  sandboxMode?: ThreadOptions["sandboxMode"];
  makeClient?: (input: CodexClientFactoryInput) => CodexClientLike;
}

export interface CodexClientFactoryInput {
  codexHome: string;
  codexPath?: string;
}

export interface CodexClientLike {
  startThread(options?: ThreadOptions): CodexThreadLike;
  resumeThread(id: string, options?: ThreadOptions): CodexThreadLike;
}

export interface CodexThreadLike {
  readonly id: string | null;
  runStreamed(input: string, turnOptions?: TurnOptions): Promise<{
    events: AsyncGenerator<ThreadEvent>;
  }>;
}

export class CodexProviderAdapter implements ProviderAdapter {
  readonly kind = "openai-codex";

  constructor(private readonly options: CodexProviderOptions) {}

  async health(_upstreamAccount: UpstreamAccount): Promise<ProviderHealth> {
    // Phase 1 health is an auth-cache presence check, not credential validation.
    const authFile = `${this.options.codexHome}/auth.json`;
    if (existsSync(authFile)) {
      return {
        state: "healthy",
        checkedAt: new Date(),
        detail: "Codex auth cache is present."
      };
    }

    return {
      state: "reauth_required",
      checkedAt: new Date(),
      detail: "Codex auth cache is missing; run device-code authorization."
    };
  }

  async *message(input: MessageInput): AsyncIterable<StreamEvent> {
    const client = this.createClient();
    const thread = input.session.providerSessionRef
      ? client.resumeThread(input.session.providerSessionRef, this.threadOptions(input.scope))
      : client.startThread(this.threadOptions(input.scope));
    const agentTextByItemId = new Map<string, string>();
    const emittedToolCalls = new Set<string>();
    let providerSessionRef = input.session.providerSessionRef ?? thread.id;
    let usage: TokenUsage | undefined;

    try {
      const { events } = await thread.runStreamed(input.message, {
        signal: input.signal
      });

      for await (const event of events) {
        if (event.type === "thread.started") {
          providerSessionRef = event.thread_id;
          continue;
        }

        if (event.type === "turn.failed") {
          const normalized = this.normalizeAndReport(
            new Error(event.error.message),
            "turn.failed",
            input
          );
          yield {
            type: "error",
            code: normalized.code,
            message: normalized.message
          };
          return;
        }

        if (event.type === "error") {
          const normalized = this.normalizeAndReport(
            new Error(event.message),
            "stream.error",
            input
          );
          yield {
            type: "error",
            code: normalized.code,
            message: normalized.message
          };
          return;
        }

        if (event.type === "turn.completed") {
          usage = mapCodexUsage(event.usage);
          continue;
        }

        if (
          event.type === "item.started" ||
          event.type === "item.updated" ||
          event.type === "item.completed"
        ) {
          const streamEvent = this.mapThreadItem(
            event.item,
            agentTextByItemId,
            emittedToolCalls,
            input
          );
          if (streamEvent) {
            yield streamEvent;
            if (streamEvent.type === "error") {
              return;
            }
          }
        }
      }

      yield {
        type: "completed",
        providerSessionRef: providerSessionRef ?? thread.id ?? undefined,
        ...(usage ? { usage } : {})
      };
    } catch (err) {
      const normalized = this.normalizeAndReport(err, "exception", input);
      yield {
        type: "error",
        code: normalized.code,
        message: normalized.message
      };
    }
  }

  private normalizeAndReport(
    err: unknown,
    source: string,
    input: MessageInput
  ): GatewayError {
    const normalized = this.normalize(err);
    if (input.onProviderError) {
      try {
        input.onProviderError(createProviderErrorDiagnostic(err, source, normalized));
      } catch {
        // Provider error reporting is best-effort and must not mask the user-facing error.
      }
    }
    return normalized;
  }

  private normalize(err: unknown): GatewayError {
    if (err instanceof GatewayError) {
      return err;
    }

    const message = err instanceof Error ? err.message : String(err);
    const lower = message.toLowerCase();

    if (
      lower.includes("not logged in") ||
      lower.includes("login") ||
      lower.includes("unauthorized") ||
      lower.includes("401") ||
      lower.includes("reauth")
    ) {
      return new GatewayError({
        code: "provider_reauth_required",
        message: "MedCode service requires administrator reauthorization.",
        httpStatus: 503
      });
    }

    if (lower.includes("rate limit") || lower.includes("rate_limited") || lower.includes("429")) {
      return new GatewayError({
        code: "rate_limited",
        message: "MedCode service rate limit reached.",
        httpStatus: 429,
        retryAfterSeconds: 60
      });
    }

    return new GatewayError({
      code: "service_unavailable",
      message: "MedCode service is temporarily unavailable.",
      httpStatus: 503
    });
  }

  private createClient(): CodexClientLike {
    mkdirSync(this.options.codexHome, { recursive: true });

    if (this.options.makeClient) {
      return this.options.makeClient({
        codexHome: this.options.codexHome,
        codexPath: this.options.codexPath
      });
    }

    return new Codex({
      codexPathOverride: this.options.codexPath,
      env: {
        ...process.env,
        CODEX_HOME: this.options.codexHome
      } as Record<string, string>
    });
  }

  private threadOptions(scope: "medical" | "code"): ThreadOptions {
    return {
      model: this.options.model,
      modelReasoningEffort: this.options.modelReasoningEffort,
      workingDirectory: this.options.workingDirectory ?? process.cwd(),
      skipGitRepoCheck: this.options.skipGitRepoCheck,
      sandboxMode: this.options.sandboxMode ?? "read-only",
      approvalPolicy: "never",
      networkAccessEnabled: this.options.networkAccessEnabled ?? false,
      webSearchMode: "disabled",
      ...(scope === "medical" ? { additionalDirectories: [] } : {})
    };
  }

  private mapThreadItem(
    item: ThreadEvent extends infer Event
      ? Event extends { item: infer Item }
        ? Item
        : never
      : never,
    agentTextByItemId: Map<string, string>,
    emittedToolCalls: Set<string>,
    input: MessageInput
  ): StreamEvent | null {
    if (item.type === "agent_message") {
      const previous = agentTextByItemId.get(item.id) ?? "";
      agentTextByItemId.set(item.id, item.text);

      if (item.text.length === 0 || item.text === previous) {
        return null;
      }

      const delta = item.text.startsWith(previous)
        ? item.text.slice(previous.length)
        : item.text;

      return delta ? { type: "message_delta", text: delta } : null;
    }

    if (item.type === "mcp_tool_call") {
      if (emittedToolCalls.has(item.id)) {
        return null;
      }
      emittedToolCalls.add(item.id);

      return {
        type: "tool_call",
        name: `${item.server}.${item.tool}`,
        callId: item.id,
        arguments: item.arguments
      };
    }

    if (item.type === "command_execution") {
      if (emittedToolCalls.has(item.id)) {
        return null;
      }
      emittedToolCalls.add(item.id);

      return {
        type: "tool_call",
        name: "shell",
        callId: item.id,
        arguments: { command: item.command }
      };
    }

    if (item.type === "error") {
      const normalized = this.normalizeAndReport(new Error(item.message), "item.error", input);
      return {
        type: "error",
        code: normalized.code,
        message: normalized.message
      };
    }

    return null;
  }
}

function createProviderErrorDiagnostic(
  err: unknown,
  source: string,
  normalized: GatewayError
): ProviderErrorDiagnostic {
  const rawMessage = sanitizeProviderErrorText(errorMessage(err));
  const diagnostic: ProviderErrorDiagnostic = {
    source,
    code: normalized.code,
    publicMessage: normalized.message,
    rawMessage: rawMessage.length > 0 ? rawMessage : "(empty provider error)"
  };
  const rawName = sanitizeProviderErrorText(errorStringProperty(err, "name"));
  if (rawName) {
    diagnostic.rawName = rawName;
  }
  const rawCode = sanitizeProviderErrorText(errorStringProperty(err, "code"));
  if (rawCode) {
    diagnostic.rawCode = rawCode;
  }
  const rawStatus = errorNumberProperty(err, "status") ?? errorNumberProperty(err, "statusCode");
  if (rawStatus !== null) {
    diagnostic.rawStatus = rawStatus;
  }
  return diagnostic;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

function errorStringProperty(err: unknown, key: string): string {
  if (!isObject(err)) {
    return "";
  }
  const value = err[key];
  return typeof value === "string" ? value : "";
}

function errorNumberProperty(err: unknown, key: string): number | null {
  if (!isObject(err)) {
    return null;
  }
  const value = err[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return Math.trunc(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function sanitizeProviderErrorText(value: string): string {
  const redacted = value
    .replace(
      /(["'])(authorization|api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|id[-_ ]?token|cookie|set-cookie|password)\1\s*:\s*(["'])(?:\\.|(?!\3).)*\3/gi,
      (_match, keyQuote: string, key: string, valueQuote: string) =>
        `${keyQuote}${key}${keyQuote}:${valueQuote}<redacted>${valueQuote}`
    )
    .replace(/\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer <redacted>")
    .replace(
      /\b(authorization|api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|id[-_ ]?token|cookie|set-cookie|password)\s*[:=]\s*["']?[^"',\s;}]+/gi,
      "$1=<redacted>"
    )
    .replace(/\bcmev1\.[A-Za-z0-9._~-]{16,}\b/g, "cmev1.<redacted>")
    .replace(/\bcgu_live_[A-Za-z0-9]{64}\b/g, "cgu_live_<redacted>")
    .replace(/\bcgw\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{16,}\b/g, "cgw.<redacted>")
    .replace(/\bmev2_live_[A-Za-z0-9_-]+\b/g, "mev2_live_<redacted>")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "sk-<redacted>");
  return redacted.length > 2048 ? `${redacted.slice(0, 2048)}...[truncated]` : redacted;
}

function mapCodexUsage(
  usage:
    | {
        input_tokens?: number;
        cached_input_tokens?: number;
        output_tokens?: number;
      }
    | undefined
): TokenUsage | undefined {
  if (!usage) {
    return undefined;
  }

  const promptTokens = safeTokenCount(usage.input_tokens);
  const completionTokens = safeTokenCount(usage.output_tokens);
  const cachedPromptTokens = safeTokenCount(usage.cached_input_tokens);

  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    ...(cachedPromptTokens > 0 ? { cachedPromptTokens } : {})
  };
}

function safeTokenCount(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.trunc(value);
}
