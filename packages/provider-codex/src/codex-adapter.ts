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
  type CancelInput,
  type CreateSessionInput,
  type CreateSessionResult,
  type ListSessionInput,
  type MessageInput,
  type ProviderAdapter,
  type ProviderHealth,
  type ProviderSession,
  type RefreshResult,
  type StreamEvent,
  type Subscription,
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

  async health(_subscription: Subscription): Promise<ProviderHealth> {
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

  async refresh(_subscription: Subscription): Promise<RefreshResult> {
    if (existsSync(`${this.options.codexHome}/auth.json`)) {
      return {
        state: "not_needed",
        detail: "Codex CLI refreshes ChatGPT tokens during active use."
      };
    }

    return {
      state: "reauth_required",
      detail: "Codex auth cache is missing."
    };
  }

  async create(input: CreateSessionInput): Promise<CreateSessionResult> {
    if (!input.initialMessage) {
      return {
        providerSessionRef: null
      };
    }

    const client = this.createClient();
    const thread = client.startThread(this.threadOptions(input.scope));
    let providerSessionRef: string | null = null;

    try {
      const { events } = await thread.runStreamed(input.initialMessage);
      for await (const event of events) {
        if (event.type === "thread.started") {
          providerSessionRef = event.thread_id;
        } else if (event.type === "turn.failed") {
          throw this.normalize(new Error(event.error.message));
        } else if (event.type === "error") {
          throw this.normalize(new Error(event.message));
        }
      }
    } catch (err) {
      throw this.normalize(err);
    }

    return {
      providerSessionRef: providerSessionRef ?? thread.id
    };
  }

  async list(_input: ListSessionInput): Promise<ProviderSession[]> {
    // Codex SDK threads are persisted under CODEX_HOME but are not exposed through
    // a stable list API. Gateway Session Store remains the source of truth.
    return [];
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
          const normalized = this.normalize(new Error(event.error.message));
          yield {
            type: "error",
            code: normalized.code,
            message: normalized.message
          };
          continue;
        }

        if (event.type === "error") {
          const normalized = this.normalize(new Error(event.message));
          yield {
            type: "error",
            code: normalized.code,
            message: normalized.message
          };
          continue;
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
          const streamEvent = this.mapThreadItem(event.item, agentTextByItemId, emittedToolCalls);
          if (streamEvent) {
            yield streamEvent;
          }
        }
      }

      yield {
        type: "completed",
        providerSessionRef: providerSessionRef ?? thread.id ?? undefined,
        ...(usage ? { usage } : {})
      };
    } catch (err) {
      const normalized = this.normalize(err);
      yield {
        type: "error",
        code: normalized.code,
        message: normalized.message
      };
    }
  }

  async cancel(_input: CancelInput): Promise<void> {
    return;
  }

  normalize(err: unknown): GatewayError {
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
    emittedToolCalls: Set<string>
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
      return {
        type: "error",
        code: "service_unavailable",
        message: item.message
      };
    }

    return null;
  }
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
