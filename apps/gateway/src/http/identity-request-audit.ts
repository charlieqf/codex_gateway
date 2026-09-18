import {
  GatewayError, normalizeMainlandChinaPhone,
  type IdentityAuditFacts, type IdentityAuditOperation, type IdentityRequestAuditStore,
  type IdentityRequestEvent, type IdentityPhoneCaptureStatus
} from "@codex-gateway/core";
import type { FastifyInstance, FastifyRequest } from "fastify";

export interface IdentityRequestAuditContext extends IdentityAuditFacts {
  operation: IdentityAuditOperation;
  startedAt: Date;
  startedMonotonic: number;
  completed: boolean;
  phoneInput: string | null;
  phoneNormalized: string | null;
  phoneCaptureStatus: IdentityPhoneCaptureStatus;
  provider: string | null;
  externalUserId: string | null;
  targetSubjectId: string | null;
  limitDimension?: "phone" | "ip" | "device";
}

function safeText(value: unknown, maximum: number): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= maximum &&
    !/[\u0000-\u001f\u007f]/u.test(value) && !/(?:cgu_live_|rft_|Bearer |eyJ)/u.test(value) ? value : null;
}
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

/** Called only once a route is allowed to inspect parsed input (after Billing auth). */
export function captureIdentityInput(request: FastifyRequest): void {
  const audit = request.gatewayIdentityAudit;
  if (!audit || audit.completed) return;
  const body = record(request.body);
  const query = record(request.query);
  const params = record(request.params);
  audit.stage = "validation";
  if (!("phone" in body)) audit.phoneCaptureStatus = "absent";
  else if (typeof body.phone !== "string") audit.phoneCaptureStatus = "invalid_type";
  else {
    // Preserve phone formatting, not arbitrary text (a phone field can carry secrets too).
    audit.phoneInput = safeText(body.phone, 64);
    if (audit.phoneInput && !/^[+()\d -]+$/u.test(audit.phoneInput)) audit.phoneInput = null;
    audit.phoneCaptureStatus = audit.phoneInput === null ? "unsafe_value" : "captured";
    audit.phoneNormalized = audit.phoneInput === null ? null : normalizeMainlandChinaPhone(audit.phoneInput);
  }
  audit.provider = safeText(body.provider ?? query.provider ?? params.provider, 128);
  audit.externalUserId = safeText(body.external_user_id ?? query.external_user_id ?? params.externalUserId, 256);
  audit.targetSubjectId = safeText(params.subjectId ?? body.subject_id, 128);
}

export function markIdentityFacts(request: FastifyRequest, facts: IdentityAuditFacts): void {
  const audit = request.gatewayIdentityAudit;
  if (!audit || audit.completed) return;
  // Explicit mapping: never copy a result/exception object that might contain keys.
  if (facts.subjectId !== undefined) audit.subjectId = safeText(facts.subjectId, 128);
  if (facts.conflictingSubjectId !== undefined) audit.conflictingSubjectId = safeText(facts.conflictingSubjectId, 128);
  if (facts.resolvedPhone !== undefined) audit.resolvedPhone = normalizeMainlandChinaPhone(facts.resolvedPhone ?? "");
  if (facts.sessionId !== undefined) audit.sessionId = safeText(facts.sessionId, 128);
  if (facts.jobId !== undefined) audit.jobId = safeText(facts.jobId, 128);
  if (facts.stage !== undefined) audit.stage = facts.stage;
  if (facts.reasonCode !== undefined) audit.reasonCode = facts.reasonCode;
}

export function installIdentityRequestAudit(
  app: FastifyInstance,
  store: IdentityRequestAuditStore | null | undefined,
  now: () => Date = () => new Date()
): { complete(request: FastifyRequest, status: number | null): void } {
  let lost = 0;
  let lastFailureLog = -Infinity;
  const failure = (request?: FastifyRequest, maintenance = false) => {
    lost += maintenance ? 0 : 1;
    const timestamp = now().getTime();
    if (timestamp - lastFailureLog >= 60_000) {
      lastFailureLog = timestamp;
      app.log.error({ event: maintenance ? "identity_request_audit_prune_failed" : "identity_request_audit_write_failed",
        request_id: request?.id, operation: request?.gatewayIdentityAudit?.operation,
        lost_requests_since_recovery: lost }, "Identity audit storage failed; coverage may be incomplete.");
    }
  };
  const complete = (request: FastifyRequest, status: number | null) => {
    const audit = request.gatewayIdentityAudit;
    if (!store || !audit || audit.completed) return;
    audit.completed = true;
    const completedAt = now().toISOString();
    try {
      if (status === 429 && audit.operation === "phone_login" && audit.limitDimension &&
          request.gatewayRateLimited && request.gatewayRateLimitOrigin === "gateway" &&
          request.gatewayLimitKind === "request_minute" && request.gatewayErrorCode === "auth_rate_limited") {
        store.recordIdentityRateLimit({ operation: audit.operation, limitDimension: audit.limitDimension,
          limitKind: "request_minute", origin: "gateway", errorCode: "auth_rate_limited", completedAt,
          requestId: request.id, phoneInput: audit.phoneInput, phoneNormalized: audit.phoneNormalized });
      } else {
        const outcome: IdentityRequestEvent["outcome"] = status === null ? "aborted" : status >= 500 ? "failed"
          : status >= 400 ? "rejected" : status === 202 ? "accepted" : "succeeded";
        const errorCode = status === null ? "client_aborted" : safeText(request.gatewayErrorCode, 96);
        store.recordIdentityRequestEvent({
          requestId: request.id, operation: audit.operation, method: request.method,
          routeTemplate: request.routeOptions.url ?? "", startedAt: audit.startedAt.toISOString(), completedAt,
          durationMs: Math.max(0, performance.now() - audit.startedMonotonic), httpStatus: status,
          transportOutcome: status === null ? "aborted" : "responded", outcome, errorCode,
          reasonCode: audit.reasonCode ?? errorCode ?? (status !== null && status >= 400 ? "unclassified" : null),
          stage: audit.stage ?? null, phoneInput: audit.phoneInput, phoneNormalized: audit.phoneNormalized,
          phoneCaptureStatus: audit.phoneCaptureStatus, provider: audit.provider, externalUserId: audit.externalUserId,
          targetSubjectId: audit.targetSubjectId, subjectId: audit.subjectId ?? null,
          conflictingSubjectId: audit.conflictingSubjectId ?? null, resolvedPhone: audit.resolvedPhone ?? null,
          sessionId: audit.sessionId ?? null, jobId: audit.jobId ?? null,
          clientVersion: safeText(request.headers["x-medevidence-client-version"], 64)
        });
      }
      if (lost > 0) {
        app.log.warn({ event: "identity_request_audit_recovered", lost_requests: lost }, "Identity audit recording recovered; missing events were not reconstructed.");
        lost = 0;
        lastFailureLog = -Infinity;
      }
    } catch {
      failure(request);
    }
  };
  app.addHook("onRequest", async request => {
    const operation = request.routeOptions.config.identityAuditOperation;
    if (!store || !operation) return;
    request.gatewayIdentityAudit = { operation, startedAt: now(), startedMonotonic: performance.now(),
      completed: false, stage: "preflight", phoneInput: null, phoneNormalized: null,
      phoneCaptureStatus: "not_available", provider: null, externalUserId: null, targetSubjectId: null };
  });
  app.addHook("onError", async (request, _reply, error) => {
    if (!request.gatewayIdentityAudit) return;
    if (error instanceof GatewayError) {
      request.gatewayErrorCode = error.code;
      if (error.identityFailure) markIdentityFacts(request, error.identityFailure);
    } else if (typeof error.code === "string") {
      request.gatewayErrorCode = safeText(error.code, 96) ?? undefined;
    }
  });
  app.addHook("onResponse", async (request, reply) => complete(request, reply.statusCode));
  // Bounded maintenance, never on the login hot path. At most 500 rows/table/minute.
  const timer = store ? setInterval(() => {
    try { store.pruneIdentityRequestAudit(now()); } catch { failure(undefined, true); }
  }, 60_000) : null;
  timer?.unref();
  app.addHook("onClose", async () => { if (timer) clearInterval(timer); });
  return { complete };
}
