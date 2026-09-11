import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { GatewayError, phoneSignupFreePlan, phoneSignupFreePlanId, type Entitlement } from "@codex-gateway/core";
import { entitlementColumns } from "./columns.js";
import { rowToEntitlement } from "./row-mappers.js";
import { insertTransitionAudit } from "./entitlement-audit.js";
import * as plans from "./plans.js";

// These are the public product IDs, not all internal or historical Plan templates.
const freePlanIds = ["plan_free_daily_100k_v1", "plan_free_daily_10k_v1", "plan_free_daily_1m_v1"];
const paidPlanIds = ["plan_paid_monthly_v1", "plan_paid_yearly_v1"];
export const freePlanSql = `plan_id IN ('${freePlanIds.join("', '")}') AND period_kind = 'unlimited' AND period_end IS NULL`;
export const paidPlanSql = `plan_id IN ('${paidPlanIds.join("', '")}')`;

export function isRetailPaidPlan(planId: string): boolean {
  return paidPlanIds.includes(planId);
}

export function isFreeAllowance(entitlement: Entitlement): boolean {
  return freePlanIds.includes(entitlement.planId) &&
    entitlement.periodKind === "unlimited" && entitlement.periodEnd === null;
}

export function activeFreeAllowance(db: DatabaseSync, subjectId: string, now: Date): Entitlement | null {
  const row = db.prepare(`SELECT ${entitlementColumns} FROM entitlements
    WHERE subject_id = ? AND (${freePlanSql}) AND state = 'active' AND period_start <= ?
    ORDER BY created_at DESC, id DESC LIMIT 1`).get(subjectId, now.toISOString());
  return row ? rowToEntitlement(row) : null;
}

/** Caller owns the write transaction. Never reset an existing allowance or its usage. */
export function ensureFreeAllowance(db: DatabaseSync, subjectId: string, now: Date): void {
  const row = db.prepare(`SELECT ${entitlementColumns} FROM entitlements
    WHERE subject_id = ? AND (${freePlanSql})
    ORDER BY created_at DESC, id DESC LIMIT 1`).get(subjectId);
  if (row) {
    const existing = rowToEntitlement(row);
    // Recover only an allowance removed by the old replacement flow. Explicit
    // suspension/cancellation remains effective, as does its original snapshot.
    if (existing.state === "cancelled" && existing.cancelledReason === "replaced") {
      db.prepare("UPDATE entitlements SET state = 'active', cancelled_at = NULL, cancelled_reason = NULL WHERE id = ?")
        .run(existing.id);
      insertTransitionAudit(db, "entitlement-grant", existing, now, {
        source: "paid-free-allowance", from_state: "cancelled", to_state: "active",
        reason: "restore_free_allowance_replaced_by_paid"
      });
    }
    return;
  }
  // Use the same default as phone signup, atomically with the paid grant.
  // A deliberately deprecated template must not silently produce partial rights.
  const plan = plans.get(db, phoneSignupFreePlanId) ?? plans.create(db, phoneSignupFreePlan(now));
  if (plan.state !== "active") {
    throw new GatewayError({ code: "plan_inactive", httpStatus: 409,
      message: "The default Free plan is inactive; the paid entitlement was not granted." });
  }
  const id = `ent_${randomUUID().replaceAll("-", "")}`;
  db.prepare(`INSERT INTO entitlements (
    id, subject_id, plan_id, policy_snapshot_json, feature_policy_snapshot_json,
    scope_allowlist_json, period_kind, period_start, period_end, state, team_seat_id,
    created_at, cancelled_at, cancelled_reason, notes
  ) VALUES (?, ?, ?, ?, ?, ?, 'unlimited', ?, NULL, 'active', NULL, ?, NULL, NULL, ?)`)
    .run(id, subjectId, plan.id, JSON.stringify(plan.policy), JSON.stringify(plan.featurePolicy),
      JSON.stringify(plan.scopeAllowlist), now.toISOString(), now.toISOString(), "Paid account base Free allowance");
  const created = rowToEntitlement(db.prepare(`SELECT ${entitlementColumns} FROM entitlements WHERE id = ?`).get(id));
  insertTransitionAudit(db, "entitlement-grant", created, now, { source: "paid-free-allowance" });
}
