import { createHash, createHmac, randomBytes } from "node:crypto";
import type { SubjectState, UnifiedClientKeyRecord } from "./types.js";

export type PhoneAuthMode = "disabled" | "transition";
export type PhoneAuthIdentityState = "active" | "disabled";
export type PhoneAuthSessionState = "active" | "revoked";
export type PhoneAuthRefreshState = "active" | "rotated" | "revoked";
export type PhoneAuthMethod = "transition_phone_only";

export interface PhoneAuthIdentity {
  phoneHash: string;
  phoneCiphertext: string;
  subjectId: string;
  unifiedKeyId: string;
  state: PhoneAuthIdentityState;
  createdAt: Date;
  updatedAt: Date;
}

export interface PhoneAuthSession {
  id: string;
  subjectId: string;
  phoneHash: string;
  deviceId: string;
  client: "medevidence-desktop";
  authMethod: PhoneAuthMethod;
  state: PhoneAuthSessionState;
  absoluteExpiresAt: Date;
  revokedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface PhoneAuthRefreshTokenRecord {
  id: string;
  sessionId: string;
  prefix: string;
  hash: string;
  generation: number;
  state: PhoneAuthRefreshState;
  expiresAt: Date;
  rotatedAt: Date | null;
  createdAt: Date;
}

export type PhoneAuthAuditAction =
  | "prepare_identity"
  | "identity_state"
  | "login"
  | "refresh"
  | "logout"
  | "bootstrap"
  | "account_current";

export interface PhoneAuthAuditInput {
  requestId: string;
  action: PhoneAuthAuditAction;
  phoneHash: string | null;
  subjectId: string | null;
  sessionId: string | null;
  authMethod: PhoneAuthMethod | null;
  outcome: "ok" | "error";
  reasonCode: string | null;
  now: Date;
}

export interface PreparePhoneAuthIdentityInput {
  phoneHash: string;
  phoneCiphertext: string;
  subjectId: string;
  unifiedKeyId: string;
  unifiedKeyTokenCiphertext: string;
  unifiedKeyMetadata: Record<string, unknown>;
  backingAllowedPublicModels: string[];
  requestId: string;
  now: Date;
}

export interface CreatePhoneAuthSessionInput {
  session: PhoneAuthSession;
  refreshToken: PhoneAuthRefreshTokenRecord;
  requestId: string;
}

export interface RotatePhoneAuthRefreshTokenInput {
  refreshTokenHash: string;
  deviceId: string;
  replacement: Omit<PhoneAuthRefreshTokenRecord, "sessionId" | "generation">;
  requestId: string;
  now: Date;
}

export type RotatePhoneAuthRefreshTokenResult =
  | { status: "ok"; session: PhoneAuthSession }
  | { status: "invalid" }
  | { status: "replay" };

export interface PhoneAuthStore {
  preparePhoneAuthIdentity(input: PreparePhoneAuthIdentityInput): PhoneAuthIdentity;
  setPhoneAuthIdentityState(
    phoneHash: string,
    state: PhoneAuthIdentityState,
    audit: PhoneAuthAuditInput
  ): PhoneAuthIdentity | null;
  getPhoneAuthIdentityByPhoneHash(phoneHash: string): PhoneAuthIdentity | null;
  getPhoneAuthIdentityBySubjectId(subjectId: string): PhoneAuthIdentity | null;
  getPhoneAuthUnifiedKey(unifiedKeyId: string): UnifiedClientKeyRecord | null;
  createPhoneAuthSession(input: CreatePhoneAuthSessionInput): PhoneAuthSession;
  getPhoneAuthSession(id: string): PhoneAuthSession | null;
  rotatePhoneAuthRefreshToken(
    input: RotatePhoneAuthRefreshTokenInput
  ): RotatePhoneAuthRefreshTokenResult;
  revokePhoneAuthSession(id: string, audit: PhoneAuthAuditInput): PhoneAuthSession | null;
  recordPhoneAuthAudit(input: PhoneAuthAuditInput): void;
}

export interface PhoneAuthSubjectSnapshot {
  id: string;
  state: SubjectState;
}

export interface IssuedPhoneAuthRefreshToken {
  token: string;
  prefix: string;
  hash: string;
}

export function normalizeMainlandChinaPhone(value: string): string | null {
  const normalized = value.startsWith("+86") ? value.slice(3) : value;
  if (!/^1[3-9][0-9]{9}$/u.test(normalized)) {
    return null;
  }
  return `+86${normalized}`;
}

export function phoneLookupHash(normalizedPhone: string, secret: string): string {
  if (!secret) {
    throw new Error("Phone lookup HMAC secret is required.");
  }
  return `hmac-sha256:${createHmac("sha256", secret)
    .update(normalizedPhone, "utf8")
    .digest("base64url")}`;
}

export function issuePhoneAuthRefreshToken(): IssuedPhoneAuthRefreshToken {
  const payload = randomBytes(48).toString("base64url");
  const token = `rft_${payload}`;
  return {
    token,
    prefix: payload.slice(0, 16),
    hash: hashPhoneAuthRefreshToken(token)
  };
}

export function hashPhoneAuthRefreshToken(token: string): string {
  return `sha256:${createHash("sha256").update(token, "utf8").digest("base64url")}`;
}
