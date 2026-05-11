import type { DatabaseSync } from "node:sqlite";
import type { UpstreamAccount } from "@codex-gateway/core";

export interface UpdateRuntimeStateInput {
  state: UpstreamAccount["state"];
  lastUsedAt: Date | null;
  cooldownUntil: Date | null;
}

export function get(db: DatabaseSync, id: string): UpstreamAccount | null {
  const row = db
    .prepare(
      `SELECT id, provider, label, credential_ref, image_api_key_env, state, last_used_at, cooldown_until
       FROM upstream_accounts
       WHERE id = ?`
    )
    .get(id);
  if (!row) {
    return null;
  }
  const value = row as {
    id: string;
    provider: UpstreamAccount["provider"];
    label: string;
    credential_ref: string;
    image_api_key_env: string | null;
    state: UpstreamAccount["state"];
    last_used_at: string | null;
    cooldown_until: string | null;
  };
  return {
    id: value.id,
    provider: value.provider,
    label: value.label,
    credentialRef: value.credential_ref,
    imageApiKeyEnv: value.image_api_key_env,
    state: value.state,
    lastUsedAt: value.last_used_at ? new Date(value.last_used_at) : null,
    cooldownUntil: value.cooldown_until ? new Date(value.cooldown_until) : null
  };
}

export function upsert(db: DatabaseSync, upstreamAccount: UpstreamAccount): void {
  db.prepare(
    `INSERT INTO upstream_accounts (
      id, provider, label, credential_ref, image_api_key_env, state, last_used_at, cooldown_until, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      provider = excluded.provider,
      label = excluded.label,
      credential_ref = excluded.credential_ref,
      image_api_key_env = excluded.image_api_key_env,
      updated_at = excluded.updated_at`
  ).run(
    upstreamAccount.id,
    upstreamAccount.provider,
    upstreamAccount.label,
    upstreamAccount.credentialRef,
    upstreamAccount.imageApiKeyEnv ?? null,
    upstreamAccount.state,
    upstreamAccount.lastUsedAt?.toISOString() ?? null,
    upstreamAccount.cooldownUntil?.toISOString() ?? null,
    new Date().toISOString()
  );
}

export function updateRuntimeState(
  db: DatabaseSync,
  id: string,
  input: UpdateRuntimeStateInput
): UpstreamAccount | null {
  db.prepare(
    `UPDATE upstream_accounts
     SET state = ?,
         last_used_at = ?,
         cooldown_until = ?,
         updated_at = ?
     WHERE id = ?`
  ).run(
    input.state,
    input.lastUsedAt?.toISOString() ?? null,
    input.cooldownUntil?.toISOString() ?? null,
    new Date().toISOString(),
    id
  );
  return get(db, id);
}
