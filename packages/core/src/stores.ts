import type {
  AccessCredentialRecord,
  GatewaySession,
  RequestEventRecord,
  Subject,
  Subscription
} from "./types.js";

export interface CreateGatewaySessionInput {
  subjectId: string;
  subscriptionId: string;
  now?: Date;
}

export interface GatewaySessionStore {
  create(input: CreateGatewaySessionInput): GatewaySession;
  list(subjectId: string): GatewaySession[];
  get(id: string): GatewaySession | null;
  setProviderSessionRef(id: string, providerSessionRef: string): GatewaySession | null;
  close?(): void;
}

export interface BootstrapStore {
  upsertSubject(subject: Subject): void;
  upsertSubscription(subscription: Subscription): void;
}

export interface SubjectStore {
  getSubject(id: string): Subject | null;
}

export interface ListAccessCredentialsInput {
  subjectId?: string;
  includeRevoked?: boolean;
}

export interface AccessCredentialStore {
  insertAccessCredential(record: AccessCredentialRecord): AccessCredentialRecord;
  getAccessCredentialByPrefix(prefix: string): AccessCredentialRecord | null;
  listAccessCredentials(input?: ListAccessCredentialsInput): AccessCredentialRecord[];
  revokeAccessCredentialByPrefix(prefix: string, now?: Date): AccessCredentialRecord | null;
  setAccessCredentialExpiresAtByPrefix(
    prefix: string,
    expiresAt: Date
  ): AccessCredentialRecord | null;
}

export interface ListRequestEventsInput {
  credentialId?: string;
  subjectId?: string;
  limit?: number;
}

export interface ObservationStore {
  insertRequestEvent(record: RequestEventRecord): RequestEventRecord;
  listRequestEvents(input?: ListRequestEventsInput): RequestEventRecord[];
}

export type GatewayStore = GatewaySessionStore & BootstrapStore;
export type CredentialAuthStore = AccessCredentialStore & SubjectStore;
