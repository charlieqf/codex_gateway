import {
  validatePlanPolicy,
  type AdminAuditAction,
  type CreatePlanInput,
  type Entitlement,
  type EntitlementState,
  type PeriodKind,
  type Plan,
  type Scope,
  type TokenLimitPolicy
} from "@codex-gateway/core";

export function normalizeCreatePlanInput(input: CreatePlanInput): Plan {
  if (!input.id.trim()) {
    throw new Error("Plan id is required.");
  }
  if (!input.displayName.trim()) {
    throw new Error("Plan display name is required.");
  }
  const scopeAllowlist = normalizeScopeAllowlist(input.scopeAllowlist);
  const priorityClass = input.priorityClass ?? 5;
  if (!Number.isInteger(priorityClass) || priorityClass < 0) {
    throw new Error("Plan priority_class must be a non-negative integer.");
  }
  const now = input.now ?? new Date();
  return {
    id: input.id,
    displayName: input.displayName,
    policy: validatePlanPolicy(input.policy),
    scopeAllowlist,
    priorityClass,
    teamPoolId: input.teamPoolId ?? null,
    state: "active",
    createdAt: now,
    metadata: input.metadata ?? null
  };
}

export function entitlementPeriod(
  kind: PeriodKind,
  requestedStart: Date | undefined,
  requestedEnd: Date | null | undefined,
  now: Date
): { start: Date; end: Date | null } {
  if (kind === "unlimited") {
    if (requestedStart || requestedEnd) {
      throw new Error("unlimited entitlement does not accept start or end.");
    }
    return { start: now, end: null };
  }

  const start = requestedStart ?? (kind === "monthly" ? utcMonthStart(now) : now);
  if (kind === "monthly") {
    if (!isUtcMonthStart(start)) {
      throw new Error("monthly entitlement period_start must be a UTC month boundary.");
    }
    if (requestedEnd) {
      throw new Error("monthly entitlement period_end is derived automatically.");
    }
    return { start, end: new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1)) };
  }

  if (!requestedEnd) {
    throw new Error("one_off entitlement requires period_end.");
  }
  if (requestedEnd.getTime() <= start.getTime()) {
    throw new Error("one_off entitlement period_end must be after period_start.");
  }
  return { start, end: requestedEnd };
}

export function assertEntitlementTransition(
  entitlement: Entitlement,
  nextState: EntitlementState,
  now: Date
): void {
  const from = entitlement.state;
  if (from === nextState) {
    return;
  }
  if (from === "active" && (nextState === "paused" || nextState === "cancelled")) {
    return;
  }
  if (from === "active" && nextState === "expired") {
    if (entitlement.periodEnd && entitlement.periodEnd.getTime() <= now.getTime()) {
      return;
    }
  }
  if (from === "paused" && (nextState === "active" || nextState === "cancelled")) {
    return;
  }
  if (from === "scheduled" && (nextState === "active" || nextState === "cancelled")) {
    if (nextState === "cancelled" || entitlement.periodStart.getTime() <= now.getTime()) {
      return;
    }
  }
  throw new Error(`Invalid entitlement state transition: ${from} -> ${nextState}.`);
}

export function entitlementTransitionAuditAction(
  from: EntitlementState,
  nextState: EntitlementState
): AdminAuditAction {
  if (nextState === "paused") {
    return "entitlement-pause";
  }
  if (nextState === "cancelled") {
    return "entitlement-cancel";
  }
  if (nextState === "expired") {
    return "entitlement-expire";
  }
  if (nextState === "active") {
    return from === "scheduled" ? "entitlement-activate" : "entitlement-resume";
  }
  throw new Error(`No audit action for entitlement state transition: ${from} -> ${nextState}.`);
}

export function parseScopeAllowlist(value: string): Scope[] {
  return normalizeScopeAllowlist(JSON.parse(value) as unknown);
}

function normalizeScopeAllowlist(value: unknown): Scope[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("scope_allowlist must be a non-empty array.");
  }
  const scopes = value.map((item) => {
    if (item !== "code" && item !== "medical") {
      throw new Error("scope_allowlist entries must be code or medical.");
    }
    return item;
  });
  return Array.from(new Set(scopes));
}

function utcMonthStart(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function isUtcMonthStart(date: Date): boolean {
  return (
    date.getUTCHours() === 0 &&
    date.getUTCMinutes() === 0 &&
    date.getUTCSeconds() === 0 &&
    date.getUTCMilliseconds() === 0 &&
    date.getUTCDate() === 1
  );
}
