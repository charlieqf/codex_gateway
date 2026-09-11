import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { GatewayError, phoneSignupFreePlan, phoneSignupFreePlanId, type Entitlement } from "@codex-gateway/core";
import { entitlementColumns } from "./columns.js";
import { rowToEntitlement } from "./row-mappers.js";
import { insertTransitionAudit } from "./entitlement-audit.js";
import { tableExists } from "./sqlite-managed.js";
import * as plans from "./plans.js";

// These are the public product IDs, not all internal or historical Plan templates.
// plan_free_once_fixture_v1 exists only so tests can pin a custom allowance.
const freePlanIds = ["plan_free_once_1m_v1", "plan_free_once_fixture_v1", "plan_free_daily_100k_v1", "plan_free_daily_10k_v1", "plan_free_daily_1m_v1"];
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

/**
 * Recover only an allowance removed by the old replacement flow. Explicit
 * suspension/cancellation remains effective, as does its original snapshot.
 * Paid purchases no longer grant a new Free allowance: the one-off signup
 * allowance is the only source of free tokens.
 */
export function recoverReplacedFreeAllowance(db: DatabaseSync, subjectId: string, now: Date): void {
  const row = db.prepare(`SELECT ${entitlementColumns} FROM entitlements
    WHERE subject_id = ? AND (${freePlanSql})
    ORDER BY created_at DESC, id DESC LIMIT 1`).get(subjectId);
  if (!row) return;
  const existing = rowToEntitlement(row);
  if (existing.state === "cancelled" && existing.cancelledReason === "replaced") {
    db.prepare("UPDATE entitlements SET state = 'active', cancelled_at = NULL, cancelled_reason = NULL WHERE id = ?")
      .run(existing.id);
    insertTransitionAudit(db, "entitlement-grant", existing, now, {
      source: "paid-free-allowance", from_state: "cancelled", to_state: "active",
      reason: "restore_free_allowance_replaced_by_paid"
    });
  }
}

/**
 * One-off migration of legacy daily Free allowances to the lifetime model.
 * Each active daily Free entitlement keeps its id, subject and period, but is
 * re-pointed to plan_free_once_1m_v1 with a one-off 1,000,000-token snapshot
 * and its historical paid-free usage summed into a single lifetime window.
 * Cancelled/expired legacy allowances keep their snapshots for audit.
 */
export function migrateDailyFreeAllowancesToOnce(db: DatabaseSync, now: Date): { migrated: number } {
  // Databases without the plan store (event-only schemas) have no allowances
  // to migrate; the widened window table was handled by the migration itself.
  if (!tableExists(db, "plans") || !tableExists(db, "entitlements")) {
    return { migrated: 0 };
  }
  const rows = db.prepare(`SELECT ${entitlementColumns} FROM entitlements
    WHERE plan_id IN ('plan_free_daily_100k_v1', 'plan_free_daily_10k_v1', 'plan_free_daily_1m_v1')
      AND period_kind = 'unlimited' AND period_end IS NULL AND state = 'active'`)
    .all().map(row => rowToEntitlement(row));
  if (rows.length === 0) {
    return { migrated: 0 };
  }
  // Create the template lazily: databases without legacy allowances keep
  // their plan inventory untouched.
  const oncePlan = plans.get(db, phoneSignupFreePlanId) ?? plans.create(db, phoneSignupFreePlan(now));
  if (oncePlan.state !== "active") {
    throw new GatewayError({ code: "plan_inactive", httpStatus: 409,
      message: "The default Free plan is inactive; migration was not applied." });
  }
  let migrated = 0;
  for (const legacy of rows) {
    // Each settled request is booked into both a day and a month window row;
    // summing both would double-count. The month rows alone cover the full
    // history (every day belongs to a month).
    const used = db.prepare(`SELECT COALESCE(SUM(total_tokens), 0) AS used
      FROM entitlement_token_windows
      WHERE entitlement_id = ? AND window_kind = 'month'`).get(legacy.id) as { used: number };
    const total = Math.max(0, 1_000_000 - used.used);
    db.prepare(`UPDATE entitlements SET plan_id = ?, policy_snapshot_json = ?
      WHERE id = ? AND state = 'active'`)
      .run(oncePlan.id, JSON.stringify({ ...legacy.policySnapshot,
        tokensPerDay: null, tokensPerMonth: null, tokensTotal: 1_000_000 }), legacy.id);
    db.prepare(`INSERT INTO entitlement_token_windows (
        entitlement_id, window_kind, window_start, prompt_tokens, completion_tokens,
        total_tokens, cached_prompt_tokens, estimated_tokens, requests, updated_at
      ) VALUES (?, 'period', ?, 0, 0, ?, 0, 0, 0, ?)
      ON CONFLICT(entitlement_id, window_kind, window_start) DO UPDATE SET
        total_tokens = excluded.total_tokens, updated_at = excluded.updated_at`)
      .run(legacy.id, legacy.periodStart.toISOString(), used.used, now.toISOString());
    insertTransitionAudit(db, "entitlement-grant", legacy, now, {
      source: "free-once-migration", from_state: "active", to_state: "active",
      reason: "daily_free_converted_to_once", remaining_tokens: total
    });
    migrated += 1;
  }
  return { migrated };
}
