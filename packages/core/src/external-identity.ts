import type { Subject } from "./types.js";

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

export interface ClaimExternalSubjectInput extends ExternalIdentityKey {
  idempotencyKey: string;
  payloadHash: string;
  now?: Date;
}

export interface ExternalIdentityStore {
  getSubjectByExternalIdentity(identity: ExternalIdentityKey): Subject | null;
  getExternalSubjectRegistrationState(identity: ExternalIdentityKey): "ready" | "creating" | "linked" | null;
  resolveExternalSubject(input: ResolveExternalSubjectInput): ExternalSubjectResolution;
  /** Reserve the business event before upstream provisioning; retries reuse it. */
  claimExternalSubjectCreate(input: ClaimExternalSubjectInput): string;
}
