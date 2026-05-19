import type { DatabaseSync } from "node:sqlite";
import type {
  BillingAdminTokenRecord,
  ListBillingAdminTokensInput
} from "@codex-gateway/core";
import { billingAdminTokenColumns } from "./columns.js";
import { rowToBillingAdminToken } from "./row-mappers.js";

export function insert(
  db: DatabaseSync,
  record: BillingAdminTokenRecord
): BillingAdminTokenRecord {
  db.prepare(
    `INSERT INTO billing_admin_tokens (
      id, prefix, hash, label, kind, state, expires_at, revoked_at,
      created_at, last_used_at, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    record.id,
    record.prefix,
    record.hash,
    record.label,
    record.kind,
    record.state,
    record.expiresAt.toISOString(),
    record.revokedAt?.toISOString() ?? null,
    record.createdAt.toISOString(),
    record.lastUsedAt?.toISOString() ?? null,
    record.metadata ? JSON.stringify(record.metadata) : null
  );

  return record;
}

export function getByPrefix(
  db: DatabaseSync,
  prefix: string
): BillingAdminTokenRecord | null {
  const row = db
    .prepare(
      `SELECT ${billingAdminTokenColumns}
       FROM billing_admin_tokens
       WHERE prefix = ?`
    )
    .get(prefix);

  return row ? rowToBillingAdminToken(row) : null;
}

export function list(
  db: DatabaseSync,
  input: ListBillingAdminTokensInput = {}
): BillingAdminTokenRecord[] {
  const conditions: string[] = [];
  const params: Array<string | number> = [];

  if (input.activeOnly) {
    conditions.push("state = 'active'");
    conditions.push("revoked_at IS NULL");
    conditions.push("expires_at > ?");
    params.push(new Date().toISOString());
  } else if (input.state) {
    conditions.push("state = ?");
    params.push(input.state);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = input.limit ?? 100;
  const rows = db
    .prepare(
      `SELECT ${billingAdminTokenColumns}
       FROM billing_admin_tokens
       ${where}
       ORDER BY created_at DESC
       LIMIT ?`
    )
    .all(...params, limit);

  return rows.map(rowToBillingAdminToken);
}

export function revokeByPrefix(
  db: DatabaseSync,
  prefix: string,
  now: Date = new Date()
): BillingAdminTokenRecord | null {
  db.prepare(
    `UPDATE billing_admin_tokens
     SET state = 'revoked',
         revoked_at = COALESCE(revoked_at, ?)
     WHERE prefix = ?`
  ).run(now.toISOString(), prefix);

  return getByPrefix(db, prefix);
}

export function updateLastUsedAt(
  db: DatabaseSync,
  prefix: string,
  now: Date = new Date()
): void {
  const nowText = now.toISOString();
  const threshold = new Date(now.getTime() - 60_000).toISOString();
  db.prepare(
    `UPDATE billing_admin_tokens
     SET last_used_at = ?
     WHERE prefix = ?
       AND (last_used_at IS NULL OR last_used_at < ?)`
  ).run(nowText, prefix, threshold);
}
