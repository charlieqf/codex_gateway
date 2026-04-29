import type { Scope } from "./types.js";
import { type TokenLimitPolicy, validateTokenPolicy } from "./token-budget.js";

export type PlanState = "active" | "deprecated";
export type PeriodKind = "monthly" | "one_off" | "unlimited";
export type EntitlementState = "scheduled" | "active" | "paused" | "expired" | "cancelled";

export interface Plan {
  id: string;
  displayName: string;
  policy: TokenLimitPolicy;
  scopeAllowlist: Scope[];
  priorityClass: number;
  teamPoolId: string | null;
  state: PlanState;
  createdAt: Date;
  metadata: Record<string, unknown> | null;
}

export interface Entitlement {
  id: string;
  subjectId: string;
  planId: string;
  policySnapshot: TokenLimitPolicy;
  scopeAllowlist: Scope[];
  periodKind: PeriodKind;
  periodStart: Date;
  periodEnd: Date | null;
  state: EntitlementState;
  teamSeatId: string | null;
  createdAt: Date;
  cancelledAt: Date | null;
  cancelledReason: string | null;
  notes: string | null;
}

export interface CreatePlanInput {
  id: string;
  displayName: string;
  policy: TokenLimitPolicy;
  scopeAllowlist: Scope[];
  priorityClass?: number;
  teamPoolId?: string | null;
  metadata?: Record<string, unknown> | null;
  now?: Date;
}

export interface ListPlansInput {
  state?: PlanState;
}

export interface GrantEntitlementInput {
  subjectId: string;
  planId: string;
  periodKind: PeriodKind;
  periodStart?: Date;
  periodEnd?: Date | null;
  replace?: boolean;
  notes?: string | null;
  now?: Date;
}

export interface RenewEntitlementInput {
  subjectId: string;
  planId?: string;
  replace?: boolean;
  now?: Date;
}

export interface UpdateEntitlementStateInput {
  id: string;
  reason?: string | null;
  now?: Date;
}

export interface ListEntitlementsInput {
  subjectId?: string;
  planId?: string;
  state?: EntitlementState;
  periodActiveAt?: Date;
}

export type EntitlementAccessDecision =
  | { status: "active"; entitlement: Entitlement; plan: Plan | null }
  | { status: "legacy" }
  | { status: "expired"; entitlement: Entitlement | null }
  | { status: "inactive"; reason: "paused" | "cancelled" | "scheduled" | "missing"; entitlement: Entitlement | null };

export interface PlanEntitlementStore {
  createPlan(input: CreatePlanInput): Plan;
  listPlans(input?: ListPlansInput): Plan[];
  getPlan(id: string): Plan | null;
  deprecatePlan(id: string, now?: Date): Plan | null;
  grantEntitlement(input: GrantEntitlementInput): Entitlement;
  renewEntitlement(input: RenewEntitlementInput): Entitlement;
  getEntitlement(id: string): Entitlement | null;
  listEntitlements(input?: ListEntitlementsInput): Entitlement[];
  pauseEntitlement(input: UpdateEntitlementStateInput): Entitlement;
  resumeEntitlement(input: UpdateEntitlementStateInput): Entitlement;
  cancelEntitlement(input: UpdateEntitlementStateInput): Entitlement;
  entitlementAccessForSubject(subjectId: string, now?: Date): EntitlementAccessDecision;
  subjectHasEntitlementHistory(subjectId: string): boolean;
}

export function validatePlanPolicy(policy: TokenLimitPolicy): TokenLimitPolicy {
  return validateTokenPolicy(policy);
}

export function mergeEntitlementTokenPolicy(
  entitlementPolicy: TokenLimitPolicy,
  credentialOverride: TokenLimitPolicy | null | undefined
): TokenLimitPolicy {
  const effective = validateTokenPolicy(entitlementPolicy);
  if (!credentialOverride) {
    return effective;
  }
  const override = validateTokenPolicy(credentialOverride);
  for (const field of [
    "tokensPerMinute",
    "tokensPerDay",
    "tokensPerMonth",
    "maxPromptTokensPerRequest",
    "maxTotalTokensPerRequest"
  ] as const) {
    if (isLowerLimitStricter(override[field], effective[field])) {
      effective[field] = override[field];
    }
  }
  if (override.reserveTokensPerRequest > effective.reserveTokensPerRequest) {
    effective.reserveTokensPerRequest = override.reserveTokensPerRequest;
  }
  return effective;
}

function isLowerLimitStricter(override: number | null, base: number | null): boolean {
  if (override === null) {
    return false;
  }
  return base === null || override < base;
}
