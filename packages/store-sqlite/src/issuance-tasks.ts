import type { DatabaseSync } from "node:sqlite";
import { GatewayError, type IssuanceTaskRecord } from "@codex-gateway/core";

type Row = {
  id: string; provider: string; external_user_id: string; actor_id: string; state: string;
  snapshot_ciphertext: string; lease_token: string | null; lease_expires_at: string | null;
  created_at: string; updated_at: string;
  retired_at: string | null;
};
function map(row: Row): IssuanceTaskRecord {
  return { id: row.id, provider: row.provider, externalUserId: row.external_user_id,
    actorId: row.actor_id, state: row.state, snapshotCiphertext: row.snapshot_ciphertext,
    leaseToken: row.lease_token, leaseExpiresAt: row.lease_expires_at ? new Date(row.lease_expires_at) : null,
    createdAt: new Date(row.created_at), updatedAt: new Date(row.updated_at), retiredAt: row.retired_at ? new Date(row.retired_at) : null };
}
export function insert(db: DatabaseSync, record: IssuanceTaskRecord): void {
  const result = db.prepare(`INSERT INTO real_user_issuance_tasks
    (id, provider, external_user_id, actor_id, state, snapshot_ciphertext, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(provider, external_user_id) WHERE state != 'failed' AND retired_at IS NULL DO NOTHING`).run(
      record.id, record.provider, record.externalUserId, record.actorId, record.state,
      record.snapshotCiphertext, record.createdAt.toISOString(), record.updatedAt.toISOString());
  if (!result.changes) throw new GatewayError({ code: "issue_already_exists",
    message: "An issuance task already exists for this identity; inspect and resume the original task.", httpStatus: 409 });
}
export function get(db: DatabaseSync, id: string): IssuanceTaskRecord | null {
  const row = db.prepare("SELECT * FROM real_user_issuance_tasks WHERE id = ?").get(id) as Row | undefined;
  return row ? map(row) : null;
}
export function list(db: DatabaseSync, actorId: string | null, limit: number): IssuanceTaskRecord[] {
  return (db.prepare(`SELECT * FROM real_user_issuance_tasks WHERE (? IS NULL OR actor_id = ?)
    ORDER BY created_at DESC LIMIT ?`).all(actorId, actorId, limit) as Row[]).map(map);
}
export function claim(db: DatabaseSync, id: string, token: string, now: Date, expiresAt: Date, expectedState: string): boolean {
  return Boolean(db.prepare(`UPDATE real_user_issuance_tasks SET lease_token = ?, lease_expires_at = ?
    WHERE id = ? AND state = ? AND state NOT IN ('succeeded', 'failed') AND retired_at IS NULL
      AND (lease_token IS NULL OR lease_expires_at <= ?)`).run(token, expiresAt.toISOString(), id, expectedState, now.toISOString()).changes);
}
export function save(db: DatabaseSync, record: IssuanceTaskRecord, token: string, now: Date): void {
  const result = db.prepare(`UPDATE real_user_issuance_tasks SET state = ?, snapshot_ciphertext = ?,
    updated_at = ?, lease_expires_at = ? WHERE id = ? AND lease_token = ? AND lease_expires_at > ? AND retired_at IS NULL`).run(
      record.state, record.snapshotCiphertext, record.updatedAt.toISOString(), record.leaseExpiresAt?.toISOString() ?? null,
      record.id, token, now.toISOString());
  if (!result.changes) throw new GatewayError({ code: "issue_lease_lost", message: "Issuance ownership changed; reload the task.", httpStatus: 409 });
}
export function release(db: DatabaseSync, id: string, token: string): void {
  db.prepare(`UPDATE real_user_issuance_tasks SET lease_token = NULL, lease_expires_at = NULL
    WHERE id = ? AND lease_token = ?`).run(id, token);
}
