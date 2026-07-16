import type { DatabaseSync } from "node:sqlite";
import {
  normalizeRateLimitPolicy,
  type AccessCredentialRecord,
  type ListAccessCredentialsInput,
  type UpdateAccessCredentialInput
} from "@codex-gateway/core";
import { accessCredentialColumns } from "./columns.js";
import { rowToAccessCredential } from "./row-mappers.js";

export function insert(
  db: DatabaseSync,
  record: AccessCredentialRecord
): AccessCredentialRecord {
  const normalizedRate = normalizeRateLimitPolicy(record.rate);
  db.prepare(
    `INSERT INTO access_credentials (
      id, prefix, hash, token_ciphertext, subject_id, label, scope, expires_at, revoked_at,
      rate_json, created_at, rotates_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    record.id,
    record.prefix,
    record.hash,
    record.tokenCiphertext ?? null,
    record.subjectId,
    record.label,
    record.scope,
    record.expiresAt.toISOString(),
    record.revokedAt?.toISOString() ?? null,
    JSON.stringify(normalizedRate),
    record.createdAt.toISOString(),
    record.rotatesId
  );

  return { ...record, rate: normalizedRate };
}

export function getByPrefix(
  db: DatabaseSync,
  prefix: string
): AccessCredentialRecord | null {
  const row = db
    .prepare(
      `SELECT ${accessCredentialColumns}
       FROM access_credentials
       WHERE prefix = ?`
    )
    .get(prefix);

  return row ? rowToAccessCredential(row) : null;
}

export function list(
  db: DatabaseSync,
  input: ListAccessCredentialsInput = {}
): AccessCredentialRecord[] {
  const includeRevoked = input.includeRevoked ?? true;
  const rows = input.subjectId
    ? db
        .prepare(
          `SELECT ${accessCredentialColumns}
           FROM access_credentials
           WHERE subject_id = ?
             AND (? = 1 OR revoked_at IS NULL)
           ORDER BY created_at DESC`
        )
        .all(input.subjectId, includeRevoked ? 1 : 0)
    : db
        .prepare(
          `SELECT ${accessCredentialColumns}
           FROM access_credentials
           WHERE (? = 1 OR revoked_at IS NULL)
           ORDER BY created_at DESC`
        )
        .all(includeRevoked ? 1 : 0);

  return rows.map(rowToAccessCredential);
}

export function updateByPrefix(
  db: DatabaseSync,
  prefix: string,
  input: UpdateAccessCredentialInput
): AccessCredentialRecord | null {
  const normalizedRate = input.rate ? normalizeRateLimitPolicy(input.rate) : null;
  db.prepare(
    `UPDATE access_credentials
     SET label = COALESCE(?, label),
         scope = COALESCE(?, scope),
         expires_at = COALESCE(?, expires_at),
         rate_json = COALESCE(?, rate_json)
     WHERE prefix = ?`
  ).run(
    input.label ?? null,
    input.scope ?? null,
    input.expiresAt?.toISOString() ?? null,
    normalizedRate ? JSON.stringify(normalizedRate) : null,
    prefix
  );

  return getByPrefix(db, prefix);
}

export function revokeByPrefix(
  db: DatabaseSync,
  prefix: string,
  now: Date = new Date()
): AccessCredentialRecord | null {
  db.prepare(
    `UPDATE access_credentials
     SET revoked_at = COALESCE(revoked_at, ?)
     WHERE prefix = ?`
  ).run(now.toISOString(), prefix);

  return getByPrefix(db, prefix);
}

export function setExpiresAtByPrefix(
  db: DatabaseSync,
  prefix: string,
  expiresAt: Date
): AccessCredentialRecord | null {
  db.prepare(
    `UPDATE access_credentials
     SET expires_at = ?
     WHERE prefix = ?`
  ).run(expiresAt.toISOString(), prefix);

  return getByPrefix(db, prefix);
}
