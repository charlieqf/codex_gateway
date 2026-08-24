import type { DatabaseSync } from "node:sqlite";
import type {
  ListRequestEventsInput,
  PruneRequestEventsInput,
  PruneRequestEventsResult,
  RequestEventRecord,
  RequestUsageReportInput,
  RequestUsageReportRow,
  UpstreamAttemptSummary
} from "@codex-gateway/core";
import { summarizeUpstreamAttemptPurposes } from "@codex-gateway/core";
import { requestEventColumns } from "./columns.js";
import {
  compareRequestUsageRows,
  emptyRequestUsageReportRow,
  mergeTokenUsageRows,
  normalizeAndAggregateRequestUsageRows,
  requestUsageReportKey,
  tokenUsageAggregateKey,
  type TokenUsageAggregateRow
} from "./request-usage-report.js";
import {
  rowToRequestEvent,
  rowToRequestUsageReport
} from "./row-mappers.js";

export function insert(
  db: DatabaseSync,
  record: RequestEventRecord
): RequestEventRecord {
  db.prepare(
    `INSERT INTO request_events (
      request_id, credential_id, subject_id, scope, session_id, upstream_account_id, provider,
      public_model_id, upstream_runtime, upstream_model, reasoning_effort,
      requested_reasoning_effort, effective_reasoning_effort, reasoning_effort_source,
      reasoning_effort_normalized, reasoning_effort_normalization_reason, reasoning_tokens,
      client_turn_id, turn_code, client_session_id, client_message_id, client_app_version,
      tool_choice, upstream_finish_reason, upstream_request_id, upstream_http_status,
      upstream_content_chars, upstream_tool_call_count, upstream_tool_names_json,
      upstream_raw_response_hash, upstream_raw_response_chars, upstream_empty_stop,
      upstream_attempt_count, upstream_attempts_json,
      upstream_failure_origin, upstream_failure_kind, upstream_failure_stage,
      upstream_transport_code, upstream_failure_retry_count,
      upstream_recovery_attempt_count, upstream_unclassified_additional_attempt_count,
      started_at, duration_ms, first_byte_ms, status, error_code, rate_limited,
      prompt_tokens, completion_tokens, total_tokens, cached_prompt_tokens,
      estimated_tokens, gateway_estimated_prompt_tokens, gateway_prompt_estimate_method,
      model_context_tokens, model_max_output_tokens, prompt_chars, maximum_output_tokens,
      gateway_admitted_ms, provider_first_event_ms, provider_duration_ms, terminal_source,
      cancel_requested, cancel_observed, active_tool_count, client_tool_mode,
      tool_loop_guard_json, usage_source, limit_kind, reservation_id, over_request_limit,
      identity_guard_hit
    ) VALUES (${Array.from({ length: 72 }, () => "?").join(", ")})
    ON CONFLICT(request_id) DO UPDATE SET
      credential_id = excluded.credential_id,
      subject_id = excluded.subject_id,
      scope = excluded.scope,
      session_id = excluded.session_id,
      upstream_account_id = excluded.upstream_account_id,
      provider = excluded.provider,
      public_model_id = excluded.public_model_id,
      upstream_runtime = excluded.upstream_runtime,
      upstream_model = excluded.upstream_model,
      reasoning_effort = excluded.reasoning_effort,
      requested_reasoning_effort = excluded.requested_reasoning_effort,
      effective_reasoning_effort = excluded.effective_reasoning_effort,
      reasoning_effort_source = excluded.reasoning_effort_source,
      reasoning_effort_normalized = excluded.reasoning_effort_normalized,
      reasoning_effort_normalization_reason = excluded.reasoning_effort_normalization_reason,
      reasoning_tokens = excluded.reasoning_tokens,
      client_turn_id = excluded.client_turn_id,
      turn_code = excluded.turn_code,
      client_session_id = excluded.client_session_id,
      client_message_id = excluded.client_message_id,
      client_app_version = excluded.client_app_version,
      tool_choice = excluded.tool_choice,
      upstream_finish_reason = excluded.upstream_finish_reason,
      upstream_request_id = excluded.upstream_request_id,
      upstream_http_status = excluded.upstream_http_status,
      upstream_content_chars = excluded.upstream_content_chars,
      upstream_tool_call_count = excluded.upstream_tool_call_count,
      upstream_tool_names_json = excluded.upstream_tool_names_json,
      upstream_raw_response_hash = excluded.upstream_raw_response_hash,
      upstream_raw_response_chars = excluded.upstream_raw_response_chars,
      upstream_empty_stop = excluded.upstream_empty_stop,
      upstream_attempt_count = excluded.upstream_attempt_count,
      upstream_attempts_json = excluded.upstream_attempts_json,
      upstream_failure_origin = excluded.upstream_failure_origin,
      upstream_failure_kind = excluded.upstream_failure_kind,
      upstream_failure_stage = excluded.upstream_failure_stage,
      upstream_transport_code = excluded.upstream_transport_code,
      upstream_failure_retry_count = excluded.upstream_failure_retry_count,
      upstream_recovery_attempt_count = excluded.upstream_recovery_attempt_count,
      upstream_unclassified_additional_attempt_count = excluded.upstream_unclassified_additional_attempt_count,
      started_at = excluded.started_at,
      duration_ms = excluded.duration_ms,
      first_byte_ms = excluded.first_byte_ms,
      status = excluded.status,
      error_code = excluded.error_code,
      rate_limited = excluded.rate_limited,
      prompt_tokens = excluded.prompt_tokens,
      completion_tokens = excluded.completion_tokens,
      total_tokens = excluded.total_tokens,
      cached_prompt_tokens = excluded.cached_prompt_tokens,
      estimated_tokens = excluded.estimated_tokens,
      gateway_estimated_prompt_tokens = excluded.gateway_estimated_prompt_tokens,
      gateway_prompt_estimate_method = excluded.gateway_prompt_estimate_method,
      model_context_tokens = excluded.model_context_tokens,
      model_max_output_tokens = excluded.model_max_output_tokens,
      prompt_chars = excluded.prompt_chars,
      maximum_output_tokens = excluded.maximum_output_tokens,
      gateway_admitted_ms = excluded.gateway_admitted_ms,
      provider_first_event_ms = excluded.provider_first_event_ms,
      provider_duration_ms = excluded.provider_duration_ms,
      terminal_source = excluded.terminal_source,
      cancel_requested = excluded.cancel_requested,
      cancel_observed = excluded.cancel_observed,
      active_tool_count = excluded.active_tool_count,
      client_tool_mode = excluded.client_tool_mode,
      tool_loop_guard_json = excluded.tool_loop_guard_json,
      usage_source = excluded.usage_source,
      limit_kind = excluded.limit_kind,
      reservation_id = excluded.reservation_id,
      over_request_limit = excluded.over_request_limit,
      identity_guard_hit = excluded.identity_guard_hit`
  ).run(
    record.requestId,
    record.credentialId,
    record.subjectId,
    record.scope,
    record.sessionId,
    record.upstreamAccountId,
    record.provider,
    record.publicModelId ?? null,
    record.upstreamRuntime ?? null,
    record.upstreamModel ?? null,
    record.reasoningEffort ?? null,
    record.requestedReasoningEffort ?? null,
    record.effectiveReasoningEffort ?? record.reasoningEffort ?? null,
    record.reasoningEffortSource ?? null,
    record.reasoningEffortNormalized === true ? 1 : 0,
    record.reasoningEffortNormalizationReason ?? null,
    record.reasoningTokens ?? null,
    record.clientTurnId ?? null,
    record.turnCode ?? null,
    record.clientSessionId ?? null,
    record.clientMessageId ?? null,
    record.clientAppVersion ?? null,
    record.toolChoice ?? null,
    record.upstreamFinishReason ?? null,
    record.upstreamRequestId ?? null,
    record.upstreamHttpStatus ?? null,
    record.upstreamContentChars ?? null,
    record.upstreamToolCallCount ?? null,
    record.upstreamToolNames ? JSON.stringify(record.upstreamToolNames) : null,
    record.upstreamRawResponseHash ?? null,
    record.upstreamRawResponseChars ?? null,
    record.upstreamEmptyStop === null || record.upstreamEmptyStop === undefined
      ? null
      : record.upstreamEmptyStop
        ? 1
        : 0,
    record.upstreamAttemptCount ?? record.upstreamAttempts?.length ?? null,
    record.upstreamAttempts ? JSON.stringify(record.upstreamAttempts) : null,
    record.upstreamFailureOrigin ?? null,
    record.upstreamFailureKind ?? null,
    record.upstreamFailureStage ?? null,
    record.upstreamTransportCode ?? null,
    record.upstreamFailureRetryCount ?? null,
    record.upstreamRecoveryAttemptCount ?? null,
    record.upstreamUnclassifiedAdditionalAttemptCount ?? null,
    record.startedAt.toISOString(),
    record.durationMs,
    record.firstByteMs,
    record.status,
    record.errorCode,
    record.rateLimited ? 1 : 0,
    record.promptTokens ?? null,
    record.completionTokens ?? null,
    record.totalTokens ?? null,
    record.cachedPromptTokens ?? null,
    record.estimatedTokens ?? null,
    record.gatewayEstimatedPromptTokens ?? null,
    record.gatewayPromptEstimateMethod ?? null,
    record.modelContextTokens ?? null,
    record.modelMaxOutputTokens ?? null,
    record.promptChars ?? null,
    record.maximumOutputTokens ?? null,
    record.gatewayAdmittedMs ?? null,
    record.providerFirstEventMs ?? null,
    record.providerDurationMs ?? null,
    record.terminalSource ?? null,
    record.cancelRequested === undefined ? null : record.cancelRequested ? 1 : 0,
    record.cancelObserved === undefined ? null : record.cancelObserved ? 1 : 0,
    record.activeToolCount ?? null,
    record.clientToolMode ?? null,
    record.toolLoopGuard ? JSON.stringify(record.toolLoopGuard) : null,
    record.usageSource ?? null,
    record.limitKind ?? null,
    record.reservationId ?? null,
    record.overRequestLimit === true ? 1 : 0,
    record.identityGuardHit === true ? 1 : 0
  );

  return record;
}

export function list(
  db: DatabaseSync,
  input: ListRequestEventsInput = {}
): RequestEventRecord[] {
  const limit = input.limit ?? 100;
  const clauses: string[] = [];
  const params: Array<string | number> = [];
  if (input.requestId) {
    clauses.push("request_id = ?");
    params.push(input.requestId);
  }
  if (input.credentialId) {
    clauses.push("credential_id = ?");
    params.push(input.credentialId);
  }
  if (input.subjectId) {
    clauses.push("subject_id = ?");
    params.push(input.subjectId);
  }
  if (input.clientMessageIds !== undefined) {
    const messageIds = Array.from(new Set(input.clientMessageIds.filter(Boolean)));
    if (messageIds.length === 0) {
      return [];
    }
    clauses.push(`client_message_id IN (${messageIds.map(() => "?").join(", ")})`);
    params.push(...messageIds);
  }
  if (input.clientTurnId) {
    clauses.push("client_turn_id = ?");
    params.push(input.clientTurnId);
  }
  if (input.turnCode) {
    clauses.push("turn_code = ?");
    params.push(input.turnCode);
  }
  if (input.clientSessionId) {
    clauses.push("client_session_id = ?");
    params.push(input.clientSessionId);
  }
  if (input.since) {
    clauses.push("started_at >= ?");
    params.push(input.since.toISOString());
  }
  if (input.until) {
    clauses.push("started_at < ?");
    params.push(input.until.toISOString());
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = db
    .prepare(
      `SELECT ${requestEventColumns}
       FROM request_events
       ${where}
       ORDER BY started_at DESC
       LIMIT ?`
    )
    .all(...params, limit);

  return rows.map(rowToRequestEvent);
}

export function reportUsage(
  db: DatabaseSync,
  input: RequestUsageReportInput
): RequestUsageReportRow[] {
  const groupByEntitlement =
    input.groupBy === "entitlement" || input.groupBy === "entitlement-model";
  const clauses = ["request_events.started_at >= ?"];
  const params: string[] = [input.since.toISOString()];
  if (input.until) {
    clauses.push("request_events.started_at < ?");
    params.push(input.until.toISOString());
  }
  if (input.credentialId) {
    clauses.push("request_events.credential_id = ?");
    params.push(input.credentialId);
  }
  if (input.subjectId) {
    clauses.push("request_events.subject_id = ?");
    params.push(input.subjectId);
  }

  const entitlementSelect = groupByEntitlement
    ? "tr.entitlement_id AS entitlement_id,"
    : "NULL AS entitlement_id,";
  const entitlementJoin = groupByEntitlement
    ? "LEFT JOIN token_reservations tr ON tr.id = request_events.reservation_id"
    : "";
  const entitlementGroup = groupByEntitlement ? ", tr.entitlement_id" : "";
  const requestRows = db
    .prepare(
      `SELECT
         substr(request_events.started_at, 1, 10) AS date,
         request_events.credential_id AS credential_id,
         request_events.subject_id AS subject_id,
         request_events.scope AS scope,
         request_events.upstream_account_id AS upstream_account_id,
         request_events.provider AS provider,
         request_events.public_model_id AS public_model_id,
         request_events.upstream_runtime AS upstream_runtime,
         request_events.upstream_model AS upstream_model,
         request_events.reasoning_effort AS reasoning_effort,
         ${entitlementSelect}
         COUNT(*) AS requests,
         SUM(CASE WHEN request_events.status = 'ok' THEN 1 ELSE 0 END) AS ok,
         SUM(CASE WHEN request_events.status = 'error' THEN 1 ELSE 0 END) AS errors,
         SUM(CASE WHEN request_events.rate_limited = 1 THEN 1 ELSE 0 END) AS rate_limited,
         AVG(request_events.duration_ms) AS avg_duration_ms,
         AVG(request_events.first_byte_ms) AS avg_first_byte_ms,
         0 AS prompt_tokens,
         0 AS completion_tokens,
         0 AS total_tokens,
         0 AS cached_prompt_tokens,
         0 AS estimated_tokens,
         0 AS reasoning_tokens,
         SUM(CASE
           WHEN request_events.usage_source = 'none' THEN 0
           WHEN request_events.total_tokens IS NOT NULL
             OR request_events.prompt_tokens IS NOT NULL
             OR request_events.completion_tokens IS NOT NULL THEN 0
           WHEN COALESCE(request_events.estimated_tokens, 0) > 0 THEN 0
           ELSE 1
         END) AS usage_missing,
         SUM(CASE WHEN COALESCE(
           request_events.upstream_attempt_count,
           CASE WHEN json_valid(request_events.upstream_attempts_json) = 1
             AND json_type(request_events.upstream_attempts_json) = 'array'
             THEN json_array_length(request_events.upstream_attempts_json) END,
           0
         ) > 0 THEN 1 ELSE 0 END) AS model_call_requests,
         SUM(COALESCE(
           request_events.upstream_attempt_count,
           CASE WHEN json_valid(request_events.upstream_attempts_json) = 1
             AND json_type(request_events.upstream_attempts_json) = 'array'
             THEN json_array_length(request_events.upstream_attempts_json) END,
           0
         )) AS upstream_attempts,
         SUM(COALESCE(request_events.upstream_failure_retry_count, 0)) AS failure_retries,
         SUM(COALESCE(request_events.upstream_recovery_attempt_count, 0)) AS recovery_attempts,
         SUM(COALESCE(request_events.upstream_unclassified_additional_attempt_count, 0))
           AS unclassified_additional_attempts,
         SUM(CASE WHEN request_events.upstream_attempt_count IS NULL
           AND NOT (json_valid(request_events.upstream_attempts_json) = 1
             AND json_type(request_events.upstream_attempts_json) = 'array')
           THEN 1 ELSE 0 END) AS attempt_count_missing,
         SUM(CASE
           WHEN COALESCE(request_events.upstream_attempt_count, 0) > 0
             THEN CASE
               WHEN json_valid(request_events.upstream_attempts_json) = 1
                 AND json_type(request_events.upstream_attempts_json) = 'array'
                 THEN MAX(
                   request_events.upstream_attempt_count -
                     json_array_length(request_events.upstream_attempts_json),
                   0
                 )
               ELSE request_events.upstream_attempt_count
             END
           ELSE 0
         END) AS attempt_purpose_missing,
         SUM(CASE WHEN request_events.limit_kind = 'request_minute' THEN 1 ELSE 0 END) AS request_minute,
         SUM(CASE WHEN request_events.limit_kind = 'request_day' THEN 1 ELSE 0 END) AS request_day,
         SUM(CASE WHEN request_events.limit_kind = 'concurrency' THEN 1 ELSE 0 END) AS concurrency,
         SUM(CASE WHEN request_events.limit_kind = 'token_minute' THEN 1 ELSE 0 END) AS token_minute,
         SUM(CASE WHEN request_events.limit_kind = 'token_day' THEN 1 ELSE 0 END) AS token_day,
         SUM(CASE WHEN request_events.limit_kind = 'token_month' THEN 1 ELSE 0 END) AS token_month,
         SUM(CASE WHEN request_events.limit_kind = 'token_request_prompt' THEN 1 ELSE 0 END) AS token_request_prompt,
         SUM(CASE WHEN request_events.limit_kind = 'token_request_total' THEN 1 ELSE 0 END) AS token_request_total,
         SUM(CASE WHEN request_events.over_request_limit = 1 THEN 1 ELSE 0 END) AS over_request_limit,
         SUM(CASE WHEN request_events.identity_guard_hit = 1 THEN 1 ELSE 0 END) AS identity_guard_hit
       FROM request_events
       ${entitlementJoin}
       WHERE ${clauses.join(" AND ")}
       GROUP BY
         substr(request_events.started_at, 1, 10),
         request_events.credential_id,
         request_events.subject_id,
         request_events.scope,
         request_events.upstream_account_id,
         request_events.provider,
         request_events.public_model_id,
         request_events.upstream_runtime,
         request_events.upstream_model,
         request_events.reasoning_effort
         ${entitlementGroup}
       ORDER BY date DESC, requests DESC, credential_id, subject_id`
    )
    .all(...params);

  const merged = new Map<string, RequestUsageReportRow>();
  for (const row of requestRows) {
    const report = rowToRequestUsageReport(row);
    merged.set(requestUsageReportKey(report), report);
  }

  applyLegacyAttemptPurposeFallbacks(db, input, merged);

  for (const row of tokenUsageRows(db, input)) {
    const report =
      merged.get(tokenUsageAggregateKey(row)) ??
      emptyRequestUsageReportRow({
        date: row.date,
        credentialId: row.credential_id,
        subjectId: row.subject_id,
        scope: row.scope,
        upstreamAccountId: row.upstream_account_id,
        provider: row.provider,
        publicModelId: row.public_model_id,
        upstreamRuntime: row.upstream_runtime,
        upstreamModel: row.upstream_model,
        reasoningEffort: row.reasoning_effort,
        entitlementId: row.entitlement_id
      });
    report.promptTokens += row.prompt_tokens;
    report.completionTokens += row.completion_tokens;
    report.totalTokens += row.total_tokens;
    report.cachedPromptTokens += row.cached_prompt_tokens;
    report.estimatedTokens += row.estimated_tokens;
    report.reasoningTokens += row.reasoning_tokens;
    report.usageMissing += row.usage_missing;
    merged.set(requestUsageReportKey(report), report);
  }

  return normalizeAndAggregateRequestUsageRows(
    Array.from(merged.values()).sort(compareRequestUsageRows),
    input
  );
}

function applyLegacyAttemptPurposeFallbacks(
  db: DatabaseSync,
  input: RequestUsageReportInput,
  merged: Map<string, RequestUsageReportRow>
): void {
  const groupByEntitlement =
    input.groupBy === "entitlement" || input.groupBy === "entitlement-model";
  const clauses = [
    "request_events.started_at >= ?",
    "json_valid(request_events.upstream_attempts_json) = 1",
    "json_type(request_events.upstream_attempts_json) = 'array'"
  ];
  const params: string[] = [input.since.toISOString()];
  if (input.until) {
    clauses.push("request_events.started_at < ?");
    params.push(input.until.toISOString());
  }
  if (input.credentialId) {
    clauses.push("request_events.credential_id = ?");
    params.push(input.credentialId);
  }
  if (input.subjectId) {
    clauses.push("request_events.subject_id = ?");
    params.push(input.subjectId);
  }

  const rows = db
    .prepare(
      `SELECT
         substr(request_events.started_at, 1, 10) AS date,
         request_events.credential_id,
         request_events.subject_id,
         request_events.scope,
         request_events.upstream_account_id,
         request_events.provider,
         request_events.public_model_id,
         request_events.upstream_runtime,
         request_events.upstream_model,
         request_events.reasoning_effort,
         ${groupByEntitlement ? "tr.entitlement_id" : "NULL"} AS entitlement_id,
         request_events.upstream_attempt_count,
         request_events.upstream_attempts_json,
         request_events.upstream_failure_retry_count,
         request_events.upstream_recovery_attempt_count,
         request_events.upstream_unclassified_additional_attempt_count
       FROM request_events
       ${groupByEntitlement
         ? "LEFT JOIN token_reservations tr ON tr.id = request_events.reservation_id"
         : ""}
       WHERE ${clauses.join(" AND ")}`
    )
    .all(...params) as Array<{
      date: string;
      credential_id: string | null;
      subject_id: string | null;
      scope: RequestUsageReportRow["scope"];
      upstream_account_id: string | null;
      provider: RequestUsageReportRow["provider"];
      public_model_id: string | null;
      upstream_runtime: string | null;
      upstream_model: string | null;
      reasoning_effort: string | null;
      entitlement_id: string | null;
      upstream_attempt_count: number | null;
      upstream_attempts_json: string;
      upstream_failure_retry_count: number | null;
      upstream_recovery_attempt_count: number | null;
      upstream_unclassified_additional_attempt_count: number | null;
    }>;

  for (const row of rows) {
    const attempts = parseAttemptPurposeInputs(row.upstream_attempts_json);
    const summary = summarizeUpstreamAttemptPurposes(attempts);
    const keyRow = emptyRequestUsageReportRow({
      date: row.date,
      credentialId: row.credential_id,
      subjectId: row.subject_id,
      scope: row.scope,
      upstreamAccountId: row.upstream_account_id,
      provider: row.provider,
      publicModelId: row.public_model_id,
      upstreamRuntime: row.upstream_runtime,
      upstreamModel: row.upstream_model,
      reasoningEffort: row.reasoning_effort,
      entitlementId: row.entitlement_id
    });
    const report = merged.get(requestUsageReportKey(keyRow));
    if (!report) {
      continue;
    }
    if (row.upstream_failure_retry_count === null) {
      report.failureRetries += summary.failureRetryCount;
    }
    if (row.upstream_recovery_attempt_count === null) {
      report.recoveryAttempts += summary.recoveryAttemptCount;
    }
    if (row.upstream_unclassified_additional_attempt_count === null) {
      report.unclassifiedAdditionalAttempts +=
        summary.unclassifiedAdditionalAttemptCount;
    }
    report.attemptPurposeMissing += summary.attemptPurposeMissing;
  }
}

function parseAttemptPurposeInputs(value: string): UpstreamAttemptSummary[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(
      (attempt): attempt is UpstreamAttemptSummary =>
        typeof attempt === "object" &&
        attempt !== null &&
        typeof (attempt as { index?: unknown }).index === "number"
    );
  } catch {
    return [];
  }
}

export function prune(
  db: DatabaseSync,
  input: PruneRequestEventsInput
): PruneRequestEventsResult {
  if (input.dryRun) {
    const row = db
      .prepare("SELECT COUNT(*) AS count FROM request_events WHERE started_at < ?")
      .get(input.before.toISOString()) as { count: number };
    return {
      before: input.before,
      dryRun: true,
      matched: row.count,
      deleted: 0
    };
  }

  const result = db.prepare("DELETE FROM request_events WHERE started_at < ?").run(
    input.before.toISOString()
  );
  const deleted = Number(result.changes);

  return {
    before: input.before,
    dryRun: false,
    matched: deleted,
    deleted
  };
}

function tokenUsageRows(
  db: DatabaseSync,
  input: RequestUsageReportInput
): TokenUsageAggregateRow[] {
  const rows: TokenUsageAggregateRow[] = [];
  const groupByEntitlement =
    input.groupBy === "entitlement" || input.groupBy === "entitlement-model";
  const reservationClauses = [
    "token_reservations.finalized_at IS NOT NULL",
    "token_reservations.created_at >= ?"
  ];
  const reservationParams: string[] = [input.since.toISOString()];
  if (input.until) {
    reservationClauses.push("token_reservations.created_at < ?");
    reservationParams.push(input.until.toISOString());
  }
  if (input.credentialId) {
    reservationClauses.push("token_reservations.credential_id = ?");
    reservationParams.push(input.credentialId);
  }
  if (input.subjectId) {
    reservationClauses.push("token_reservations.subject_id = ?");
    reservationParams.push(input.subjectId);
  }

  rows.push(
    ...(db
      .prepare(
        `SELECT
           substr(day_window_start, 1, 10) AS date,
           token_reservations.credential_id,
           token_reservations.subject_id,
           token_reservations.scope,
           token_reservations.upstream_account_id,
           token_reservations.provider,
           COALESCE(token_reservations.public_model_id, request_events.public_model_id) AS public_model_id,
           COALESCE(token_reservations.upstream_runtime, request_events.upstream_runtime) AS upstream_runtime,
           COALESCE(token_reservations.upstream_model, request_events.upstream_model) AS upstream_model,
           COALESCE(token_reservations.reasoning_effort, request_events.reasoning_effort) AS reasoning_effort,
           ${groupByEntitlement ? "entitlement_id" : "NULL"} AS entitlement_id,
           COALESCE(SUM(CASE WHEN final_usage_source IN ('provider', 'soft_write')
             THEN final_prompt_tokens ELSE 0 END), 0) AS prompt_tokens,
           COALESCE(SUM(CASE WHEN final_usage_source IN ('provider', 'soft_write')
             THEN final_completion_tokens ELSE 0 END), 0) AS completion_tokens,
           COALESCE(SUM(CASE WHEN final_usage_source IN ('provider', 'soft_write')
             THEN final_total_tokens ELSE 0 END), 0) AS total_tokens,
           COALESCE(SUM(CASE WHEN final_usage_source IN ('provider', 'soft_write')
             THEN final_cached_prompt_tokens ELSE 0 END), 0) AS cached_prompt_tokens,
           COALESCE(SUM(CASE WHEN final_usage_source IN ('estimate', 'reserve')
             THEN final_total_tokens ELSE 0 END), 0) AS estimated_tokens,
           COALESCE(SUM(CASE WHEN final_usage_source IN ('provider', 'soft_write')
             THEN final_reasoning_tokens ELSE 0 END), 0) AS reasoning_tokens,
           0 AS usage_missing
         FROM token_reservations
         LEFT JOIN request_events ON request_events.request_id = token_reservations.request_id
         WHERE ${reservationClauses.join(" AND ")}
         GROUP BY
           substr(day_window_start, 1, 10),
           token_reservations.credential_id,
           token_reservations.subject_id,
           token_reservations.scope,
           token_reservations.upstream_account_id,
           token_reservations.provider,
           COALESCE(token_reservations.public_model_id, request_events.public_model_id),
           COALESCE(token_reservations.upstream_runtime, request_events.upstream_runtime),
           COALESCE(token_reservations.upstream_model, request_events.upstream_model),
           COALESCE(token_reservations.reasoning_effort, request_events.reasoning_effort)
           ${groupByEntitlement ? ", entitlement_id" : ""}`
      )
      .all(...reservationParams) as unknown as TokenUsageAggregateRow[])
  );

  const legacyClauses = [
    "started_at >= ?",
    "reservation_id IS NULL",
    "(total_tokens IS NOT NULL OR prompt_tokens IS NOT NULL OR completion_tokens IS NOT NULL OR estimated_tokens IS NOT NULL)"
  ];
  const legacyParams: string[] = [input.since.toISOString()];
  if (input.until) {
    legacyClauses.push("started_at < ?");
    legacyParams.push(input.until.toISOString());
  }
  if (input.credentialId) {
    legacyClauses.push("credential_id = ?");
    legacyParams.push(input.credentialId);
  }
  if (input.subjectId) {
    legacyClauses.push("subject_id = ?");
    legacyParams.push(input.subjectId);
  }

  rows.push(
    ...(db
      .prepare(
        `SELECT
           substr(started_at, 1, 10) AS date,
           credential_id,
           subject_id,
           scope,
           upstream_account_id,
           provider,
           public_model_id,
           upstream_runtime,
           upstream_model,
           reasoning_effort,
           NULL AS entitlement_id,
           COALESCE(SUM(CASE WHEN total_tokens IS NOT NULL OR prompt_tokens IS NOT NULL OR completion_tokens IS NOT NULL THEN COALESCE(prompt_tokens, 0) ELSE 0 END), 0) AS prompt_tokens,
           COALESCE(SUM(CASE WHEN total_tokens IS NOT NULL OR prompt_tokens IS NOT NULL OR completion_tokens IS NOT NULL THEN COALESCE(completion_tokens, 0) ELSE 0 END), 0) AS completion_tokens,
           COALESCE(SUM(CASE WHEN total_tokens IS NOT NULL OR prompt_tokens IS NOT NULL OR completion_tokens IS NOT NULL THEN COALESCE(total_tokens, COALESCE(prompt_tokens, 0) + COALESCE(completion_tokens, 0)) ELSE 0 END), 0) AS total_tokens,
           COALESCE(SUM(cached_prompt_tokens), 0) AS cached_prompt_tokens,
           COALESCE(SUM(CASE WHEN total_tokens IS NULL AND prompt_tokens IS NULL AND completion_tokens IS NULL THEN COALESCE(estimated_tokens, 0) ELSE 0 END), 0) AS estimated_tokens,
           COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens,
           0 AS usage_missing
         FROM request_events
         WHERE ${legacyClauses.join(" AND ")}
         GROUP BY
           substr(started_at, 1, 10),
           credential_id,
           subject_id,
           scope,
           upstream_account_id,
           provider,
           public_model_id,
           upstream_runtime,
           upstream_model,
           reasoning_effort`
      )
      .all(...legacyParams) as unknown as TokenUsageAggregateRow[])
  );

  return mergeTokenUsageRows(rows);
}
