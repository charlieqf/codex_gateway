import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { GatewayError } from "./errors.js";
import type { UnifiedClientKeyRecord } from "./types.js";

export const unifiedClientKeyTokenPrefix = "cgu_live_";

export interface IssueUnifiedClientKeyInput {
  subjectId: string;
  label: string;
  expiresAt: Date;
  codexCredentialId: string;
  codexCredentialPrefix: string;
  codexKeyCiphertext: string;
  medevidenceKeyCiphertext: string;
  medevidenceKeyPrefix?: string | null;
  metadata?: Record<string, unknown> | null;
  now?: Date;
}

export interface IssuedUnifiedClientKey {
  token: string;
  record: UnifiedClientKeyRecord;
}

export function issueUnifiedClientKey(input: IssueUnifiedClientKeyInput): IssuedUnifiedClientKey {
  const payload = randomBase62(64);
  const token = `${unifiedClientKeyTokenPrefix}${payload}`;
  const now = input.now ?? new Date();
  return {
    token,
    record: {
      id: `uck_${randomBase62(16)}`,
      prefix: payload.slice(0, 16),
      hash: hashUnifiedClientKey(token),
      subjectId: input.subjectId,
      label: input.label,
      expiresAt: input.expiresAt,
      revokedAt: null,
      codexCredentialId: input.codexCredentialId,
      codexCredentialPrefix: input.codexCredentialPrefix,
      codexKeyCiphertext: input.codexKeyCiphertext,
      medevidenceKeyCiphertext: input.medevidenceKeyCiphertext,
      medevidenceKeyPrefix: input.medevidenceKeyPrefix ?? null,
      createdAt: now,
      metadata: input.metadata ?? null
    }
  };
}

export function extractUnifiedClientKeyPrefix(token: string): string | null {
  if (!token.startsWith(unifiedClientKeyTokenPrefix)) {
    return null;
  }
  const payload = token.slice(unifiedClientKeyTokenPrefix.length);
  if (!/^[A-Za-z0-9]{64}$/.test(payload)) {
    return null;
  }
  return payload.slice(0, 16);
}

export function hashUnifiedClientKey(token: string): string {
  return `sha256:${createHash("sha256").update(token).digest("base64url")}`;
}

export function verifyUnifiedClientKeyToken(
  token: string,
  record: UnifiedClientKeyRecord,
  now = new Date()
): GatewayError | null {
  if (!safeEqual(hashUnifiedClientKey(token), record.hash)) {
    return new GatewayError({
      code: "invalid_credential",
      message: "Invalid unified key.",
      httpStatus: 401
    });
  }
  if (record.revokedAt) {
    return new GatewayError({
      code: "revoked_credential",
      message: "Unified key has been revoked.",
      httpStatus: 401
    });
  }
  if (record.expiresAt.getTime() <= now.getTime()) {
    return new GatewayError({
      code: "expired_credential",
      message: "Unified key has expired.",
      httpStatus: 401
    });
  }
  return null;
}

function randomBase62(length: number): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let output = "";
  while (output.length < length) {
    const bytes = randomBytes(length);
    for (const byte of bytes) {
      if (byte >= 248) {
        continue;
      }
      output += alphabet[byte % alphabet.length];
      if (output.length === length) {
        break;
      }
    }
  }
  return output;
}

function safeEqual(received: string, expected: string): boolean {
  const receivedBuffer = Buffer.from(received);
  const expectedBuffer = Buffer.from(expected);
  if (receivedBuffer.length !== expectedBuffer.length) {
    return false;
  }
  return timingSafeEqual(receivedBuffer, expectedBuffer);
}
