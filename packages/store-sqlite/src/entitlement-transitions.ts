import type { DatabaseSync } from "node:sqlite";
import type { Entitlement } from "@codex-gateway/core";
import { entitlementColumns } from "./columns.js";
import { insertTransitionAudit } from "./entitlement-audit.js";
import { currentExists } from "./entitlement-queries.js";
import { rowToEntitlement } from "./row-mappers.js";

export function activeForSubjectInTransaction(
  db: DatabaseSync,
  subjectId: string,
  now: Date
): Entitlement | null {
  const expiredRows = db
    .prepare(
      `SELECT ${entitlementColumns}
       FROM entitlements
       WHERE subject_id = ?
         AND state = 'active'
         AND period_end IS NOT NULL
         AND period_end <= ?`
    )
    .all(subjectId, now.toISOString())
    .map(rowToEntitlement);

  for (const entitlement of expiredRows) {
    db.prepare("UPDATE entitlements SET state = 'expired' WHERE id = ?").run(entitlement.id);
    insertTransitionAudit(db, "entitlement-expire", entitlement, now, {
      from_state: "active",
      to_state: "expired"
    });
  }

  if (!currentExists(db, subjectId)) {
    const scheduled = db
      .prepare(
        `SELECT ${entitlementColumns}
         FROM entitlements
         WHERE subject_id = ?
           AND state = 'scheduled'
           AND period_start <= ?
         ORDER BY period_start ASC, created_at ASC
         LIMIT 1`
      )
      .get(subjectId, now.toISOString());
    if (scheduled) {
      const entitlement = rowToEntitlement(scheduled);
      db.prepare("UPDATE entitlements SET state = 'active' WHERE id = ?").run(entitlement.id);
      insertTransitionAudit(db, "entitlement-activate", entitlement, now, {
        from_state: "scheduled",
        to_state: "active"
      });
    }
  }

  const active = db
    .prepare(
      `SELECT ${entitlementColumns}
       FROM entitlements
       WHERE subject_id = ?
         AND state = 'active'
         AND period_start <= ?
         AND (period_end IS NULL OR period_end > ?)
       ORDER BY period_start DESC, created_at DESC
       LIMIT 1`
    )
    .get(subjectId, now.toISOString(), now.toISOString());
  return active ? rowToEntitlement(active) : null;
}

export function cancelCurrent(
  db: DatabaseSync,
  subjectId: string,
  now: Date,
  reason: string
): void {
  const entitlements = db
    .prepare(
      `SELECT ${entitlementColumns}
       FROM entitlements
       WHERE subject_id = ?
         AND state IN ('active', 'paused')`
    )
    .all(subjectId)
    .map(rowToEntitlement);
  db.prepare(
    `UPDATE entitlements
     SET state = 'cancelled', cancelled_at = ?, cancelled_reason = ?
     WHERE subject_id = ?
       AND state IN ('active', 'paused')`
  ).run(now.toISOString(), reason, subjectId);
  for (const entitlement of entitlements) {
    insertTransitionAudit(db, "entitlement-cancel", entitlement, now, {
      from_state: entitlement.state,
      to_state: "cancelled",
      reason
    });
  }
}

export function cancelScheduled(
  db: DatabaseSync,
  subjectId: string,
  now: Date,
  reason: string
): void {
  const entitlements = db
    .prepare(
      `SELECT ${entitlementColumns}
       FROM entitlements
       WHERE subject_id = ?
         AND state = 'scheduled'`
    )
    .all(subjectId)
    .map(rowToEntitlement);
  db.prepare(
    `UPDATE entitlements
     SET state = 'cancelled', cancelled_at = ?, cancelled_reason = ?
     WHERE subject_id = ?
       AND state = 'scheduled'`
  ).run(now.toISOString(), reason, subjectId);
  for (const entitlement of entitlements) {
    insertTransitionAudit(db, "entitlement-cancel", entitlement, now, {
      from_state: entitlement.state,
      to_state: "cancelled",
      reason
    });
  }
}
