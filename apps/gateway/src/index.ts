import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import {
  type CredentialAuthStore,
  GatewayError,
  type GatewaySession,
  type GatewayStore,
  type ObservationStore,
  type ProviderAdapter,
  type Subject,
  type Subscription
} from "@codex-gateway/core";
import {
  CodexProviderAdapter,
  type CodexProviderOptions
} from "@codex-gateway/provider-codex";
import { createSqliteStore } from "@codex-gateway/store-sqlite";
import { credentialAuthHook, devAuthHook } from "./http/auth.js";
import { getGatewayContext } from "./http/context.js";
import {
  markFirstByte,
  markGatewayError,
  markSession,
  recordObservation,
  startObservation
} from "./http/observation.js";
import { rateLimitHook, releaseRateLimit } from "./http/rate-limit.js";
import {
  chatMessagesToPrompt,
  createChatCompletionResponse,
  createFinalChatCompletionChunk,
  createInitialChatCompletionChunk,
  openAIErrorPayload,
  openAIUsageFromTokenUsage,
  parseChatCompletionRequest,
  streamEventToChatCompletionChunk,
  type ChatCompletionShape,
  type OpenAIChatToolCall,
  type OpenAIChatUsage
} from "./openai-compat.js";
import {
  InMemoryCredentialRateLimiter,
  type CredentialRateLimiter
} from "./services/rate-limiter.js";
import { InMemorySessionStore } from "./services/session-store.js";

export type GatewayAuthMode = "dev" | "credential";

export interface GatewayOptions {
  accessToken?: string;
  authMode?: GatewayAuthMode;
  credentialStore?: CredentialAuthStore;
  publicMetadata?: GatewayPublicMetadata;
  provider?: ProviderAdapter;
  sessionStore?: GatewayStore;
  subject?: Subject;
  subscription?: Subscription;
  rateLimiter?: CredentialRateLimiter;
  observationStore?: ObservationStore;
  logger?: boolean;
}

export interface GatewayPublicMetadata {
  serviceName?: string;
  providerName?: string;
  providerDisplayName?: string;
  subscriptionId?: string;
  phase?: string;
}

interface ResolvedGatewayPublicMetadata {
  serviceName: string;
  providerName: string;
  providerDisplayName: string;
  subscriptionId: string;
  phase: string;
}

interface MessageBody {
  message?: unknown;
}

export function buildGateway(options: GatewayOptions = {}) {
  const app = Fastify({ logger: options.logger ?? true });
  const accessToken = options.accessToken ?? process.env.GATEWAY_DEV_ACCESS_TOKEN;
  const subject = options.subject ?? defaultSubject();
  const subscription = options.subscription ?? defaultSubscription();
  const provider =
    options.provider ??
    new CodexProviderAdapter({
      codexHome: process.env.CODEX_HOME ?? ".gateway-state/codex-home",
      model: process.env.MEDCODE_UPSTREAM_MODEL,
      modelReasoningEffort: parseModelReasoningEffort(
        process.env.MEDCODE_UPSTREAM_REASONING_EFFORT
      ),
      workingDirectory: process.env.CODEX_WORKDIR ?? process.cwd(),
      skipGitRepoCheck: process.env.CODEX_SKIP_GIT_REPO_CHECK === "1"
    });
  const sessions = options.sessionStore ?? createDefaultSessionStore();
  const credentialStore =
    options.credentialStore ?? (isCredentialAuthStore(sessions) ? sessions : undefined);
  const publicMetadata = resolvePublicMetadata(options.publicMetadata, process.env);
  const openAIModelId = process.env.MEDCODE_PUBLIC_MODEL_ID ?? "medcode";
  const openAIModelLimits = resolveOpenAIModelLimits(process.env);
  const configuredAuthMode = options.authMode ?? parseAuthMode(process.env.GATEWAY_AUTH_MODE);
  const authMode = resolveAuthMode({
    configured: configuredAuthMode,
    accessToken,
    credentialStore
  });
  validateAuthModeForEnvironment(authMode, process.env.NODE_ENV);
  const rateLimiter = options.rateLimiter ?? new InMemoryCredentialRateLimiter();
  const observationStore =
    options.observationStore ?? (isObservationStore(sessions) ? sessions : undefined);
  sessions.upsertSubject(subject);
  sessions.upsertSubscription(subscription);
  const devContext = {
    subject,
    subscription,
    provider,
    scope: "code" as const,
    credential: {
      id: null,
      prefix: "dev",
      label: "Development token",
      expiresAt: null,
      rate: null
    }
  };

  app.addHook("onClose", async () => {
    sessions.close?.();
  });

  app.addHook("onRequest", async (request) => {
    startObservation(request);
  });

  if (authMode === "dev") {
    app.log.warn({ auth_mode: authMode }, "Gateway running in dev auth mode.");
  } else if (accessToken && credentialStore && !configuredAuthMode) {
    app.log.warn(
      { auth_mode: authMode },
      "Gateway credential auth mode selected; GATEWAY_DEV_ACCESS_TOKEN is ignored."
    );
  }

  if (authMode === "credential") {
    if (!credentialStore) {
      throw new Error("Credential auth mode requires a credential store.");
    }
    app.addHook("onRequest", async (request, reply) =>
      credentialAuthHook(request, reply, {
        store: credentialStore,
        provider,
        subscription
      })
    );
  } else {
    app.addHook("onRequest", async (request, reply) =>
      devAuthHook(request, reply, {
        accessToken,
        context: devContext
      })
    );
  }

  app.addHook("preHandler", async (request, reply) =>
    rateLimitHook(request, reply, rateLimiter)
  );

  app.addHook("onResponse", async (request, reply) => {
    releaseRateLimit(request);
    recordObservation(request, observationStore, reply.statusCode);
  });

  app.get(
    "/gateway/health",
    {
      config: { public: true }
    },
    async () => ({
      state: "ready",
      service: publicMetadata.serviceName,
      auth_mode: authMode,
      provider: publicMetadata.providerName,
      store: {
        session: storeKind(sessions),
        observation: observationStore ? "enabled" : "disabled"
      },
      phase: publicMetadata.phase
    })
  );

  app.get("/gateway/status", async (request) => {
    const { subject, subscription, provider, scope, credential } = getGatewayContext(request);
    const health = await provider.health(subscription);

    return {
      state: health.state === "healthy" ? "ready" : health.state,
      subject: {
        id: subject.id,
        label: subject.label
      },
      credential: {
        prefix: credential.prefix,
        scope,
        expires_at: credential.expiresAt?.toISOString() ?? null,
        rate: credential.rate
      },
      subscription: {
        id: publicMetadata.subscriptionId,
        provider: publicMetadata.providerName,
        state: health.state,
        detail: publicProviderDetail(health.state, publicMetadata.providerDisplayName)
      }
    };
  });

  app.get("/v1/models", async () => ({
    object: "list",
    data: [openAIModelObject(openAIModelId, openAIModelLimits)]
  }));

  app.get<{ Params: { id: string } }>("/v1/models/:id", async (request, reply) => {
    if (request.params.id !== openAIModelId) {
      return sendOpenAIError(
        request,
        reply,
        new GatewayError({
          code: "invalid_request",
          message: `Model '${request.params.id}' does not exist.`,
          httpStatus: 404
        })
      );
    }

    return openAIModelObject(openAIModelId, openAIModelLimits);
  });

  app.post<{ Body: unknown }>("/v1/chat/completions", async (request, reply) => {
    const { subject, subscription, provider, scope } = getGatewayContext(request);
    const parsed = parseChatCompletionRequest(request.body, openAIModelId);
    if (parsed instanceof GatewayError) {
      return sendOpenAIError(request, reply, parsed);
    }

    const session = createStatelessSession(subject.id, subscription.id);
    markSession(request, session.id);
    const shape = createChatCompletionShape(parsed.model);
    const prompt = chatMessagesToPrompt(parsed);

    if (parsed.stream) {
      reply.raw.setHeader("content-type", "text/event-stream; charset=utf-8");
      reply.raw.setHeader("cache-control", "no-cache");
      reply.raw.setHeader("connection", "keep-alive");
      reply.hijack();

      const abort = new AbortController();
      let closed = false;
      let failed = false;
      let hasToolCalls = false;
      let toolCallIndex = 0;
      let usage: OpenAIChatUsage | null = null;
      const close = () => {
        closed = true;
        abort.abort();
      };
      reply.raw.on("close", close);
      const heartbeat = setInterval(() => {
        writeSseComment(reply, "ping");
      }, 25_000);
      heartbeat.unref?.();

      try {
        writeOpenAISseData(reply, createInitialChatCompletionChunk(shape));
        markFirstByte(request);

        for await (const event of provider.message({
          subscription,
          subject,
          scope,
          session,
          message: prompt,
          signal: abort.signal
        })) {
          if (closed) {
            break;
          }
          if (event.type === "completed") {
            usage = openAIUsageFromTokenUsage(event.usage);
            continue;
          }
          if (event.type === "error") {
            const error = streamErrorToGatewayError(event);
            request.gatewayErrorCode = error.code;
            writeOpenAISseData(reply, openAIErrorPayload(error));
            failed = true;
            break;
          }

          if (event.type === "tool_call") {
            hasToolCalls = true;
          }

          const chunk = streamEventToChatCompletionChunk({
            shape,
            event,
            toolCallIndex
          });
          if (event.type === "tool_call") {
            toolCallIndex += 1;
          }
          if (chunk && !writeOpenAISseData(reply, chunk)) {
            abort.abort();
            break;
          }
        }

        if (!closed && !failed) {
          const finishReason = hasToolCalls ? "tool_calls" : "stop";
          writeOpenAISseData(reply, createFinalChatCompletionChunk(shape, finishReason, usage));
          writeOpenAISseDone(reply);
        }
      } finally {
        releaseRateLimit(request);
        recordObservation(request, observationStore, reply.raw.statusCode);
        clearInterval(heartbeat);
        reply.raw.off("close", close);
        if (!reply.raw.destroyed && !reply.raw.writableEnded) {
          reply.raw.end();
        }
      }
      return;
    }

    let content = "";
    const toolCalls: OpenAIChatToolCall[] = [];
    let usage: OpenAIChatUsage | null = null;

    for await (const event of provider.message({
      subscription,
      subject,
      scope,
      session,
      message: prompt
    })) {
      if (event.type === "message_delta") {
        markFirstByte(request);
        content += event.text;
      } else if (event.type === "tool_call") {
        markFirstByte(request);
        toolCalls.push({
          id: event.callId,
          type: "function",
          function: {
            name: event.name,
            arguments: JSON.stringify(event.arguments ?? {})
          }
        });
      } else if (event.type === "error") {
        return sendOpenAIError(request, reply, streamErrorToGatewayError(event));
      } else if (event.type === "completed") {
        usage = openAIUsageFromTokenUsage(event.usage);
      }
    }

    return createChatCompletionResponse({
      shape,
      content,
      toolCalls,
      finishReason: toolCalls.length > 0 ? "tool_calls" : "stop",
      usage
    });
  });

  app.get("/sessions", async (request) => {
    const { subject } = getGatewayContext(request);
    return {
      sessions: sessions
        .list(subject.id)
        .map((session) => serializeSession(session, publicMetadata))
    };
  });

  app.post("/sessions", async (request, reply) => {
    const { subject, subscription } = getGatewayContext(request);
    const session = sessions.create({
      subjectId: subject.id,
      subscriptionId: subscription.id
    });
    markSession(request, session.id);

    reply.code(201);
    return {
      session: serializeSession(session, publicMetadata)
    };
  });

  app.post<{ Params: { id: string }; Body: MessageBody }>(
    "/sessions/:id/messages",
    async (request, reply) => {
      const { subject, subscription, provider, scope } = getGatewayContext(request);
      markSession(request, request.params.id);

      const session = sessions.get(request.params.id);
      if (!session || session.subjectId !== subject.id) {
        return sendError(
          request,
          reply,
          new GatewayError({
            code: "session_not_found",
            message: "Session does not exist or does not belong to the current subject.",
            httpStatus: 404
          })
        );
      }

      const message = request.body?.message;
      if (typeof message !== "string" || message.length === 0) {
        return sendError(
          request,
          reply,
          new GatewayError({
            code: "invalid_request",
            message: "message must be a non-empty string.",
            httpStatus: 400
          })
        );
      }

      reply.raw.setHeader("content-type", "text/event-stream; charset=utf-8");
      reply.raw.setHeader("cache-control", "no-cache");
      reply.raw.setHeader("connection", "keep-alive");
      reply.hijack();

      const abort = new AbortController();
      let closed = false;
      const close = () => {
        closed = true;
        abort.abort();
      };
      reply.raw.on("close", close);
      const heartbeat = setInterval(() => {
        writeSseComment(reply, "ping");
      }, 25_000);
      heartbeat.unref?.();

      try {
        for await (const event of provider.message({
          subscription,
          subject,
          scope,
          session,
          message,
          signal: abort.signal
        })) {
          if (closed) {
            break;
          }
          if (event.type === "completed" && event.providerSessionRef) {
            sessions.setProviderSessionRef(session.id, event.providerSessionRef);
          }
          if (event.type === "error") {
            request.gatewayErrorCode = event.code;
          }
          markFirstByte(request);
          if (!writeSseEvent(reply, event.type, event)) {
            abort.abort();
            break;
          }
        }
      } finally {
        releaseRateLimit(request);
        recordObservation(request, observationStore, reply.raw.statusCode);
        clearInterval(heartbeat);
        reply.raw.off("close", close);
        if (!reply.raw.destroyed && !reply.raw.writableEnded) {
          reply.raw.end();
        }
      }
    }
  );

  return app;
}

async function main() {
  validateRuntimeEnvironment(process.env);
  const host = process.env.GATEWAY_HOST ?? "127.0.0.1";
  const port = Number.parseInt(process.env.GATEWAY_PORT ?? "8787", 10);
  const app = buildGateway();
  await app.listen({ host, port });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}

function sendError(request: FastifyRequest, reply: FastifyReply, error: GatewayError) {
  markGatewayError(request, error);
  reply.code(error.httpStatus);
  return {
    error: {
      code: error.code,
      message: error.message,
      retry_after_seconds: error.retryAfterSeconds
    }
  };
}

function sendOpenAIError(request: FastifyRequest, reply: FastifyReply, error: GatewayError) {
  markGatewayError(request, error);
  reply.code(error.httpStatus);
  return openAIErrorPayload(error);
}

interface OpenAIModelLimits {
  contextWindow: number;
  maxContextWindow: number;
  maxOutputTokens: number;
}

function openAIModelObject(model: string, limits: OpenAIModelLimits) {
  return {
    id: model,
    object: "model",
    created: 0,
    owned_by: "medcode",
    context_window: limits.contextWindow,
    max_context_window: limits.maxContextWindow,
    max_output_tokens: limits.maxOutputTokens
  };
}

function createChatCompletionShape(model: string): ChatCompletionShape {
  return {
    id: `chatcmpl_${randomUUID().replaceAll("-", "")}`,
    created: Math.floor(Date.now() / 1000),
    model
  };
}

function createStatelessSession(subjectId: string, subscriptionId: string): GatewaySession {
  const now = new Date();
  return {
    id: `sess_stateless_${randomUUID().replaceAll("-", "")}`,
    subjectId,
    subscriptionId,
    providerSessionRef: null,
    title: null,
    state: "active",
    createdAt: now,
    updatedAt: now
  };
}

function streamErrorToGatewayError(event: { code: string; message: string }): GatewayError {
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
  if (event.code === "invalid_request") {
    return new GatewayError({
      code: "invalid_request",
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

function writeSseEvent(reply: FastifyReply, event: string, data: unknown): boolean {
  if (reply.raw.destroyed || reply.raw.writableEnded) {
    return false;
  }

  try {
    reply.raw.write(`event: ${event}\n`);
    reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
    return true;
  } catch {
    return false;
  }
}

function writeOpenAISseData(reply: FastifyReply, data: unknown): boolean {
  if (reply.raw.destroyed || reply.raw.writableEnded) {
    return false;
  }

  try {
    reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
    return true;
  } catch {
    return false;
  }
}

function writeOpenAISseDone(reply: FastifyReply): boolean {
  if (reply.raw.destroyed || reply.raw.writableEnded) {
    return false;
  }

  try {
    reply.raw.write("data: [DONE]\n\n");
    return true;
  } catch {
    return false;
  }
}

function writeSseComment(reply: FastifyReply, comment: string): boolean {
  if (reply.raw.destroyed || reply.raw.writableEnded) {
    return false;
  }

  try {
    reply.raw.write(`:${comment}\n\n`);
    return true;
  } catch {
    return false;
  }
}

function defaultSubject(): Subject {
  return {
    id: "subj_dev",
    label: "dev-subject",
    state: "active",
    createdAt: new Date()
  };
}

function defaultSubscription(): Subscription {
  return {
    id: "sub_openai_codex_dev",
    provider: "openai-codex",
    label: "OpenAI Codex dev subscription",
    credentialRef: "CODEX_HOME",
    state: "active",
    lastUsedAt: null,
    cooldownUntil: null
  };
}

function serializeSession(
  session: GatewaySession,
  publicMetadata: ResolvedGatewayPublicMetadata
) {
  return {
    id: session.id,
    subject_id: session.subjectId,
    subscription_id: publicMetadata.subscriptionId,
    provider_session_ref: session.providerSessionRef,
    title: session.title,
    state: session.state,
    created_at: session.createdAt.toISOString(),
    updated_at: session.updatedAt.toISOString()
  };
}

function resolvePublicMetadata(
  input: GatewayPublicMetadata | undefined,
  env: NodeJS.ProcessEnv
): ResolvedGatewayPublicMetadata {
  const providerDisplayName =
    input?.providerDisplayName ?? env.GATEWAY_PUBLIC_PROVIDER_DISPLAY_NAME ?? "MedCode";
  const providerName = input?.providerName ?? env.GATEWAY_PUBLIC_PROVIDER_NAME ?? "medcode";

  return {
    serviceName: input?.serviceName ?? env.GATEWAY_PUBLIC_SERVICE_NAME ?? "medcode",
    providerName,
    providerDisplayName,
    subscriptionId:
      input?.subscriptionId ?? env.GATEWAY_PUBLIC_SUBSCRIPTION_ID ?? providerName,
    phase: input?.phase ?? env.GATEWAY_PUBLIC_PHASE ?? "controlled-trial"
  };
}

function resolveOpenAIModelLimits(env: NodeJS.ProcessEnv): OpenAIModelLimits {
  return {
    contextWindow: parsePositiveIntegerEnv(
      env.MEDCODE_PUBLIC_MODEL_CONTEXT_WINDOW,
      272_000,
      "MEDCODE_PUBLIC_MODEL_CONTEXT_WINDOW"
    ),
    maxContextWindow: parsePositiveIntegerEnv(
      env.MEDCODE_PUBLIC_MODEL_MAX_CONTEXT_WINDOW,
      1_000_000,
      "MEDCODE_PUBLIC_MODEL_MAX_CONTEXT_WINDOW"
    ),
    maxOutputTokens: parsePositiveIntegerEnv(
      env.MEDCODE_PUBLIC_MODEL_MAX_OUTPUT_TOKENS,
      128_000,
      "MEDCODE_PUBLIC_MODEL_MAX_OUTPUT_TOKENS"
    )
  };
}

function parsePositiveIntegerEnv(
  value: string | undefined,
  fallback: number,
  name: string
): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

function publicProviderDetail(
  state: "healthy" | "degraded" | "reauth_required" | "unhealthy",
  providerDisplayName: string
): string {
  if (state === "healthy") {
    return `${providerDisplayName} service is available.`;
  }
  if (state === "degraded") {
    return `${providerDisplayName} service is degraded.`;
  }
  if (state === "reauth_required") {
    return `${providerDisplayName} service requires administrator attention.`;
  }
  return `${providerDisplayName} service is unavailable.`;
}

function createDefaultSessionStore(): GatewayStore {
  const sqlitePath = process.env.GATEWAY_SQLITE_PATH;
  if (sqlitePath) {
    return createSqliteStore({ path: sqlitePath });
  }

  return new InMemorySessionStore();
}

function parseAuthMode(value: string | undefined): GatewayAuthMode | undefined {
  if (!value) {
    return undefined;
  }
  if (value === "dev" || value === "credential") {
    return value;
  }
  throw new Error("GATEWAY_AUTH_MODE must be dev or credential.");
}

function parseModelReasoningEffort(
  value: string | undefined
): CodexProviderOptions["modelReasoningEffort"] | undefined {
  if (!value) {
    return undefined;
  }
  if (
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh"
  ) {
    return value;
  }
  throw new Error(
    "MEDCODE_UPSTREAM_REASONING_EFFORT must be minimal, low, medium, high, or xhigh."
  );
}

function resolveAuthMode(input: {
  configured?: GatewayAuthMode;
  accessToken?: string;
  credentialStore?: CredentialAuthStore;
}): GatewayAuthMode {
  if (input.configured) {
    return input.configured;
  }
  if (input.credentialStore) {
    return "credential";
  }
  return "dev";
}

function validateAuthModeForEnvironment(authMode: GatewayAuthMode, nodeEnv: string | undefined) {
  if (nodeEnv === "production" && authMode === "dev") {
    throw new Error("Dev auth mode is not allowed when NODE_ENV=production.");
  }
}

export function validateRuntimeEnvironment(env: NodeJS.ProcessEnv) {
  if (env.NODE_ENV !== "production") {
    return;
  }

  if (env.GATEWAY_AUTH_MODE !== "credential") {
    throw new Error("Production runtime requires GATEWAY_AUTH_MODE=credential.");
  }
  if (!env.GATEWAY_SQLITE_PATH) {
    throw new Error("Production runtime requires GATEWAY_SQLITE_PATH.");
  }
  if (!env.CODEX_HOME) {
    throw new Error("Production runtime requires CODEX_HOME.");
  }
  if (env.GATEWAY_DEV_ACCESS_TOKEN) {
    throw new Error("Production runtime must not set GATEWAY_DEV_ACCESS_TOKEN.");
  }
}

function isCredentialAuthStore(store: GatewayStore): store is GatewayStore & CredentialAuthStore {
  const candidate = store as Partial<CredentialAuthStore>;
  return (
    typeof candidate.getSubject === "function" &&
    typeof candidate.listSubjects === "function" &&
    typeof candidate.setSubjectState === "function" &&
    typeof candidate.getAccessCredentialByPrefix === "function" &&
    typeof candidate.listAccessCredentials === "function" &&
    typeof candidate.updateAccessCredentialByPrefix === "function" &&
    typeof candidate.revokeAccessCredentialByPrefix === "function" &&
    typeof candidate.setAccessCredentialExpiresAtByPrefix === "function"
  );
}

function isObservationStore(store: GatewayStore): store is GatewayStore & ObservationStore {
  const candidate = store as Partial<ObservationStore>;
  return (
    typeof candidate.insertRequestEvent === "function" &&
    typeof candidate.listRequestEvents === "function" &&
    typeof candidate.reportRequestUsage === "function" &&
    typeof candidate.pruneRequestEvents === "function"
  );
}

function storeKind(store: GatewayStore): "sqlite" | "memory" | "custom" {
  const candidate = store as { kind?: unknown };
  if (candidate.kind === "sqlite") {
    return "sqlite";
  }
  if (store instanceof InMemorySessionStore) {
    return "memory";
  }
  return "custom";
}
