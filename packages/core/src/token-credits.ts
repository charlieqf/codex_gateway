import { GatewayError } from "./errors.js";
import { validateBillingIdempotencyKey } from "./billing.js";
import { isRecord } from "./utils.js";

/** Independent, permanent Token balance. This does not grant product capabilities. */
export interface TokenCreditWallet {
  subjectId: string;
  grantedTokens: number;
  chargedTokens: number;
  balanceTokens: number;
  reservedTokens: number;
  availableTokens: number;
}

export interface GrantTokenCreditsInput {
  idempotencyKey: string;
  subjectId: string;
  provider: string;
  externalEventId: string;
  externalOrderId?: string | null;
  eventType: "gift" | "topup";
  tokens: number;
  reason: string;
  now?: Date;
}

export interface TokenCreditEvent {
  id: string;
  idempotencyKey: string;
  subjectId: string;
  provider: string;
  externalEventId: string;
  externalOrderId: string | null;
  eventType: "gift" | "topup";
  tokens: number;
  reason: string;
  createdAt: string;
}

export interface TokenCreditStore {
  grantTokenCredits(input: GrantTokenCreditsInput): {
    event: TokenCreditEvent;
    wallet: TokenCreditWallet;
    idempotentReplay: boolean;
  };
  getTokenCreditWallet(subjectId: string, now?: Date): TokenCreditWallet;
  getTokenCreditEvent(idempotencyKey: string): TokenCreditEvent | null;
  listTokenCreditEvents(input: { subjectId: string; limit?: number; cursor?: string }): {
    events: TokenCreditEvent[];
    nextCursor: string | null;
  };
}

/** Shared by HTTP parsing and persistence; neither trusts caller-supplied types. */
export function validateTokenCreditGrant(input: unknown): asserts input is GrantTokenCreditsInput {
  if (!isRecord(input)) invalidGrant("A Token credit grant object is required.");
  for (const field of ["idempotencyKey", "provider", "externalEventId", "subjectId"]) {
    const value = input[field];
    if (typeof value !== "string" || !validateBillingIdempotencyKey(value)) {
      invalidGrant(`${field} must be a 1-200 character identifier.`);
    }
  }
  if (input.externalOrderId != null && (typeof input.externalOrderId !== "string" || !validateBillingIdempotencyKey(input.externalOrderId))) {
    invalidGrant("externalOrderId must be a 1-200 character identifier.");
  }
  if (input.eventType !== "gift" && input.eventType !== "topup") invalidGrant("eventType must be gift or topup.");
  if (input.eventType === "topup" && !input.externalOrderId) invalidGrant("topup requires externalOrderId.");
  if (typeof input.tokens !== "number" || !Number.isSafeInteger(input.tokens) || input.tokens <= 0) {
    invalidGrant("tokens must be a positive safe integer.");
  }
  if (typeof input.reason !== "string" || !input.reason.trim() || input.reason.length > 500) {
    invalidGrant("reason must contain 1-500 characters.");
  }
  if (input.now !== undefined && (!(input.now instanceof Date) || !Number.isFinite(input.now.getTime()))) {
    invalidGrant("now must be a valid Date.");
  }
}

function invalidGrant(message: string): never {
  throw new GatewayError({ code: "invalid_request", httpStatus: 400, message });
}

export function publicTokenCreditWallet(wallet: TokenCreditWallet) {
  return { subject_id: wallet.subjectId, granted_tokens: wallet.grantedTokens,
    charged_tokens: wallet.chargedTokens, balance_tokens: wallet.balanceTokens,
    reserved_tokens: wallet.reservedTokens, available_tokens: wallet.availableTokens, expires_at: null };
}

export function publicTokenCreditEvent(event: TokenCreditEvent) {
  return { id: event.id, idempotency_key: event.idempotencyKey, subject_id: event.subjectId,
    provider: event.provider, external_event_id: event.externalEventId, external_order_id: event.externalOrderId,
    event_type: event.eventType, tokens: event.tokens, reason: event.reason, created_at: event.createdAt, expires_at: null };
}
