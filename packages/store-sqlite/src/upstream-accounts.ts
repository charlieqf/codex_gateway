import type { DatabaseSync } from "node:sqlite";
import type { UpstreamAccount } from "@codex-gateway/core";

export function upsert(db: DatabaseSync, upstreamAccount: UpstreamAccount): void {
  db.prepare(
    `INSERT INTO upstream_accounts (
      id, provider, label, credential_ref, state, last_used_at, cooldown_until, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      provider = excluded.provider,
      label = excluded.label,
      credential_ref = excluded.credential_ref,
      updated_at = excluded.updated_at`
  ).run(
    upstreamAccount.id,
    upstreamAccount.provider,
    upstreamAccount.label,
    upstreamAccount.credentialRef,
    upstreamAccount.state,
    upstreamAccount.lastUsedAt?.toISOString() ?? null,
    upstreamAccount.cooldownUntil?.toISOString() ?? null,
    new Date().toISOString()
  );
}
