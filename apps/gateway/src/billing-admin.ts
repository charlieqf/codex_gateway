import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
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
  type RateLimitPolicy,
  type Scope,
  type TokenLimitPolicy,
  verifyBillingAdminToken
} from "@codex-gateway/core";
import type { CredentialRateLimiter } from "./services/rate-limiter.js";
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
  rateLimiter?: CredentialRateLimiter;
  ratePolicy?: RateLimitPolicy;
  upstreamV2Client?: UpstreamV2Client | null;
  apiKeyEncryptionSecret?: string | null;
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

        const now = new Date();
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

        const now = new Date();
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
        return billingSecurityHeaders(reply).send(
          publicUsageResult(options.billingStore.reportBillingUsage(parsed))
        );
      } catch (err) {
        return sendBillingError(request, reply, toBillingGatewayError(err));
      }
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
      const now = new Date();
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
  if (groupBy !== "day" && groupBy !== "month" && groupBy !== "none") {
    return invalidRequest("group_by must be day, month, or none.");
  }
  return {
    subjectId,
    from,
    to,
    groupBy,
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

function publicUsageResult(result: BillingUsageReportResult) {
  return {
    subject_id: result.subjectId,
    from: result.from.toISOString(),
    to: result.to.toISOString(),
    group_by: result.groupBy,
    rows: result.rows.map((row) => ({
      period_start: row.periodStart?.toISOString() ?? null,
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
