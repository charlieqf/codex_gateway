import type {
  AccessCredentialRecord,
  AdminAuditAction,
  AdminAuditEventRecord,
  AdminAuditStatus,
  GatewaySession,
  ProviderKind,
  RateLimitPolicy,
  RequestEventRecord,
  Scope,
  Subject,
  SubjectState,
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
  listSubjects(input?: ListSubjectsInput): Subject[];
  setSubjectState(id: string, state: SubjectState): Subject | null;
}

export interface ListSubjectsInput {
  includeArchived?: boolean;
  state?: SubjectState;
}

export interface ListAccessCredentialsInput {
  subjectId?: string;
  includeRevoked?: boolean;
}

export interface UpdateAccessCredentialInput {
  label?: string;
  scope?: Scope;
  expiresAt?: Date;
  rate?: RateLimitPolicy;
}

export interface AccessCredentialStore {
  insertAccessCredential(record: AccessCredentialRecord): AccessCredentialRecord;
  getAccessCredentialByPrefix(prefix: string): AccessCredentialRecord | null;
  listAccessCredentials(input?: ListAccessCredentialsInput): AccessCredentialRecord[];
  updateAccessCredentialByPrefix(
    prefix: string,
    input: UpdateAccessCredentialInput
  ): AccessCredentialRecord | null;
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

export interface RequestUsageReportInput {
  since: Date;
  until?: Date;
  credentialId?: string;
  subjectId?: string;
}

export interface RequestUsageReportRow {
  date: string;
  credentialId: string | null;
  subjectId: string | null;
  scope: Scope | null;
  subscriptionId: string | null;
  provider: ProviderKind | null;
  requests: number;
  ok: number;
  errors: number;
  rateLimited: number;
  avgDurationMs: number | null;
  avgFirstByteMs: number | null;
}

export interface PruneRequestEventsInput {
  before: Date;
  dryRun?: boolean;
}

export interface PruneRequestEventsResult {
  before: Date;
  dryRun: boolean;
  matched: number;
  deleted: number;
}

export interface ListAdminAuditEventsInput {
  userId?: string;
  action?: AdminAuditAction;
  status?: AdminAuditStatus;
  limit?: number;
}

export interface AdminAuditStore {
  insertAdminAuditEvent(record: AdminAuditEventRecord): AdminAuditEventRecord;
  listAdminAuditEvents(input?: ListAdminAuditEventsInput): AdminAuditEventRecord[];
}

export interface ObservationStore {
  insertRequestEvent(record: RequestEventRecord): RequestEventRecord;
  listRequestEvents(input?: ListRequestEventsInput): RequestEventRecord[];
  reportRequestUsage(input: RequestUsageReportInput): RequestUsageReportRow[];
  pruneRequestEvents(input: PruneRequestEventsInput): PruneRequestEventsResult;
}

export type GatewayStore = GatewaySessionStore & BootstrapStore;
export type CredentialAuthStore = AccessCredentialStore & SubjectStore;
