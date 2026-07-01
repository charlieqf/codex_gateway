import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  defaultPublicModelAliasGroups,
  mergeEntitlementTokenPolicy,
  billingPayloadHash,
  encryptSecret,
  extractBillingAdminTokenPrefix,
  GatewayError,
  issueAccessCredential,
  issueUnifiedClientKey,
  isBillingEventType,
  publicFeaturePolicy,
  validateBillingIdempotencyKey,
  type ApplyBillingEntitlementEventInput,
  type ApplyBillingEntitlementEventResult,
  type AccessCredentialRecord,
  type AccessCredentialStore,
  type AdminAuditStore,
  type BillingAdminStore,
  type BillingAdminTokenStore,
  type BillingApplyMode,
  type BillingEventRecord,
  type BillingSubjectDetails,
  type CreateBillingSubjectResult,
  type DisableBillingSubjectResult,
  type RotateBillingSubjectResult,
  type BillingUsageGroupBy,
  type BillingUsageReportResult,
  type Entitlement,
  type PeriodKind,
  type Plan,
  type PlanEntitlementStore,
  type PublicModelAliasGroup,
  type RateLimitPolicy,
  type Scope,
  type TokenBudgetLimiter,
  type TokenLimitPolicy,
  type TokenUsageSnapshot,
  type TokenWindowKind,
  verifyBillingAdminToken
} from "@codex-gateway/core";
import type {
  CredentialRateLimiter,
  RateLimitResetResult,
  RateLimitResetWindow
} from "./services/rate-limiter.js";
import type { UpstreamV2Client } from "./upstream-v2-client.js";

export const billingAdminTokenEnvName = "GATEWAY_BILLING_ADMIN_TOKEN";
export const billingAdminNextTokenEnvName = "GATEWAY_BILLING_ADMIN_TOKEN_NEXT";

export interface BillingAdminAccess {
  token: string;
  nextToken: string | null;
}

export type BillingAdminTokenMode = "env" | "db" | "hybrid";

export interface BillingAdminRouteOptions {
  access: BillingAdminAccess | null;
  tokenMode?: BillingAdminTokenMode;
  tokenStore?: BillingAdminTokenStore;
  billingStore?: BillingAdminStore;
  planEntitlementStore?: PlanEntitlementStore;
  credentialStore?: AccessCredentialStore;
  adminAuditStore?: AdminAuditStore;
  credentialRateLimiter?: CredentialRateLimiter;
  tokenBudgetLimiter?: TokenBudgetLimiter;
  rateLimiter?: CredentialRateLimiter;
  ratePolicy?: RateLimitPolicy;
  upstreamV2Client?: UpstreamV2Client | null;
  apiKeyEncryptionSecret?: string | null;
  publicModels?: BillingPublicModel[];
  now?: () => Date;
}

export interface BillingPublicModel extends PublicModelAliasGroup {
  displayName: string;
}

interface BillingEventQuery {
  subject_id?: string;
  provider?: string;
  external_order_id?: string;
  limit?: string;
  cursor?: string;
}

interface BillingUsageQuery {
  subject_id?: string;
  from?: string;
  to?: string;
  group_by?: string;
  public_model_id?: string;
  limit?: string;
  cursor?: string;
}

interface BillingEntitlementQuery {
  limit?: string;
  cursor?: string;
}

interface BillingSubjectQuery {
  provider?: string;
  external_user_id?: string;
}

export function resolveBillingAdminAccess(input: {
  token?: string;
  nextToken?: string;
}): BillingAdminAccess | null {
  const token = input.token?.trim();
  const nextToken = input.nextToken?.trim();
  if (!token) {
    return null;
  }
  if (token.length < 24) {
    throw new Error(`${billingAdminTokenEnvName} must be at least 24 characters.`);
  }
  if (nextToken && nextToken.length < 24) {
    throw new Error(`${billingAdminNextTokenEnvName} must be at least 24 characters.`);
  }
  return {
    token,
    nextToken: nextToken || null
  };
}

export function resolveBillingAdminTokenMode(value?: string): BillingAdminTokenMode {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return "hybrid";
  }
  if (normalized === "env" || normalized === "db" || normalized === "hybrid") {
    return normalized;
  }
  throw new Error("GATEWAY_BILLING_ADMIN_TOKEN_MODE must be env, db, or hybrid.");
}

export function registerBillingAdminRoutes(
  app: FastifyInstance,
  options: BillingAdminRouteOptions
): void {
  app.post<{ Body: unknown }>(
    "/gateway/admin/billing/v1/subjects",
    billingRouteOptions(),
    async (request, reply) => {
      const authError = billingRoutePreflight(request, reply, options);
      if (authError) {
        return authError;
      }
      if (!options.billingStore) {
        return sendBillingError(request, reply, serviceUnavailable("Billing subject store is not configured."));
      }

      const parsed = parseCreateSubjectRequest(request);
      if (parsed instanceof GatewayError) {
        return sendBillingError(request, reply, parsed);
      }

      try {
        const replay = options.billingStore.replayBillingSubjectCreate(
          parsed.idempotencyKey,
          parsed.payloadHash
        );
        if (replay) {
          return billingSecurityHeaders(reply).send(publicCreateSubjectResult(replay, null));
        }
        if (options.billingStore.getBillingSubjectByExternal(parsed.provider, parsed.externalUserId)) {
          return sendBillingError(
            request,
            reply,
            new GatewayError({
              code: "subject_already_exists",
              message: "Subject already exists for provider and external_user_id.",
              httpStatus: 409
            })
          );
        }
      } catch (err) {
        return sendBillingError(request, reply, toBillingGatewayError(err));
      }

      if (!options.upstreamV2Client) {
        return sendBillingError(request, reply, serviceUnavailable("MedEvidence v2 provisioning is not configured."));
      }
      if (!options.apiKeyEncryptionSecret) {
        return sendBillingError(
          request,
          reply,
          serviceUnavailable("Gateway API key encryption secret is not configured.")
        );
      }

      const subjectId = deterministicBillingSubjectId(parsed.provider, parsed.externalUserId);
      const v2IdempotencyKey = `medevidence:${subjectId}:create_user`;
      try {
        const upstream = await options.upstreamV2Client.createUser({
          externalProvider: "medevidence_backend",
          externalUserId: subjectId,
          displayName: parsed.displayName ?? `internal:${subjectId}`,
          metadata: {
            source: "billing_signup",
            billing_provider: parsed.provider
          },
          idempotencyKey: v2IdempotencyKey
        });

        const now = billingNow(options);
        const expiresAt = addDays(now, 365);
        const gatewayCredential = issueAccessCredential({
          subjectId,
          label: `Billing ${parsed.provider}`,
          scope: parsed.scopeAllowlist[0] ?? "code",
          expiresAt,
          now
        });
        const gatewayRecord = {
          ...gatewayCredential.record,
          tokenCiphertext: encryptSecret(gatewayCredential.token, options.apiKeyEncryptionSecret)
        };
        const unified = issueUnifiedClientKey({
          subjectId,
          label: `Billing ${parsed.provider}`,
          expiresAt,
          codexCredentialId: gatewayRecord.id,
          codexCredentialPrefix: gatewayRecord.prefix,
          codexKeyCiphertext: encryptSecret(gatewayCredential.token, options.apiKeyEncryptionSecret),
          medevidenceKeyCiphertext: encryptSecret(upstream.key.key, options.apiKeyEncryptionSecret),
          medevidenceKeyPrefix: upstream.key.keyPrefix,
          metadata: null,
          now
        });
        const result = options.billingStore.createBillingSubject({
          idempotencyKey: parsed.idempotencyKey,
          payloadHash: parsed.payloadHash,
          subjectId,
          provider: parsed.provider,
          externalUserId: parsed.externalUserId,
          displayName: parsed.displayName,
          scopeAllowlist: parsed.scopeAllowlist,
          metadata: parsed.metadata,
          gatewayCredential: gatewayRecord,
          unifiedClientKey: unified.record,
          upstreamV2Binding: {
            subjectId,
            v2UserId: upstream.user.id,
            v2KeyId: upstream.key.id,
            state: "active",
            lastSyncedAt: now,
            metadata: {
              idempotency_key: v2IdempotencyKey,
              key_prefix: upstream.key.keyPrefix ?? null
            },
            createdAt: now,
            updatedAt: now
          },
          now
        });
        return billingSecurityHeaders(reply).send(publicCreateSubjectResult(result, unified.token));
      } catch (err) {
        return sendBillingError(request, reply, toBillingGatewayError(err));
      }
    }
  );

  app.get<{ Querystring: BillingSubjectQuery }>(
    "/gateway/admin/billing/v1/subjects",
    billingRouteOptions(),
    async (request, reply) => {
      const authError = billingRoutePreflight(request, reply, options);
      if (authError) {
        return authError;
      }
      if (!options.billingStore) {
        return sendBillingError(request, reply, serviceUnavailable("Billing subject store is not configured."));
      }
      const provider = optionalString(request.query.provider);
      const externalUserId = optionalString(request.query.external_user_id);
      if (!provider || !externalUserId) {
        return sendBillingError(request, reply, invalidRequest("provider and external_user_id are required."));
      }
      const subject = options.billingStore.getBillingSubjectByExternal(provider, externalUserId);
      if (!subject) {
        return sendBillingError(request, reply, subjectNotFound());
      }
      return billingSecurityHeaders(reply).send(publicSubjectDetails(subject));
    }
  );

  app.get<{ Params: { subjectId: string } }>(
    "/gateway/admin/billing/v1/subjects/:subjectId",
    billingRouteOptions(),
    async (request, reply) => {
      const authError = billingRoutePreflight(request, reply, options);
      if (authError) {
        return authError;
      }
      if (!options.billingStore) {
        return sendBillingError(request, reply, serviceUnavailable("Billing subject store is not configured."));
      }
      const subject = options.billingStore.getBillingSubject(request.params.subjectId);
      if (!subject) {
        return sendBillingError(request, reply, subjectNotFound());
      }
      return billingSecurityHeaders(reply).send(publicSubjectDetails(subject));
    }
  );

  app.post<{ Params: { subjectId: string }; Body: unknown }>(
    "/gateway/admin/billing/v1/subjects/:subjectId/keys",
    billingRouteOptions(),
    async (request, reply) => {
      const authError = billingRoutePreflight(request, reply, options);
      if (authError) {
        return authError;
      }
      if (!options.billingStore) {
        return sendBillingError(request, reply, serviceUnavailable("Billing subject store is not configured."));
      }
      if (!options.apiKeyEncryptionSecret) {
        return sendBillingError(
          request,
          reply,
          serviceUnavailable("Gateway API key encryption secret is not configured.")
        );
      }

      const parsed = parseRotateSubjectRequest(request);
      if (parsed instanceof GatewayError) {
        return sendBillingError(request, reply, parsed);
      }

      try {
        const replay = options.billingStore.replayBillingSubjectRotate(
          parsed.idempotencyKey,
          parsed.payloadHash
        );
        if (replay) {
          return billingSecurityHeaders(reply).send(publicRotateSubjectResult(replay, null));
        }

        const subject = options.billingStore.getBillingSubject(parsed.subjectId);
        if (!subject || subject.subject.state !== "active") {
          return sendBillingError(request, reply, subjectNotFound());
        }
        const activeUnifiedKey = options.billingStore.getBillingSubjectActiveUnifiedKey(parsed.subjectId);
        if (!activeUnifiedKey) {
          return sendBillingError(
            request,
            reply,
            new GatewayError({
              code: "credential_not_found",
              message: "Active opaque key does not exist for subject.",
              httpStatus: 404
            })
          );
        }

        const now = billingNow(options);
        const expiresAt = addDays(now, 365);
        const gatewayCredential = issueAccessCredential({
          subjectId: parsed.subjectId,
          label: `Billing ${subject.subject.externalProvider ?? "subject"} rotated`,
          scope: subject.scopeAllowlist[0] ?? "code",
          expiresAt,
          now,
          rotatesId: activeUnifiedKey.codexCredentialId
        });
        const gatewayRecord = {
          ...gatewayCredential.record,
          tokenCiphertext: encryptSecret(gatewayCredential.token, options.apiKeyEncryptionSecret)
        };
        const unified = issueUnifiedClientKey({
          subjectId: parsed.subjectId,
          label: `Billing ${subject.subject.externalProvider ?? "subject"} rotated`,
          expiresAt,
          codexCredentialId: gatewayRecord.id,
          codexCredentialPrefix: gatewayRecord.prefix,
          codexKeyCiphertext: encryptSecret(gatewayCredential.token, options.apiKeyEncryptionSecret),
          medevidenceKeyCiphertext: activeUnifiedKey.medevidenceKeyCiphertext,
          medevidenceKeyPrefix: activeUnifiedKey.medevidenceKeyPrefix,
          metadata: activeUnifiedKey.metadata,
          now
        });

        const result = options.billingStore.rotateBillingSubject({
          idempotencyKey: parsed.idempotencyKey,
          payloadHash: parsed.payloadHash,
          subjectId: parsed.subjectId,
          reason: parsed.reason,
          revokePrevious: parsed.revokePrevious,
          gracePeriodSeconds: parsed.gracePeriodSeconds,
          gatewayCredential: gatewayRecord,
          unifiedClientKey: unified.record,
          now
        });
        return billingSecurityHeaders(reply).send(publicRotateSubjectResult(result, unified.token));
      } catch (err) {
        return sendBillingError(request, reply, toBillingGatewayError(err));
      }
    }
  );

  app.post<{ Params: { subjectId: string }; Body: unknown }>(
    "/gateway/admin/billing/v1/subjects/:subjectId/disable",
    billingRouteOptions(),
    async (request, reply) => {
      const authError = billingRoutePreflight(request, reply, options);
      if (authError) {
        return authError;
      }
      if (!options.billingStore) {
        return sendBillingError(request, reply, serviceUnavailable("Billing subject store is not configured."));
      }

      const parsed = parseDisableSubjectRequest(request);
      if (parsed instanceof GatewayError) {
        return sendBillingError(request, reply, parsed);
      }

      try {
        const replay = options.billingStore.replayBillingSubjectDisable(
          parsed.idempotencyKey,
          parsed.payloadHash
        );
        if (replay) {
          return billingSecurityHeaders(reply).send(publicDisableSubjectResult(replay));
        }

        const subject = options.billingStore.getBillingSubject(parsed.subjectId);
        if (!subject) {
          return sendBillingError(request, reply, subjectNotFound());
        }
        if (subject.upstreamV2Binding?.v2UserId && !options.upstreamV2Client) {
          return sendBillingError(request, reply, serviceUnavailable("MedEvidence v2 provisioning is not configured."));
        }
        if (subject.upstreamV2Binding?.v2UserId && options.upstreamV2Client) {
          await options.upstreamV2Client.disableUser({
            externalUserId: parsed.subjectId,
            userId: subject.upstreamV2Binding.v2UserId,
            reason: parsed.reason,
            idempotencyKey: `medevidence:${parsed.subjectId}:disable_user`
          });
        }

        const result = options.billingStore.disableBillingSubject({
          idempotencyKey: parsed.idempotencyKey,
          payloadHash: parsed.payloadHash,
          subjectId: parsed.subjectId,
          reason: parsed.reason
        });
        return billingSecurityHeaders(reply).send(publicDisableSubjectResult(result));
      } catch (err) {
        return sendBillingError(request, reply, toBillingGatewayError(err));
      }
    }
  );

  app.get(
    "/gateway/admin/billing/v1/plans",
    billingRouteOptions(),
    async (request, reply) => {
      const authError = billingRoutePreflight(request, reply, options);
      if (authError) {
        return authError;
      }
      if (!options.planEntitlementStore) {
        return sendBillingError(request, reply, serviceUnavailable("Billing plan store is not configured."));
      }

      return billingSecurityHeaders(reply).send({
        plans: options.planEntitlementStore.listPlans({ state: "active" }).map(publicPlan)
      });
    }
  );

  app.post<{ Body: unknown }>(
    "/gateway/admin/billing/v1/entitlement-events",
    billingRouteOptions(),
    async (request, reply) => {
      const authError = billingRoutePreflight(request, reply, options);
      if (authError) {
        return authError;
      }
      if (!options.billingStore) {
        return sendBillingError(request, reply, serviceUnavailable("Billing event store is not configured."));
      }

      const parsed = parseBillingEntitlementEventRequest(request);
      if (parsed instanceof GatewayError) {
        return sendBillingError(request, reply, parsed);
      }

      try {
        return billingSecurityHeaders(reply).send(
          publicApplyResult(options.billingStore.applyBillingEntitlementEvent(parsed))
        );
      } catch (err) {
        return sendBillingError(request, reply, toBillingGatewayError(err));
      }
    }
  );

  app.get<{ Querystring: BillingEventQuery }>(
    "/gateway/admin/billing/v1/entitlement-events",
    billingRouteOptions(),
    async (request, reply) => {
      const authError = billingRoutePreflight(request, reply, options);
      if (authError) {
        return authError;
      }
      if (!options.billingStore) {
        return sendBillingError(request, reply, serviceUnavailable("Billing event store is not configured."));
      }

      try {
        const result = options.billingStore.listBillingEvents({
          subjectId: optionalString(request.query.subject_id) ?? undefined,
          provider: optionalString(request.query.provider) ?? undefined,
          externalOrderId: optionalString(request.query.external_order_id) ?? undefined,
          limit: parseLimit(request.query.limit, 50),
          cursor: optionalString(request.query.cursor) ?? undefined
        });
        return billingSecurityHeaders(reply).send({
          billing_events: result.events.map((event) => publicBillingEvent(event)),
          next_cursor: result.nextCursor
        });
      } catch (err) {
        return sendBillingError(request, reply, toBillingGatewayError(err));
      }
    }
  );

  app.get<{ Params: { idempotencyKey: string } }>(
    "/gateway/admin/billing/v1/entitlement-events/:idempotencyKey",
    billingRouteOptions(),
    async (request, reply) => {
      const authError = billingRoutePreflight(request, reply, options);
      if (authError) {
        return authError;
      }
      if (!options.billingStore) {
        return sendBillingError(request, reply, serviceUnavailable("Billing event store is not configured."));
      }

      const key = decodeURIComponent(request.params.idempotencyKey);
      const event = options.billingStore.getBillingEventByIdempotencyKey(key);
      if (!event) {
        return sendBillingError(
          request,
          reply,
          new GatewayError({
            code: "entitlement_not_found",
            message: "Billing entitlement event was not found.",
            httpStatus: 404
          })
        );
      }
      return billingSecurityHeaders(reply).send({ billing_event: publicBillingEvent(event) });
    }
  );

  app.get<{ Params: { subjectId: string }; Querystring: BillingEntitlementQuery }>(
    "/gateway/admin/billing/v1/users/:subjectId/entitlements",
    billingRouteOptions(),
    async (request, reply) => {
      const authError = billingRoutePreflight(request, reply, options);
      if (authError) {
        return authError;
      }
      if (!options.billingStore) {
        return sendBillingError(request, reply, serviceUnavailable("Billing event store is not configured."));
      }

      try {
        const result = options.billingStore.listBillingEntitlements({
          subjectId: request.params.subjectId,
          limit: parseLimit(request.query.limit, 50),
          cursor: optionalString(request.query.cursor) ?? undefined
        });
        return billingSecurityHeaders(reply).send({
          subject_id: result.subjectId,
          current: result.current ? publicEntitlement(result.current) : null,
          history: result.history.map(publicEntitlement),
          next_cursor: result.nextCursor
        });
      } catch (err) {
        return sendBillingError(request, reply, toBillingGatewayError(err));
      }
    }
  );

  app.post<{ Params: { subjectId: string }; Body: unknown }>(
    "/gateway/admin/billing/v1/users/:subjectId/quota-reset",
    billingRouteOptions(),
    async (request, reply) => {
      const authError = billingRoutePreflight(request, reply, options);
      if (authError) {
        return authError;
      }

      const parsed = parseBillingQuotaResetRequest(request);
      if (parsed instanceof GatewayError) {
        return sendBillingError(request, reply, parsed);
      }
      if (!options.credentialStore) {
        return sendBillingError(request, reply, serviceUnavailable("Credential store is not configured."));
      }

      const now = billingNow(options);
      const credentials = resolveQuotaResetCredentials(
        options.credentialStore,
        parsed.subjectId,
        parsed.credentialPrefix,
        now
      );
      if (credentials instanceof GatewayError) {
        recordBillingQuotaResetAudit(options, parsed, "error", credentials.message);
        return sendBillingError(request, reply, credentials);
      }

      try {
        const requestReset = resetRequestQuota(options, credentials, parsed.requestWindows);
        const tokenReset = await resetTokenQuota(options, credentials[0], parsed.tokenWindows, now);
        recordBillingQuotaResetAudit(options, parsed, "ok", null, {
          credential_prefixes: credentials.map((credential) => credential.prefix),
          request_windows: parsed.requestWindows,
          token_windows: parsed.tokenWindows,
          reason: parsed.reason
        });
        return billingSecurityHeaders(reply).send({
          subject_id: parsed.subjectId,
          credential_prefixes: credentials.map((credential) => credential.prefix),
          request_reset: requestReset,
          token_reset: tokenReset
        });
      } catch (err) {
        const message = sanitizeBillingAdminLogMessage(errorMessage(err));
        request.log.error({ error: message }, "Billing quota reset failed.");
        recordBillingQuotaResetAudit(options, parsed, "error", message);
        return sendBillingError(request, reply, toBillingGatewayError(err));
      }
    }
  );

  app.get<{ Querystring: BillingUsageQuery }>(
    "/gateway/admin/billing/v1/usage",
    billingRouteOptions(),
    async (request, reply) => {
      const authError = billingRoutePreflight(request, reply, options);
      if (authError) {
        return authError;
      }
      if (!options.billingStore) {
        return sendBillingError(request, reply, serviceUnavailable("Billing event store is not configured."));
      }

      const parsed = parseUsageQuery(request.query);
      if (parsed instanceof GatewayError) {
        return sendBillingError(request, reply, parsed);
      }
      try {
        const publicModels = billingPublicModels(options.publicModels);
        return billingSecurityHeaders(reply).send(
          publicUsageResult(
            options.billingStore.reportBillingUsage({
              ...parsed,
              publicModelAliases: publicModels
            }),
            publicModels
          )
        );
      } catch (err) {
        return sendBillingError(request, reply, toBillingGatewayError(err));
      }
    }
  );

  app.get(
    "/gateway/admin/billing/v1/usage-ui",
    billingRouteOptions(),
    async (request, reply) => {
      if (!isBillingAdminAuthConfigured(options) || !options.billingStore) {
        return sendBillingError(
          request,
          reply,
          serviceUnavailable("Billing usage UI is not configured.")
        );
      }
      return billingPageSecurityHeaders(reply)
        .type("text/html; charset=utf-8")
        .send(renderBillingUsagePage({ publicModels: billingPublicModels(options.publicModels) }));
    }
  );
}

function billingRouteOptions() {
  return {
    config: {
      public: true,
      skipRateLimit: true,
      skipObservation: true
    }
  };
}

function billingRoutePreflight(
  request: FastifyRequest,
  reply: FastifyReply,
  options: BillingAdminRouteOptions
): FastifyReply | null {
  if (!isBillingAdminAuthConfigured(options)) {
    return sendBillingError(request, reply, serviceUnavailable("Billing admin API is not configured."));
  }
  let authError: GatewayError | null;
  try {
    authError = authenticateBillingAdminRequest(request, options);
  } catch (err) {
    request.log.error(
      {
        error: sanitizeBillingAdminLogMessage(errorMessage(err))
      },
      "Billing admin token authentication store failed."
    );
    return sendBillingError(request, reply, serviceUnavailable("Billing admin token store failed."));
  }
  if (authError) {
    return sendBillingError(request, reply, authError);
  }
  if (options.rateLimiter && options.ratePolicy) {
    const permit = options.rateLimiter.acquire({
      credentialId: "billing-admin",
      policy: options.ratePolicy
    });
    if (!("release" in permit)) {
      reply.header("retry-after", String(permit.error.retryAfterSeconds ?? 1));
      return sendBillingError(request, reply, permit.error);
    }
    request.gatewayRateLimitRelease = () => {
      permit.release();
      request.gatewayRateLimitRelease = undefined;
    };
  }
  return null;
}

function authenticateBillingAdminRequest(
  request: FastifyRequest,
  options: BillingAdminRouteOptions
): GatewayError | null {
  const authorization = request.headers.authorization;
  if (!authorization) {
    return new GatewayError({
      code: "missing_credential",
      message: "Billing admin token is required.",
      httpStatus: 401
    });
  }
  const [scheme, token] = authorization.split(/\s+/, 2);
  if (scheme?.toLowerCase() !== "bearer" || !token) {
    return new GatewayError({
      code: "invalid_credential",
      message: "Invalid billing admin token.",
      httpStatus: 401
    });
  }
  const tokenMode = options.tokenMode ?? "hybrid";
  if (tokenMode !== "env" && options.tokenStore) {
    const prefix = extractBillingAdminTokenPrefix(token);
    if (prefix) {
      const record = options.tokenStore.getBillingAdminTokenByPrefix(prefix);
      if (!record) {
        return invalidBillingAdminToken();
      }
      const now = billingNow(options);
      const verificationError = verifyBillingAdminToken(token, record, now);
      if (verificationError) {
        return verificationError;
      }
      if (!record.lastUsedAt || now.getTime() - record.lastUsedAt.getTime() >= 60_000) {
        try {
          options.tokenStore.updateBillingAdminTokenLastUsedAt(prefix, now);
        } catch (err) {
          request.log.warn(
            {
              token_prefix: prefix,
              error: sanitizeBillingAdminLogMessage(errorMessage(err))
            },
            "Billing admin token last_used_at update failed."
          );
        }
      }
      return null;
    }
  }

  if (tokenMode !== "db" && options.access && billingAdminEnvTokenMatches(token, options.access)) {
    return null;
  }

  return invalidBillingAdminToken();
}

function isBillingAdminAuthConfigured(options: BillingAdminRouteOptions): boolean {
  const tokenMode = options.tokenMode ?? "hybrid";
  if (tokenMode === "env") {
    return Boolean(options.access);
  }
  if (tokenMode === "db") {
    return Boolean(options.tokenStore);
  }
  return Boolean(options.access || options.tokenStore);
}

function billingAdminEnvTokenMatches(token: string, access: BillingAdminAccess): boolean {
  return safeEqual(token, access.token) || Boolean(access.nextToken && safeEqual(token, access.nextToken));
}

function invalidBillingAdminToken(): GatewayError {
  return new GatewayError({
    code: "invalid_credential",
    message: "Invalid billing admin token.",
    httpStatus: 401
  });
}

export function sanitizeBillingAdminLogMessage(message: string): string {
  return message
    .replace(/bat_(?:test|live)_[A-Za-z0-9._-]+/g, "bat_<redacted>")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer <redacted>");
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function parseBillingEntitlementEventRequest(
  request: FastifyRequest
): ApplyBillingEntitlementEventInput | GatewayError {
  const idempotencyKey = headerString(request.headers["idempotency-key"]);
  if (!idempotencyKey || !validateBillingIdempotencyKey(idempotencyKey)) {
    return new GatewayError({
      code: "invalid_request",
      message: "Idempotency-Key is required and must match [A-Za-z0-9._:-]{1,200}.",
      httpStatus: 400
    });
  }

  const body = objectBody(request.body);
  if (body instanceof GatewayError) {
    return body;
  }
  const eventType = body.event_type;
  if (!isBillingEventType(eventType)) {
    return new GatewayError({
      code: "invalid_event_type",
      message: "event_type is not supported.",
      httpStatus: 400
    });
  }
  const applyMode = (body.apply_mode ?? "apply") as BillingApplyMode;
  if (applyMode !== "apply" && applyMode !== "log_only") {
    return invalidRequest("apply_mode must be apply or log_only.");
  }
  const provider = requiredString(body.provider, "provider");
  const externalOrderId = requiredString(body.external_order_id, "external_order_id");
  const subjectId = requiredString(body.subject_id, "subject_id");
  if (provider instanceof GatewayError) {
    return provider;
  }
  if (externalOrderId instanceof GatewayError) {
    return externalOrderId;
  }
  if (subjectId instanceof GatewayError) {
    return subjectId;
  }

  const periodKind = optionalPeriodKind(body.period_kind);
  if (periodKind instanceof GatewayError) {
    return periodKind;
  }
  const periodStart = optionalOffsetDate(body.period_start, "period_start");
  if (periodStart instanceof GatewayError) {
    return periodStart;
  }
  const periodEnd = optionalOffsetDate(body.period_end, "period_end");
  if (periodEnd instanceof GatewayError) {
    return periodEnd;
  }
  const amountMinor = optionalInteger(body.amount_minor, "amount_minor");
  if (amountMinor instanceof GatewayError) {
    return amountMinor;
  }
  const metadata = optionalMetadata(body.metadata);
  if (metadata instanceof GatewayError) {
    return metadata;
  }

  return {
    idempotencyKey,
    eventType,
    applyMode,
    provider,
    externalOrderId,
    externalEventId: optionalString(body.external_event_id),
    subjectId,
    planId: optionalString(body.plan_id),
    periodKind,
    periodStart,
    periodEnd,
    replaceCurrent: body.replace_current === true,
    replaceScheduled: body.replace_scheduled === true,
    replacePaused: body.replace_paused === true,
    entitlementId: optionalString(body.entitlement_id),
    reason: optionalString(body.reason),
    amountMinor,
    currency: optionalCurrency(body.currency),
    metadata,
    payloadHash: billingPayloadHash(body)
  };
}

function parseCreateSubjectRequest(
  request: FastifyRequest
):
  | {
      idempotencyKey: string;
      provider: string;
      externalUserId: string;
      displayName: string | null;
      scopeAllowlist: Scope[];
      metadata: Record<string, unknown> | null;
      payloadHash: string;
    }
  | GatewayError {
  const idempotencyKey = headerString(request.headers["idempotency-key"]);
  if (!idempotencyKey || !validateBillingIdempotencyKey(idempotencyKey)) {
    return new GatewayError({
      code: "invalid_request",
      message: "Idempotency-Key is required and must match [A-Za-z0-9._:-]{1,200}.",
      httpStatus: 400
    });
  }
  const body = objectBody(request.body);
  if (body instanceof GatewayError) {
    return body;
  }
  const provider = requiredString(body.provider, "provider");
  const externalUserId = requiredString(body.external_user_id, "external_user_id");
  if (provider instanceof GatewayError) {
    return provider;
  }
  if (externalUserId instanceof GatewayError) {
    return externalUserId;
  }
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(externalUserId)) {
    return new GatewayError({
      code: "invalid_external_user_id",
      message: "external_user_id must match [A-Za-z0-9._-]{1,128}.",
      httpStatus: 400
    });
  }
  const scopeAllowlist = parseScopeAllowlist(body.scope_allowlist);
  if (scopeAllowlist instanceof GatewayError) {
    return scopeAllowlist;
  }
  const metadata = optionalMetadata(body.metadata);
  if (metadata instanceof GatewayError) {
    return metadata;
  }
  return {
    idempotencyKey,
    provider,
    externalUserId,
    displayName: optionalString(body.display_name),
    scopeAllowlist,
    metadata,
    payloadHash: billingPayloadHash(body)
  };
}

function parseRotateSubjectRequest(
  request: FastifyRequest<{ Params: { subjectId: string } }>
):
  | {
      idempotencyKey: string;
      subjectId: string;
      reason: string | null;
      revokePrevious: boolean;
      gracePeriodSeconds: number;
      payloadHash: string;
    }
  | GatewayError {
  const idempotencyKey = headerString(request.headers["idempotency-key"]);
  if (!idempotencyKey || !validateBillingIdempotencyKey(idempotencyKey)) {
    return new GatewayError({
      code: "invalid_request",
      message: "Idempotency-Key is required and must match [A-Za-z0-9._:-]{1,200}.",
      httpStatus: 400
    });
  }
  const body = objectBody(request.body ?? {});
  if (body instanceof GatewayError) {
    return body;
  }
  const gracePeriodSeconds = optionalInteger(body.grace_period_seconds, "grace_period_seconds");
  if (gracePeriodSeconds instanceof GatewayError) {
    return gracePeriodSeconds;
  }
  if (gracePeriodSeconds !== null && (gracePeriodSeconds < 0 || gracePeriodSeconds > 3600)) {
    return invalidRequest("grace_period_seconds must be between 0 and 3600.");
  }
  return {
    idempotencyKey,
    subjectId: request.params.subjectId,
    reason: optionalString(body.reason),
    revokePrevious: body.revoke_previous !== false,
    gracePeriodSeconds: gracePeriodSeconds ?? 0,
    payloadHash: billingPayloadHash({
      subject_id: request.params.subjectId,
      ...body
    })
  };
}

function parseDisableSubjectRequest(
  request: FastifyRequest<{ Params: { subjectId: string } }>
):
  | {
      idempotencyKey: string;
      subjectId: string;
      reason: string | null;
      payloadHash: string;
    }
  | GatewayError {
  const idempotencyKey = headerString(request.headers["idempotency-key"]);
  if (!idempotencyKey || !validateBillingIdempotencyKey(idempotencyKey)) {
    return new GatewayError({
      code: "invalid_request",
      message: "Idempotency-Key is required and must match [A-Za-z0-9._:-]{1,200}.",
      httpStatus: 400
    });
  }
  const body = objectBody(request.body ?? {});
  if (body instanceof GatewayError) {
    return body;
  }
  return {
    idempotencyKey,
    subjectId: request.params.subjectId,
    reason: optionalString(body.reason),
    payloadHash: billingPayloadHash({
      subject_id: request.params.subjectId,
      ...body
    })
  };
}

function parseBillingQuotaResetRequest(
  request: FastifyRequest<{ Params: { subjectId: string } }>
):
  | {
      subjectId: string;
      credentialPrefix: string | null;
      requestWindows: RateLimitResetWindow[];
      tokenWindows: TokenWindowKind[];
      reason: string | null;
    }
  | GatewayError {
  const body = objectBody(request.body ?? {});
  if (body instanceof GatewayError) {
    return body;
  }
  const requestWindows = parseWindowList(
    body.request_windows,
    ["minute", "day"],
    ["day"],
    "request_windows"
  );
  if (requestWindows instanceof GatewayError) {
    return requestWindows;
  }
  const tokenWindows = parseWindowList(
    body.token_windows,
    ["minute", "day", "month"],
    ["day"],
    "token_windows"
  );
  if (tokenWindows instanceof GatewayError) {
    return tokenWindows;
  }
  if (requestWindows.length === 0 && tokenWindows.length === 0) {
    return invalidRequest("At least one request or token window must be selected.");
  }
  return {
    subjectId: request.params.subjectId,
    credentialPrefix: optionalString(body.credential_prefix),
    requestWindows: requestWindows as RateLimitResetWindow[],
    tokenWindows: tokenWindows as TokenWindowKind[],
    reason: optionalString(body.reason)
  };
}

function parseWindowList<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T[],
  field: string
): T[] | GatewayError {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (!Array.isArray(value)) {
    return invalidRequest(`${field} must be an array.`);
  }
  const windows: T[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !allowed.includes(item as T)) {
      return invalidRequest(`${field} contains an unsupported window.`);
    }
    if (!windows.includes(item as T)) {
      windows.push(item as T);
    }
  }
  return windows;
}

function parseScopeAllowlist(value: unknown): Scope[] | GatewayError {
  if (value === undefined || value === null) {
    return ["code"];
  }
  if (!Array.isArray(value) || value.length === 0) {
    return invalidRequest("scope_allowlist must be a non-empty array.");
  }
  const scopes: Scope[] = [];
  for (const item of value) {
    if (item !== "code" && item !== "medical") {
      return invalidRequest("scope_allowlist can only contain code or medical.");
    }
    if (!scopes.includes(item)) {
      scopes.push(item);
    }
  }
  return scopes;
}

function parseUsageQuery(
  query: BillingUsageQuery
): {
  subjectId: string;
  from: Date;
  to: Date;
  groupBy: BillingUsageGroupBy;
  publicModelId?: string;
  limit?: number;
  cursor?: string;
} | GatewayError {
  const subjectId = requiredString(query.subject_id, "subject_id");
  if (subjectId instanceof GatewayError) {
    return subjectId;
  }
  const from = requiredOffsetDate(query.from, "from");
  if (from instanceof GatewayError) {
    return from;
  }
  const to = requiredOffsetDate(query.to, "to");
  if (to instanceof GatewayError) {
    return to;
  }
  if (to.getTime() <= from.getTime()) {
    return invalidRequest("to must be after from.");
  }
  if (to.getTime() - from.getTime() > 90 * 24 * 60 * 60 * 1000) {
    return invalidRequest("usage query range cannot exceed 90 days.");
  }
  const groupBy = (query.group_by ?? "day") as BillingUsageGroupBy;
  if (groupBy !== "day" && groupBy !== "month" && groupBy !== "none" && groupBy !== "model") {
    return invalidRequest("group_by must be day, month, none, or model.");
  }
  return {
    subjectId,
    from,
    to,
    groupBy,
    publicModelId: optionalString(query.public_model_id) ?? undefined,
    limit: parseLimit(query.limit, 90),
    cursor: optionalString(query.cursor) ?? undefined
  };
}

function publicApplyResult(result: ApplyBillingEntitlementEventResult) {
  return {
    applied: result.applied,
    idempotent_replay: result.idempotentReplay,
    billing_event: publicBillingEvent(result.billingEvent, false),
    subject_id: result.subjectId,
    ...(result.plan
      ? {
          plan: {
            id: result.plan.id,
            display_name: result.plan.displayName
          }
        }
      : {}),
    ...(result.entitlement ? { entitlement: publicEntitlement(result.entitlement) } : {}),
    cancelled_entitlement_ids: result.cancelledEntitlementIds
  };
}

function publicBillingEvent(event: BillingEventRecord, includeIdempotency = true) {
  return {
    id: event.id,
    ...(includeIdempotency ? { idempotency_key: event.idempotencyKey } : {}),
    provider: event.provider,
    external_order_id: event.externalOrderId,
    external_event_id: event.externalEventId,
    event_type: event.eventType,
    apply_mode: event.applyMode,
    status: event.status,
    subject_id: event.subjectId,
    plan_id: event.planId,
    entitlement_id: event.entitlementId,
    amount_minor: event.amountMinor,
    currency: event.currency,
    period_kind: event.periodKind,
    period_start: event.periodStart?.toISOString() ?? null,
    period_end: event.periodEnd?.toISOString() ?? null,
    applied_at: event.appliedAt?.toISOString() ?? null,
    error_message: event.errorMessage,
    created_at: event.createdAt.toISOString()
  };
}

function publicPlan(plan: Plan) {
  return {
    id: plan.id,
    display_name: plan.displayName,
    state: plan.state,
    scope_allowlist: plan.scopeAllowlist,
    token_policy: publicTokenPolicy(plan.policy),
    feature_policy: publicFeaturePolicy(plan.featurePolicy)
  };
}

function publicEntitlement(entitlement: Entitlement) {
  return {
    id: entitlement.id,
    plan_id: entitlement.planId,
    state: entitlement.state,
    period_kind: entitlement.periodKind,
    period_start: entitlement.periodStart.toISOString(),
    period_end: entitlement.periodEnd?.toISOString() ?? null,
    scope_allowlist: entitlement.scopeAllowlist,
    feature_policy: publicFeaturePolicy(entitlement.featurePolicySnapshot)
  };
}

function publicUsageResult(
  result: BillingUsageReportResult,
  publicModels: BillingPublicModel[] | undefined
) {
  return {
    subject_id: result.subjectId,
    from: result.from.toISOString(),
    to: result.to.toISOString(),
    group_by: result.groupBy,
    rows: result.rows.map((row) => ({
      period_start: row.periodStart?.toISOString() ?? null,
      ...(row.publicModelId !== undefined
        ? {
            public_model_id: row.publicModelId,
            model_display_name: modelDisplayName(row.publicModelId, publicModels)
          }
        : {}),
      request_count: row.requestCount,
      success_count: row.successCount,
      error_count: row.errorCount,
      prompt_tokens: row.promptTokens,
      completion_tokens: row.completionTokens,
      total_tokens: row.totalTokens,
      estimated_tokens: row.estimatedTokens
    })),
    next_cursor: result.nextCursor
  };
}

function billingPublicModels(publicModels: BillingPublicModel[] | undefined): BillingPublicModel[] {
  const merged = new Map<string, BillingPublicModel>();
  for (const group of defaultPublicModelAliasGroups) {
    merged.set(group.id, {
      id: group.id,
      aliases: [...(group.aliases ?? [])],
      displayName: group.id === "max" ? "Max" : group.id
    });
  }
  for (const model of publicModels ?? []) {
    const aliasTarget = Array.from(merged.values()).find((candidate) =>
      candidate.aliases?.includes(model.id)
    );
    if (aliasTarget && aliasTarget.id !== model.id) {
      merged.set(aliasTarget.id, {
        ...aliasTarget,
        aliases: Array.from(new Set([...(aliasTarget.aliases ?? []), model.id, ...(model.aliases ?? [])]))
      });
      continue;
    }
    merged.set(model.id, model);
  }
  return Array.from(merged.values());
}

function renderBillingUsagePage(input: { publicModels: BillingPublicModel[] }): string {
  const models = input.publicModels.map((model) => ({
    id: model.id,
    displayName: model.displayName
  }));
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Billing Usage</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f7f9;
      --panel: #ffffff;
      --line: #d9dee7;
      --line-strong: #aeb8c8;
      --text: #141821;
      --muted: #5b6574;
      --accent: #1459b8;
      --accent-dark: #0e438c;
      --ok: #067647;
      --bad: #b42318;
      --warn-bg: #fff6df;
      --warn-line: #edc967;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background: var(--bg);
      color: var(--text);
    }
    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 16px 22px;
      border-bottom: 1px solid var(--line);
      background: var(--panel);
      position: sticky;
      top: 0;
      z-index: 10;
    }
    h1 {
      margin: 0;
      font-size: 20px;
      line-height: 1.2;
      font-weight: 700;
      letter-spacing: 0;
    }
    main {
      width: min(1480px, 100%);
      margin: 0 auto;
      padding: 16px 22px 30px;
    }
    .token {
      display: grid;
      grid-template-columns: auto minmax(260px, 360px);
      gap: 10px;
      align-items: center;
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
    }
    .toolbar {
      display: grid;
      grid-template-columns: minmax(220px, 1.3fr) 150px 150px 150px minmax(150px, 190px) 96px auto;
      gap: 10px;
      align-items: end;
      padding: 14px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel);
    }
    label {
      display: grid;
      gap: 5px;
      min-width: 0;
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
    }
    input, select, button {
      height: 36px;
      min-width: 0;
      border: 1px solid var(--line-strong);
      border-radius: 6px;
      background: #fff;
      color: var(--text);
      font: inherit;
      font-size: 14px;
      letter-spacing: 0;
    }
    input, select { padding: 0 10px; width: 100%; }
    button {
      padding: 0 14px;
      border-color: var(--accent);
      background: var(--accent);
      color: #fff;
      font-weight: 700;
      cursor: pointer;
      white-space: nowrap;
    }
    button:hover { background: var(--accent-dark); }
    button:disabled {
      cursor: progress;
      opacity: 0.72;
    }
    .quick {
      display: flex;
      gap: 6px;
      align-items: end;
      height: 36px;
    }
    .quick button {
      width: 42px;
      padding: 0;
      border-color: var(--line-strong);
      background: #fff;
      color: var(--text);
      font-size: 12px;
      font-weight: 700;
    }
    .quick button:hover { background: #eef3fa; }
    .custom-model { display: none; }
    .custom-model.visible { display: grid; }
    .meta {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      padding: 12px 2px;
      color: var(--muted);
      font-size: 13px;
    }
    .meta strong { color: var(--text); }
    .status-ok { color: var(--ok); }
    .status-bad { color: var(--bad); }
    .notice {
      margin: 0 0 12px;
      padding: 10px 12px;
      border: 1px solid var(--warn-line);
      border-radius: 6px;
      background: var(--warn-bg);
      color: #684b00;
      font-size: 14px;
    }
    .notice.bad {
      border-color: #efb5ae;
      background: #fff1ef;
      color: var(--bad);
    }
    .summary {
      display: grid;
      grid-template-columns: repeat(6, minmax(120px, 1fr));
      gap: 1px;
      margin-bottom: 14px;
      overflow: hidden;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--line);
    }
    .metric {
      min-height: 76px;
      padding: 12px;
      background: var(--panel);
    }
    .metric span {
      display: block;
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
    }
    .metric strong {
      display: block;
      margin-top: 8px;
      overflow-wrap: anywhere;
      font-size: 22px;
      line-height: 1.1;
      font-weight: 750;
    }
    .chart {
      margin-bottom: 14px;
      border: 1px solid var(--line);
      border-radius: 8px;
      overflow: hidden;
      background: var(--panel);
    }
    .chart-row {
      display: grid;
      grid-template-columns: 180px 1fr 120px;
      gap: 10px;
      align-items: center;
      padding: 9px 12px;
      border-bottom: 1px solid var(--line);
      font-size: 13px;
    }
    .chart-row:last-child { border-bottom: 0; }
    .bar-track {
      height: 10px;
      overflow: hidden;
      border-radius: 999px;
      background: #e8edf4;
    }
    .bar {
      height: 100%;
      min-width: 2px;
      background: linear-gradient(90deg, #1459b8, #2d7d56);
    }
    .table-wrap {
      overflow: auto;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel);
    }
    table {
      width: 100%;
      min-width: 1080px;
      border-collapse: collapse;
      table-layout: fixed;
    }
    th, td {
      padding: 10px 12px;
      border-bottom: 1px solid var(--line);
      vertical-align: top;
      text-align: right;
      font-size: 13px;
    }
    th {
      position: sticky;
      top: 0;
      z-index: 1;
      background: #f0f3f7;
      color: #3c4655;
      font-size: 12px;
      font-weight: 750;
    }
    th:first-child, td:first-child,
    th:nth-child(2), td:nth-child(2) {
      text-align: left;
    }
    tbody tr:hover { background: #f7fbff; }
    .period { width: 170px; }
    .model { width: 170px; }
    .number {
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
    }
    .muted { color: var(--muted); }
    .hidden { display: none; }
    @media (max-width: 1120px) {
      header {
        align-items: stretch;
        flex-direction: column;
      }
      .token {
        grid-template-columns: 1fr;
      }
      .toolbar {
        grid-template-columns: 1fr 1fr;
      }
      .summary {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
      main { padding: 12px; }
    }
  </style>
</head>
<body>
  <header>
    <h1>Billing Usage</h1>
    <label class="token">Billing token
      <input id="token" type="password" autocomplete="off" placeholder="Paste billing admin token">
    </label>
  </header>
  <main>
    <section class="toolbar">
      <label>Subject ID
        <input id="subjectId" autocomplete="off" placeholder="subj_...">
      </label>
      <label>From
        <input id="from" type="date">
      </label>
      <label>To
        <input id="to" type="date">
      </label>
      <label>Group
        <select id="groupBy">
          <option value="model">model</option>
          <option value="day">day</option>
          <option value="month">month</option>
          <option value="none">none</option>
        </select>
      </label>
      <label>Model
        <select id="model"></select>
      </label>
      <label id="customModelWrap" class="custom-model">Custom
        <input id="customModel" autocomplete="off" placeholder="model id">
      </label>
      <div class="quick" aria-label="range shortcuts">
        <button type="button" data-range="7">7d</button>
        <button type="button" data-range="30">30d</button>
        <button type="button" data-range="90">90d</button>
      </div>
      <button id="refresh" type="button">Refresh</button>
    </section>
    <div class="meta">
      <span>Status: <strong id="status">idle</strong></span>
      <span>Rows: <strong id="rowCount">0</strong></span>
      <span>Generated: <strong id="generated">-</strong></span>
    </div>
    <div class="notice" id="notice" hidden></div>
    <section class="summary" id="summary"></section>
    <section class="chart hidden" id="chart"></section>
    <section class="table-wrap">
      <table>
        <thead>
          <tr>
            <th class="period">Period</th>
            <th class="model">Model</th>
            <th>Requests</th>
            <th>Success</th>
            <th>Errors</th>
            <th>Prompt</th>
            <th>Completion</th>
            <th>Total</th>
            <th>Estimated</th>
          </tr>
        </thead>
        <tbody id="rows"></tbody>
      </table>
    </section>
  </main>
  <script>
    const knownModels = ${JSON.stringify(models)};
    const els = {
      token: document.getElementById("token"),
      subjectId: document.getElementById("subjectId"),
      from: document.getElementById("from"),
      to: document.getElementById("to"),
      groupBy: document.getElementById("groupBy"),
      model: document.getElementById("model"),
      customModelWrap: document.getElementById("customModelWrap"),
      customModel: document.getElementById("customModel"),
      refresh: document.getElementById("refresh"),
      status: document.getElementById("status"),
      rowCount: document.getElementById("rowCount"),
      generated: document.getElementById("generated"),
      notice: document.getElementById("notice"),
      summary: document.getElementById("summary"),
      chart: document.getElementById("chart"),
      rows: document.getElementById("rows")
    };
    const numberFormat = new Intl.NumberFormat();
    init();

    function init() {
      els.token.value = sessionStorage.getItem("gatewayBillingAdminToken") || "";
      els.subjectId.value = localStorage.getItem("gatewayBillingSubjectId") || "";
      els.token.addEventListener("input", () => sessionStorage.setItem("gatewayBillingAdminToken", els.token.value));
      els.subjectId.addEventListener("input", () => localStorage.setItem("gatewayBillingSubjectId", els.subjectId.value));
      initDates(30);
      renderModelOptions();
      els.model.addEventListener("change", () => {
        els.customModelWrap.classList.toggle("visible", els.model.value === "__custom__");
        if (els.model.value !== "__custom__") load();
      });
      els.customModel.addEventListener("keydown", (event) => {
        if (event.key === "Enter") load();
      });
      for (const button of document.querySelectorAll("[data-range]")) {
        button.addEventListener("click", () => {
          initDates(Number(button.getAttribute("data-range")));
          load();
        });
      }
      for (const control of [els.from, els.to, els.groupBy]) {
        control.addEventListener("change", () => load());
      }
      els.refresh.addEventListener("click", () => load());
      if (els.token.value && els.subjectId.value) {
        load();
      } else {
        renderEmpty();
      }
    }

    function renderModelOptions() {
      const options = [{ id: "", displayName: "All models" }, ...knownModels, { id: "__custom__", displayName: "Custom" }];
      els.model.innerHTML = options.map((model) =>
        "<option value=\\"" + escapeAttr(model.id) + "\\">" + escapeHtml(model.displayName + (model.id && model.id !== model.displayName ? " (" + model.id + ")" : "")) + "</option>"
      ).join("");
    }

    async function load() {
      const token = els.token.value.trim();
      const subjectId = els.subjectId.value.trim();
      if (!token) {
        setStatus("missing token", false);
        showNotice("Billing admin token required.", false);
        els.token.focus();
        renderEmpty();
        return;
      }
      if (!subjectId) {
        setStatus("missing subject", false);
        showNotice("Subject ID required.", false);
        els.subjectId.focus();
        renderEmpty();
        return;
      }
      const params = new URLSearchParams();
      params.set("subject_id", subjectId);
      params.set("from", dateInputToIso(els.from.value));
      params.set("to", dateInputToIso(els.to.value));
      params.set("group_by", els.groupBy.value);
      const model = selectedModelId();
      if (model) params.set("public_model_id", model);

      setStatus("loading", true);
      showNotice("", true);
      els.refresh.disabled = true;
      els.refresh.textContent = "Loading";
      try {
        const response = await fetch("/gateway/admin/billing/v1/usage?" + params.toString(), {
          headers: { authorization: "Bearer " + token },
          cache: "no-store"
        });
        const payload = await response.json();
        if (!response.ok) {
          throw new Error(payload.error && payload.error.message ? payload.error.message : "request failed");
        }
        renderUsage(payload);
        setStatus("ok", true);
      } catch (error) {
        setStatus(error.message || String(error), false);
        showNotice(error.message || String(error), false);
      } finally {
        els.refresh.disabled = false;
        els.refresh.textContent = "Refresh";
      }
    }

    function renderUsage(payload) {
      const rows = Array.isArray(payload.rows) ? payload.rows : [];
      els.rowCount.textContent = String(rows.length);
      els.generated.textContent = formatDateTime(new Date());
      renderSummary(rows);
      renderChart(rows, payload.group_by);
      els.rows.innerHTML = rows.length
        ? rows.map(renderRow).join("")
        : "<tr><td colspan=\\"9\\" class=\\"muted\\">No usage rows match the current filters.</td></tr>";
    }

    function renderSummary(rows) {
      const totals = rows.reduce((acc, row) => {
        acc.requests += num(row.request_count);
        acc.success += num(row.success_count);
        acc.errors += num(row.error_count);
        acc.prompt += num(row.prompt_tokens);
        acc.completion += num(row.completion_tokens);
        acc.total += num(row.total_tokens);
        acc.estimated += num(row.estimated_tokens);
        return acc;
      }, { requests: 0, success: 0, errors: 0, prompt: 0, completion: 0, total: 0, estimated: 0 });
      const metrics = [
        ["Requests", totals.requests],
        ["Success", totals.success],
        ["Errors", totals.errors],
        ["Prompt", totals.prompt],
        ["Completion", totals.completion],
        ["Total tokens", totals.total],
        ["Estimated", totals.estimated]
      ];
      els.summary.innerHTML = metrics.map(([label, value]) =>
        "<div class=\\"metric\\"><span>" + escapeHtml(label) + "</span><strong>" + formatNumber(value) + "</strong></div>"
      ).join("");
    }

    function renderChart(rows, groupBy) {
      if (!rows.length) {
        els.chart.classList.add("hidden");
        els.chart.innerHTML = "";
        return;
      }
      const max = Math.max(...rows.map((row) => num(row.total_tokens)), 1);
      els.chart.classList.remove("hidden");
      els.chart.innerHTML = rows.slice(0, 20).map((row) => {
        const value = num(row.total_tokens);
        const pct = Math.max(1, Math.round((value / max) * 100));
        const label = groupBy === "model"
          ? modelLabel(row)
          : periodLabel(row.period_start) + (row.public_model_id ? " / " + modelLabel(row) : "");
        return "<div class=\\"chart-row\\">" +
          "<div>" + escapeHtml(label) + "</div>" +
          "<div class=\\"bar-track\\"><div class=\\"bar\\" style=\\"width:" + pct + "%\\"></div></div>" +
          "<div class=\\"number\\">" + formatNumber(value) + "</div>" +
        "</div>";
      }).join("");
    }

    function renderRow(row) {
      return "<tr>" +
        "<td>" + escapeHtml(periodLabel(row.period_start)) + "</td>" +
        "<td>" + escapeHtml(modelLabel(row)) + "</td>" +
        numberCell(row.request_count) +
        numberCell(row.success_count) +
        numberCell(row.error_count) +
        numberCell(row.prompt_tokens) +
        numberCell(row.completion_tokens) +
        numberCell(row.total_tokens) +
        numberCell(row.estimated_tokens) +
      "</tr>";
    }

    function renderEmpty() {
      els.rowCount.textContent = "0";
      els.generated.textContent = "-";
      renderSummary([]);
      els.chart.classList.add("hidden");
      els.chart.innerHTML = "";
      els.rows.innerHTML = "<tr><td colspan=\\"9\\" class=\\"muted\\">No usage loaded.</td></tr>";
    }

    function numberCell(value) {
      return "<td class=\\"number\\">" + formatNumber(value) + "</td>";
    }

    function selectedModelId() {
      if (els.model.value === "__custom__") {
        return els.customModel.value.trim();
      }
      return els.model.value;
    }

    function initDates(days) {
      const to = new Date();
      to.setUTCDate(to.getUTCDate() + 1);
      const from = new Date(to);
      from.setUTCDate(from.getUTCDate() - days);
      els.from.value = toDateInput(from);
      els.to.value = toDateInput(to);
    }

    function toDateInput(date) {
      return date.toISOString().slice(0, 10);
    }

    function dateInputToIso(value) {
      return value + "T00:00:00.000Z";
    }

    function modelLabel(row) {
      if (row.model_display_name && row.public_model_id && row.model_display_name !== row.public_model_id) {
        return row.model_display_name + " (" + row.public_model_id + ")";
      }
      return row.public_model_id || "-";
    }

    function periodLabel(value) {
      return value ? value.slice(0, 10) : "Total";
    }

    function num(value) {
      return Number.isFinite(Number(value)) ? Number(value) : 0;
    }

    function formatNumber(value) {
      return numberFormat.format(num(value));
    }

    function formatDateTime(value) {
      return new Intl.DateTimeFormat(undefined, {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false
      }).format(value);
    }

    function setStatus(text, ok) {
      els.status.textContent = text;
      els.status.className = ok ? "status-ok" : "status-bad";
    }

    function showNotice(text, ok) {
      if (!text) {
        els.notice.hidden = true;
        els.notice.textContent = "";
        return;
      }
      els.notice.hidden = false;
      els.notice.className = ok ? "notice" : "notice bad";
      els.notice.textContent = text;
    }

    function escapeHtml(value) {
      return String(value).replace(/[&<>"']/g, (char) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        "\\"": "&quot;",
        "'": "&#39;"
      }[char]));
    }

    function escapeAttr(value) {
      return escapeHtml(value).replace(/\\n/g, " ");
    }
  </script>
</body>
</html>`;
}

function modelDisplayName(
  publicModelId: string | null | undefined,
  publicModels: BillingPublicModel[] | undefined
): string | null {
  if (!publicModelId) {
    return publicModelId ?? null;
  }
  const model = publicModels?.find((candidate) => candidate.id === publicModelId);
  return model?.displayName ?? publicModelId;
}

function resolveQuotaResetCredentials(
  store: AccessCredentialStore,
  subjectId: string,
  credentialPrefix: string | null,
  now: Date
): AccessCredentialRecord[] | GatewayError {
  if (credentialPrefix) {
    const credential = store.getAccessCredentialByPrefix(credentialPrefix);
    if (!credential || credential.subjectId !== subjectId || !isCredentialActive(credential, now)) {
      return credentialNotFound();
    }
    return [credential];
  }

  const credentials = store
    .listAccessCredentials({ subjectId, includeRevoked: false })
    .filter((credential) => isCredentialActive(credential, now));
  if (credentials.length === 0) {
    return credentialNotFound();
  }
  return credentials;
}

function resetRequestQuota(
  options: BillingAdminRouteOptions,
  credentials: AccessCredentialRecord[],
  windows: RateLimitResetWindow[]
) {
  if (windows.length === 0) {
    return {
      status: "skipped",
      reason: "no_request_windows",
      windows
    };
  }
  if (!options.credentialRateLimiter?.reset) {
    throw serviceUnavailable("Request quota reset is not configured.");
  }

  return {
    status: "reset",
    windows,
    credentials: credentials.map((credential) => ({
      credential_id: credential.id,
      credential_prefix: credential.prefix,
      reset: publicRateLimitResetResult(
        options.credentialRateLimiter!.reset!({
          credentialId: credential.id,
          windows
        })
      )
    }))
  };
}

async function resetTokenQuota(
  options: BillingAdminRouteOptions,
  credential: AccessCredentialRecord,
  windows: TokenWindowKind[],
  now: Date
) {
  if (windows.length === 0) {
    return {
      status: "skipped",
      reason: "no_token_windows",
      windows
    };
  }
  if (!options.tokenBudgetLimiter?.resetUsage) {
    throw serviceUnavailable("Token quota reset is not configured.");
  }

  const context = tokenResetContext(options, credential, now);
  if (!context) {
    return {
      status: "skipped",
      reason: "no_token_policy",
      windows
    };
  }

  const result = await options.tokenBudgetLimiter.resetUsage({
    subjectId: credential.subjectId,
    entitlementId: context.entitlementId,
    entitlementPeriodStart: context.entitlementPeriodStart,
    entitlementPeriodEnd: context.entitlementPeriodEnd,
    policy: context.policy,
    windows,
    now
  });
  return {
    status: "reset",
    source: result.before.source,
    entitlement_id: context.entitlementId,
    windows: result.windows,
    expired_reservations: result.expiredReservations,
    usage_before: publicTokenUsageSnapshot(result.before),
    usage_after: publicTokenUsageSnapshot(result.after)
  };
}

function tokenResetContext(
  options: BillingAdminRouteOptions,
  credential: AccessCredentialRecord,
  now: Date
): {
  entitlementId: string | null;
  entitlementPeriodStart: Date | null;
  entitlementPeriodEnd: Date | null;
  policy: TokenLimitPolicy;
} | null {
  const access = options.planEntitlementStore?.entitlementAccessForSubject(credential.subjectId, now);
  if (access?.status === "active") {
    return {
      entitlementId: access.entitlement.id,
      entitlementPeriodStart: access.entitlement.periodStart,
      entitlementPeriodEnd: access.entitlement.periodEnd,
      policy: mergeEntitlementTokenPolicy(
        access.entitlement.policySnapshot,
        credential.rate.token ?? null
      )
    };
  }
  if (credential.rate.token) {
    return {
      entitlementId: null,
      entitlementPeriodStart: null,
      entitlementPeriodEnd: null,
      policy: credential.rate.token
    };
  }
  return null;
}

function publicTokenUsageSnapshot(snapshot: TokenUsageSnapshot) {
  return {
    source: snapshot.source,
    minute: publicWindowSnapshot(snapshot.minute),
    day: publicWindowSnapshot(snapshot.day),
    month: publicWindowSnapshot(snapshot.month)
  };
}

function publicRateLimitResetResult(result: RateLimitResetResult) {
  return {
    found: result.found,
    windows: result.windows,
    before: result.before ? publicRateLimitResetSnapshot(result.before) : null,
    after: result.after ? publicRateLimitResetSnapshot(result.after) : null
  };
}

function publicRateLimitResetSnapshot(snapshot: RateLimitResetResult["before"]) {
  if (!snapshot) {
    return null;
  }
  return {
    minute_window: snapshot.minuteWindow,
    minute_count: snapshot.minuteCount,
    day_window: snapshot.dayWindow,
    day_count: snapshot.dayCount,
    active: snapshot.active
  };
}

function publicWindowSnapshot(snapshot: TokenUsageSnapshot["minute"]) {
  return {
    limit: snapshot.limit,
    used: snapshot.used,
    reserved: snapshot.reserved,
    remaining: snapshot.remaining,
    window_start: snapshot.windowStart,
    window_end: snapshot.windowEnd
  };
}

function recordBillingQuotaResetAudit(
  options: BillingAdminRouteOptions,
  parsed: {
    subjectId: string;
    credentialPrefix: string | null;
    requestWindows: RateLimitResetWindow[];
    tokenWindows: TokenWindowKind[];
    reason: string | null;
  },
  status: "ok" | "error",
  errorMessage: string | null,
  params: Record<string, unknown> | null = null
): void {
  if (!options.adminAuditStore) {
    return;
  }
  try {
    options.adminAuditStore.insertAdminAuditEvent({
      id: `audit_${randomUUID()}`,
      action: "quota-reset",
      targetUserId: parsed.subjectId,
      targetCredentialId: null,
      targetCredentialPrefix: parsed.credentialPrefix,
      status,
      params: params ?? {
        credential_prefix: parsed.credentialPrefix,
        request_windows: parsed.requestWindows,
        token_windows: parsed.tokenWindows,
        reason: parsed.reason
      },
      errorMessage,
      createdAt: billingNow(options)
    });
  } catch {
    // Do not fail the reset after quota state has already been changed.
  }
}

function isCredentialActive(credential: AccessCredentialRecord, now: Date): boolean {
  return !credential.revokedAt && credential.expiresAt.getTime() > now.getTime();
}

function billingNow(options: BillingAdminRouteOptions): Date {
  return options.now?.() ?? new Date();
}

function publicCreateSubjectResult(result: CreateBillingSubjectResult, key: string | null) {
  const visibleCredential = result.unifiedClientKey;
  return {
    created: result.created,
    idempotent_replay: result.idempotentReplay,
    ...publicSubjectDetails(result),
    credential: {
      id: visibleCredential.id,
      ...(key ? { key } : {}),
      key_prefix: `cgu_live_${visibleCredential.prefix}`,
      issued_at: visibleCredential.createdAt.toISOString(),
      expires_at: visibleCredential.expiresAt.toISOString(),
      state: visibleCredential.revokedAt ? "revoked" : "active"
    }
  };
}

function publicRotateSubjectResult(result: RotateBillingSubjectResult, key: string | null) {
  const visibleCredential = result.unifiedClientKey;
  return {
    rotated: result.rotated,
    idempotent_replay: result.idempotentReplay,
    ...publicSubjectDetails(result),
    credential: {
      id: visibleCredential.id,
      ...(key ? { key } : {}),
      key_prefix: `cgu_live_${visibleCredential.prefix}`,
      issued_at: visibleCredential.createdAt.toISOString(),
      expires_at: visibleCredential.expiresAt.toISOString(),
      state: visibleCredential.revokedAt ? "revoked" : "active"
    },
    revoked_credential_ids: result.revokedCredentialIds,
    revoked_unified_key_ids: result.revokedUnifiedKeyIds
  };
}

function publicDisableSubjectResult(result: DisableBillingSubjectResult) {
  return {
    disabled: result.disabled,
    idempotent_replay: result.idempotentReplay,
    ...publicSubjectDetails(result),
    revoked_credential_ids: result.revokedCredentialIds,
    revoked_unified_key_ids: result.revokedUnifiedKeyIds,
    cancelled_entitlement_ids: result.cancelledEntitlementIds
  };
}

function publicSubjectDetails(details: BillingSubjectDetails) {
  return {
    subject: {
      id: details.subject.id,
      provider: details.subject.externalProvider,
      external_user_id: details.subject.externalUserId,
      display_name: details.subject.displayName,
      scope_allowlist: details.scopeAllowlist,
      state: details.subject.state,
      created_at: details.subject.createdAt.toISOString()
    },
    credentials: details.credentials.map((credential) => ({
      id: credential.id,
      key_prefix: credential.keyPrefix,
      issued_at: credential.issuedAt.toISOString(),
      expires_at: credential.expiresAt?.toISOString() ?? null,
      state: credential.state
    }))
  };
}

function publicTokenPolicy(policy: TokenLimitPolicy) {
  return {
    tokens_per_minute: policy.tokensPerMinute,
    tokens_per_day: policy.tokensPerDay,
    tokens_per_month: policy.tokensPerMonth,
    max_prompt_tokens_per_request: policy.maxPromptTokensPerRequest,
    max_total_tokens_per_request: policy.maxTotalTokensPerRequest
  };
}

function billingSecurityHeaders(reply: FastifyReply): FastifyReply {
  return reply
    .header("cache-control", "no-store")
    .header("x-robots-tag", "noindex, nofollow")
    .header("x-content-type-options", "nosniff");
}

function billingPageSecurityHeaders(reply: FastifyReply): FastifyReply {
  return billingSecurityHeaders(reply).header(
    "content-security-policy",
    [
      "default-src 'none'",
      "style-src 'unsafe-inline'",
      "script-src 'unsafe-inline'",
      "connect-src 'self'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'"
    ].join("; ")
  );
}

function sendBillingError(
  request: FastifyRequest,
  reply: FastifyReply,
  error: GatewayError
): FastifyReply {
  return billingSecurityHeaders(reply).code(error.httpStatus).send({
    error: {
      code: error.code,
      message: error.message,
      request_id: request.id,
      ...(error.retryAfterSeconds ? { retry_after_seconds: error.retryAfterSeconds } : {})
    }
  });
}

function toBillingGatewayError(err: unknown): GatewayError {
  if (err instanceof GatewayError) {
    return err;
  }
  return serviceUnavailable("Billing admin request failed.");
}

function serviceUnavailable(message: string): GatewayError {
  return new GatewayError({
    code: "service_unavailable",
    message,
    httpStatus: 503
  });
}

function subjectNotFound(): GatewayError {
  return new GatewayError({
    code: "subject_not_found",
    message: "Subject does not exist.",
    httpStatus: 404
  });
}

function credentialNotFound(): GatewayError {
  return new GatewayError({
    code: "credential_not_found",
    message: "Active credential does not exist for subject.",
    httpStatus: 404
  });
}

function invalidRequest(message: string): GatewayError {
  return new GatewayError({
    code: "invalid_request",
    message,
    httpStatus: 400
  });
}

function objectBody(body: unknown): Record<string, unknown> | GatewayError {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return invalidRequest("JSON body must be an object.");
  }
  return body as Record<string, unknown>;
}

function requiredString(value: unknown, name: string): string | GatewayError {
  const normalized = optionalString(value);
  return normalized ?? invalidRequest(`${name} is required.`);
}

function optionalString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function optionalPeriodKind(value: unknown): PeriodKind | null | GatewayError {
  if (value === undefined || value === null) {
    return null;
  }
  if (value === "monthly" || value === "one_off" || value === "unlimited") {
    return value;
  }
  return new GatewayError({
    code: "invalid_period",
    message: "period_kind must be monthly, one_off, or unlimited.",
    httpStatus: 400
  });
}

function requiredOffsetDate(value: unknown, name: string): Date | GatewayError {
  return optionalOffsetDate(value, name) ?? invalidRequest(`${name} is required.`);
}

function optionalOffsetDate(value: unknown, name: string): Date | null | GatewayError {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string" || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) {
    return new GatewayError({
      code: "invalid_period",
      message: `${name} must be an RFC 3339 timestamp with an explicit offset.`,
      httpStatus: 400
    });
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return new GatewayError({
      code: "invalid_period",
      message: `${name} is not a valid timestamp.`,
      httpStatus: 400
    });
  }
  return parsed;
}

function optionalInteger(value: unknown, name: string): number | null | GatewayError {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    return invalidRequest(`${name} must be an integer.`);
  }
  return value;
}

function optionalCurrency(value: unknown): string | null {
  const currency = optionalString(value);
  return currency ? currency.toUpperCase() : null;
}

function optionalMetadata(value: unknown): Record<string, unknown> | null | GatewayError {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    return invalidRequest("metadata must be an object.");
  }
  const json = JSON.stringify(value);
  if (json.length > 4_096) {
    return invalidRequest("metadata is too large.");
  }
  const sensitivePath = findSensitiveMetadataPath(value, []);
  if (sensitivePath) {
    return invalidRequest(`metadata contains sensitive field: ${sensitivePath}`);
  }
  return value as Record<string, unknown>;
}

function findSensitiveMetadataPath(value: unknown, path: string[]): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findSensitiveMetadataPath(value[index], [...path, String(index)]);
      if (found) {
        return found;
      }
    }
    return null;
  }
  for (const [key, child] of Object.entries(value)) {
    if (isSensitiveMetadataKey(key)) {
      return [...path, key].join(".");
    }
    const found = findSensitiveMetadataPath(child, [...path, key]);
    if (found) {
      return found;
    }
  }
  return null;
}

function isSensitiveMetadataKey(key: string): boolean {
  return /card|cvv|cvc|pan|email|phone|billing.*address|address|invoice|account/i.test(key);
}

function parseLimit(value: string | undefined, fallback: number): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 200) {
    throw invalidRequest("limit must be between 1 and 200.");
  }
  return parsed || fallback;
}

function headerString(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }
  return value ?? null;
}

function safeEqual(received: string, expected: string): boolean {
  const receivedBuffer = Buffer.from(received);
  const expectedBuffer = Buffer.from(expected);
  if (receivedBuffer.length !== expectedBuffer.length) {
    return false;
  }
  return timingSafeEqual(receivedBuffer, expectedBuffer);
}

function deterministicBillingSubjectId(provider: string, externalUserId: string): string {
  return `subj_${createHash("sha256")
    .update(`${provider}:${externalUserId}`, "utf8")
    .digest("base64url")
    .slice(0, 24)}`;
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60_000);
}
