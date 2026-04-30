import type { DatabaseSync } from "node:sqlite";
import type {
  ListRequestEventsInput,
  PruneRequestEventsInput,
  PruneRequestEventsResult,
  RequestEventRecord,
  RequestUsageReportInput,
  RequestUsageReportRow
} from "@codex-gateway/core";
import { requestEventColumns } from "./columns.js";
import {
  compareRequestUsageRows,
  emptyRequestUsageReportRow,
  mergeTokenUsageRows,
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
      started_at, duration_ms, first_byte_ms, status, error_code, rate_limited,
      prompt_tokens, completion_tokens, total_tokens, cached_prompt_tokens,
      estimated_tokens, usage_source, limit_kind, reservation_id, over_request_limit,
      identity_guard_hit
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(request_id) DO UPDATE SET
      credential_id = excluded.credential_id,
      subject_id = excluded.subject_id,
      scope = excluded.scope,
      session_id = excluded.session_id,
      upstream_account_id = excluded.upstream_account_id,
      provider = excluded.provider,
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
  const rows = input.credentialId
    ? db
        .prepare(
          `SELECT ${requestEventColumns}
           FROM request_events
           WHERE credential_id = ?
           ORDER BY started_at DESC
           LIMIT ?`
        )
        .all(input.credentialId, limit)
    : input.subjectId
      ? db
          .prepare(
            `SELECT ${requestEventColumns}
             FROM request_events
             WHERE subject_id = ?
             ORDER BY started_at DESC
             LIMIT ?`
          )
          .all(input.subjectId, limit)
      : db
          .prepare(
            `SELECT ${requestEventColumns}
             FROM request_events
             ORDER BY started_at DESC
             LIMIT ?`
          )
          .all(limit);

  return rows.map(rowToRequestEvent);
}

export function reportUsage(
  db: DatabaseSync,
  input: RequestUsageReportInput
): RequestUsageReportRow[] {
  const groupByEntitlement = input.groupBy === "entitlement";
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
         request_events.provider
         ${entitlementGroup}
       ORDER BY date DESC, requests DESC, credential_id, subject_id`
    )
    .all(...params);

  const merged = new Map<string, RequestUsageReportRow>();
  for (const row of requestRows) {
    const report = rowToRequestUsageReport(row);
    merged.set(requestUsageReportKey(report), report);
  }

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
        entitlementId: row.entitlement_id
      });
    report.promptTokens += row.prompt_tokens;
    report.completionTokens += row.completion_tokens;
    report.totalTokens += row.total_tokens;
    report.cachedPromptTokens += row.cached_prompt_tokens;
    report.estimatedTokens += row.estimated_tokens;
    merged.set(requestUsageReportKey(report), report);
  }

  return Array.from(merged.values()).sort(compareRequestUsageRows);
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
  const reservationClauses = ["finalized_at IS NOT NULL", "created_at >= ?"];
  const reservationParams: string[] = [input.since.toISOString()];
  if (input.until) {
    reservationClauses.push("created_at < ?");
    reservationParams.push(input.until.toISOString());
  }
  if (input.credentialId) {
    reservationClauses.push("credential_id = ?");
    reservationParams.push(input.credentialId);
  }
  if (input.subjectId) {
    reservationClauses.push("subject_id = ?");
    reservationParams.push(input.subjectId);
  }

  rows.push(
    ...(db
      .prepare(
        `SELECT
           substr(day_window_start, 1, 10) AS date,
           credential_id,
           subject_id,
           scope,
           upstream_account_id,
           provider,
           ${input.groupBy === "entitlement" ? "entitlement_id" : "NULL"} AS entitlement_id,
           COALESCE(SUM(final_prompt_tokens), 0) AS prompt_tokens,
           COALESCE(SUM(final_completion_tokens), 0) AS completion_tokens,
           COALESCE(SUM(final_total_tokens), 0) AS total_tokens,
           COALESCE(SUM(final_cached_prompt_tokens), 0) AS cached_prompt_tokens,
           COALESCE(SUM(final_estimated_tokens), 0) AS estimated_tokens
         FROM token_reservations
         WHERE ${reservationClauses.join(" AND ")}
         GROUP BY
           substr(day_window_start, 1, 10),
           credential_id,
           subject_id,
           scope,
           upstream_account_id,
           provider
           ${input.groupBy === "entitlement" ? ", entitlement_id" : ""}`
      )
      .all(...reservationParams) as unknown as TokenUsageAggregateRow[])
  );

  const legacyClauses = [
    "started_at >= ?",
    "reservation_id IS NULL",
    "total_tokens IS NOT NULL"
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
           NULL AS entitlement_id,
           COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
           COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
           COALESCE(SUM(total_tokens), 0) AS total_tokens,
           COALESCE(SUM(cached_prompt_tokens), 0) AS cached_prompt_tokens,
           COALESCE(SUM(estimated_tokens), 0) AS estimated_tokens
         FROM request_events
         WHERE ${legacyClauses.join(" AND ")}
         GROUP BY
           substr(started_at, 1, 10),
           credential_id,
           subject_id,
           scope,
           upstream_account_id,
           provider`
      )
      .all(...legacyParams) as unknown as TokenUsageAggregateRow[])
  );

  return mergeTokenUsageRows(rows);
}
