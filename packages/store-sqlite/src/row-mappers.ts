import {
  validatePlanPolicy,
  type AccessCredentialRecord,
  type AdminAuditEventRecord,
  type ClientDiagnosticEventRecord,
  type ClientMessageEventRecord,
  type Entitlement,
  type EntitlementState,
  type GatewaySession,
  type PeriodKind,
  type Plan,
  type PlanState,
  type RateLimitPolicy,
  type RequestEventRecord,
  type RequestUsageReportRow,
  type Subject,
  type TokenLimitPolicy
} from "@codex-gateway/core";
import { parseScopeAllowlist } from "./entitlement-rules.js";

export function rowToSession(row: unknown): GatewaySession {
  const value = row as {
    id: string;
    subject_id: string;
    upstream_account_id: string;
    provider_session_ref: string | null;
    title: string | null;
    state: GatewaySession["state"];
    created_at: string;
    updated_at: string;
  };

  return {
    id: value.id,
    subjectId: value.subject_id,
    upstreamAccountId: value.upstream_account_id,
    providerSessionRef: value.provider_session_ref,
    title: value.title,
    state: value.state,
    createdAt: new Date(value.created_at),
    updatedAt: new Date(value.updated_at)
  };
}

export function rowToSubject(row: unknown): Subject {
  const value = row as {
    id: string;
    label: string;
    name: string | null;
    phone_number: string | null;
    state: Subject["state"];
    created_at: string;
  };

  return {
    id: value.id,
    label: value.label,
    name: value.name,
    phoneNumber: value.phone_number,
    state: value.state,
    createdAt: new Date(value.created_at)
  };
}

export function rowToAccessCredential(row: unknown): AccessCredentialRecord {
  const value = row as {
    id: string;
    prefix: string;
    hash: string;
    token_ciphertext: string | null;
    subject_id: string;
    label: string;
    scope: AccessCredentialRecord["scope"];
    expires_at: string;
    revoked_at: string | null;
    rate_json: string;
    created_at: string;
    rotates_id: string | null;
  };

  return {
    id: value.id,
    prefix: value.prefix,
    hash: value.hash,
    tokenCiphertext: value.token_ciphertext,
    subjectId: value.subject_id,
    label: value.label,
    scope: value.scope,
    expiresAt: new Date(value.expires_at),
    revokedAt: value.revoked_at ? new Date(value.revoked_at) : null,
    rate: JSON.parse(value.rate_json) as RateLimitPolicy,
    createdAt: new Date(value.created_at),
    rotatesId: value.rotates_id
  };
}

export function rowToPlan(row: unknown): Plan {
  const value = row as {
    id: string;
    display_name: string;
    policy_json: string;
    scope_allowlist_json: string;
    priority_class: number;
    team_pool_id: string | null;
    state: PlanState;
    created_at: string;
    metadata_json: string | null;
  };
  return {
    id: value.id,
    displayName: value.display_name,
    policy: validatePlanPolicy(JSON.parse(value.policy_json) as TokenLimitPolicy),
    scopeAllowlist: parseScopeAllowlist(value.scope_allowlist_json),
    priorityClass: value.priority_class,
    teamPoolId: value.team_pool_id,
    state: value.state,
    createdAt: new Date(value.created_at),
    metadata: value.metadata_json
      ? (JSON.parse(value.metadata_json) as Record<string, unknown>)
      : null
  };
}

export function rowToEntitlement(row: unknown): Entitlement {
  const value = row as {
    id: string;
    subject_id: string;
    plan_id: string;
    policy_snapshot_json: string;
    scope_allowlist_json: string;
    period_kind: PeriodKind;
    period_start: string;
    period_end: string | null;
    state: EntitlementState;
    team_seat_id: string | null;
    created_at: string;
    cancelled_at: string | null;
    cancelled_reason: string | null;
    notes: string | null;
  };
  return {
    id: value.id,
    subjectId: value.subject_id,
    planId: value.plan_id,
    policySnapshot: validatePlanPolicy(JSON.parse(value.policy_snapshot_json) as TokenLimitPolicy),
    scopeAllowlist: parseScopeAllowlist(value.scope_allowlist_json),
    periodKind: value.period_kind,
    periodStart: new Date(value.period_start),
    periodEnd: value.period_end ? new Date(value.period_end) : null,
    state: value.state,
    teamSeatId: value.team_seat_id,
    createdAt: new Date(value.created_at),
    cancelledAt: value.cancelled_at ? new Date(value.cancelled_at) : null,
    cancelledReason: value.cancelled_reason,
    notes: value.notes
  };
}

export function rowToRequestEvent(row: unknown): RequestEventRecord {
  const value = row as {
    request_id: string;
    credential_id: string | null;
    subject_id: string | null;
    scope: RequestEventRecord["scope"];
    session_id: string | null;
    upstream_account_id: string | null;
    provider: RequestEventRecord["provider"];
    started_at: string;
    duration_ms: number | null;
    first_byte_ms: number | null;
    status: RequestEventRecord["status"];
    error_code: string | null;
    rate_limited: number;
    prompt_tokens: number | null;
    completion_tokens: number | null;
    total_tokens: number | null;
    cached_prompt_tokens: number | null;
    estimated_tokens: number | null;
    usage_source: RequestEventRecord["usageSource"];
    limit_kind: RequestEventRecord["limitKind"];
    reservation_id: string | null;
    over_request_limit: number;
    identity_guard_hit: number;
  };

  return {
    requestId: value.request_id,
    credentialId: value.credential_id,
    subjectId: value.subject_id,
    scope: value.scope,
    sessionId: value.session_id,
    upstreamAccountId: value.upstream_account_id,
    provider: value.provider,
    startedAt: new Date(value.started_at),
    durationMs: value.duration_ms,
    firstByteMs: value.first_byte_ms,
    status: value.status,
    errorCode: value.error_code,
    rateLimited: value.rate_limited === 1,
    promptTokens: value.prompt_tokens,
    completionTokens: value.completion_tokens,
    totalTokens: value.total_tokens,
    cachedPromptTokens: value.cached_prompt_tokens,
    estimatedTokens: value.estimated_tokens,
    usageSource: value.usage_source,
    limitKind: value.limit_kind,
    reservationId: value.reservation_id,
    overRequestLimit: value.over_request_limit === 1,
    identityGuardHit: value.identity_guard_hit === 1
  };
}

export function rowToAdminAuditEvent(row: unknown): AdminAuditEventRecord {
  const value = row as {
    id: string;
    action: AdminAuditEventRecord["action"];
    target_user_id: string | null;
    target_credential_id: string | null;
    target_credential_prefix: string | null;
    status: AdminAuditEventRecord["status"];
    params_json: string | null;
    error_message: string | null;
    created_at: string;
  };

  return {
    id: value.id,
    action: value.action,
    targetUserId: value.target_user_id,
    targetCredentialId: value.target_credential_id,
    targetCredentialPrefix: value.target_credential_prefix,
    status: value.status,
    params: value.params_json ? (JSON.parse(value.params_json) as Record<string, unknown>) : null,
    errorMessage: value.error_message,
    createdAt: new Date(value.created_at)
  };
}

export function rowToClientMessageEvent(row: unknown): ClientMessageEventRecord {
  const value = row as {
    id: string;
    event_id: string;
    request_id: string;
    credential_id: string;
    subject_id: string;
    scope: ClientMessageEventRecord["scope"];
    session_id: string;
    message_id: string;
    agent: string | null;
    provider_id: string | null;
    model_id: string | null;
    engine: string | null;
    text: string;
    text_sha256: string;
    attachments_json: string;
    app_name: string | null;
    app_version: string | null;
    created_at: string;
    received_at: string;
  };

  return {
    id: value.id,
    eventId: value.event_id,
    requestId: value.request_id,
    credentialId: value.credential_id,
    subjectId: value.subject_id,
    scope: value.scope,
    sessionId: value.session_id,
    messageId: value.message_id,
    agent: value.agent,
    providerId: value.provider_id,
    modelId: value.model_id,
    engine: value.engine,
    text: value.text,
    textSha256: value.text_sha256,
    attachmentsJson: value.attachments_json,
    appName: value.app_name,
    appVersion: value.app_version,
    createdAt: new Date(value.created_at),
    receivedAt: new Date(value.received_at)
  };
}

export function rowToClientDiagnosticEvent(row: unknown): ClientDiagnosticEventRecord {
  const value = row as {
    id: string;
    event_id: string;
    request_id: string;
    credential_id: string;
    subject_id: string;
    scope: ClientDiagnosticEventRecord["scope"];
    session_id: string | null;
    message_id: string | null;
    category: string;
    action: string;
    status: ClientDiagnosticEventRecord["status"];
    method: string | null;
    path: string | null;
    duration_ms: number | null;
    http_status: number | null;
    error_code: string | null;
    error_message: string | null;
    metadata_json: string;
    app_name: string | null;
    app_version: string | null;
    created_at: string;
    received_at: string;
  };

  return {
    id: value.id,
    eventId: value.event_id,
    requestId: value.request_id,
    credentialId: value.credential_id,
    subjectId: value.subject_id,
    scope: value.scope,
    sessionId: value.session_id,
    messageId: value.message_id,
    category: value.category,
    action: value.action,
    status: value.status,
    method: value.method,
    path: value.path,
    durationMs: value.duration_ms,
    httpStatus: value.http_status,
    errorCode: value.error_code,
    errorMessage: value.error_message,
    metadataJson: value.metadata_json,
    appName: value.app_name,
    appVersion: value.app_version,
    createdAt: new Date(value.created_at),
    receivedAt: new Date(value.received_at)
  };
}

export function rowToRequestUsageReport(row: unknown): RequestUsageReportRow {
  const value = row as {
    date: string;
    credential_id: string | null;
    subject_id: string | null;
    scope: RequestUsageReportRow["scope"];
    upstream_account_id: string | null;
    provider: RequestUsageReportRow["provider"];
    entitlement_id: string | null;
    requests: number;
    ok: number;
    errors: number;
    rate_limited: number;
    avg_duration_ms: number | null;
    avg_first_byte_ms: number | null;
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    cached_prompt_tokens: number;
    estimated_tokens: number;
    request_minute: number;
    request_day: number;
    concurrency: number;
    token_minute: number;
    token_day: number;
    token_month: number;
    token_request_prompt: number;
    token_request_total: number;
    over_request_limit: number;
    identity_guard_hit: number;
  };

  return {
    date: value.date,
    credentialId: value.credential_id,
    subjectId: value.subject_id,
    scope: value.scope,
    upstreamAccountId: value.upstream_account_id,
    provider: value.provider,
    entitlementId: value.entitlement_id,
    requests: value.requests,
    ok: value.ok,
    errors: value.errors,
    rateLimited: value.rate_limited,
    avgDurationMs: value.avg_duration_ms,
    avgFirstByteMs: value.avg_first_byte_ms,
    promptTokens: value.prompt_tokens,
    completionTokens: value.completion_tokens,
    totalTokens: value.total_tokens,
    cachedPromptTokens: value.cached_prompt_tokens,
    estimatedTokens: value.estimated_tokens,
    rateLimitedBy: {
      request_minute: value.request_minute,
      request_day: value.request_day,
      concurrency: value.concurrency,
      token_minute: value.token_minute,
      token_day: value.token_day,
      token_month: value.token_month,
      token_request_prompt: value.token_request_prompt,
      token_request_total: value.token_request_total
    },
    overRequestLimit: value.over_request_limit,
    identityGuardHit: value.identity_guard_hit
  };
}
