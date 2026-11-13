import { createHash, randomUUID } from "node:crypto";
import { Transform } from "node:stream";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { GatewayError, type AdminAuditStore, type ObservationStore, type PhoneAuthStore } from "@codex-gateway/core";
import type { SqliteClientEventsStore, SqliteGatewayStore } from "@codex-gateway/store-sqlite";
import { adminMessagesSecurityHeaders, authenticateAdminMessagesRequest, type AdminMessagesAccess } from "./admin-client-messages.js";
import { ClientSupportStore, SupportStorageFull, supportDetailsRetentionMs, supportSummaryRetentionMs, type SupportRow } from "./client-support-store.js";
import { canonicalSupportJson, parseSupportReport, supportAutomaticBytes, supportHash, supportManualBytes, supportUuidPattern, type SupportReport } from "./client-support.js";
import { renderClientSupportPage } from "./client-support-page.js";
import type { PhoneAuthService } from "./services/phone-auth-service.js";
import { InMemoryRequestRateLimiter } from "./services/rate-limiter.js";

const config = { public: true, skipRateLimit: true, skipObservation: true };
const uuid = new RegExp(supportUuidPattern);
const messages: Record<string, string> = {
  invalid_request: "Invalid support report.", access_token_invalid: "Invalid access token.", access_token_expired: "Access token expired.",
  support_identity_mismatch: "Report account does not match the access token.", support_report_too_large: "Support report is too large.",
  rate_limited: "Support traffic is limited. Retry after the indicated delay.", service_unavailable: "Support reporting is temporarily unavailable.",
  idempotency_conflict: "Report ID already exists with different content.", support_report_expired: "Support report or diagnostics have expired.",
  unauthorized: "Admin messages token is required.", not_found: "Not found."
};
function error(request: FastifyRequest, reply: FastifyReply, status: number, code: string) {
  return reply.code(status).send({ error: { code, message: messages[code], request_id: request.id } });
}

export function registerClientSupportRoutes(app: FastifyInstance, options: {
  store: ClientSupportStore;
  clientEvents: SqliteClientEventsStore;
  gatewayStore?: SqliteGatewayStore;
  phoneAuth?: PhoneAuthService;
  phoneStore?: PhoneAuthStore;
  observationStore?: ObservationStore;
  adminAuditStore?: AdminAuditStore;
  access: AdminMessagesAccess | null;
  now: () => Date;
}) {
  const { store, now } = options;
  const limiter = new InMemoryRequestRateLimiter({ now });
  const subjects = new WeakMap<FastifyRequest, string>();
  const bodySizes = new WeakMap<FastifyRequest, { bytes: number }>();
  const sweep = () => {
    try { store.prune(now().getTime()); }
    catch { app.log.error("Client support retention cleanup failed."); }
  };
  sweep();
  const timer = setInterval(sweep, 3_600_000);
  timer.unref();
  app.addHook("onClose", async () => clearInterval(timer));

  function permit(request: FastifyRequest, reply: FastifyReply, key: string, requestsPerMinute: number, requestsPerDay: number, concurrentRequests: number) {
    const result = limiter.acquire({ key, scope: "subject", policy: { requestsPerMinute, requestsPerDay, concurrentRequests } });
    if (!("release" in result)) {
      reply.header("retry-after", String(result.error.retryAfterSeconds ?? 1));
      error(request, reply, 429, "rate_limited");
      return false;
    }
    reply.raw.once("close", result.release);
    reply.raw.once("finish", result.release);
    return true;
  }

  app.post("/gateway/client-events/support", {
    config, bodyLimit: supportManualBytes,
    preParsing: async (request, _reply, payload) => {
      const size = { bytes: 0 };
      bodySizes.set(request, size);
      const counter = new Transform({ transform(chunk, _encoding, done) {
        size.bytes += chunk.length;
        counter.receivedEncodedLength = size.bytes;
        done(null, chunk);
      } }) as Transform & { receivedEncodedLength: number };
      counter.receivedEncodedLength = 0;
      payload.on("error", cause => counter.destroy(cause));
      return payload.pipe(counter);
    },
    onRequest: async (request, reply) => {
      reply.header("cache-control", "no-store");
      if (!permit(request, reply, "submit:global", 300, 10_000, 8) ||
          !permit(request, reply, `submit:ip:${request.ip}`, 30, 500, 2)) return reply;
      const header = request.headers.authorization;
      if (header === undefined) return;
      const token = /^Bearer ([^\s]+)$/i.exec(header)?.[1];
      if (!token) return error(request, reply, 401, "access_token_invalid");
      if (!options.phoneAuth) return error(request, reply, 503, "service_unavailable");
      try {
        const { subjectId } = options.phoneAuth.authenticateAccessToken(token);
        if (!permit(request, reply, `submit:subject:${subjectId}`, 30, 300, 2)) return reply;
        subjects.set(request, subjectId);
      } catch (cause) {
        if (cause instanceof GatewayError && cause.httpStatus === 401)
          return error(request, reply, 401, cause.code === "access_token_expired" ? cause.code : "access_token_invalid");
        return error(request, reply, 503, "service_unavailable");
      }
    },
    errorHandler: (cause, request, reply) => {
      if (cause.statusCode === 413) return error(request, reply, 413, "support_report_too_large");
      if (cause.statusCode === 400 || cause.statusCode === 415) return error(request, reply, 400, "invalid_request");
      app.log.error({ request_id: request.id, reason: cause instanceof SupportStorageFull ? "capacity" : "storage" }, "Client support persistence failed.");
      return error(request, reply, 503, "service_unavailable");
    }
  }, async (request, reply) => {
    const report = parseSupportReport(request.body);
    if (!report) return error(request, reply, 400, "invalid_request");
    if (report.kind === "automatic" && (bodySizes.get(request)?.bytes ?? 0) > supportAutomaticBytes)
      return error(request, reply, 413, "support_report_too_large");
    const existing = store.get(report.report_id);
    const subject = subjects.get(request) ?? null;
    if (existing) {
      if (existing.content_hash !== supportHash(canonicalSupportJson(report))) return error(request, reply, 409, "idempotency_conflict");
      if (existing.received_at + (existing.has_diagnostics ? supportDetailsRetentionMs : supportSummaryRetentionMs) <= now().getTime())
        return error(request, reply, 410, "support_report_expired");
    } else if (subject && subject !== report.account_subject_id) {
      return error(request, reply, 403, "support_identity_mismatch");
    }
    const saved = store.save(report, subject, now().getTime());
    return reply.code(existing ? 200 : 201).send({ report_id: saved.report_id, stored: true, duplicate: Boolean(existing), received_at: new Date(saved.received_at).toISOString() });
  });

  function admin(request: FastifyRequest, reply: FastifyReply): boolean {
    adminMessagesSecurityHeaders(reply);
    if (options.access?.mode !== "token" || !options.access.token || !options.adminAuditStore) {
      error(request, reply, 404, "not_found"); return false;
    }
    if (!authenticateAdminMessagesRequest(request, options.access.token)) {
      error(request, reply, 401, "unauthorized"); return false;
    }
    return permit(request, reply, "admin:support", 120, 10_000, 4);
  }
  function audit(action: "client-support-query" | "client-support-download", params: Record<string, unknown>) {
    options.adminAuditStore!.insertAdminAuditEvent({
      id: randomUUID(), action, targetUserId: null, targetCredentialId: null, targetCredentialPrefix: null,
      status: "ok", errorMessage: null, createdAt: now(), params: {
        ...params, actor: createHash("sha256").update(options.access!.token!).digest("hex").slice(0, 16)
      }
    });
  }
  const adminOptions = {
    config, bodyLimit: 4096,
    onRequest: async (request: FastifyRequest, reply: FastifyReply) => { if (!admin(request, reply)) return reply; },
    errorHandler: (cause: Error & { statusCode?: number }, request: FastifyRequest, reply: FastifyReply) => {
      const status = cause instanceof GatewayError ? cause.httpStatus : cause.statusCode;
      if (status && status >= 400 && status < 500) return error(request, reply, 400, "invalid_request");
      app.log.error({ request_id: request.id }, "Client support admin request failed.");
      return error(request, reply, 503, "service_unavailable");
    }
  };

  app.get("/gateway/admin/client-support", { config }, async (request, reply) => {
    adminMessagesSecurityHeaders(reply);
    if (options.access?.mode !== "token" || !options.adminAuditStore) return error(request, reply, 404, "not_found");
    return reply.type("text/html; charset=utf-8").send(renderClientSupportPage());
  });

  app.post("/gateway/admin/client-support/query", adminOptions, async (request, reply) => {
    const query = request.body as Record<string, unknown>;
    if (!query || typeof query !== "object" || Array.isArray(query) ||
        Object.keys(query).some(key => !["phone", "subject_id", "report_id", "failure_id", "since", "until", "limit"].includes(key)))
      return error(request, reply, 400, "invalid_request");
    for (const key of ["report_id", "failure_id"]) if (query[key] !== undefined && (typeof query[key] !== "string" || !uuid.test(query[key])))
      return error(request, reply, 400, "invalid_request");
    if (query.subject_id !== undefined && (typeof query.subject_id !== "string" || !/^subj_[A-Za-z0-9_-]{1,80}$/.test(query.subject_id)))
      return error(request, reply, 400, "invalid_request");
    const since = query.since === undefined ? now().getTime() - (query.report_id || query.failure_id ? supportSummaryRetentionMs : 86_400_000) : typeof query.since === "string" ? Date.parse(query.since) : NaN;
    const until = query.until === undefined ? now().getTime() : typeof query.until === "string" ? Date.parse(query.until) : NaN;
    const limit = query.limit ?? 50;
    if (!Number.isFinite(since) || !Number.isFinite(until) || since > until || typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 100)
      return error(request, reply, 400, "invalid_request");
    let subjectId = query.subject_id as string | undefined;
    if (query.phone !== undefined) {
      if (typeof query.phone !== "string" || query.phone.length > 32 || query.subject_id !== undefined) return error(request, reply, 400, "invalid_request");
      if (!options.phoneAuth || !options.phoneStore) return error(request, reply, 503, "service_unavailable");
      subjectId = options.phoneStore.getPhoneAuthIdentityByPhoneHash(options.phoneAuth.phoneHash(query.phone))?.subjectId;
      if (!subjectId) { audit("client-support-query", { phone_lookup: true, matched: 0 }); return { reports: [] }; }
    }
    const rows = store.list({ since: Math.max(since, now().getTime() - supportSummaryRetentionMs + 1), until, limit, subjectId, reportId: query.report_id as string | undefined, failureId: query.failure_id as string | undefined });
    audit("client-support-query", { subject_id: subjectId ?? null, report_id: query.report_id ?? null, failure_id: query.failure_id ?? null, since, until, matched: rows.length });
    return { reports: rows.map(row => ({
      ...JSON.parse(row.summary_json), subject_id: row.subject_id, identity: row.subject_id ? "verified" : "anonymous",
      received_at: new Date(row.received_at).toISOString(),
      diagnostics_available: Boolean(row.has_diagnostics && row.received_at + supportDetailsRetentionMs > now().getTime()),
      ...(query.report_id ? { correlation: correlate(row) } : {})
    })) };
  });

  app.get<{ Params: { id: string } }>("/gateway/admin/client-support/:id/diagnostics", adminOptions, async (request, reply) => {
    if (!uuid.test(request.params.id)) return error(request, reply, 400, "invalid_request");
    const row = store.get(request.params.id);
    if (!row) return error(request, reply, 404, "not_found");
    if (row.received_at + supportSummaryRetentionMs <= now().getTime() || !row.has_diagnostics || row.received_at + supportDetailsRetentionMs <= now().getTime())
      return error(request, reply, 410, "support_report_expired");
    const json = store.readDetails(row, now().getTime());
    if (json === null) return error(request, reply, 503, "service_unavailable");
    audit("client-support-download", { report_id: row.report_id, subject_id: row.subject_id });
    return reply.header("content-disposition", `attachment; filename="support-${row.report_id}.json"`).type("application/json; charset=utf-8").send(json);
  });

  function correlate(row: SupportRow) {
    if (!row.subject_id) return { status: "anonymous", requests: [], diagnostics: [], model_call: null };
    const report = JSON.parse(row.summary_json) as SupportReport;
    const from = new Date(Date.parse(report.occurred_at) - 600_000);
    const until = new Date(Date.parse(report.occurred_at) + 600_000);
    const call = report.model_call_id ? options.gatewayStore?.database.prepare(
      "SELECT id, request_id, state, expires_at FROM model_calls WHERE subject_id = ? AND scope = 'code' AND id = ?"
    ).get(row.subject_id, report.model_call_id) : undefined;
    const requestId = report.request_id ?? (call?.request_id as string | undefined);
    const requests = (requestId || report.message_id || report.turn_code) ? options.observationStore?.listRequestEvents({
      subjectId: row.subject_id, requestId, ...(report.message_id && !requestId ? { clientMessageIds: [report.message_id] } : {}),
      ...(!requestId && !report.message_id ? { turnCode: report.turn_code } : {}), since: from, until, limit: 50
    }).filter(item => item.scope === "code").map(item => ({ request_id: item.requestId, started_at: item.startedAt, status: item.status, error_code: item.errorCode, duration_ms: item.durationMs })) ?? [] : [];
    const diagnostics = report.session_id ? options.clientEvents.database.prepare(
      `SELECT event_id, created_at, category, action, status, duration_ms, http_status FROM client_diagnostic_events
       WHERE subject_id = ? AND scope = 'code' AND session_id = ? AND created_at >= ? AND created_at <= ? ORDER BY created_at LIMIT 50`
    ).all(row.subject_id, report.session_id, from.toISOString(), until.toISOString()) : [];
    return { status: requests.length || call ? "matched" : "unlinked", requests, diagnostics, model_call: call ?? null };
  }
}
