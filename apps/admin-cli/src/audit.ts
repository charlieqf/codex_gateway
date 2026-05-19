import { randomUUID } from "node:crypto";

import type {
  AdminAuditAction,
  AdminAuditEventRecord,
  AdminAuditStatus
} from "@codex-gateway/core";

export interface AuditInput {
  action: AdminAuditAction;
  targetUserId?: string | null;
  targetCredentialId?: string | null;
  targetCredentialPrefix?: string | null;
  params?: Record<string, unknown> | null;
}

export interface AuditedActionResult {
  output: unknown;
  audit?: Partial<AuditInput>;
}

export function mergeAudit(
  base: AuditInput,
  extra: Partial<AuditInput> | undefined
): AuditInput {
  return {
    ...base,
    ...extra,
    params: mergeAuditParams(base.params, extra?.params)
  };
}

export function adminAuditRecord(
  input: AuditInput,
  status: AdminAuditStatus,
  errorMessage: string | null
): AdminAuditEventRecord {
  return {
    id: `audit_${randomUUID()}`,
    action: input.action,
    targetUserId: input.targetUserId ?? null,
    targetCredentialId: input.targetCredentialId ?? null,
    targetCredentialPrefix: input.targetCredentialPrefix ?? null,
    status,
    params: input.params ?? null,
    errorMessage,
    createdAt: new Date()
  };
}

export function sanitizeAuditErrorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message
    .replace(/cmev1\.[A-Za-z0-9._~-]{16,}/g, "cmev1.<redacted>")
    .replace(/cgu_live_[A-Za-z0-9]{64}/g, "cgu_live_<redacted>")
    .replace(/cgw\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "cgw.<redacted>")
    .replace(/mev2_live_[A-Za-z0-9_-]+/g, "mev2_live_<redacted>")
    .replace(/bat_(?:test|live)_[A-Za-z0-9._-]+/g, "bat_<redacted>")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer <redacted>");
}

function mergeAuditParams(
  base: Record<string, unknown> | null | undefined,
  extra: Record<string, unknown> | null | undefined
): Record<string, unknown> | null {
  if (base && extra) {
    return { ...base, ...extra };
  }
  return extra ?? base ?? null;
}
