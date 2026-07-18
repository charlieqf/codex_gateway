import { randomUUID } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import {
  type AdminAuditStore,
  type BillingAdminStore,
  type BillingAdminTokenStore,
  type ClientDiagnosticEventRecord,
  type ClientMessageEventStore,
  credentialAllowsPublicModel,
  type CredentialAuthStore,
  decryptSecret,
  type Entitlement,
  extractAccessCredentialPrefix,
  extractUnifiedClientKeyPrefix,
  GatewayError,
  type LimitRejection,
  publicFeaturePolicy,
  type GatewaySession,
  type GatewayStore,
  type ObservationStore,
  mergeEntitlementTokenPolicy,
  type PlanEntitlementStore,
  type ProviderAdapter,
  type ProviderErrorDiagnostic,
  type PublicModelAliasGroup,
  type RateLimitPolicy,
  type ResearchStore,
  type ResearchWorkerStore,
  type Scope,
  type StreamEvent,
  type Subject,
  type SubjectStore,
  type TokenBudgetLimiter,
  type UnifiedClientKeyRecord,
  type UnifiedClientKeyStore,
  type UpstreamAccount,
  verifyAccessCredentialToken,
  verifyUnifiedClientKeyToken
} from "@codex-gateway/core";
import {
  cleanupStaleCodexRuntimeStateDirs,
  CodexProviderAdapter,
  type CodexProviderOptions
} from "@codex-gateway/provider-codex";
import { probeResearchStorageAdmission } from "@codex-gateway/research-agent";
import {
  buildQuotaDashboardData,
  buildRealtimeTokenUsageData,
  createResearchSqliteStore,
  createSqliteClientEventsStore,
  createSqliteStore,
  createSqliteTokenBudgetLimiter,
  renderRealtimeTokenUsagePage,
  renderQuotaDashboardPage,
  SqliteGatewayStore
} from "@codex-gateway/store-sqlite";
import {
  CLIENT_DIAGNOSTIC_BODY_LIMIT_BYTES,
  CLIENT_MESSAGE_BODY_LIMIT_BYTES,
  type ParsedClientDiagnosticEventRequest,
  type ParsedClientMessageEventRequest,
  parseClientDiagnosticEventRequest,
  parseClientMessageEventRequest
} from "./client-events.js";
import {
  adminMessagesSecurityHeaders,
  authenticateAdminMessagesRequest,
  buildAdminClientMessagesPayload,
  renderAdminClientMessagesPage,
  resolveAdminMessagesAccess,
  sendAdminMessagesUnauthorized,
  sendAdminMessagesUnavailable,
  type AdminMessagesAuthMode,
  type AdminClientMessagesQuery
} from "./admin-client-messages.js";
import {
  registerBillingAdminRoutes,
  resolveBillingAdminAccess,
  resolveBillingAdminTokenMode,
  type BillingAdminTokenMode
} from "./billing-admin.js";
import { registerResearchRoutes } from "./research-routes.js";
import {
  resolveUpstreamV2Client,
  type UpstreamV2Client
} from "./upstream-v2-client.js";
import { credentialAuthHook, devAuthHook } from "./http/auth.js";
import {
  getGatewayContext,
  researchRouteConfig,
  type GatewayRequestContext
} from "./http/context.js";
import {
  applyGatewayErrorHeaders,
  gatewayErrorMetadata,
  researchErrorPayload,
  type GatewayErrorResponseContext
} from "./http/error-response.js";
import {
  markClientAborted,
  markFirstByte,
  markGatewayError,
  markRateLimitOrigin,
  markRateLimitRejection,
  markSession,
  markTokenUsage,
  recordObservation,
  startObservation
} from "./http/observation.js";
import { rateLimitHook, releaseRateLimit } from "./http/rate-limit.js";
import { setupSseResponse, type SseHandle } from "./http/sse.js";
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
import {
  createResponsesFailedEvent,
  createResponsesResult,
  createResponsesStreamStart,
  parseResponsesRequest,
  type ResponsesSseEvent
} from "./responses-compat.js";
import {
  buildImageGenerationResponse,
  finalizeImageGenerationResult,
  GeminiImageGenerationProvider,
  isImageBillingLimitError,
  maxPromptCharsFromEnv,
  OpenAIImageGenerationProvider,
  parseImageGenerationRequest,
  parseImageModelMap,
  resolveImageUpstreamModel,
  XAIImageGenerationProvider,
  type ImageGenerationRequest,
  type ImageGenerationProvider
} from "./image-generation.js";
import {
  attachProviderStreamSummary,
  combineProviderStreamSummaries,
  collectProviderMessage,
  providerCompletionError,
  providerStreamSummaryFromError,
  ProviderStreamSummaryCollector,
  streamErrorToGatewayError,
  type CollectedProviderMessage,
  type ProviderStreamAttemptContext,
  type ProviderStreamSummary,
  type ProviderToolCall
} from "./services/provider-stream.js";
import { InMemorySessionStore } from "./services/session-store.js";
import {
  accountFromPoolConfig,
  applyStartupAuthState,
  readUpstreamAccountPoolConfigFile,
  UpstreamAccountRouter,
  type UpstreamAccountCooldownConfig,
  type UpstreamAccountConfigLogger,
  type UpstreamImageLease,
  type UpstreamAccountLease,
  type UpstreamAccountOutcome,
  type ImageProviderOutcome,
  type ParsedUpstreamAccountConfig,
  type UpstreamAccountRuntimeInput,
  type UpstreamAccountSelection,
  type UpstreamSoftAffinity
} from "./services/upstream-account-router.js";
import {
  beginTokenBudget,
  cleanupExpiredTokenReservations,
  estimatePromptTokens,
  PROMPT_TOKEN_ESTIMATE_METHOD,
  finalizeTokenBudget,
  publicRatePolicy,
  publicTokenPolicy,
  publicTokenUsage
} from "./services/token-budget-hook.js";
import {
  createChatRuntimeDispatcher,
  publicModelPoolAffinityKey,
  type ChatRuntimeContext
} from "./services/chat-runtime-dispatcher.js";
import {
  ActiveRequestRegistry,
  type ActiveRequestHandle
} from "./services/active-request-registry.js";
import {
  createChatRequestDeadline,
  parseChatRequestTimeoutPolicy,
  resolveChatRequestTimeoutMs
} from "./services/chat-request-deadline.js";
import {
  assessToolLoopShadow,
  parseToolLoopShadowPolicy,
  toolLoopGuardAssessed,
  toolLoopGuardAssessmentFailed,
  toolLoopGuardNotAssessed
} from "./services/tool-loop-shadow.js";
import { resolveEntitlementAccessForChat } from "./services/entitlement-access.js";
import { OpenAICompatibleProviderAdapter } from "./services/openai-compatible-provider.js";
import {
  modelNotFoundError,
  openAIModelObject,
  publicModelPoolMemberAdapterKey,
  resolvePublicModelRegistry,
  type OpenAICompatibleRuntimeKind,
  type PublicModelConfig,
  type PublicModelPoolMemberConfig,
  type PublicModelRegistry
} from "./services/public-model-registry.js";

export type GatewayAuthMode = "dev" | "credential";

export interface GatewayOptions {
  accessToken?: string;
  authMode?: GatewayAuthMode;
  credentialStore?: CredentialAuthStore;
  unifiedClientKeyStore?: UnifiedClientKeyStore;
  adminAuditStore?: AdminAuditStore;
  publicMetadata?: GatewayPublicMetadata;
  provider?: ProviderAdapter;
  upstreamAccounts?: UpstreamAccountRuntimeInput[];
  sessionStore?: GatewayStore;
  subject?: Subject;
  upstreamAccount?: UpstreamAccount;
  rateLimiter?: CredentialRateLimiter;
  observationStore?: ObservationStore;
  clientEventsStore?: ClientMessageEventStore | null;
  clientEventsRateLimiter?: CredentialRateLimiter;
  clientEventsRatePolicy?: RateLimitPolicy;
  adminMessagesToken?: string;
  adminMessagesAuthMode?: AdminMessagesAuthMode;
  billingAdminToken?: string;
  billingAdminNextToken?: string;
  billingAdminTokenMode?: BillingAdminTokenMode;
  billingAdminTokenStore?: BillingAdminTokenStore;
  billingAdminStore?: BillingAdminStore;
  billingAdminRateLimiter?: CredentialRateLimiter;
  billingAdminRatePolicy?: RateLimitPolicy;
  researchRateLimiter?: CredentialRateLimiter;
  researchReadRatePolicy?: RateLimitPolicy;
  researchMutationRatePolicy?: RateLimitPolicy;
  researchWorkerHealthStore?: Pick<
    ResearchWorkerStore,
    "listWorkerHeartbeats"
  >;
  researchAcceptWhenWorkerUnavailable?: boolean;
  researchWorkerStaleAfterSeconds?: number;
  researchArtifactRoot?: string;
  researchMaximumArtifactBytes?: number;
  researchAdmissionGuard?: (now: Date) => Promise<GatewayError | null>;
  upstreamV2Client?: UpstreamV2Client | null;
  tokenBudgetLimiter?: TokenBudgetLimiter;
  planEntitlementStore?: PlanEntitlementStore;
  researchStore?: ResearchStore | null;
  imageGenerationProvider?: ImageGenerationProvider | null;
  imageGenerationBillingFallbackProvider?: ImageGenerationProvider | null;
  imageGenerationBillingFallbackModel?: string;
  imageGenerationBillingFallbacks?: ImageGenerationBillingFallbackInput[];
  activeRequestRegistry?: ActiveRequestRegistry;
  now?: () => Date;
  logger?: boolean;
}

export interface ImageGenerationBillingFallbackInput {
  accountId?: string;
  provider: ImageGenerationProvider;
  upstreamModel?: string;
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

interface ResolvedUpstreamAccountPool {
  runtimes: UpstreamAccountRuntimeInput[];
  softAffinity: UpstreamSoftAffinity;
  cooldown: UpstreamAccountCooldownConfig;
  accountPoolConfigured: boolean;
}

type PublicModelPoolRouters = Map<string, UpstreamAccountRouter>;
type OpenAICompatibleAdapterMap = Map<string, ProviderAdapter>;

interface OpenAICompatibleAdapterTarget {
  id: string;
  publicModelId: string;
  runtime: OpenAICompatibleRuntimeKind;
  upstreamModel: string;
  reasoning?: Record<string, unknown>;
}

const maxStatelessAttempts = 2;
const defaultImageBillingFallbackModel = "gpt-image-1.5";
const defaultXAIImageBillingFallbackModel = "grok-imagine-image-quality";
const defaultGeminiImageBillingFallbackModel = "gemini-3.1-flash-image";
const imageBillingFallbackAccountId = "image-billing-fallback";

interface ImageGenerationBillingFallback {
  accountId: string;
  provider: ImageGenerationProvider;
  upstreamModel: string;
}

interface ChatCompletionExecutionOptions {
  captureErrors?: boolean;
  clientSessionId?: string | null;
  signal?: AbortSignal;
}

interface ChatCompletionExecutionFailure {
  __chatCompletionExecutionFailure: true;
  error: GatewayError;
}

export function buildGateway(options: GatewayOptions = {}) {
  const app = Fastify({
    logger: options.logger ?? true,
    genReqId: () => `req-${randomUUID()}`
  });
  const accessToken = options.accessToken ?? process.env.GATEWAY_DEV_ACCESS_TOKEN;
  const clock = options.now ?? (() => new Date());
  const activeRequestRegistry =
    options.activeRequestRegistry ??
    new ActiveRequestRegistry({
      now: clock,
      snapshotPath: process.env.GATEWAY_OPS_RUNTIME_SNAPSHOT_PATH,
      onSnapshotWriteError: (error) =>
        app.log.warn(
          { error: error instanceof Error ? error.message : String(error) },
          "Failed to publish the operations runtime snapshot."
        )
    });
  const chatRequestTimeoutPolicy = parseChatRequestTimeoutPolicy(process.env, (message) =>
    app.log.warn(message)
  );
  const nativeToolForceRequiredMode = parseNativeToolForceRequiredMode(
    process.env.MEDCODE_NATIVE_TOOL_FORCE_REQUIRED_MODE,
    (message) => app.log.warn(message)
  );
  const toolLoopShadowPolicy = parseToolLoopShadowPolicy(process.env, (message) =>
    app.log.warn(message)
  );
  const subject = options.subject ?? defaultSubject();
  const sessions = options.sessionStore ?? createDefaultSessionStore(app.log);
  const upstreamPool = resolveUpstreamAccountPool(options, process.env, sessions, app.log);
  const upstreamRouter = new UpstreamAccountRouter(upstreamPool.runtimes, {
    softAffinity: upstreamPool.softAffinity,
    cooldown: upstreamPool.cooldown,
    now: clock,
    onAccountUpdated: (account) => persistUpstreamAccountRuntimeState(sessions, account, app.log)
  });
  const defaultUpstream = upstreamRouter.defaultSelection();
  const upstreamAccount = defaultUpstream.upstreamAccount;
  const provider = defaultUpstream.provider;
  const credentialStore =
    options.credentialStore ?? (isCredentialAuthStore(sessions) ? sessions : undefined);
  const unifiedClientKeyStore =
    options.unifiedClientKeyStore ?? (isUnifiedClientKeyStore(sessions) ? sessions : undefined);
  const adminAuditStore =
    options.adminAuditStore ?? (isAdminAuditStore(sessions) ? sessions : undefined);
  const publicMetadata = resolvePublicMetadata(options.publicMetadata, process.env, app.log);
  const publicGatewayBaseUrl = normalizeBaseUrl(process.env.GATEWAY_PUBLIC_BASE_URL);
  const publicModelRegistry = resolvePublicModelRegistry(process.env, app.log);
  const publicModelAliasGroups = publicModelRegistry.models.map((model) => ({
    id: model.id,
    aliases: model.aliases
  }));
  const nativeSessionPublicModel = resolveNativeSessionPublicModel(
    publicModelRegistry,
    process.env
  );
  const openRouterAdapters = createOpenRouterAdapters(publicModelRegistry.models, process.env, app.log);
  const qianfanAdapters = createQianfanAdapters(publicModelRegistry.models, process.env, app.log);
  const aliyunAdapters = createAliyunAdapters(publicModelRegistry.models, process.env, app.log);
  const tencentAdapters = createTencentAdapters(publicModelRegistry.models, process.env, app.log);
  const publicModelPoolRouters = createPublicModelPoolRouters(
    publicModelRegistry.models,
    {
      openrouter: openRouterAdapters,
      qianfan: qianfanAdapters,
      aliyun: aliyunAdapters,
      tencent: tencentAdapters
    },
    clock
  );
  const chatRuntimeDispatcher = createChatRuntimeDispatcher({
    codexRouter: upstreamRouter,
    openRouterAdapterForModel: (model) => openRouterAdapters.get(model.id) ?? null,
    qianfanAdapterForModel: (model) => qianfanAdapters.get(model.id) ?? null,
    aliyunAdapterForModel: (model) => aliyunAdapters.get(model.id) ?? null,
    tencentAdapterForModel: (model) => tencentAdapters.get(model.id) ?? null,
    poolRouterForModel: (model) => publicModelPoolRouters.get(model.id) ?? null
  });
  const openRouterAvailable = openRouterAdapters.size > 0;
  const qianfanAvailable = qianfanAdapters.size > 0;
  const aliyunAvailable = aliyunAdapters.size > 0;
  const tencentAvailable = tencentAdapters.size > 0;
  const publicModelAvailability = {
    openRouterAvailable,
    qianfanAvailable,
    aliyunAvailable,
    tencentAvailable,
    poolMemberAdapterKeys: poolMemberAdapterKeys({
      openrouter: openRouterAdapters,
      qianfan: qianfanAdapters,
      aliyun: aliyunAdapters,
      tencent: tencentAdapters
    })
  };
  const configuredAuthMode = options.authMode ?? parseAuthMode(process.env.GATEWAY_AUTH_MODE);
  const authMode = resolveAuthMode({
    configured: configuredAuthMode,
    accessToken,
    credentialStore
  });
  validateAuthModeForEnvironment(authMode, process.env.NODE_ENV);
  const rateLimiter = options.rateLimiter ?? new InMemoryCredentialRateLimiter({ now: clock });
  const observationStore =
    options.observationStore ?? (isObservationStore(sessions) ? sessions : undefined);
  const tokenBudgetLimiter =
    options.tokenBudgetLimiter ??
    (sessions instanceof SqliteGatewayStore
      ? createSqliteTokenBudgetLimiter({ db: sessions.database, logger: app.log })
      : undefined);
  const planEntitlementStore =
    options.planEntitlementStore ??
    (isPlanEntitlementStore(sessions) ? sessions : undefined);
  const defaultResearchRuntime =
    options.researchStore === undefined
      ? createDefaultResearchRuntime(process.env, app.log)
      : null;
  const researchStore =
    options.researchStore === undefined
      ? defaultResearchRuntime?.store
      : options.researchStore ?? undefined;
  const researchRateLimiter =
    options.researchRateLimiter ??
    new InMemoryCredentialRateLimiter({ now: clock });
  const researchReadRatePolicy =
    options.researchReadRatePolicy ??
    defaultResearchRuntime?.readRatePolicy ??
    researchControlRatePolicy(120);
  const researchMutationRatePolicy =
    options.researchMutationRatePolicy ??
    defaultResearchRuntime?.mutationRatePolicy ??
    researchControlRatePolicy(30);
  const researchWorkerHealthStore =
    options.researchWorkerHealthStore ??
    defaultResearchRuntime?.workerHealthStore ??
    (isResearchWorkerHealthStore(researchStore)
      ? researchStore
      : undefined);
  const researchAcceptWhenWorkerUnavailable =
    options.researchAcceptWhenWorkerUnavailable ??
    defaultResearchRuntime?.acceptWhenWorkerUnavailable ??
    false;
  const researchWorkerStaleAfterSeconds =
    options.researchWorkerStaleAfterSeconds ??
    defaultResearchRuntime?.workerStaleAfterSeconds ??
    45;
  const researchArtifactRoot =
    options.researchArtifactRoot ?? defaultResearchRuntime?.artifactRoot;
  const researchMaximumArtifactBytes =
    options.researchMaximumArtifactBytes ??
    defaultResearchRuntime?.maximumArtifactBytes;
  const researchAdmissionGuard =
    options.researchAdmissionGuard ?? defaultResearchRuntime?.admissionGuard;
  const imageGenerationProvider =
    options.imageGenerationProvider === undefined
      ? upstreamRouter.hasImageBindingDeclared()
        ? undefined
        : createDefaultImageGenerationProvider(process.env)
      : options.imageGenerationProvider ?? undefined;
  const imageGenerationBillingFallbacks = resolveImageGenerationBillingFallbacks(
    options,
    process.env,
    app.log
  );
  const accountPoolImageBindingDeclared = upstreamRouter.hasImageBindingDeclared();
  const imageModelMap = parseImageModelMap(process.env.MEDCODE_IMAGE_MODEL_MAP_JSON);
  const imageMaxPromptChars = maxPromptCharsFromEnv(process.env.MEDCODE_IMAGE_MAX_PROMPT_CHARS);
  const imageRequestTimeoutMs = parsePositiveIntegerEnv(
    process.env.MEDCODE_IMAGE_REQUEST_TIMEOUT_MS,
    180_000,
    "MEDCODE_IMAGE_REQUEST_TIMEOUT_MS"
  );
  const requireEntitlement = process.env.GATEWAY_REQUIRE_ENTITLEMENT === "1";
  const clientEventsStore =
    options.clientEventsStore === undefined
      ? createDefaultClientEventsStore()
      : options.clientEventsStore ?? undefined;
  const clientEventsRateLimiter =
    options.clientEventsRateLimiter ?? new InMemoryCredentialRateLimiter({ now: clock });
  const clientEventsRatePolicy =
    options.clientEventsRatePolicy ?? resolveClientEventsRatePolicy(process.env);
  const clientEventsRateLimitLogState = new Map<
    string,
    { nextLogAtMs: number; suppressed: number }
  >();
  const adminMessagesAccess = resolveAdminMessagesAccess({
    token: options.adminMessagesToken ?? process.env.GATEWAY_ADMIN_MESSAGES_TOKEN,
    authMode: options.adminMessagesAuthMode ?? process.env.GATEWAY_ADMIN_MESSAGES_AUTH
  });
  const billingAdminStore =
    options.billingAdminStore ?? (isBillingAdminStore(sessions) ? sessions : undefined);
  const billingAdminTokenStore =
    options.billingAdminTokenStore ?? (isBillingAdminTokenStore(sessions) ? sessions : undefined);
  const billingAdminAccess = resolveBillingAdminAccess({
    token: options.billingAdminToken ?? process.env.GATEWAY_BILLING_ADMIN_TOKEN,
    nextToken: options.billingAdminNextToken ?? process.env.GATEWAY_BILLING_ADMIN_TOKEN_NEXT
  });
  const billingAdminTokenMode = resolveBillingAdminTokenMode(
    options.billingAdminTokenMode ?? process.env.GATEWAY_BILLING_ADMIN_TOKEN_MODE
  );
  const billingAdminRateLimiter =
    options.billingAdminRateLimiter ?? new InMemoryCredentialRateLimiter({ now: clock });
  const billingAdminRatePolicy =
    options.billingAdminRatePolicy ?? resolveBillingAdminRatePolicy(process.env);
  const upstreamV2Client =
    options.upstreamV2Client === undefined
      ? resolveUpstreamV2Client(process.env)
      : options.upstreamV2Client ?? null;
  assertUpstreamPoolAvailable(upstreamRouter, process.env);
  if (authMode === "dev") {
    sessions.upsertSubject(subject);
  }
  for (const runtime of upstreamRouter.listAccounts()) {
    sessions.upsertUpstreamAccount(runtime.upstreamAccount);
  }
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
      rate: null,
      allowedPublicModels: null
    }
  };

  app.addHook("onClose", async () => {
    sessions.close?.();
    clientEventsStore?.close?.();
    researchStore?.close?.();
  });

  app.addHook("onRequest", async (request, reply) => {
    startObservation(request);
    reply.header("x-request-id", request.id);
    reply.raw.setHeader("x-request-id", request.id);
    const recordClientAbort = () => {
      markClientAborted(request);
      releaseRateLimit(request);
      recordObservation(request, observationStore, 499);
    };
    request.raw.once("aborted", recordClientAbort);
    reply.raw.once("close", () => {
      request.raw.off("aborted", recordClientAbort);
      if (!reply.raw.writableEnded) {
        recordClientAbort();
      }
    });
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
        unifiedClientKeyStore,
        provider,
        upstreamAccount,
        now: clock
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

  app.addHook("preHandler", async (request) => {
    if (!request.routeOptions.config?.public) {
      applyClientTurnHeaders(request);
    }
  });

  app.addHook("preHandler", async (request, reply) =>
    rateLimitHook(request, reply, rateLimiter)
  );

  app.addHook("preHandler", async (request) => {
    if (request.routeOptions.config?.public) {
      return;
    }
    await cleanupExpiredTokenReservations(tokenBudgetLimiter, request.log, clock());
  });

  app.addHook("onResponse", async (request, reply) => {
    releaseRateLimit(request);
    recordObservation(request, observationStore, reply.statusCode);
  });

  if (researchStore) {
    app.get<{
      Params: { model: string };
      Querystring: {
        maximum_prompt_tokens_per_call?: string;
        maximum_output_tokens_per_call?: string;
        calls_per_run?: string;
        maximum_tokens_per_run?: string;
      };
    }>(
      "/gateway/research/v1/worker/llm-readiness/:model",
      { config: researchRouteConfig },
      async (request, reply) => {
        let requirements: ResearchLlmReadinessRequirements;
        try {
          requirements = parseResearchLlmReadinessRequirements(
            request.query
          );
        } catch (error) {
          return sendOpenAIError(
            request,
            reply,
            error instanceof GatewayError
              ? error
              : researchReadinessInvalidRequest(
                  "Research LLM readiness requirements are invalid."
                )
          );
        }
        const publicModel = publicModelRegistry.get(request.params.model);
        if (
          !publicModel ||
          !publicModelRegistry.isAvailable(
            publicModel,
            publicModelAvailability
          )
        ) {
          return sendOpenAIError(
            request,
            reply,
            modelNotFoundError(request.params.model)
          );
        }
        const { subject, scope, credential } = getGatewayContext(request);
        if (
          credential.allowedPublicModels === null ||
          credential.allowedPublicModels.length !== 1 ||
          credential.allowedPublicModels[0] !== publicModel.id
        ) {
          return sendOpenAIError(
            request,
            reply,
            new GatewayError({
              code: "model_not_allowed_for_credential",
              message: "Credential is not allowed to use this model.",
              httpStatus: 403
            })
          );
        }
        const entitlement = resolveEntitlementAccessForChat({
          context: { subject, scope, credential },
          entitlementStore: planEntitlementStore,
          requireEntitlement: true,
          now: clock()
        });
        if (entitlement instanceof GatewayError) {
          return sendOpenAIError(request, reply, entitlement);
        }
        const serviceCapabilities =
          entitlement.decision?.status === "active"
            ? entitlement.decision.entitlement.featurePolicySnapshot
                .capabilities
            : [];
        if (
          serviceCapabilities.length !== 1 ||
          serviceCapabilities[0] !== "chat"
        ) {
          return sendOpenAIError(
            request,
            reply,
            new GatewayError({
              code: "plan_capability_required",
              message:
                "Research Worker credential requires a chat-only entitlement.",
              httpStatus: 403
            })
          );
        }
        const serviceRate = credential.rate;
        const serviceTokenPolicy = entitlement.tokenPolicy;
        if (
          !serviceRate ||
          serviceRate.requestsPerMinute < requirements.callsPerRun ||
          serviceRate.requestsPerDay === null ||
          serviceRate.requestsPerDay < requirements.callsPerRun ||
          serviceRate.concurrentRequests === null ||
          serviceRate.concurrentRequests <= 0 ||
          !serviceTokenPolicy ||
          serviceTokenPolicy.tokensPerMinute === null ||
          serviceTokenPolicy.tokensPerMinute <
            requirements.maximumTokensPerRun ||
          serviceTokenPolicy.tokensPerDay === null ||
          serviceTokenPolicy.tokensPerDay <
            requirements.maximumTokensPerRun ||
          serviceTokenPolicy.tokensPerMonth === null ||
          serviceTokenPolicy.tokensPerMonth <
            requirements.maximumTokensPerRun ||
          serviceTokenPolicy.maxPromptTokensPerRequest === null ||
          serviceTokenPolicy.maxPromptTokensPerRequest <
            requirements.maximumPromptTokensPerCall ||
          serviceTokenPolicy.maxTotalTokensPerRequest === null ||
          serviceTokenPolicy.maxTotalTokensPerRequest <
            requirements.maximumPromptTokensPerCall +
              requirements.maximumOutputTokensPerCall ||
          serviceTokenPolicy.reserveTokensPerRequest <
            requirements.maximumOutputTokensPerCall ||
          serviceTokenPolicy.missingUsageCharge !== "reserve"
        ) {
          return sendOpenAIError(
            request,
            reply,
            new GatewayError({
              code: "plan_capability_required",
              message:
                "Research Worker credential requires bounded request and token policies.",
              httpStatus: 403
            })
          );
        }
        return {
          schema_version: "research_llm_readiness.v1",
          request_id: request.id,
          model: publicModel.id,
          authorized: true
        };
      }
    );
    registerResearchRoutes(app, {
      store: researchStore,
      planEntitlementStore,
      rateLimiter: researchRateLimiter,
      readRatePolicy: researchReadRatePolicy,
      mutationRatePolicy: researchMutationRatePolicy,
      workerHealthStore: researchWorkerHealthStore,
      acceptWhenWorkerUnavailable: researchAcceptWhenWorkerUnavailable,
      workerStaleAfterSeconds: researchWorkerStaleAfterSeconds,
      artifactRoot: researchArtifactRoot,
      maximumArtifactBytes: researchMaximumArtifactBytes,
      admissionGuard: researchAdmissionGuard,
      now: clock
    });
  }

  app.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith("/gateway/research/v1/")) {
      const artifactRoute = request.url.startsWith(
        "/gateway/research/v1/artifacts/"
      );
      const error = new GatewayError({
        code: artifactRoute ? "artifact_not_found" : "run_not_found",
        message: artifactRoute
          ? "Research artifact was not found."
          : "Research route was not found.",
        httpStatus: 404
      });
      markGatewayError(request, error);
      reply.code(404);
      return researchErrorPayload(error, { requestId: request.id });
    }
    reply.code(404);
    return {
      message: `Route ${request.method}:${request.url} not found`,
      error: "Not Found",
      statusCode: 404
    };
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

  app.get("/gateway/status", async (request, reply) => {
    const selected = upstreamRouter.selectForStatus();
    if (selected instanceof GatewayError) {
      return sendError(request, reply, selected);
    }
    applyUpstreamSelection(request, selected);
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
      const access = planEntitlementStore?.entitlementAccessForSubject(subject.id);
      const activeEntitlement = access?.status === "active" ? access.entitlement : null;
      const activePlan = access?.status === "active" ? access.plan : null;
      const visibleEntitlement =
        activeEntitlement ?? (access && "entitlement" in access ? access.entitlement : null);
      const visiblePlan =
        activePlan ??
        (visibleEntitlement ? planEntitlementStore?.getPlan(visibleEntitlement.planId) ?? null : null);
      const tokenPolicy = activeEntitlement
        ? mergeEntitlementTokenPolicy(activeEntitlement.policySnapshot, credential.rate?.token ?? null)
        : access?.status === undefined || access.status === "legacy"
          ? credential.rate?.token ?? null
          : null;
      const tokenUsage =
        tokenPolicy && tokenBudgetLimiter
          ? await tokenBudgetLimiter
              .getCurrentUsage({
                subjectId: subject.id,
                entitlementId: activeEntitlement?.id ?? null,
                entitlementPeriodStart: activeEntitlement?.periodStart ?? null,
                entitlementPeriodEnd: activeEntitlement?.periodEnd ?? null,
                policy: tokenPolicy
              })
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
          ...(credential.allowedPublicModels
            ? { allowed_public_models: credential.allowedPublicModels }
            : {}),
          ...(tokenPolicy ? { token: publicTokenPolicy(tokenPolicy) } : {})
        },
        ...(visibleEntitlement
          ? {
              ...(visiblePlan
                ? {
                    plan: {
                      display_name: visiblePlan.displayName,
                      scope_allowlist: visibleEntitlement.scopeAllowlist
                    }
                  }
                : {}),
              entitlement: {
                period_kind: visibleEntitlement.periodKind,
                period_start: visibleEntitlement.periodStart.toISOString(),
                period_end: visibleEntitlement.periodEnd?.toISOString() ?? null,
                state: visibleEntitlement.state,
                feature_policy: publicFeaturePolicy(visibleEntitlement.featurePolicySnapshot),
                ...(access?.status === "inactive" ? { reason: access.reason } : {})
              }
            }
          : {}),
        ...(tokenUsage ? { token_usage: tokenUsage } : {})
      };
    }
  );

  app.post<{ Body: unknown }>(
    "/gateway/billing/v1/subscription/pause",
    {
      config: { skipAuth: true, skipRateLimit: true }
    },
    async (request, reply) => {
      if (!planEntitlementStore) {
        return sendGatewayErrorResponse(
          request,
          reply,
          new GatewayError({
            code: "service_unavailable",
            message: "Plan entitlement store is not configured.",
            httpStatus: 503
          })
        );
      }
      if (!credentialStore) {
        return sendGatewayErrorResponse(
          request,
          reply,
          new GatewayError({
            code: "service_unavailable",
            message: "Credential store is not configured.",
            httpStatus: 503
          })
        );
      }

      const parsed = parseClientSubscriptionPauseRequest(request.body);
      if (parsed instanceof GatewayError) {
        return sendGatewayErrorResponse(request, reply, parsed);
      }

      const context = authenticateClientSubscriptionPauseBearer(request, {
        credentialStore,
        unifiedClientKeyStore,
        provider,
        upstreamAccount,
        now: clock
      });
      if (context instanceof GatewayError) {
        return sendGatewayErrorResponse(request, reply, context);
      }
      request.gatewayContext = context;

      const { subject } = context;
      const now = clock();
      let access: ReturnType<PlanEntitlementStore["entitlementAccessForSubject"]>;
      try {
        access = planEntitlementStore.entitlementAccessForSubject(subject.id, now);
      } catch (err) {
        request.log.error(
          { error: err instanceof Error ? err.message : String(err), subject_id: subject.id },
          "Failed to resolve entitlement access for client subscription pause."
        );
        return sendGatewayErrorResponse(
          request,
          reply,
          new GatewayError({
            code: "service_unavailable",
            message: "Plan entitlement service is unavailable.",
            httpStatus: 503
          })
        );
      }

      if (access.status === "inactive" && access.reason === "paused" && access.entitlement) {
        return clientSubscriptionPauseResponse({
          subject,
          entitlement: access.entitlement,
          planEntitlementStore,
          alreadyPaused: true
        });
      }

      if (access.status !== "active") {
        return sendGatewayErrorResponse(
          request,
          reply,
          new GatewayError({
            code: "entitlement_not_found",
            message: "No active subscription is available to pause.",
            httpStatus: 404
          })
        );
      }

      try {
        const entitlement = planEntitlementStore.pauseEntitlement({
          id: access.entitlement.id,
          reason: parsed.reason ?? "client_requested",
          now
        });
        return clientSubscriptionPauseResponse({
          subject,
          entitlement,
          planEntitlementStore,
          alreadyPaused: false
        });
      } catch (err) {
        const pauseError = clientSubscriptionPauseError(err);
        if (pauseError.code === "service_unavailable") {
          request.log.error(
            { error: err instanceof Error ? err.message : String(err), subject_id: subject.id },
            "Failed to pause client subscription."
          );
        }
        return sendGatewayErrorResponse(request, reply, pauseError);
      }
    }
  );

  app.post(
    "/gateway/unified-keys/resolve",
    {
      config: {
        public: true,
        skipRateLimit: true
      }
    },
    async (request, reply) => {
      if (!unifiedClientKeyStore || !credentialStore) {
        return sendGatewayErrorResponse(
          request,
          reply,
          new GatewayError({
            code: "service_unavailable",
            message: "Unified key resolver is not configured.",
            httpStatus: 503
          })
        );
      }

      const result = authenticateUnifiedClientKeyBearer(request, {
        store: unifiedClientKeyStore,
        subjectStore: credentialStore,
        now: clock
      });
      if (result instanceof GatewayError) {
        return sendGatewayErrorResponse(request, reply, result);
      }

      const encryptionSecret = process.env.GATEWAY_API_KEY_ENCRYPTION_SECRET;
      if (!encryptionSecret) {
        return sendGatewayErrorResponse(
          request,
          reply,
          new GatewayError({
            code: "service_unavailable",
            message: "Unified key resolver encryption secret is not configured.",
            httpStatus: 503
          })
        );
      }

      let codexApiKey: string;
      let medevidenceApiKey: string;
      try {
        codexApiKey = decryptSecret(result.record.codexKeyCiphertext, encryptionSecret);
        medevidenceApiKey = decryptSecret(
          result.record.medevidenceKeyCiphertext,
          encryptionSecret
        );
      } catch (err) {
        request.log.error(
          {
            error: err instanceof Error ? err.message : String(err),
            unified_key_prefix: result.record.prefix
          },
          "Failed to decrypt unified client key payload."
        );
        return sendGatewayErrorResponse(
          request,
          reply,
          new GatewayError({
            code: "service_unavailable",
            message: "Unified key resolver payload is unavailable.",
            httpStatus: 503
          })
        );
      }

      const backingCredentialError = validateBackingGatewayCredential({
        store: credentialStore,
        record: result.record,
        codexApiKey,
        now: clock
      });
      if (backingCredentialError) {
        return sendGatewayErrorResponse(request, reply, backingCredentialError);
      }

      recordUnifiedKeyResolveAudit(adminAuditStore, result.record, request.log);

      const medevidenceBaseUrl = normalizeBaseUrl(
        metadataString(result.record.metadata, "medevidence_base_url")
      );

      return {
        valid: true,
        unified_key: {
          prefix: result.record.prefix,
          label: result.record.label,
          expires_at: result.record.expiresAt.toISOString()
        },
        subject: {
          id: result.subject.id,
          label: result.subject.label
        },
        codex_gateway: {
          endpoint_base_url: publicGatewayBaseUrl ? `${publicGatewayBaseUrl}/v1` : null,
          credential_validation_url: publicGatewayBaseUrl
            ? `${publicGatewayBaseUrl}/gateway/credentials/current`
            : null,
          key_prefix: result.record.codexCredentialPrefix,
          api_key: codexApiKey
        },
        medevidence: {
          base_url: medevidenceBaseUrl,
          key_prefix: result.record.medevidenceKeyPrefix,
          api_key: medevidenceApiKey
        }
      };
    }
  );

  app.get(
    "/gateway/admin/client-messages",
    {
      config: {
        public: true,
        skipRateLimit: true,
        skipObservation: true
      }
    },
    async (_request, reply) => {
      if (!adminMessagesAccess || !clientEventsStore || !credentialStore) {
        return sendAdminMessagesUnavailable(adminMessagesSecurityHeaders(reply));
      }

      return adminMessagesSecurityHeaders(reply)
        .type("text/html; charset=utf-8")
        .send(renderAdminClientMessagesPage({ authRequired: adminMessagesAccess.mode === "token" }));
    }
  );

  app.get<{ Querystring: AdminClientMessagesQuery }>(
    "/gateway/admin/client-messages.json",
    {
      config: {
        public: true,
        skipRateLimit: true,
        skipObservation: true
      }
    },
    async (request, reply) => {
      if (!adminMessagesAccess || !clientEventsStore || !credentialStore) {
        return sendAdminMessagesUnavailable(adminMessagesSecurityHeaders(reply));
      }
      if (
        adminMessagesAccess.mode === "token" &&
        (!adminMessagesAccess.token ||
          !authenticateAdminMessagesRequest(request, adminMessagesAccess.token))
      ) {
        return sendAdminMessagesUnauthorized(adminMessagesSecurityHeaders(reply));
      }

      return adminMessagesSecurityHeaders(reply).send(
        buildAdminClientMessagesPayload({
          clientEventsStore,
          credentialStore,
          query: request.query
        })
      );
    }
  );

  app.get(
    "/gateway/admin/quota-dashboard",
    {
      config: {
        public: true,
        skipRateLimit: true,
        skipObservation: true
      }
    },
    async (_request, reply) => {
      if (!adminMessagesAccess || !(sessions instanceof SqliteGatewayStore)) {
        return sendAdminMessagesUnavailable(adminMessagesSecurityHeaders(reply));
      }

      return adminMessagesSecurityHeaders(reply)
        .type("text/html; charset=utf-8")
        .send(renderQuotaDashboardPage({ authRequired: adminMessagesAccess.mode === "token" }));
    }
  );

  app.get<{ Querystring: { include_inactive?: string } }>(
    "/gateway/admin/quota-dashboard.json",
    {
      config: {
        public: true,
        skipRateLimit: true,
        skipObservation: true
      }
    },
    async (request, reply) => {
      if (!adminMessagesAccess || !(sessions instanceof SqliteGatewayStore)) {
        return sendAdminMessagesUnavailable(adminMessagesSecurityHeaders(reply));
      }
      if (
        adminMessagesAccess.mode === "token" &&
        (!adminMessagesAccess.token ||
          !authenticateAdminMessagesRequest(request, adminMessagesAccess.token))
      ) {
        return sendAdminMessagesUnauthorized(adminMessagesSecurityHeaders(reply));
      }

      const includeInactive = ["1", "true", "yes"].includes(
        String(request.query.include_inactive ?? "").trim().toLowerCase()
      );
      return adminMessagesSecurityHeaders(reply).send(
        await buildQuotaDashboardData(sessions, { includeInactive })
      );
    }
  );

  app.get(
    "/gateway/admin/quota-dashboard/realtime-token-usage",
    {
      config: {
        public: true,
        skipRateLimit: true,
        skipObservation: true
      }
    },
    async (_request, reply) => {
      if (!adminMessagesAccess || !(sessions instanceof SqliteGatewayStore)) {
        return sendAdminMessagesUnavailable(adminMessagesSecurityHeaders(reply));
      }

      return adminMessagesSecurityHeaders(reply)
        .type("text/html; charset=utf-8")
        .send(
          renderRealtimeTokenUsagePage({ authRequired: adminMessagesAccess.mode === "token" })
        );
    }
  );

  app.get<{
    Querystring: {
      window_seconds?: string;
      bucket_seconds?: string;
      limit?: string;
      include_auth_noise?: string;
    };
  }>(
    "/gateway/admin/quota-dashboard/realtime-token-usage.json",
    {
      config: {
        public: true,
        skipRateLimit: true,
        skipObservation: true
      }
    },
    async (request, reply) => {
      if (!adminMessagesAccess || !(sessions instanceof SqliteGatewayStore)) {
        return sendAdminMessagesUnavailable(adminMessagesSecurityHeaders(reply));
      }
      if (
        adminMessagesAccess.mode === "token" &&
        (!adminMessagesAccess.token ||
          !authenticateAdminMessagesRequest(request, adminMessagesAccess.token))
      ) {
        return sendAdminMessagesUnauthorized(adminMessagesSecurityHeaders(reply));
      }

      return adminMessagesSecurityHeaders(reply).send(
        await buildRealtimeTokenUsageData(sessions, {
          clientEventsStore,
          windowSeconds: parseOptionalPositiveInteger(request.query.window_seconds),
          bucketSeconds: parseOptionalPositiveInteger(request.query.bucket_seconds),
          limit: parseOptionalPositiveInteger(request.query.limit),
          includeAuthNoise: parseOptionalBoolean(request.query.include_auth_noise)
        })
      );
    }
  );

  registerBillingAdminRoutes(app, {
    access: billingAdminAccess,
    tokenMode: billingAdminTokenMode,
    tokenStore: billingAdminTokenStore,
    billingStore: billingAdminStore,
    planEntitlementStore,
    credentialStore,
    adminAuditStore,
    credentialRateLimiter: rateLimiter,
    tokenBudgetLimiter,
    rateLimiter: billingAdminRateLimiter,
    ratePolicy: billingAdminRatePolicy,
    upstreamV2Client,
    apiKeyEncryptionSecret: process.env.GATEWAY_API_KEY_ENCRYPTION_SECRET ?? null,
    publicModels: publicModelRegistry.models.map((model) => ({
      id: model.id,
      aliases: model.aliases,
      displayName: model.displayName
    })),
    now: clock
  });

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
        credentialId: clientEventsRateLimitKey(credential.id, "messages"),
        policy: clientEventsRatePolicy
      });
      if (!("release" in permit)) {
        markRateLimitRejection(request, permit);
        logClientEventRateLimitRejection({
          request,
          credentialId: credential.id,
          subjectId: subject.id,
          family: "messages",
          rejection: permit,
          state: clientEventsRateLimitLogState,
          now: clock()
        });
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
        backfillClientDiagnosticsForMessage(clientEventsStore, subject.id, parsed);

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

  app.post<{ Body: unknown }>(
    "/gateway/client-events/diagnostics",
    {
      bodyLimit: CLIENT_DIAGNOSTIC_BODY_LIMIT_BYTES,
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
            message: "Client diagnostic event storage is not configured.",
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
            message: "Client diagnostic events require credential auth.",
            httpStatus: 503
          })
        );
      }

      const permit = clientEventsRateLimiter.acquire({
        credentialId: clientEventsRateLimitKey(credential.id, "diagnostics"),
        policy: clientEventsRatePolicy
      });
      if (!("release" in permit)) {
        markRateLimitRejection(request, permit);
        logClientEventRateLimitRejection({
          request,
          credentialId: credential.id,
          subjectId: subject.id,
          family: "diagnostics",
          rejection: permit,
          state: clientEventsRateLimitLogState,
          now: clock()
        });
        return sendError(request, reply, permit.error);
      }

      try {
        const parsed = parseClientDiagnosticEventRequest(request.body);
        if (parsed instanceof GatewayError) {
          return sendError(request, reply, parsed);
        }
        const linked = linkClientDiagnosticEvent(clientEventsStore, subject.id, parsed);

        const existing = clientEventsStore.getClientDiagnosticEvent(
          subject.id,
          linked.eventId
        );
        if (existing) {
          const relinked = relinkExistingClientDiagnosticEvent(
            clientEventsStore,
            subject.id,
            existing,
            parsed,
            linked
          );
          if (relinked || clientDiagnosticEventsMatch(existing, linked)) {
            return {
              ok: true,
              event_id: linked.eventId,
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
        clientEventsStore.insertClientDiagnosticEvent({
          id: `cde_${randomUUID().replaceAll("-", "")}`,
          eventId: linked.eventId,
          requestId: request.id,
          credentialId: credential.id,
          subjectId: subject.id,
          scope,
          sessionId: linked.sessionId,
          messageId: linked.messageId,
          toolCallId: linked.toolCallId,
          providerId: linked.providerId,
          modelId: linked.modelId,
          category: linked.category,
          action: linked.action,
          status: linked.status,
          method: linked.method,
          path: linked.path,
          monoMs: linked.monoMs,
          durationMs: linked.durationMs,
          httpStatus: linked.httpStatus,
          errorCode: linked.errorCode,
          errorMessage: linked.errorMessage,
          metadataJson: linked.metadataJson,
          appName: linked.appName,
          appVersion: linked.appVersion,
          createdAt: linked.createdAt,
          receivedAt
        });

        reply.code(201);
        return {
          ok: true,
          event_id: linked.eventId,
          duplicate: false,
          received_at: receivedAt.toISOString()
        };
      } finally {
        permit.release();
      }
    }
  );

  app.post<{ Body: unknown }>(
    "/gateway/images/generations",
    {
      config: { skipRateLimit: true }
    },
    async (request, reply) => {
      const { subject } = getGatewayContext(request);
      const parsed = parseImageGenerationRequest(request.body, {
        maxPromptChars: imageMaxPromptChars
      });
      if (parsed instanceof GatewayError) {
        return sendImageError(request, reply, parsed);
      }

      const access = planEntitlementStore?.entitlementAccessForSubject(subject.id);
      if (!access || access.status !== "active") {
        return sendImageError(
          request,
          reply,
          new GatewayError({
            code: "plan_capability_required",
            message: "This credential is not entitled for image generation.",
            httpStatus: 403
          })
        );
      }

      const upstreamModel = resolveImageUpstreamModel(
        parsed,
        access.entitlement.featurePolicySnapshot,
        imageModelMap
      );
      if (upstreamModel instanceof GatewayError) {
        return sendImageError(request, reply, upstreamModel);
      }
      if (accountPoolImageBindingDeclared) {
        return generateImageWithAccountPool(request, reply, upstreamRouter, {
          parsed,
          upstreamModel,
          timeoutMs: imageRequestTimeoutMs,
          billingFallbacks: imageGenerationBillingFallbacks
        });
      }
      if (!imageGenerationProvider) {
        return sendImageError(
          request,
          reply,
          new GatewayError({
            code: "upstream_unavailable",
            message: "Image generation service is not configured.",
            httpStatus: 503
          })
        );
      }

      const abort = createImageRequestAbort(request, reply, imageRequestTimeoutMs);
      try {
        if (upstreamPool.accountPoolConfigured) {
          request.gatewayObservedUpstreamAccount = {
            id: null,
            provider: null
          };
        }
        const result = await runImageGenerationWithAbort(imageGenerationProvider, abort, {
          request: parsed,
          upstreamModel
        });
        const finalized = await finalizeImageGenerationResult({
          request: parsed,
          result
        });
        markFirstByte(request);
        return buildImageGenerationResponse({
          request: parsed,
          result: finalized
        });
      } catch (err) {
        const error = imageErrorFromUnknown(err);
        if (isImageBillingLimitError(error) && imageGenerationBillingFallbacks.length > 0) {
          try {
            return await generateImageWithBillingFallbacks(request, abort, {
              parsed,
              billingFallbacks: imageGenerationBillingFallbacks
            });
          } catch (fallbackErr) {
            return sendImageError(request, reply, imageErrorFromUnknown(fallbackErr));
          }
        }
        return sendImageError(request, reply, error);
      } finally {
        abort.cleanup();
      }
    }
  );

  app.get("/v1/models", async () => ({
    object: "list",
    data: publicModelRegistry
      .listAvailable(publicModelAvailability)
      .map((model) => openAIModelObject(model))
  }));

  app.get<{ Params: { id: string } }>("/v1/models/:id", async (request, reply) => {
    const model = publicModelRegistry.get(request.params.id);
    if (
      !model ||
      !publicModelRegistry.isAvailable(model, publicModelAvailability)
    ) {
      return sendOpenAIError(request, reply, modelNotFoundError(request.params.id));
    }

    return openAIModelObject(model, request.params.id);
  });

  const executeChatCompletion = async (
    request: FastifyRequest<{ Body: unknown }>,
    reply: FastifyReply,
    parsed: ChatCompletionRequest,
    executionOptions: ChatCompletionExecutionOptions = {}
  ) => {
    const fail = (error: GatewayError) =>
      executionOptions.captureErrors
        ? chatCompletionExecutionFailure(error)
        : sendOpenAIError(request, reply, error);
    applyClientTurnHeaders(request, executionOptions.clientSessionId);
    const publicModel = publicModelRegistry.get(parsed.model);
    request.gatewayPublicModelId = parsed.model;
    if (
      !publicModel ||
      !publicModelRegistry.isAvailable(publicModel, publicModelAvailability)
    ) {
      request.gatewayObservedUpstreamAccount = { id: null, provider: null };
      return fail(modelNotFoundError(parsed.model));
    }
    const { credential } = getGatewayContext(request);
    if (
      !credentialAllowsPublicModel(
        credential.allowedPublicModels,
        publicModel.id,
        publicModelAliasGroups
      )
    ) {
      request.gatewayObservedUpstreamAccount = { id: null, provider: null };
      return fail(
        new GatewayError({
          code: "model_not_allowed_for_credential",
          message: "Credential is not allowed to use this model.",
          httpStatus: 403
        })
      );
    }
    const reasoningEffort = resolveChatCompletionReasoningEffort(
      publicModel,
      parsed.reasoningEffort,
      parsed.model
    );
    if (reasoningEffort instanceof GatewayError) {
      request.gatewayObservedUpstreamAccount = { id: null, provider: null };
      return fail(reasoningEffort);
    }

    let entitlementAccess;
    try {
      const { subject, scope, credential } = getGatewayContext(request);
      entitlementAccess = resolveEntitlementAccessForChat({
        context: { subject, scope, credential },
        entitlementStore: planEntitlementStore,
        requireEntitlement,
        now: clock()
      });
    } catch (err) {
      request.log.error(
        {
          request_id: request.id,
          error: err instanceof Error ? err.message : String(err)
        },
        "Plan entitlement check failed."
      );
      entitlementAccess = new GatewayError({
        code: "service_unavailable",
        message: "Plan entitlement service is unavailable.",
        httpStatus: 503
      });
    }
    if (entitlementAccess instanceof GatewayError) {
      request.gatewayObservedUpstreamAccount = { id: null, provider: null };
      return fail(entitlementAccess);
    }

    const affinityKey = chatRuntimeAffinityKey(request, publicModel, upstreamRouter.softAffinity);
    const attemptedAccountIds = new Set<string>();
    let statelessAttempts = 1;
    const gatewayContext = getGatewayContext(request);
    const { subject, scope } = gatewayContext;
    let attempt = chatRuntimeDispatcher.begin({
      model: publicModel,
      reasoningEffort,
      reasoningEffortSource: parsed.reasoningEffort === undefined ? "default" : "request",
      subject,
      scope,
      affinityKey,
      createSession: createStatelessSession
    });
    if (attempt instanceof GatewayError) {
      return fail(attempt);
    }
    applyChatRuntimeContext(request, attempt);
    const shape = createChatCompletionShape(parsed.model);
    const nativeClientTools = hasNativeClientTools(parsed, publicModel);
    const strictClientTools = hasStrictClientTools(parsed) && !nativeClientTools;
    request.gatewayToolChoice = serializeToolChoice(
      nativeClientTools
        ? initialNativeToolChoice(parsed, attempt.upstreamModel, nativeToolForceRequiredMode)
        : parsed.toolChoice
    );
    request.gatewayModelContextTokens = attempt.limits.contextWindow;
    request.gatewayModelMaxOutputTokens = attempt.limits.maxOutputTokens;
    request.gatewayActiveToolCount =
      request.gatewayToolChoice === "none" ? 0 : parsed.tools?.length ?? 0;
    request.gatewayClientToolMode =
      (parsed.tools?.length ?? 0) === 0
        ? "none"
        : nativeClientTools
          ? "native"
          : "strict";
    const prompt = strictClientTools
      ? chatMessagesToStrictToolPrompt(parsed)
      : chatMessagesToPrompt(parsed, { includeToolsContext: !nativeClientTools });
    request.gatewayEstimatedTokens = estimatePromptTokens(
      prompt,
      chatCompletionEstimateExtras(parsed, strictClientTools, attempt.runtime)
    );
    request.gatewayEstimatedPromptTokens = request.gatewayEstimatedTokens;
    request.gatewayPromptEstimateMethod = PROMPT_TOKEN_ESTIMATE_METHOD;
    request.gatewayToolLoopGuard = toolLoopGuardNotAssessed(
      toolLoopShadowPolicy,
      toolLoopShadowPolicy.mode === "disabled"
        ? "disabled"
        : !observationStore
          ? "observation_store_unavailable"
          : !gatewayContext.credential.id
            ? "credential_id_unavailable"
            : !request.gatewayClientTurnId
              ? "client_turn_id_unavailable"
              : "not_started"
    );
    if (
      toolLoopShadowPolicy.mode === "shadow" &&
      observationStore &&
      gatewayContext.credential.id &&
      request.gatewayClientTurnId
    ) {
      try {
        const now = clock();
        const assessment = assessToolLoopShadow({
          events: observationStore.listRequestEvents({
            credentialId: gatewayContext.credential.id,
            subjectId: subject.id,
            clientTurnId: request.gatewayClientTurnId,
            limit: toolLoopShadowPolicy.historyLimit
          }),
          publicModelId: publicModel.id,
          now,
          promptTokens: request.gatewayEstimatedTokens,
          policy: toolLoopShadowPolicy
        });
        request.gatewayToolLoopGuard = toolLoopGuardAssessed(
          toolLoopShadowPolicy,
          assessment
        );
        const fields = {
          request_id: request.id,
          subject_id: subject.id,
          credential_id: gatewayContext.credential.id,
          client_turn_id: request.gatewayClientTurnId,
          public_model_id: publicModel.id,
          tool_loop_guard_mode: "shadow",
          prior_consecutive_tool_calls: assessment.priorConsecutiveToolCalls,
          candidate_call_count: assessment.candidateCallCount,
          elapsed_ms: assessment.elapsedMs,
          prompt_tokens: assessment.promptTokens,
          would_warn: assessment.wouldWarn,
          would_finalize: assessment.wouldFinalize,
          warning_reasons: assessment.warningReasons,
          hard_reasons: assessment.hardReasons
        };
        if (assessment.wouldWarn) {
          request.log.warn(fields, "Tool loop guard shadow threshold matched; request is not altered.");
        } else {
          request.log.info(fields, "Tool loop guard shadow assessment completed.");
        }
      } catch (error) {
        request.gatewayToolLoopGuard = toolLoopGuardAssessmentFailed(toolLoopShadowPolicy);
        request.log.warn(
          {
            request_id: request.id,
            client_turn_id: request.gatewayClientTurnId,
            error: error instanceof Error ? error.message : String(error)
          },
          "Tool loop guard shadow assessment failed; request is not altered."
        );
      }
    }
    const tokenBudgetError = await beginTokenBudget(
      request,
      tokenBudgetLimiter,
      request.gatewayEstimatedTokens,
      {
        entitlementStore: planEntitlementStore,
        requireEntitlement,
        resolvedAccess: entitlementAccess,
        now: clock
      }
    );
    if (tokenBudgetError) {
      attempt.release();
      return fail(tokenBudgetError);
    }

    const chatRequestTimeoutMs = resolveChatRequestTimeoutMs(
      chatRequestTimeoutPolicy,
      publicModel.id,
      attempt.runtime
    );
    const beginActiveRequest = (
      runtimeContext: ChatRuntimeContext,
      deadlineAt: Date | null
    ): ActiveRequestHandle =>
      activeRequestRegistry.begin({
        requestId: request.id,
        publicModelId: publicModel.id,
        upstreamRuntime: runtimeContext.runtime,
        upstreamAccountId: runtimeContext.adapterInputUpstreamAccount.id,
        startedAt: clock(),
        deadlineAt
      });

    if (parsed.stream) {
      const sse = setupSseResponse(reply);
      const deadline = createChatRequestDeadline({
        timeoutMs: chatRequestTimeoutMs,
        parentSignals: [executionOptions.signal, sse.signal],
        now: clock()
      });
      const activeRequest = beginActiveRequest(attempt, deadline.deadlineAt);
      let failed = false;
      let hasToolCalls = false;
      let toolCallIndex = 0;
      let usage: OpenAIChatUsage | null = null;
      let initialChunkSent = false;
      const writeInitialChunk = () => {
        if (initialChunkSent) {
          return true;
        }
        initialChunkSent = true;
        markFirstByte(request);
        return sse.writeData(createInitialChatCompletionChunk(shape));
      };

      try {
        if (strictClientTools) {
          const onProviderError = createProviderErrorLogger(request);
          const strictResult = await runStrictClientTools({
            provider: attempt.adapter,
            upstreamAccount: attempt.adapterInputUpstreamAccount,
            upstreamRuntime: attempt.runtime,
            upstreamModel: attempt.upstreamModel,
            subject: attempt.subject,
            scope: attempt.scope,
            session: attempt.session,
            reasoningEffort: attempt.reasoningEffort,
            request: parsed,
            prompt,
            signal: deadline.signal,
            requestId: request.id,
            log: request.log,
            onProviderError
          });
          if (strictResult instanceof GatewayError) {
            recordChatRuntimeErrorOutcome(attempt, strictResult);
            markProviderStreamSummary(request, providerStreamSummaryFromError(strictResult));
            request.gatewayErrorCode = strictResult.code;
            writeOpenAIStreamError(request, reply, sse, strictResult);
            failed = true;
          } else if (strictResult.toolCalls.length > 0) {
            writeInitialChunk();
            activeRequest.markFirstByte();
            if (!sse.isClosed()) {
              attempt.recordSuccess();
            }
            hasToolCalls = true;
            usage = strictResult.usage;
            markProviderStreamSummary(request, strictResult.providerSummary);
            markOpenAITokenUsage(request, usage);
            for (const toolCall of strictResult.toolCalls) {
              const chunk = streamEventToChatCompletionChunk({
                shape,
                event: openAIToolCallToStreamEvent(toolCall),
                toolCallIndex
              });
              toolCallIndex += 1;
              if (chunk && !sse.writeData(chunk)) {
                break;
              }
            }
          } else {
            writeInitialChunk();
            activeRequest.markFirstByte();
            if (!sse.isClosed()) {
              attempt.recordSuccess();
            }
            usage = strictResult.usage;
            markProviderStreamSummary(request, strictResult.providerSummary);
            markOpenAITokenUsage(request, usage);
            const chunk = streamEventToChatCompletionChunk({
              shape,
              event: { type: "message_delta", text: strictResult.content },
              toolCallIndex
            });
            chunk && sse.writeData(chunk);
          }
        } else if (nativeClientTools) {
          const onProviderError = createProviderErrorLogger(request);
          const nativeResult = await runNativeClientTools({
            provider: attempt.adapter,
            upstreamAccount: attempt.adapterInputUpstreamAccount,
            upstreamRuntime: attempt.runtime,
            upstreamModel: attempt.upstreamModel,
            subject: attempt.subject,
            scope: attempt.scope,
            session: attempt.session,
            reasoningEffort: attempt.reasoningEffort,
            request: parsed,
            prompt,
            nativeToolForceRequiredMode,
            signal: deadline.signal,
            requestId: request.id,
            log: request.log,
            onProviderError
          });
          if (nativeResult instanceof GatewayError) {
            recordChatRuntimeErrorOutcome(attempt, nativeResult);
            markProviderStreamSummary(request, providerStreamSummaryFromError(nativeResult));
            request.gatewayErrorCode = nativeResult.code;
            writeOpenAIStreamError(request, reply, sse, nativeResult);
            failed = true;
          } else if (nativeResult.toolCalls.length > 0) {
            writeInitialChunk();
            activeRequest.markFirstByte();
            if (!sse.isClosed()) {
              attempt.recordSuccess();
            }
            hasToolCalls = true;
            usage = nativeResult.usage;
            markProviderStreamSummary(request, nativeResult.providerSummary);
            markOpenAITokenUsage(request, usage);
            if (nativeResult.content.length > 0) {
              const contentChunk = streamEventToChatCompletionChunk({
                shape,
                event: { type: "message_delta", text: nativeResult.content },
                toolCallIndex
              });
              contentChunk && sse.writeData(contentChunk);
            }
            for (const toolCall of nativeResult.toolCalls) {
              const chunk = streamEventToChatCompletionChunk({
                shape,
                event: openAIToolCallToStreamEvent(toolCall),
                toolCallIndex
              });
              toolCallIndex += 1;
              if (chunk && !sse.writeData(chunk)) {
                break;
              }
            }
          } else {
            writeInitialChunk();
            activeRequest.markFirstByte();
            if (!sse.isClosed()) {
              attempt.recordSuccess();
            }
            usage = nativeResult.usage;
            markProviderStreamSummary(request, nativeResult.providerSummary);
            markOpenAITokenUsage(request, usage);
            const chunk = streamEventToChatCompletionChunk({
              shape,
              event: { type: "message_delta", text: nativeResult.content },
              toolCallIndex
            });
            chunk && sse.writeData(chunk);
          }
        } else {
          const providerSummaries: ProviderStreamSummary[] = [];
          while (true) {
            const onProviderError = createProviderErrorLogger(request);
            const providerSummary = new ProviderStreamSummaryCollector();
            const attemptKind = statelessAttempts > 1 ? "stateless_retry" : "primary";
            const bufferedToolCalls: Array<
              Extract<StreamEvent, { type: "tool_call" }>
            > = [];
            let attemptHasToolCalls = false;
            let retrying = false;
            for await (const event of attempt.adapter.message({
              upstreamAccount: attempt.adapterInputUpstreamAccount,
              subject: attempt.subject,
              scope: attempt.scope,
              session: attempt.session,
              message: prompt,
              reasoningEffort: attempt.reasoningEffort,
              clientTools: nativeClientTools ? parsed.tools : undefined,
              clientToolChoice: nativeClientTools ? parsed.toolChoice : undefined,
              signal: deadline.signal,
              onProviderError
            })) {
              providerSummary.record(event);
              if (sse.isClosed()) {
                break;
              }
              if (event.type === "completed") {
                usage = openAIUsageFromTokenUsage(event.usage);
                markTokenUsage(request, event.usage);
                continue;
              }
              if (event.type === "error") {
                const error = streamErrorToGatewayError(event);
                const errorSummary = providerSummary.snapshot(
                  chatRuntimeAttemptContext(attempt, attemptKind, parsed.toolChoice)
                );
                providerSummaries.push(errorSummary);
                attempt.recordError(error);
                if (
                  !initialChunkSent &&
                  statelessAttempts < maxStatelessAttempts &&
                  isStatelessRetryableProviderError(error) &&
                  attempt.beginRetry
                ) {
                  attemptedAccountIds.add(attempt.runtimeInstanceId);
                  attempt.release();
                  const nextAttempt = attempt.beginRetry({
                    excludeAccountIds: attemptedAccountIds
                  });
                  if (!(nextAttempt instanceof GatewayError)) {
                    statelessAttempts += 1;
                    attempt = nextAttempt;
                    applyChatRuntimeContext(request, attempt);
                    activeRequest.update({
                      upstreamRuntime: attempt.runtime,
                      upstreamAccountId: attempt.adapterInputUpstreamAccount.id
                    });
                    retrying = true;
                    break;
                  }
                }
                request.gatewayErrorCode = error.code;
                markProviderStreamSummary(
                  request,
                  combineProviderStreamSummaries(providerSummaries) ?? errorSummary
                );
                writeOpenAIStreamError(request, reply, sse, error);
                failed = true;
                break;
              }

              if (event.type === "tool_call") {
                if (parsed.toolChoice === "none") {
                  continue;
                }
                attemptHasToolCalls = true;
                bufferedToolCalls.push(event);
                continue;
              }
              if (event.type === "message_delta" && attemptHasToolCalls) {
                continue;
              }

              if (!writeInitialChunk()) {
                break;
              }
              activeRequest.markFirstByte();
              const chunk = streamEventToChatCompletionChunk({
                shape,
                event,
                toolCallIndex
              });
              if (chunk && !sse.writeData(chunk)) {
                break;
              }
            }
            if (retrying) {
              continue;
            }
            if (!failed && !sse.isClosed()) {
              const successSummary = providerSummary.snapshot(
                chatRuntimeAttemptContext(attempt, attemptKind, parsed.toolChoice)
              );
              const completionError = providerCompletionError(successSummary);
              if (completionError) {
                const errorSummary =
                  providerStreamSummaryFromError(completionError) ?? successSummary;
                providerSummaries.push(errorSummary);
                attempt.recordError(completionError);
                if (
                  !initialChunkSent &&
                  statelessAttempts < maxStatelessAttempts &&
                  isStatelessRetryableProviderError(completionError) &&
                  attempt.beginRetry
                ) {
                  attemptedAccountIds.add(attempt.runtimeInstanceId);
                  attempt.release();
                  const nextAttempt = attempt.beginRetry({
                    excludeAccountIds: attemptedAccountIds
                  });
                  if (!(nextAttempt instanceof GatewayError)) {
                    statelessAttempts += 1;
                    attempt = nextAttempt;
                    applyChatRuntimeContext(request, attempt);
                    activeRequest.update({
                      upstreamRuntime: attempt.runtime,
                      upstreamAccountId: attempt.adapterInputUpstreamAccount.id
                    });
                    continue;
                  }
                }
                request.gatewayErrorCode = completionError.code;
                markProviderStreamSummary(
                  request,
                  combineProviderStreamSummaries(providerSummaries) ?? errorSummary
                );
                writeOpenAIStreamError(request, reply, sse, completionError);
                failed = true;
                break;
              }
              providerSummaries.push(successSummary);
              attempt.recordSuccess();
              if (bufferedToolCalls.length > 0) {
                if (!writeInitialChunk()) {
                  break;
                }
                activeRequest.markFirstByte();
                hasToolCalls = true;
                for (const toolCall of bufferedToolCalls) {
                  const chunk = streamEventToChatCompletionChunk({
                    shape,
                    event: toolCall,
                    toolCallIndex
                  });
                  toolCallIndex += 1;
                  if (chunk && !sse.writeData(chunk)) {
                    break;
                  }
                }
              }
              markProviderStreamSummary(
                request,
                combineProviderStreamSummaries(providerSummaries) ?? successSummary
              );
            }
            break;
          }
        }

        if (!sse.isClosed() && !failed) {
          writeInitialChunk();
          const finishReason = hasToolCalls ? "tool_calls" : "stop";
          sse.writeData(createFinalChatCompletionChunk(shape, finishReason, usage));
          sse.writeDone();
        }
      } finally {
        await finalizeTokenBudget(request, tokenBudgetLimiter, { now: clock });
        attempt.release();
        activeRequest.finish();
        deadline.cleanup();
        releaseRateLimit(request);
        recordObservation(request, observationStore, reply.raw.statusCode);
        sse.end();
      }
      return;
    }

    let content = "";
    const toolCalls: OpenAIChatToolCall[] = [];
    let usage: OpenAIChatUsage | null = null;
    const deadline = createChatRequestDeadline({
      timeoutMs: chatRequestTimeoutMs,
      parentSignals: [executionOptions.signal],
      now: clock()
    });
    const activeRequest = beginActiveRequest(attempt, deadline.deadlineAt);

    try {
      if (strictClientTools) {
        const onProviderError = createProviderErrorLogger(request);
        const strictResult = await runStrictClientTools({
          provider: attempt.adapter,
          upstreamAccount: attempt.adapterInputUpstreamAccount,
          upstreamRuntime: attempt.runtime,
          upstreamModel: attempt.upstreamModel,
          subject: attempt.subject,
          scope: attempt.scope,
          session: attempt.session,
          reasoningEffort: attempt.reasoningEffort,
          request: parsed,
          prompt,
          signal: deadline.signal,
          requestId: request.id,
          log: request.log,
          onProviderError
        });
        if (strictResult instanceof GatewayError) {
          recordChatRuntimeErrorOutcome(attempt, strictResult);
          markProviderStreamSummary(request, providerStreamSummaryFromError(strictResult));
          return fail(strictResult);
        }
        attempt.recordSuccess();
        activeRequest.markFirstByte();
        markFirstByte(request);
        content = strictResult.content;
        toolCalls.push(...strictResult.toolCalls);
        usage = strictResult.usage;
        markProviderStreamSummary(request, strictResult.providerSummary);
        markOpenAITokenUsage(request, usage);
      } else if (nativeClientTools) {
        const onProviderError = createProviderErrorLogger(request);
        const nativeResult = await runNativeClientTools({
          provider: attempt.adapter,
          upstreamAccount: attempt.adapterInputUpstreamAccount,
          upstreamRuntime: attempt.runtime,
          upstreamModel: attempt.upstreamModel,
          subject: attempt.subject,
          scope: attempt.scope,
          session: attempt.session,
          reasoningEffort: attempt.reasoningEffort,
          request: parsed,
          prompt,
          nativeToolForceRequiredMode,
          signal: deadline.signal,
          requestId: request.id,
          log: request.log,
          onProviderError
        });
        if (nativeResult instanceof GatewayError) {
          recordChatRuntimeErrorOutcome(attempt, nativeResult);
          markProviderStreamSummary(request, providerStreamSummaryFromError(nativeResult));
          return fail(nativeResult);
        }
        attempt.recordSuccess();
        activeRequest.markFirstByte();
        markFirstByte(request);
        content = nativeResult.content;
        toolCalls.push(...nativeResult.toolCalls);
        usage = nativeResult.usage;
        markProviderStreamSummary(request, nativeResult.providerSummary);
        markOpenAITokenUsage(request, usage);
      } else {
        let collected: CollectedProviderMessage | null = null;
        const providerSummaries: ProviderStreamSummary[] = [];
        while (true) {
          const onProviderError = createProviderErrorLogger(request);
          const attemptResult = await collectProviderMessage({
            provider: attempt.adapter,
            upstreamAccount: attempt.adapterInputUpstreamAccount,
            subject: attempt.subject,
            scope: attempt.scope,
            session: attempt.session,
            message: prompt,
            reasoningEffort: attempt.reasoningEffort,
            clientTools: nativeClientTools ? parsed.tools : undefined,
            clientToolChoice: nativeClientTools ? parsed.toolChoice : undefined,
            attemptKind: statelessAttempts > 1 ? "stateless_retry" : "primary",
            attemptToolChoice: serializeToolChoice(parsed.toolChoice),
            upstreamRuntime: attempt.runtime,
            upstreamModel: attempt.upstreamModel,
            signal: deadline.signal,
            onProviderError,
            suppressToolCalls: parsed.toolChoice === "none",
            suppressTextAfterToolCall: true
          });
          if (attemptResult instanceof GatewayError) {
            const providerSummary = providerStreamSummaryFromError(attemptResult);
            if (providerSummary) {
              providerSummaries.push(providerSummary);
            }
            attempt.recordError(attemptResult);
            if (
              statelessAttempts < maxStatelessAttempts &&
              isStatelessRetryableProviderError(attemptResult) &&
              attempt.beginRetry
            ) {
              attemptedAccountIds.add(attempt.runtimeInstanceId);
              attempt.release();
              const nextAttempt = attempt.beginRetry({
                excludeAccountIds: attemptedAccountIds
              });
              if (!(nextAttempt instanceof GatewayError)) {
                statelessAttempts += 1;
                attempt = nextAttempt;
                applyChatRuntimeContext(request, attempt);
                activeRequest.update({
                  upstreamRuntime: attempt.runtime,
                  upstreamAccountId: attempt.adapterInputUpstreamAccount.id
                });
                continue;
              }
            }
            markProviderStreamSummary(
              request,
              combineProviderStreamSummaries(providerSummaries) ?? providerSummary
            );
            return fail(attemptResult);
          }
          collected = attemptResult;
          providerSummaries.push(collected.providerSummary);
          attempt.recordSuccess();
          break;
        }
        if (!collected) {
          return fail(
            new GatewayError({
              code: "service_unavailable",
              message: "MedCode service is temporarily unavailable.",
              httpStatus: 503
            })
          );
        }
        if (collected.content.length > 0 || collected.toolCalls.length > 0) {
          activeRequest.markFirstByte();
          markFirstByte(request);
        }
        content = collected.content;
        toolCalls.push(...collected.toolCalls.map(providerToolCallToOpenAI));
        usage = openAIUsageFromTokenUsage(collected.usage);
        markProviderStreamSummary(
          request,
          combineProviderStreamSummaries(providerSummaries) ?? collected.providerSummary
        );
        markTokenUsage(request, collected.usage);
      }

      return createChatCompletionResponse({
        shape,
        content,
        toolCalls,
        finishReason: toolCalls.length > 0 ? "tool_calls" : "stop",
        usage
      });
    } finally {
      await finalizeTokenBudget(request, tokenBudgetLimiter, { now: clock });
      attempt.release();
      activeRequest.finish();
      deadline.cleanup();
    }
  };

  const chatCompletionsHandler = async (
    request: FastifyRequest<{ Body: unknown }>,
    reply: FastifyReply
  ) => {
    const parsed = parseChatCompletionRequest(request.body, publicModelRegistry.defaultModelId);
    if (parsed instanceof GatewayError) {
      return sendOpenAIError(request, reply, parsed);
    }
    return executeChatCompletion(request, reply, parsed);
  };

  app.post<{ Body: unknown }>("/v1/chat/completions", chatCompletionsHandler);

  app.post<{ Body: unknown }>("/v1/responses", async (request, reply) => {
    const parsed = parseResponsesRequest(request.body);
    if (parsed instanceof GatewayError) {
      return sendOpenAIError(request, reply, parsed);
    }

    if (!parsed.stream) {
      const chatCompletion = await executeChatCompletion(
        request,
        reply,
        parsed.chatRequest,
        {
          captureErrors: true,
          clientSessionId: parsed.promptCacheKey
        }
      );
      if (isChatCompletionExecutionFailure(chatCompletion)) {
        return sendOpenAIError(request, reply, chatCompletion.error);
      }
      const result = createResponsesResult(parsed, chatCompletion, clock());
      if (result instanceof GatewayError) {
        return sendOpenAIError(request, reply, result);
      }
      return result.response;
    }

    const sse = setupSseResponse(reply);
    const streamStart = createResponsesStreamStart(parsed, clock());
    try {
      markFirstByte(request);
      if (!sse.writeEvent(streamStart.event.event, streamStart.event.data)) {
        return;
      }
      const chatCompletion = await executeChatCompletion(
        request,
        reply,
        parsed.chatRequest,
        {
          captureErrors: true,
          clientSessionId: parsed.promptCacheKey,
          signal: sse.signal
        }
      );
      if (isChatCompletionExecutionFailure(chatCompletion)) {
        writeResponsesFailure(
          request,
          sse,
          createResponsesFailedEvent(parsed, streamStart.state, chatCompletion.error, clock()),
          chatCompletion.error
        );
        return;
      }
      const result = createResponsesResult(parsed, chatCompletion, clock(), streamStart.state);
      if (result instanceof GatewayError) {
        writeResponsesFailure(
          request,
          sse,
          createResponsesFailedEvent(parsed, streamStart.state, result, clock()),
          result
        );
        return;
      }
      for (const frame of result.events) {
        if (!sse.writeEvent(frame.event, frame.data)) {
          break;
        }
      }
    } catch (err) {
      const error = chatCompletionErrorFromUnknown(err);
      writeResponsesFailure(
        request,
        sse,
        createResponsesFailedEvent(parsed, streamStart.state, error, clock()),
        error
      );
    } finally {
      releaseRateLimit(request);
      recordObservation(request, observationStore, reply.raw.statusCode);
      sse.end();
    }
    return;
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
    if (!nativeSessionPublicModel) {
      return sendError(
        request,
        reply,
        nativeSessionsUnavailable()
      );
    }
    const modelAccessError = credentialPublicModelAccessError(
      request,
      nativeSessionPublicModel.id,
      publicModelAliasGroups
    );
    if (modelAccessError) {
      request.gatewayObservedUpstreamAccount = { id: null, provider: null };
      return sendError(request, reply, modelAccessError);
    }
    const selected = upstreamRouter.selectForNewSession({
      affinityKey: requestAffinityKey(request, upstreamRouter.softAffinity)
    });
    if (selected instanceof GatewayError) {
      return sendError(request, reply, selected);
    }
    applyUpstreamSelection(request, selected);
    const { subject, upstreamAccount } = getGatewayContext(request);
    const session = sessions.create({
      subjectId: subject.id,
      upstreamAccountId: upstreamAccount.id,
      publicModelId: nativeSessionPublicModel.id
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
      const { subject } = getGatewayContext(request);
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

      const sessionPublicModelId =
        session.publicModelId ?? nativeSessionPublicModel?.id;
      if (!sessionPublicModelId) {
        return sendError(
          request,
          reply,
          nativeSessionsUnavailable()
        );
      }
      const modelAccessError = credentialPublicModelAccessError(
        request,
        sessionPublicModelId,
        publicModelAliasGroups
      );
      if (modelAccessError) {
        request.gatewayObservedUpstreamAccount = { id: null, provider: null };
        return sendError(request, reply, modelAccessError);
      }
      const lease = upstreamRouter.beginExistingSession(session.upstreamAccountId);
      if (lease instanceof GatewayError) {
        return sendError(request, reply, lease);
      }
      applyUpstreamSelection(request, lease);
      const { upstreamAccount, provider, scope } = getGatewayContext(request);

      const message = request.body?.message;
      if (typeof message !== "string" || message.length === 0) {
        lease.release();
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
      request.gatewayEstimatedPromptTokens = request.gatewayEstimatedTokens;
      request.gatewayPromptEstimateMethod = PROMPT_TOKEN_ESTIMATE_METHOD;
      const tokenBudgetError = await beginTokenBudget(
        request,
        tokenBudgetLimiter,
        request.gatewayEstimatedTokens,
        { entitlementStore: planEntitlementStore, requireEntitlement, now: clock }
      );
      if (tokenBudgetError) {
        lease.release();
        return sendError(request, reply, tokenBudgetError);
      }

      const sse = setupSseResponse(reply);
      let providerFailed = false;
      let outcomeRecorded = false;

      try {
        for await (const event of provider.message({
          upstreamAccount,
          subject,
          scope,
          session,
          message,
          signal: sse.signal,
          onProviderError: createProviderErrorLogger(request)
        })) {
          if (sse.isClosed()) {
            break;
          }
          if (event.type === "completed" && event.providerSessionRef) {
            sessions.setProviderSessionRef(session.id, event.providerSessionRef);
          }
          if (event.type === "completed") {
            markTokenUsage(request, event.usage);
          }
          if (event.type === "error") {
            const error = streamErrorToGatewayError(event);
            recordUpstreamErrorOutcome(upstreamRouter, lease, error);
            outcomeRecorded = true;
            providerFailed = true;
            request.gatewayErrorCode = error.code;
          }
          markFirstByte(request);
          if (!sse.writeEvent(event.type, event)) {
            break;
          }
        }
        if (!providerFailed && !outcomeRecorded && !sse.isClosed()) {
          upstreamRouter.recordOutcome(lease.upstreamAccount.id, "success");
        }
      } finally {
        await finalizeTokenBudget(request, tokenBudgetLimiter, { now: clock });
        lease.release();
        releaseRateLimit(request);
        recordObservation(request, observationStore, reply.raw.statusCode);
        sse.end();
      }
    }
  );

  return app;
}

interface StrictClientToolsInput {
  provider: ProviderAdapter;
  upstreamAccount: UpstreamAccount;
  upstreamRuntime: string;
  upstreamModel: string;
  subject: Subject;
  scope: Scope;
  session: GatewaySession;
  reasoningEffort: string | null;
  request: ChatCompletionRequest;
  prompt: string;
  signal?: AbortSignal;
  requestId?: string;
  log?: StrictClientToolsLogger;
  onProviderError?: (diagnostic: ProviderErrorDiagnostic) => void;
}

interface NativeClientToolsInput extends StrictClientToolsInput {
  nativeToolForceRequiredMode: NativeToolForceRequiredMode;
}

interface StrictClientToolsResult {
  content: string;
  toolCalls: OpenAIChatToolCall[];
  usage: OpenAIChatUsage | null;
  providerSummary: ProviderStreamSummary | null;
}

interface StrictClientToolsLogger {
  info: (obj: Record<string, unknown>, msg: string) => void;
  warn: (obj: Record<string, unknown>, msg: string) => void;
}

interface StrictToolCollection {
  collected: CollectedProviderMessage;
  parsed: StrictToolDecision | GatewayError;
}

async function runNativeClientTools(
  input: NativeClientToolsInput
): Promise<StrictClientToolsResult | GatewayError> {
  const firstToolChoice = initialNativeToolChoice(
    input.request,
    input.upstreamModel,
    input.nativeToolForceRequiredMode
  );
  if (firstToolChoice !== input.request.toolChoice) {
    input.log?.info(
      {
        request_id: input.requestId,
        native_tools_initial_tool_choice: "auto_to_required"
      },
      "Native client-defined tools request looks like a file generation task; using required tool_choice."
    );
  }

  const first = await collectNativeClientTools(input, firstToolChoice, input.prompt, "native_initial");
  if (first instanceof GatewayError) {
    return first;
  }

  const firstUsage = openAIUsageFromTokenUsage(first.usage);
  const firstResult = nativeCollectionToResult(
    input,
    first,
    firstUsage,
    firstToolChoice
  );
  if (firstResult instanceof GatewayError) {
    const retryPlan = nativeValidationRetryPlan(
      input.request,
      input.upstreamModel,
      firstToolChoice,
      firstResult,
      input.prompt
    );
    if (!retryPlan) {
      return firstResult;
    }

    input.log?.info(
      {
        request_id: input.requestId,
        native_tools_retry: retryPlan.kind,
        validation_error: firstResult.message,
        retry_tool_choice: retryPlan.toolChoice
      },
      "Native client-defined tool output failed validation; retrying tool call request."
    );

    const second = await collectNativeClientTools(
      input,
      retryPlan.toolChoice,
      retryPlan.prompt,
      retryPlan.kind
    );
    if (second instanceof GatewayError) {
      return second;
    }

    const secondResult = nativeCollectionToResult(
      input,
      second,
      addOpenAIUsage(firstUsage, openAIUsageFromTokenUsage(second.usage)),
      retryPlan.validationToolChoice,
      combineProviderStreamSummaries([first.providerSummary, second.providerSummary]) ??
        second.providerSummary
    );
    if (secondResult instanceof GatewayError) {
      return secondResult;
    }
    return validateNativeCompletion(secondResult);
  }
  const retryPlan = nativeAutoToolRetryPlan(
    input.request,
    input.upstreamModel,
    firstToolChoice,
    firstResult,
    input.prompt,
    input.nativeToolForceRequiredMode
  );
  if (!retryPlan) {
    return validateNativeCompletion(firstResult);
  }

  input.log?.info(
    {
      request_id: input.requestId,
      native_tools_retry: retryPlan.kind,
      first_output_chars: firstResult.content.length
    },
    "Native client-defined tools auto response did not call a tool; retrying tool call request."
  );

  const second = await collectNativeClientTools(
    input,
    retryPlan.toolChoice,
    retryPlan.prompt,
    retryPlan.kind
  );
  if (second instanceof GatewayError) {
    return second;
  }

  const secondUsage = openAIUsageFromTokenUsage(second.usage);
  const secondResult = nativeCollectionToResult(
    input,
    second,
    addOpenAIUsage(firstUsage, secondUsage),
    retryPlan.toolChoice,
    combineProviderStreamSummaries([first.providerSummary, second.providerSummary]) ??
      second.providerSummary
  );
  if (secondResult instanceof GatewayError) {
    return secondResult;
  }
  if (retryPlan.kind === "auto_ack_after_tool_to_auto") {
    return validateNativeCompletion(secondResult);
  }
  return validateNativeCompletion(
    secondResult.toolCalls.length > 0 ? secondResult : firstResult
  );
}

async function collectNativeClientTools(
  input: StrictClientToolsInput,
  toolChoice: ChatCompletionRequest["toolChoice"],
  prompt = input.prompt,
  attemptKind = "native"
): Promise<CollectedProviderMessage | GatewayError> {
  return collectProviderMessage({
    provider: input.provider,
    upstreamAccount: input.upstreamAccount,
    subject: input.subject,
    scope: input.scope,
    session: input.session,
    message: prompt,
    reasoningEffort: input.reasoningEffort,
    clientTools: input.request.tools,
    clientToolChoice: toolChoice,
    attemptKind,
    attemptToolChoice: serializeToolChoice(toolChoice),
    upstreamRuntime: input.upstreamRuntime,
    upstreamModel: input.upstreamModel,
    signal: input.signal,
    onProviderError: input.onProviderError,
    suppressTextAfterToolCall: true,
    deferEmptyCompletionError: true
  });
}

function validateNativeCompletion(
  result: StrictClientToolsResult
): StrictClientToolsResult | GatewayError {
  if (result.content.length > 0 || result.toolCalls.length > 0 || !result.providerSummary) {
    return result;
  }
  return providerCompletionError(result.providerSummary) ?? result;
}

function nativeCollectionToResult(
  input: StrictClientToolsInput,
  collected: CollectedProviderMessage,
  usage: OpenAIChatUsage | null,
  toolChoice: ChatCompletionRequest["toolChoice"],
  providerSummary: ProviderStreamSummary | null = collected.providerSummary
): StrictClientToolsResult | GatewayError {
  const toolCalls = collected.toolCalls.map(providerToolCallToOpenAI);
  const parsed = parseStrictToolDecision({
    text: JSON.stringify(
      toolCalls.length > 0
        ? { type: "tool_calls", tool_calls: toolCalls }
        : { type: "message", content: collected.content }
    ),
    tools: input.request.tools ?? [],
    toolChoice,
    createToolCallId
  });
  if (parsed instanceof GatewayError) {
    return providerSummary
      ? attachProviderStreamSummary(parsed, providerSummary)
      : parsed;
  }
  const result = strictDecisionToResult(parsed, usage, providerSummary);
  if (result.toolCalls.length > 0 && collected.content.length > 0) {
    result.content = collected.content;
  }
  return result;
}

interface NativeAutoToolRetryPlan {
  kind:
    | "auto_ack_to_required"
    | "auto_ack_to_auto"
    | "auto_ack_after_tool_to_auto"
    | "auto_empty_to_auto";
  toolChoice: ChatCompletionRequest["toolChoice"];
  prompt: string;
}

interface NativeValidationRetryPlan {
  kind: "validation_failed_to_same" | "validation_failed_to_auto";
  toolChoice: ChatCompletionRequest["toolChoice"];
  validationToolChoice: ChatCompletionRequest["toolChoice"];
  prompt: string;
}

function nativeAutoToolRetryPlan(
  request: ChatCompletionRequest,
  upstreamModel: string,
  attemptedToolChoice: ChatCompletionRequest["toolChoice"],
  result: StrictClientToolsResult,
  prompt: string,
  forceRequiredMode: NativeToolForceRequiredMode
): NativeAutoToolRetryPlan | null {
  if (request.preserveAutoToolChoice) {
    return null;
  }
  const shouldRetry =
    request.toolChoice === "auto" &&
    attemptedToolChoice === "auto" &&
    result.toolCalls.length === 0;
  if (!shouldRetry) {
    return null;
  }

  if (looksLikeSilentNativeToolNoop(request, result.content)) {
    return {
      kind: "auto_empty_to_auto",
      toolChoice: "auto",
      prompt: nativeToolEmptyRetryPrompt(prompt)
    };
  }

  if (!looksLikeToolUseAcknowledgement(result.content)) {
    return null;
  }

  const completedToolRound = hasCompletedClientToolRound(request);
  // This safety invariant intentionally overrides legacy mode: legacy restores
  // the old initial-choice classifier for diagnostics, never the post-tool loop vector.
  if (completedToolRound) {
    return {
      kind: "auto_ack_after_tool_to_auto",
      toolChoice: "auto",
      prompt: nativePostToolAcknowledgementRetryPrompt(prompt)
    };
  }

  const shouldForceRequired =
    forceRequiredMode === "legacy" ||
    (forceRequiredMode === "first_step" &&
      shouldRequireNativeToolForFileGeneration(request, upstreamModel, forceRequiredMode));
  const shouldUseStrongAutoPrompt =
    usesAutoOnlyNativeTools(upstreamModel) && isFirstStepNativeFileGenerationTask(request);
  if (usesAutoOnlyNativeTools(upstreamModel) || !shouldForceRequired) {
    return {
      kind: "auto_ack_to_auto",
      toolChoice: "auto",
      prompt: shouldForceRequired || shouldUseStrongAutoPrompt
        ? nativeToolAcknowledgementRetryPrompt(prompt)
        : nativeAutoAcknowledgementRetryPrompt(prompt)
    };
  }
  return {
    kind: "auto_ack_to_required",
    toolChoice: "required",
    prompt
  };
}

function nativeValidationRetryPlan(
  request: ChatCompletionRequest,
  upstreamModel: string,
  attemptedToolChoice: ChatCompletionRequest["toolChoice"],
  error: GatewayError,
  prompt: string
): NativeValidationRetryPlan | null {
  if (error.code !== "tool_call_validation_failed") {
    return null;
  }

  const retryToolChoice = usesAutoRetryNativeTools(upstreamModel)
    ? "auto"
    : attemptedToolChoice;
  return {
    kind: retryToolChoice === attemptedToolChoice
      ? "validation_failed_to_same"
      : "validation_failed_to_auto",
    toolChoice: retryToolChoice,
    validationToolChoice: attemptedToolChoice,
    prompt: nativeToolValidationRetryPrompt(prompt, error.message, attemptedToolChoice, request)
  };
}

type NativeToolForceRequiredMode = "first_step" | "disabled" | "legacy";

function parseNativeToolForceRequiredMode(
  value: string | undefined,
  onWarning?: (message: string) => void
): NativeToolForceRequiredMode {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized === "first_step") {
    return "first_step";
  }
  if (normalized === "disabled" || normalized === "legacy") {
    return normalized;
  }
  onWarning?.(
    `Invalid MEDCODE_NATIVE_TOOL_FORCE_REQUIRED_MODE=${value}; using first_step.`
  );
  return "first_step";
}

function initialNativeToolChoice(
  request: ChatCompletionRequest,
  upstreamModel: string,
  forceRequiredMode: NativeToolForceRequiredMode
): ChatCompletionRequest["toolChoice"] {
  if (request.preserveAutoToolChoice) {
    return request.toolChoice;
  }
  return shouldRequireNativeToolForFileGeneration(request, upstreamModel, forceRequiredMode)
    ? "required"
    : request.toolChoice;
}

function shouldRequireNativeToolForFileGeneration(
  request: ChatCompletionRequest,
  upstreamModel: string,
  forceRequiredMode: NativeToolForceRequiredMode
): boolean {
  if (forceRequiredMode === "disabled") {
    return false;
  }
  if (request.toolChoice !== "auto" || !request.tools?.length) {
    return false;
  }
  if (usesAutoOnlyNativeTools(upstreamModel)) {
    return false;
  }
  if (!request.tools.some((tool) => looksLikeFileOrCodeTool(tool))) {
    return false;
  }
  if (forceRequiredMode === "legacy") {
    return looksLikeLegacyFileGenerationTask(request);
  }
  return isFirstStepNativeFileGenerationTask(request);
}

function isFirstStepNativeFileGenerationTask(request: ChatCompletionRequest): boolean {
  return (
    request.toolChoice === "auto" &&
    request.tools?.some((tool) => looksLikeFileOrCodeTool(tool)) === true &&
    !hasCompletedClientToolRound(request) &&
    looksLikeFileGenerationTask(request)
  );
}

function looksLikeSilentNativeToolNoop(request: ChatCompletionRequest, content: string): boolean {
  return (
    content.trim().length === 0 &&
    request.tools?.some((tool) => looksLikeFileOrCodeTool(tool)) === true &&
    looksLikeFileGenerationTask(request)
  );
}

const modelsWithAutoOnlyNativeTools = new Set(["glm-5-turbo"]);
const modelsWithAutoRetryNativeTools = new Set(["glm-5.2", "glm-5-turbo"]);

function usesAutoOnlyNativeTools(upstreamModel: string): boolean {
  return modelsWithAutoOnlyNativeTools.has(normalizedNativeToolModelName(upstreamModel));
}

function usesAutoRetryNativeTools(upstreamModel: string): boolean {
  return modelsWithAutoRetryNativeTools.has(normalizedNativeToolModelName(upstreamModel));
}

function normalizedNativeToolModelName(upstreamModel: string): string {
  return upstreamModel.toLowerCase().split("/").pop() ?? upstreamModel.toLowerCase();
}

function nativeToolAcknowledgementRetryPrompt(prompt: string): string {
  return [
    prompt,
    "",
    "The previous assistant output only acknowledged the task. Complete the user's requested task now by calling one of the client-declared tools. Do not send another acknowledgement or plain-text description."
  ].join("\n");
}

function nativeAutoAcknowledgementRetryPrompt(prompt: string): string {
  return [
    prompt,
    "",
    "The previous assistant output only acknowledged the task. Do not send another acknowledgement.",
    "If a client-declared tool is genuinely needed, call it now; otherwise provide the final answer now."
  ].join("\n");
}

function nativePostToolAcknowledgementRetryPrompt(prompt: string): string {
  return [
    prompt,
    "",
    "The previous assistant output only acknowledged the task after client tools had already run. Do not send another acknowledgement.",
    "If another client-declared tool call is genuinely needed, call it now; otherwise provide the final answer now using the available tool results."
  ].join("\n");
}

function nativeToolEmptyRetryPrompt(prompt: string): string {
  return [
    prompt,
    "",
    "The previous assistant output was empty and did not call any client-declared tool.",
    "Complete the user's requested file or artifact task now by calling one of the client-declared tools.",
    "Do not return an empty message or a plain-text acknowledgement."
  ].join("\n");
}

function nativeToolValidationRetryPrompt(
  prompt: string,
  validationError: string,
  validationToolChoice: ChatCompletionRequest["toolChoice"],
  request: ChatCompletionRequest
): string {
  return [
    prompt,
    "",
    "The previous assistant tool response was rejected by the gateway.",
    nativeToolValidationRetryInstruction(validationToolChoice, request),
    "Use only client-declared tool names and make the arguments satisfy the selected tool's JSON Schema.",
    "Do not answer in plain text when a tool call is required.",
    "",
    "<validation_error>",
    validationError,
    "</validation_error>"
  ].join("\n");
}

function nativeToolValidationRetryInstruction(
  toolChoice: ChatCompletionRequest["toolChoice"],
  request: ChatCompletionRequest
): string {
  if (toolChoice === "required") {
    return "Call at least one client-declared tool now.";
  }
  const forcedToolName = typeof toolChoice === "object" ? toolChoice.function.name : null;
  if (forcedToolName) {
    return `Call the client-declared tool named ${forcedToolName} now.`;
  }
  if (request.tools?.some((tool) => looksLikeFileOrCodeTool(tool)) && looksLikeFileGenerationTask(request)) {
    return "Complete the requested file or artifact task by calling a valid client-declared tool now.";
  }
  return "If you call a tool, call a valid client-declared tool with schema-valid arguments.";
}

function looksLikeFileOrCodeTool(tool: NonNullable<ChatCompletionRequest["tools"]>[number]): boolean {
  const name = tool.function.name.toLowerCase();
  const description = tool.function.description?.toLowerCase() ?? "";
  return /(^|[_-])(write|edit|create|save|patch|apply|replace)([_-]|$)/.test(name) ||
    /\b(file|fs|workspace|code)\b/.test(name) ||
    /\b(write|edit|create|save|patch|replace).{0,40}\b(file|workspace|code)\b/.test(description);
}

function hasCompletedClientToolRound(request: ChatCompletionRequest): boolean {
  return request.messages.some(
    (message) =>
      message.role === "tool" ||
      (message.role === "assistant" && (message.tool_calls?.length ?? 0) > 0)
  );
}

function latestUserText(request: ChatCompletionRequest): string {
  for (let index = request.messages.length - 1; index >= 0; index -= 1) {
    const message = request.messages[index];
    if (message?.role === "user" && typeof message.content === "string") {
      return message.content;
    }
  }
  return "";
}

function looksLikeLegacyFileGenerationTask(request: ChatCompletionRequest): boolean {
  const text = request.messages
    .map((message) => (typeof message.content === "string" ? message.content : ""))
    .join("\n")
    .toLowerCase();
  return looksLikeFileGenerationText(text);
}

function looksLikeFileGenerationTask(request: ChatCompletionRequest): boolean {
  return looksLikeFileGenerationText(latestUserText(request).toLowerCase());
}

function looksLikeFileGenerationText(text: string): boolean {
  if (!text.trim()) {
    return false;
  }
  return /(<html|html|javascript|css|代码|页面|文件|成品|互动|动画|超链接|跳转|\bcode\b|\bfile\b|\bpage\b|\bapp\b|\bcomponent\b)/i.test(text) &&
    /(写|创建|生成|做|给我|\u66f4\u6539|\u4fee\u6539|\u8c03\u6574|\u4fee\u590d|build|create|generate|write|make|update|change|edit|fix)/i.test(text);
}

function looksLikeToolUseAcknowledgement(content: string): boolean {
  const normalized = content.trim().toLowerCase();
  if (!normalized || normalized.length > 180) {
    return false;
  }

  return [
    /^i(?:'| a)m\s+(?:going\s+to\s+)?(?:create|write|build|generate|make)\b/,
    /^i\s+will\s+(?:create|write|build|generate|make)\b/,
    /^i(?:'| wi)ll\s+(?:create|write|build|generate|make)\b/,
    /^let\s+me\s+(?:create|write|build|generate|make)\b/,
    /^sure[,.\s]+i(?:'| wi)ll\s+(?:create|write|build|generate|make)\b/,
    /^ok(?:ay)?[,.\s]+i(?:'| wi)ll\s+(?:create|write|build|generate|make)\b/,
    /^(?:\u6211\u6765|\u6211\u73b0\u5728|\u597d\u7684[,\uFF0C]?\u6211\u6765)/
  ].some((pattern) => pattern.test(normalized));
}

async function runStrictClientTools(
  input: StrictClientToolsInput
): Promise<StrictClientToolsResult | GatewayError> {
  const first = await collectStrictToolDecision(input, input.prompt, "strict_initial");
  if (first instanceof GatewayError) {
    return first;
  }

  const firstUsage = openAIUsageFromTokenUsage(first.collected.usage);
  const parsed = first.parsed;
  if (!(parsed instanceof GatewayError)) {
      return strictDecisionToResult(parsed, firstUsage, first.collected.providerSummary);
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
    invalidOutput: first.collected.content,
    validationError: parsed.message
  });
  const repaired = await collectStrictToolDecision(input, repairPrompt, "strict_repair");
  if (repaired instanceof GatewayError) {
    const repairedSummary = providerStreamSummaryFromError(repaired);
    return repairedSummary
      ? attachProviderStreamSummary(
          repaired,
          combineProviderStreamSummaries([first.collected.providerSummary, repairedSummary]) ??
            repairedSummary
        )
      : repaired;
  }

  const repairedParsed = repaired.parsed;
  if (repairedParsed instanceof GatewayError) {
    const repairedCompletionError = providerCompletionError(
      repaired.collected.providerSummary
    );
    if (repairedCompletionError) {
      const repairedErrorSummary =
        providerStreamSummaryFromError(repairedCompletionError) ??
        repaired.collected.providerSummary;
      return attachProviderStreamSummary(
        repairedCompletionError,
        combineProviderStreamSummaries([
          first.collected.providerSummary,
          repairedErrorSummary
        ]) ?? repairedErrorSummary
      );
    }
    if (
      shouldFallbackStrictAutoPlainText({
        toolChoice: input.request.toolChoice,
        firstValidationError: parsed.message,
        repairValidationError: repairedParsed.message,
        firstOutput: first.collected.content
      })
    ) {
      input.log?.info(
        {
          request_id: input.requestId,
          strict_tools_fallback: "auto_plain_text",
          tool_choice: "auto",
          validation_error: repairedParsed.message,
          invalid_output_chars: first.collected.content.length,
          repair_invalid_output_chars: repaired.collected.content.length
        },
        "Strict client-defined tool output fell back to plain assistant message."
      );
      return strictDecisionToResult(
        { type: "message", content: first.collected.content },
        addOpenAIUsage(firstUsage, openAIUsageFromTokenUsage(repaired.collected.usage)),
        combineProviderStreamSummaries([
          first.collected.providerSummary,
          repaired.collected.providerSummary
        ])
      );
    }

    input.log?.warn(
      {
        request_id: input.requestId,
        code: repairedParsed.code,
        validation_error: repairedParsed.message,
        strict_tools_repair: false
      },
      "Strict client-defined tool output repair failed validation."
    );
    return attachProviderStreamSummary(
      repairedParsed,
      combineProviderStreamSummaries([
        first.collected.providerSummary,
        repaired.collected.providerSummary
      ]) ?? repaired.collected.providerSummary
    );
  }

  input.log?.info(
    {
      request_id: input.requestId,
      strict_tools_repaired: true
    },
    "Strict client-defined tool output repaired successfully."
  );

  return strictDecisionToResult(
    repairedParsed,
    addOpenAIUsage(firstUsage, openAIUsageFromTokenUsage(repaired.collected.usage)),
    combineProviderStreamSummaries([
      first.collected.providerSummary,
      repaired.collected.providerSummary
    ])
  );
}

function shouldFallbackStrictAutoPlainText(input: {
  toolChoice: ChatCompletionRequest["toolChoice"];
  firstValidationError: string;
  repairValidationError: string;
  firstOutput: string;
}): boolean {
  return (
    input.toolChoice === "auto" &&
    input.firstValidationError === "Expected valid JSON object output." &&
    input.repairValidationError === "Expected valid JSON object output." &&
    input.firstOutput.trim().length > 0 &&
    !looksLikeStrictToolOutputAttempt(input.firstOutput)
  );
}

function looksLikeStrictToolOutputAttempt(output: string): boolean {
  const trimmed = output.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[") || /^```(?:json)?\s*[\[{]/i.test(trimmed)) {
    return true;
  }
  return [
    /["']type["']\s*:\s*["']tool_calls["']/i,
    /["']tool_calls["']\s*:/i,
    /["']function["']\s*:/i,
    /["']arguments["']\s*:/i,
    /\btool_calls?\b/i,
    /\bfunction_call\b/i,
    /<tool_call\b/i
  ].some((pattern) => pattern.test(trimmed));
}

async function collectStrictToolDecision(
  input: StrictClientToolsInput,
  prompt: string,
  attemptKind: string
): Promise<StrictToolCollection | GatewayError> {
  const collected = await collectProviderMessage({
    provider: input.provider,
    upstreamAccount: input.upstreamAccount,
    subject: input.subject,
    scope: input.scope,
    session: input.session,
    message: prompt,
    reasoningEffort: input.reasoningEffort,
    attemptKind,
    attemptToolChoice: serializeToolChoice(input.request.toolChoice),
    upstreamRuntime: input.upstreamRuntime,
    upstreamModel: input.upstreamModel,
    signal: input.signal,
    onProviderError: input.onProviderError,
    suppressToolCalls: true,
    deferEmptyCompletionError: true
  });
  if (collected instanceof GatewayError) {
    return collected;
  }

  return {
    collected,
    parsed: parseStrictToolDecision({
      text: collected.content,
      tools: input.request.tools ?? [],
      toolChoice: input.request.toolChoice,
      createToolCallId
    })
  };
}

function strictDecisionToResult(
  decision: StrictToolDecision,
  usage: OpenAIChatUsage | null,
  providerSummary: ProviderStreamSummary | null = null
): StrictClientToolsResult {
  if (decision.type === "message") {
    return {
      content: decision.content,
      toolCalls: [],
      usage,
      providerSummary
    };
  }

  return {
    content: "",
    toolCalls: decision.toolCalls,
    usage,
    providerSummary
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
    arguments: parsedArguments,
    argumentsJson: toolCall.function.arguments
  };
}

function providerToolCallToOpenAI(toolCall: ProviderToolCall): OpenAIChatToolCall {
  return {
    id: toolCall.id,
    type: "function",
    function: {
      name: toolCall.name,
      arguments: toolCall.argumentsJson ?? JSON.stringify(toolCall.arguments ?? {})
    }
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
      : {}),
    ...(usage.completion_tokens_details?.reasoning_tokens !== undefined
      ? { reasoningTokens: usage.completion_tokens_details.reasoning_tokens }
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
  const reasoningTokens =
    (first.completion_tokens_details?.reasoning_tokens ?? 0) +
    (second.completion_tokens_details?.reasoning_tokens ?? 0);
  return {
    prompt_tokens: first.prompt_tokens + second.prompt_tokens,
    completion_tokens: first.completion_tokens + second.completion_tokens,
    total_tokens: first.total_tokens + second.total_tokens,
    ...(cachedTokens > 0 ? { prompt_tokens_details: { cached_tokens: cachedTokens } } : {}),
    ...(first.completion_tokens_details || second.completion_tokens_details
      ? { completion_tokens_details: { reasoning_tokens: reasoningTokens } }
      : {})
  };
}

async function main() {
  validateRuntimeEnvironment(process.env);
  const cleanup = cleanupStaleCodexRuntimeStateDirs();
  if (cleanup.errors > 0) {
    console.warn("Codex runtime state startup cleanup.", cleanup);
  } else if (cleanup.removed > 0) {
    console.info("Codex runtime state startup cleanup.", cleanup);
  }
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
  inferUpstreamRateLimitOrigin(request, error);
  markGatewayError(request, error);
  const errorContext = gatewayErrorResponseContext(request);
  applyGatewayErrorHeaders(reply, error, errorContext);
  reply.code(error.httpStatus);
  if (request.routeOptions.config?.responseDialect === "research") {
    return researchErrorPayload(error, errorContext);
  }
  return {
    error: {
      code: error.code,
      message: error.message,
      ...gatewayErrorMetadata(error, errorContext)
    }
  };
}

function writeOpenAIStreamError(
  request: FastifyRequest,
  reply: FastifyReply,
  sse: SseHandle,
  error: GatewayError
): boolean {
  const errorContext = gatewayErrorResponseContext(request);
  const payload = openAIErrorPayload(error, errorContext);
  if (reply.raw.headersSent) {
    return sse.writeData(payload);
  }

  applyGatewayErrorHeaders(reply, error, errorContext);
  reply.raw.statusCode = error.httpStatus;
  reply.raw.setHeader("content-type", "application/json; charset=utf-8");
  reply.raw.setHeader("cache-control", "no-store");
  try {
    return reply.raw.write(JSON.stringify(payload));
  } catch {
    return false;
  }
}

function credentialPublicModelAccessError(
  request: FastifyRequest,
  canonicalPublicModelId: string,
  aliasGroups: readonly PublicModelAliasGroup[]
): GatewayError | null {
  const { credential } = getGatewayContext(request);
  if (
    credentialAllowsPublicModel(
      credential.allowedPublicModels,
      canonicalPublicModelId,
      aliasGroups
    )
  ) {
    return null;
  }
  return new GatewayError({
    code: "model_not_allowed_for_credential",
    message: "Credential is not allowed to use this model.",
    httpStatus: 403
  });
}

function gatewayErrorResponseContext(
  request: FastifyRequest
): GatewayErrorResponseContext {
  return {
    requestId: request.id,
    limitKind: request.gatewayLimitKind,
    limitDetails: request.gatewayLimitDetails,
    rateLimitOrigin: request.gatewayRateLimitOrigin
  };
}

function inferUpstreamRateLimitOrigin(
  request: FastifyRequest,
  error: GatewayError
): void {
  if (error.code !== "rate_limited" || request.gatewayLimitKind) {
    return;
  }
  if (
    error.upstreamStatus === 429 ||
    request.gatewayUpstreamHttpStatus === 429 ||
    request.gatewayUpstreamAttempts?.some(
      (attempt) => attempt.errorCode === "rate_limited" || attempt.upstreamHttpStatus === 429
    )
  ) {
    markRateLimitOrigin(request, "upstream");
  }
}

function sendImageError(request: FastifyRequest, reply: FastifyReply, error: GatewayError) {
  inferUpstreamRateLimitOrigin(request, error);
  markGatewayError(request, error);
  const errorContext = gatewayErrorResponseContext(request);
  applyGatewayErrorHeaders(reply, error, errorContext);
  reply.code(error.httpStatus);
  return {
    error: {
      code: error.code,
      message: error.message,
      request_id: request.id,
      ...gatewayErrorMetadata(error, errorContext)
    }
  };
}

async function generateImageWithAccountPool(
  request: FastifyRequest,
  reply: FastifyReply,
  router: UpstreamAccountRouter,
  input: {
    parsed: ImageGenerationRequest;
    upstreamModel: string;
    timeoutMs: number;
    billingFallbacks: readonly ImageGenerationBillingFallback[];
  }
) {
  const affinityKey = requestAffinityKey(request, router.softAffinity);
  const attemptedAccountIds = new Set<string>();
  let lastError: GatewayError | null = null;
  const abort = createImageRequestAbort(request, reply, input.timeoutMs);

  try {
    for (let attemptIndex = 0; attemptIndex < maxStatelessAttempts; attemptIndex += 1) {
      const lease = router.beginImage({ affinityKey, excludeAccountIds: attemptedAccountIds });
      if (lease instanceof GatewayError) {
        return sendImageError(request, reply, lastError ?? lease);
      }
      attemptedAccountIds.add(lease.upstreamAccount.id);
      applyImageSelection(request, lease);

      try {
        const result = await runImageGenerationWithAbort(lease.imageProvider, abort, {
          request: input.parsed,
          upstreamModel: input.upstreamModel
        });
        const finalized = await finalizeImageGenerationResult({
          request: input.parsed,
          result
        });
        router.recordImageOutcome(lease.upstreamAccount.id, "success");
        markFirstByte(request);
        return buildImageGenerationResponse({
          request: input.parsed,
          result: finalized
        });
      } catch (err) {
        const error = imageErrorFromUnknown(err);
        const outcome = imageOutcomeFromError(error);
        if (outcome) {
          router.recordImageOutcome(lease.upstreamAccount.id, outcome);
        }
        lastError = error;
        if (isImageBillingLimitError(error) && input.billingFallbacks.length > 0) {
          try {
            return await generateImageWithBillingFallbacks(request, abort, {
              parsed: input.parsed,
              billingFallbacks: input.billingFallbacks
            });
          } catch (fallbackErr) {
            return sendImageError(request, reply, imageErrorFromUnknown(fallbackErr));
          }
        }
        if (
          abort.clientAborted() ||
          abort.timedOut() ||
          !outcome ||
          !isImageRetryableOutcome(outcome) ||
          attemptIndex + 1 >= maxStatelessAttempts
        ) {
          return sendImageError(request, reply, error);
        }
      } finally {
        lease.release();
      }
    }
  } finally {
    abort.cleanup();
  }

  return sendImageError(
    request,
    reply,
    lastError ??
      new GatewayError({
        code: "upstream_unavailable",
        message: "Image generation service is unavailable.",
        httpStatus: 503
      })
  );
}

interface ImageRequestAbort {
  signal: AbortSignal;
  promise: Promise<never>;
  cleanup: () => void;
  clientAborted: () => boolean;
  timedOut: () => boolean;
}

function createImageRequestAbort(
  request: FastifyRequest,
  reply: FastifyReply,
  timeoutMs: number
): ImageRequestAbort {
  const controller = new AbortController();
  let settled = false;
  let rejectAbort!: (error: GatewayError) => void;
  const promise = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });

  const abortWith = (reason: Error, error: GatewayError) => {
    if (settled) {
      return;
    }
    settled = true;
    controller.abort(reason);
    rejectAbort(error);
  };
  const abortClient = () =>
    abortWith(
      new Error("client_aborted"),
      new GatewayError({
        code: "client_aborted",
        message: "Client aborted image generation.",
        httpStatus: 499
      })
    );
  const timeout = setTimeout(
    () =>
      abortWith(
        new Error("gateway_image_timeout"),
        new GatewayError({
          code: "upstream_timeout",
          message: "Image generation timed out.",
          httpStatus: 504
        })
      ),
    timeoutMs
  );

  request.raw.once("aborted", abortClient);
  reply.raw.once("close", abortClient);

  return {
    signal: controller.signal,
    promise,
    cleanup: () => {
      settled = true;
      clearTimeout(timeout);
      request.raw.off("aborted", abortClient);
      reply.raw.off("close", abortClient);
    },
    clientAborted: () => isAbortReason(controller.signal.reason, "client_aborted"),
    timedOut: () => isAbortReason(controller.signal.reason, "gateway_image_timeout")
  };
}

async function runImageGenerationWithAbort(
  provider: ImageGenerationProvider,
  abort: ImageRequestAbort,
  input: {
    request: ImageGenerationRequest;
    upstreamModel: string;
  }
) {
  return Promise.race([
    provider.generate({
      ...input,
      signal: abort.signal
    }),
    abort.promise
  ]);
}

async function generateImageWithBillingFallbacks(
  request: FastifyRequest,
  abort: ImageRequestAbort,
  input: {
    parsed: ImageGenerationRequest;
    billingFallbacks: readonly ImageGenerationBillingFallback[];
  }
) {
  let lastError: GatewayError | null = null;
  for (let index = 0; index < input.billingFallbacks.length; index += 1) {
    const fallback = input.billingFallbacks[index];
    request.gatewayObservedUpstreamAccount = {
      id: fallback.accountId,
      provider: null
    };
    try {
      const result = await runImageGenerationWithAbort(fallback.provider, abort, {
        request: input.parsed,
        upstreamModel: fallback.upstreamModel
      });
      const finalized = await finalizeImageGenerationResult({
        request: input.parsed,
        result
      });
      markFirstByte(request);
      return buildImageGenerationResponse({
        request: input.parsed,
        result: finalized
      });
    } catch (err) {
      const error = imageErrorFromUnknown(err);
      lastError = error;
      if (!isImageFallbackRetryableError(error) || index + 1 >= input.billingFallbacks.length) {
        throw error;
      }
    }
  }

  throw (
    lastError ??
    new GatewayError({
      code: "upstream_unavailable",
      message: "Image generation service is unavailable.",
      httpStatus: 503
    })
  );
}

function imageErrorFromUnknown(err: unknown): GatewayError {
  return err instanceof GatewayError
    ? err
    : new GatewayError({
        code: "upstream_unavailable",
        message: "Image generation service is unavailable.",
        httpStatus: 503
      });
}

function isAbortReason(reason: unknown, message: string): boolean {
  return reason instanceof Error && reason.message === message;
}

function applyImageSelection(request: FastifyRequest, selection: UpstreamImageLease): void {
  const context = getGatewayContext(request);
  request.gatewayContext = {
    ...context,
    upstreamAccount: selection.upstreamAccount
  };
  request.gatewayObservedUpstreamAccount = {
    id: selection.upstreamAccount.id,
    provider: selection.upstreamAccount.provider
  };
}

function imageOutcomeFromError(error: GatewayError): ImageProviderOutcome | null {
  if (error.upstreamStatus === 401 || error.upstreamStatus === 403) {
    return "key_invalid";
  }
  if (isImageBillingLimitError(error)) {
    return "service_error";
  }
  if (error.code === "rate_limited") {
    return "rate_limited";
  }
  if (error.code === "upstream_timeout") {
    return "upstream_timeout";
  }
  if (error.code === "content_policy_violation") {
    return "content_policy_violation";
  }
  if (error.code === "invalid_request") {
    return "invalid_request";
  }
  if (error.code === "upstream_unavailable" || error.code === "service_unavailable") {
    return "service_error";
  }
  return null;
}

function isImageRetryableOutcome(outcome: ImageProviderOutcome): boolean {
  return (
    outcome === "rate_limited" ||
    outcome === "service_error" ||
    outcome === "upstream_timeout" ||
    outcome === "key_invalid"
  );
}

function isImageFallbackRetryableError(error: GatewayError): boolean {
  if (isImageBillingLimitError(error)) {
    return true;
  }
  const outcome = imageOutcomeFromError(error);
  return outcome !== null && isImageRetryableOutcome(outcome);
}

function sendOpenAIError(request: FastifyRequest, reply: FastifyReply, error: GatewayError) {
  inferUpstreamRateLimitOrigin(request, error);
  markGatewayError(request, error);
  if (error.upstreamStatus !== undefined) {
    request.gatewayUpstreamHttpStatus = error.upstreamStatus;
  }
  const errorContext = gatewayErrorResponseContext(request);
  applyGatewayErrorHeaders(reply, error, errorContext);
  reply.code(error.httpStatus);
  return openAIErrorPayload(error, errorContext);
}

function chatCompletionExecutionFailure(
  error: GatewayError
): ChatCompletionExecutionFailure {
  return {
    __chatCompletionExecutionFailure: true,
    error
  };
}

function isChatCompletionExecutionFailure(
  value: unknown
): value is ChatCompletionExecutionFailure {
  return (
    typeof value === "object" &&
    value !== null &&
    "__chatCompletionExecutionFailure" in value &&
    (value as ChatCompletionExecutionFailure).__chatCompletionExecutionFailure === true
  );
}

function chatCompletionErrorFromUnknown(err: unknown): GatewayError {
  return err instanceof GatewayError
    ? err
    : new GatewayError({
        code: "service_unavailable",
        message: "GoldenCode service is temporarily unavailable.",
        httpStatus: 503
      });
}

function writeResponsesFailure(
  request: FastifyRequest,
  sse: SseHandle,
  frame: ResponsesSseEvent,
  error: GatewayError
): void {
  markGatewayError(request, error);
  request.gatewayErrorCode = error.code;
  if (!sse.isClosed()) {
    sse.writeEvent(frame.event, frame.data);
  }
}

function sendGatewayErrorResponse(
  request: FastifyRequest,
  reply: FastifyReply,
  error: GatewayError
): FastifyReply {
  markGatewayError(request, error);
  return reply.code(error.httpStatus).send({
    error: {
      code: error.code,
      message: error.message,
      retry_after_seconds: error.retryAfterSeconds
    }
  });
}

function parseClientSubscriptionPauseRequest(
  body: unknown
): { reason: string | null } | GatewayError {
  if (body === undefined || body === null) {
    return { reason: null };
  }
  if (typeof body !== "object" || Array.isArray(body)) {
    return new GatewayError({
      code: "invalid_request",
      message: "Request body must be a JSON object.",
      httpStatus: 400
    });
  }

  const value = body as Record<string, unknown>;
  const allowed = new Set(["reason"]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      return new GatewayError({
        code: "invalid_request",
        message: "Request body may only include reason.",
        httpStatus: 400
      });
    }
  }

  if (value.reason === undefined || value.reason === null) {
    return { reason: null };
  }
  if (typeof value.reason !== "string") {
    return new GatewayError({
      code: "invalid_request",
      message: "reason must be a string.",
      httpStatus: 400
    });
  }
  const reason = value.reason.trim();
  if (reason.length > 200) {
    return new GatewayError({
      code: "invalid_request",
      message: "reason must be 200 characters or fewer.",
      httpStatus: 400
    });
  }
  return { reason: reason || null };
}

function clientSubscriptionPauseResponse(input: {
  subject: Subject;
  entitlement: Entitlement;
  planEntitlementStore: PlanEntitlementStore;
  alreadyPaused: boolean;
}) {
  const plan = input.planEntitlementStore.getPlan(input.entitlement.planId);
  return {
    paused: true,
    already_paused: input.alreadyPaused,
    subject: {
      id: input.subject.id,
      label: input.subject.label
    },
    ...(plan
      ? {
          plan: {
            display_name: plan.displayName,
            scope_allowlist: input.entitlement.scopeAllowlist
          }
        }
      : {}),
    entitlement: {
      period_kind: input.entitlement.periodKind,
      period_start: input.entitlement.periodStart.toISOString(),
      period_end: input.entitlement.periodEnd?.toISOString() ?? null,
      state: input.entitlement.state,
      feature_policy: publicFeaturePolicy(input.entitlement.featurePolicySnapshot),
      ...(input.entitlement.state === "paused" ? { reason: "paused" } : {})
    }
  };
}

function clientSubscriptionPauseError(err: unknown): GatewayError {
  if (err instanceof GatewayError) {
    return err;
  }

  const message = err instanceof Error ? err.message : String(err);
  if (message.startsWith("Entitlement not found")) {
    return new GatewayError({
      code: "entitlement_not_found",
      message: "No active subscription is available to pause.",
      httpStatus: 404
    });
  }
  if (message.startsWith("Invalid entitlement state transition")) {
    return new GatewayError({
      code: "invalid_entitlement_transition",
      message,
      httpStatus: 409
    });
  }
  return new GatewayError({
    code: "service_unavailable",
    message: "Subscription pause service is unavailable.",
    httpStatus: 503
  });
}

function authenticateClientSubscriptionPauseBearer(
  request: FastifyRequest,
  options: {
    credentialStore: CredentialAuthStore;
    unifiedClientKeyStore?: UnifiedClientKeyStore;
    provider: ProviderAdapter;
    upstreamAccount: UpstreamAccount;
    now?: () => Date;
  }
): GatewayRequestContext | GatewayError {
  const token = bearerToken(request, invalidAccessCredentialError);
  if (token instanceof GatewayError) {
    return token;
  }

  const unifiedPrefix = extractUnifiedClientKeyPrefix(token);
  if (unifiedPrefix) {
    return authenticateClientPauseUnifiedKey(token, unifiedPrefix, options);
  }

  const credentialPrefix = extractAccessCredentialPrefix(token);
  if (!credentialPrefix) {
    return invalidAccessCredentialError();
  }
  const credential = options.credentialStore.getAccessCredentialByPrefix(credentialPrefix);
  if (!credential) {
    return invalidAccessCredentialError();
  }

  const tokenError = verifyAccessCredentialToken(
    token,
    credential,
    options.now?.() ?? new Date()
  );
  if (tokenError) {
    return tokenError;
  }

  const subject = options.credentialStore.getSubject(credential.subjectId);
  if (!subject || subject.state !== "active") {
    return invalidAccessCredentialError();
  }

  return {
    subject,
    upstreamAccount: options.upstreamAccount,
    provider: options.provider,
    scope: credential.scope,
    credential: {
      id: credential.id,
      prefix: credential.prefix,
      label: credential.label,
      expiresAt: credential.expiresAt,
      rate: credential.rate,
      allowedPublicModels: credential.allowedPublicModels
    }
  };
}

function authenticateClientPauseUnifiedKey(
  token: string,
  prefix: string,
  options: {
    credentialStore: CredentialAuthStore;
    unifiedClientKeyStore?: UnifiedClientKeyStore;
    provider: ProviderAdapter;
    upstreamAccount: UpstreamAccount;
    now?: () => Date;
  }
): GatewayRequestContext | GatewayError {
  if (!options.unifiedClientKeyStore) {
    return invalidAccessCredentialError();
  }

  const now = options.now?.() ?? new Date();
  const record = options.unifiedClientKeyStore.getUnifiedClientKeyByPrefix(prefix);
  if (!record) {
    return invalidAccessCredentialError();
  }

  const unifiedError = verifyUnifiedClientKeyToken(token, record, now);
  if (unifiedError) {
    return unifiedError;
  }

  const subject = options.credentialStore.getSubject(record.subjectId);
  if (!subject || subject.state !== "active") {
    return invalidAccessCredentialError();
  }

  const credential = options.credentialStore.getAccessCredentialByPrefix(
    record.codexCredentialPrefix
  );
  if (
    !credential ||
    credential.id !== record.codexCredentialId ||
    credential.subjectId !== record.subjectId
  ) {
    return invalidAccessCredentialError();
  }
  if (credential.revokedAt) {
    return new GatewayError({
      code: "revoked_credential",
      message: "Access credential has been revoked.",
      httpStatus: 401
    });
  }
  if (credential.expiresAt.getTime() <= now.getTime()) {
    return new GatewayError({
      code: "expired_credential",
      message: "Access credential has expired.",
      httpStatus: 401
    });
  }

  return {
    subject,
    upstreamAccount: options.upstreamAccount,
    provider: options.provider,
    scope: credential.scope,
    credential: {
      id: credential.id,
      prefix: credential.prefix,
      label: credential.label,
      expiresAt: credential.expiresAt,
      rate: credential.rate,
      allowedPublicModels: credential.allowedPublicModels
    }
  };
}

function authenticateUnifiedClientKeyBearer(
  request: FastifyRequest,
  options: {
    store: UnifiedClientKeyStore;
    subjectStore: SubjectStore;
    now?: () => Date;
  }
): { record: NonNullable<ReturnType<UnifiedClientKeyStore["getUnifiedClientKeyByPrefix"]>>; subject: Subject } | GatewayError {
  const token = bearerToken(request);
  if (token instanceof GatewayError) {
    return token;
  }

  const prefix = extractUnifiedClientKeyPrefix(token);
  if (!prefix) {
    return invalidUnifiedKeyError();
  }

  const record = options.store.getUnifiedClientKeyByPrefix(prefix);
  if (!record) {
    return invalidUnifiedKeyError();
  }

  const tokenError = verifyUnifiedClientKeyToken(token, record, options.now?.() ?? new Date());
  if (tokenError) {
    return tokenError;
  }

  const subject = options.subjectStore.getSubject(record.subjectId);
  if (!subject || subject.state !== "active") {
    return invalidUnifiedKeyError();
  }

  return { record, subject };
}

function validateBackingGatewayCredential(input: {
  store: CredentialAuthStore;
  record: UnifiedClientKeyRecord;
  codexApiKey: string;
  now?: () => Date;
}): GatewayError | null {
  const credential = input.store.getAccessCredentialByPrefix(input.record.codexCredentialPrefix);
  if (
    !credential ||
    credential.id !== input.record.codexCredentialId ||
    credential.subjectId !== input.record.subjectId
  ) {
    return invalidUnifiedKeyError();
  }
  return verifyAccessCredentialToken(input.codexApiKey, credential, input.now?.() ?? new Date());
}

function recordUnifiedKeyResolveAudit(
  store: AdminAuditStore | undefined,
  record: UnifiedClientKeyRecord,
  logger: FastifyRequest["log"]
): void {
  if (!store) {
    return;
  }
  try {
    store.insertAdminAuditEvent({
      id: `audit_${randomUUID()}`,
      action: "unified-key-resolve",
      targetUserId: record.subjectId,
      targetCredentialId: record.id,
      targetCredentialPrefix: record.prefix,
      status: "ok",
      params: {
        codex_credential_prefix: record.codexCredentialPrefix,
        medevidence_key_prefix: record.medevidenceKeyPrefix
      },
      errorMessage: null,
      createdAt: new Date()
    });
  } catch (err) {
    logger.warn(
      {
        error: err instanceof Error ? err.message : String(err),
        unified_key_prefix: record.prefix
      },
      "Failed to write unified key resolve audit event."
    );
  }
}

function bearerToken(
  request: FastifyRequest,
  invalidError: () => GatewayError = invalidUnifiedKeyError
): string | GatewayError {
  const authorization = request.headers.authorization;
  if (!authorization) {
    return new GatewayError({
      code: "missing_credential",
      message: "Missing bearer credential.",
      httpStatus: 401
    });
  }

  const [scheme, token] = authorization.split(/\s+/, 2);
  if (scheme?.toLowerCase() !== "bearer" || !token) {
    return invalidError();
  }
  return token;
}

function invalidUnifiedKeyError(): GatewayError {
  return new GatewayError({
    code: "invalid_credential",
    message: "Invalid unified key.",
    httpStatus: 401
  });
}

function invalidAccessCredentialError(): GatewayError {
  return new GatewayError({
    code: "invalid_credential",
    message: "Invalid access credential.",
    httpStatus: 401
  });
}

function normalizeBaseUrl(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.replace(/\/+$/, "");
}

function metadataString(metadata: Record<string, unknown> | null, key: string): string | null {
  const value = metadata?.[key];
  return typeof value === "string" ? value : null;
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
  strictClientTools: boolean,
  runtime: ChatRuntimeContext["runtime"]
): string {
  const runtimeExtra =
    runtimeAddsOpenAICompatibleIdentityGuard(runtime)
      ? "OpenRouter identity guard is added as an internal system message."
      : "";
  if (strictClientTools) {
    return runtimeExtra;
  }
  const base = {
    tools: request.tools ?? null,
    tool_choice: request.toolChoice
  };
  if (!runtimeExtra) {
    return JSON.stringify(base);
  }
  return JSON.stringify({
    ...base,
    runtime_extra: runtimeExtra
  });
}

function hasNativeClientTools(
  request: ChatCompletionRequest,
  publicModel: PublicModelConfig
): boolean {
  return usesOpenAICompatiblePublicRuntime(publicModel.runtime) && hasStrictClientTools(request);
}

function isOpenAICompatibleRuntime(runtime: PublicModelConfig["runtime"]): boolean {
  return (
    runtime === "openrouter" ||
    runtime === "qianfan" ||
    runtime === "aliyun" ||
    runtime === "tencent"
  );
}

function usesOpenAICompatiblePublicRuntime(runtime: PublicModelConfig["runtime"]): boolean {
  return isOpenAICompatibleRuntime(runtime) || runtime === "pool";
}

function runtimeAddsOpenAICompatibleIdentityGuard(
  runtime: ChatRuntimeContext["runtime"]
): boolean {
  return runtime === "openrouter";
}

function createStatelessSession(subjectId: string, upstreamAccountId: string): GatewaySession {
  const now = new Date();
  return {
    id: `sess_stateless_${randomUUID().replaceAll("-", "")}`,
    subjectId,
    upstreamAccountId,
    publicModelId: null,
    providerSessionRef: null,
    title: null,
    state: "active",
    createdAt: now,
    updatedAt: now
  };
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

function parseRequiredPositiveIntegerEnv(
  value: string | undefined,
  name: string
): number {
  const normalized = value?.trim();
  if (!normalized) {
    throw new Error(`${name} is required when Research API is enabled.`);
  }
  if (!/^[1-9][0-9]*$/u.test(normalized)) {
    throw new Error(`${name} must be a positive integer.`);
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${name} exceeds the safe integer range.`);
  }
  return parsed;
}

function parseRequiredResearchSecondsEnv(
  value: string | undefined,
  name: string
): number {
  const seconds = parseRequiredPositiveIntegerEnv(value, name);
  if (!Number.isSafeInteger(seconds * 1_000)) {
    throw new Error(`${name} exceeds the safe millisecond range.`);
  }
  return seconds;
}

interface ResearchLlmReadinessRequirements {
  maximumPromptTokensPerCall: number;
  maximumOutputTokensPerCall: number;
  callsPerRun: number;
  maximumTokensPerRun: number;
}

function parseResearchLlmReadinessRequirements(input: {
  maximum_prompt_tokens_per_call?: string;
  maximum_output_tokens_per_call?: string;
  calls_per_run?: string;
  maximum_tokens_per_run?: string;
}): ResearchLlmReadinessRequirements {
  const maximumPromptTokensPerCall = boundedReadinessInteger(
    input.maximum_prompt_tokens_per_call,
    "maximum_prompt_tokens_per_call",
    1_000_000
  );
  const maximumOutputTokensPerCall = boundedReadinessInteger(
    input.maximum_output_tokens_per_call,
    "maximum_output_tokens_per_call",
    100_000
  );
  const callsPerRun = boundedReadinessInteger(
    input.calls_per_run,
    "calls_per_run",
    3
  );
  const maximumTokensPerRun = boundedReadinessInteger(
    input.maximum_tokens_per_run,
    "maximum_tokens_per_run",
    1_100_000
  );
  if (
    maximumTokensPerRun <
      maximumPromptTokensPerCall + maximumOutputTokensPerCall
  ) {
    throw researchReadinessInvalidRequest(
      "maximum_tokens_per_run must cover one maximum-size model call."
    );
  }
  return {
    maximumPromptTokensPerCall,
    maximumOutputTokensPerCall,
    callsPerRun,
    maximumTokensPerRun
  };
}

function boundedReadinessInteger(
  value: string | undefined,
  name: string,
  maximum: number
): number {
  const normalized = value?.trim();
  if (!normalized || !/^[1-9][0-9]*$/u.test(normalized)) {
    throw researchReadinessInvalidRequest(
      `${name} must be a positive integer.`
    );
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed > maximum) {
    throw researchReadinessInvalidRequest(
      `${name} exceeds its controlled-beta bound.`
    );
  }
  return parsed;
}

function researchReadinessInvalidRequest(message: string): GatewayError {
  return new GatewayError({
    code: "invalid_request",
    message,
    httpStatus: 400
  });
}

function parseOptionalPositiveInteger(value: string | undefined): number | undefined {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    return undefined;
  }
  return parsed;
}

function parseOptionalBoolean(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes(String(value ?? "").trim().toLowerCase());
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

function resolveNativeSessionPublicModel(
  registry: PublicModelRegistry,
  env: NodeJS.ProcessEnv
): PublicModelConfig | null {
  const configuredId = env.GATEWAY_NATIVE_SESSION_PUBLIC_MODEL_ID?.trim();
  let model: PublicModelConfig | null | undefined;
  if (configuredId) {
    model = registry.get(configuredId);
  } else {
    const codexModels = registry.models.filter(
      (candidate) => candidate.runtime === "codex" && candidate.enabled
    );
    model =
      codexModels.find((candidate) => candidate.id === "max") ??
      codexModels.find((candidate) =>
        candidate.aliases.includes("medcode")
      ) ??
      (codexModels.length === 1 ? codexModels[0] : null);
  }
  if (configuredId && (!model || model.runtime !== "codex" || !model.enabled)) {
    throw new Error(
      "GATEWAY_NATIVE_SESSION_PUBLIC_MODEL_ID must identify one enabled codex public model."
    );
  }
  return model ?? null;
}

function nativeSessionsUnavailable(): GatewayError {
  return new GatewayError({
    code: "service_unavailable",
    message: "Native Codex sessions are not configured.",
    httpStatus: 503,
    retryAfterSeconds: 30
  });
}

function createDefaultClientEventsStore(): ClientMessageEventStore | undefined {
  const sqlitePath = process.env.GATEWAY_CLIENT_EVENTS_SQLITE_PATH;
  if (!sqlitePath) {
    return undefined;
  }

  return createSqliteClientEventsStore({ path: sqlitePath });
}

function createDefaultResearchRuntime(
  env: NodeJS.ProcessEnv,
  logger: { info(message: string): void }
): {
  store: ResearchStore;
  workerHealthStore: Pick<ResearchWorkerStore, "listWorkerHeartbeats">;
  readRatePolicy: RateLimitPolicy;
  mutationRatePolicy: RateLimitPolicy;
  acceptWhenWorkerUnavailable: boolean;
  workerStaleAfterSeconds: number;
  artifactRoot: string;
  maximumArtifactBytes: number;
  admissionGuard: (now: Date) => Promise<GatewayError | null>;
} | null {
  if (!parseResearchEnabled(env.RESEARCH_API_ENABLED)) {
    return null;
  }
  const databasePath = env.RESEARCH_DB_PATH?.trim();
  if (!databasePath) {
    throw new Error(
      "RESEARCH_DB_PATH is required when Research API is enabled."
    );
  }
  assertDedicatedResearchDatabasePath(databasePath, env);
  const artifactRoot = env.RESEARCH_ARTIFACT_ROOT?.trim();
  if (!artifactRoot) {
    throw new Error(
      "RESEARCH_ARTIFACT_ROOT is required when Research API is enabled."
    );
  }
  const readRpm = parseRequiredPositiveIntegerEnv(
    env.RESEARCH_CONTROL_READ_RPM,
    "RESEARCH_CONTROL_READ_RPM"
  );
  const mutationRpm = parseRequiredPositiveIntegerEnv(
    env.RESEARCH_CONTROL_MUTATION_RPM,
    "RESEARCH_CONTROL_MUTATION_RPM"
  );
  const maximumCheckpointBytes = parseRequiredPositiveIntegerEnv(
    env.RESEARCH_MAX_CHECKPOINT_BYTES,
    "RESEARCH_MAX_CHECKPOINT_BYTES"
  );
  const maximumResultBytes = parseRequiredPositiveIntegerEnv(
    env.RESEARCH_MAX_RESULT_BYTES,
    "RESEARCH_MAX_RESULT_BYTES"
  );
  const maximumArtifactBytes = parseRequiredPositiveIntegerEnv(
    env.RESEARCH_MAX_ARTIFACT_BYTES,
    "RESEARCH_MAX_ARTIFACT_BYTES"
  );
  if (
    maximumCheckpointBytes > 10 * 1_024 * 1_024 ||
    maximumResultBytes > 10 * 1_024 * 1_024 ||
    maximumArtifactBytes > 10 * 1_024 * 1_024
  ) {
    throw new Error(
      "Research checkpoint, result, and artifact byte limits must not exceed 10 MiB."
    );
  }
  const acceptWhenWorkerUnavailable = parseResearchBoolean(
    env.RESEARCH_ACCEPT_WHEN_WORKER_UNAVAILABLE,
    false,
    "RESEARCH_ACCEPT_WHEN_WORKER_UNAVAILABLE"
  );
  if (acceptWhenWorkerUnavailable) {
    throw new Error(
      "RESEARCH_ACCEPT_WHEN_WORKER_UNAVAILABLE must remain false for the controlled beta."
    );
  }
  const workerStaleAfterSeconds = parseRequiredResearchSecondsEnv(
    env.RESEARCH_HEARTBEAT_STALE_SECONDS,
    "RESEARCH_HEARTBEAT_STALE_SECONDS"
  );
  const maximumStorageBytes = parseRequiredPositiveIntegerEnv(
    env.RESEARCH_MAX_STORAGE_BYTES,
    "RESEARCH_MAX_STORAGE_BYTES"
  );
  const minimumFreeBytes = parseRequiredPositiveIntegerEnv(
    env.RESEARCH_MIN_FREE_BYTES,
    "RESEARCH_MIN_FREE_BYTES"
  );
  const minimumFreePercent = parseRequiredPositiveIntegerEnv(
    env.RESEARCH_MIN_FREE_PERCENT,
    "RESEARCH_MIN_FREE_PERCENT"
  );
  if (minimumFreePercent > 100) {
    throw new Error("RESEARCH_MIN_FREE_PERCENT must not exceed 100.");
  }
  const backupMaxAgeSeconds = parseRequiredResearchSecondsEnv(
    env.RESEARCH_BACKUP_MAX_AGE_SECONDS,
    "RESEARCH_BACKUP_MAX_AGE_SECONDS"
  );
  const resolvedArtifactRoot = path.resolve(artifactRoot);
  const researchStorageRoot =
    databasePath === ":memory:"
      ? resolvedArtifactRoot
      : assertResearchStorageLayout(databasePath, resolvedArtifactRoot);
  const store = createResearchSqliteStore({
    path: databasePath,
    limits: {
      dailyRunsPerSubject: parseRequiredPositiveIntegerEnv(
        env.RESEARCH_MAX_DAILY_RUNS_PER_SUBJECT,
        "RESEARCH_MAX_DAILY_RUNS_PER_SUBJECT"
      ),
      uniqueDoctors30dPerSubject: parseRequiredPositiveIntegerEnv(
        env.RESEARCH_MAX_UNIQUE_DOCTORS_PER_SUBJECT_30D,
        "RESEARCH_MAX_UNIQUE_DOCTORS_PER_SUBJECT_30D"
      ),
      globalActiveRuns: parseRequiredPositiveIntegerEnv(
        env.RESEARCH_MAX_QUEUED_RUNS,
        "RESEARCH_MAX_QUEUED_RUNS"
      ),
      needsInputPerSubject: parseRequiredPositiveIntegerEnv(
        env.RESEARCH_MAX_NEEDS_INPUT_PER_SUBJECT,
        "RESEARCH_MAX_NEEDS_INPUT_PER_SUBJECT"
      )
    },
    idempotencyReplaySeconds: parseRequiredResearchSecondsEnv(
      env.RESEARCH_IDEMPOTENCY_REPLAY_SECONDS,
      "RESEARCH_IDEMPOTENCY_REPLAY_SECONDS"
    ),
    idempotencyTombstoneSeconds: parseRequiredResearchSecondsEnv(
      env.RESEARCH_IDEMPOTENCY_TOMBSTONE_SECONDS,
      "RESEARCH_IDEMPOTENCY_TOMBSTONE_SECONDS"
    ),
    resultTtlSeconds: parseRequiredResearchSecondsEnv(
      env.RESEARCH_RESULT_TTL_SECONDS,
      "RESEARCH_RESULT_TTL_SECONDS"
    ),
    runRetentionSeconds: parseRequiredResearchSecondsEnv(
      env.RESEARCH_RUN_RETENTION_SECONDS,
      "RESEARCH_RUN_RETENTION_SECONDS"
    ),
    needsInputTtlSeconds: parseRequiredResearchSecondsEnv(
      env.RESEARCH_NEEDS_INPUT_TTL_SECONDS,
      "RESEARCH_NEEDS_INPUT_TTL_SECONDS"
    ),
    maximumCheckpointBytes,
    maximumResultBytes,
    logger
  });
  return {
    store,
    workerHealthStore: store,
    readRatePolicy: researchControlRatePolicy(readRpm),
    mutationRatePolicy: researchControlRatePolicy(mutationRpm),
    acceptWhenWorkerUnavailable,
    workerStaleAfterSeconds,
    artifactRoot: resolvedArtifactRoot,
    maximumArtifactBytes,
    admissionGuard: async (now) => {
      const latestBackup = store.latestSuccessfulBackupAt();
      if (
        latestBackup === null ||
        now.getTime() - latestBackup.getTime() >
          backupMaxAgeSeconds * 1_000
      ) {
        return new GatewayError({
          code: "research_backup_stale",
          message: "Research backups are stale.",
          httpStatus: 503,
          retryAfterSeconds: 60
        });
      }
      const report = await probeResearchStorageAdmission({
        filesystemPath: resolvedArtifactRoot,
        researchRoot: researchStorageRoot,
        policy: {
          minimumFreeBytes,
          minimumFreePercent,
          maximumResearchBytes: maximumStorageBytes
        }
      });
      return report.available
        ? null
        : new GatewayError({
            code: "research_storage_unavailable",
            message: "Research storage is unavailable.",
            httpStatus: 503,
            retryAfterSeconds: 60
          });
    }
  };
}

function assertResearchStorageLayout(
  databasePath: string,
  artifactRoot: string
): string {
  const databaseDirectory = path.dirname(path.resolve(databasePath));
  const relativeArtifactPath = path.relative(databaseDirectory, artifactRoot);
  if (
    relativeArtifactPath === "" ||
    relativeArtifactPath === ".." ||
    relativeArtifactPath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeArtifactPath)
  ) {
    throw new Error(
      "RESEARCH_ARTIFACT_ROOT must be a child of the Research database directory."
    );
  }
  return databaseDirectory;
}

function parseResearchEnabled(value: string | undefined): boolean {
  if (value === undefined || value.trim() === "") {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1") {
    return true;
  }
  if (normalized === "false" || normalized === "0") {
    return false;
  }
  throw new Error("RESEARCH_API_ENABLED must be true/false or 1/0.");
}

function parseResearchBoolean(
  value: string | undefined,
  fallback: boolean,
  name: string
): boolean {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1") {
    return true;
  }
  if (normalized === "false" || normalized === "0") {
    return false;
  }
  throw new Error(`${name} must be true/false or 1/0.`);
}

function assertDedicatedResearchDatabasePath(
  databasePath: string,
  env: NodeJS.ProcessEnv
): void {
  if (
    databasePath === ":memory:" &&
    env.NODE_ENV?.trim().toLowerCase() === "production"
  ) {
    throw new Error("RESEARCH_DB_PATH cannot be :memory: in production.");
  }
  if (databasePath === ":memory:") {
    return;
  }
  const researchPath = comparableFilesystemPath(databasePath);
  for (const [name, configuredPath] of [
    ["GATEWAY_SQLITE_PATH", env.GATEWAY_SQLITE_PATH],
    [
      "GATEWAY_CLIENT_EVENTS_SQLITE_PATH",
      env.GATEWAY_CLIENT_EVENTS_SQLITE_PATH
    ]
  ] as const) {
    if (
      configuredPath &&
      configuredPath !== ":memory:" &&
      comparableFilesystemPath(configuredPath) === researchPath
    ) {
      throw new Error(`RESEARCH_DB_PATH must not reuse ${name}.`);
    }
  }
}

function comparableFilesystemPath(value: string): string {
  const resolved = path.resolve(value.trim());
  let canonical = resolved;
  try {
    canonical = realpathSync.native(resolved);
  } catch {
    try {
      canonical = path.join(
        realpathSync.native(path.dirname(resolved)),
        path.basename(resolved)
      );
    } catch {
      canonical = resolved;
    }
  }
  return process.platform === "win32"
    ? canonical.toLowerCase()
    : canonical;
}

function isResearchWorkerHealthStore(
  value: ResearchStore | undefined
): value is ResearchStore &
  Pick<ResearchWorkerStore, "listWorkerHeartbeats"> {
  return (
    value !== undefined &&
    typeof (value as Partial<ResearchWorkerStore>).listWorkerHeartbeats ===
      "function"
  );
}

function researchControlRatePolicy(
  requestsPerMinute: number
): RateLimitPolicy {
  return {
    requestsPerMinute,
    requestsPerDay: null,
    concurrentRequests: null
  };
}

function clientEventsRateLimitKey(
  credentialId: string,
  eventFamily: "messages" | "diagnostics"
): string {
  return `${credentialId}:${eventFamily}`;
}

function logClientEventRateLimitRejection(input: {
  request: FastifyRequest;
  credentialId: string;
  subjectId: string;
  family: "messages" | "diagnostics";
  rejection: LimitRejection;
  state: Map<string, { nextLogAtMs: number; suppressed: number }>;
  now: Date;
}): void {
  const key = `${input.credentialId}:${input.family}:${input.rejection.limitKind}`;
  const nowMs = input.now.getTime();
  const previous = input.state.get(key);
  if (previous && nowMs < previous.nextLogAtMs) {
    previous.suppressed += 1;
    return;
  }

  input.request.log.warn(
    {
      request_id: input.request.id,
      credential_id: input.credentialId,
      subject_id: input.subjectId,
      event_family: input.family,
      limit_kind: input.rejection.limitKind,
      rate_limit_origin: "gateway",
      limit: input.rejection.details ?? null,
      retry_after_seconds: input.rejection.error.retryAfterSeconds ?? null,
      rejected_since_previous_log: (previous?.suppressed ?? 0) + 1
    },
    "Client event ingest rate limited."
  );
  input.state.set(key, {
    nextLogAtMs: nowMs + 60_000,
    suppressed: 0
  });
}

const diagnosticInferredLinkSource = "inferred_latest_session_message";
const sessionScopedDiagnosticCategories = new Set([
  "agent_turn",
  "provider_stream",
  "tool",
  "medevidence"
]);

function linkClientDiagnosticEvent(
  store: ClientMessageEventStore,
  subjectId: string,
  parsed: ParsedClientDiagnosticEventRequest
): ParsedClientDiagnosticEventRequest {
  if (parsed.sessionId && parsed.messageId) {
    return parsed;
  }

  const byMessageId =
    parsed.messageId && !parsed.sessionId
      ? store.findClientMessageEventByMessageId(subjectId, parsed.messageId)
      : null;
  const bySession =
    parsed.sessionId && !parsed.messageId && shouldInferSessionDiagnosticLink(parsed)
      ? store.findLatestClientMessageEventForSession(subjectId, parsed.sessionId, parsed.createdAt)
      : null;
  const linked = byMessageId ?? bySession;
  if (!linked) {
    return parsed;
  }

  const linkedDiagnostic = {
    ...parsed,
    sessionId: parsed.sessionId ?? linked.sessionId,
    messageId: parsed.messageId ?? linked.messageId
  };
  return bySession ? markInferredDiagnosticLink(linkedDiagnostic, linked.messageId) : linkedDiagnostic;
}

function shouldInferSessionDiagnosticLink(
  parsed: Pick<ParsedClientDiagnosticEventRequest, "category" | "toolCallId" | "providerId">
): boolean {
  if (sessionScopedDiagnosticCategories.has(parsed.category)) {
    return true;
  }
  return parsed.category === "renderer" && Boolean(parsed.toolCallId || parsed.providerId);
}

function markInferredDiagnosticLink(
  parsed: ParsedClientDiagnosticEventRequest,
  messageId: string
): ParsedClientDiagnosticEventRequest {
  return {
    ...parsed,
    metadataJson: addDiagnosticLinkMetadata(parsed.metadataJson, {
      source: diagnosticInferredLinkSource,
      message_id: messageId
    })
  };
}

function addDiagnosticLinkMetadata(
  metadataJson: string,
  link: { source: string; message_id: string }
): string {
  const metadata = parseMetadataObject(metadataJson);
  metadata.diagnostic_link = link;
  return JSON.stringify(metadata);
}

function removeDiagnosticLinkMetadata(metadataJson: string): string {
  const metadata = parseMetadataObject(metadataJson);
  delete metadata.diagnostic_link;
  return JSON.stringify(metadata);
}

function parseMetadataObject(metadataJson: string): Record<string, unknown> {
  try {
    const value = JSON.parse(metadataJson);
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    // Malformed stored metadata should not block diagnostic ingestion paths.
  }
  return {};
}

function hasInferredDiagnosticLink(metadataJson: string): boolean {
  const link = parseMetadataObject(metadataJson).diagnostic_link;
  return (
    Boolean(link) &&
    typeof link === "object" &&
    !Array.isArray(link) &&
    (link as Record<string, unknown>).source === diagnosticInferredLinkSource
  );
}

function relinkExistingClientDiagnosticEvent(
  store: ClientMessageEventStore,
  subjectId: string,
  existing: ClientDiagnosticEventRecord,
  parsed: ParsedClientDiagnosticEventRequest,
  linked: ParsedClientDiagnosticEventRequest
): ClientDiagnosticEventRecord | null {
  if (!linked.sessionId || !linked.messageId) {
    return null;
  }
  if (existing.sessionId === linked.sessionId && existing.messageId === linked.messageId) {
    return null;
  }
  if (!canRelinkClientDiagnostic(existing, parsed)) {
    return null;
  }

  const metadataJson = hasInferredDiagnosticLink(linked.metadataJson)
    ? addDiagnosticLinkMetadata(removeDiagnosticLinkMetadata(linked.metadataJson), {
        source: diagnosticInferredLinkSource,
        message_id: linked.messageId
      })
    : linked.metadataJson;
  return store.updateClientDiagnosticEventLink(subjectId, existing.eventId, {
    sessionId: linked.sessionId,
    messageId: linked.messageId,
    metadataJson
  });
}

function canRelinkClientDiagnostic(
  existing: ClientDiagnosticEventRecord,
  parsed: ParsedClientDiagnosticEventRequest
): boolean {
  if (existing.messageId && !hasInferredDiagnosticLink(existing.metadataJson)) {
    return false;
  }
  return clientDiagnosticEventsMatchExceptLink(existing, parsed);
}

function clientDiagnosticEventsMatchExceptLink(
  existing: ClientDiagnosticEventRecord,
  parsed: ParsedClientDiagnosticEventRequest
): boolean {
  return (
    existing.toolCallId === parsed.toolCallId &&
    existing.providerId === parsed.providerId &&
    existing.modelId === parsed.modelId &&
    existing.createdAt.getTime() === parsed.createdAt.getTime() &&
    existing.appName === parsed.appName &&
    existing.appVersion === parsed.appVersion &&
    existing.category === parsed.category &&
    existing.action === parsed.action &&
    existing.status === parsed.status &&
    existing.method === parsed.method &&
    existing.path === parsed.path &&
    existing.monoMs === parsed.monoMs &&
    existing.durationMs === parsed.durationMs &&
    existing.httpStatus === parsed.httpStatus &&
    existing.errorCode === parsed.errorCode &&
    existing.errorMessage === parsed.errorMessage &&
    removeDiagnosticLinkMetadata(existing.metadataJson) ===
      removeDiagnosticLinkMetadata(parsed.metadataJson)
  );
}

function backfillClientDiagnosticsForMessage(
  store: ClientMessageEventStore,
  subjectId: string,
  message: ParsedClientMessageEventRequest
): void {
  const candidates = store.listClientDiagnosticEventsForSession(
    subjectId,
    message.sessionId,
    message.createdAt
  );
  for (const diagnostic of candidates) {
    if (!shouldInferSessionDiagnosticLink(diagnostic)) {
      continue;
    }
    if (diagnostic.messageId && !hasInferredDiagnosticLink(diagnostic.metadataJson)) {
      continue;
    }
    const latest = store.findLatestClientMessageEventForSession(
      subjectId,
      message.sessionId,
      diagnostic.createdAt
    );
    if (latest?.messageId !== message.messageId) {
      continue;
    }
    if (diagnostic.sessionId === message.sessionId && diagnostic.messageId === message.messageId) {
      continue;
    }
    store.updateClientDiagnosticEventLink(subjectId, diagnostic.eventId, {
      sessionId: message.sessionId,
      messageId: message.messageId,
      metadataJson: addDiagnosticLinkMetadata(removeDiagnosticLinkMetadata(diagnostic.metadataJson), {
        source: diagnosticInferredLinkSource,
        message_id: message.messageId
      })
    });
  }
}

function createProviderErrorLogger(
  request: FastifyRequest
): (diagnostic: ProviderErrorDiagnostic) => void {
  return (diagnostic) => {
    if (diagnostic.rawStatus !== undefined) {
      request.gatewayUpstreamHttpStatus = diagnostic.rawStatus;
    }
    if (diagnostic.code === "rate_limited" || diagnostic.rawStatus === 429) {
      markRateLimitOrigin(request, "upstream");
    }
    request.log.warn(
      {
        request_id: request.id,
        session_id: request.gatewaySessionId ?? null,
        provider_error: {
          source: diagnostic.source,
          code: diagnostic.code,
          public_message: diagnostic.publicMessage,
          raw_message: diagnostic.rawMessage,
          ...(diagnostic.rawName ? { raw_name: diagnostic.rawName } : {}),
          ...(diagnostic.rawCode ? { raw_code: diagnostic.rawCode } : {}),
          ...(diagnostic.rawStatus !== undefined ? { raw_status: diagnostic.rawStatus } : {})
        }
      },
      "Provider returned sanitized error."
    );
  };
}

function applyClientTurnHeaders(
  request: FastifyRequest,
  fallbackClientSessionId?: string | null
): void {
  request.gatewayClientTurnId = readSingleHeader(request, "x-medcode-client-turn-id", 128);
  request.gatewayTurnCode = readSingleHeader(request, "x-medcode-client-turn-code", 64);
  request.gatewayClientSessionId =
    readSingleHeader(request, "x-medcode-client-session-id", 128) ??
    fallbackClientSessionId ??
    null;
  request.gatewayClientMessageId = readSingleHeader(request, "x-medcode-client-message-id", 128);
  request.gatewayClientAppVersion = readSingleHeader(request, "x-medcode-client-app-version", 64);
}

function readSingleHeader(
  request: FastifyRequest,
  name: string,
  maxLength: number
): string | null {
  const raw = request.headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength) {
    return null;
  }
  return trimmed;
}

function serializeToolChoice(toolChoice: ChatCompletionRequest["toolChoice"]): string {
  if (typeof toolChoice === "string") {
    return toolChoice;
  }
  return `function:${toolChoice.function.name}`;
}

function chatRuntimeAttemptContext(
  runtime: ChatRuntimeContext,
  kind: string,
  toolChoice: ChatCompletionRequest["toolChoice"]
): ProviderStreamAttemptContext {
  return {
    kind,
    toolChoice: serializeToolChoice(toolChoice),
    provider: runtime.providerKind,
    upstreamRuntime: runtime.runtime,
    upstreamModel: runtime.upstreamModel,
    upstreamAccountId: runtime.adapterInputUpstreamAccount.id
  };
}

function markProviderStreamSummary(
  request: FastifyRequest,
  summary: ProviderStreamSummary | null
): void {
  if (!summary) {
    return;
  }
  if (
    summary.errorCode === "rate_limited" ||
    summary.upstreamHttpStatus === 429 ||
    summary.attempts.some(
      (attempt) => attempt.errorCode === "rate_limited" || attempt.upstreamHttpStatus === 429
    )
  ) {
    markRateLimitOrigin(request, "upstream");
  }
  request.gatewayUpstreamFinishReason = summary.finishReason;
  request.gatewayUpstreamRequestId = summary.upstreamRequestId;
  request.gatewayUpstreamHttpStatus = summary.upstreamHttpStatus;
  request.gatewayUpstreamContentChars = summary.contentChars;
  request.gatewayUpstreamToolCallCount = summary.toolCallCount;
  request.gatewayUpstreamToolNames = summary.toolNames;
  request.gatewayUpstreamRawResponseHash = summary.rawResponseHash;
  request.gatewayUpstreamRawResponseChars = summary.rawResponseChars;
  request.gatewayUpstreamEmptyStop = summary.emptyStop;
  request.gatewayUpstreamAttemptCount = summary.attempts.length;
  request.gatewayUpstreamAttempts = summary.attempts;
}

function clientDiagnosticEventsMatch(
  existing: ClientDiagnosticEventRecord,
  parsed: ParsedClientDiagnosticEventRequest
): boolean {
  return (
    existing.sessionId === parsed.sessionId &&
    existing.messageId === parsed.messageId &&
    existing.toolCallId === parsed.toolCallId &&
    existing.providerId === parsed.providerId &&
    existing.modelId === parsed.modelId &&
    existing.createdAt.getTime() === parsed.createdAt.getTime() &&
    existing.appName === parsed.appName &&
    existing.appVersion === parsed.appVersion &&
    existing.category === parsed.category &&
    existing.action === parsed.action &&
    existing.status === parsed.status &&
    existing.method === parsed.method &&
    existing.path === parsed.path &&
    existing.monoMs === parsed.monoMs &&
    existing.durationMs === parsed.durationMs &&
    existing.httpStatus === parsed.httpStatus &&
    existing.errorCode === parsed.errorCode &&
    existing.errorMessage === parsed.errorMessage &&
    existing.metadataJson === parsed.metadataJson
  );
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

function resolveBillingAdminRatePolicy(env: NodeJS.ProcessEnv): RateLimitPolicy {
  return {
    requestsPerMinute: parsePositiveIntegerEnv(
      env.GATEWAY_BILLING_ADMIN_RPM,
      120,
      "GATEWAY_BILLING_ADMIN_RPM"
    ),
    requestsPerDay: parsePositiveIntegerEnv(
      env.GATEWAY_BILLING_ADMIN_RPD,
      10_000,
      "GATEWAY_BILLING_ADMIN_RPD"
    ),
    concurrentRequests: parsePositiveIntegerEnv(
      env.GATEWAY_BILLING_ADMIN_CONCURRENT,
      8,
      "GATEWAY_BILLING_ADMIN_CONCURRENT"
    )
  };
}

function createDefaultImageGenerationProvider(
  env: NodeJS.ProcessEnv
): ImageGenerationProvider | undefined {
  if (env.MEDCODE_IMAGE_GENERATION_ENABLED !== "1") {
    return undefined;
  }
  if (!env.MEDCODE_IMAGE_OPENAI_API_KEY) {
    throw new Error("MEDCODE_IMAGE_OPENAI_API_KEY is required when image generation is enabled.");
  }
  return new OpenAIImageGenerationProvider({
    apiKey: env.MEDCODE_IMAGE_OPENAI_API_KEY,
    baseUrl: env.MEDCODE_IMAGE_OPENAI_BASE_URL,
    timeoutMs: parsePositiveIntegerEnv(
      env.MEDCODE_IMAGE_TIMEOUT_MS,
      180_000,
      "MEDCODE_IMAGE_TIMEOUT_MS"
    )
  });
}

function resolveImageGenerationBillingFallbacks(
  options: GatewayOptions,
  env: NodeJS.ProcessEnv,
  logger: UpstreamAccountConfigLogger
): ImageGenerationBillingFallback[] {
  if (options.imageGenerationBillingFallbacks !== undefined) {
    return options.imageGenerationBillingFallbacks.map((fallback, index) => ({
      accountId: fallback.accountId ?? `${imageBillingFallbackAccountId}-${index + 1}`,
      provider: fallback.provider,
      upstreamModel: fallback.upstreamModel ?? defaultImageBillingFallbackModel
    }));
  }
  if (options.imageGenerationBillingFallbackProvider !== undefined) {
    return options.imageGenerationBillingFallbackProvider
      ? [
          {
            accountId: imageBillingFallbackAccountId,
            provider: options.imageGenerationBillingFallbackProvider,
            upstreamModel:
              options.imageGenerationBillingFallbackModel ?? defaultImageBillingFallbackModel
          }
        ]
      : [];
  }
  return createDefaultImageGenerationBillingFallbacks(env, logger);
}

function createDefaultImageGenerationBillingFallbacks(
  env: NodeJS.ProcessEnv,
  logger: UpstreamAccountConfigLogger
): ImageGenerationBillingFallback[] {
  if (env.MEDCODE_IMAGE_GENERATION_ENABLED !== "1") {
    return [];
  }
  const fallbacks: ImageGenerationBillingFallback[] = [];
  const apiKey = env.MEDCODE_IMAGE_BILLING_FALLBACK_OPENAI_API_KEY?.trim();
  if (apiKey) {
    fallbacks.push({
      accountId: imageBillingFallbackAccountId,
      provider: new OpenAIImageGenerationProvider({
        apiKey,
        baseUrl:
          env.MEDCODE_IMAGE_BILLING_FALLBACK_OPENAI_BASE_URL ??
          env.MEDCODE_IMAGE_OPENAI_BASE_URL,
        timeoutMs: parsePositiveIntegerEnv(
          env.MEDCODE_IMAGE_BILLING_FALLBACK_TIMEOUT_MS ?? env.MEDCODE_IMAGE_TIMEOUT_MS,
          180_000,
          "MEDCODE_IMAGE_BILLING_FALLBACK_TIMEOUT_MS"
        )
      }),
      upstreamModel: parseImageBillingFallbackModel(
        env.MEDCODE_IMAGE_BILLING_FALLBACK_MODEL,
        defaultImageBillingFallbackModel,
        "MEDCODE_IMAGE_BILLING_FALLBACK_MODEL"
      )
    });
  }
  fallbacks.push(...createExtraImageGenerationBillingFallbacks(env, logger));
  return fallbacks;
}

function createExtraImageGenerationBillingFallbacks(
  env: NodeJS.ProcessEnv,
  logger: UpstreamAccountConfigLogger
): ImageGenerationBillingFallback[] {
  const keysFile = env.MEDCODE_IMAGE_BILLING_FALLBACK_KEYS_FILE?.trim();
  if (!keysFile) {
    return [];
  }
  const entries = parseImageBillingFallbackKeysFile(keysFile);
  const counters = new Map<string, number>();
  const fallbacks = entries.map((entry) => {
    const next = (counters.get(entry.provider) ?? 0) + 1;
    counters.set(entry.provider, next);
    return createExtraImageGenerationBillingFallback(entry.provider, entry.apiKey, next, env);
  });
  logger.info(
    {
      image_billing_fallback_keys_file: keysFile,
      image_billing_fallback_count: fallbacks.length,
      image_billing_fallback_providers: entries.map((entry) => entry.provider)
    },
    "Configured extra image billing fallback providers."
  );
  return fallbacks;
}

function createExtraImageGenerationBillingFallback(
  provider: ImageBillingFallbackProviderKind,
  apiKey: string,
  index: number,
  env: NodeJS.ProcessEnv
): ImageGenerationBillingFallback {
  if (provider === "openai") {
    return {
      accountId: `${imageBillingFallbackAccountId}-openai-${index}`,
      provider: new OpenAIImageGenerationProvider({
        apiKey,
        baseUrl:
          env.MEDCODE_IMAGE_BILLING_FALLBACK_EXTRA_OPENAI_BASE_URL ??
          env.MEDCODE_IMAGE_OPENAI_BASE_URL,
        timeoutMs: parsePositiveIntegerEnv(
          env.MEDCODE_IMAGE_BILLING_FALLBACK_OPENAI_TIMEOUT_MS ??
            env.MEDCODE_IMAGE_BILLING_FALLBACK_TIMEOUT_MS ??
            env.MEDCODE_IMAGE_TIMEOUT_MS,
          180_000,
          "MEDCODE_IMAGE_BILLING_FALLBACK_OPENAI_TIMEOUT_MS"
        )
      }),
      upstreamModel: parseImageBillingFallbackModel(
        env.MEDCODE_IMAGE_BILLING_FALLBACK_OPENAI_MODEL ??
          env.MEDCODE_IMAGE_BILLING_FALLBACK_MODEL,
        defaultImageBillingFallbackModel,
        "MEDCODE_IMAGE_BILLING_FALLBACK_OPENAI_MODEL"
      )
    };
  }
  if (provider === "xai") {
    return {
      accountId: `${imageBillingFallbackAccountId}-xai-${index}`,
      provider: new XAIImageGenerationProvider({
        apiKey,
        baseUrl: env.MEDCODE_IMAGE_BILLING_FALLBACK_XAI_BASE_URL,
        timeoutMs: parsePositiveIntegerEnv(
          env.MEDCODE_IMAGE_BILLING_FALLBACK_XAI_TIMEOUT_MS ??
            env.MEDCODE_IMAGE_BILLING_FALLBACK_TIMEOUT_MS ??
            env.MEDCODE_IMAGE_TIMEOUT_MS,
          180_000,
          "MEDCODE_IMAGE_BILLING_FALLBACK_XAI_TIMEOUT_MS"
        ),
        resolution: parseXAIImageResolution(env.MEDCODE_IMAGE_BILLING_FALLBACK_XAI_RESOLUTION)
      }),
      upstreamModel: parseImageBillingFallbackModel(
        env.MEDCODE_IMAGE_BILLING_FALLBACK_XAI_MODEL,
        defaultXAIImageBillingFallbackModel,
        "MEDCODE_IMAGE_BILLING_FALLBACK_XAI_MODEL"
      )
    };
  }
  return {
    accountId: `${imageBillingFallbackAccountId}-gemini-${index}`,
    provider: new GeminiImageGenerationProvider({
      apiKey,
      baseUrl: env.MEDCODE_IMAGE_BILLING_FALLBACK_GEMINI_BASE_URL,
      timeoutMs: parsePositiveIntegerEnv(
        env.MEDCODE_IMAGE_BILLING_FALLBACK_GEMINI_TIMEOUT_MS ??
          env.MEDCODE_IMAGE_BILLING_FALLBACK_TIMEOUT_MS ??
          env.MEDCODE_IMAGE_TIMEOUT_MS,
        180_000,
        "MEDCODE_IMAGE_BILLING_FALLBACK_GEMINI_TIMEOUT_MS"
      ),
      imageSize: parseGeminiImageSize(env.MEDCODE_IMAGE_BILLING_FALLBACK_GEMINI_IMAGE_SIZE)
    }),
    upstreamModel: parseImageBillingFallbackModel(
      env.MEDCODE_IMAGE_BILLING_FALLBACK_GEMINI_MODEL,
      defaultGeminiImageBillingFallbackModel,
      "MEDCODE_IMAGE_BILLING_FALLBACK_GEMINI_MODEL"
    )
  };
}

type ImageBillingFallbackProviderKind = "openai" | "xai" | "gemini";

function parseImageBillingFallbackKeysFile(path: string): Array<{
  provider: ImageBillingFallbackProviderKind;
  apiKey: string;
}> {
  const content = readFileSync(path, "utf8");
  const entries: Array<{ provider: ImageBillingFallbackProviderKind; apiKey: string }> = [];
  const lines = content.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const separator = line.indexOf(":");
    if (separator <= 0) {
      throw new Error(
        `MEDCODE_IMAGE_BILLING_FALLBACK_KEYS_FILE line ${index + 1} must use provider:key format.`
      );
    }
    const provider = parseImageBillingFallbackProviderKind(
      line.slice(0, separator).trim(),
      index + 1
    );
    const apiKey = line.slice(separator + 1).trim();
    if (!apiKey) {
      throw new Error(
        `MEDCODE_IMAGE_BILLING_FALLBACK_KEYS_FILE line ${index + 1} has an empty key.`
      );
    }
    entries.push({ provider, apiKey });
  }
  return entries;
}

function parseImageBillingFallbackProviderKind(
  value: string,
  lineNumber: number
): ImageBillingFallbackProviderKind {
  const normalized = value.toLowerCase();
  if (normalized === "openai" || normalized === "xai" || normalized === "gemini") {
    return normalized;
  }
  throw new Error(
    `MEDCODE_IMAGE_BILLING_FALLBACK_KEYS_FILE line ${lineNumber} has unsupported provider: ${value}.`
  );
}

function parseImageBillingFallbackModel(
  value: string | undefined,
  fallback: string,
  envName: string
): string {
  const model = value?.trim() || fallback;
  if (!model) {
    throw new Error(`${envName} must be a non-empty string.`);
  }
  return model;
}

function parseXAIImageResolution(value: string | undefined): "1k" | "2k" | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized === "1k" || normalized === "2k") {
    return normalized;
  }
  throw new Error("MEDCODE_IMAGE_BILLING_FALLBACK_XAI_RESOLUTION must be 1k or 2k.");
}

function parseGeminiImageSize(value: string | undefined): "512" | "1K" | "2K" | "4K" | undefined {
  const normalized = value?.trim();
  if (!normalized) {
    return undefined;
  }
  if (normalized === "512" || normalized === "1K" || normalized === "2K" || normalized === "4K") {
    return normalized;
  }
  throw new Error("MEDCODE_IMAGE_BILLING_FALLBACK_GEMINI_IMAGE_SIZE must be 512, 1K, 2K, or 4K.");
}

function createImageProviderForAccount(
  config: ParsedUpstreamAccountConfig,
  env: NodeJS.ProcessEnv,
  logger: UpstreamAccountConfigLogger
): ImageGenerationProvider | null {
  if (!config.imageApiKeyEnv) {
    return null;
  }
  if (env.MEDCODE_IMAGE_GENERATION_ENABLED !== "1") {
    logger.info(
      { upstream_account_id: config.id, image_api_key_env: config.imageApiKeyEnv },
      "Image key declared for upstream account but image generation is disabled."
    );
    return null;
  }
  const apiKey = env[config.imageApiKeyEnv]?.trim();
  if (!apiKey) {
    logger.warn?.(
      { upstream_account_id: config.id, image_api_key_env: config.imageApiKeyEnv },
      "Image key env for upstream account is missing or empty."
    );
    return null;
  }
  logger.info(
    { upstream_account_id: config.id, image_api_key_env: config.imageApiKeyEnv },
    "Image key configured for upstream account."
  );
  return new OpenAIImageGenerationProvider({
    apiKey,
    baseUrl: config.imageBaseUrlEnv
      ? env[config.imageBaseUrlEnv]
      : env.MEDCODE_IMAGE_OPENAI_BASE_URL,
    timeoutMs:
      config.imageTimeoutMs ??
      parsePositiveIntegerEnv(
        env.MEDCODE_IMAGE_TIMEOUT_MS,
        180_000,
        "MEDCODE_IMAGE_TIMEOUT_MS"
      )
  });
}

function resolveUpstreamAccountPool(
  options: GatewayOptions,
  env: NodeJS.ProcessEnv,
  store: GatewayStore,
  logger: UpstreamAccountConfigLogger
): ResolvedUpstreamAccountPool {
  if (options.upstreamAccounts) {
    return {
      runtimes: options.upstreamAccounts,
      softAffinity: "credential",
      cooldown: defaultUpstreamCooldown(),
      accountPoolConfigured: true
    };
  }

  if (env.GATEWAY_UPSTREAM_ACCOUNTS_JSON) {
    const pool = readUpstreamAccountPoolConfigFile(env.GATEWAY_UPSTREAM_ACCOUNTS_JSON, {
      nodeEnv: env.NODE_ENV,
      logger
    });
    return {
      runtimes: pool.accounts.map((config) => {
        const upstreamAccount = applyStartupAuthState(
          resolveConfiguredUpstreamAccount(config, store),
          config,
          {
            validateAuthFiles: env.NODE_ENV === "production"
          }
        );
        return {
          upstreamAccount,
          provider: createCodexProvider(env, config.codexHome),
          imageProvider: createImageProviderForAccount(config, env, logger),
          enabled: config.enabled,
          weight: config.weight,
          maxConcurrent: config.maxConcurrent
        };
      }),
      softAffinity: pool.selection.softAffinity,
      cooldown: pool.cooldown,
      accountPoolConfigured: true
    };
  }

  const codexHome = env.CODEX_HOME ?? ".gateway-state/codex-home";
  return {
    runtimes: [
      {
        upstreamAccount: options.upstreamAccount ?? defaultUpstreamAccount(),
        provider: options.provider ?? createCodexProvider(env, codexHome)
      }
    ],
    softAffinity: "credential",
    cooldown: defaultUpstreamCooldown(),
    accountPoolConfigured: false
  };
}

function resolveConfiguredUpstreamAccount(
  config: ParsedUpstreamAccountConfig,
  store: GatewayStore
): UpstreamAccount {
  const configured = accountFromPoolConfig(config);
  const existing = getStoredUpstreamAccount(store, config.id);
  if (!existing) {
    return configured;
  }
  return {
    ...configured,
    imageApiKeyEnv: configured.imageApiKeyEnv,
    state: existing.state,
    lastUsedAt: existing.lastUsedAt,
    cooldownUntil: existing.cooldownUntil
  };
}

function getStoredUpstreamAccount(store: GatewayStore, id: string): UpstreamAccount | null {
  const candidate = store as Partial<{
    getUpstreamAccount: (id: string) => UpstreamAccount | null;
  }>;
  return candidate.getUpstreamAccount?.(id) ?? null;
}

function persistUpstreamAccountRuntimeState(
  store: GatewayStore,
  account: UpstreamAccount,
  logger: UpstreamAccountConfigLogger
): void {
  const candidate = store as Partial<{
    updateUpstreamAccountRuntimeState: (
      id: string,
      input: {
        state: UpstreamAccount["state"];
        lastUsedAt: Date | null;
        cooldownUntil: Date | null;
      }
    ) => UpstreamAccount | null;
  }>;
  try {
    candidate.updateUpstreamAccountRuntimeState?.(account.id, {
      state: account.state,
      lastUsedAt: account.lastUsedAt,
      cooldownUntil: account.cooldownUntil
    });
  } catch (err) {
    logger.warn?.(
      {
        upstream_account_id: account.id,
        error: err instanceof Error ? err.message : String(err)
      },
      "Failed to persist upstream account runtime state."
    );
  }
}

function defaultUpstreamCooldown(): UpstreamAccountCooldownConfig {
  return {
    rateLimitSeconds: 120,
    reauthSeconds: 900,
    serviceErrorSeconds: 30
  };
}

function createCodexProvider(env: NodeJS.ProcessEnv, codexHome: string): ProviderAdapter {
  return new CodexProviderAdapter({
    codexHome,
    codexPath: env.CODEX_GATEWAY_CODEX_PATH,
    model: env.MEDCODE_UPSTREAM_MODEL,
    modelReasoningEffort: parseModelReasoningEffort(env.MEDCODE_UPSTREAM_REASONING_EFFORT),
    workingDirectory: env.CODEX_WORKDIR ?? process.cwd(),
    skipGitRepoCheck: env.CODEX_SKIP_GIT_REPO_CHECK === "1"
  });
}

function createOpenRouterAdapters(
  models: PublicModelConfig[],
  env: NodeJS.ProcessEnv,
  logger?: { warn: (obj: Record<string, unknown>, msg: string) => void }
): OpenAICompatibleAdapterMap {
  return createOpenAICompatibleAdapters({
    models,
    env,
    logger,
    runtime: "openrouter",
    providerKind: "openrouter",
    displayName: "OpenRouter",
    apiKeyEnvName: env.MEDCODE_OPENROUTER_API_KEY_ENV?.trim() || "MEDCODE_OPENROUTER_API_KEY",
    baseUrl: env.MEDCODE_OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1",
    timeoutMs: parsePositiveIntegerEnv(
      env.MEDCODE_OPENROUTER_TIMEOUT_MS,
      300_000,
      "MEDCODE_OPENROUTER_TIMEOUT_MS"
    ),
    reasoningForTarget: (target) => target.reasoning ?? { effort: "none" },
    siteUrl: env.MEDCODE_OPENROUTER_SITE_URL,
    appTitle: env.MEDCODE_OPENROUTER_APP_TITLE ?? "MedCode"
  });
}

function createQianfanAdapters(
  models: PublicModelConfig[],
  env: NodeJS.ProcessEnv,
  logger?: { warn: (obj: Record<string, unknown>, msg: string) => void }
): OpenAICompatibleAdapterMap {
  return createOpenAICompatibleAdapters({
    models,
    env,
    logger,
    runtime: "qianfan",
    providerKind: "qianfan",
    displayName: "Qianfan",
    apiKeyEnvName: env.MEDCODE_QIANFAN_API_KEY_ENV?.trim() || "MEDCODE_QIANFAN_API_KEY",
    baseUrl: env.MEDCODE_QIANFAN_BASE_URL ?? "https://qianfan.baidubce.com/v2/tokenplan/team",
    timeoutMs: parsePositiveIntegerEnv(
      env.MEDCODE_QIANFAN_TIMEOUT_MS,
      300_000,
      "MEDCODE_QIANFAN_TIMEOUT_MS"
    ),
    reasoningForTarget: (target) => target.reasoning
  });
}

function createAliyunAdapters(
  models: PublicModelConfig[],
  env: NodeJS.ProcessEnv,
  logger?: { warn: (obj: Record<string, unknown>, msg: string) => void }
): OpenAICompatibleAdapterMap {
  return createOpenAICompatibleAdapters({
    models,
    env,
    logger,
    runtime: "aliyun",
    providerKind: "aliyun",
    displayName: "Aliyun Token Plan",
    apiKeyEnvName:
      env.MEDCODE_ALIYUN_TOKEN_PLAN_API_KEY_ENV?.trim() ||
      env.MEDCODE_ALIYUN_API_KEY_ENV?.trim() ||
      "MEDCODE_ALIYUN_DASHSCOPE_API_KEY",
    baseUrl:
      env.MEDCODE_ALIYUN_TOKEN_PLAN_BASE_URL ??
      env.MEDCODE_ALIYUN_DASHSCOPE_BASE_URL ??
      "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
    timeoutMs: parsePositiveIntegerEnv(
      env.MEDCODE_ALIYUN_TOKEN_PLAN_TIMEOUT_MS ?? env.MEDCODE_ALIYUN_DASHSCOPE_TIMEOUT_MS,
      300_000,
      "MEDCODE_ALIYUN_TOKEN_PLAN_TIMEOUT_MS"
    ),
    reasoningForTarget: (target) => target.reasoning ?? { effort: "none" },
    reasoningParameterStyle: "effort_field"
  });
}

function createTencentAdapters(
  models: PublicModelConfig[],
  env: NodeJS.ProcessEnv,
  logger?: { warn: (obj: Record<string, unknown>, msg: string) => void }
): OpenAICompatibleAdapterMap {
  return createOpenAICompatibleAdapters({
    models,
    env,
    logger,
    runtime: "tencent",
    providerKind: "tencent",
    displayName: "Tencent TokenHub",
    apiKeyEnvName:
      env.MEDCODE_TENCENT_TOKENHUB_API_KEY_ENV?.trim() ||
      env.MEDCODE_TENCENT_API_KEY_ENV?.trim() ||
      "MEDCODE_TENCENT_TOKENHUB_API_KEY",
    baseUrl: env.MEDCODE_TENCENT_TOKENHUB_BASE_URL ?? "https://tokenhub.tencentmaas.com/plan/v3",
    timeoutMs: parsePositiveIntegerEnv(
      env.MEDCODE_TENCENT_TOKENHUB_TIMEOUT_MS,
      300_000,
      "MEDCODE_TENCENT_TOKENHUB_TIMEOUT_MS"
    ),
    reasoningForTarget: (target) => target.reasoning ?? { effort: "none" },
    reasoningParameterStyle: "effort_field"
  });
}

function createOpenAICompatibleAdapters(input: {
  models: PublicModelConfig[];
  env: NodeJS.ProcessEnv;
  logger?: { warn: (obj: Record<string, unknown>, msg: string) => void };
  runtime: "openrouter" | "qianfan" | "aliyun" | "tencent";
  providerKind: "openrouter" | "qianfan" | "aliyun" | "tencent";
  displayName: string;
  apiKeyEnvName: string;
  baseUrl: string;
  timeoutMs: number;
  reasoningForTarget: (target: OpenAICompatibleAdapterTarget) => Record<string, unknown> | undefined;
  reasoningParameterStyle?: "object" | "effort_field";
  siteUrl?: string;
  appTitle?: string;
}): OpenAICompatibleAdapterMap {
  const adapters: OpenAICompatibleAdapterMap = new Map();
  const apiKey = input.env[input.apiKeyEnvName]?.trim();
  const enabledTargets = openAICompatibleAdapterTargets(input.models, input.runtime);
  assertUniqueOpenAICompatibleAdapterTargetIds(enabledTargets);
  if (!apiKey) {
    if (enabledTargets.length > 0) {
      input.logger?.warn(
        {
          api_key_env: input.apiKeyEnvName,
          public_model_ids: uniqueValues(enabledTargets.map((target) => target.publicModelId)),
          adapter_ids: enabledTargets.map((target) => target.id)
        },
        `${input.displayName} public models are configured but the API key env is missing; those models will not be exposed.`
      );
    }
    return adapters;
  }

  for (const target of enabledTargets) {
    adapters.set(
      target.id,
      new OpenAICompatibleProviderAdapter({
        providerKind: input.providerKind,
        baseUrl: input.baseUrl,
        apiKey,
        apiKeyEnv: input.apiKeyEnvName,
        upstreamModel: target.upstreamModel,
        reasoning: input.reasoningForTarget(target),
        reasoningParameterStyle: input.reasoningParameterStyle,
        siteUrl: input.siteUrl,
        appTitle: input.appTitle,
        timeoutMs: input.timeoutMs
      })
    );
  }
  return adapters;
}

function openAICompatibleAdapterTargets(
  models: PublicModelConfig[],
  runtime: OpenAICompatibleRuntimeKind
): OpenAICompatibleAdapterTarget[] {
  const targets: OpenAICompatibleAdapterTarget[] = [];
  for (const model of models) {
    if (!model.enabled) {
      continue;
    }
    if (model.runtime === runtime) {
      targets.push({
        id: model.id,
        publicModelId: model.id,
        runtime,
        upstreamModel: model.upstreamModel,
        ...(model.reasoning ? { reasoning: model.reasoning } : {})
      });
      continue;
    }
    if (model.runtime !== "pool" || !model.pool) {
      continue;
    }
    for (const member of model.pool.members) {
      if (!member.enabled || member.runtime !== runtime) {
        continue;
      }
      const reasoning = member.reasoning ?? model.reasoning;
      targets.push({
        id: member.id,
        publicModelId: model.id,
        runtime,
        upstreamModel: member.upstreamModel,
        ...(reasoning ? { reasoning } : {})
      });
    }
  }
  return targets;
}

function assertUniqueOpenAICompatibleAdapterTargetIds(
  targets: OpenAICompatibleAdapterTarget[]
): void {
  const seen = new Set<string>();
  for (const target of targets) {
    if (seen.has(target.id)) {
      throw new Error(`Duplicate OpenAI-compatible adapter id '${target.id}'.`);
    }
    seen.add(target.id);
  }
}

function createPublicModelPoolRouters(
  models: PublicModelConfig[],
  adaptersByRuntime: Record<OpenAICompatibleRuntimeKind, OpenAICompatibleAdapterMap>,
  now: () => Date
): PublicModelPoolRouters {
  const routers: PublicModelPoolRouters = new Map();
  for (const model of models) {
    if (!model.enabled || model.runtime !== "pool" || !model.pool) {
      continue;
    }
    const runtimes: UpstreamAccountRuntimeInput[] = [];
    for (const member of model.pool.members) {
      if (!member.enabled) {
        continue;
      }
      const adapter = adaptersByRuntime[member.runtime].get(member.id);
      if (!adapter) {
        continue;
      }
      runtimes.push({
        upstreamAccount: poolMemberUpstreamAccount(model, member),
        provider: adapter,
        enabled: true,
        maxConcurrent: member.maxConcurrent ?? null
      });
    }
    if (runtimes.length > 0) {
      routers.set(
        model.id,
        new UpstreamAccountRouter(runtimes, {
          softAffinity: "credential",
          cooldown: defaultUpstreamCooldown(),
          now
        })
      );
    }
  }
  return routers;
}

function poolMemberUpstreamAccount(
  model: PublicModelConfig,
  member: PublicModelPoolMemberConfig
): UpstreamAccount {
  return {
    id: member.id,
    provider: member.runtime,
    label: `${model.displayName} ${member.runtime}`,
    credentialRef: `PUBLIC_MODEL_POOL:${model.id}:${member.id}`,
    state: "active",
    lastUsedAt: null,
    cooldownUntil: null
  };
}

function poolMemberAdapterKeys(
  adaptersByRuntime: Record<OpenAICompatibleRuntimeKind, OpenAICompatibleAdapterMap>
): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const [runtime, adapterMap] of Object.entries(adaptersByRuntime) as Array<
    [OpenAICompatibleRuntimeKind, OpenAICompatibleAdapterMap]
  >) {
    for (const id of adapterMap.keys()) {
      ids.add(publicModelPoolMemberAdapterKey(runtime, id));
    }
  }
  return ids;
}

function uniqueValues(values: string[]): string[] {
  return [...new Set(values)];
}

function assertUpstreamPoolAvailable(
  router: UpstreamAccountRouter,
  env: NodeJS.ProcessEnv
): void {
  if (env.NODE_ENV !== "production" || env.GATEWAY_ALLOW_EMPTY_UPSTREAM_POOL === "1") {
    return;
  }
  const selection = router.selectForNewSession();
  if (selection instanceof GatewayError) {
    throw new Error(`Production runtime has no available upstream account: ${selection.message}`);
  }
}

function applyUpstreamSelection(
  request: FastifyRequest,
  selection: UpstreamAccountSelection
): void {
  const context = getGatewayContext(request);
  request.gatewayContext = {
    ...context,
    upstreamAccount: selection.upstreamAccount,
    provider: selection.provider
  };
}

function applyChatRuntimeContext(
  request: FastifyRequest,
  runtime: ChatRuntimeContext
): void {
  const context = getGatewayContext(request);
  request.gatewayContext = {
    ...context,
    upstreamAccount: runtime.adapterInputUpstreamAccount,
    provider: runtime.adapter
  };
  request.gatewayPublicModelId = runtime.publicModelId;
  request.gatewayUpstreamRuntime = runtime.runtime;
  request.gatewayUpstreamModel = runtime.upstreamModel;
  request.gatewayReasoningEffort = runtime.reasoningEffort;
  markSession(request, runtime.session.id);
}

function chatRuntimeAffinityKey(
  request: FastifyRequest,
  publicModel: PublicModelConfig,
  codexSoftAffinity: UpstreamSoftAffinity
): string | null {
  if (publicModel.runtime !== "pool") {
    return requestAffinityKey(request, codexSoftAffinity);
  }
  const { credential, subject } = getGatewayContext(request);
  return publicModelPoolAffinityKey(publicModel, {
    client_session: request.gatewayClientSessionId ?? null,
    credential: credential.id,
    subject: subject.id
  });
}

function requestAffinityKey(
  request: FastifyRequest,
  mode: UpstreamSoftAffinity
): string | null {
  if (mode === "none") {
    return null;
  }
  const { credential, subject } = getGatewayContext(request);
  return mode === "credential" ? credential.id : subject.id;
}

function upstreamOutcomeFromError(error: GatewayError): UpstreamAccountOutcome | null {
  if (error.code === "provider_reauth_required") {
    return "provider_reauth_required";
  }
  if (error.code === "rate_limited") {
    return "rate_limited";
  }
  if (
    error.code === "service_unavailable" ||
    error.code === "upstream_unavailable" ||
    error.code === "upstream_timeout" ||
    error.code === "upstream_incomplete_stream" ||
    error.code === "upstream_empty_response"
  ) {
    return "service_error";
  }
  return null;
}

function isStatelessRetryableProviderError(error: GatewayError): boolean {
  return upstreamOutcomeFromError(error) !== null;
}

function recordChatRuntimeErrorOutcome(
  runtime: ChatRuntimeContext,
  error: GatewayError
): void {
  if (error.code === "client_aborted") {
    return;
  }
  if (!runtime.recordError(error)) {
    runtime.recordSuccess();
  }
}

function recordUpstreamErrorOutcome(
  router: UpstreamAccountRouter,
  lease: UpstreamAccountLease,
  error: GatewayError
): boolean {
  const outcome = upstreamOutcomeFromError(error);
  if (outcome) {
    router.recordOutcome(lease.upstreamAccount.id, outcome);
    return true;
  }
  return false;
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

const maxRequestReasoningEfforts = ["minimal", "low", "medium", "high", "xhigh"] as const;
const standardRequestReasoningEfforts = ["none", "low", "medium", "high"] as const;
const legacyStandardReasoningModelIds = new Set([
  "specialist",
  "expert",
  "advisor",
  "consultant",
  "pro",
  "standard"
]);

function resolveChatCompletionReasoningEffort(
  model: PublicModelConfig,
  requested: string | undefined,
  requestModelId: string
): string | null | GatewayError {
  if (requested === undefined) {
    return configuredReasoningEffortForModel(model);
  }

  const supported = supportedReasoningEffortsForModel(model);
  if (!supported) {
    return new GatewayError({
      code: "invalid_request",
      message: `reasoning_effort is not supported for model '${requestModelId}'.`,
      httpStatus: 400
    });
  }

  if (!supported.values.includes(requested)) {
    return new GatewayError({
      code: "invalid_request",
      message: `reasoning_effort '${requested}' is not supported for model '${requestModelId}'. Supported values: ${supported.values.join(", ")}.`,
      httpStatus: 400
    });
  }

  return requested;
}

function configuredReasoningEffortForModel(model: PublicModelConfig): string | null {
  const effort = model.reasoning?.effort;
  return typeof effort === "string" && effort.length > 0 ? effort : null;
}

function supportedReasoningEffortsForModel(
  model: PublicModelConfig
): { values: readonly string[] } | null {
  if (isMaxReasoningModel(model)) {
    return { values: maxRequestReasoningEfforts };
  }
  if (
    legacyStandardReasoningModelIds.has(model.id) ||
    usesOpenAICompatiblePublicRuntime(model.runtime)
  ) {
    return { values: standardRequestReasoningEfforts };
  }
  return null;
}

function isMaxReasoningModel(model: PublicModelConfig): boolean {
  return (
    model.id === "max" ||
    model.aliases.includes("medcode") ||
    (model.runtime === "codex" && model.displayName.toLowerCase() === "max")
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
  if (!env.CODEX_HOME && !env.GATEWAY_UPSTREAM_ACCOUNTS_JSON) {
    throw new Error("Production runtime requires CODEX_HOME or GATEWAY_UPSTREAM_ACCOUNTS_JSON.");
  }
  if (env.GATEWAY_DEV_ACCESS_TOKEN) {
    throw new Error("Production runtime must not set GATEWAY_DEV_ACCESS_TOKEN.");
  }
  if (env.MEDCODE_IMAGE_GENERATION_ENABLED === "1" && !env.MEDCODE_IMAGE_OPENAI_API_KEY) {
    throw new Error("Production image generation requires MEDCODE_IMAGE_OPENAI_API_KEY.");
  }
  if (Boolean(env.GATEWAY_UPSTREAM_V2_BASE_URL) !== Boolean(env.GATEWAY_UPSTREAM_V2_TOKEN)) {
    throw new Error("Production upstream v2 config requires GATEWAY_UPSTREAM_V2_BASE_URL and GATEWAY_UPSTREAM_V2_TOKEN together.");
  }
  if (env.GATEWAY_BILLING_ADMIN_TOKEN) {
    if (!env.GATEWAY_API_KEY_ENCRYPTION_SECRET) {
      throw new Error("Production billing admin API requires GATEWAY_API_KEY_ENCRYPTION_SECRET.");
    }
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

function isUnifiedClientKeyStore(
  store: GatewayStore
): store is GatewayStore & UnifiedClientKeyStore {
  const candidate = store as Partial<UnifiedClientKeyStore>;
  return (
    typeof candidate.insertUnifiedClientKey === "function" &&
    typeof candidate.getUnifiedClientKeyByPrefix === "function" &&
    typeof candidate.listUnifiedClientKeys === "function" &&
    typeof candidate.revokeUnifiedClientKeyByPrefix === "function"
  );
}

function isBillingAdminTokenStore(
  store: GatewayStore
): store is GatewayStore & BillingAdminTokenStore {
  const candidate = store as Partial<BillingAdminTokenStore>;
  return (
    typeof candidate.insertBillingAdminToken === "function" &&
    typeof candidate.getBillingAdminTokenByPrefix === "function" &&
    typeof candidate.listBillingAdminTokens === "function" &&
    typeof candidate.revokeBillingAdminTokenByPrefix === "function" &&
    typeof candidate.updateBillingAdminTokenLastUsedAt === "function"
  );
}

function isAdminAuditStore(store: GatewayStore): store is GatewayStore & AdminAuditStore {
  const candidate = store as Partial<AdminAuditStore>;
  return (
    typeof candidate.insertAdminAuditEvent === "function" &&
    typeof candidate.listAdminAuditEvents === "function"
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

function isPlanEntitlementStore(store: GatewayStore): store is GatewayStore & PlanEntitlementStore {
  const candidate = store as Partial<PlanEntitlementStore>;
  return (
    typeof candidate.createPlan === "function" &&
    typeof candidate.listPlans === "function" &&
    typeof candidate.getPlan === "function" &&
    typeof candidate.deprecatePlan === "function" &&
    typeof candidate.grantEntitlement === "function" &&
    typeof candidate.renewEntitlement === "function" &&
    typeof candidate.getEntitlement === "function" &&
    typeof candidate.listEntitlements === "function" &&
    typeof candidate.pauseEntitlement === "function" &&
    typeof candidate.resumeEntitlement === "function" &&
    typeof candidate.cancelEntitlement === "function" &&
    typeof candidate.entitlementAccessForSubject === "function" &&
    typeof candidate.subjectHasEntitlementHistory === "function"
  );
}

function isBillingAdminStore(store: GatewayStore): store is GatewayStore & BillingAdminStore {
  const candidate = store as Partial<BillingAdminStore>;
  return (
    typeof candidate.applyBillingEntitlementEvent === "function" &&
    typeof candidate.replayBillingSubjectCreate === "function" &&
    typeof candidate.createBillingSubject === "function" &&
    typeof candidate.replayBillingSubjectRotate === "function" &&
    typeof candidate.rotateBillingSubject === "function" &&
    typeof candidate.replayBillingSubjectDisable === "function" &&
    typeof candidate.disableBillingSubject === "function" &&
    typeof candidate.getBillingSubject === "function" &&
    typeof candidate.getBillingSubjectByExternal === "function" &&
    typeof candidate.getBillingSubjectActiveUnifiedKey === "function" &&
    typeof candidate.getBillingEventByIdempotencyKey === "function" &&
    typeof candidate.listBillingEvents === "function" &&
    typeof candidate.listBillingEntitlements === "function" &&
    typeof candidate.reportBillingUsage === "function"
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
