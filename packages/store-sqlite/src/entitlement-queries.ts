import type { DatabaseSync } from "node:sqlite";
import type {
  Entitlement,
  ListEntitlementsInput
} from "@codex-gateway/core";
import { entitlementColumns } from "./columns.js";
import { rowToEntitlement } from "./row-mappers.js";

export function get(db: DatabaseSync, id: string): Entitlement | null {
  const row = db
    .prepare(
      `SELECT ${entitlementColumns}
       FROM entitlements
       WHERE id = ?`
    )
    .get(id);
  return row ? rowToEntitlement(row) : null;
}

export function list(db: DatabaseSync, input: ListEntitlementsInput = {}): Entitlement[] {
  const clauses: string[] = [];
  const params: string[] = [];
  if (input.subjectId) {
    clauses.push("subject_id = ?");
    params.push(input.subjectId);
  }
  if (input.planId) {
    clauses.push("plan_id = ?");
    params.push(input.planId);
  }
  if (input.state) {
    clauses.push("state = ?");
    params.push(input.state);
  }
  if (input.periodActiveAt) {
    clauses.push("period_start <= ?");
    clauses.push("(period_end IS NULL OR period_end > ?)");
    params.push(input.periodActiveAt.toISOString(), input.periodActiveAt.toISOString());
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = db
    .prepare(
      `SELECT ${entitlementColumns}
       FROM entitlements
       ${where}
       ORDER BY created_at DESC, id DESC`
    )
    .all(...params);
  return rows.map(rowToEntitlement);
}

export function latestForSubject(db: DatabaseSync, subjectId: string): Entitlement | null {
  const row = db
    .prepare(
      `SELECT ${entitlementColumns}
       FROM entitlements
       WHERE subject_id = ?
       ORDER BY period_start DESC, created_at DESC
       LIMIT 1`
    )
    .get(subjectId);
  return row ? rowToEntitlement(row) : null;
}

export function currentExists(db: DatabaseSync, subjectId: string): boolean {
  const row = db
    .prepare(
      `SELECT 1 AS found
       FROM entitlements
       WHERE subject_id = ?
         AND state IN ('active', 'paused')
       LIMIT 1`
    )
    .get(subjectId);
  return Boolean(row);
}

export function scheduledExists(db: DatabaseSync, subjectId: string): boolean {
  const row = db
    .prepare(
      `SELECT 1 AS found
       FROM entitlements
       WHERE subject_id = ?
         AND state = 'scheduled'
       LIMIT 1`
    )
    .get(subjectId);
  return Boolean(row);
}

export function hasHistory(db: DatabaseSync, subjectId: string): boolean {
  const row = db
    .prepare("SELECT 1 AS found FROM entitlements WHERE subject_id = ? LIMIT 1")
    .get(subjectId);
  return Boolean(row);
}
