import { defaultFeaturePolicy } from "./feature-policy.js";
import type { CreatePlanInput } from "./plan-entitlement.js";

// New grants use a one-off lifetime allowance; existing daily grants keep
// their snapshots and are migrated separately to the lifetime window model.
export const phoneSignupFreePlanId = "plan_free_once_1m_v1";

/** One million tokens for the account's lifetime; it never resets. */
export function phoneSignupFreePlan(now: Date): CreatePlanInput {
  return {
    id: phoneSignupFreePlanId,
    displayName: "Free · 1,000,000 tokens once",
    scopeAllowlist: ["code"],
    featurePolicy: defaultFeaturePolicy(),
    policy: {
      tokensPerMinute: 300_000,
      tokensPerDay: null,
      tokensPerMonth: null,
      tokensTotal: 1_000_000,
      maxPromptTokensPerRequest: null,
      maxTotalTokensPerRequest: null,
      reserveTokensPerRequest: 0,
      missingUsageCharge: "estimate"
    },
    metadata: { source: "phone_signup", quota_timezone: "UTC" },
    now
  };
}
