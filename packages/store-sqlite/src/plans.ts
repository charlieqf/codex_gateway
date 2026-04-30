import type { DatabaseSync } from "node:sqlite";
import type {
  CreatePlanInput,
  ListPlansInput,
  Plan
} from "@codex-gateway/core";
import { planColumns } from "./columns.js";
import { normalizeCreatePlanInput } from "./entitlement-rules.js";
import { rowToPlan } from "./row-mappers.js";

export function create(db: DatabaseSync, input: CreatePlanInput): Plan {
  const plan = normalizeCreatePlanInput(input);
  db.prepare(
    `INSERT INTO plans (
      id, display_name, policy_json, scope_allowlist_json, priority_class,
      team_pool_id, state, created_at, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`
  ).run(
    plan.id,
    plan.displayName,
    JSON.stringify(plan.policy),
    JSON.stringify(plan.scopeAllowlist),
    plan.priorityClass,
    plan.teamPoolId,
    plan.createdAt.toISOString(),
    plan.metadata ? JSON.stringify(plan.metadata) : null
  );
  return plan;
}

export function list(db: DatabaseSync, input: ListPlansInput = {}): Plan[] {
  const rows = input.state
    ? db
        .prepare(
          `SELECT ${planColumns}
           FROM plans
           WHERE state = ?
           ORDER BY created_at DESC, id`
        )
        .all(input.state)
    : db
        .prepare(
          `SELECT ${planColumns}
           FROM plans
           ORDER BY created_at DESC, id`
        )
        .all();
  return rows.map(rowToPlan);
}

export function get(db: DatabaseSync, id: string): Plan | null {
  const row = db
    .prepare(
      `SELECT ${planColumns}
       FROM plans
       WHERE id = ?`
    )
    .get(id);
  return row ? rowToPlan(row) : null;
}

export function deprecate(db: DatabaseSync, id: string): Plan | null {
  db.prepare("UPDATE plans SET state = 'deprecated' WHERE id = ?").run(id);
  return get(db, id);
}
