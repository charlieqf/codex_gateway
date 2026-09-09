import { defaultFeaturePolicy } from "./feature-policy.js";
import type { CreatePlanInput } from "./plan-entitlement.js";

export const phoneSignupFreePlanId = "plan_free_daily_1m_v1";

/** The existing token ledger uses UTC days (08:00 China time). */
export function phoneSignupFreePlan(now: Date): CreatePlanInput {
  return {
    id: phoneSignupFreePlanId,
    displayName: "Free · 1,000,000 tokens/day",
    scopeAllowlist: ["code"],
    featurePolicy: defaultFeaturePolicy(),
    policy: {
      tokensPerMinute: 300_000,
      tokensPerDay: 1_000_000,
      tokensPerMonth: null,
      maxPromptTokensPerRequest: null,
      maxTotalTokensPerRequest: null,
      reserveTokensPerRequest: 0,
      missingUsageCharge: "estimate"
    },
    metadata: { source: "phone_signup", quota_timezone: "UTC" },
    now
  };
}
