import type { GatewayError } from "./errors.js";
import type { ProviderKind, Scope, TokenUsage } from "./types.js";

export interface TokenLimitPolicy {
  tokensPerMinute: number | null;
  tokensPerDay: number | null;
  tokensPerMonth: number | null;
  maxPromptTokensPerRequest: number | null;
  maxTotalTokensPerRequest: number | null;
  reserveTokensPerRequest: number;
  missingUsageCharge: "none" | "estimate" | "reserve";
}

export type LimitKind =
  | "request_minute"
  | "request_day"
  | "concurrency"
  | "token_minute"
  | "token_day"
  | "token_month"
  | "token_request_prompt"
  | "token_request_total";

export interface AcquireInput {
  requestId: string;
  credentialId: string;
  subjectId: string;
  entitlementId?: string | null;
  scope: Scope;
  upstreamAccountId: string | null;
  provider: ProviderKind | null;
  policy: TokenLimitPolicy;
  estimatedPromptTokens: number;
  estimatedTotalTokens?: number | null;
  now?: Date;
}

export interface AcquireSuccess {
  ok: true;
  reservationId: string;
}

export interface LimitRejection {
  ok: false;
  error: GatewayError;
  limitKind: LimitKind;
}

export interface FinalizeInput {
  reservationId: string;
  requestId?: string;
  usage?: TokenUsage;
  now?: Date;
}

export interface SoftWriteBeginInput {
  requestId: string;
  credentialId: string;
  subjectId: string;
  entitlementId?: string | null;
  scope: Scope;
  upstreamAccountId: string | null;
  provider: ProviderKind | null;
  now?: Date;
}

export interface SoftWriteFinalizeInput {
  reservationId: string;
  requestId?: string;
  usage?: TokenUsage;
  now?: Date;
}

export interface FinalizeResult {
  reservationId: string;
  kind: "reservation" | "soft_write";
  finalTotalTokens: number;
  finalUsageSource: "provider" | "estimate" | "reserve" | "none" | "soft_write";
  overRequestLimit: boolean;
}

export interface CleanupResult {
  count: number;
  sampleIds: string[];
}

export interface GetUsageInput {
  subjectId: string;
  entitlementId?: string | null;
  policy: TokenLimitPolicy;
  now?: Date;
}

export interface TokenUsageSnapshot {
  source: "entitlement" | "subject";
  minute: WindowSnapshot;
  day: WindowSnapshot;
  month: WindowSnapshot;
}

export interface WindowSnapshot {
  limit: number | null;
  used: number;
  reserved: number;
  remaining: number | null;
  windowStart: string;
}

export interface TokenBudgetLimiter {
  acquire(input: AcquireInput): Promise<AcquireSuccess | LimitRejection>;
  finalize(input: FinalizeInput): Promise<FinalizeResult>;
  beginSoftWrite(input: SoftWriteBeginInput): Promise<{ reservationId: string }>;
  finalizeSoftWrite(input: SoftWriteFinalizeInput): Promise<FinalizeResult>;
  cleanupExpired(now?: Date): Promise<CleanupResult>;
  getCurrentUsage(input: GetUsageInput): Promise<TokenUsageSnapshot>;
}

export function validateTokenPolicy(policy: TokenLimitPolicy): TokenLimitPolicy {
  const missingUsageCharge = policy.missingUsageCharge;
  if (
    missingUsageCharge !== "none" &&
    missingUsageCharge !== "estimate" &&
    missingUsageCharge !== "reserve"
  ) {
    throw new Error("token.missingUsageCharge must be none, estimate, or reserve.");
  }

  return {
    tokensPerMinute: nullableNonNegativeInteger(policy.tokensPerMinute, "tokensPerMinute"),
    tokensPerDay: nullableNonNegativeInteger(policy.tokensPerDay, "tokensPerDay"),
    tokensPerMonth: nullableNonNegativeInteger(policy.tokensPerMonth, "tokensPerMonth"),
    maxPromptTokensPerRequest: nullableNonNegativeInteger(
      policy.maxPromptTokensPerRequest,
      "maxPromptTokensPerRequest"
    ),
    maxTotalTokensPerRequest: nullableNonNegativeInteger(
      policy.maxTotalTokensPerRequest,
      "maxTotalTokensPerRequest"
    ),
    reserveTokensPerRequest: nonNegativeInteger(policy.reserveTokensPerRequest),
    missingUsageCharge
  };
}

function nullableNonNegativeInteger(value: number | null, field: string): number | null {
  if (value === null) {
    return null;
  }
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`token.${field} must be a non-negative integer or null.`);
  }
  return value;
}

function nonNegativeInteger(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.floor(value));
}
