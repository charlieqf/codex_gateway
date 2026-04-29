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
  policy: TokenLimitPolicy;
  now?: Date;
}

export interface TokenUsageSnapshot {
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
