import type { DatabaseSync } from "node:sqlite";
import type {
  ListUnifiedClientKeysInput,
  UnifiedClientKeyRecord
} from "@codex-gateway/core";
import { unifiedClientKeyColumns } from "./columns.js";
import { rowToUnifiedClientKey } from "./row-mappers.js";

export function insert(db: DatabaseSync, record: UnifiedClientKeyRecord): UnifiedClientKeyRecord {
  db.prepare(
    `INSERT INTO unified_client_keys (
      id, prefix, hash, subject_id, label, expires_at, revoked_at,
      codex_credential_id, codex_credential_prefix, codex_key_ciphertext,
      medevidence_key_ciphertext, medevidence_key_prefix, created_at, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    record.id,
    record.prefix,
    record.hash,
    record.subjectId,
    record.label,
    record.expiresAt.toISOString(),
    record.revokedAt?.toISOString() ?? null,
    record.codexCredentialId,
    record.codexCredentialPrefix,
    record.codexKeyCiphertext,
    record.medevidenceKeyCiphertext,
    record.medevidenceKeyPrefix,
    record.createdAt.toISOString(),
    record.metadata ? JSON.stringify(record.metadata) : null
  );

  return record;
}

export function getByPrefix(db: DatabaseSync, prefix: string): UnifiedClientKeyRecord | null {
  const row = db
    .prepare(
      `SELECT ${unifiedClientKeyColumns}
       FROM unified_client_keys
       WHERE prefix = ?`
    )
    .get(prefix);
  return row ? rowToUnifiedClientKey(row) : null;
}

export function list(
  db: DatabaseSync,
  input: ListUnifiedClientKeysInput = {}
): UnifiedClientKeyRecord[] {
  const includeRevoked = input.includeRevoked ?? true;
  const rows = input.subjectId
    ? db
        .prepare(
          `SELECT ${unifiedClientKeyColumns}
           FROM unified_client_keys
           WHERE subject_id = ?
             AND (? = 1 OR revoked_at IS NULL)
           ORDER BY created_at DESC`
        )
        .all(input.subjectId, includeRevoked ? 1 : 0)
    : db
        .prepare(
          `SELECT ${unifiedClientKeyColumns}
           FROM unified_client_keys
           WHERE (? = 1 OR revoked_at IS NULL)
           ORDER BY created_at DESC`
        )
        .all(includeRevoked ? 1 : 0);
  return rows.map(rowToUnifiedClientKey);
}

export function revokeByPrefix(
  db: DatabaseSync,
  prefix: string,
  now: Date = new Date()
): UnifiedClientKeyRecord | null {
  db.prepare(
    `UPDATE unified_client_keys
     SET revoked_at = COALESCE(revoked_at, ?)
     WHERE prefix = ?`
  ).run(now.toISOString(), prefix);
  return getByPrefix(db, prefix);
}
