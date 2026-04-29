import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import {
  type ClientMessageEventStore,
  type CredentialAuthStore,
  GatewayError,
  type GatewaySession,
  type GatewayStore,
  type ObservationStore,
  type ProviderAdapter,
  type RateLimitPolicy,
  type Scope,
  type Subject,
  type TokenBudgetLimiter,
  type UpstreamAccount
} from "@codex-gateway/core";
import {
  CodexProviderAdapter,
  type CodexProviderOptions
} from "@codex-gateway/provider-codex";
import {
  createSqliteClientEventsStore,
  createSqliteStore,
  createSqliteTokenBudgetLimiter,
  SqliteGatewayStore
} from "@codex-gateway/store-sqlite";
import {
  CLIENT_MESSAGE_BODY_LIMIT_BYTES,
  parseClientMessageEventRequest
} from "./client-events.js";
import { credentialAuthHook, devAuthHook } from "./http/auth.js";
import { getGatewayContext } from "./http/context.js";
import {
  markFirstByte,
  markGatewayError,
  markSession,
  markTokenUsage,
  recordObservation,
  startObservation
} from "./http/observation.js";
import { rateLimitHook, releaseRateLimit } from "./http/rate-limit.js";
import {
  chatMessagesToPrompt,
  chatMessagesToStrictToolPrompt,
  chatMessagesToStrictToolRepairPrompt,
  createChatCompletionResponse,
  createFinalChatCompletionChunk,
  createInitialChatCompletionChunk,
  hasStrictClientTools,
  openAIErrorPayload,
  openAIUsageFromTokenUsage,
  parseChatCompletionRequest,
  parseStrictToolDecision,
  streamEventToChatCompletionChunk,
  type ChatCompletionRequest,
  type ChatCompletionShape,
  type OpenAIChatToolCall,
  type OpenAIChatUsage,
  type StrictToolDecision
} from "./openai-compat.js";
import {
  InMemoryCredentialRateLimiter,
  type CredentialRateLimiter
} from "./services/rate-limiter.js";
import { InMemorySessionStore } from "./services/session-store.js";
import {
  beginTokenBudget,
  cleanupExpiredTokenReservations,
  estimatePromptTokens,
  finalizeTokenBudget,
  publicRatePolicy,
  publicTokenPolicy,
  publicTokenUsage
} from "./services/token-budget-hook.js";

export type GatewayAuthMode = "dev" | "credential";

export interface GatewayOptions {
  accessToken?: string;
  authMode?: GatewayAuthMode;
  credentialStore?: CredentialAuthStore;
  publicMetadata?: GatewayPublicMetadata;
  provider?: ProviderAdapter;
  sessionStore?: GatewayStore;
  subject?: Subject;
  upstreamAccount?: UpstreamAccount;
  rateLimiter?: CredentialRateLimiter;
  observationStore?: ObservationStore;
  clientEventsStore?: ClientMessageEventStore | null;
  clientEventsRateLimiter?: CredentialRateLimiter;
  clientEventsRatePolicy?: RateLimitPolicy;
  tokenBudgetLimiter?: TokenBudgetLimiter;
  logger?: boolean;
}

export interface GatewayPublicMetadata {
  serviceName?: string;
  providerName?: string;
  providerDisplayName?: string;
  upstreamAccountLabel?: string;
  phase?: string;
}

interface ResolvedGatewayPublicMetadata {
  serviceName: string;
  providerName: string;
  providerDisplayName: string;
  upstreamAccountLabel: string;
  phase: string;
}

interface MessageBody {
  message?: unknown;
}

export function buildGateway(options: GatewayOptions = {}) {
  const app = Fastify({
    logger: options.logger ?? true,
    genReqId: () => `req-${randomUUID()}`
  });
  const accessToken = options.accessToken ?? process.env.GATEWAY_DEV_ACCESS_TOKEN;
  const subject = options.subject ?? defaultSubject();
  const upstreamAccount = options.upstreamAccount ?? defaultUpstreamAccount();
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
  const sessions = options.sessionStore ?? createDefaultSessionStore(app.log);
  const credentialStore =
    options.credentialStore ?? (isCredentialAuthStore(sessions) ? sessions : undefined);
  const publicMetadata = resolvePublicMetadata(options.publicMetadata, process.env, app.log);
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
  const tokenBudgetLimiter =
    options.tokenBudgetLimiter ??
    (sessions instanceof SqliteGatewayStore
      ? createSqliteTokenBudgetLimiter({ db: sessions.database, logger: app.log })
      : undefined);
  const clientEventsStore =
    options.clientEventsStore === undefined
      ? createDefaultClientEventsStore()
      : options.clientEventsStore ?? undefined;
  const clientEventsRateLimiter =
    options.clientEventsRateLimiter ?? new InMemoryCredentialRateLimiter();
  const clientEventsRatePolicy =
    options.clientEventsRatePolicy ?? resolveClientEventsRatePolicy(process.env);
  if (authMode === "dev") {
    sessions.upsertSubject(subject);
  }
  sessions.upsertUpstreamAccount(upstreamAccount);
  const devContext = {
    subject,
    upstreamAccount,
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
    clientEventsStore?.close?.();
  });

  app.addHook("onRequest", async (request, reply) => {
    startObservation(request);
    reply.header("x-request-id", request.id);
    reply.raw.setHeader("x-request-id", request.id);
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
        upstreamAccount
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

  app.addHook("preHandler", async (request) => {
    if (request.routeOptions.config?.public) {
      return;
    }
    await cleanupExpiredTokenReservations(tokenBudgetLimiter, request.log);
  });

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
    const { subject, upstreamAccount, provider, scope, credential } = getGatewayContext(request);
    const health = await provider.health(upstreamAccount);

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
        rate: publicRatePolicy(credential.rate)
      },
      upstream_account: {
        label: publicMetadata.upstreamAccountLabel,
        provider: publicMetadata.providerName,
        state: health.state,
        detail: publicProviderDetail(health.state, publicMetadata.providerDisplayName)
      },
      subscription: {
        id: publicMetadata.upstreamAccountLabel,
        provider: publicMetadata.providerName,
        state: health.state,
        detail: publicProviderDetail(health.state, publicMetadata.providerDisplayName)
      }
    };
  });

  app.get(
    "/gateway/credentials/current",
    {
      config: { skipRateLimit: true }
    },
    async (request) => {
      const { subject, scope, credential } = getGatewayContext(request);
      const tokenPolicy = credential.rate?.token ?? null;
      const tokenUsage =
        tokenPolicy && tokenBudgetLimiter
          ? await tokenBudgetLimiter
              .getCurrentUsage({ subjectId: subject.id, policy: tokenPolicy })
              .then(publicTokenUsage)
              .catch((err) => {
                request.log.warn(
                  { error: err instanceof Error ? err.message : String(err) },
                  "Failed to read token usage for current credential."
                );
                return null;
              })
          : null;

      return {
        valid: true,
        subject: {
          id: subject.id,
          label: subject.label
        },
        credential: {
          prefix: credential.prefix,
          scope,
          expires_at: credential.expiresAt?.toISOString() ?? null,
          rate: publicRatePolicy(credential.rate),
          ...(tokenPolicy ? { token: publicTokenPolicy(tokenPolicy) } : {})
        },
        ...(tokenUsage ? { token_usage: tokenUsage } : {})
      };
    }
  );

  app.post<{ Body: unknown }>(
    "/gateway/client-events/messages",
    {
      bodyLimit: CLIENT_MESSAGE_BODY_LIMIT_BYTES,
      config: {
        public: !clientEventsStore,
        skipRateLimit: true,
        skipObservation: true
      }
    },
    async (request, reply) => {
      if (!clientEventsStore) {
        return sendError(
          request,
          reply,
          new GatewayError({
            code: "service_unavailable",
            message: "Client message event storage is not configured.",
            httpStatus: 503
          })
        );
      }

      const { subject, scope, credential } = getGatewayContext(request);
      if (!credential.id) {
        return sendError(
          request,
          reply,
          new GatewayError({
            code: "service_unavailable",
            message: "Client message events require credential auth.",
            httpStatus: 503
          })
        );
      }

      const permit = clientEventsRateLimiter.acquire({
        credentialId: credential.id,
        policy: clientEventsRatePolicy
      });
      if (!("release" in permit)) {
        return sendError(request, reply, permit.error);
      }

      try {
        const parsed = parseClientMessageEventRequest(request.body);
        if (parsed instanceof GatewayError) {
          return sendError(request, reply, parsed);
        }

        const existing = clientEventsStore.getClientMessageEvent(
          subject.id,
          parsed.eventId
        );
        if (existing) {
          if (
            existing.textSha256 === parsed.textSha256 &&
            existing.sessionId === parsed.sessionId &&
            existing.messageId === parsed.messageId
          ) {
            return {
              ok: true,
              event_id: parsed.eventId,
              duplicate: true,
              received_at: existing.receivedAt.toISOString()
            };
          }

          return sendError(
            request,
            reply,
            new GatewayError({
              code: "idempotency_conflict",
              message: "event_id already exists for this user with different content.",
              httpStatus: 409
            })
          );
        }

        const receivedAt = new Date();
        clientEventsStore.insertClientMessageEvent({
          id: `cme_${randomUUID().replaceAll("-", "")}`,
          eventId: parsed.eventId,
          requestId: request.id,
          credentialId: credential.id,
          subjectId: subject.id,
          scope,
          sessionId: parsed.sessionId,
          messageId: parsed.messageId,
          agent: parsed.agent,
          providerId: parsed.providerId,
          modelId: parsed.modelId,
          engine: parsed.engine,
          text: parsed.text,
          textSha256: parsed.textSha256,
          attachmentsJson: parsed.attachmentsJson,
          appName: parsed.appName,
          appVersion: parsed.appVersion,
          createdAt: parsed.createdAt,
          receivedAt
        });

        reply.code(201);
        return {
          ok: true,
          event_id: parsed.eventId,
          duplicate: false,
          received_at: receivedAt.toISOString()
        };
      } finally {
        permit.release();
      }
    }
  );

  app.get("/v1/models", async () => ({
    object: "list",
    data: [openAIModelObject(openAIModelId, openAIModelLimits)]
  }));

  app.get<{ Params: { id: string } }>("/v1/models/:id", async (request, reply) => {
    if (request.params.id !== openAIModelId) {
      return sendOpenAIError(request, reply, modelNotFoundError(request.params.id));
    }

    return openAIModelObject(openAIModelId, openAIModelLimits);
  });

  app.post<{ Body: unknown }>("/v1/chat/completions", async (request, reply) => {
    const { subject, upstreamAccount, provider, scope } = getGatewayContext(request);
    const parsed = parseChatCompletionRequest(request.body, openAIModelId);
    if (parsed instanceof GatewayError) {
      return sendOpenAIError(request, reply, parsed);
    }
    if (parsed.model !== openAIModelId) {
      return sendOpenAIError(request, reply, modelNotFoundError(parsed.model));
    }

    const session = createStatelessSession(subject.id, upstreamAccount.id);
    markSession(request, session.id);
    const shape = createChatCompletionShape(openAIModelId);
    const strictClientTools = hasStrictClientTools(parsed);
    const prompt = strictClientTools
      ? chatMessagesToStrictToolPrompt(parsed)
      : chatMessagesToPrompt(parsed);
    request.gatewayEstimatedTokens = estimatePromptTokens(
      prompt,
      chatCompletionEstimateExtras(parsed, strictClientTools)
    );
    const tokenBudgetError = await beginTokenBudget(
      request,
      tokenBudgetLimiter,
      request.gatewayEstimatedTokens
    );
    if (tokenBudgetError) {
      return sendOpenAIError(request, reply, tokenBudgetError);
    }

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

        if (strictClientTools) {
          const strictResult = await runStrictClientTools({
            provider,
            upstreamAccount,
            subject,
            scope,
            session,
            request: parsed,
            prompt,
            signal: abort.signal,
            requestId: request.id,
            log: request.log
          });
          if (strictResult instanceof GatewayError) {
            request.gatewayErrorCode = strictResult.code;
            writeOpenAISseData(reply, openAIErrorPayload(strictResult));
            failed = true;
          } else if (strictResult.toolCalls.length > 0) {
            hasToolCalls = true;
            usage = strictResult.usage;
            markOpenAITokenUsage(request, usage);
            for (const toolCall of strictResult.toolCalls) {
              const chunk = streamEventToChatCompletionChunk({
                shape,
                event: openAIToolCallToStreamEvent(toolCall),
                toolCallIndex
              });
              toolCallIndex += 1;
              if (chunk && !writeOpenAISseData(reply, chunk)) {
                abort.abort();
                break;
              }
            }
          } else {
            usage = strictResult.usage;
            markOpenAITokenUsage(request, usage);
            const chunk = streamEventToChatCompletionChunk({
              shape,
              event: { type: "message_delta", text: strictResult.content },
              toolCallIndex
            });
            if (chunk && !writeOpenAISseData(reply, chunk)) {
              abort.abort();
            }
          }
        } else {
          for await (const event of provider.message({
            upstreamAccount,
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
              markTokenUsage(request, event.usage);
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
              if (parsed.toolChoice === "none") {
                continue;
              }
              hasToolCalls = true;
            }
            if (event.type === "message_delta" && hasToolCalls) {
              continue;
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
        }

        if (!closed && !failed) {
          const finishReason = hasToolCalls ? "tool_calls" : "stop";
          writeOpenAISseData(reply, createFinalChatCompletionChunk(shape, finishReason, usage));
          writeOpenAISseDone(reply);
        }
      } finally {
        await finalizeTokenBudget(request, tokenBudgetLimiter);
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

    try {
      if (strictClientTools) {
        const strictResult = await runStrictClientTools({
          provider,
          upstreamAccount,
          subject,
          scope,
          session,
          request: parsed,
          prompt,
          requestId: request.id,
          log: request.log
        });
        if (strictResult instanceof GatewayError) {
          return sendOpenAIError(request, reply, strictResult);
        }
        markFirstByte(request);
        content = strictResult.content;
        toolCalls.push(...strictResult.toolCalls);
        usage = strictResult.usage;
        markOpenAITokenUsage(request, usage);
      } else {
        for await (const event of provider.message({
          upstreamAccount,
          subject,
          scope,
          session,
          message: prompt
        })) {
          if (event.type === "message_delta") {
            markFirstByte(request);
            content += event.text;
          } else if (event.type === "tool_call") {
            if (parsed.toolChoice === "none") {
              continue;
            }
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
            markTokenUsage(request, event.usage);
          }
        }
      }

      return createChatCompletionResponse({
        shape,
        content,
        toolCalls,
        finishReason: toolCalls.length > 0 ? "tool_calls" : "stop",
        usage
      });
    } finally {
      await finalizeTokenBudget(request, tokenBudgetLimiter);
    }
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
    const { subject, upstreamAccount } = getGatewayContext(request);
    const session = sessions.create({
      subjectId: subject.id,
      upstreamAccountId: upstreamAccount.id
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
      const { subject, upstreamAccount, provider, scope } = getGatewayContext(request);
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

      request.gatewayEstimatedTokens = estimatePromptTokens(message);
      const tokenBudgetError = await beginTokenBudget(
        request,
        tokenBudgetLimiter,
        request.gatewayEstimatedTokens
      );
      if (tokenBudgetError) {
        return sendError(request, reply, tokenBudgetError);
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
          upstreamAccount,
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
          if (event.type === "completed") {
            markTokenUsage(request, event.usage);
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
        await finalizeTokenBudget(request, tokenBudgetLimiter);
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

interface StrictClientToolsInput {
  provider: ProviderAdapter;
  upstreamAccount: UpstreamAccount;
  subject: Subject;
  scope: Scope;
  session: GatewaySession;
  request: ChatCompletionRequest;
  prompt: string;
  signal?: AbortSignal;
  requestId?: string;
  log?: StrictClientToolsLogger;
}

interface StrictClientToolsResult {
  content: string;
  toolCalls: OpenAIChatToolCall[];
  usage: OpenAIChatUsage | null;
}

interface StrictClientToolsLogger {
  info: (obj: Record<string, unknown>, msg: string) => void;
  warn: (obj: Record<string, unknown>, msg: string) => void;
}

async function runStrictClientTools(
  input: StrictClientToolsInput
): Promise<StrictClientToolsResult | GatewayError> {
  const first = await collectProviderText({
    provider: input.provider,
    upstreamAccount: input.upstreamAccount,
    subject: input.subject,
    scope: input.scope,
    session: input.session,
    prompt: input.prompt,
    signal: input.signal
  });
  if (first instanceof GatewayError) {
    return first;
  }

  const parsed = parseStrictToolDecision({
    text: first.content,
    tools: input.request.tools ?? [],
    toolChoice: input.request.toolChoice,
    createToolCallId
  });
  if (!(parsed instanceof GatewayError)) {
    return strictDecisionToResult(parsed, first.usage);
  }

  input.log?.warn(
    {
      request_id: input.requestId,
      code: parsed.code,
      validation_error: parsed.message,
      strict_tools_repair: true
    },
    "Strict client-defined tool output failed validation; attempting repair."
  );

  const repairPrompt = chatMessagesToStrictToolRepairPrompt({
    originalPrompt: input.prompt,
    invalidOutput: first.content,
    validationError: parsed.message
  });
  const repaired = await collectProviderText({
    provider: input.provider,
    upstreamAccount: input.upstreamAccount,
    subject: input.subject,
    scope: input.scope,
    session: input.session,
    prompt: repairPrompt,
    signal: input.signal
  });
  if (repaired instanceof GatewayError) {
    return repaired;
  }

  const repairedParsed = parseStrictToolDecision({
    text: repaired.content,
    tools: input.request.tools ?? [],
    toolChoice: input.request.toolChoice,
    createToolCallId
  });
  if (repairedParsed instanceof GatewayError) {
    input.log?.warn(
      {
        request_id: input.requestId,
        code: repairedParsed.code,
        validation_error: repairedParsed.message,
        strict_tools_repair: false
      },
      "Strict client-defined tool output repair failed validation."
    );
    return repairedParsed;
  }

  input.log?.info(
    {
      request_id: input.requestId,
      strict_tools_repaired: true
    },
    "Strict client-defined tool output repaired successfully."
  );

  return strictDecisionToResult(repairedParsed, addOpenAIUsage(first.usage, repaired.usage));
}

async function collectProviderText(input: {
  provider: ProviderAdapter;
  upstreamAccount: UpstreamAccount;
  subject: Subject;
  scope: Scope;
  session: GatewaySession;
  prompt: string;
  signal?: AbortSignal;
}): Promise<{ content: string; usage: OpenAIChatUsage | null } | GatewayError> {
  let content = "";
  let usage: OpenAIChatUsage | null = null;

  for await (const event of input.provider.message({
    upstreamAccount: input.upstreamAccount,
    subject: input.subject,
    scope: input.scope,
    session: input.session,
    message: input.prompt,
    signal: input.signal
  })) {
    if (event.type === "message_delta") {
      content += event.text;
    } else if (event.type === "completed") {
      usage = openAIUsageFromTokenUsage(event.usage);
    } else if (event.type === "error") {
      return streamErrorToGatewayError(event);
    }
  }

  return { content, usage };
}

function strictDecisionToResult(
  decision: StrictToolDecision,
  usage: OpenAIChatUsage | null
): StrictClientToolsResult {
  if (decision.type === "message") {
    return {
      content: decision.content,
      toolCalls: [],
      usage
    };
  }

  return {
    content: "",
    toolCalls: decision.toolCalls,
    usage
  };
}

function createToolCallId(): string {
  return `call_${randomUUID().replaceAll("-", "")}`;
}

function openAIToolCallToStreamEvent(toolCall: OpenAIChatToolCall) {
  let parsedArguments: unknown = {};
  try {
    parsedArguments = JSON.parse(toolCall.function.arguments) as unknown;
  } catch {
    parsedArguments = {};
  }

  return {
    type: "tool_call" as const,
    callId: toolCall.id,
    name: toolCall.function.name,
    arguments: parsedArguments
  };
}

function markOpenAITokenUsage(
  request: FastifyRequest,
  usage: OpenAIChatUsage | null
): void {
  if (!usage) {
    return;
  }

  markTokenUsage(request, {
    promptTokens: usage.prompt_tokens,
    completionTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens,
    ...(usage.prompt_tokens_details?.cached_tokens !== undefined
      ? { cachedPromptTokens: usage.prompt_tokens_details.cached_tokens }
      : {})
  });
}

function addOpenAIUsage(
  first: OpenAIChatUsage | null,
  second: OpenAIChatUsage | null
): OpenAIChatUsage | null {
  if (!first) {
    return second;
  }
  if (!second) {
    return first;
  }
  const cachedTokens =
    (first.prompt_tokens_details?.cached_tokens ?? 0) +
    (second.prompt_tokens_details?.cached_tokens ?? 0);
  return {
    prompt_tokens: first.prompt_tokens + second.prompt_tokens,
    completion_tokens: first.completion_tokens + second.completion_tokens,
    total_tokens: first.total_tokens + second.total_tokens,
    ...(cachedTokens > 0 ? { prompt_tokens_details: { cached_tokens: cachedTokens } } : {})
  };
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

function chatCompletionEstimateExtras(
  request: ChatCompletionRequest,
  strictClientTools: boolean
): string {
  if (strictClientTools) {
    return "";
  }
  return JSON.stringify({
    tools: request.tools ?? null,
    tool_choice: request.toolChoice
  });
}

function createStatelessSession(subjectId: string, upstreamAccountId: string): GatewaySession {
  const now = new Date();
  return {
    id: `sess_stateless_${randomUUID().replaceAll("-", "")}`,
    subjectId,
    upstreamAccountId,
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

function modelNotFoundError(model: string): GatewayError {
  return new GatewayError({
    code: "model_not_found",
    message: `Model '${model}' does not exist.`,
    httpStatus: 404
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

function defaultUpstreamAccount(): UpstreamAccount {
  return {
    id: "sub_openai_codex_dev",
    provider: "openai-codex",
    label: "OpenAI Codex dev upstream account",
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
    upstream_account_label: publicMetadata.upstreamAccountLabel,
    subscription_id: publicMetadata.upstreamAccountLabel,
    provider_session_ref: session.providerSessionRef,
    title: session.title,
    state: session.state,
    created_at: session.createdAt.toISOString(),
    updated_at: session.updatedAt.toISOString()
  };
}

function resolvePublicMetadata(
  input: GatewayPublicMetadata | undefined,
  env: NodeJS.ProcessEnv,
  logger?: { warn: (obj: Record<string, unknown>, msg: string) => void }
): ResolvedGatewayPublicMetadata {
  const providerDisplayName =
    input?.providerDisplayName ?? env.GATEWAY_PUBLIC_PROVIDER_DISPLAY_NAME ?? "MedCode";
  const providerName = input?.providerName ?? env.GATEWAY_PUBLIC_PROVIDER_NAME ?? "medcode";
  const upstreamAccountLabel =
    input?.upstreamAccountLabel ??
    env.GATEWAY_PUBLIC_UPSTREAM_ACCOUNT_LABEL ??
    env.GATEWAY_PUBLIC_SUBSCRIPTION_ID ??
    providerName;

  if (
    !input?.upstreamAccountLabel &&
    !env.GATEWAY_PUBLIC_UPSTREAM_ACCOUNT_LABEL &&
    env.GATEWAY_PUBLIC_SUBSCRIPTION_ID
  ) {
    logger?.warn(
      {
        deprecated_env: "GATEWAY_PUBLIC_SUBSCRIPTION_ID",
        replacement_env: "GATEWAY_PUBLIC_UPSTREAM_ACCOUNT_LABEL"
      },
      "GATEWAY_PUBLIC_SUBSCRIPTION_ID is deprecated; use GATEWAY_PUBLIC_UPSTREAM_ACCOUNT_LABEL."
    );
  }

  return {
    serviceName: input?.serviceName ?? env.GATEWAY_PUBLIC_SERVICE_NAME ?? "medcode",
    providerName,
    providerDisplayName,
    upstreamAccountLabel,
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

function createDefaultSessionStore(logger?: { info: (message: string) => void }): GatewayStore {
  const sqlitePath = process.env.GATEWAY_SQLITE_PATH;
  if (sqlitePath) {
    return createSqliteStore({ path: sqlitePath, logger });
  }

  return new InMemorySessionStore();
}

function createDefaultClientEventsStore(): ClientMessageEventStore | undefined {
  const sqlitePath = process.env.GATEWAY_CLIENT_EVENTS_SQLITE_PATH;
  if (!sqlitePath) {
    return undefined;
  }

  return createSqliteClientEventsStore({ path: sqlitePath });
}

function resolveClientEventsRatePolicy(env: NodeJS.ProcessEnv): RateLimitPolicy {
  return {
    requestsPerMinute: parsePositiveIntegerEnv(
      env.GATEWAY_CLIENT_EVENTS_RPM,
      60,
      "GATEWAY_CLIENT_EVENTS_RPM"
    ),
    requestsPerDay: parsePositiveIntegerEnv(
      env.GATEWAY_CLIENT_EVENTS_RPD,
      2_000,
      "GATEWAY_CLIENT_EVENTS_RPD"
    ),
    concurrentRequests: null
  };
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
