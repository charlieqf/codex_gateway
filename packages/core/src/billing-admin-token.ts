import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { GatewayError } from "./errors.js";
import type { BillingAdminTokenKind, BillingAdminTokenRecord } from "./types.js";

export const billingAdminTokenIdPrefix = "bat";

export interface IssueBillingAdminTokenInput {
  label: string;
  kind: BillingAdminTokenKind;
  expiresAt: Date;
  metadata?: Record<string, unknown> | null;
  now?: Date;
}

export interface IssuedBillingAdminToken {
  token: string;
  record: BillingAdminTokenRecord;
}

export function issueBillingAdminToken(input: IssueBillingAdminTokenInput): IssuedBillingAdminToken {
  const prefix = `${billingAdminTokenIdPrefix}_${input.kind}_${randomTokenPart(10)}`;
  const secret = randomTokenPart(32);
  const token = `${prefix}.${secret}`;
  const now = input.now ?? new Date();

  return {
    token,
    record: {
      id: `${billingAdminTokenIdPrefix}_${randomTokenPart(16)}`,
      prefix,
      hash: hashBillingAdminToken(token),
      label: input.label,
      kind: input.kind,
      state: "active",
      expiresAt: input.expiresAt,
      revokedAt: null,
      createdAt: now,
      lastUsedAt: null,
      metadata: input.metadata ?? null
    }
  };
}

export function extractBillingAdminTokenPrefix(token: string): string | null {
  const match = /^(bat_(?:test|live)_[A-Za-z0-9_-]{8,})\.[A-Za-z0-9_-]{16,}$/.exec(token);
  return match?.[1] ?? null;
}

export function hashBillingAdminToken(token: string): string {
  return `sha256:${createHash("sha256").update(token).digest("base64url")}`;
}

export function verifyBillingAdminToken(
  token: string,
  record: BillingAdminTokenRecord,
  now = new Date()
): GatewayError | null {
  if (!safeEqual(hashBillingAdminToken(token), record.hash)) {
    return invalidBillingAdminTokenError();
  }
  if (record.state !== "active" || record.revokedAt) {
    return invalidBillingAdminTokenError();
  }
  if (record.expiresAt.getTime() <= now.getTime()) {
    return invalidBillingAdminTokenError();
  }
  return null;
}

export function invalidBillingAdminTokenError(): GatewayError {
  return new GatewayError({
    code: "invalid_credential",
    message: "Invalid billing admin token.",
    httpStatus: 401
  });
}

function randomTokenPart(bytes: number): string {
  let value = randomBytes(bytes).toString("base64url");
  while (!/^[A-Za-z0-9]/.test(value)) {
    value = randomBytes(bytes).toString("base64url");
  }
  return value;
}

function safeEqual(received: string, expected: string): boolean {
  const receivedBuffer = Buffer.from(received);
  const expectedBuffer = Buffer.from(expected);
  if (receivedBuffer.length !== expectedBuffer.length) {
    return false;
  }
  return timingSafeEqual(receivedBuffer, expectedBuffer);
}
