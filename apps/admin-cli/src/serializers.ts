import type {
  AccessCredentialRecord,
  AdminAuditEventRecord,
  Entitlement,
  EntitlementAccessDecision,
  Plan,
  Subject
} from "@codex-gateway/core";

export type CredentialStatus =
  | "active"
  | "revoked"
  | "expired"
  | "user_disabled"
  | "user_archived"
  | "user_missing";

export function auditCredentialSnapshot(record: AccessCredentialRecord) {
  return {
    id: record.id,
    prefix: record.prefix,
    user_id: record.subjectId,
    label: record.label,
    scope: record.scope,
    expires_at: record.expiresAt.toISOString(),
    revoked_at: record.revokedAt?.toISOString() ?? null,
    rate: record.rate
  };
}

export function publicCredential(
  record: AccessCredentialRecord,
  subject?: Subject | null,
  now: Date = new Date(),
  revealedToken?: string | null
) {
  const status = credentialStatus(record, subject, now);
  const output: Record<string, unknown> = {
    id: record.id,
    prefix: record.prefix,
    user_id: record.subjectId,
    subject_id: record.subjectId,
    label: record.label,
    scope: record.scope,
    expires_at: record.expiresAt.toISOString(),
    revoked_at: record.revokedAt?.toISOString() ?? null,
    status,
    is_currently_valid: status === "active",
    token_available: Boolean(record.tokenCiphertext),
    token_unavailable_reason: record.tokenCiphertext ? null : "not_stored",
    rate: record.rate,
    created_at: record.createdAt.toISOString(),
    rotates_id: record.rotatesId,
    user: subject ? publicSubject(subject) : null
  };
  if (revealedToken !== undefined) {
    output.token = revealedToken;
  }
  return output;
}

export function publicPlan(plan: Plan, includePolicy: boolean) {
  return {
    id: plan.id,
    display_name: plan.displayName,
    scope_allowlist: plan.scopeAllowlist,
    priority_class: plan.priorityClass,
    team_pool_id: plan.teamPoolId,
    state: plan.state,
    created_at: plan.createdAt.toISOString(),
    metadata: plan.metadata,
    ...(includePolicy ? { policy: plan.policy } : {})
  };
}

export function publicEntitlement(entitlement: Entitlement) {
  return {
    id: entitlement.id,
    user_id: entitlement.subjectId,
    subject_id: entitlement.subjectId,
    plan_id: entitlement.planId,
    policy_snapshot: entitlement.policySnapshot,
    scope_allowlist: entitlement.scopeAllowlist,
    period_kind: entitlement.periodKind,
    period_start: entitlement.periodStart.toISOString(),
    period_end: entitlement.periodEnd?.toISOString() ?? null,
    state: entitlement.state,
    team_seat_id: entitlement.teamSeatId,
    created_at: entitlement.createdAt.toISOString(),
    cancelled_at: entitlement.cancelledAt?.toISOString() ?? null,
    cancelled_reason: entitlement.cancelledReason,
    notes: entitlement.notes
  };
}

export function publicEntitlementAccess(access: EntitlementAccessDecision) {
  if (access.status === "active") {
    return {
      status: access.status,
      plan: access.plan ? publicPlan(access.plan, false) : null,
      entitlement: publicEntitlement(access.entitlement)
    };
  }
  return {
    status: access.status,
    ...("reason" in access ? { reason: access.reason } : {}),
    ...("entitlement" in access ? { entitlement: access.entitlement ? publicEntitlement(access.entitlement) : null } : {})
  };
}

export function publicSubject(subject: Subject) {
  return {
    id: subject.id,
    label: subject.label,
    name: subject.name ?? null,
    phone_number: subject.phoneNumber ?? null,
    state: subject.state,
    created_at: subject.createdAt.toISOString()
  };
}

export function credentialStatus(
  record: AccessCredentialRecord,
  subject: Subject | null | undefined,
  now: Date
): CredentialStatus {
  if (record.revokedAt) {
    return "revoked";
  }
  if (record.expiresAt.getTime() <= now.getTime()) {
    return "expired";
  }
  if (!subject) {
    return "user_missing";
  }
  if (subject.state === "disabled") {
    return "user_disabled";
  }
  if (subject.state === "archived") {
    return "user_archived";
  }
  return "active";
}

export function publicAdminAuditEvent(record: AdminAuditEventRecord) {
  return {
    id: record.id,
    action: record.action,
    target_user_id: record.targetUserId,
    target_credential_id: record.targetCredentialId,
    target_credential_prefix: record.targetCredentialPrefix,
    status: record.status,
    params: record.params,
    error_message: record.errorMessage,
    created_at: record.createdAt.toISOString()
  };
}
