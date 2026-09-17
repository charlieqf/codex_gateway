import type { Subject } from "./types.js";
import type { EnrollExistingPhoneAuthIdentityInput } from "./phone-auth.js";

export interface ExternalIdentityKey {
  provider: string;
  externalUserId: string;
}

export interface ResolveExternalSubjectInput extends ExternalIdentityKey {
  /** Supplied by the authenticated identity backend after SMS verification. */
  phone: string;
  requestId: string;
  now?: Date;
}

export interface ExternalSubjectResolution {
  status: "linked" | "create_ready" | "account_pending";
  subject: Subject | null;
}

export interface ResolveExternalSubjectOptions {
  /** Manual issuance must never link or enroll an existing account. */
  createOnly?: boolean;
  phoneHash?: string;
  /** Synchronous, read-only preparation under the association transaction's lock. */
  prepareLinkedPhoneIdentity?: (subject: Subject) => EnrollExistingPhoneAuthIdentityInput;
}

export interface ClaimExternalSubjectInput extends ExternalIdentityKey {
  idempotencyKey: string;
  payloadHash: string;
  now?: Date;
}

export interface ExternalSubjectRegistration extends ExternalIdentityKey {
  phone: string;
  state: "ready" | "creating" | "linked";
  subjectId: string | null;
  idempotencyKey: string | null;
  payloadHash: string | null;
  upstreamUserId: string | null;
  upstreamKeyId: string | null;
  lastErrorCode: string | null;
  lastErrorAt: Date | null;
  compensationState: "none" | "pending" | "disabled";
  releasedAt: Date | null;
}

export interface RecordExternalSubjectUpstreamInput extends ClaimExternalSubjectInput {
  upstreamUserId: string;
  upstreamKeyId: string;
}

export interface RecordExternalSubjectCreateFailureInput extends ClaimExternalSubjectInput {
  errorCode: string;
}

export interface ExternalSubjectCompensationInput extends RecordExternalSubjectUpstreamInput {
  actorId: string;
  requestId: string;
}

export interface ExternalIdentityStore {
  getSubjectByExternalIdentity(identity: ExternalIdentityKey): Subject | null;
  getExternalSubjectRegistration(identity: ExternalIdentityKey): ExternalSubjectRegistration | null;
  getExternalSubjectRegistrationState(identity: ExternalIdentityKey): "ready" | "creating" | "linked" | null;
  resolveExternalSubject(input: ResolveExternalSubjectInput, options?: ResolveExternalSubjectOptions): ExternalSubjectResolution;
  /** Reserve the business event before upstream provisioning; retries reuse it. */
  claimExternalSubjectCreate(input: ClaimExternalSubjectInput): string;
  /** Persist non-secret upstream identifiers so an interrupted create can be reconciled safely. */
  recordExternalSubjectUpstream(input: RecordExternalSubjectUpstreamInput): void;
  /** Preserve a machine-readable failure marker without releasing the phone reservation. */
  recordExternalSubjectCreateFailure(input: RecordExternalSubjectCreateFailureInput): void;
  /** Fences local completion before disabling an orphan. Never releases its phone. */
  beginExternalSubjectCompensation(input: ExternalSubjectCompensationInput): void;
  completeExternalSubjectCompensation(input: ExternalSubjectCompensationInput): void;
}
