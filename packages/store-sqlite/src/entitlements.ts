import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  AccessCredentialRecord,
  AdminAuditAction,
  Entitlement,
  EntitlementAccessDecision,
  EntitlementState,
  GrantEntitlementInput,
  ListAccessCredentialsInput,
  Plan,
  RenewEntitlementInput,
  Scope,
  UpdateEntitlementStateInput
} from "@codex-gateway/core";
import {
  insertTransitionAudit,
  insertTransitionErrorAudit
} from "./entitlement-audit.js";
import * as entitlementQueries from "./entitlement-queries.js";
import {
  assertEntitlementTransition,
  entitlementPeriod,
  entitlementTransitionAuditAction
} from "./entitlement-rules.js";
import {
  activeForSubjectInTransaction,
  cancelCurrent,
  cancelScheduled
} from "./entitlement-transitions.js";
import { runInTransaction } from "./sql.js";

export interface EntitlementStoreDependencies {
  getPlan(id: string): Plan | null;
  listAccessCredentials(input?: ListAccessCredentialsInput): AccessCredentialRecord[];
}

export { get, hasHistory, list } from "./entitlement-queries.js";

export function grant(
  db: DatabaseSync,
  input: GrantEntitlementInput,
  deps: EntitlementStoreDependencies
): Entitlement {
  const now = input.now ?? new Date();
  return runInTransaction(db, "BEGIN IMMEDIATE", () => {
    const plan = deps.getPlan(input.planId);
    if (!plan) {
      throw new Error(`Plan not found: ${input.planId}`);
    }
    if (plan.state !== "active") {
      throw new Error(`Plan is deprecated and cannot grant new entitlements: ${input.planId}`);
    }
    assertActiveCredentialScopesAllowed(deps, input.subjectId, plan.scopeAllowlist, now);
    return insertFromPlan(db, plan, input, now);
  });
}

export function renew(
  db: DatabaseSync,
  input: RenewEntitlementInput,
  deps: EntitlementStoreDependencies
): Entitlement {
  const now = input.now ?? new Date();
  return runInTransaction(db, "BEGIN IMMEDIATE", () => {
    const current = activeForSubjectInTransaction(db, input.subjectId, now);
    if (!current) {
      throw new Error(`No active entitlement found for user: ${input.subjectId}`);
    }
    if (!current.periodEnd) {
      throw new Error("Cannot renew an unlimited entitlement.");
    }
    const planId = input.planId ?? current.planId;
    const plan = deps.getPlan(planId);
    if (!plan) {
      throw new Error(`Plan not found: ${planId}`);
    }
    if (plan.state !== "active") {
      throw new Error(`Plan is deprecated and cannot grant new entitlements: ${planId}`);
    }
    assertActiveCredentialScopesAllowed(deps, input.subjectId, plan.scopeAllowlist, now);
    return insertFromPlan(
      db,
      plan,
      {
        subjectId: input.subjectId,
        planId,
        periodKind: "monthly",
        periodStart: current.periodEnd,
        replace: input.replace,
        now
      },
      now
    );
  });
}

export function pause(db: DatabaseSync, input: UpdateEntitlementStateInput): Entitlement {
  const now = input.now ?? new Date();
  return runAuditedTransition(db, "entitlement-pause", input, "paused", now, () =>
    updateState(db, input.id, "paused", now, input.reason)
  );
}

export function resume(db: DatabaseSync, input: UpdateEntitlementStateInput): Entitlement {
  const now = input.now ?? new Date();
  return runAuditedTransition(db, "entitlement-resume", input, "active", now, () =>
    updateState(db, input.id, "active", now, input.reason)
  );
}

export function cancel(db: DatabaseSync, input: UpdateEntitlementStateInput): Entitlement {
  const now = input.now ?? new Date();
  return runAuditedTransition(db, "entitlement-cancel", input, "cancelled", now, () =>
    runInTransaction(db, "BEGIN IMMEDIATE", () => {
      const existing = entitlementQueries.get(db, input.id);
      if (!existing) {
        throw new Error(`Entitlement not found: ${input.id}`);
      }
      if (!["scheduled", "active", "paused"].includes(existing.state)) {
        throw new Error(`Cannot cancel entitlement from state ${existing.state}.`);
      }
      db.prepare(
        `UPDATE entitlements
         SET state = 'cancelled', cancelled_at = ?, cancelled_reason = ?
         WHERE id = ?`
      ).run(now.toISOString(), input.reason ?? null, input.id);
      const updated = entitlementQueries.get(db, input.id);
      if (!updated) {
        throw new Error(`Entitlement not found after update: ${input.id}`);
      }
      insertTransitionAudit(db, "entitlement-cancel", existing, now, {
        from_state: existing.state,
        to_state: "cancelled",
        reason: input.reason ?? null
      });
      return updated;
    })
  );
}

export function accessForSubject(
  db: DatabaseSync,
  subjectId: string,
  now: Date,
  deps: EntitlementStoreDependencies
): EntitlementAccessDecision {
  return runInTransaction(db, "BEGIN IMMEDIATE", () => {
    const active = activeForSubjectInTransaction(db, subjectId, now);
    if (active) {
      return { status: "active", entitlement: active, plan: deps.getPlan(active.planId) };
    }

    const latest = entitlementQueries.latestForSubject(db, subjectId);
    if (!latest) {
      return { status: "legacy" };
    }
    if (latest.state === "expired") {
      return { status: "expired", entitlement: latest };
    }
    if (latest.state === "paused") {
      return { status: "inactive", reason: "paused", entitlement: latest };
    }
    if (latest.state === "scheduled") {
      return { status: "inactive", reason: "scheduled", entitlement: latest };
    }
    if (latest.state === "cancelled") {
      return { status: "inactive", reason: "cancelled", entitlement: latest };
    }
    return { status: "inactive", reason: "missing", entitlement: latest };
  });
}

function insertFromPlan(
  db: DatabaseSync,
  plan: Plan,
  input: GrantEntitlementInput,
  now: Date
): Entitlement {
  const period = entitlementPeriod(input.periodKind, input.periodStart, input.periodEnd, now);
  const state: EntitlementState = period.start.getTime() > now.getTime() ? "scheduled" : "active";

  if (state === "active") {
    if (input.replace) {
      cancelCurrent(db, input.subjectId, now, "replaced");
      cancelScheduled(db, input.subjectId, now, "replaced");
    } else if (entitlementQueries.currentExists(db, input.subjectId)) {
      throw new Error(`User already has an active or paused entitlement: ${input.subjectId}`);
    }
  } else if (input.replace) {
    cancelScheduled(db, input.subjectId, now, "replaced");
  } else if (entitlementQueries.scheduledExists(db, input.subjectId)) {
    throw new Error(`User already has a scheduled entitlement: ${input.subjectId}`);
  }

  const entitlement: Entitlement = {
    id: `ent_${randomUUID().replaceAll("-", "")}`,
    subjectId: input.subjectId,
    planId: plan.id,
    policySnapshot: plan.policy,
    scopeAllowlist: plan.scopeAllowlist,
    periodKind: input.periodKind,
    periodStart: period.start,
    periodEnd: period.end,
    state,
    teamSeatId: null,
    createdAt: now,
    cancelledAt: null,
    cancelledReason: null,
    notes: input.notes ?? null
  };

  db.prepare(
    `INSERT INTO entitlements (
      id, subject_id, plan_id, policy_snapshot_json, scope_allowlist_json,
      period_kind, period_start, period_end, state, team_seat_id, created_at,
      cancelled_at, cancelled_reason, notes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    entitlement.id,
    entitlement.subjectId,
    entitlement.planId,
    JSON.stringify(entitlement.policySnapshot),
    JSON.stringify(entitlement.scopeAllowlist),
    entitlement.periodKind,
    entitlement.periodStart.toISOString(),
    entitlement.periodEnd?.toISOString() ?? null,
    entitlement.state,
    entitlement.teamSeatId,
    entitlement.createdAt.toISOString(),
    entitlement.cancelledAt?.toISOString() ?? null,
    entitlement.cancelledReason,
    entitlement.notes
  );

  return entitlement;
}

function updateState(
  db: DatabaseSync,
  id: string,
  nextState: EntitlementState,
  now: Date,
  reason?: string | null
): Entitlement {
  return runInTransaction(db, "BEGIN IMMEDIATE", () => {
    const existing = entitlementQueries.get(db, id);
    if (!existing) {
      throw new Error(`Entitlement not found: ${id}`);
    }
    assertEntitlementTransition(existing, nextState, now);
    db.prepare("UPDATE entitlements SET state = ? WHERE id = ?").run(nextState, id);
    const updated = entitlementQueries.get(db, id);
    if (!updated) {
      throw new Error(`Entitlement not found after update: ${id}`);
    }
    if (existing.state !== nextState) {
      insertTransitionAudit(
        db,
        entitlementTransitionAuditAction(existing.state, nextState),
        existing,
        now,
        {
          from_state: existing.state,
          to_state: nextState,
          reason: reason ?? null
        }
      );
    }
    return updated;
  });
}

function runAuditedTransition<T>(
  db: DatabaseSync,
  action: AdminAuditAction,
  input: UpdateEntitlementStateInput,
  nextState: EntitlementState,
  now: Date,
  fn: () => T
): T {
  try {
    return fn();
  } catch (err) {
    try {
      insertTransitionErrorAudit(db, action, entitlementQueries.get(db, input.id), now, err, {
        entitlement_id: input.id,
        to_state: nextState,
        reason: input.reason ?? null
      });
    } catch {
      // Preserve the transition failure if audit writing also fails.
    }
    throw err;
  }
}

function assertActiveCredentialScopesAllowed(
  deps: EntitlementStoreDependencies,
  subjectId: string,
  scopeAllowlist: Scope[],
  now: Date
): void {
  const disallowed = deps
    .listAccessCredentials({ subjectId, includeRevoked: false })
    .filter(
      (credential) =>
        credential.expiresAt.getTime() > now.getTime() &&
        !scopeAllowlist.includes(credential.scope)
    );
  if (disallowed.length > 0) {
    throw new Error(
      `Active credential scopes are not allowed by plan: ${disallowed
        .map((credential) => credential.prefix)
        .join(", ")}`
    );
  }
}
