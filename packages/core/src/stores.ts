import type {
  AccessCredentialRecord,
  AdminAuditAction,
  AdminAuditEventRecord,
  AdminAuditStatus,
  BillingAdminTokenRecord,
  BillingAdminTokenState,
  ClientDiagnosticEventRecord,
  ClientMessageEventRecord,
  GatewaySession,
  ProviderKind,
  RateLimitPolicy,
  RequestEventRecord,
  Scope,
  Subject,
  SubjectState,
  UnifiedClientKeyRecord,
  UpstreamAccount
} from "./types.js";
import type { BillingAdminStore } from "./billing.js";
import type { PublicModelAliasGroup } from "./public-model-usage.js";
import type { LimitKind } from "./token-budget.js";
import type { PlanEntitlementStore } from "./plan-entitlement.js";

export interface CreateGatewaySessionInput {
  subjectId: string;
  upstreamAccountId: string;
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
  upsertUpstreamAccount(upstreamAccount: UpstreamAccount): void;
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

export interface ListUnifiedClientKeysInput {
  subjectId?: string;
  includeRevoked?: boolean;
}

export interface UnifiedClientKeyStore {
  insertUnifiedClientKey(record: UnifiedClientKeyRecord): UnifiedClientKeyRecord;
  getUnifiedClientKeyByPrefix(prefix: string): UnifiedClientKeyRecord | null;
  listUnifiedClientKeys(input?: ListUnifiedClientKeysInput): UnifiedClientKeyRecord[];
  revokeUnifiedClientKeyByPrefix(prefix: string, now?: Date): UnifiedClientKeyRecord | null;
}

export interface ListBillingAdminTokensInput {
  activeOnly?: boolean;
  state?: BillingAdminTokenState;
  limit?: number;
}

export interface BillingAdminTokenStore {
  insertBillingAdminToken(record: BillingAdminTokenRecord): BillingAdminTokenRecord;
  getBillingAdminTokenByPrefix(prefix: string): BillingAdminTokenRecord | null;
  listBillingAdminTokens(input?: ListBillingAdminTokensInput): BillingAdminTokenRecord[];
  revokeBillingAdminTokenByPrefix(prefix: string, now?: Date): BillingAdminTokenRecord | null;
  updateBillingAdminTokenLastUsedAt(prefix: string, now?: Date): void;
}

export interface ListRequestEventsInput {
  credentialId?: string;
  subjectId?: string;
  clientTurnId?: string;
  turnCode?: string;
  since?: Date;
  until?: Date;
  limit?: number;
}

export interface RequestUsageReportInput {
  since: Date;
  until?: Date;
  credentialId?: string;
  subjectId?: string;
  publicModelId?: string;
  upstreamRuntime?: string;
  provider?: ProviderKind;
  groupBy?: "default" | "entitlement" | "model" | "user-model" | "entitlement-model";
  publicModelAliases?: PublicModelAliasGroup[];
}

export interface RequestUsageReportRow {
  date: string;
  credentialId: string | null;
  subjectId: string | null;
  scope: Scope | null;
  upstreamAccountId: string | null;
  provider: ProviderKind | null;
  publicModelId: string | null;
  upstreamRuntime: string | null;
  upstreamModel: string | null;
  reasoningEffort?: string | null;
  entitlementId?: string | null;
  requests: number;
  ok: number;
  errors: number;
  rateLimited: number;
  avgDurationMs: number | null;
  avgFirstByteMs: number | null;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedPromptTokens: number;
  estimatedTokens: number;
  reasoningTokens: number;
  usageMissing: number;
  rateLimitedBy: Partial<Record<LimitKind, number>>;
  overRequestLimit: number;
  identityGuardHit: number;
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

export interface ClientMessageEventStore {
  getClientMessageEvent(subjectId: string, eventId: string): ClientMessageEventRecord | null;
  listClientMessageEvents(input?: ListClientMessageEventsInput): ClientMessageEventRecord[];
  findClientMessageEventByMessageId(
    subjectId: string,
    messageId: string
  ): ClientMessageEventRecord | null;
  findLatestClientMessageEventForSession(
    subjectId: string,
    sessionId: string,
    createdAt: Date
  ): ClientMessageEventRecord | null;
  insertClientMessageEvent(record: ClientMessageEventRecord): ClientMessageEventRecord;
  getClientDiagnosticEvent(subjectId: string, eventId: string): ClientDiagnosticEventRecord | null;
  listClientDiagnosticEventsForSession(
    subjectId: string,
    sessionId: string,
    fromCreatedAt: Date
  ): ClientDiagnosticEventRecord[];
  updateClientDiagnosticEventLink(
    subjectId: string,
    eventId: string,
    input: { sessionId: string; messageId: string; metadataJson: string }
  ): ClientDiagnosticEventRecord | null;
  insertClientDiagnosticEvent(
    record: ClientDiagnosticEventRecord
  ): ClientDiagnosticEventRecord;
  close?(): void;
}

export interface ListClientMessageEventsInput {
  subjectId?: string;
  credentialId?: string;
  sessionId?: string;
  messageId?: string;
  since?: Date;
  until?: Date;
  limit?: number;
}

export type GatewayStore = GatewaySessionStore & BootstrapStore;
export type CredentialAuthStore = AccessCredentialStore & SubjectStore;
export type EntitlementBackedGatewayStore = GatewayStore & PlanEntitlementStore;
export type BillingBackedGatewayStore = GatewayStore & BillingAdminStore;
