import { createHash } from "node:crypto";
import type {
  Entitlement,
  PeriodKind,
  Plan
} from "./plan-entitlement.js";
import type {
  AccessCredentialRecord,
  Scope,
  Subject,
  UnifiedClientKeyRecord,
  UpstreamV2BindingRecord
} from "./types.js";
import type { PublicModelAliasGroup } from "./public-model-usage.js";

export const billingEventTypes = [
  "purchase",
  "renew",
  "pause",
  "resume",
  "cancel",
  "notice"
] as const;

export type BillingEventType = (typeof billingEventTypes)[number];
export type BillingApplyMode = "apply" | "log_only";
export type BillingEventStatus = "applied" | "failed" | "ignored";
export type BillingUsageGroupBy = "day" | "month" | "none" | "model";
export type BillingSubjectLifecycleEventType =
  | "create_subject"
  | "rotate_key"
  | "disable_subject";

export interface BillingEventRecord {
  id: string;
  idempotencyKey: string;
  payloadHash: string;
  provider: string;
  externalOrderId: string;
  externalEventId: string | null;
  eventType: BillingEventType;
  applyMode: BillingApplyMode;
  subjectId: string;
  planId: string | null;
  entitlementId: string | null;
  status: BillingEventStatus;
  amountMinor: number | null;
  currency: string | null;
  periodKind: PeriodKind | null;
  periodStart: Date | null;
  periodEnd: Date | null;
  appliedAt: Date | null;
  errorMessage: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
}

export interface ApplyBillingEntitlementEventInput {
  idempotencyKey: string;
  eventType: BillingEventType;
  applyMode: BillingApplyMode;
  provider: string;
  externalOrderId: string;
  externalEventId?: string | null;
  subjectId: string;
  planId?: string | null;
  periodKind?: PeriodKind | null;
  periodStart?: Date | null;
  periodEnd?: Date | null;
  replaceCurrent?: boolean;
  replaceScheduled?: boolean;
  replacePaused?: boolean;
  entitlementId?: string | null;
  reason?: string | null;
  amountMinor?: number | null;
  currency?: string | null;
  metadata?: Record<string, unknown> | null;
  payloadHash: string;
  now?: Date;
}

export interface ApplyBillingEntitlementEventResult {
  applied: boolean;
  idempotentReplay: boolean;
  billingEvent: BillingEventRecord;
  subjectId: string;
  plan: Plan | null;
  entitlement: Entitlement | null;
  cancelledEntitlementIds: string[];
}

export interface ListBillingEventsInput {
  subjectId?: string;
  provider?: string;
  externalOrderId?: string;
  limit?: number;
  cursor?: string;
}

export interface BillingEventListResult {
  events: BillingEventRecord[];
  nextCursor: string | null;
}

export interface ListBillingEntitlementsInput {
  subjectId: string;
  limit?: number;
  cursor?: string;
}

export interface BillingEntitlementListResult {
  subjectId: string;
  current: Entitlement | null;
  history: Entitlement[];
  nextCursor: string | null;
}

export interface BillingUsageReportInput {
  subjectId: string;
  from: Date;
  to: Date;
  groupBy: BillingUsageGroupBy;
  publicModelId?: string;
  publicModelAliases?: PublicModelAliasGroup[];
  limit?: number;
  cursor?: string;
}

export interface BillingUsageReportRow {
  periodStart: Date | null;
  publicModelId?: string | null;
  requestCount: number;
  successCount: number;
  errorCount: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedTokens: number;
}

export interface BillingUsageReportResult {
  subjectId: string;
  from: Date;
  to: Date;
  groupBy: BillingUsageGroupBy;
  rows: BillingUsageReportRow[];
  nextCursor: string | null;
}

export interface BillingSubjectCredential {
  id: string;
  keyPrefix: string;
  issuedAt: Date;
  expiresAt: Date | null;
  state: "active" | "revoked" | "expired";
}

export interface BillingSubjectDetails {
  subject: Subject;
  scopeAllowlist: Scope[];
  credentials: BillingSubjectCredential[];
  upstreamV2Binding: UpstreamV2BindingRecord | null;
}

export interface CreateBillingSubjectInput {
  idempotencyKey: string;
  payloadHash: string;
  subjectId: string;
  provider: string;
  externalUserId: string;
  displayName?: string | null;
  scopeAllowlist: Scope[];
  metadata?: Record<string, unknown> | null;
  gatewayCredential: AccessCredentialRecord;
  unifiedClientKey: UnifiedClientKeyRecord;
  upstreamV2Binding: UpstreamV2BindingRecord;
  now?: Date;
}

export interface CreateBillingSubjectResult extends BillingSubjectDetails {
  created: boolean;
  idempotentReplay: boolean;
  gatewayCredential: AccessCredentialRecord;
  unifiedClientKey: UnifiedClientKeyRecord;
}

export interface RotateBillingSubjectInput {
  idempotencyKey: string;
  payloadHash: string;
  subjectId: string;
  reason?: string | null;
  revokePrevious: boolean;
  gracePeriodSeconds: number;
  gatewayCredential: AccessCredentialRecord;
  unifiedClientKey: UnifiedClientKeyRecord;
  now?: Date;
}

export interface RotateBillingSubjectResult extends BillingSubjectDetails {
  rotated: boolean;
  idempotentReplay: boolean;
  gatewayCredential: AccessCredentialRecord;
  unifiedClientKey: UnifiedClientKeyRecord;
  revokedCredentialIds: string[];
  revokedUnifiedKeyIds: string[];
}

export interface DisableBillingSubjectInput {
  idempotencyKey: string;
  payloadHash: string;
  subjectId: string;
  reason?: string | null;
  now?: Date;
}

export interface DisableBillingSubjectResult extends BillingSubjectDetails {
  disabled: boolean;
  idempotentReplay: boolean;
  revokedCredentialIds: string[];
  revokedUnifiedKeyIds: string[];
  cancelledEntitlementIds: string[];
}

export interface BillingAdminStore {
  replayBillingSubjectCreate(
    idempotencyKey: string,
    payloadHash: string
  ): CreateBillingSubjectResult | null;
  createBillingSubject(input: CreateBillingSubjectInput): CreateBillingSubjectResult;
  replayBillingSubjectRotate(
    idempotencyKey: string,
    payloadHash: string
  ): RotateBillingSubjectResult | null;
  rotateBillingSubject(input: RotateBillingSubjectInput): RotateBillingSubjectResult;
  replayBillingSubjectDisable(
    idempotencyKey: string,
    payloadHash: string
  ): DisableBillingSubjectResult | null;
  disableBillingSubject(input: DisableBillingSubjectInput): DisableBillingSubjectResult;
  getBillingSubject(subjectId: string): BillingSubjectDetails | null;
  getBillingSubjectByExternal(
    provider: string,
    externalUserId: string
  ): BillingSubjectDetails | null;
  getBillingSubjectActiveUnifiedKey(subjectId: string): UnifiedClientKeyRecord | null;
  applyBillingEntitlementEvent(
    input: ApplyBillingEntitlementEventInput
  ): ApplyBillingEntitlementEventResult;
  getBillingEventByIdempotencyKey(idempotencyKey: string): BillingEventRecord | null;
  listBillingEvents(input?: ListBillingEventsInput): BillingEventListResult;
  listBillingEntitlements(input: ListBillingEntitlementsInput): BillingEntitlementListResult;
  reportBillingUsage(input: BillingUsageReportInput): BillingUsageReportResult;
}

export function isBillingEventType(value: unknown): value is BillingEventType {
  return typeof value === "string" && (billingEventTypes as readonly string[]).includes(value);
}

export function validateBillingIdempotencyKey(value: string): boolean {
  return value.length >= 1 && value.length <= 200 && /^[A-Za-z0-9._:-]+$/.test(value);
}

export function billingPayloadHash(payload: unknown): string {
  return `sha256:${createHash("sha256")
    .update(canonicalJson(payload))
    .digest("base64url")}`;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === "object") {
    const input = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(input).sort()) {
      const field = input[key];
      if (field !== undefined) {
        output[key] = canonicalize(field);
      }
    }
    return output;
  }
  return value;
}
