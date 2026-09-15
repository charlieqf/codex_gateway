import { type FastifyRequest } from "fastify";
import {
  type ClientDiagnosticEventRecord,
  type ClientMessageEventStore,
  type LimitRejection,
  type RateLimitPolicy
} from "@codex-gateway/core";
import {
  type ParsedClientDiagnosticEventRequest,
  type ParsedClientMessageEventRequest
} from "../client-events.js";
import { parsePositiveIntegerEnv } from "../runtime/env.js";

export function clientEventsRateLimitKey(
  credentialId: string,
  eventFamily: "messages" | "diagnostics"
): string {
  return `${credentialId}:${eventFamily}`;
}

export function logClientEventRateLimitRejection(input: {
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

export function linkClientDiagnosticEvent(
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

export function relinkExistingClientDiagnosticEvent(
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

export function backfillClientDiagnosticsForMessage(
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

export function clientDiagnosticEventsMatch(
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

export function resolveClientEventsRatePolicy(env: NodeJS.ProcessEnv): RateLimitPolicy {
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

export function resolveBillingAdminRatePolicy(env: NodeJS.ProcessEnv): RateLimitPolicy {
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
