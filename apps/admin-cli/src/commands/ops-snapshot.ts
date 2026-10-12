import { existsSync, readFileSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { diagnoseTimeout, isProviderFailureClassification, type TimeoutDiagnostic } from "@codex-gateway/core";

const infrastructureErrorCodes = new Set([
  "upstream_timeout",
  "upstream_unavailable",
  "service_unavailable",
  "provider_reauth_required",
  "subscription_unavailable"
]);

const userErrorCodes = new Set([
  "missing_credential",
  "invalid_credential",
  "revoked_credential",
  "expired_credential",
  "client_aborted",
  "context_length_exceeded",
  "model_not_found",
  "invalid_request"
]);

export interface OpsSnapshotOptions {
  dbPath: string;
  runtimeSnapshotPath?: string | null;
  now?: Date;
}

export interface OpsSnapshot {
  schemaVersion: 1;
  generatedAt: string;
  runtime: unknown;
  runtimeSnapshotStatus: "ok" | "missing" | "invalid";
  windows: Record<string, RequestWindowSnapshot>;
  timeoutAlerts: TimeoutAlert[];
  upstreamAccounts: Array<{
    id: string;
    provider: string;
    state: string;
    cooldownUntil: string | null;
    lastUsedAt: string | null;
  }>;
  databaseFiles: {
    databaseBytes: number;
    walBytes: number;
    shmBytes: number;
  };
}

interface RequestWindowSnapshot {
  minutes: number;
  timeBasis: "completed_at_derived";
  missingDuration: number;
  modelCalls: {
    total: number; ok: number; errors: number; clientAborted: number;
    timeoutRateDenominator: number; timeouts: number; timeoutRate: number | null;
    p95DurationMs: number | null;
    byTimeoutPhase: Record<string, number>;
  };
  total: number;
  ok: number;
  errors: number;
  affectedUsers: number;
  infrastructureAffectedUsers: number;
  infrastructureErrors: number;
  userErrors: number;
  upstreamRateLimited: number;
  userRateLimited: number;
  rateLimitOriginUnknown: number;
  otherErrors: number;
  maxDurationMs: number | null;
  maxFirstByteMs: number | null;
  p95DurationMs: number | null;
  p95FirstByteMs: number | null;
  firstByteOver300Seconds: number;
  durationOver600Seconds: number;
  byErrorCode: Record<string, number>;
  byModel: Record<string, number>;
  byUpstreamAccount: Record<string, number>;
}

interface RequestEventRow {
  request_id: string;
  started_at: string;
  subject_id: string | null;
  upstream_account_id: string | null;
  public_model_id: string | null;
  duration_ms: number | null;
  first_byte_ms: number | null;
  status: string;
  error_code: string | null;
  rate_limited: number;
  limit_kind: string | null;
  upstream_attempts_json: string | null;
  terminal_source: string | null;
  upstream_runtime: string | null;
  upstream_failure_origin: string | null;
  upstream_failure_kind: string | null;
  upstream_failure_stage: string | null;
  upstream_transport_code: string | null;
  upstream_http_status: number | null;
}

export interface TimeoutAlert {
  id: string;
  kind: "timeout_event" | "repeated_user_timeout" | "channel_timeouts";
  severity: "info" | "warning";
  windowMinutes: number;
  requests: number;
  affectedUsers: number;
  model: string | null;
  runtime: string | null;
  requestIds: string[];
  diagnosis?: TimeoutDiagnostic | null;
  message: string;
}

interface UpstreamAccountRow {
  id: string;
  provider: string;
  state: string;
  cooldown_until: string | null;
  last_used_at: string | null;
}

export function buildOpsSnapshot(options: OpsSnapshotOptions): OpsSnapshot {
  if (options.dbPath !== ":memory:" && !existsSync(options.dbPath)) {
    throw new Error(`Gateway SQLite database does not exist: ${options.dbPath}`);
  }
  const db = new DatabaseSync(options.dbPath, { readOnly: true, timeout: 1_000 });
  try {
    db.exec("PRAGMA query_only = ON");
    const now = options.now ?? new Date();
    const runtime = readRuntimeSnapshot(options.runtimeSnapshotPath);
    const recent = completedRequests(db, now, 30);
    return {
      schemaVersion: 1,
      generatedAt: now.toISOString(),
      runtime: runtime.value,
      runtimeSnapshotStatus: runtime.status,
      windows: {
        "5m": requestWindow(recent, now, 5),
        "15m": requestWindow(recent, now, 15)
      },
      timeoutAlerts: timeoutAlerts(recent, now),
      upstreamAccounts: readUpstreamAccounts(db),
      databaseFiles: {
        databaseBytes: fileSize(options.dbPath),
        walBytes: fileSize(`${options.dbPath}-wal`),
        shmBytes: fileSize(`${options.dbPath}-shm`)
      }
    };
  } finally {
    db.close();
  }
}

function completedRequests(db: DatabaseSync, now: Date, minutes: number): RequestEventRow[] {
  if (!tableExists(db, "request_events")) {
    return [];
  }
  const optional = ["upstream_attempts_json", "terminal_source", "upstream_runtime",
    "upstream_failure_origin", "upstream_failure_kind", "upstream_failure_stage",
    "upstream_transport_code", "upstream_http_status"]
    .map(column => columnExists(db, "request_events", column) ? column : `NULL AS ${column}`).join(", ");
  // Matches idx_request_events_completed_ms. No fixed lookback that loses long requests.
  // Unknown durations use start time and are explicitly counted as uncertain below.
  return db
    .prepare(
      `SELECT request_id, started_at, subject_id, upstream_account_id, public_model_id, duration_ms, first_byte_ms,
              status, error_code, rate_limited, limit_kind, ${optional}
       FROM request_events
       WHERE CAST(ROUND((julianday(started_at) - 2440587.5) * 86400000) AS INTEGER) + MAX(COALESCE(duration_ms, 0), 0)
         BETWEEN ? AND ?`
    )
    .all(now.getTime() - minutes * 60_000, now.getTime()) as unknown as RequestEventRow[];
}

function requestWindow(recent: RequestEventRow[], now: Date, minutes: number): RequestWindowSnapshot {
  const rows = recent.filter(row => completedAt(row) >= now.getTime() - minutes * 60_000);
  const snapshot = emptyWindow(minutes);
  const affectedUsers = new Set<string>();
  const infrastructureAffectedUsers = new Set<string>();
  const durations: number[] = [];
  const firstBytes: number[] = [];
  const modelDurations: number[] = [];
  for (const row of rows) {
    if (row.duration_ms === null) snapshot.missingDuration += 1;
    if (isModelCall(row)) {
      const model = snapshot.modelCalls;
      model.total += 1;
      if (row.status === "ok") model.ok += 1; else model.errors += 1;
      if (row.error_code === "client_aborted") model.clientAborted += 1;
      else {
        model.timeoutRateDenominator += 1;
        if (row.duration_ms !== null) modelDurations.push(row.duration_ms);
      }
      if (row.error_code === "upstream_timeout") {
        model.timeouts += 1;
        increment(model.byTimeoutPhase, diagnosis(row)?.phase ?? "unknown");
      }
    }
    snapshot.total += 1;
    if (row.status === "ok") {
      snapshot.ok += 1;
    } else {
      snapshot.errors += 1;
      if (row.subject_id) {
        affectedUsers.add(row.subject_id);
      }
    }
    snapshot.maxDurationMs = maxNullable(snapshot.maxDurationMs, row.duration_ms);
    snapshot.maxFirstByteMs = maxNullable(snapshot.maxFirstByteMs, row.first_byte_ms);
    if (row.duration_ms !== null) {
      durations.push(row.duration_ms);
      if (row.duration_ms > 600_000) {
        snapshot.durationOver600Seconds += 1;
      }
    }
    if (row.first_byte_ms !== null) {
      firstBytes.push(row.first_byte_ms);
      if (row.first_byte_ms > 300_000) {
        snapshot.firstByteOver300Seconds += 1;
      }
    }
    increment(snapshot.byModel, row.public_model_id ?? "unknown");
    increment(snapshot.byUpstreamAccount, row.upstream_account_id ?? "unassigned");

    if (!row.error_code) {
      continue;
    }
    increment(snapshot.byErrorCode, row.error_code);
    if (row.error_code === "rate_limited") {
      if (row.limit_kind) {
        snapshot.userRateLimited += 1;
      } else if (row.upstream_account_id || hasUpstreamAttempts(row.upstream_attempts_json)) {
        snapshot.upstreamRateLimited += 1;
      } else {
        snapshot.rateLimitOriginUnknown += 1;
      }
    } else if (infrastructureErrorCodes.has(row.error_code)) {
      snapshot.infrastructureErrors += 1;
      if (row.subject_id) {
        infrastructureAffectedUsers.add(row.subject_id);
      }
    } else if (userErrorCodes.has(row.error_code)) {
      snapshot.userErrors += 1;
    } else {
      snapshot.otherErrors += 1;
    }
  }
  snapshot.affectedUsers = affectedUsers.size;
  snapshot.infrastructureAffectedUsers = infrastructureAffectedUsers.size;
  snapshot.p95DurationMs = percentile95(durations);
  snapshot.p95FirstByteMs = percentile95(firstBytes);
  snapshot.modelCalls.p95DurationMs = percentile95(modelDurations);
  snapshot.modelCalls.timeoutRate = snapshot.modelCalls.timeoutRateDenominator
    ? snapshot.modelCalls.timeouts / snapshot.modelCalls.timeoutRateDenominator : null;
  return snapshot;
}

function completedAt(row: RequestEventRow): number {
  return Date.parse(row.started_at) + Math.max(0, row.duration_ms ?? 0);
}

function isModelCall(row: RequestEventRow): boolean {
  // Only generation outcomes belong in the denominator, not credential/admission failures.
  return !!row.public_model_id && !row.limit_kind && (row.status === "ok" ||
    ["client_aborted", "upstream_timeout", "upstream_unavailable", "upstream_incomplete_stream",
      "upstream_empty_response", "tool_call_output_truncated", "tool_call_validation_failed",
      "output_length_exceeded", "content_policy_violation", "service_unavailable",
      "provider_reauth_required", "subscription_unavailable"].includes(row.error_code ?? "") ||
    (row.error_code === "rate_limited" && (!!row.upstream_account_id || hasUpstreamAttempts(row.upstream_attempts_json))));
}

function diagnosis(row: RequestEventRow): TimeoutDiagnostic | null {
  let attempts: unknown;
  try { attempts = JSON.parse(row.upstream_attempts_json ?? "null"); } catch { attempts = null; }
  const failure = { origin: row.upstream_failure_origin, kind: row.upstream_failure_kind,
    stage: row.upstream_failure_stage, transportCode: row.upstream_transport_code,
    upstreamStatus: row.upstream_http_status };
  return diagnoseTimeout({ errorCode: row.error_code, terminalSource: row.terminal_source, attempts,
    failure: isProviderFailureClassification(failure) ? failure : null });
}

function timeoutAlerts(rows: RequestEventRow[], now: Date): TimeoutAlert[] {
  const timeouts = rows.filter(row => isModelCall(row) && row.error_code === "upstream_timeout")
    .sort((a, b) => completedAt(b) - completedAt(a));
  const alerts: TimeoutAlert[] = timeouts.slice(0, 100).map(row => ({
    id: `timeout:${row.request_id}`, kind: "timeout_event", severity: "info", windowMinutes: 30,
    requests: 1, affectedUsers: row.subject_id ? 1 : 0, model: row.public_model_id,
    runtime: row.upstream_runtime, requestIds: [row.request_id], diagnosis: diagnosis(row),
    message: `Model request timed out: ${row.request_id} (${diagnosis(row)?.phase ?? "unknown"}).`
  }));
  const users = new Map<string, RequestEventRow[]>();
  for (const row of timeouts) {
    if (row.subject_id) appendGroup(users, row.subject_id, row);
  }
  for (const group of users.values()) {
    if (group.length < 2) continue;
    // Stable across arrivals without including a raw subject identifier in the alert.
    const identity = createHash("sha256").update(group[0].subject_id!).digest("hex").slice(0, 24);
    alerts.push({ id: `repeated:${identity}`, kind: "repeated_user_timeout", severity: "warning",
      windowMinutes: 30, requests: group.length, affectedUsers: 1, model: null, runtime: null,
      requestIds: group.slice(0, 10).map(row => row.request_id),
      message: `One user has ${group.length} model timeouts in 30 minutes; investigate the conversation.` });
  }
  const channels = new Map<string, RequestEventRow[]>();
  for (const row of rows.filter(row => isModelCall(row) && row.error_code !== "client_aborted" &&
    completedAt(row) >= now.getTime() - 15 * 60_000)) {
    const route = row.upstream_runtime || row.upstream_account_id;
    // Missing routing evidence must not merge unrelated failures into a channel incident.
    if (!route) continue;
    const key = JSON.stringify([row.public_model_id, route]);
    appendGroup(channels, key, row);
  }
  for (const group of channels.values()) {
    const failed = group.filter(row => row.error_code === "upstream_timeout");
    const affected = new Set(failed.map(row => row.subject_id).filter(Boolean)).size;
    if (failed.length < 3 || affected < 2 || (group.length >= 20 && failed.length / group.length < 0.1)) continue;
    alerts.push({ id: `channel:${group[0].public_model_id}:${group[0].upstream_runtime ?? group[0].upstream_account_id}`,
      kind: "channel_timeouts", severity: "warning", windowMinutes: 15, requests: failed.length,
      affectedUsers: affected, model: group[0].public_model_id, runtime: group[0].upstream_runtime,
      requestIds: failed.slice(0, 10).map(row => row.request_id),
      message: `${failed.length}/${group.length} model calls timed out across ${affected} users in 15 minutes; investigate the channel.` });
  }
  return alerts;
}

function appendGroup(groups: Map<string, RequestEventRow[]>, key: string, row: RequestEventRow): void {
  const group = groups.get(key);
  if (group) group.push(row); else groups.set(key, [row]);
}

function readUpstreamAccounts(db: DatabaseSync): OpsSnapshot["upstreamAccounts"] {
  if (!tableExists(db, "upstream_accounts")) {
    return [];
  }
  const rows = db
    .prepare(
      `SELECT id, provider, state, cooldown_until, last_used_at
       FROM upstream_accounts
       ORDER BY id`
    )
    .all() as unknown as UpstreamAccountRow[];
  return rows.map((row) => ({
    id: row.id,
    provider: row.provider,
    state: row.state,
    cooldownUntil: row.cooldown_until,
    lastUsedAt: row.last_used_at
  }));
}

function readRuntimeSnapshot(path: string | null | undefined): {
  status: OpsSnapshot["runtimeSnapshotStatus"];
  value: unknown;
} {
  if (!path?.trim() || !existsSync(path)) {
    return { status: "missing", value: null };
  }
  try {
    return { status: "ok", value: JSON.parse(readFileSync(path, "utf8")) as unknown };
  } catch {
    return { status: "invalid", value: null };
  }
}

function tableExists(db: DatabaseSync, table: string): boolean {
  const row = db
    .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) as { present?: number } | undefined;
  return row?.present === 1;
}

function columnExists(db: DatabaseSync, table: string, column: string): boolean {
  if (!tableExists(db, table)) {
    return false;
  }
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{
    name: string;
  }>;
  return rows.some((row) => row.name === column);
}

function emptyWindow(minutes: number): RequestWindowSnapshot {
  return {
    minutes,
    timeBasis: "completed_at_derived",
    missingDuration: 0,
    modelCalls: { total: 0, ok: 0, errors: 0, clientAborted: 0, timeoutRateDenominator: 0,
      timeouts: 0, timeoutRate: null, p95DurationMs: null, byTimeoutPhase: {} },
    total: 0,
    ok: 0,
    errors: 0,
    affectedUsers: 0,
    infrastructureAffectedUsers: 0,
    infrastructureErrors: 0,
    userErrors: 0,
    upstreamRateLimited: 0,
    userRateLimited: 0,
    rateLimitOriginUnknown: 0,
    otherErrors: 0,
    maxDurationMs: null,
    maxFirstByteMs: null,
    p95DurationMs: null,
    p95FirstByteMs: null,
    firstByteOver300Seconds: 0,
    durationOver600Seconds: 0,
    byErrorCode: {},
    byModel: {},
    byUpstreamAccount: {}
  };
}

function fileSize(path: string): number {
  if (path === ":memory:" || !existsSync(path)) {
    return 0;
  }
  return statSync(path).size;
}

function increment(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

function maxNullable(current: number | null, next: number | null): number | null {
  if (next === null) {
    return current;
  }
  return current === null ? next : Math.max(current, next);
}

function hasUpstreamAttempts(value: string | null): boolean {
  if (!value?.trim()) {
    return false;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) && parsed.length > 0;
  } catch {
    return false;
  }
}

function percentile95(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(sorted.length * 0.95) - 1);
  return sorted[index] ?? null;
}
