import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  GatewayError,
  type AcquireInput,
  type AcquireSuccess,
  type CleanupResult,
  type FinalizeInput,
  type FinalizeResult,
  type GetUsageInput,
  type LimitKind,
  type LimitRejection,
  type ProviderKind,
  type Scope,
  type SoftWriteBeginInput,
  type SoftWriteFinalizeInput,
  type TokenBudgetLimiter,
  type TokenLimitPolicy,
  type TokenUsage,
  type TokenUsageSnapshot
} from "@codex-gateway/core";

export interface SqliteTokenBudgetLimiterOptions {
  db: DatabaseSync;
  logger?: {
    warn: (obj: Record<string, unknown>, msg: string) => void;
  };
}

export interface TokenReservationListInput {
  subjectId?: string;
  includeFinalized?: boolean;
  limit?: number;
}

export interface TokenReservationListRow {
  id: string;
  requestId: string;
  kind: "reservation" | "soft_write";
  credentialId: string;
  subjectId: string;
  scope: Scope;
  upstreamAccountId: string | null;
  provider: ProviderKind | null;
  createdAt: Date;
  expiresAt: Date | null;
  finalizedAt: Date | null;
  reservedTokens: number;
  estimatedPromptTokens: number;
  estimatedTotalTokens: number;
  finalPromptTokens: number;
  finalCompletionTokens: number;
  finalTotalTokens: number;
  finalCachedPromptTokens: number;
  finalEstimatedTokens: number;
  finalUsageSource: FinalizeResult["finalUsageSource"] | null;
  chargePolicySnapshot: TokenLimitPolicy["missingUsageCharge"];
  overRequestLimit: boolean;
}

interface WindowBoundaries {
  minute: Date;
  day: Date;
  month: Date;
}

interface ReservationRow {
  id: string;
  request_id: string;
  kind: "reservation" | "soft_write";
  credential_id: string;
  subject_id: string;
  scope: Scope;
  upstream_account_id: string | null;
  provider: ProviderKind | null;
  created_at: string;
  expires_at: string | null;
  finalized_at: string | null;
  estimated_prompt_tokens: number;
  estimated_total_tokens: number;
  reserved_tokens: number;
  final_prompt_tokens: number;
  final_completion_tokens: number;
  final_total_tokens: number;
  final_cached_prompt_tokens: number;
  final_estimated_tokens: number;
  final_usage_source: FinalizeResult["finalUsageSource"] | null;
  charge_policy_snapshot: TokenLimitPolicy["missingUsageCharge"];
  minute_window_start: string;
  day_window_start: string;
  month_window_start: string;
  max_prompt_tokens_per_request: number | null;
  max_total_tokens_per_request: number | null;
  over_request_limit: number;
}

export class SqliteTokenBudgetLimiter implements TokenBudgetLimiter {
  private readonly db: DatabaseSync;
  private readonly logger?: SqliteTokenBudgetLimiterOptions["logger"];

  constructor(options: SqliteTokenBudgetLimiterOptions) {
    this.db = options.db;
    this.logger = options.logger;
  }

  async acquire(input: AcquireInput): Promise<AcquireSuccess | LimitRejection> {
    const policy = validateTokenPolicy(input.policy);
    const now = input.now ?? new Date();
    const windows = windowBoundaries(now);
    const estimatedPromptTokens = nonNegativeInteger(input.estimatedPromptTokens);
    const estimatedTotalTokens = estimatedPromptTokens + policy.reserveTokensPerRequest;
    const reservedTokens = Math.max(estimatedTotalTokens, policy.reserveTokensPerRequest);

    if (
      policy.maxPromptTokensPerRequest !== null &&
      estimatedPromptTokens > policy.maxPromptTokensPerRequest
    ) {
      return tokenRejection("token_request_prompt", "Prompt exceeds maxPromptTokensPerRequest.");
    }
    if (
      policy.maxTotalTokensPerRequest !== null &&
      reservedTokens > policy.maxTotalTokensPerRequest
    ) {
      return tokenRejection(
        "token_request_total",
        "Single request would exceed maxTotalTokensPerRequest."
      );
    }

    const reservationId = `tr_${randomUUID().replaceAll("-", "")}`;
    const expiresAt = new Date(now.getTime() + 5 * 60_000);
    return runInTransaction(this.db, "BEGIN IMMEDIATE", () => {
      const existing = this.reservationByRequestId(input.requestId);
      if (existing && existing.kind === "reservation") {
        return { ok: true, reservationId: existing.id };
      }

      const minuteRejected = this.windowRejection({
        subjectId: input.subjectId,
        kind: "minute",
        windowStart: windows.minute,
        limit: policy.tokensPerMinute,
        reservedTokens,
        now
      });
      if (minuteRejected) {
        return minuteRejected;
      }

      const dayRejected = this.windowRejection({
        subjectId: input.subjectId,
        kind: "day",
        windowStart: windows.day,
        limit: policy.tokensPerDay,
        reservedTokens,
        now
      });
      if (dayRejected) {
        return dayRejected;
      }

      const monthRejected = this.windowRejection({
        subjectId: input.subjectId,
        kind: "month",
        windowStart: windows.month,
        limit: policy.tokensPerMonth,
        reservedTokens,
        now
      });
      if (monthRejected) {
        return monthRejected;
      }

      this.insertReservation({
        id: reservationId,
        requestId: input.requestId,
        kind: "reservation",
        credentialId: input.credentialId,
        subjectId: input.subjectId,
        scope: input.scope,
        upstreamAccountId: input.upstreamAccountId,
        provider: input.provider,
        now,
        expiresAt,
        estimatedPromptTokens,
        estimatedTotalTokens,
        reservedTokens,
        chargePolicySnapshot: policy.missingUsageCharge,
        maxPromptTokensPerRequest: policy.maxPromptTokensPerRequest,
        maxTotalTokensPerRequest: policy.maxTotalTokensPerRequest,
        policy,
        windows
      });

      return { ok: true, reservationId };
    });
  }

  async beginSoftWrite(input: SoftWriteBeginInput): Promise<{ reservationId: string }> {
    const now = input.now ?? new Date();
    const windows = windowBoundaries(now);
    const reservationId = `tr_${randomUUID().replaceAll("-", "")}`;
    const finalReservationId = runInTransaction(this.db, "BEGIN IMMEDIATE", () => {
      const existing = this.reservationByRequestId(input.requestId);
      if (existing && existing.kind === "soft_write") {
        return existing.id;
      }
      this.insertReservation({
        id: reservationId,
        requestId: input.requestId,
        kind: "soft_write",
        credentialId: input.credentialId,
        subjectId: input.subjectId,
        scope: input.scope,
        upstreamAccountId: input.upstreamAccountId,
        provider: input.provider,
        now,
        expiresAt: null,
        estimatedPromptTokens: 0,
        estimatedTotalTokens: 0,
        reservedTokens: 0,
        chargePolicySnapshot: "none",
        maxPromptTokensPerRequest: null,
        maxTotalTokensPerRequest: null,
        policy: null,
        windows
      });
      return reservationId;
    });
    return { reservationId: finalReservationId };
  }

  async finalize(input: FinalizeInput): Promise<FinalizeResult> {
    return this.finalizeReservation(input.reservationId, input.usage, input.now ?? new Date());
  }

  async finalizeSoftWrite(input: SoftWriteFinalizeInput): Promise<FinalizeResult> {
    return this.finalizeReservation(input.reservationId, input.usage, input.now ?? new Date());
  }

  async cleanupExpired(now: Date = new Date()): Promise<CleanupResult> {
    const nowIso = now.toISOString();
    const rows = this.db
      .prepare(
        `SELECT id
         FROM token_reservations
         WHERE kind = 'reservation'
           AND finalized_at IS NULL
           AND expires_at IS NOT NULL
           AND expires_at <= ?
         ORDER BY expires_at ASC
         LIMIT 50`
      )
      .all(nowIso) as Array<{ id: string }>;

    for (const row of rows) {
      this.finalizeReservation(row.id, undefined, now);
    }

    if (rows.length > 0) {
      this.insertAuditBestEffort("token-reservation-expired", {
        count: rows.length,
        sample_ids: rows.slice(0, 10).map((row) => row.id)
      });
    }

    return {
      count: rows.length,
      sampleIds: rows.slice(0, 10).map((row) => row.id)
    };
  }

  async getCurrentUsage(input: GetUsageInput): Promise<TokenUsageSnapshot> {
    const policy = validateTokenPolicy(input.policy);
    const now = input.now ?? new Date();
    const windows = windowBoundaries(now);

    return {
      minute: this.readUsageWindow(
        input.subjectId,
        "minute",
        windows.minute,
        policy.tokensPerMinute,
        now
      ),
      day: this.readUsageWindow(input.subjectId, "day", windows.day, policy.tokensPerDay, now),
      month: this.readUsageWindow(
        input.subjectId,
        "month",
        windows.month,
        policy.tokensPerMonth,
        now
      )
    };
  }

  listReservations(input: TokenReservationListInput = {}): TokenReservationListRow[] {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (input.subjectId) {
      clauses.push("subject_id = ?");
      params.push(input.subjectId);
    }
    if (!input.includeFinalized) {
      clauses.push("finalized_at IS NULL");
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(
        `SELECT ${reservationColumns()}
         FROM token_reservations
         ${where}
         ORDER BY created_at DESC, id DESC
         LIMIT ?`
      )
      .all(...params, input.limit ?? 100) as unknown as ReservationRow[];

    return rows.map((row) => ({
      id: row.id,
      requestId: row.request_id,
      kind: row.kind,
      credentialId: row.credential_id,
      subjectId: row.subject_id,
      scope: row.scope,
      upstreamAccountId: row.upstream_account_id,
      provider: row.provider,
      createdAt: new Date(row.created_at),
      expiresAt: row.expires_at ? new Date(row.expires_at) : null,
      finalizedAt: row.finalized_at ? new Date(row.finalized_at) : null,
      reservedTokens: row.reserved_tokens,
      estimatedPromptTokens: row.estimated_prompt_tokens,
      estimatedTotalTokens: row.estimated_total_tokens,
      finalPromptTokens: row.final_prompt_tokens,
      finalCompletionTokens: row.final_completion_tokens,
      finalTotalTokens: row.final_total_tokens,
      finalCachedPromptTokens: row.final_cached_prompt_tokens,
      finalEstimatedTokens: row.final_estimated_tokens,
      finalUsageSource: row.final_usage_source,
      chargePolicySnapshot: row.charge_policy_snapshot,
      overRequestLimit: row.over_request_limit === 1
    }));
  }

  private finalizeReservation(
    reservationId: string,
    usage: TokenUsage | undefined,
    now: Date
  ): FinalizeResult {
    const result = runInTransaction(this.db, "BEGIN IMMEDIATE", () => {
      const row = this.reservationById(reservationId);
      if (!row) {
        throw new Error(`Token reservation not found: ${reservationId}`);
      }
      if (row.finalized_at) {
        return finalizedRowResult(row);
      }

      const final = finalUsageForRow(row, usage);
      const overRequestLimit =
        (row.max_prompt_tokens_per_request !== null &&
          final.promptTokens > row.max_prompt_tokens_per_request) ||
        (row.max_total_tokens_per_request !== null &&
          final.totalTokens > row.max_total_tokens_per_request);

      this.db
        .prepare(
          `UPDATE token_reservations
           SET finalized_at = ?,
               final_prompt_tokens = ?,
               final_completion_tokens = ?,
               final_total_tokens = ?,
               final_cached_prompt_tokens = ?,
               final_estimated_tokens = ?,
               final_usage_source = ?,
               over_request_limit = ?
           WHERE id = ?
             AND finalized_at IS NULL`
        )
        .run(
          now.toISOString(),
          final.promptTokens,
          final.completionTokens,
          final.totalTokens,
          final.cachedPromptTokens,
          final.estimatedTokens,
          final.source,
          overRequestLimit ? 1 : 0,
          row.id
        );

      this.addUsageToWindow(row.subject_id, "minute", row.minute_window_start, final, now);
      this.addUsageToWindow(row.subject_id, "day", row.day_window_start, final, now);
      this.addUsageToWindow(row.subject_id, "month", row.month_window_start, final, now);

      return {
        reservationId: row.id,
        kind: row.kind,
        finalTotalTokens: final.totalTokens,
        finalUsageSource: final.source,
        overRequestLimit
      };
    });

    if (result.overRequestLimit) {
      this.insertAuditBestEffort("token-overrun", {
        reservation_id: result.reservationId,
        final_total_tokens: result.finalTotalTokens
      });
    }

    return result;
  }

  private insertReservation(input: {
    id: string;
    requestId: string;
    kind: "reservation" | "soft_write";
    credentialId: string;
    subjectId: string;
    scope: Scope;
    upstreamAccountId: string | null;
    provider: ProviderKind | null;
    now: Date;
    expiresAt: Date | null;
    estimatedPromptTokens: number;
    estimatedTotalTokens: number;
    reservedTokens: number;
    chargePolicySnapshot: TokenLimitPolicy["missingUsageCharge"];
    maxPromptTokensPerRequest: number | null;
    maxTotalTokensPerRequest: number | null;
    policy: TokenLimitPolicy | null;
    windows: WindowBoundaries;
  }): void {
    this.db
      .prepare(
        `INSERT INTO token_reservations (
          id, request_id, kind, credential_id, subject_id, scope, upstream_account_id, provider,
          created_at, expires_at, estimated_prompt_tokens, estimated_total_tokens,
          reserved_tokens, charge_policy_snapshot, max_prompt_tokens_per_request,
          max_total_tokens_per_request, minute_window_start, day_window_start, month_window_start,
          policy_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.id,
        input.requestId,
        input.kind,
        input.credentialId,
        input.subjectId,
        input.scope,
        input.upstreamAccountId,
        input.provider,
        input.now.toISOString(),
        input.expiresAt?.toISOString() ?? null,
        input.estimatedPromptTokens,
        input.estimatedTotalTokens,
        input.reservedTokens,
        input.chargePolicySnapshot,
        input.maxPromptTokensPerRequest,
        input.maxTotalTokensPerRequest,
        input.windows.minute.toISOString(),
        input.windows.day.toISOString(),
        input.windows.month.toISOString(),
        input.policy ? JSON.stringify(input.policy) : null
      );
  }

  private reservationById(id: string): ReservationRow | null {
    const row = this.db
      .prepare(
        `SELECT ${reservationColumns()}
         FROM token_reservations
         WHERE id = ?`
      )
      .get(id) as ReservationRow | undefined;
    return row ?? null;
  }

  private reservationByRequestId(requestId: string): ReservationRow | null {
    const row = this.db
      .prepare(
        `SELECT ${reservationColumns()}
         FROM token_reservations
         WHERE request_id = ?`
      )
      .get(requestId) as ReservationRow | undefined;
    return row ?? null;
  }

  private windowRejection(input: {
    subjectId: string;
    kind: "minute" | "day" | "month";
    windowStart: Date;
    limit: number | null;
    reservedTokens: number;
    now: Date;
  }): LimitRejection | null {
    if (input.limit === null) {
      return null;
    }
    const used = this.windowUsed(input.subjectId, input.kind, input.windowStart);
    const reserved = this.activeReserved(input.subjectId, input.kind, input.windowStart, input.now);
    if (used + reserved + input.reservedTokens <= input.limit) {
      return null;
    }
    const limitKind = `token_${input.kind}` as LimitKind;
    return tokenRejection(
      limitKind,
      `Token ${input.kind} budget exceeded.`,
      Math.max(1, Math.ceil((windowEnd(input.kind, input.windowStart).getTime() - input.now.getTime()) / 1000))
    );
  }

  private readUsageWindow(
    subjectId: string,
    kind: "minute" | "day" | "month",
    windowStart: Date,
    limit: number | null,
    now: Date
  ) {
    const used = this.windowUsed(subjectId, kind, windowStart);
    const reserved = this.activeReserved(subjectId, kind, windowStart, now);
    return {
      limit,
      used,
      reserved,
      remaining: limit === null ? null : Math.max(0, limit - used - reserved),
      windowStart: windowStart.toISOString()
    };
  }

  private windowUsed(
    subjectId: string,
    kind: "minute" | "day" | "month",
    windowStart: Date | string
  ): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(total_tokens, 0) AS used
         FROM token_windows
         WHERE subject_id = ?
           AND window_kind = ?
           AND window_start = ?`
      )
      .get(subjectId, kind, iso(windowStart)) as { used: number } | undefined;
    return row?.used ?? 0;
  }

  private activeReserved(
    subjectId: string,
    kind: "minute" | "day" | "month",
    windowStart: Date | string,
    now: Date
  ): number {
    const column = `${kind}_window_start`;
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(reserved_tokens), 0) AS reserved
         FROM token_reservations
         WHERE subject_id = ?
           AND kind = 'reservation'
           AND finalized_at IS NULL
           AND expires_at IS NOT NULL
           AND expires_at > ?
           AND ${column} = ?`
      )
      .get(subjectId, now.toISOString(), iso(windowStart)) as { reserved: number } | undefined;
    return row?.reserved ?? 0;
  }

  private addUsageToWindow(
    subjectId: string,
    kind: "minute" | "day" | "month",
    windowStart: string,
    usage: FinalUsage,
    now: Date
  ): void {
    this.db
      .prepare(
        `INSERT INTO token_windows (
          subject_id, window_kind, window_start, prompt_tokens, completion_tokens,
          total_tokens, cached_prompt_tokens, estimated_tokens, requests, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
        ON CONFLICT(subject_id, window_kind, window_start) DO UPDATE SET
          prompt_tokens = prompt_tokens + excluded.prompt_tokens,
          completion_tokens = completion_tokens + excluded.completion_tokens,
          total_tokens = total_tokens + excluded.total_tokens,
          cached_prompt_tokens = cached_prompt_tokens + excluded.cached_prompt_tokens,
          estimated_tokens = estimated_tokens + excluded.estimated_tokens,
          requests = requests + 1,
          updated_at = excluded.updated_at`
      )
      .run(
        subjectId,
        kind,
        windowStart,
        usage.promptTokens,
        usage.completionTokens,
        usage.totalTokens,
        usage.cachedPromptTokens,
        usage.estimatedTokens,
        now.toISOString()
      );
  }

  private insertAuditBestEffort(
    action: "token-overrun" | "token-reservation-expired",
    params: Record<string, unknown>
  ): void {
    try {
      this.db
        .prepare(
          `INSERT INTO admin_audit_events (
            id, action, target_user_id, target_credential_id, target_credential_prefix,
            status, params_json, error_message, created_at
          ) VALUES (?, ?, ?, ?, ?, 'ok', ?, NULL, ?)`
        )
        .run(
          `audit_${randomUUID()}`,
          action,
          null,
          null,
          null,
          JSON.stringify(params),
          new Date().toISOString()
        );
    } catch (err) {
      this.logger?.warn(
        {
          action,
          error: err instanceof Error ? err.message : String(err)
        },
        "Token budget audit insert failed after token accounting commit."
      );
    }
  }
}

export function createSqliteTokenBudgetLimiter(
  options: SqliteTokenBudgetLimiterOptions
): SqliteTokenBudgetLimiter {
  return new SqliteTokenBudgetLimiter(options);
}

interface FinalUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedPromptTokens: number;
  estimatedTokens: number;
  source: FinalizeResult["finalUsageSource"];
}

function finalUsageForRow(row: ReservationRow, usage: TokenUsage | undefined): FinalUsage {
  if (usage) {
    return {
      promptTokens: nonNegativeInteger(usage.promptTokens),
      completionTokens: nonNegativeInteger(usage.completionTokens),
      totalTokens: nonNegativeInteger(usage.totalTokens),
      cachedPromptTokens: nonNegativeInteger(usage.cachedPromptTokens ?? 0),
      estimatedTokens: 0,
      source: row.kind === "soft_write" ? "soft_write" : "provider"
    };
  }

  if (row.kind === "soft_write" || row.charge_policy_snapshot === "none") {
    return {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      cachedPromptTokens: 0,
      estimatedTokens: 0,
      source: "none"
    };
  }

  if (row.charge_policy_snapshot === "estimate") {
    return {
      promptTokens: row.estimated_prompt_tokens,
      completionTokens: 0,
      totalTokens: row.estimated_total_tokens,
      cachedPromptTokens: 0,
      estimatedTokens: row.estimated_total_tokens,
      source: "estimate"
    };
  }

  return {
    promptTokens: 0,
    completionTokens: Math.max(0, row.reserved_tokens - row.estimated_prompt_tokens),
    totalTokens: row.reserved_tokens,
    cachedPromptTokens: 0,
    estimatedTokens: row.estimated_total_tokens,
    source: "reserve"
  };
}

function finalizedRowResult(row: ReservationRow): FinalizeResult {
  return {
    reservationId: row.id,
    kind: row.kind,
    finalTotalTokens: row.final_total_tokens,
    finalUsageSource: row.final_usage_source ?? "none",
    overRequestLimit: row.over_request_limit === 1
  };
}

function validateTokenPolicy(policy: TokenLimitPolicy): TokenLimitPolicy {
  const missingUsageCharge = policy.missingUsageCharge;
  if (
    missingUsageCharge !== "none" &&
    missingUsageCharge !== "estimate" &&
    missingUsageCharge !== "reserve"
  ) {
    throw new Error("token.missingUsageCharge must be none, estimate, or reserve.");
  }

  return {
    tokensPerMinute: nullableNonNegativeInteger(policy.tokensPerMinute, "tokensPerMinute"),
    tokensPerDay: nullableNonNegativeInteger(policy.tokensPerDay, "tokensPerDay"),
    tokensPerMonth: nullableNonNegativeInteger(policy.tokensPerMonth, "tokensPerMonth"),
    maxPromptTokensPerRequest: nullableNonNegativeInteger(
      policy.maxPromptTokensPerRequest,
      "maxPromptTokensPerRequest"
    ),
    maxTotalTokensPerRequest: nullableNonNegativeInteger(
      policy.maxTotalTokensPerRequest,
      "maxTotalTokensPerRequest"
    ),
    reserveTokensPerRequest: nonNegativeInteger(policy.reserveTokensPerRequest),
    missingUsageCharge
  };
}

function nullableNonNegativeInteger(value: number | null, field: string): number | null {
  if (value === null) {
    return null;
  }
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`token.${field} must be a non-negative integer or null.`);
  }
  return value;
}

function nonNegativeInteger(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.floor(value));
}

function tokenRejection(
  limitKind: LimitKind,
  message: string,
  retryAfterSeconds?: number
): LimitRejection {
  return {
    ok: false,
    limitKind,
    error: new GatewayError({
      code: "rate_limited",
      message,
      httpStatus: 429,
      retryAfterSeconds
    })
  };
}

function runInTransaction<T>(
  db: DatabaseSync,
  begin: "BEGIN" | "BEGIN IMMEDIATE",
  fn: () => T
): T {
  db.exec(begin);
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

function reservationColumns(): string {
  return [
    "id",
    "request_id",
    "kind",
    "credential_id",
    "subject_id",
    "scope",
    "upstream_account_id",
    "provider",
    "created_at",
    "expires_at",
    "finalized_at",
    "estimated_prompt_tokens",
    "estimated_total_tokens",
    "reserved_tokens",
    "final_prompt_tokens",
    "final_completion_tokens",
    "final_total_tokens",
    "final_cached_prompt_tokens",
    "final_estimated_tokens",
    "final_usage_source",
    "charge_policy_snapshot",
    "minute_window_start",
    "day_window_start",
    "month_window_start",
    "max_prompt_tokens_per_request",
    "max_total_tokens_per_request",
    "over_request_limit"
  ].join(", ");
}

function windowBoundaries(date: Date): WindowBoundaries {
  return {
    minute: new Date(
      Date.UTC(
        date.getUTCFullYear(),
        date.getUTCMonth(),
        date.getUTCDate(),
        date.getUTCHours(),
        date.getUTCMinutes()
      )
    ),
    day: new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())),
    month: new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1))
  };
}

function windowEnd(kind: "minute" | "day" | "month", start: Date): Date {
  if (kind === "minute") {
    return new Date(start.getTime() + 60_000);
  }
  if (kind === "day") {
    return new Date(
      Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate() + 1)
    );
  }
  return new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
}

function iso(value: Date | string): string {
  return typeof value === "string" ? value : value.toISOString();
}
