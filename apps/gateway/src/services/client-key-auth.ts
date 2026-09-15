import { randomUUID } from "node:crypto";
import { type FastifyRequest } from "fastify";
import {
  type AdminAuditStore,
  type CredentialAuthStore,
  type Entitlement,
  extractAccessCredentialPrefix,
  extractUnifiedClientKeyPrefix,
  GatewayError,
  publicFeaturePolicy,
  type PlanEntitlementStore,
  type ProviderAdapter,
  type Subject,
  type SubjectStore,
  type UnifiedClientKeyRecord,
  type UnifiedClientKeyStore,
  type UpstreamAccount,
  verifyAccessCredentialToken,
  verifyUnifiedClientKeyToken
} from "@codex-gateway/core";
import { type GatewayRequestContext } from "../http/context.js";

export function parseClientSubscriptionPauseRequest(
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

export function clientSubscriptionPauseResponse(input: {
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

export function clientSubscriptionPauseError(err: unknown): GatewayError {
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

export function authenticateClientSubscriptionPauseBearer(
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
      allowedPublicModels: credential.allowedPublicModels,
      credentialClass: credential.credentialClass ?? "unknown"
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
      allowedPublicModels: credential.allowedPublicModels,
      credentialClass:
        record.credentialClass === credential.credentialClass
          ? record.credentialClass ?? "unknown"
          : "unknown"
    }
  };
}

export function authenticateUnifiedClientKeyBearer(
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
  if (!subject) {
    return invalidUnifiedKeyError();
  }
  if (subject.state !== "active") {
    return accountDisabledError();
  }

  return { record, subject };
}

export function recordUnifiedKeyResolveAudit(
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

export function invalidUnifiedKeyError(): GatewayError {
  return new GatewayError({
    code: "invalid_credential",
    message: "Invalid unified key.",
    httpStatus: 401
  });
}

function accountDisabledError(): GatewayError {
  return new GatewayError({
    code: "account_disabled",
    message: "This internal account is disabled.",
    httpStatus: 403
  });
}

function invalidAccessCredentialError(): GatewayError {
  return new GatewayError({
    code: "invalid_credential",
    message: "Invalid access credential.",
    httpStatus: 401
  });
}
