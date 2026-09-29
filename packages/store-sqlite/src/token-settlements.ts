import type { DatabaseSync } from "node:sqlite";

export interface SettlementAllocation {
  table: "token_windows" | "entitlement_token_windows";
  owner: string;
  kind: string;
  start: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedPromptTokens: number;
  estimatedTokens: number;
}

// Retain the exact original postings: correcting Free/paid splits cannot be
// reconstructed reliably from today's entitlement or remaining balance.
export const tokenSettlementSchema = `
  CREATE TABLE token_settlements (
    reservation_id TEXT PRIMARY KEY REFERENCES token_reservations(id) ON DELETE CASCADE,
    state TEXT NOT NULL CHECK (state IN ('provisional','corrected','invalidated')),
    original_json TEXT NOT NULL,
    allocations_json TEXT NOT NULL,
    corrected_json TEXT,
    updated_at TEXT NOT NULL
  );
  ${(["token_windows", "entitlement_token_windows"] as const).map(table => `
    CREATE TRIGGER invalidate_settlement_${table} BEFORE DELETE ON ${table} BEGIN
      UPDATE token_settlements SET state = 'invalidated'
      WHERE state = 'provisional' AND EXISTS (
        SELECT 1 FROM json_each(allocations_json) a
        WHERE json_extract(a.value, '$.table') = '${table}'
          AND json_extract(a.value, '$.owner') = OLD.${table === "token_windows" ? "subject_id" : "entitlement_id"}
          AND json_extract(a.value, '$.kind') = OLD.window_kind
          AND json_extract(a.value, '$.start') = OLD.window_start
      );
    END;
  `).join("\n")}
`;

/** Called inside the same transaction as the replacement settlement. */
export function reverseProvisionalSettlement(db: DatabaseSync, id: string, now: Date): boolean {
  const saved = db.prepare("SELECT allocations_json FROM token_settlements WHERE reservation_id = ? AND state = 'provisional'")
    .get(id) as { allocations_json: string } | undefined;
  if (!saved) return false;
  const allocations = JSON.parse(saved.allocations_json) as SettlementAllocation[];
  for (const a of allocations) {
    const ownerColumn = a.table === "token_windows" ? "subject_id" : "entitlement_id";
    if (a.table !== "token_windows" && a.table !== "entitlement_token_windows") throw new Error("Invalid settlement table");
    const values = [a.promptTokens, a.completionTokens, a.totalTokens, a.cachedPromptTokens, a.estimatedTokens];
    const result = db.prepare(`UPDATE ${a.table} SET
      prompt_tokens = prompt_tokens - ?, completion_tokens = completion_tokens - ?,
      total_tokens = total_tokens - ?, cached_prompt_tokens = cached_prompt_tokens - ?,
      estimated_tokens = estimated_tokens - ?, requests = requests - 1, updated_at = ?
      WHERE ${ownerColumn} = ? AND window_kind = ? AND window_start = ?
        AND prompt_tokens >= ? AND completion_tokens >= ? AND total_tokens >= ?
        AND cached_prompt_tokens >= ? AND estimated_tokens >= ? AND requests >= 1`)
      .run(...values, now.toISOString(), a.owner, a.kind, a.start, ...values);
    if (Number(result.changes) !== 1) throw new Error("Settlement window changed; manual reconciliation required");
  }
  return true;
}
