import type { RateLimitPolicy, Scope, TokenLimitPolicy } from "@codex-gateway/core";
import type { SqliteGatewayStore } from "@codex-gateway/store-sqlite";

import type { AuditedActionResult, AuditInput } from "../audit.js";

export type NullableIntegerOption = number | null | "";
export type MissingUsageCharge = TokenLimitPolicy["missingUsageCharge"];

export interface CommandRateOptions {
  rpm: number;
  rpd?: NullableIntegerOption;
  concurrent?: NullableIntegerOption;
  tokensPerMinute?: NullableIntegerOption;
  tokensPerDay?: NullableIntegerOption;
  tokensPerMonth?: NullableIntegerOption;
  maxPromptTokens?: NullableIntegerOption;
  maxTotalTokens?: NullableIntegerOption;
  reserveTokens?: number;
  missingUsageCharge?: MissingUsageCharge;
}

export interface CommandContext {
  defaultSubjectId: string;
  defaultSubjectLabel: string;
  withAuditedStore(baseAudit: AuditInput, fn: (store: SqliteGatewayStore) => AuditedActionResult): void;
  normalizeOptionalText(value: string | undefined): string | null;
  entitlementCheckBypassed(options: { entitlementCheck?: boolean }): boolean;
  rateFromOptions(options: CommandRateOptions): RateLimitPolicy;
  assertCanIssueCredentialForEntitlement(
    store: SqliteGatewayStore,
    userId: string,
    scope: Scope,
    bypass: boolean
  ): void;
  addDays(date: Date, days: number): Date;
}

export function buildCommandContext(context: CommandContext): CommandContext {
  return context;
}
