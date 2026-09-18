import {
  type AdminAuditStore,
  type BillingAdminStore,
  type BillingAdminTokenStore,
  type ClientMessageEventStore,
  type CredentialAuthStore,
  GatewayError,
  type GatewaySession,
  type GatewayStore,
  type ObservationStore,
  type IdentityRequestAuditStore,
  type PhoneAuthStore,
  type PlanEntitlementStore,
  type Subject,
  type UnifiedClientKeyStore,
  type UpstreamAccount
} from "@codex-gateway/core";
import { createSqliteClientEventsStore, createSqliteStore } from "@codex-gateway/store-sqlite";
import { type BillingSubjectMetadataStore } from "../billing-admin.js";
import type { ExternalIdentityStore } from "@codex-gateway/core";
import { InMemorySessionStore } from "../services/session-store.js";
import { type PublicModelConfig, type PublicModelRegistry } from "../services/public-model-registry.js";
import type { GatewayPublicMetadata } from "../gateway-options.js";

interface ResolvedGatewayPublicMetadata {
  serviceName: string;
  providerName: string;
  providerDisplayName: string;
  upstreamAccountLabel: string;
  phase: string;
}

export function defaultSubject(): Subject {
  return {
    id: "subj_dev",
    label: "dev-subject",
    state: "active",
    createdAt: new Date()
  };
}

export function defaultUpstreamAccount(): UpstreamAccount {
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

export function serializeSession(
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

export function resolvePublicMetadata(
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

export function publicProviderDetail(
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

export function createDefaultSessionStore(logger?: { info: (message: string) => void }): GatewayStore {
  const sqlitePath = process.env.GATEWAY_SQLITE_PATH;
  if (sqlitePath) {
    return createSqliteStore({ path: sqlitePath, logger });
  }

  return new InMemorySessionStore();
}

export function resolveNativeSessionPublicModel(
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

export function nativeSessionsUnavailable(): GatewayError {
  return new GatewayError({
    code: "service_unavailable",
    message: "Native Codex sessions are not configured.",
    httpStatus: 503,
    retryAfterSeconds: 30
  });
}

export function createDefaultClientEventsStore(): ClientMessageEventStore | undefined {
  const sqlitePath = process.env.GATEWAY_CLIENT_EVENTS_SQLITE_PATH;
  if (!sqlitePath) {
    return undefined;
  }

  return createSqliteClientEventsStore({ path: sqlitePath });
}

export function isSubjectMetadataStore(
  store: GatewayStore
): store is GatewayStore & BillingSubjectMetadataStore {
  return typeof (store as Partial<BillingSubjectMetadataStore>).updateSubject === "function";
}

export function isCredentialAuthStore(store: GatewayStore): store is GatewayStore & CredentialAuthStore {
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

export function isUnifiedClientKeyStore(
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

export function isBillingAdminTokenStore(
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

export function isAdminAuditStore(store: GatewayStore): store is GatewayStore & AdminAuditStore {
  const candidate = store as Partial<AdminAuditStore>;
  return (
    typeof candidate.insertAdminAuditEvent === "function" &&
    typeof candidate.listAdminAuditEvents === "function"
  );
}

export function isObservationStore(store: GatewayStore): store is GatewayStore & ObservationStore {
  const candidate = store as Partial<ObservationStore>;
  return (
    typeof candidate.insertRequestEvent === "function" &&
    typeof candidate.listRequestEvents === "function" &&
    typeof candidate.reportRequestUsage === "function" &&
    typeof candidate.pruneRequestEvents === "function"
  );
}

export function isPlanEntitlementStore(store: GatewayStore): store is GatewayStore & PlanEntitlementStore {
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

export function isPhoneAuthStore(
  store: GatewayStore
): store is GatewayStore & PhoneAuthStore {
  const candidate = store as Partial<PhoneAuthStore>;
  return (
    typeof candidate.preparePhoneAuthIdentity === "function" &&
    typeof candidate.setPhoneAuthIdentityState === "function" &&
    typeof candidate.getPhoneAuthIdentityByPhoneHash === "function" &&
    typeof candidate.getPhoneAuthIdentityBySubjectId === "function" &&
    typeof candidate.getPhoneAuthUnifiedKey === "function" &&
    typeof candidate.createPhoneAuthSession === "function" &&
    typeof candidate.getPhoneAuthSession === "function" &&
    typeof candidate.rotatePhoneAuthRefreshToken === "function" &&
    typeof candidate.revokePhoneAuthSession === "function"
  );
}

export function isIdentityRequestAuditStore(store: GatewayStore): store is GatewayStore & IdentityRequestAuditStore {
  const candidate = store as Partial<IdentityRequestAuditStore>;
  return typeof candidate.recordIdentityRequestEvent === "function" &&
    typeof candidate.recordIdentityRateLimit === "function" &&
    typeof candidate.pruneIdentityRequestAudit === "function";
}

export function isExternalIdentityStore(store: GatewayStore): store is GatewayStore & ExternalIdentityStore {
  const candidate = store as Partial<ExternalIdentityStore>;
  return typeof candidate.getSubjectByExternalIdentity === "function" &&
    typeof candidate.getExternalSubjectRegistration === "function" &&
    typeof candidate.getExternalSubjectRegistrationState === "function" &&
    typeof candidate.resolveExternalSubject === "function" &&
    typeof candidate.claimExternalSubjectCreate === "function" &&
    typeof candidate.recordExternalSubjectUpstream === "function" &&
    typeof candidate.recordExternalSubjectCreateFailure === "function" &&
    typeof candidate.beginExternalSubjectCompensation === "function" &&
    typeof candidate.completeExternalSubjectCompensation === "function";
}

export function isBillingAdminStore(store: GatewayStore): store is GatewayStore & BillingAdminStore {
  const candidate = store as Partial<BillingAdminStore>;
  return (
    typeof candidate.applyBillingEntitlementEvent === "function" &&
    typeof candidate.recordBillingProvisioningAttempt === "function" &&
    typeof candidate.hasBillingProvisioningAttempt === "function" &&
    typeof candidate.replayBillingSubjectCreate === "function" &&
    typeof candidate.createBillingSubject === "function" &&
    typeof candidate.replayBillingSubjectRotate === "function" &&
    typeof candidate.rotateBillingSubject === "function" &&
    typeof candidate.replayBillingSubjectDisable === "function" &&
    typeof candidate.disableBillingSubject === "function" &&
    typeof candidate.confirmBillingSubjectUpstreamDisabled === "function" &&
    typeof candidate.getBillingSubject === "function" &&
    typeof candidate.getBillingSubjectByExternal === "function" &&
    typeof candidate.getBillingSubjectActiveUnifiedKey === "function" &&
    typeof candidate.getBillingEventByIdempotencyKey === "function" &&
    typeof candidate.listBillingEvents === "function" &&
    typeof candidate.listBillingEntitlements === "function" &&
    typeof candidate.reportBillingUsage === "function"
  );
}

export function storeKind(store: GatewayStore): "sqlite" | "memory" | "custom" {
  const candidate = store as { kind?: unknown };
  if (candidate.kind === "sqlite") {
    return "sqlite";
  }
  if (store instanceof InMemorySessionStore) {
    return "memory";
  }
  return "custom";
}
