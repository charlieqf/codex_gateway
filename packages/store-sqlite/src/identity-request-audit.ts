import type { DatabaseSync, StatementSync } from "node:sqlite";
import {
  identityAuditOperations, identityAuditStages,
  type IdentityRequestEvent, type IdentityRateLimitEvent
} from "@codex-gateway/core";

// These values are source-controlled enums, never request-provided SQL.
const enumSql = (values: readonly string[]) => values.map(value => `'${value}'`).join(",");
export const identityRequestAuditSchema = `
  CREATE TABLE identity_request_events (
    request_id TEXT PRIMARY KEY CHECK(length(request_id) BETWEEN 1 AND 128),
    operation TEXT NOT NULL CHECK(operation IN (${enumSql(identityAuditOperations)})),
    method TEXT NOT NULL CHECK(length(method) <= 16),
    route_template TEXT NOT NULL CHECK(length(route_template) <= 256),
    started_at TEXT NOT NULL, completed_at TEXT NOT NULL,
    duration_ms REAL NOT NULL CHECK(duration_ms >= 0),
    http_status INTEGER CHECK(http_status BETWEEN 100 AND 599),
    transport_outcome TEXT NOT NULL CHECK(transport_outcome IN ('responded','aborted')),
    outcome TEXT NOT NULL CHECK(outcome IN ('succeeded','accepted','rejected','failed','aborted')),
    error_code TEXT CHECK(length(error_code) <= 96), reason_code TEXT CHECK(length(reason_code) <= 96),
    stage TEXT CHECK(stage IN (${enumSql(identityAuditStages)})),
    phone_input TEXT CHECK(length(phone_input) <= 64),
    phone_normalized TEXT CHECK(length(phone_normalized) <= 16),
    phone_capture_status TEXT NOT NULL CHECK(phone_capture_status IN ('not_available','absent','captured','invalid_type','unsafe_value')),
    provider TEXT CHECK(length(provider) <= 128), external_user_id TEXT CHECK(length(external_user_id) <= 256),
    subject_id TEXT CHECK(length(subject_id) <= 128), target_subject_id TEXT CHECK(length(target_subject_id) <= 128),
    conflicting_subject_id TEXT CHECK(length(conflicting_subject_id) <= 128),
    resolved_phone TEXT CHECK(length(resolved_phone) <= 16),
    session_id TEXT CHECK(length(session_id) <= 128), job_id TEXT CHECK(length(job_id) <= 128),
    client_version TEXT CHECK(length(client_version) <= 64),
    CHECK((transport_outcome = 'aborted' AND http_status IS NULL AND outcome = 'aborted')
       OR (transport_outcome = 'responded' AND http_status IS NOT NULL AND outcome != 'aborted'))
  ) STRICT;
  CREATE INDEX idx_identity_request_completed ON identity_request_events(completed_at);
  CREATE INDEX idx_identity_request_phone ON identity_request_events(phone_normalized, completed_at)
    WHERE phone_normalized IS NOT NULL;
  CREATE INDEX idx_identity_request_resolved_phone ON identity_request_events(resolved_phone, completed_at)
    WHERE resolved_phone IS NOT NULL;
  CREATE INDEX idx_identity_request_external ON identity_request_events(provider, external_user_id, completed_at)
    WHERE provider IS NOT NULL AND external_user_id IS NOT NULL;
  CREATE INDEX idx_identity_request_subject ON identity_request_events(subject_id, completed_at)
    WHERE subject_id IS NOT NULL;
  CREATE INDEX idx_identity_request_job ON identity_request_events(job_id, completed_at)
    WHERE job_id IS NOT NULL;
  CREATE TABLE identity_rate_limit_minutes (
    minute_start TEXT NOT NULL,
    operation TEXT NOT NULL CHECK(operation = 'phone_login'),
    limit_dimension TEXT NOT NULL CHECK(limit_dimension IN ('phone','ip','device')),
    limit_kind TEXT NOT NULL CHECK(limit_kind = 'request_minute'),
    origin TEXT NOT NULL CHECK(origin = 'gateway'),
    error_code TEXT NOT NULL CHECK(error_code = 'auth_rate_limited'),
    rejection_count INTEGER NOT NULL CHECK(rejection_count > 0),
    first_at TEXT NOT NULL, last_at TEXT NOT NULL,
    first_request_id TEXT NOT NULL CHECK(length(first_request_id) <= 128),
    last_request_id TEXT NOT NULL CHECK(length(last_request_id) <= 128),
    first_phone_input TEXT CHECK(length(first_phone_input) <= 64),
    first_phone_normalized TEXT CHECK(length(first_phone_normalized) <= 16),
    last_phone_input TEXT CHECK(length(last_phone_input) <= 64),
    last_phone_normalized TEXT CHECK(length(last_phone_normalized) <= 16),
    PRIMARY KEY(minute_start, operation, limit_dimension, limit_kind, origin, error_code)
  ) STRICT;
`;

const columns: ReadonlyArray<readonly [string, keyof IdentityRequestEvent]> = [
  ["request_id", "requestId"], ["operation", "operation"], ["method", "method"],
  ["route_template", "routeTemplate"], ["started_at", "startedAt"], ["completed_at", "completedAt"],
  ["duration_ms", "durationMs"], ["http_status", "httpStatus"], ["transport_outcome", "transportOutcome"],
  ["outcome", "outcome"], ["error_code", "errorCode"], ["reason_code", "reasonCode"], ["stage", "stage"],
  ["phone_input", "phoneInput"], ["phone_normalized", "phoneNormalized"], ["phone_capture_status", "phoneCaptureStatus"],
  ["provider", "provider"], ["external_user_id", "externalUserId"], ["subject_id", "subjectId"],
  ["target_subject_id", "targetSubjectId"], ["conflicting_subject_id", "conflictingSubjectId"],
  ["resolved_phone", "resolvedPhone"], ["session_id", "sessionId"], ["job_id", "jobId"], ["client_version", "clientVersion"]
];
const statements = new WeakMap<DatabaseSync, { request: StatementSync; minute: StatementSync }>();
function prepared(db: DatabaseSync) {
  let cached = statements.get(db);
  if (!cached) {
    cached = {
      request: db.prepare(`INSERT INTO identity_request_events (${columns.map(([column]) => column).join(",")})
        VALUES (${columns.map(() => "?").join(",")}) ON CONFLICT(request_id) DO NOTHING`),
      minute: db.prepare(`INSERT INTO identity_rate_limit_minutes
        (minute_start,operation,limit_dimension,limit_kind,origin,error_code,rejection_count,
         first_at,last_at,first_request_id,last_request_id,first_phone_input,first_phone_normalized,last_phone_input,last_phone_normalized)
        VALUES (?,?,?,?,?,?,1,?,?,?,?,?,?,?,?)
        ON CONFLICT(minute_start,operation,limit_dimension,limit_kind,origin,error_code) DO UPDATE SET
          rejection_count = rejection_count + 1,
          first_request_id = CASE WHEN excluded.first_at < first_at THEN excluded.first_request_id ELSE first_request_id END,
          first_phone_input = CASE WHEN excluded.first_at < first_at THEN excluded.first_phone_input ELSE first_phone_input END,
          first_phone_normalized = CASE WHEN excluded.first_at < first_at THEN excluded.first_phone_normalized ELSE first_phone_normalized END,
          last_request_id = CASE WHEN excluded.last_at >= last_at THEN excluded.last_request_id ELSE last_request_id END,
          last_phone_input = CASE WHEN excluded.last_at >= last_at THEN excluded.last_phone_input ELSE last_phone_input END,
          last_phone_normalized = CASE WHEN excluded.last_at >= last_at THEN excluded.last_phone_normalized ELSE last_phone_normalized END,
          first_at = min(first_at,excluded.first_at), last_at = max(last_at,excluded.last_at)`)
    };
    statements.set(db, cached);
  }
  return cached;
}
export function recordRequest(db: DatabaseSync, event: IdentityRequestEvent): void {
  prepared(db).request.run(...columns.map(([, key]) => event[key]));
}
export function recordRateLimit(db: DatabaseSync, event: IdentityRateLimitEvent): void {
  const minute = new Date(Math.floor(Date.parse(event.completedAt) / 60_000) * 60_000).toISOString();
  prepared(db).minute.run(minute, event.operation, event.limitDimension, event.limitKind, event.origin,
    event.errorCode, event.completedAt, event.completedAt, event.requestId, event.requestId,
    event.phoneInput, event.phoneNormalized, event.phoneInput, event.phoneNormalized);
}
export function prune(db: DatabaseSync, now: Date, batchSize = 500): { requests: number; minutes: number } {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 5_000 || !Number.isFinite(now.getTime())) {
    throw new Error("Invalid identity audit retention input.");
  }
  const requests = db.prepare(`DELETE FROM identity_request_events WHERE rowid IN
    (SELECT rowid FROM identity_request_events WHERE completed_at < ? ORDER BY completed_at LIMIT ?)`)
    .run(new Date(now.getTime() - 30 * 86_400_000).toISOString(), batchSize).changes;
  const minutes = db.prepare(`DELETE FROM identity_rate_limit_minutes WHERE rowid IN
    (SELECT rowid FROM identity_rate_limit_minutes WHERE minute_start < ? ORDER BY minute_start LIMIT ?)`)
    .run(new Date(now.getTime() - 7 * 86_400_000).toISOString(), batchSize).changes;
  return { requests: Number(requests), minutes: Number(minutes) };
}
