import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import {
  checkAccessCredentialState,
  credentialAllowsPublicModel,
  decryptSecret,
  formatAccessCredentialPublicPrefix,
  GatewayError,
  publicFeaturePolicy,
  mergeEntitlementTokenPolicy,
  type PlanEntitlementStore,
  type StreamEvent,
  unifiedClientKeyTokenPrefix,
  verifyAccessCredentialToken
} from "@codex-gateway/core";
import { cleanupStaleCodexRuntimeStateDirs } from "@codex-gateway/provider-codex";
import {
  buildQuotaDashboardData,
  buildRealtimeTokenUsageData,
  createSqliteTokenBudgetLimiter,
  renderRealtimeTokenUsagePage,
  renderQuotaDashboardPage,
  SqliteGatewayStore
} from "@codex-gateway/store-sqlite";
import {
  CLIENT_DIAGNOSTIC_BODY_LIMIT_BYTES,
  CLIENT_MESSAGE_BODY_LIMIT_BYTES,
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
  type AdminClientMessagesQuery
} from "./admin-client-messages.js";
import {
  registerBillingAdminRoutes,
  resolveBillingAdminAccess,
  resolveBillingAdminTokenMode
} from "./billing-admin.js";
import {
  applyPrivateResponseHeaders,
  assertPhoneAuthVersionGateCompatibility,
  desktopVersionHeader,
  desktopVersionGateError,
  isPhoneSessionRoute,
  needsMedevidenceIdentityFallback,
  resolveDesktopVersionGate,
  sendDesktopVersionGateError,
  shouldGateDesktopRoute
} from "./desktop-version-gate.js";
import {
  isApprovedMedevidenceOrigin,
  resolveMedevidenceOriginPolicy,
  selectMedevidenceOrigin
} from "./medevidence-origin-policy.js";
import {
  phoneAuthContractErrorHandler,
  registerPhoneAuthRoutes,
  sendPhoneAuthError
} from "./phone-auth-routes.js";
import {
  PhoneAuthService,
  resolvePhoneAuthMode,
  resolvePhoneAuthServiceOptions
} from "./services/phone-auth-service.js";
import { registerResearchRoutes } from "./research-routes.js";
import { resolveUpstreamV2Client } from "./upstream-v2-client.js";
import { credentialAuthHook, devAuthHook } from "./http/auth.js";
import { observeClientDisconnect } from "./http/client-disconnect.js";
import { getGatewayContext, researchRouteConfig } from "./http/context.js";
import { researchErrorPayload } from "./http/error-response.js";
import {
  markClientAborted,
  markFirstByte,
  markGatewayError,
  markProviderCallFinished,
  markProviderCallStarted,
  markProviderEvent,
  markRateLimitRejection,
  markSession,
  markTokenUsage,
  recordObservation,
  startObservation
} from "./http/observation.js";
import { rateLimitHook, releaseRateLimit } from "./http/rate-limit.js";
import { setupSseResponse } from "./http/sse.js";
import {
  boundedWritePolicyFromEnv,
  boundedWriteEnabled,
  WriteDeliveryAdmission,
  negotiateWriteDelivery,
  reservedWriteDeliveryRequestError
} from "./services/write-delivery.js";
import {
  chatMessagesToPrompt,
  chatMessagesToStrictToolPrompt,
  createChatCompletionResponse,
  createFinalChatCompletionChunk,
  createInitialChatCompletionChunk,
  hasStrictClientTools,
  openAIUsageFromTokenUsage,
  parseChatCompletionRequest,
  streamEventToChatCompletionChunk,
  type ChatCompletionRequest,
  type OpenAIChatToolCall,
  type OpenAIChatUsage
} from "./openai-compat.js";
import { InMemoryCredentialRateLimiter } from "./services/rate-limiter.js";
import {
  createResponsesFailedEvent,
  createResponsesResult,
  createResponsesStreamStart,
  parseResponsesRequest
} from "./responses-compat.js";
import {
  buildImageGenerationResponse,
  finalizeImageGenerationResult,
  maxPromptCharsFromEnv,
  parseImageGenerationRequest,
  parseImageModelMap,
  resolveImageUpstreamModel
} from "./image-generation.js";
import {
  combineProviderStreamSummaries,
  combineSuccessfulProviderStreamSummaries,
  collectProviderMessage,
  providerCompletionError,
  providerStreamSummaryFromError,
  ProviderStreamSummaryCollector,
  streamErrorToGatewayError,
  type CollectedProviderMessage,
  type ProviderStreamSummary
} from "./services/provider-stream.js";
import { UpstreamAccountRouter } from "./services/upstream-account-router.js";
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
import { createChatRuntimeDispatcher, type ChatRuntimeContext } from "./services/chat-runtime-dispatcher.js";
import { ActiveRequestRegistry, type ActiveRequestHandle } from "./services/active-request-registry.js";
import {
  createChatRequestDeadline,
  parseRequestedChatRequestTimeoutMs,
  parseChatRequestTimeoutPolicy,
  resolveChatRequestTimeoutMs
} from "./services/chat-request-deadline.js";
import {
  contextCompactionRequiredError,
  parseLocalContextAdmissionMode,
  providerTokenizedContextWindowDetails
} from "./services/local-context-admission.js";
import {
  assessToolLoopShadow,
  parseToolLoopShadowPolicy,
  toolLoopGuardAssessed,
  toolLoopGuardAssessmentFailed,
  toolLoopGuardNotAssessed
} from "./services/tool-loop-shadow.js";
import { resolveEntitlementAccessForChat } from "./services/entitlement-access.js";
import { canFailoverNativeError, nativeFailoverEnabled } from "./services/native-tool-failover.js";
import { VisionRequestRecovery, visionRecoveryRequestHeader } from "./services/vision-request-recovery.js";
import { visionDefaultRequestBodyBytes, visionInputLimitError } from "./services/vision-input-policy.js";
import { resolveProviderApiKey } from "./services/provider-secret.js";
import {
  resolveVisionAssetService,
  visionAssetMaximumIdCharacters
} from "./services/vision-asset-service.js";
import { registerVisionAssetRoutes } from "./vision-asset-routes.js";
import {
  modelNotFoundError,
  openAIModelObject,
  resolvePublicModelRegistry
} from "./services/public-model-registry.js";
import type { GatewayOptions } from "./gateway-options.js";
import {
  initialNativeToolChoice,
  parseNativeFileToolRecoveryPolicy,
  parseNativeToolForceRequiredMode
} from "./services/native-tool-policy.js";
import {
  maxStatelessAttempts,
  metadataString,
  normalizeBaseUrl,
  parseAuthMode,
  parseOptionalBoolean,
  parseOptionalPositiveInteger,
  parsePositiveIntegerEnv
} from "./runtime/env.js";
import {
  createDefaultClientEventsStore,
  createDefaultSessionStore,
  defaultSubject,
  isAdminAuditStore,
  isBillingAdminStore,
  isBillingAdminTokenStore,
  isCredentialAuthStore,
  isExternalIdentityStore,
  isObservationStore,
  isPhoneAuthStore,
  isPlanEntitlementStore,
  isSubjectMetadataStore,
  isUnifiedClientKeyStore,
  nativeSessionsUnavailable,
  publicProviderDetail,
  resolveNativeSessionPublicModel,
  resolvePublicMetadata,
  serializeSession,
  storeKind
} from "./runtime/gateway-state.js";
import {
  assertUpstreamPoolAvailable,
  createPublicModelPoolRouters,
  isStatelessRetryableProviderError,
  persistUpstreamAccountRuntimeState,
  poolMemberAdapterKeys,
  recordUpstreamErrorOutcome,
  resolveUpstreamAccountPool
} from "./runtime/upstream-accounts.js";
import {
  createAliyunAdapters,
  createLocalOpenAIAdapters,
  createOpenRouterAdapters,
  createQianfanAdapters,
  createTencentAdapters,
  createTiankuanAdapters,
  createTokenSwitchAdapters,
  createXaiVisionAdapters,
  localOpenAIInferenceHealth,
  localOpenAIInferenceRequiredForReadiness
} from "./runtime/chat-providers.js";
import {
  resolveAuthMode,
  validateAuthModeForEnvironment,
  validateRuntimeEnvironment
} from "./runtime/auth-config.js";
import {
  createDefaultResearchRuntime,
  isResearchWorkerHealthStore,
  parseResearchLlmReadinessRequirements,
  researchControlRatePolicy,
  type ResearchLlmReadinessRequirements,
  researchReadinessInvalidRequest
} from "./runtime/research.js";
import {
  createDefaultImageGenerationProvider,
  resolveImageGenerationBillingFallbacks
} from "./runtime/image-providers.js";
import {
  backfillClientDiagnosticsForMessage,
  clientDiagnosticEventsMatch,
  clientEventsRateLimitKey,
  linkClientDiagnosticEvent,
  logClientEventRateLimitRejection,
  relinkExistingClientDiagnosticEvent,
  resolveBillingAdminRatePolicy,
  resolveClientEventsRatePolicy
} from "./services/client-event-ingest.js";
import {
  applyClientTurnHeaders,
  chatRuntimeAttemptContext,
  createProviderErrorLogger,
  markOpenAITokenUsage,
  markProviderStreamSummary
} from "./http/provider-telemetry.js";
import {
  chatCompletionErrorFromUnknown,
  chatCompletionExecutionFailure,
  credentialPublicModelAccessError,
  gatewayErrorResponseContext,
  isChatCompletionExecutionFailure,
  sendError,
  sendGatewayErrorResponse,
  sendImageError,
  sendOpenAIError,
  writeOpenAIStreamError,
  writeResponsesFailure
} from "./http/gateway-errors.js";
import {
  applyChatRuntimeContext,
  applyUpstreamSelection,
  chatCompletionEstimateExtras,
  chatRuntimeAffinityKey,
  createChatCompletionShape,
  createStatelessSession,
  estimatedTokensPerVisionImage,
  hasNativeClientTools,
  publicSessionStreamEvent,
  requestAffinityKey,
  serializeToolChoice
} from "./services/chat-request-shaping.js";
import {
  authenticateClientSubscriptionPauseBearer,
  authenticateUnifiedClientKeyBearer,
  clientSubscriptionPauseError,
  clientSubscriptionPauseResponse,
  invalidUnifiedKeyError,
  parseClientSubscriptionPauseRequest,
  recordUnifiedKeyResolveAudit
} from "./services/client-key-auth.js";
import {
  applyImageAttemptAttribution,
  createImageRequestAbort,
  generateImageWithAccountPool,
  generateImageWithBillingFallbacks,
  imageErrorFromUnknown,
  isImageFallbackRetryableError,
  runImageGenerationWithAbort
} from "./services/image-execution.js";
import { resolveChatCompletionReasoningEffort } from "./services/reasoning-policy.js";
import { runStrictClientTools } from "./services/strict-client-tools.js";
import { openAIToolCallToStreamEvent, providerToolCallToOpenAI } from "./services/client-tool-output.js";
import { runNativeWithFailover } from "./services/native-client-tools.js";

export type { GatewayAuthMode, GatewayOptions, GatewayPublicMetadata, ImageGenerationBillingFallbackInput } from "./gateway-options.js";

export { validateRuntimeEnvironment } from "./runtime/auth-config.js";

interface MessageBody {
  message?: unknown;
}

interface ChatCompletionExecutionOptions {
  captureErrors?: boolean;
  clientSessionId?: string | null;
  signal?: AbortSignal;
}

export function buildGateway(options: GatewayOptions = {}) {
  const boundedWritePolicy = options.boundedWritePolicy ?? boundedWritePolicyFromEnv(process.env);
  const writeDeliveryAdmission = new WriteDeliveryAdmission(boundedWritePolicy.maxConcurrent ?? 4);
  const app = Fastify({
    logger: options.logger ?? true,
    genReqId: () => `req-${randomUUID()}`,
    trustProxy: ["loopback", "linklocal", "uniquelocal"],
    routerOptions: {
      maxParamLength: visionAssetMaximumIdCharacters
    }
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
  const goldencodeNativeFailover = nativeFailoverEnabled(process.env.GATEWAY_GOLDENCODE_NATIVE_FAILOVER_MODE);
  const failoverSubjectIds = process.env.GATEWAY_GOLDENCODE_FAILOVER_SUBJECT_IDS?.trim();
  const goldencodeFailoverSubjects = new Set(failoverSubjectIds ? failoverSubjectIds.split(",").map((id) => id.trim()) : []);
  if (goldencodeFailoverSubjects.has("")) {
    throw new Error("GATEWAY_GOLDENCODE_FAILOVER_SUBJECT_IDS must not contain empty entries.");
  }
  const nativeToolForceRequiredMode = parseNativeToolForceRequiredMode(
    process.env.MEDCODE_NATIVE_TOOL_FORCE_REQUIRED_MODE,
    (message) => app.log.warn(message)
  );
  const nativeFileToolRecoveryPolicy = parseNativeFileToolRecoveryPolicy(
    process.env,
    (message) => app.log.warn(message)
  );
  const toolLoopShadowPolicy = parseToolLoopShadowPolicy(process.env, (message) =>
    app.log.warn(message)
  );
  const localContextAdmissionMode =
    options.localContextAdmissionMode ??
    parseLocalContextAdmissionMode(process.env.MEDCODE_LOCAL_CONTEXT_ADMISSION_MODE);
  const visionRequestBodyLimitBytes = parsePositiveIntegerEnv(
    process.env.MEDCODE_VISION_REQUEST_BODY_LIMIT_BYTES,
    visionDefaultRequestBodyBytes,
    "MEDCODE_VISION_REQUEST_BODY_LIMIT_BYTES"
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
  const tiankuanAdapters = createTiankuanAdapters(publicModelRegistry.models, process.env, app.log);
  const tokenSwitchAdapters = createTokenSwitchAdapters(
    publicModelRegistry.models,
    process.env,
    app.log
  );
  const localOpenAIAdapters = createLocalOpenAIAdapters(
    publicModelRegistry.models,
    process.env,
    app.log
  );
  const xaiVisionAdapters = createXaiVisionAdapters(
    publicModelRegistry.models,
    process.env,
    app.log
  );
  const publicModelPoolRouters = createPublicModelPoolRouters(
    publicModelRegistry.models,
    {
      openrouter: openRouterAdapters,
      qianfan: qianfanAdapters,
      aliyun: aliyunAdapters,
      tencent: tencentAdapters,
      tiankuan: tiankuanAdapters,
      tokenswitch: tokenSwitchAdapters
    },
    clock,
    app.log
  );
  const chatRuntimeDispatcher = createChatRuntimeDispatcher({
    codexRouter: upstreamRouter,
    openRouterAdapterForModel: (model) => openRouterAdapters.get(model.id) ?? null,
    qianfanAdapterForModel: (model) => qianfanAdapters.get(model.id) ?? null,
    aliyunAdapterForModel: (model) => aliyunAdapters.get(model.id) ?? null,
    tencentAdapterForModel: (model) => tencentAdapters.get(model.id) ?? null,
    tiankuanAdapterForModel: (model) => tiankuanAdapters.get(model.id) ?? null,
    tokenSwitchAdapterForModel: (model) => tokenSwitchAdapters.get(model.id) ?? null,
    localOpenAIAdapterForModel: (model) => localOpenAIAdapters.get(model.id) ?? null,
    xaiVisionAdapterForModel: (model) => xaiVisionAdapters.get(model.id) ?? null,
    poolRouterForModel: (model) => publicModelPoolRouters.get(model.id) ?? null
  });
  const openRouterAvailable = openRouterAdapters.size > 0;
  const qianfanAvailable = qianfanAdapters.size > 0;
  const aliyunAvailable = aliyunAdapters.size > 0;
  const tencentAvailable = tencentAdapters.size > 0;
  const tiankuanAvailable = tiankuanAdapters.size > 0;
  const tokenSwitchAvailable = tokenSwitchAdapters.size > 0;
  const localOpenAIAvailable = localOpenAIAdapters.size > 0;
  const publicModelAvailability = {
    openRouterAvailable,
    qianfanAvailable,
    aliyunAvailable,
    tencentAvailable,
    tiankuanAvailable,
    tokenSwitchAvailable,
    localOpenAIAvailable,
    poolMemberAdapterKeys: poolMemberAdapterKeys({
      openrouter: openRouterAdapters,
      qianfan: qianfanAdapters,
      aliyun: aliyunAdapters,
      tencent: tencentAdapters,
      tiankuan: tiankuanAdapters,
      tokenswitch: tokenSwitchAdapters
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
  const desktopVersionGate =
    options.desktopVersionGate ?? resolveDesktopVersionGate(process.env);
  const medevidenceOriginPolicy =
    options.medevidenceOriginPolicy ??
    resolveMedevidenceOriginPolicy(process.env);
  const configuredPhoneAuthMode = resolvePhoneAuthMode(
    process.env.GATEWAY_PHONE_AUTH_MODE
  );
  assertPhoneAuthVersionGateCompatibility(
    configuredPhoneAuthMode,
    desktopVersionGate.mode
  );
  const phoneAuthStore =
    options.phoneAuthStore ?? (isPhoneAuthStore(sessions) ? sessions : undefined);
  if (
    configuredPhoneAuthMode === "transition" &&
    (!phoneAuthStore ||
      !credentialStore ||
      !unifiedClientKeyStore ||
      !planEntitlementStore)
  ) {
    throw new Error(
      "Phone auth transition mode requires SQLite phone auth, credential, unified-key and entitlement stores."
    );
  }
  const phoneAuthService =
    options.phoneAuthService === undefined
      ? phoneAuthStore &&
        credentialStore &&
        unifiedClientKeyStore &&
        planEntitlementStore
        ? new PhoneAuthService(
            resolvePhoneAuthServiceOptions(process.env, {
              store: phoneAuthStore,
              credentialStore,
              unifiedKeyStore: unifiedClientKeyStore,
              entitlementStore: planEntitlementStore,
              now: clock
            })
          )
        : null
      : options.phoneAuthService;
  if (
    configuredPhoneAuthMode === "transition" &&
    phoneAuthService?.mode !== "transition"
  ) {
    throw new Error(
      "Phone auth transition mode requires an enabled PhoneAuthService."
    );
  }
  if (phoneAuthService?.mode === "transition") {
    assertPhoneAuthVersionGateCompatibility(
      phoneAuthService.mode,
      desktopVersionGate.mode
    );
    if (publicGatewayBaseUrl !== phoneAuthService.publicGatewayBaseUrl) {
      throw new Error(
        `Phone auth transition mode requires GATEWAY_PUBLIC_BASE_URL=${phoneAuthService.publicGatewayBaseUrl}.`
      );
    }
  }
  const phoneAuthLoginRateLimiter =
    options.phoneAuthLoginRateLimiter ??
    new InMemoryCredentialRateLimiter({ now: clock });
  const phoneAuthPhoneRequestsPerMinute =
    options.phoneAuthPhoneRequestsPerMinute ??
    parsePositiveIntegerEnv(
      process.env.GATEWAY_PHONE_AUTH_LOGIN_PHONE_RPM,
      5,
      "GATEWAY_PHONE_AUTH_LOGIN_PHONE_RPM"
    );
  const phoneAuthIpRequestsPerMinute =
    options.phoneAuthIpRequestsPerMinute ??
    parsePositiveIntegerEnv(
      process.env.GATEWAY_PHONE_AUTH_LOGIN_IP_RPM,
      20,
      "GATEWAY_PHONE_AUTH_LOGIN_IP_RPM"
    );
  const phoneAuthDeviceRequestsPerMinute =
    options.phoneAuthDeviceRequestsPerMinute ??
    parsePositiveIntegerEnv(
      process.env.GATEWAY_PHONE_AUTH_LOGIN_DEVICE_RPM,
      10,
      "GATEWAY_PHONE_AUTH_LOGIN_DEVICE_RPM"
    );
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
  const researchOfficialSourceMode =
    options.researchOfficialSourceMode ??
    defaultResearchRuntime?.officialSourceMode ??
    "brave";
  const researchOfficialWebAllowedDomains =
    options.researchOfficialWebAllowedDomains ??
    defaultResearchRuntime?.officialWebAllowedDomains ??
    [];
  const researchOfficialIdentityRegistry =
    options.researchOfficialIdentityRegistry ??
    defaultResearchRuntime?.officialIdentityRegistry ??
    [];
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
  const visionAssetService =
    options.visionAssetService === undefined
      ? resolveVisionAssetService(process.env, { now: clock })
      : options.visionAssetService;
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
  const externalIdentityProvider = options.externalIdentityProvider ?? process.env.GATEWAY_BILLING_IDENTITY_PROVIDER?.trim() ?? null;
  if (externalIdentityProvider && !/^[A-Za-z0-9._:-]{1,100}$/.test(externalIdentityProvider)) {
    throw new Error("Invalid GATEWAY_BILLING_IDENTITY_PROVIDER.");
  }
  const externalIdentityStore = options.externalIdentityStore ?? (isExternalIdentityStore(sessions) ? sessions : undefined);
  const unifiedKeyRecoverySecret = options.unifiedKeyRecoverySecret === undefined
    ? resolveProviderApiKey(process.env, "GATEWAY_UNIFIED_KEY_RECOVERY_KEY").apiKey
    : options.unifiedKeyRecoverySecret;
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
      allowedPublicModels: null,
      credentialClass: "operator" as const
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
    request.gatewayClientDisconnect = observeClientDisconnect(request, reply, () => {
      markClientAborted(request);
      releaseRateLimit(request);
      recordObservation(request, observationStore, 499);
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

  app.addHook("onRequest", async (request, reply) => {
    if (
      reply.sent ||
      !shouldGateDesktopRoute(
        desktopVersionGate.mode,
        request.method,
        request.url
      )
    ) {
      return;
    }
    const alwaysDesktop = isPhoneSessionRoute(
      request.method,
      request.url
    );
    if (!alwaysDesktop && !request.gatewayContext) {
      return;
    }
    const credentialClass = alwaysDesktop
      ? undefined
      : request.gatewayContext?.credential.credentialClass;
    const needsIdentityFallback = needsMedevidenceIdentityFallback(
      request,
      credentialClass
    );
    const error = desktopVersionGateError(
      request,
      desktopVersionGate,
      credentialClass,
      Boolean(
        needsIdentityFallback &&
          request.gatewayContext &&
          phoneAuthStore?.getPhoneAuthIdentityBySubjectId(
            request.gatewayContext.subject.id
          )
      )
    );
    if (error) {
      return sendDesktopVersionGateError(
        request,
        reply,
        desktopVersionGate,
        error
      );
    }
  });

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
    request.gatewayClientDisconnect?.cleanup();
  });

  registerPhoneAuthRoutes(app, {
    service: phoneAuthService,
    versionGate: desktopVersionGate,
    loginRateLimiter: phoneAuthLoginRateLimiter,
    phoneRequestsPerMinute: phoneAuthPhoneRequestsPerMinute,
    ipRequestsPerMinute: phoneAuthIpRequestsPerMinute,
    deviceRequestsPerMinute: phoneAuthDeviceRequestsPerMinute
  });

  registerVisionAssetRoutes(app, {
    maximumRequestBodyBytes: visionRequestBodyLimitBytes,
    service: visionAssetService,
    authorize: (request) => {
      const context = getGatewayContext(request);
      const allowedVisionModel = publicModelRegistry.models.some(
        (model) =>
          model.vision?.enabled === true &&
          xaiVisionAdapters.has(model.id) &&
          credentialAllowsPublicModel(
            context.credential.allowedPublicModels,
            model.id,
            publicModelAliasGroups
          )
      );
      if (!allowedVisionModel) {
        return new GatewayError({
          code: "model_not_allowed_for_credential",
          message: "Credential is not allowed to use a vision-capable model.",
          httpStatus: 403
        });
      }
      const access = resolveEntitlementAccessForChat({
        context,
        entitlementStore: planEntitlementStore,
        requireEntitlement,
        now: clock()
      });
      if (access instanceof GatewayError) {
        return access;
      }
      if (
        access.decision?.status === "active" &&
        !access.decision.entitlement.featurePolicySnapshot.capabilities.includes(
          "chat"
        )
      ) {
        return new GatewayError({
          code: "plan_capability_required",
          message: "The active plan does not allow chat or vision requests.",
          httpStatus: 403
        });
      }
      return null;
    }
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
        if (
          requirements.maximumPromptTokensPerCall +
            requirements.maximumOutputTokensPerCall >
          publicModel.contextWindow
        ) {
          return sendOpenAIError(
            request,
            reply,
            new GatewayError({
              code: "context_length_exceeded",
              message:
                "Research LLM readiness requirements exceed the model context window.",
              httpStatus: 400
            })
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
          serviceRate.concurrentRequests <
            requirements.concurrentCalls ||
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
      officialSourceMode: researchOfficialSourceMode,
      officialWebAllowedDomains: researchOfficialWebAllowedDomains,
      officialIdentityRegistry: researchOfficialIdentityRegistry,
      identityAgentEnabled: options.researchIdentityAgentEnabled ?? defaultResearchRuntime?.identityAgentEnabled ?? false,
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
    async (_request, reply) => {
      const localHealth = await localOpenAIInferenceHealth(
        publicModelRegistry.models,
        localOpenAIAdapters,
        upstreamAccount
      );
      const localInferenceRequired = localOpenAIInferenceRequiredForReadiness(
        publicModelRegistry.models
      );
      if (
        localInferenceRequired &&
        localHealth &&
        localHealth.state !== "healthy"
      ) {
        reply.code(503);
      }
      return {
        state:
          localInferenceRequired &&
          localHealth &&
          localHealth.state !== "healthy"
            ? "not_ready"
            : "ready",
        service: publicMetadata.serviceName,
        auth_mode: authMode,
        phone_auth: {
          mode: phoneAuthService?.mode ?? configuredPhoneAuthMode,
          version_gate_mode: desktopVersionGate.mode,
          minimum_desktop_version: desktopVersionGate.minimumVersion
        },
        medevidence_routing: {
          mode: medevidenceOriginPolicy.mode,
          r760_minimum_desktop_version:
            medevidenceOriginPolicy.r760MinimumDesktopVersion
        },
        provider: publicMetadata.providerName,
        store: {
          session: storeKind(sessions),
          observation: observationStore ? "enabled" : "disabled"
        },
        ...(localHealth
          ? {
              inference: {
                runtime: "local_openai",
                state: localHealth.state
              }
            }
          : {}),
        phase: publicMetadata.phase
      };
    }
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
        prefix: formatAccessCredentialPublicPrefix(credential.prefix),
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
    async (request, reply) => {
      applyPrivateResponseHeaders(reply);
      const { subject, scope, credential } = getGatewayContext(request);
      const usageNow = clock();
      const access = planEntitlementStore?.entitlementAccessForSubject(subject.id, usageNow);
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
                policy: tokenPolicy,
                now: usageNow
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
          prefix: formatAccessCredentialPublicPrefix(credential.prefix),
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
      },
      errorHandler: phoneAuthContractErrorHandler
    },
    async (request, reply) => {
      applyPrivateResponseHeaders(reply);
      if (!unifiedClientKeyStore || !credentialStore) {
        return sendPhoneAuthError(
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
        return sendPhoneAuthError(request, reply, result);
      }

      const backingCredential = credentialStore.getAccessCredentialByPrefix(
        result.record.codexCredentialPrefix
      );
      if (
        !backingCredential ||
        backingCredential.id !== result.record.codexCredentialId ||
        backingCredential.subjectId !== result.record.subjectId
      ) {
        return sendPhoneAuthError(request, reply, invalidUnifiedKeyError());
      }
      const now = clock();
      const backingCredentialStateError = checkAccessCredentialState(
        backingCredential,
        now
      );
      if (backingCredentialStateError) {
        return sendPhoneAuthError(
          request,
          reply,
          backingCredentialStateError
        );
      }
      const credentialClass =
        backingCredential.credentialClass === result.record.credentialClass
          ? result.record.credentialClass ?? "unknown"
          : "unknown";
      const needsIdentityFallback = needsMedevidenceIdentityFallback(
        request,
        credentialClass
      );
      const gateError = desktopVersionGateError(
        request,
        desktopVersionGate,
        credentialClass,
        Boolean(
          needsIdentityFallback &&
            phoneAuthStore?.getPhoneAuthIdentityBySubjectId(
            result.record.subjectId
          )
        )
      );
      if (gateError) {
        return sendDesktopVersionGateError(
          request,
          reply,
          desktopVersionGate,
          gateError
        );
      }
      if (
        request.body !== undefined &&
        (!request.body ||
          typeof request.body !== "object" ||
          Array.isArray(request.body) ||
          Object.keys(request.body).length !== 0)
      ) {
        return sendPhoneAuthError(
          request,
          reply,
          new GatewayError({
            code: "invalid_request",
            message: "Request does not match contract version 1.",
            httpStatus: 400
          })
        );
      }

      const medevidenceBaseUrl = normalizeBaseUrl(
        metadataString(result.record.metadata, "medevidence_base_url")
      );
      const routeMissingMedevidenceMetadata = Boolean(
        result.record.medevidenceKeyPrefix && medevidenceBaseUrl === null
      );
      if (
        credentialClass === "desktop" &&
        !isApprovedMedevidenceOrigin(medevidenceBaseUrl) &&
        !routeMissingMedevidenceMetadata
      ) {
        return sendPhoneAuthError(
          request,
          reply,
          new GatewayError({
            code: "account_migration_required",
            message: "The internal account runtime key is not recoverable.",
            httpStatus: 409
          })
        );
      }

      const encryptionSecret = process.env.GATEWAY_API_KEY_ENCRYPTION_SECRET;
      if (!encryptionSecret) {
        return sendPhoneAuthError(
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
        return sendPhoneAuthError(
          request,
          reply,
          new GatewayError({
            code: "service_unavailable",
            message: "Unified key resolver payload is unavailable.",
            httpStatus: 503
          })
        );
      }
      const backingCredentialError = verifyAccessCredentialToken(
        codexApiKey,
        backingCredential,
        now
      );
      if (backingCredentialError) {
        return sendPhoneAuthError(request, reply, backingCredentialError);
      }

      recordUnifiedKeyResolveAudit(adminAuditStore, result.record, request.log);

      const receivedClientVersion = request.headers[desktopVersionHeader];
      const clientVersion =
        typeof receivedClientVersion === "string"
          ? receivedClientVersion
          : null;
      const selectedMedevidenceBaseUrl = selectMedevidenceOrigin(
        medevidenceBaseUrl,
        clientVersion,
        medevidenceOriginPolicy,
        routeMissingMedevidenceMetadata
      );

      return {
        valid: true,
        unified_key: {
          prefix: `${unifiedClientKeyTokenPrefix}${result.record.prefix}`,
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
          key_prefix: formatAccessCredentialPublicPrefix(result.record.codexCredentialPrefix),
          api_key: codexApiKey
        },
        medevidence: {
          base_url: selectedMedevidenceBaseUrl,
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
          observationStore,
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
    subjectMetadataStore: isSubjectMetadataStore(sessions) ? sessions : undefined,
    publicBaseUrl: publicGatewayBaseUrl,
    desktopClientVersion: desktopVersionGate.minimumVersion,
    phoneAuthService,
    externalIdentityProvider,
    externalIdentityStore,
    unifiedKeyRecoverySecret,
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
      request.gatewayPublicModelId = parsed.model;

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

      const abort = createImageRequestAbort(
        request.gatewayClientDisconnect?.signal,
        imageRequestTimeoutMs
      );
      try {
        applyImageAttemptAttribution(request, {
          provider: imageGenerationProvider,
          upstreamModel,
          upstreamAccountId: null
        });
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
        if (isImageFallbackRetryableError(error) && imageGenerationBillingFallbacks.length > 0) {
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
    const reservedReceiverError = reservedWriteDeliveryRequestError(parsed);
    if (reservedReceiverError) return fail(reservedReceiverError);
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
    request.gatewayPublicModelId = publicModel.id;
    const modality = parsed.images?.length ? "vision" : "text";
    const visionRecovery = modality === "vision" && request.headers[visionRecoveryRequestHeader] === "1"
      ? new VisionRequestRecovery(parsed.images!.length) : undefined;
    request.gatewayVisionRecovery = visionRecovery;
    request.gatewayRequestedReasoningEffort = parsed.reasoningEffort ?? null;
    request.gatewayEffectiveReasoningEffort = null;
    request.gatewayReasoningEffortSource =
      parsed.reasoningEffort === undefined ? "default" : "request";
    request.gatewayReasoningEffortNormalized = false;
    request.gatewayReasoningEffortNormalizationReason = null;
    const reasoningEffort = resolveChatCompletionReasoningEffort(
      publicModel,
      parsed.reasoningEffort,
      parsed.model,
      modality
    );
    if (reasoningEffort instanceof GatewayError) {
      request.gatewayObservedUpstreamAccount = { id: null, provider: null };
      return fail(reasoningEffort);
    }
    request.gatewayEffectiveReasoningEffort = reasoningEffort.effective;
    request.gatewayReasoningEffortSource = reasoningEffort.source;
    request.gatewayReasoningEffortNormalized = reasoningEffort.normalized;
    request.gatewayReasoningEffortNormalizationReason =
      reasoningEffort.normalizationReason;
    if (reasoningEffort.normalized) {
      request.log.warn(
        {
          request_id: request.id,
          public_model_id: publicModel.id,
          requested_reasoning_effort: reasoningEffort.requested,
          effective_reasoning_effort: reasoningEffort.effective,
          normalization_reason: reasoningEffort.normalizationReason
        },
        "Legacy reasoning effort normalized before provider dispatch."
      );
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

    const requestedChatRequestTimeoutMs =
      parseRequestedChatRequestTimeoutMs(
        request.headers["x-medcode-request-timeout-ms"]
      );
    if (requestedChatRequestTimeoutMs instanceof GatewayError) {
      request.gatewayObservedUpstreamAccount = { id: null, provider: null };
      return fail(requestedChatRequestTimeoutMs);
    }

    const affinityKey = chatRuntimeAffinityKey(request, publicModel, upstreamRouter.softAffinity);
    const attemptedAccountIds = new Set<string>();
    let statelessAttempts = 1;
    const gatewayContext = getGatewayContext(request);
    const { subject, scope } = gatewayContext;
    const boundedWriteForRequest = publicModel.id === "goldencode" && modality === "text" &&
      boundedWriteEnabled(boundedWritePolicy, subject.id);
    const goldencodeRequestFailover = publicModel.id === "goldencode" &&
      publicModel.runtime === "pool" && modality === "text" &&
      publicModel.pool!.members.every((member) => member.runtime === "tencent" || member.runtime === "tiankuan") &&
      goldencodeNativeFailover && (!goldencodeFailoverSubjects.size || goldencodeFailoverSubjects.has(subject.id));
    request.gatewayProviderFailoverEnabled = goldencodeRequestFailover || !!visionRecovery;
    let attempt = chatRuntimeDispatcher.begin({
      model: publicModel,
      modality,
      reasoningEffort: reasoningEffort.effective,
      reasoningEffortSource: reasoningEffort.source,
      subject,
      scope,
      affinityKey,
      quotaRequest: publicModel.id === "goldencode" && modality === "text" ? {
        promptTokens: estimatePromptTokens(chatMessagesToPrompt(parsed, { includeToolsContext: false }),
          chatCompletionEstimateExtras(parsed, false, "tencent")),
        maximumOutputTokens: parsed.maximumOutputTokens ?? publicModel.maxOutputTokens
      } : undefined,
      createSession: createStatelessSession
    });
    if (attempt instanceof GatewayError) {
      return fail(attempt);
    }
    applyChatRuntimeContext(request, attempt);
    const shape = createChatCompletionShape(parsed.model);
    const nativeClientTools = hasNativeClientTools(parsed, attempt.runtime);
    const nativeFailover = nativeClientTools && goldencodeRequestFailover;
    const strictClientTools = hasStrictClientTools(parsed) && !nativeClientTools;
    request.gatewayToolChoice = serializeToolChoice(
      nativeClientTools
        ? initialNativeToolChoice(parsed, attempt.upstreamModel, nativeToolForceRequiredMode)
        : parsed.toolChoice
    );
    request.gatewayModelContextTokens = attempt.limits.contextWindow;
    request.gatewayModelMaxOutputTokens = attempt.limits.maxOutputTokens;
    const maximumOutputTokens =
      parsed.maximumOutputTokens ?? attempt.limits.maxOutputTokens;
    if (maximumOutputTokens > attempt.limits.maxOutputTokens) {
      attempt.release();
      return fail(
        new GatewayError({
          code: "invalid_request",
          message: `Requested output tokens exceed the ${attempt.limits.maxOutputTokens} token model limit.`,
          httpStatus: 400
        })
      );
    }
    request.gatewayMaximumOutputTokens = maximumOutputTokens;
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
    request.gatewayPromptChars = prompt.length;
    request.gatewayEstimatedTokens = estimatePromptTokens(
      prompt,
      chatCompletionEstimateExtras(parsed, strictClientTools, attempt.runtime)
    ) + (parsed.images?.length ?? 0) * estimatedTokensPerVisionImage;
    request.gatewayEstimatedPromptTokens = request.gatewayEstimatedTokens;
    request.gatewayPromptEstimateMethod = PROMPT_TOKEN_ESTIMATE_METHOD;
    if (
      attempt.runtime === "local_openai" &&
      localContextAdmissionMode !== "disabled"
    ) {
      if (!attempt.adapter.countPromptTokens) {
        request.log.warn(
          {
            request_id: request.id,
            public_model_id: publicModel.id,
            local_context_admission_mode: localContextAdmissionMode
          },
          "Local context admission tokenizer is unavailable; request will continue."
        );
      } else {
        try {
          const tokenCount = await attempt.adapter.countPromptTokens({
            upstreamAccount: attempt.adapterInputUpstreamAccount,
            subject: attempt.subject,
            scope: attempt.scope,
            session: attempt.session,
            message: prompt,
            chatMessages: parsed.messages,
            images: parsed.images,
            reasoningEffort: attempt.reasoningEffort,
            maximumOutputTokens,
            clientTools: nativeClientTools ? parsed.tools : undefined,
            clientToolChoice: nativeClientTools ? parsed.toolChoice : undefined,
            signal: executionOptions.signal
          });
          request.gatewayEstimatedPromptTokens = tokenCount.promptTokens;
          request.gatewayPromptEstimateMethod = tokenCount.source;
          const contextWindowDetails = providerTokenizedContextWindowDetails({
            configuredContextLimitTokens: attempt.limits.contextWindow,
            requestedOutputTokens: maximumOutputTokens,
            tokenCount
          });
          const fields = {
            request_id: request.id,
            public_model_id: publicModel.id,
            local_context_admission_mode: localContextAdmissionMode,
            configured_context_limit_tokens: attempt.limits.contextWindow,
            provider_context_limit_tokens: tokenCount.maxContextTokens,
            effective_context_limit_tokens: Math.min(
              attempt.limits.contextWindow,
              tokenCount.maxContextTokens
            ),
            prompt_tokens: tokenCount.promptTokens,
            requested_output_tokens: maximumOutputTokens,
            total_tokens: tokenCount.promptTokens + maximumOutputTokens,
            overflow_tokens: contextWindowDetails?.overflowTokens ?? 0,
            would_reject: contextWindowDetails !== null
          };
          if (contextWindowDetails) {
            request.log.warn(
              fields,
              localContextAdmissionMode === "enforce"
                ? "Local context admission rejected an oversized request."
                : "Local context admission shadow check would reject the request."
            );
            if (localContextAdmissionMode === "enforce") {
              attempt.release();
              return fail(contextCompactionRequiredError(contextWindowDetails));
            }
          } else {
            request.log.info(fields, "Local context admission check passed.");
          }
        } catch (error) {
          request.log.warn(
            {
              request_id: request.id,
              public_model_id: publicModel.id,
              local_context_admission_mode: localContextAdmissionMode,
              error: error instanceof Error ? error.message : String(error)
            },
            "Local context admission tokenizer failed; request will continue."
          );
        }
      }
    }
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
      attempt.runtime,
      requestedChatRequestTimeoutMs
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
      const offeredDelivery = nativeClientTools && boundedWriteForRequest && !executionOptions.captureErrors
        ? negotiateWriteDelivery({ headers: request.headers, request: parsed, requestId: request.id,
            subjectId: subject.id, policy: boundedWritePolicy }) : undefined;
      const releaseDelivery = offeredDelivery ? writeDeliveryAdmission.acquire() : undefined;
      const acceptedDelivery = releaseDelivery ? offeredDelivery : undefined;
      const sse = setupSseResponse(reply, { deferHeartbeat: !!acceptedDelivery });
      const deadline = createChatRequestDeadline({
        timeoutMs: chatRequestTimeoutMs || (visionRecovery ? 600_000 : 0),
        parentSignals: [executionOptions.signal, sse.signal],
        now: clock()
      });
      const activeRequest = beginActiveRequest(attempt, deadline.deadlineAt);
      markProviderCallStarted(request, clock());
      const onProviderEvent = (event: StreamEvent) =>
        markProviderEvent(request, event, clock());
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
            nativeFileToolRecoveryPolicy,
            signal: deadline.signal,
            requestId: request.id,
            log: request.log,
            onProviderError,
            onProviderEvent
          });
          if (strictResult instanceof GatewayError) {
            attempt.recordError(strictResult);
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
          const nativeResult = await runNativeWithFailover({
            failover: nativeFailover,
            visionRecovery,
            runtime: attempt,
            deadlineAt: deadline.deadlineAt,
            now: clock,
            outputCommitted: () => initialChunkSent || sse.isClosed(),
            selected: (next) => {
              attempt = next;
              applyChatRuntimeContext(request, next);
              activeRequest.update({ upstreamRuntime: next.runtime, upstreamAccountId: next.adapterInputUpstreamAccount.id });
            },
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
            nativeFileToolRecoveryPolicy,
            boundedWriteEnabled: boundedWriteForRequest,
            writeDelivery: acceptedDelivery ? { negotiation: acceptedDelivery, shape } : undefined,
            signal: deadline.signal,
            requestId: request.id,
            log: request.log,
            onProviderError,
            onProviderEvent
          });
          if (nativeResult instanceof GatewayError) {
            if (!nativeFailover) attempt.recordError(nativeResult);
            markProviderStreamSummary(request, providerStreamSummaryFromError(nativeResult));
            request.gatewayErrorCode = nativeResult.code;
            writeOpenAIStreamError(request, reply, sse, nativeResult);
            failed = true;
          } else if (nativeResult.writeDelivery) {
            const delivery = nativeResult.writeDelivery;
            usage = nativeResult.usage;
            markProviderStreamSummary(request, nativeResult.providerSummary);
            markOpenAITokenUsage(request, usage);
            if (deadline.signal.aborted || (deadline.deadlineAt && clock() >= deadline.deadlineAt)) {
              const error = deadline.signal.reason instanceof GatewayError ? deadline.signal.reason : new GatewayError({
                code: "upstream_timeout", httpStatus: 504, message: "Request deadline reached before write delivery." });
              request.gatewayErrorCode = error.code;
              writeOpenAIStreamError(request, reply, sse, error);
              return;
            }
            // The optional S path has emitted no data or heartbeat. Bind headers
            // to this exact response, never to provider headers or model values.
            for (const [name, value] of Object.entries(delivery.headers)) reply.raw.setHeader(name, value);
            markFirstByte(request);
            activeRequest.markFirstByte();
            for (const frame of delivery.frames) {
              if (!await sse.writeDataAsync(frame, deadline.signal)) {
                request.gatewayErrorCode = deadline.signal.reason instanceof GatewayError
                  ? deadline.signal.reason.code : "client_aborted";
                return;
              }
            }
            if (deadline.signal.aborted || !sse.writeDone()) {
              request.gatewayErrorCode = deadline.signal.reason instanceof GatewayError
                ? deadline.signal.reason.code : "client_aborted";
              return;
            }
            if (!nativeFailover) attempt.recordSuccess();
            request.log.info({ request_id: request.id, delivery_id: delivery.deliveryId,
              lossless_delivery_delivered: true, payload_utf8_bytes: delivery.payloadBytes,
              arguments_utf8_bytes: delivery.argumentsBytes, response_body_bytes: delivery.responseBytes,
              transport_chunk_count: delivery.chunkCount }, "Complete write handed to the response stream; client commit remains unconfirmed.");
            return;
          } else if (nativeResult.toolCalls.length > 0) {
            writeInitialChunk();
            activeRequest.markFirstByte();
            if (!nativeFailover && !sse.isClosed()) {
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
            if (!nativeFailover && !sse.isClosed()) {
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
            const endError = visionRecovery?.endError({ signal: deadline.signal, deadlineAt: deadline.deadlineAt, now: clock });
            if (endError) {
              markProviderStreamSummary(request, combineProviderStreamSummaries(providerSummaries));
              writeOpenAIStreamError(request, reply, sse, endError);
              failed = true;
              break;
            }
            const onProviderError = createProviderErrorLogger(request);
            const providerSummary = new ProviderStreamSummaryCollector({
              softToolArgumentBytes: nativeFileToolRecoveryPolicy.softArgumentBytes,
              hardToolArgumentBytes: nativeFileToolRecoveryPolicy.hardArgumentBytes,
              outputTruncationMode: nativeFileToolRecoveryPolicy.mode
            });
            const attemptKind = statelessAttempts > 1 ? "stateless_retry" : "primary";
            const bufferedToolCalls: Array<
              Extract<StreamEvent, { type: "tool_call" }>
            > = [];
            let attemptHasToolCalls = false;
            let retrying = false;
            visionRecovery?.budget.consume();
            for await (const event of attempt.adapter.message({
              upstreamAccount: attempt.adapterInputUpstreamAccount,
              subject: attempt.subject,
              scope: attempt.scope,
              session: attempt.session,
              message: prompt,
              ...(attempt.runtime === "local_openai"
                ? { chatMessages: parsed.messages }
                : {}),
              images: parsed.images,
              reasoningEffort: attempt.reasoningEffort,
              maximumOutputTokens,
              clientTools: nativeClientTools ? parsed.tools : undefined,
              clientToolChoice: nativeClientTools ? parsed.toolChoice : undefined,
              signal: deadline.signal,
              onProviderError
            })) {
              onProviderEvent(event);
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
                let error = streamErrorToGatewayError(event);
                const errorSummary = providerSummary.snapshot(
                  chatRuntimeAttemptContext(attempt, attemptKind, parsed.toolChoice)
                );
                providerSummaries.push(errorSummary);
                attempt.recordError(error);
                if (visionRecovery && await visionRecovery.prepareRetry({ error, summary: errorSummary,
                  signal: deadline.signal, deadlineAt: deadline.deadlineAt, now: clock, outputCommitted: initialChunkSent })) {
                  statelessAttempts += 1;
                  retrying = true;
                  break;
                }
                error = visionRecovery?.endError({ signal: deadline.signal, deadlineAt: deadline.deadlineAt, now: clock }) ?? error;
                if (
                  !visionRecovery &&
                  !initialChunkSent &&
                  !deadline.signal.aborted &&
                  (!deadline.deadlineAt || deadline.deadlineAt.getTime() - clock().getTime() >= 1000) &&
                  statelessAttempts < maxStatelessAttempts &&
                  (goldencodeRequestFailover ? canFailoverNativeError(error, errorSummary) : isStatelessRetryableProviderError(error)) &&
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
              let completionError = providerCompletionError(successSummary, {
                outputTruncationMode: nativeFileToolRecoveryPolicy.mode,
                outputKind: "auto"
              });
              if (completionError) {
                const errorSummary =
                  providerStreamSummaryFromError(completionError) ?? successSummary;
                providerSummaries.push(errorSummary);
                attempt.recordError(completionError);
                if (visionRecovery && await visionRecovery.prepareRetry({ error: completionError, summary: errorSummary,
                  signal: deadline.signal, deadlineAt: deadline.deadlineAt, now: clock, outputCommitted: initialChunkSent })) {
                  statelessAttempts += 1;
                  continue;
                }
                completionError = visionRecovery?.endError({ signal: deadline.signal, deadlineAt: deadline.deadlineAt, now: clock }) ?? completionError;
                if (
                  !visionRecovery &&
                  !initialChunkSent &&
                  !deadline.signal.aborted &&
                  (!deadline.deadlineAt || deadline.deadlineAt.getTime() - clock().getTime() >= 1000) &&
                  statelessAttempts < maxStatelessAttempts &&
                  (goldencodeRequestFailover ? canFailoverNativeError(completionError) : isStatelessRetryableProviderError(completionError)) &&
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
              const finalSummary = combineSuccessfulProviderStreamSummaries(providerSummaries) ?? successSummary;
              usage = openAIUsageFromTokenUsage(finalSummary.usage ?? undefined);
              markProviderStreamSummary(request, finalSummary);
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
        releaseDelivery?.();
        markProviderCallFinished(request, deadline.signal, clock());
        await finalizeTokenBudget(request, tokenBudgetLimiter, { now: clock });
        attempt.release();
        activeRequest.finish();
        deadline.cleanup();
        releaseRateLimit(request);
        recordObservation(request, observationStore, reply.raw.statusCode, {
          refresh: request.gatewayClientDisconnect?.signal.aborted === true
        });
        sse.end();
      }
      return;
    }

    let content = "";
    const toolCalls: OpenAIChatToolCall[] = [];
    let usage: OpenAIChatUsage | null = null;
    const deadline = createChatRequestDeadline({
      timeoutMs: chatRequestTimeoutMs || (visionRecovery ? 600_000 : 0),
      parentSignals: [executionOptions.signal, request.gatewayClientDisconnect?.signal],
      now: clock()
    });
    const activeRequest = beginActiveRequest(attempt, deadline.deadlineAt);
    markProviderCallStarted(request, clock());
    const onProviderEvent = (event: StreamEvent) =>
      markProviderEvent(request, event, clock());

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
          nativeFileToolRecoveryPolicy,
          signal: deadline.signal,
          requestId: request.id,
          log: request.log,
          onProviderError,
          onProviderEvent
        });
        if (strictResult instanceof GatewayError) {
          attempt.recordError(strictResult);
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
        const nativeResult = await runNativeWithFailover({
          failover: nativeFailover,
          visionRecovery,
          runtime: attempt,
          deadlineAt: deadline.deadlineAt,
          now: clock,
          outputCommitted: () => false,
          selected: (next) => {
            attempt = next;
            applyChatRuntimeContext(request, next);
            activeRequest.update({ upstreamRuntime: next.runtime, upstreamAccountId: next.adapterInputUpstreamAccount.id });
          },
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
          nativeFileToolRecoveryPolicy,
          boundedWriteEnabled: boundedWriteForRequest,
          signal: deadline.signal,
          requestId: request.id,
          log: request.log,
          onProviderError,
          onProviderEvent
        });
        if (nativeResult instanceof GatewayError) {
          if (!nativeFailover) attempt.recordError(nativeResult);
          markProviderStreamSummary(request, providerStreamSummaryFromError(nativeResult));
          return fail(nativeResult);
        }
        if (!nativeFailover) attempt.recordSuccess();
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
          const endError = visionRecovery?.endError({ signal: deadline.signal, deadlineAt: deadline.deadlineAt, now: clock });
          if (endError) {
            markProviderStreamSummary(request, combineProviderStreamSummaries(providerSummaries));
            return fail(endError);
          }
          const onProviderError = createProviderErrorLogger(request);
          visionRecovery?.budget.consume();
          const attemptResult = await collectProviderMessage({
            provider: attempt.adapter,
            upstreamAccount: attempt.adapterInputUpstreamAccount,
            subject: attempt.subject,
            scope: attempt.scope,
            session: attempt.session,
            message: prompt,
            ...(attempt.runtime === "local_openai"
              ? { chatMessages: parsed.messages }
              : {}),
            images: parsed.images,
            reasoningEffort: attempt.reasoningEffort,
            maximumOutputTokens,
            clientTools: nativeClientTools ? parsed.tools : undefined,
            clientToolChoice: nativeClientTools ? parsed.toolChoice : undefined,
            attemptKind: statelessAttempts > 1 ? "stateless_retry" : "primary",
            attemptToolChoice: serializeToolChoice(parsed.toolChoice),
            upstreamRuntime: attempt.runtime,
            upstreamModel: attempt.upstreamModel,
            signal: deadline.signal,
            onProviderError,
            onProviderEvent,
            suppressToolCalls: parsed.toolChoice === "none",
            suppressTextAfterToolCall: true,
            outputTruncationMode: nativeFileToolRecoveryPolicy.mode,
            outputKind: "auto",
            softToolArgumentBytes: nativeFileToolRecoveryPolicy.softArgumentBytes,
            hardToolArgumentBytes: nativeFileToolRecoveryPolicy.hardArgumentBytes
          });
          if (attemptResult instanceof GatewayError) {
            const providerSummary = providerStreamSummaryFromError(attemptResult);
            if (providerSummary) {
              providerSummaries.push(providerSummary);
            }
            attempt.recordError(attemptResult);
            if (visionRecovery && await visionRecovery.prepareRetry({ error: attemptResult, summary: providerSummary,
              signal: deadline.signal, deadlineAt: deadline.deadlineAt, now: clock, outputCommitted: false })) {
              statelessAttempts += 1;
              continue;
            }
            if (
              !visionRecovery &&
              !deadline.signal.aborted &&
              (!deadline.deadlineAt || deadline.deadlineAt.getTime() - clock().getTime() >= 1000) &&
              statelessAttempts < maxStatelessAttempts &&
              (goldencodeRequestFailover ? canFailoverNativeError(attemptResult) : isStatelessRetryableProviderError(attemptResult)) &&
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
            return fail(visionRecovery?.endError({ signal: deadline.signal, deadlineAt: deadline.deadlineAt, now: clock }) ?? attemptResult);
          }
          const afterCallError = visionRecovery?.endError({ signal: deadline.signal, deadlineAt: deadline.deadlineAt, now: clock });
          if (afterCallError) {
            providerSummaries.push(attemptResult.providerSummary);
            markProviderStreamSummary(request, combineProviderStreamSummaries(providerSummaries));
            return fail(afterCallError);
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
        const finalSummary = combineSuccessfulProviderStreamSummaries(providerSummaries) ?? collected.providerSummary;
        usage = openAIUsageFromTokenUsage(finalSummary.usage ?? undefined);
        markProviderStreamSummary(request, finalSummary);
      }

      return createChatCompletionResponse({
        shape,
        content,
        toolCalls,
        finishReason: toolCalls.length > 0 ? "tool_calls" : "stop",
        usage
      });
    } finally {
      markProviderCallFinished(request, deadline.signal, clock());
      await finalizeTokenBudget(request, tokenBudgetLimiter, { now: clock });
      attempt.release();
      activeRequest.finish();
      deadline.cleanup();
      if (request.gatewayClientDisconnect?.signal.aborted) {
        recordObservation(request, observationStore, 499, { refresh: true });
      }
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
    return executeChatCompletion(request, reply, parsed, {
      signal: request.gatewayClientDisconnect?.signal
    });
  };

  const modelRouteOptions = {
    bodyLimit: visionRequestBodyLimitBytes,
    errorHandler: (error: Error & { code?: string }, request: FastifyRequest, reply: FastifyReply) => {
      if (error.code === "FST_ERR_CTP_BODY_TOO_LARGE") {
        return reply.send(sendOpenAIError(request, reply, visionInputLimitError({
          kind: "request_bytes", actual: null, maximum: visionRequestBodyLimitBytes
        })));
      }
      return reply.send(error);
    }
  };

  app.post<{ Body: unknown }>(
    "/v1/chat/completions",
    modelRouteOptions,
    chatCompletionsHandler
  );

  app.post<{ Body: unknown }>(
    "/v1/responses",
    modelRouteOptions,
    async (request, reply) => {
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
          clientSessionId: parsed.promptCacheKey,
          signal: request.gatewayClientDisconnect?.signal
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
          createResponsesFailedEvent(
            parsed,
            streamStart.state,
            chatCompletion.error,
            clock(),
            gatewayErrorResponseContext(request, chatCompletion.error)
          ),
          chatCompletion.error
        );
        return;
      }
      const result = createResponsesResult(parsed, chatCompletion, clock(), streamStart.state);
      if (result instanceof GatewayError) {
        writeResponsesFailure(
          request,
          sse,
          createResponsesFailedEvent(
            parsed, streamStart.state, result, clock(),
            gatewayErrorResponseContext(request, result)
          ),
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
        createResponsesFailedEvent(
          parsed, streamStart.state, error, clock(),
          gatewayErrorResponseContext(request, error)
        ),
        error
      );
    } finally {
      releaseRateLimit(request);
      recordObservation(request, observationStore, reply.raw.statusCode);
      sse.end();
    }
    return;
    }
  );

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
      const providerSummary = new ProviderStreamSummaryCollector({
        now: () => clock().getTime()
      });
      const sessionPublicModel = publicModelRegistry.get(sessionPublicModelId);
      let providerFailed = false;
      let outcomeRecorded = false;

      try {
        markProviderCallStarted(request, clock());
        for await (const event of provider.message({
          upstreamAccount,
          subject,
          scope,
          session,
          message,
          signal: sse.signal,
          onProviderError: createProviderErrorLogger(request)
        })) {
          markProviderEvent(request, event, clock());
          providerSummary.record(event);
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
          if (!sse.writeEvent(event.type, publicSessionStreamEvent(event))) {
            break;
          }
        }
        if (!providerFailed && !outcomeRecorded && !sse.isClosed()) {
          upstreamRouter.recordOutcome(lease.upstreamAccount.id, "success");
        }
      } finally {
        markProviderStreamSummary(
          request,
          providerSummary.snapshot({
            kind: "primary",
            purpose: "primary",
            toolChoice: null,
            provider: upstreamAccount.provider,
            upstreamRuntime: sessionPublicModel?.runtime ?? "codex",
            upstreamModel: sessionPublicModel?.upstreamModel ?? null,
            upstreamAccountId: upstreamAccount.id
          })
        );
        markProviderCallFinished(request, sse.signal, clock());
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
