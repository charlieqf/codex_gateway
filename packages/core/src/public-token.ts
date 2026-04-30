import type { TokenLimitPolicy, TokenUsageSnapshot, WindowSnapshot } from "./token-budget.js";

export function publicTokenPolicy(policy: TokenLimitPolicy) {
  return {
    tokensPerMinute: policy.tokensPerMinute,
    tokensPerDay: policy.tokensPerDay,
    tokensPerMonth: policy.tokensPerMonth,
    maxPromptTokensPerRequest: policy.maxPromptTokensPerRequest,
    maxTotalTokensPerRequest: policy.maxTotalTokensPerRequest
  };
}

export function publicTokenUsage(usage: TokenUsageSnapshot) {
  return {
    source: usage.source,
    minute: publicTokenWindow(usage.minute),
    day: publicTokenWindow(usage.day),
    month: publicTokenWindow(usage.month)
  };
}

export function publicTokenWindow(input: WindowSnapshot) {
  return {
    limit: input.limit,
    used: input.used,
    reserved: input.reserved,
    remaining: input.remaining,
    window_start: input.windowStart
  };
}
