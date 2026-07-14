import { existsSync, readFileSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

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
    return {
      schemaVersion: 1,
      generatedAt: now.toISOString(),
      runtime: runtime.value,
      runtimeSnapshotStatus: runtime.status,
      windows: {
        "5m": requestWindow(db, now, 5),
        "15m": requestWindow(db, now, 15)
      },
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

function requestWindow(db: DatabaseSync, now: Date, minutes: number): RequestWindowSnapshot {
  if (!tableExists(db, "request_events")) {
    return emptyWindow(minutes);
  }
  const since = new Date(now.getTime() - minutes * 60_000).toISOString();
  const attemptsColumn = columnExists(db, "request_events", "upstream_attempts_json")
    ? "upstream_attempts_json"
    : "NULL AS upstream_attempts_json";
  const rows = db
    .prepare(
      `SELECT subject_id, upstream_account_id, public_model_id, duration_ms, first_byte_ms,
              status, error_code, rate_limited, limit_kind, ${attemptsColumn}
       FROM request_events
       WHERE started_at >= ? AND started_at <= ?`
    )
    .all(since, now.toISOString()) as unknown as RequestEventRow[];

  const snapshot = emptyWindow(minutes);
  const affectedUsers = new Set<string>();
  const infrastructureAffectedUsers = new Set<string>();
  const durations: number[] = [];
  const firstBytes: number[] = [];
  for (const row of rows) {
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
  return snapshot;
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
