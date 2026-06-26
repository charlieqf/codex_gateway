import {
  GatewayError,
  mergeEntitlementTokenPolicy,
  type EntitlementAccessDecision,
  type PlanEntitlementStore,
  type RateLimitPolicy,
  type Scope,
  type Subject
} from "@codex-gateway/core";

export interface CredentialAccessContext {
  subject: Subject;
  scope: Scope;
  credential: {
    id: string | null;
    rate: RateLimitPolicy | null;
  };
}

export interface ResolvedEntitlementAccess {
  decision: EntitlementAccessDecision | null;
  entitlementId: string | null;
  entitlementPeriodStart: Date | null;
  entitlementPeriodEnd: Date | null;
  tokenPolicy: NonNullable<RateLimitPolicy["token"]> | null;
}

export interface ResolveEntitlementAccessInput {
  context: CredentialAccessContext;
  entitlementStore?: PlanEntitlementStore;
  publicModelId: string;
  requireEntitlement?: boolean;
  now?: Date;
}

export function resolveEntitlementAccessForChat(
  input: ResolveEntitlementAccessInput
): ResolvedEntitlementAccess | GatewayError {
  const { context } = input;
  if (!context.credential.id) {
    return {
      decision: null,
      entitlementId: null,
      entitlementPeriodStart: null,
      entitlementPeriodEnd: null,
      tokenPolicy: context.credential.rate?.token ?? null
    };
  }

  const access = input.entitlementStore?.entitlementAccessForSubject(
    context.subject.id,
    input.now
  );
  if (access?.status === "active") {
    if (!access.entitlement.scopeAllowlist.includes(context.scope)) {
      return new GatewayError({
        code: "forbidden_scope",
        message: "Credential scope is not allowed by the active plan.",
        httpStatus: 403
      });
    }
    if (!isPublicModelAllowed(access.entitlement.featurePolicySnapshot, input.publicModelId)) {
      return new GatewayError({
        code: "plan_capability_required",
        message: "This credential is not entitled for the requested MedCode model.",
        httpStatus: 403
      });
    }
    return {
      decision: access,
      entitlementId: access.entitlement.id,
      entitlementPeriodStart: access.entitlement.periodStart,
      entitlementPeriodEnd: access.entitlement.periodEnd,
      tokenPolicy: mergeEntitlementTokenPolicy(
        access.entitlement.policySnapshot,
        context.credential.rate?.token ?? null
      )
    };
  }

  if (access?.status === "expired") {
    return new GatewayError({
      code: "plan_expired",
      message: "Plan entitlement has expired.",
      httpStatus: 402
    });
  }
  if (access?.status === "inactive") {
    return new GatewayError({
      code: "plan_inactive",
      message: "Plan entitlement is inactive.",
      httpStatus: 402
    });
  }
  if (access?.status === "legacy" && input.requireEntitlement) {
    return new GatewayError({
      code: "plan_inactive",
      message: "Plan entitlement is required.",
      httpStatus: 402
    });
  }
  return {
    decision: access ?? null,
    entitlementId: null,
    entitlementPeriodStart: null,
    entitlementPeriodEnd: null,
    tokenPolicy: context.credential.rate?.token ?? null
  };
}

export function isPublicModelAllowed(
  policy: { medcodeModels?: { allowed: string[] } | null },
  publicModelId: string
): boolean {
  // Backward compatibility hard gate: v1 medcode keeps its historical default
  // behavior and is not rejected by the new per-model allow-list. Legacy
  // entitlements without the new field fail open for currently enabled public
  // models so already-issued keys automatically get newly added MedCode models.
  if (publicModelId === "medcode") {
    return true;
  }
  if (!policy.medcodeModels) {
    return true;
  }
  return policy.medcodeModels?.allowed.includes(publicModelId) === true;
}
