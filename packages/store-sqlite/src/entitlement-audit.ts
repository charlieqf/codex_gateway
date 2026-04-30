import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { AdminAuditAction, Entitlement } from "@codex-gateway/core";
import * as adminAudit from "./admin-audit.js";

export function insertTransitionAudit(
  db: DatabaseSync,
  action: AdminAuditAction,
  entitlement: Entitlement,
  now: Date,
  params: Record<string, unknown> = {}
): void {
  adminAudit.insert(db, {
    id: `audit_${randomUUID()}`,
    action,
    targetUserId: entitlement.subjectId,
    targetCredentialId: null,
    targetCredentialPrefix: null,
    status: "ok",
    params: {
      entitlement_id: entitlement.id,
      plan_id: entitlement.planId,
      ...params
    },
    errorMessage: null,
    createdAt: now
  });
}

export function insertTransitionErrorAudit(
  db: DatabaseSync,
  action: AdminAuditAction,
  entitlement: Entitlement | null,
  now: Date,
  err: unknown,
  params: Record<string, unknown> = {}
): void {
  adminAudit.insert(db, {
    id: `audit_${randomUUID()}`,
    action,
    targetUserId: entitlement?.subjectId ?? null,
    targetCredentialId: null,
    targetCredentialPrefix: null,
    status: "error",
    params: {
      ...(entitlement
        ? {
            entitlement_id: entitlement.id,
            plan_id: entitlement.planId,
            from_state: entitlement.state
          }
        : {}),
      ...params
    },
    errorMessage: sanitizeAuditErrorMessage(err),
    createdAt: now
  });
}

function sanitizeAuditErrorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message
    .replace(/cgw\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "cgw.<redacted>")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer <redacted>");
}
