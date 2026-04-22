import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { GatewayError } from "./errors.js";
import type { AccessCredentialRecord, RateLimitPolicy, Scope } from "./types.js";

export const accessCredentialTokenPrefix = "cgw";

export interface IssueAccessCredentialInput {
  subjectId: string;
  label: string;
  scope: Scope;
  expiresAt: Date;
  rate?: Partial<RateLimitPolicy>;
  now?: Date;
  rotatesId?: string | null;
}

export interface IssuedAccessCredential {
  token: string;
  record: AccessCredentialRecord;
}

export function issueAccessCredential(input: IssueAccessCredentialInput): IssuedAccessCredential {
  const prefix = randomTokenPart(10);
  const secret = randomTokenPart(32);
  const token = `${accessCredentialTokenPrefix}.${prefix}.${secret}`;
  const now = input.now ?? new Date();

  return {
    token,
    record: {
      id: `cred_${randomTokenPart(16)}`,
      prefix,
      hash: hashAccessCredential(token),
      subjectId: input.subjectId,
      label: input.label,
      scope: input.scope,
      expiresAt: input.expiresAt,
      revokedAt: null,
      rate: {
        requestsPerMinute: input.rate?.requestsPerMinute ?? 30,
        requestsPerDay: input.rate?.requestsPerDay ?? null,
        concurrentRequests: input.rate?.concurrentRequests ?? 1
      },
      createdAt: now,
      rotatesId: input.rotatesId ?? null
    }
  };
}

export function extractAccessCredentialPrefix(token: string): string | null {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== accessCredentialTokenPrefix) {
    return null;
  }

  const prefix = parts[1];
  if (!prefix || !/^[A-Za-z0-9_-]{8,}$/.test(prefix)) {
    return null;
  }

  return prefix;
}

export function hashAccessCredential(token: string): string {
  return `sha256:${createHash("sha256").update(token).digest("base64url")}`;
}

export function verifyAccessCredentialToken(
  token: string,
  record: AccessCredentialRecord,
  now = new Date()
): GatewayError | null {
  if (!safeEqual(hashAccessCredential(token), record.hash)) {
    return new GatewayError({
      code: "invalid_credential",
      message: "Invalid access credential.",
      httpStatus: 401
    });
  }

  if (record.revokedAt) {
    return new GatewayError({
      code: "revoked_credential",
      message: "Access credential has been revoked.",
      httpStatus: 401
    });
  }

  if (record.expiresAt.getTime() <= now.getTime()) {
    return new GatewayError({
      code: "expired_credential",
      message: "Access credential has expired.",
      httpStatus: 401
    });
  }

  return null;
}

function randomTokenPart(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}

function safeEqual(received: string, expected: string): boolean {
  const receivedBuffer = Buffer.from(received);
  const expectedBuffer = Buffer.from(expected);
  if (receivedBuffer.length !== expectedBuffer.length) {
    return false;
  }
  return timingSafeEqual(receivedBuffer, expectedBuffer);
}
