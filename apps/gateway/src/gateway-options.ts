import {
  type AdminAuditStore,
  type BillingAdminStore,
  type BillingAdminTokenStore,
  type ClientMessageEventStore,
  type CredentialAuthStore,
  GatewayError,
  type GatewayStore,
  type ObservationStore,
  type PhoneAuthStore,
  type PlanEntitlementStore,
  type ProviderAdapter,
  type RateLimitPolicy,
  type ResearchStore,
  type ResearchWorkerStore,
  type Subject,
  type TokenBudgetLimiter,
  type UnifiedClientKeyStore,
  type UpstreamAccount
} from "@codex-gateway/core";
import { type AdminMessagesAuthMode } from "./admin-client-messages.js";
import { type BillingAdminTokenMode } from "./billing-admin.js";
import { type DesktopVersionGate } from "./desktop-version-gate.js";
import { type MedevidenceOriginPolicy } from "./medevidence-origin-policy.js";
import type { ExternalIdentityStore } from "@codex-gateway/core";
import { PhoneAuthService } from "./services/phone-auth-service.js";
import { type ResearchIdentityRegistryEntry } from "./research-routes.js";
import { type UpstreamV2Client } from "./upstream-v2-client.js";
import { type BoundedWritePolicy } from "./services/write-delivery.js";
import { type CredentialRateLimiter } from "./services/rate-limiter.js";
import { type ImageGenerationProvider } from "./image-generation.js";
import { type UpstreamAccountRuntimeInput } from "./services/upstream-account-router.js";
import { ActiveRequestRegistry } from "./services/active-request-registry.js";
import { type LocalContextAdmissionMode } from "./services/local-context-admission.js";
import { type VisionAssetService } from "./services/vision-asset-service.js";

export type GatewayAuthMode = "dev" | "credential";

export interface GatewayOptions {
  boundedWritePolicy?: BoundedWritePolicy;
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
  researchOfficialSourceMode?: "brave" | "direct";
  researchOfficialWebAllowedDomains?: readonly string[];
  researchOfficialIdentityRegistry?: readonly ResearchIdentityRegistryEntry[];
  researchIdentityAgentEnabled?: boolean;
  upstreamV2Client?: UpstreamV2Client | null;
  tokenBudgetLimiter?: TokenBudgetLimiter;
  planEntitlementStore?: PlanEntitlementStore;
  phoneAuthStore?: PhoneAuthStore;
  phoneAuthService?: PhoneAuthService | null;
  externalIdentityProvider?: string | null;
  externalIdentityStore?: ExternalIdentityStore;
  unifiedKeyRecoverySecret?: string | null;
  desktopVersionGate?: DesktopVersionGate;
  medevidenceOriginPolicy?: MedevidenceOriginPolicy;
  phoneAuthLoginRateLimiter?: CredentialRateLimiter;
  phoneAuthPhoneRequestsPerMinute?: number;
  phoneAuthIpRequestsPerMinute?: number;
  phoneAuthDeviceRequestsPerMinute?: number;
  researchStore?: ResearchStore | null;
  imageGenerationProvider?: ImageGenerationProvider | null;
  imageGenerationBillingFallbackProvider?: ImageGenerationProvider | null;
  imageGenerationBillingFallbackModel?: string;
  imageGenerationBillingFallbacks?: ImageGenerationBillingFallbackInput[];
  visionAssetService?: VisionAssetService | null;
  activeRequestRegistry?: ActiveRequestRegistry;
  localContextAdmissionMode?: LocalContextAdmissionMode;
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
