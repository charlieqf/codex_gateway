/** HTTP identity outcomes, not authentication proofs or transactional security events. */
export const identityAuditOperations = [
  "phone_login", "phone_refresh", "phone_logout", "phone_bootstrap", "phone_account",
  "phone_identity_prepare", "phone_identity_state", "subject_resolve", "subject_create",
  "subject_lookup", "subject_get", "subject_rotate", "subject_disable",
  "registration_get", "registration_retry_disable", "issuance_create", "issuance_get",
  "issuance_resume", "issuance_retry_disable"
] as const;
export type IdentityAuditOperation = typeof identityAuditOperations[number];
export const identityAuditStages = [
  "preflight", "validation", "identity_resolution", "provisioning",
  "account_readiness", "credential_recovery", "response"
] as const;
export type IdentityAuditStage = typeof identityAuditStages[number];
export const identityFailureReasons = [
  "unclassified", "phone_multiple_subjects", "linked_subject_phone_mismatch",
  "external_identity_binding_conflict", "phone_reserved_by_other_identity",
  "registration_phone_mismatch", "registration_state_mismatch", "existing_subject",
  "phone_identity_owner_mismatch", "linked_identity_subject_mismatch"
] as const;
export type IdentityFailureReason = typeof identityFailureReasons[number];

/** Only facts already established by the domain operation; never raw tokens/bodies. */
export interface IdentityAuditFacts {
  subjectId?: string | null;
  conflictingSubjectId?: string | null;
  resolvedPhone?: string | null;
  sessionId?: string | null;
  jobId?: string | null;
  stage?: IdentityAuditStage;
  reasonCode?: IdentityFailureReason;
}
export type IdentityPhoneCaptureStatus =
  "not_available" | "absent" | "captured" | "invalid_type" | "unsafe_value";
export interface IdentityRequestEvent {
  requestId: string;
  operation: IdentityAuditOperation;
  method: string;
  routeTemplate: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  httpStatus: number | null;
  transportOutcome: "responded" | "aborted";
  outcome: "succeeded" | "accepted" | "rejected" | "failed" | "aborted";
  errorCode: string | null;
  reasonCode: string | null;
  stage: IdentityAuditStage | null;
  phoneInput: string | null;
  phoneNormalized: string | null;
  phoneCaptureStatus: IdentityPhoneCaptureStatus;
  provider: string | null;
  externalUserId: string | null;
  subjectId: string | null;
  targetSubjectId: string | null;
  conflictingSubjectId: string | null;
  resolvedPhone: string | null;
  sessionId: string | null;
  jobId: string | null;
  clientVersion: string | null;
}
export interface IdentityRateLimitEvent {
  operation: "phone_login";
  limitDimension: "phone" | "ip" | "device";
  limitKind: "request_minute";
  origin: "gateway";
  errorCode: "auth_rate_limited";
  completedAt: string;
  requestId: string;
  phoneInput: string | null;
  phoneNormalized: string | null;
}
export interface IdentityRequestAuditStore {
  recordIdentityRequestEvent(event: IdentityRequestEvent): void;
  recordIdentityRateLimit(event: IdentityRateLimitEvent): void;
  pruneIdentityRequestAudit(now: Date, batchSize?: number): { requests: number; minutes: number };
}
