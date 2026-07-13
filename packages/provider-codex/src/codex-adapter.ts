import {
  type Dirent,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  rmSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Codex,
  type CodexOptions,
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

const CONTEXT_LENGTH_EXCEEDED_MESSAGE =
  "Current conversation or attached files are too large. Start a new conversation, split large PDFs/files, or clear earlier history before retrying.";
const RUNTIME_STATE_DIR_PREFIX = "codex-gateway-state-";
const LEGACY_RUNTIME_STATE_DIR_PATTERN = /^codex-gateway-state-[A-Za-z0-9]{6}$/;
const PID_RUNTIME_STATE_DIR_PATTERN = /^codex-gateway-state-(\d+)-[A-Za-z0-9]{6}$/;
const DEFAULT_LEGACY_RUNTIME_STATE_MIN_AGE_MS = 60 * 60 * 1000;

export interface RuntimeStateCleanupOptions {
  rootDir?: string;
  currentPid?: number;
  nowMs?: number;
  legacyMinAgeMs?: number;
  isProcessAlive?: (pid: number) => boolean;
}

export interface RuntimeStateCleanupReport {
  removed: number;
  skippedActive: number;
  skippedFreshLegacy: number;
  skippedUnsafe: number;
  errors: number;
}

/**
 * Remove runtime-state directories left by an earlier Gateway process.
 *
 * Call this once during process startup, before accepting requests. The scan is
 * intentionally limited to the first level of the OS temp directory and only
 * accepts names produced by this adapter. Legacy directories without a PID are
 * removed only after a grace period so a concurrently running older Gateway is
 * not disrupted.
 */
export function cleanupStaleCodexRuntimeStateDirs(
  options: RuntimeStateCleanupOptions = {}
): RuntimeStateCleanupReport {
  const rootDir = options.rootDir ?? tmpdir();
  const currentPid = options.currentPid ?? process.pid;
  const nowMs = options.nowMs ?? Date.now();
  const legacyMinAgeMs =
    options.legacyMinAgeMs ?? DEFAULT_LEGACY_RUNTIME_STATE_MIN_AGE_MS;
  const isProcessAlive = options.isProcessAlive ?? processIsAlive;
  const report: RuntimeStateCleanupReport = {
    removed: 0,
    skippedActive: 0,
    skippedFreshLegacy: 0,
    skippedUnsafe: 0,
    errors: 0
  };

  let entries: Dirent[];
  try {
    entries = readdirSync(rootDir, { withFileTypes: true });
  } catch {
    report.errors += 1;
    return report;
  }

  for (const entry of entries) {
    if (!entry.name.startsWith(RUNTIME_STATE_DIR_PREFIX)) {
      continue;
    }

    const pidMatch = PID_RUNTIME_STATE_DIR_PATTERN.exec(entry.name);
    const legacyMatch = LEGACY_RUNTIME_STATE_DIR_PATTERN.test(entry.name);
    if (!pidMatch && !legacyMatch) {
      report.skippedUnsafe += 1;
      continue;
    }

    const candidate = join(rootDir, entry.name);
    try {
      const stats = lstatSync(candidate);
      if (!entry.isDirectory() || !stats.isDirectory() || stats.isSymbolicLink()) {
        report.skippedUnsafe += 1;
        continue;
      }

      if (pidMatch) {
        const ownerPid = Number.parseInt(pidMatch[1]!, 10);
        if (ownerPid !== currentPid && isProcessAlive(ownerPid)) {
          report.skippedActive += 1;
          continue;
        }
      } else if (nowMs - stats.mtimeMs < legacyMinAgeMs) {
        report.skippedFreshLegacy += 1;
        continue;
      }

      rmSync(candidate, { recursive: true, force: true });
      report.removed += 1;
    } catch {
      report.errors += 1;
    }
  }

  return report;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

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
  config?: CodexOptions["config"];
  env?: Record<string, string>;
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
    const ephemeral = input.session.id.startsWith("sess_stateless_");
    const client = this.createClient(input.reasoningEffort, ephemeral);
    const thread = input.session.providerSessionRef
      ? client.resumeThread(
          input.session.providerSessionRef,
          this.threadOptions(input.scope, input.reasoningEffort)
        )
      : client.startThread(this.threadOptions(input.scope, input.reasoningEffort));
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

    if (isContextWindowOverflow(lower)) {
      return new GatewayError({
        code: "context_length_exceeded",
        message: CONTEXT_LENGTH_EXCEEDED_MESSAGE,
        httpStatus: 413
      });
    }

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

  private createClient(
    reasoningEffort?: string | null,
    ephemeral = false
  ): CodexClientLike {
    mkdirSync(this.options.codexHome, { recursive: true });
    const config = codexConfigForRequest(reasoningEffort);
    const env = {
      ...process.env,
      CODEX_HOME: this.options.codexHome,
      ...(ephemeral ? { CODEX_GATEWAY_EPHEMERAL: "1" } : {})
    } as Record<string, string>;

    if (this.options.makeClient) {
      return this.options.makeClient({
        codexHome: this.options.codexHome,
        codexPath: this.options.codexPath,
        ...(config ? { config } : {}),
        env
      });
    }

    return new Codex({
      codexPathOverride: this.options.codexPath,
      ...(config ? { config } : {}),
      env
    });
  }

  private threadOptions(
    scope: "medical" | "code",
    reasoningEffort?: string | null
  ): ThreadOptions {
    return {
      model: this.options.model,
      modelReasoningEffort: codexThreadReasoningEffortForRequest(
        reasoningEffort,
        this.options.modelReasoningEffort
      ),
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

function codexThreadReasoningEffortForRequest(
  reasoningEffort: string | null | undefined,
  fallback: ModelReasoningEffort | undefined
): ModelReasoningEffort | undefined {
  if (reasoningEffort === "minimal") {
    return undefined;
  }
  return isModelReasoningEffort(reasoningEffort) ? reasoningEffort : fallback;
}

function codexConfigForRequest(
  reasoningEffort: string | null | undefined
): CodexOptions["config"] | undefined {
  const config: NonNullable<CodexOptions["config"]> = {};
  if (reasoningEffort === "minimal") {
    config.model_reasoning_effort = "none";
    config.features = { image_generation: false };
  }
  return Object.keys(config).length > 0 ? config : undefined;
}

function isModelReasoningEffort(value: string | null | undefined): value is ModelReasoningEffort {
  return (
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh"
  );
}

function isContextWindowOverflow(lowercaseMessage: string): boolean {
  return (
    lowercaseMessage.includes("ran out of room in the model's context window") ||
    lowercaseMessage.includes("ran out of room in the models context window") ||
    lowercaseMessage.includes("clear earlier history before retrying") ||
    lowercaseMessage.includes("context length exceeded") ||
    lowercaseMessage.includes("context_length_exceeded") ||
    lowercaseMessage.includes("maximum context length") ||
    lowercaseMessage.includes("context window") && lowercaseMessage.includes("too long")
  );
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
