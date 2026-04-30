import type { DatabaseSync } from "node:sqlite";
import type {
  AdminAuditEventRecord,
  ListAdminAuditEventsInput
} from "@codex-gateway/core";
import { adminAuditEventColumns } from "./columns.js";
import { rowToAdminAuditEvent } from "./row-mappers.js";

export function insert(
  db: DatabaseSync,
  record: AdminAuditEventRecord
): AdminAuditEventRecord {
  db.prepare(
    `INSERT INTO admin_audit_events (
      id, action, target_user_id, target_credential_id, target_credential_prefix,
      status, params_json, error_message, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    record.id,
    record.action,
    record.targetUserId,
    record.targetCredentialId,
    record.targetCredentialPrefix,
    record.status,
    record.params ? JSON.stringify(record.params) : null,
    record.errorMessage,
    record.createdAt.toISOString()
  );

  return record;
}

export function list(
  db: DatabaseSync,
  input: ListAdminAuditEventsInput = {}
): AdminAuditEventRecord[] {
  const clauses: string[] = [];
  const params: Array<string | number> = [];
  if (input.userId) {
    clauses.push("target_user_id = ?");
    params.push(input.userId);
  }
  if (input.action) {
    clauses.push("action = ?");
    params.push(input.action);
  }
  if (input.status) {
    clauses.push("status = ?");
    params.push(input.status);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = db
    .prepare(
      `SELECT ${adminAuditEventColumns}
       FROM admin_audit_events
       ${where}
       ORDER BY created_at DESC, id DESC
       LIMIT ?`
    )
    .all(...params, input.limit ?? 100);

  return rows.map(rowToAdminAuditEvent);
}
