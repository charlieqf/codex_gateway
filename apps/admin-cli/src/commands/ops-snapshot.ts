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
  infrastructureErrors: number;
  userErrors: number;
  upstreamRateLimited: number;
  userRateLimited: number;
  otherErrors: number;
  maxDurationMs: number | null;
  maxFirstByteMs: number | null;
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
  const rows = db
    .prepare(
      `SELECT subject_id, upstream_account_id, public_model_id, duration_ms, first_byte_ms,
              status, error_code, rate_limited, limit_kind
       FROM request_events
       WHERE started_at >= ? AND started_at <= ?`
    )
    .all(since, now.toISOString()) as unknown as RequestEventRow[];

  const snapshot = emptyWindow(minutes);
  const affectedUsers = new Set<string>();
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
    increment(snapshot.byModel, row.public_model_id ?? "unknown");
    increment(snapshot.byUpstreamAccount, row.upstream_account_id ?? "unassigned");

    if (!row.error_code) {
      continue;
    }
    increment(snapshot.byErrorCode, row.error_code);
    if (row.error_code === "rate_limited") {
      if (row.limit_kind) {
        snapshot.userRateLimited += 1;
      } else {
        snapshot.upstreamRateLimited += 1;
      }
    } else if (infrastructureErrorCodes.has(row.error_code)) {
      snapshot.infrastructureErrors += 1;
    } else if (userErrorCodes.has(row.error_code)) {
      snapshot.userErrors += 1;
    } else {
      snapshot.otherErrors += 1;
    }
  }
  snapshot.affectedUsers = affectedUsers.size;
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

function emptyWindow(minutes: number): RequestWindowSnapshot {
  return {
    minutes,
    total: 0,
    ok: 0,
    errors: 0,
    affectedUsers: 0,
    infrastructureErrors: 0,
    userErrors: 0,
    upstreamRateLimited: 0,
    userRateLimited: 0,
    otherErrors: 0,
    maxDurationMs: null,
    maxFirstByteMs: null,
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
