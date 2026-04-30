import { DatabaseSync } from "node:sqlite";
import * as accessCredentials from "./access-credentials.js";
import * as adminAudit from "./admin-audit.js";
import * as entitlementsStore from "./entitlements.js";
import type { EntitlementStoreDependencies } from "./entitlements.js";
import { migrateGatewaySchema } from "./migrations.js";
import * as plansStore from "./plans.js";
import * as requestEvents from "./request-events.js";
import * as sessionsStore from "./sessions.js";
import {
  openConfiguredSqliteDatabase,
  tightenSqliteFilePermissions
} from "./sqlite-managed.js";
import * as subjectsStore from "./subjects.js";
import type { SqliteStoreLogger, SqliteStoreOptions, UpdateSubjectInput } from "./types.js";
import * as upstreamAccounts from "./upstream-accounts.js";
import {
  type AccessCredentialRecord,
  type AdminAuditEventRecord,
  type CreatePlanInput,
  type CreateGatewaySessionInput,
  type Entitlement,
  type EntitlementAccessDecision,
  type GatewaySession,
  type GatewayStore,
  type GrantEntitlementInput,
  type ListAccessCredentialsInput,
  type ListAdminAuditEventsInput,
  type ListEntitlementsInput,
  type ListPlansInput,
  type ListRequestEventsInput,
  type ListSubjectsInput,
  type Plan,
  type PruneRequestEventsInput,
  type PruneRequestEventsResult,
  type RenewEntitlementInput,
  type RequestEventRecord,
  type RequestUsageReportInput,
  type RequestUsageReportRow,
  type Subject,
  type SubjectState,
  type UpstreamAccount,
  type UpdateAccessCredentialInput,
  type UpdateEntitlementStateInput
} from "@codex-gateway/core";

export type { SqliteStoreLogger, SqliteStoreOptions, UpdateSubjectInput } from "./types.js";

export class SqliteGatewayStore implements GatewayStore {
  readonly kind = "sqlite";
  readonly path: string;
  private readonly db: DatabaseSync;
  private readonly logger?: SqliteStoreLogger;

  constructor(options: SqliteStoreOptions) {
    this.path = options.path;
    this.logger = options.logger;
    this.db = openConfiguredSqliteDatabase(options.path);
    migrateGatewaySchema(this.db, this.logger);
    tightenSqliteFilePermissions(this.path);
  }

  get database(): DatabaseSync {
    return this.db;
  }

  upsertSubject(subject: Subject): void {
    subjectsStore.upsert(this.db, subject);
  }

  upsertUpstreamAccount(upstreamAccount: UpstreamAccount): void {
    upstreamAccounts.upsert(this.db, upstreamAccount);
  }

  getSubject(id: string): Subject | null {
    return subjectsStore.get(this.db, id);
  }

  listSubjects(input: ListSubjectsInput = {}): Subject[] {
    return subjectsStore.list(this.db, input);
  }

  updateSubject(id: string, input: UpdateSubjectInput): Subject | null {
    return subjectsStore.update(this.db, id, input);
  }

  setSubjectState(id: string, state: SubjectState): Subject | null {
    return subjectsStore.setState(this.db, id, state);
  }

  insertAccessCredential(record: AccessCredentialRecord): AccessCredentialRecord {
    return accessCredentials.insert(this.db, record);
  }

  getAccessCredentialByPrefix(prefix: string): AccessCredentialRecord | null {
    return accessCredentials.getByPrefix(this.db, prefix);
  }

  listAccessCredentials(input: ListAccessCredentialsInput = {}): AccessCredentialRecord[] {
    return accessCredentials.list(this.db, input);
  }

  updateAccessCredentialByPrefix(
    prefix: string,
    input: UpdateAccessCredentialInput
  ): AccessCredentialRecord | null {
    return accessCredentials.updateByPrefix(this.db, prefix, input);
  }

  revokeAccessCredentialByPrefix(
    prefix: string,
    now: Date = new Date()
  ): AccessCredentialRecord | null {
    return accessCredentials.revokeByPrefix(this.db, prefix, now);
  }

  setAccessCredentialExpiresAtByPrefix(
    prefix: string,
    expiresAt: Date
  ): AccessCredentialRecord | null {
    return accessCredentials.setExpiresAtByPrefix(this.db, prefix, expiresAt);
  }

  createPlan(input: CreatePlanInput): Plan {
    return plansStore.create(this.db, input);
  }

  listPlans(input: ListPlansInput = {}): Plan[] {
    return plansStore.list(this.db, input);
  }

  getPlan(id: string): Plan | null {
    return plansStore.get(this.db, id);
  }

  deprecatePlan(id: string): Plan | null {
    return plansStore.deprecate(this.db, id);
  }

  grantEntitlement(input: GrantEntitlementInput): Entitlement {
    return entitlementsStore.grant(this.db, input, this.entitlementDependencies());
  }

  renewEntitlement(input: RenewEntitlementInput): Entitlement {
    return entitlementsStore.renew(this.db, input, this.entitlementDependencies());
  }

  getEntitlement(id: string): Entitlement | null {
    return entitlementsStore.get(this.db, id);
  }

  listEntitlements(input: ListEntitlementsInput = {}): Entitlement[] {
    return entitlementsStore.list(this.db, input);
  }

  pauseEntitlement(input: UpdateEntitlementStateInput): Entitlement {
    return entitlementsStore.pause(this.db, input);
  }

  resumeEntitlement(input: UpdateEntitlementStateInput): Entitlement {
    return entitlementsStore.resume(this.db, input);
  }

  cancelEntitlement(input: UpdateEntitlementStateInput): Entitlement {
    return entitlementsStore.cancel(this.db, input);
  }

  entitlementAccessForSubject(
    subjectId: string,
    now: Date = new Date()
  ): EntitlementAccessDecision {
    return entitlementsStore.accessForSubject(
      this.db,
      subjectId,
      now,
      this.entitlementDependencies()
    );
  }

  subjectHasEntitlementHistory(subjectId: string): boolean {
    return entitlementsStore.hasHistory(this.db, subjectId);
  }

  insertAdminAuditEvent(record: AdminAuditEventRecord): AdminAuditEventRecord {
    return adminAudit.insert(this.db, record);
  }

  listAdminAuditEvents(input: ListAdminAuditEventsInput = {}): AdminAuditEventRecord[] {
    return adminAudit.list(this.db, input);
  }

  create(input: CreateGatewaySessionInput): GatewaySession {
    return sessionsStore.create(this.db, input);
  }

  list(subjectId: string): GatewaySession[] {
    return sessionsStore.list(this.db, subjectId);
  }

  get(id: string): GatewaySession | null {
    return sessionsStore.get(this.db, id);
  }

  setProviderSessionRef(id: string, providerSessionRef: string): GatewaySession | null {
    return sessionsStore.setProviderSessionRef(this.db, id, providerSessionRef);
  }

  insertRequestEvent(record: RequestEventRecord): RequestEventRecord {
    return requestEvents.insert(this.db, record);
  }

  listRequestEvents(input: ListRequestEventsInput = {}): RequestEventRecord[] {
    return requestEvents.list(this.db, input);
  }

  reportRequestUsage(input: RequestUsageReportInput): RequestUsageReportRow[] {
    return requestEvents.reportUsage(this.db, input);
  }

  pruneRequestEvents(input: PruneRequestEventsInput): PruneRequestEventsResult {
    return requestEvents.prune(this.db, input);
  }

  private entitlementDependencies(): EntitlementStoreDependencies {
    return {
      getPlan: (id) => this.getPlan(id),
      listAccessCredentials: (input) => this.listAccessCredentials(input)
    };
  }

  close(): void {
    this.db.close();
  }

}

export function createSqliteStore(options: SqliteStoreOptions): SqliteGatewayStore {
  return new SqliteGatewayStore(options);
}

export {
  createSqliteTokenBudgetLimiter,
  SqliteTokenBudgetLimiter,
  type SqliteTokenBudgetLimiterOptions,
  type TokenReservationListInput,
  type TokenReservationListRow
} from "./token-budget.js";

export { createSqliteClientEventsStore, SqliteClientEventsStore } from "./client-events-store.js";
