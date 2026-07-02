import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import {
  type AdminAuditStore,
  type BillingAdminStore,
  type BillingAdminTokenStore,
  type ClientDiagnosticEventRecord,
  type ClientMessageEventStore,
  type CredentialAuthStore,
  decryptSecret,
  extractUnifiedClientKeyPrefix,
  GatewayError,
  publicFeaturePolicy,
  type GatewaySession,
  type GatewayStore,
  type ObservationStore,
  mergeEntitlementTokenPolicy,
  type PlanEntitlementStore,
  type ProviderAdapter,
  type ProviderErrorDiagnostic,
  type RateLimitPolicy,
  type Scope,
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
  CodexProviderAdapter,
  type CodexProviderOptions
} from "@codex-gateway/provider-codex";
import {
  buildQuotaDashboardData,
  buildRealtimeTokenUsageData,
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
import {
  resolveUpstreamV2Client,
  type UpstreamV2Client
} from "./upstream-v2-client.js";
import { credentialAuthHook, devAuthHook } from "./http/auth.js";
import { getGatewayContext } from "./http/context.js";
import {
  markClientAborted,
  markFirstByte,
  markGatewayError,
  markSession,
  markTokenUsage,
  recordObservation,
  startObservation
} from "./http/observation.js";
import { rateLimitHook, releaseRateLimit } from "./http/rate-limit.js";
import { setupSseResponse } from "./http/sse.js";
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
  buildImageGenerationResponse,
  finalizeImageGenerationResult,
  isImageBillingLimitError,
  maxPromptCharsFromEnv,
  OpenAIImageGenerationProvider,
  parseImageGenerationRequest,
  parseImageModelMap,
  resolveImageUpstreamModel,
  type ImageGenerationRequest,
  type ImageGenerationProvider
} from "./image-generation.js";
import {
  attachProviderStreamSummary,
  combineProviderStreamSummaries,
  collectProviderMessage,
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
  finalizeTokenBudget,
  publicRatePolicy,
  publicTokenPolicy,
  publicTokenUsage
} from "./services/token-budget-hook.js";
import {
  createChatRuntimeDispatcher,
  type ChatRuntimeContext
} from "./services/chat-runtime-dispatcher.js";
import { resolveEntitlementAccessForChat } from "./services/entitlement-access.js";
import { OpenAICompatibleProviderAdapter } from "./services/openai-compatible-provider.js";
import {
  modelNotFoundError,
  openAIModelObject,
  resolvePublicModelRegistry,
  type PublicModelConfig
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
  upstreamV2Client?: UpstreamV2Client | null;
  tokenBudgetLimiter?: TokenBudgetLimiter;
  planEntitlementStore?: PlanEntitlementStore;
  imageGenerationProvider?: ImageGenerationProvider | null;
  imageGenerationBillingFallbackProvider?: ImageGenerationProvider | null;
  imageGenerationBillingFallbackModel?: string;
  now?: () => Date;
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

interface ResolvedUpstreamAccountPool {
  runtimes: UpstreamAccountRuntimeInput[];
  softAffinity: UpstreamSoftAffinity;
  cooldown: UpstreamAccountCooldownConfig;
  accountPoolConfigured: boolean;
}

const maxStatelessAttempts = 2;
const defaultImageBillingFallbackModel = "gpt-image-1.5";
const imageBillingFallbackAccountId = "image-billing-fallback";

interface ImageGenerationBillingFallback {
  provider: ImageGenerationProvider;
  upstreamModel: string;
}

export function buildGateway(options: GatewayOptions = {}) {
  const app = Fastify({
    logger: options.logger ?? true,
    genReqId: () => `req-${randomUUID()}`
  });
  const accessToken = options.accessToken ?? process.env.GATEWAY_DEV_ACCESS_TOKEN;
  const clock = options.now ?? (() => new Date());
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
  const openRouterAdapters = createOpenRouterAdapters(publicModelRegistry.models, process.env, app.log);
  const qianfanAdapters = createQianfanAdapters(publicModelRegistry.models, process.env, app.log);
  const aliyunAdapters = createAliyunAdapters(publicModelRegistry.models, process.env, app.log);
  const tencentAdapters = createTencentAdapters(publicModelRegistry.models, process.env, app.log);
  const chatRuntimeDispatcher = createChatRuntimeDispatcher({
    codexRouter: upstreamRouter,
    openRouterAdapterForModel: (model) => openRouterAdapters.get(model.id) ?? null,
    qianfanAdapterForModel: (model) => qianfanAdapters.get(model.id) ?? null,
    aliyunAdapterForModel: (model) => aliyunAdapters.get(model.id) ?? null,
    tencentAdapterForModel: (model) => tencentAdapters.get(model.id) ?? null
  });
  const openRouterAvailable = openRouterAdapters.size > 0;
  const qianfanAvailable = qianfanAdapters.size > 0;
  const aliyunAvailable = aliyunAdapters.size > 0;
  const tencentAvailable = tencentAdapters.size > 0;
  const publicModelAvailability = {
    openRouterAvailable,
    qianfanAvailable,
    aliyunAvailable,
    tencentAvailable
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
  const imageGenerationProvider =
    options.imageGenerationProvider === undefined
      ? upstreamRouter.hasImageBindingDeclared()
        ? undefined
        : createDefaultImageGenerationProvider(process.env)
      : options.imageGenerationProvider ?? undefined;
  const imageGenerationBillingFallback =
    options.imageGenerationBillingFallbackProvider === undefined
      ? createDefaultImageGenerationBillingFallback(process.env)
      : options.imageGenerationBillingFallbackProvider
        ? {
            provider: options.imageGenerationBillingFallbackProvider,
            upstreamModel:
              options.imageGenerationBillingFallbackModel ?? defaultImageBillingFallbackModel
          }
        : undefined;
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
          billingFallback: imageGenerationBillingFallback
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
        if (isImageBillingLimitError(error) && imageGenerationBillingFallback) {
          try {
            return await generateImageWithBillingFallback(request, abort, {
              parsed,
              billingFallback: imageGenerationBillingFallback
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

  app.post<{ Body: unknown }>("/v1/chat/completions", async (request, reply) => {
    const parsed = parseChatCompletionRequest(request.body, publicModelRegistry.defaultModelId);
    if (parsed instanceof GatewayError) {
      return sendOpenAIError(request, reply, parsed);
    }
    applyClientTurnHeaders(request);
    const publicModel = publicModelRegistry.get(parsed.model);
    request.gatewayPublicModelId = parsed.model;
    if (
      !publicModel ||
      !publicModelRegistry.isAvailable(publicModel, publicModelAvailability)
    ) {
      request.gatewayObservedUpstreamAccount = { id: null, provider: null };
      return sendOpenAIError(request, reply, modelNotFoundError(parsed.model));
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
      return sendOpenAIError(request, reply, entitlementAccess);
    }

    const affinityKey = requestAffinityKey(request, upstreamRouter.softAffinity);
    const attemptedAccountIds = new Set<string>();
    let statelessAttempts = 1;
    const { subject, scope } = getGatewayContext(request);
    let attempt = chatRuntimeDispatcher.begin({
      model: publicModel,
      subject,
      scope,
      affinityKey,
      createSession: createStatelessSession
    });
    if (attempt instanceof GatewayError) {
      return sendOpenAIError(request, reply, attempt);
    }
    applyChatRuntimeContext(request, attempt);
    const shape = createChatCompletionShape(parsed.model);
    const nativeClientTools = hasNativeClientTools(parsed, publicModel);
    const strictClientTools = hasStrictClientTools(parsed) && !nativeClientTools;
    request.gatewayToolChoice = serializeToolChoice(
      nativeClientTools ? initialNativeToolChoice(parsed, attempt.upstreamModel) : parsed.toolChoice
    );
    const prompt = strictClientTools
      ? chatMessagesToStrictToolPrompt(parsed)
      : chatMessagesToPrompt(parsed, { includeToolsContext: !nativeClientTools });
    request.gatewayEstimatedTokens = estimatePromptTokens(
      prompt,
      chatCompletionEstimateExtras(parsed, strictClientTools, publicModel)
    );
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
      return sendOpenAIError(request, reply, tokenBudgetError);
    }

    if (parsed.stream) {
      const sse = setupSseResponse(reply);
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
          writeInitialChunk();
          const strictResult = await runStrictClientTools({
            provider: attempt.adapter,
            upstreamAccount: attempt.adapterInputUpstreamAccount,
            upstreamRuntime: attempt.runtime,
            upstreamModel: attempt.upstreamModel,
            subject: attempt.subject,
            scope: attempt.scope,
            session: attempt.session,
            request: parsed,
            prompt,
            signal: sse.signal,
            requestId: request.id,
            log: request.log,
            onProviderError
          });
          if (strictResult instanceof GatewayError) {
            if (!attempt.recordError(strictResult)) {
              attempt.recordSuccess();
            }
            markProviderStreamSummary(request, providerStreamSummaryFromError(strictResult));
            request.gatewayErrorCode = strictResult.code;
            sse.writeData(openAIErrorPayload(strictResult));
            failed = true;
          } else if (strictResult.toolCalls.length > 0) {
            attempt.recordSuccess();
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
            attempt.recordSuccess();
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
          writeInitialChunk();
          const nativeResult = await runNativeClientTools({
            provider: attempt.adapter,
            upstreamAccount: attempt.adapterInputUpstreamAccount,
            upstreamRuntime: attempt.runtime,
            upstreamModel: attempt.upstreamModel,
            subject: attempt.subject,
            scope: attempt.scope,
            session: attempt.session,
            request: parsed,
            prompt,
            signal: sse.signal,
            requestId: request.id,
            log: request.log,
            onProviderError
          });
          if (nativeResult instanceof GatewayError) {
            if (!attempt.recordError(nativeResult)) {
              attempt.recordSuccess();
            }
            markProviderStreamSummary(request, providerStreamSummaryFromError(nativeResult));
            request.gatewayErrorCode = nativeResult.code;
            sse.writeData(openAIErrorPayload(nativeResult));
            failed = true;
          } else if (nativeResult.toolCalls.length > 0) {
            attempt.recordSuccess();
            hasToolCalls = true;
            usage = nativeResult.usage;
            markProviderStreamSummary(request, nativeResult.providerSummary);
            markOpenAITokenUsage(request, usage);
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
            attempt.recordSuccess();
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
            let retrying = false;
            for await (const event of attempt.adapter.message({
              upstreamAccount: attempt.adapterInputUpstreamAccount,
              subject: attempt.subject,
              scope: attempt.scope,
              session: attempt.session,
              message: prompt,
              clientTools: nativeClientTools ? parsed.tools : undefined,
              clientToolChoice: nativeClientTools ? parsed.toolChoice : undefined,
              signal: sse.signal,
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
                    retrying = true;
                    break;
                  }
                }
                writeInitialChunk();
                request.gatewayErrorCode = error.code;
                markProviderStreamSummary(
                  request,
                  combineProviderStreamSummaries(providerSummaries) ?? errorSummary
                );
                sse.writeData(openAIErrorPayload(error));
                failed = true;
                break;
              }

              if (!writeInitialChunk()) {
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
              if (chunk && !sse.writeData(chunk)) {
                break;
              }
            }
            if (retrying) {
              continue;
            }
            if (!failed) {
              attempt.recordSuccess();
              const successSummary = providerSummary.snapshot(
                chatRuntimeAttemptContext(attempt, attemptKind, parsed.toolChoice)
              );
              providerSummaries.push(successSummary);
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
        releaseRateLimit(request);
        recordObservation(request, observationStore, reply.raw.statusCode);
        sse.end();
      }
      return;
    }

    let content = "";
    const toolCalls: OpenAIChatToolCall[] = [];
    let usage: OpenAIChatUsage | null = null;

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
          request: parsed,
          prompt,
          requestId: request.id,
          log: request.log,
          onProviderError
        });
        if (strictResult instanceof GatewayError) {
          if (!attempt.recordError(strictResult)) {
            attempt.recordSuccess();
          }
          markProviderStreamSummary(request, providerStreamSummaryFromError(strictResult));
          return sendOpenAIError(request, reply, strictResult);
        }
        attempt.recordSuccess();
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
          request: parsed,
          prompt,
          requestId: request.id,
          log: request.log,
          onProviderError
        });
        if (nativeResult instanceof GatewayError) {
          if (!attempt.recordError(nativeResult)) {
            attempt.recordSuccess();
          }
          markProviderStreamSummary(request, providerStreamSummaryFromError(nativeResult));
          return sendOpenAIError(request, reply, nativeResult);
        }
        attempt.recordSuccess();
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
            clientTools: nativeClientTools ? parsed.tools : undefined,
            clientToolChoice: nativeClientTools ? parsed.toolChoice : undefined,
            attemptKind: statelessAttempts > 1 ? "stateless_retry" : "primary",
            attemptToolChoice: serializeToolChoice(parsed.toolChoice),
            upstreamRuntime: attempt.runtime,
            upstreamModel: attempt.upstreamModel,
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
                continue;
              }
            }
            markProviderStreamSummary(
              request,
              combineProviderStreamSummaries(providerSummaries) ?? providerSummary
            );
            return sendOpenAIError(request, reply, attemptResult);
          }
          collected = attemptResult;
          providerSummaries.push(collected.providerSummary);
          attempt.recordSuccess();
          break;
        }
        if (!collected) {
          return sendOpenAIError(
            request,
            reply,
            new GatewayError({
              code: "service_unavailable",
              message: "MedCode service is temporarily unavailable.",
              httpStatus: 503
            })
          );
        }
        if (collected.content.length > 0 || collected.toolCalls.length > 0) {
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
        if (!providerFailed && !outcomeRecorded) {
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
  request: ChatCompletionRequest;
  prompt: string;
  signal?: AbortSignal;
  requestId?: string;
  log?: StrictClientToolsLogger;
  onProviderError?: (diagnostic: ProviderErrorDiagnostic) => void;
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
  input: StrictClientToolsInput
): Promise<StrictClientToolsResult | GatewayError> {
  const firstToolChoice = initialNativeToolChoice(input.request, input.upstreamModel);
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
    return secondResult;
  }
  const retryPlan = nativeAutoToolRetryPlan(
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
  return secondResult.toolCalls.length > 0 ? secondResult : firstResult;
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
    clientTools: input.request.tools,
    clientToolChoice: toolChoice,
    attemptKind,
    attemptToolChoice: serializeToolChoice(toolChoice),
    upstreamRuntime: input.upstreamRuntime,
    upstreamModel: input.upstreamModel,
    signal: input.signal,
    onProviderError: input.onProviderError,
    suppressTextAfterToolCall: true
  });
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
  return strictDecisionToResult(parsed, usage, providerSummary);
}

interface NativeAutoToolRetryPlan {
  kind: "auto_ack_to_required" | "auto_ack_to_auto" | "auto_empty_to_auto";
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
  prompt: string
): NativeAutoToolRetryPlan | null {
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

  if (usesAutoOnlyNativeTools(upstreamModel)) {
    return {
      kind: "auto_ack_to_auto",
      toolChoice: "auto",
      prompt: nativeToolAcknowledgementRetryPrompt(prompt)
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

function initialNativeToolChoice(
  request: ChatCompletionRequest,
  upstreamModel: string
): ChatCompletionRequest["toolChoice"] {
  return shouldRequireNativeToolForFileGeneration(request, upstreamModel)
    ? "required"
    : request.toolChoice;
}

function shouldRequireNativeToolForFileGeneration(
  request: ChatCompletionRequest,
  upstreamModel: string
): boolean {
  if (request.toolChoice !== "auto" || !request.tools?.length) {
    return false;
  }
  if (usesAutoOnlyNativeTools(upstreamModel)) {
    return false;
  }
  if (!request.tools.some((tool) => looksLikeFileOrCodeTool(tool))) {
    return false;
  }
  return looksLikeFileGenerationTask(request);
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

function looksLikeFileGenerationTask(request: ChatCompletionRequest): boolean {
  const text = request.messages
    .map((message) => (typeof message.content === "string" ? message.content : ""))
    .join("\n")
    .toLowerCase();
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
    attemptKind,
    attemptToolChoice: serializeToolChoice(input.request.toolChoice),
    upstreamRuntime: input.upstreamRuntime,
    upstreamModel: input.upstreamModel,
    signal: input.signal,
    onProviderError: input.onProviderError,
    suppressToolCalls: true
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

function sendImageError(request: FastifyRequest, reply: FastifyReply, error: GatewayError) {
  markGatewayError(request, error);
  reply.code(error.httpStatus);
  return {
    error: {
      code: error.code,
      message: error.message,
      request_id: request.id
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
    billingFallback?: ImageGenerationBillingFallback;
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
        if (isImageBillingLimitError(error) && input.billingFallback) {
          try {
            return await generateImageWithBillingFallback(request, abort, {
              parsed: input.parsed,
              billingFallback: input.billingFallback
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

async function generateImageWithBillingFallback(
  request: FastifyRequest,
  abort: ImageRequestAbort,
  input: {
    parsed: ImageGenerationRequest;
    billingFallback: ImageGenerationBillingFallback;
  }
) {
  request.gatewayObservedUpstreamAccount = {
    id: imageBillingFallbackAccountId,
    provider: null
  };
  const result = await runImageGenerationWithAbort(input.billingFallback.provider, abort, {
    request: input.parsed,
    upstreamModel: input.billingFallback.upstreamModel
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

function sendOpenAIError(request: FastifyRequest, reply: FastifyReply, error: GatewayError) {
  markGatewayError(request, error);
  if (error.upstreamStatus !== undefined) {
    request.gatewayUpstreamHttpStatus = error.upstreamStatus;
  }
  reply.code(error.httpStatus);
  return openAIErrorPayload(error);
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

function bearerToken(request: FastifyRequest): string | GatewayError {
  const authorization = request.headers.authorization;
  if (!authorization) {
    return new GatewayError({
      code: "missing_credential",
      message: "Missing unified key.",
      httpStatus: 401
    });
  }

  const [scheme, token] = authorization.split(/\s+/, 2);
  if (scheme?.toLowerCase() !== "bearer" || !token) {
    return invalidUnifiedKeyError();
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
  publicModel: PublicModelConfig
): string {
  const runtimeExtra =
    publicModel.runtime === "openrouter"
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
  return isOpenAICompatibleRuntime(publicModel.runtime) && hasStrictClientTools(request);
}

function isOpenAICompatibleRuntime(runtime: PublicModelConfig["runtime"]): boolean {
  return (
    runtime === "openrouter" ||
    runtime === "qianfan" ||
    runtime === "aliyun" ||
    runtime === "tencent"
  );
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

function createDefaultClientEventsStore(): ClientMessageEventStore | undefined {
  const sqlitePath = process.env.GATEWAY_CLIENT_EVENTS_SQLITE_PATH;
  if (!sqlitePath) {
    return undefined;
  }

  return createSqliteClientEventsStore({ path: sqlitePath });
}

function clientEventsRateLimitKey(
  credentialId: string,
  eventFamily: "messages" | "diagnostics"
): string {
  return `${credentialId}:${eventFamily}`;
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

function applyClientTurnHeaders(request: FastifyRequest): void {
  request.gatewayClientTurnId = readSingleHeader(request, "x-medcode-client-turn-id", 128);
  request.gatewayTurnCode = readSingleHeader(request, "x-medcode-client-turn-code", 64);
  request.gatewayClientSessionId = readSingleHeader(request, "x-medcode-client-session-id", 128);
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
    upstreamAccountId: runtime.attributionAccount.id
  };
}

function markProviderStreamSummary(
  request: FastifyRequest,
  summary: ProviderStreamSummary | null
): void {
  if (!summary) {
    return;
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

function createDefaultImageGenerationBillingFallback(
  env: NodeJS.ProcessEnv
): ImageGenerationBillingFallback | undefined {
  if (env.MEDCODE_IMAGE_GENERATION_ENABLED !== "1") {
    return undefined;
  }
  const apiKey = env.MEDCODE_IMAGE_BILLING_FALLBACK_OPENAI_API_KEY?.trim();
  if (!apiKey) {
    return undefined;
  }
  return {
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
    upstreamModel: parseImageBillingFallbackModel(env.MEDCODE_IMAGE_BILLING_FALLBACK_MODEL)
  };
}

function parseImageBillingFallbackModel(value: string | undefined): string {
  const model = value?.trim() || defaultImageBillingFallbackModel;
  if (!model) {
    throw new Error("MEDCODE_IMAGE_BILLING_FALLBACK_MODEL must be a non-empty string.");
  }
  return model;
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
): Map<string, ProviderAdapter> {
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
    reasoningForModel: (model) => model.reasoning ?? { effort: "none" },
    siteUrl: env.MEDCODE_OPENROUTER_SITE_URL,
    appTitle: env.MEDCODE_OPENROUTER_APP_TITLE ?? "MedCode"
  });
}

function createQianfanAdapters(
  models: PublicModelConfig[],
  env: NodeJS.ProcessEnv,
  logger?: { warn: (obj: Record<string, unknown>, msg: string) => void }
): Map<string, ProviderAdapter> {
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
    reasoningForModel: (model) => model.reasoning
  });
}

function createAliyunAdapters(
  models: PublicModelConfig[],
  env: NodeJS.ProcessEnv,
  logger?: { warn: (obj: Record<string, unknown>, msg: string) => void }
): Map<string, ProviderAdapter> {
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
    reasoningForModel: (model) => model.reasoning ?? { effort: "none" },
    reasoningParameterStyle: "effort_field"
  });
}

function createTencentAdapters(
  models: PublicModelConfig[],
  env: NodeJS.ProcessEnv,
  logger?: { warn: (obj: Record<string, unknown>, msg: string) => void }
): Map<string, ProviderAdapter> {
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
    reasoningForModel: (model) => model.reasoning ?? { effort: "none" },
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
  reasoningForModel: (model: PublicModelConfig) => Record<string, unknown> | undefined;
  reasoningParameterStyle?: "object" | "effort_field";
  siteUrl?: string;
  appTitle?: string;
}): Map<string, ProviderAdapter> {
  const adapters = new Map<string, ProviderAdapter>();
  const apiKey = input.env[input.apiKeyEnvName]?.trim();
  const enabledModels = input.models.filter(
    (model) => model.enabled && model.runtime === input.runtime
  );
  if (!apiKey) {
    if (enabledModels.length > 0) {
      input.logger?.warn(
        {
          api_key_env: input.apiKeyEnvName,
          public_model_ids: enabledModels.map((model) => model.id)
        },
        `${input.displayName} public models are configured but the API key env is missing; those models will not be exposed.`
      );
    }
    return adapters;
  }

  for (const model of enabledModels) {
    adapters.set(
      model.id,
      new OpenAICompatibleProviderAdapter({
        providerKind: input.providerKind,
        baseUrl: input.baseUrl,
        apiKey,
        apiKeyEnv: input.apiKeyEnvName,
        upstreamModel: model.upstreamModel,
        reasoning: input.reasoningForModel(model),
        reasoningParameterStyle: input.reasoningParameterStyle,
        siteUrl: input.siteUrl,
        appTitle: input.appTitle,
        timeoutMs: input.timeoutMs
      })
    );
  }
  return adapters;
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
    error.code === "upstream_timeout"
  ) {
    return "service_error";
  }
  return null;
}

function isStatelessRetryableProviderError(error: GatewayError): boolean {
  return upstreamOutcomeFromError(error) !== null;
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
    typeof candidate.getPlan === "function" &&
    typeof candidate.grantEntitlement === "function" &&
    typeof candidate.entitlementAccessForSubject === "function"
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
