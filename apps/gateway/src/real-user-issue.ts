import { randomUUID } from "node:crypto";
import {
  GatewayError,
  gatewayErrorCodes,
  type GatewayErrorCode,
  decryptSecret,
  encryptSecret,
  type IssuanceTaskStore,
  type IssuanceTaskRecord,
  normalizeAccessCredentialStoredPrefix,
  normalizeMainlandChinaPhone
} from "@codex-gateway/core";
import type { RateLimitPolicy } from "@codex-gateway/core";

/**
 * Background issuance of a real-user cgu_live key.
 *
 * This mirrors `scripts/issue-real-user-cgu-key.py --r760-only`: R760 is the
 * authority, no Azure compatibility mirror is attempted, and every step that
 * the script validates is validated here too. The work runs as a job because a
 * full issue-and-validate cycle takes tens of seconds and must not depend on a
 * single HTTP request staying open.
 *
 * The full `cgu_live_*` key only ever lives in the job record, in memory, for a
 * short reveal window, and is only returned to the admin token that started the
 * job. It is never logged and never written to disk.
 */

export const realUserIssueStepKeys = [
  "create_subject",
  "grant_entitlement",
  "resolve_key",
  "normalize_metadata",
  "validate_credential",
  "prepare_phone_login"
] as const;

export type RealUserIssueStepKey = (typeof realUserIssueStepKeys)[number];
export type RealUserIssueStepState = "pending" | "running" | "ok" | "failed";
export type RealUserIssueJobState = "queued" | "running" | "retryable" | "compensating" | "compensation_failed" | "succeeded" | "failed";

const stepLabels: Record<RealUserIssueStepKey, string> = {
  create_subject: "创建计费主体与 key",
  grant_entitlement: "授予 Plan 权益",
  resolve_key: "解析 key 并校验运行态凭据",
  normalize_metadata: "写入姓名/手机并规范限额",
  validate_credential: "校验凭据与能力",
  prepare_phone_login: "准备手机号免验证码登录"
};

export const minimumRealUserRequestsPerMinute = 20;

export const defaultRealUserIssueRate: RateLimitPolicy = {
  requestsPerMinute: minimumRealUserRequestsPerMinute,
  requestsPerDay: 200,
  concurrentRequests: 4
};

export const defaultRealUserPlanId = "plan_internal_high_quota_image_v1";
export const defaultRealUserProvider = "manual_trial";
export const minRealUserValidityDays = 90;
export const defaultRealUserValidityDays = 92;

export interface RealUserIssueStep {
  key: RealUserIssueStepKey;
  label: string;
  state: RealUserIssueStepState;
  detail: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
}

export interface RealUserIssueResult {
  subjectId: string;
  keyPrefix: string;
  codexGatewayPrefix: string;
  medevidencePrefix: string | null;
  planId: string;
  entitlementState: string;
  capabilities: string[];
  imageGeneration: boolean;
  rate: RateLimitPolicy;
  backingKeyExpiresAt: Date;
  entitlementEnd: Date;
  endpointBaseUrl: string | null;
}

export interface RealUserIssueJob {
  id: string;
  state: RealUserIssueJobState;
  actorTokenPrefix: string | null;
  externalUserId: string;
  displayName: string;
  phoneTail: string;
  steps: RealUserIssueStep[];
  result: RealUserIssueResult | null;
  unifiedKey: string | null;
  unifiedKeyExpiresAt: Date | null;
  error: { code: string; message: string } | null;
  createdAt: Date;
  updatedAt: Date;
  input?: RealUserIssueInput;
  subjectId: string | null;
  compensationError: { code: string; message: string } | null;
  /** Persisted in the encrypted snapshot, without changing the SQL state enum. */
  requiresReview?: boolean;
}

export interface RealUserIssueInput {
  name: string;
  phone: string;
  externalUserId: string;
  provider: string;
  planId: string;
  scope: string;
  rate: RateLimitPolicy;
  entitlementEnd: Date;
  keyExpiresAt: Date;
  requireImageCapability: boolean;
}

export interface RealUserIssueJobStoreOptions {
  /** How long a finished job stays readable. */
  jobTtlMs?: number;
  /** How long the full cgu_live key stays retrievable after success. */
  keyTtlMs?: number;
  maxJobs?: number;
  now?: () => Date;
  persistence?: IssuanceTaskStore;
  encryptionSecret?: string;
}

const defaultJobTtlMs = 2 * 60 * 60 * 1000;
const defaultKeyTtlMs = 15 * 60 * 1000;
const defaultMaxJobs = 200;

export class RealUserIssueJobStore {
  private readonly jobs = new Map<string, RealUserIssueJob>();
  private readonly inFlightExternalUserIds = new Set<string>();
  private readonly jobTtlMs: number;
  private readonly keyTtlMs: number;
  private readonly maxJobs: number;
  private readonly now: () => Date;
  private readonly persistence?: IssuanceTaskStore;
  private readonly encryptionSecret?: string;
  private readonly leases = new Map<string, string>();

  constructor(options: RealUserIssueJobStoreOptions = {}) {
    this.jobTtlMs = options.jobTtlMs ?? defaultJobTtlMs;
    this.keyTtlMs = options.keyTtlMs ?? defaultKeyTtlMs;
    this.maxJobs = options.maxJobs ?? defaultMaxJobs;
    this.now = options.now ?? (() => new Date());
    this.persistence = options.persistence;
    this.encryptionSecret = options.encryptionSecret;
    if (this.persistence && !this.encryptionSecret) throw new Error("Issuance encryption is required.");
  }

  get durable(): boolean { return Boolean(this.persistence); }

  create(input: {
    externalUserId: string;
    displayName: string;
    phone: string;
    actorTokenPrefix: string | null;
    issuanceInput?: RealUserIssueInput;
  }): RealUserIssueJob {
    this.sweep();
    if (!this.persistence && this.inFlightExternalUserIds.has(input.externalUserId)) {
      throw new GatewayError({
        code: "issue_already_running",
        message: "An issuance for this phone number is already running.",
        httpStatus: 409
      });
    }
    const now = this.now();
    const job: RealUserIssueJob = {
      id: `rui_${randomUUID().replace(/-/g, "")}`,
      state: "queued",
      actorTokenPrefix: input.actorTokenPrefix,
      externalUserId: input.externalUserId,
      displayName: input.displayName,
      phoneTail: input.phone.slice(-4),
      steps: realUserIssueStepKeys.map((key) => ({
        key,
        label: stepLabels[key],
        state: "pending" as RealUserIssueStepState,
        detail: null,
        startedAt: null,
        finishedAt: null
      })),
      result: null,
      unifiedKey: null,
      unifiedKeyExpiresAt: null,
      error: null,
      createdAt: now,
      updatedAt: now,
      input: input.issuanceInput,
      subjectId: null,
      compensationError: null
    };
    if (this.persistence) {
      if (!job.input) throw new Error("Durable issuance requires immutable input.");
      this.persistence.insertIssuanceTask(this.record(job));
    }
    this.jobs.set(job.id, job);
    this.inFlightExternalUserIds.add(input.externalUserId);
    this.enforceMaxJobs();
    return job;
  }

  get(id: string): RealUserIssueJob | null {
    this.sweep();
    if (this.persistence) {
      const record = this.persistence.getIssuanceTask(id);
      if (!record) return null;
      const job = this.decode(record);
      const cached = this.jobs.get(id);
      if (!record.retiredAt && job.state === "succeeded" && cached?.state === "succeeded" && cached.unifiedKey &&
          cached.unifiedKeyExpiresAt && cached.unifiedKeyExpiresAt > this.now()) {
        job.unifiedKey = cached.unifiedKey;
      }
      this.jobs.set(id, job);
      return job;
    }
    return this.jobs.get(id) ?? null;
  }

  list(actorTokenPrefix: string | null, limit = 20): RealUserIssueJob[] {
    this.sweep();
    if (this.persistence) return this.persistence.listIssuanceTasks(actorTokenPrefix, limit).map(record => this.get(record.id)!);
    return [...this.jobs.values()]
      .filter((job) => actorTokenPrefix === null || job.actorTokenPrefix === actorTokenPrefix)
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
      .slice(0, limit);
  }

  startStep(id: string, key: RealUserIssueStepKey): void {
    this.mutate(id, (job) => {
      job.state = "running";
      const step = job.steps.find((candidate) => candidate.key === key);
      if (step) {
        step.state = "running";
        step.startedAt = this.now();
      }
    });
  }

  acquire(id: string, action: "resume" | "retry-disable" = "resume", acknowledgeReview = false): void {
    const job = this.get(id);
    if (!job) throw new GatewayError({ code: "issue_job_not_found", message: "Issuance task not found.", httpStatus: 404 });
    const compensating = job.state === "compensating" || job.state === "compensation_failed";
    if (["succeeded", "failed"].includes(job.state) || compensating !== (action === "retry-disable")) {
      throw new GatewayError({ code: "issue_not_resumable", message: "This task cannot perform the requested recovery action.", httpStatus: 409 });
    }
    if (job.requiresReview && !acknowledgeReview) {
      throw new GatewayError({code: "issue_recovery_requires_review", message: "Inspect and reconcile this task before explicitly acknowledging recovery.", httpStatus: 409});
    }
    if (this.leases.has(id)) throw new GatewayError({ code: "issue_already_running", message: "Issuance is already running.", httpStatus: 409 });
    const token = randomUUID();
    if (this.persistence && !this.persistence.claimIssuanceTask(id, token, this.now(), this.leaseExpiry(), job.state)) {
      throw new GatewayError({ code: "issue_already_running", message: "Issuance is running or its previous lease has not expired.", httpStatus: 409 });
    }
    this.leases.set(id, token);
  }

  assertOwner(id: string): void {
    if (!this.persistence) return;
    const record = this.persistence.getIssuanceTask(id);
    if (!record || record.retiredAt || !this.leases.get(id) || record.leaseToken !== this.leases.get(id) ||
        !record.leaseExpiresAt || record.leaseExpiresAt <= this.now()) {
      throw new GatewayError({ code: "issue_lease_lost", message: "Issuance ownership expired; reload the task.", httpStatus: 409 });
    }
  }

  release(id: string): void {
    const token = this.leases.get(id);
    if (token) this.persistence?.releaseIssuanceTask(id, token);
    this.leases.delete(id);
  }

  checkpointSubject(id: string, subjectId: string): void {
    this.mutate(id, job => { job.subjectId = subjectId; });
  }

  markRetryable(id: string, error: { code: string; message: string }): void {
    this.mutate(id, job => { job.state = "retryable"; job.error = error; job.unifiedKey = null; job.requiresReview = false; });
  }

  requireReview(id: string, error: { code: string; message: string }): void {
    this.mutate(id, job => { job.state = "retryable"; job.error = error; job.unifiedKey = null; job.requiresReview = true; });
  }

  beginCompensation(id: string, error: { code: string; message: string }): void {
    this.mutate(id, job => {
      job.state = "compensating"; job.error = error; job.compensationError = null; job.unifiedKey = null;
      job.requiresReview = false;
    });
  }

  failCompensation(id: string, error: { code: string; message: string }): void {
    this.mutate(id, job => { job.state = "compensation_failed"; job.compensationError = error;
      job.requiresReview = error.code === "issue_recovery_requires_review" || error.code === "disable_target_changed"; });
  }

  private leaseExpiry(): Date { return new Date(this.now().getTime() + 120_000); }

  private record(job: RealUserIssueJob): IssuanceTaskRecord {
    return { id: job.id, provider: job.input?.provider ?? defaultRealUserProvider,
      externalUserId: job.externalUserId, actorId: job.actorTokenPrefix ?? "",
      state: job.state, snapshotCiphertext: encryptSecret(JSON.stringify({ ...job, unifiedKey: null }), this.encryptionSecret!),
      leaseToken: this.leases.get(job.id) ?? null, leaseExpiresAt: this.leaseExpiry(),
      createdAt: job.createdAt, updatedAt: job.updatedAt };
  }

  private decode(record: IssuanceTaskRecord): RealUserIssueJob {
    const job = JSON.parse(decryptSecret(record.snapshotCiphertext, this.encryptionSecret!)) as RealUserIssueJob;
    if (job.id !== record.id || job.state !== record.state || job.input?.provider !== record.provider ||
        job.externalUserId !== record.externalUserId || (job.actorTokenPrefix ?? "") !== record.actorId) {
      throw new Error("Invalid issuance snapshot.");
    }
    job.createdAt = new Date(job.createdAt); job.updatedAt = new Date(job.updatedAt);
    job.unifiedKeyExpiresAt = job.unifiedKeyExpiresAt ? new Date(job.unifiedKeyExpiresAt) : null;
    for (const step of job.steps) {
      step.startedAt = step.startedAt ? new Date(step.startedAt) : null;
      step.finishedAt = step.finishedAt ? new Date(step.finishedAt) : null;
    }
    if (job.input) {
      job.input.entitlementEnd = new Date(job.input.entitlementEnd);
      job.input.keyExpiresAt = new Date(job.input.keyExpiresAt);
    }
    if (job.result) {
      job.result.backingKeyExpiresAt = new Date(job.result.backingKeyExpiresAt);
      job.result.entitlementEnd = new Date(job.result.entitlementEnd);
    }
    if (record.retiredAt) {
      job.state = "failed";
      job.requiresReview = false;
      job.updatedAt = record.retiredAt;
      job.unifiedKey = null;
      job.unifiedKeyExpiresAt = null;
      job.compensationError = null;
      job.result = null;
      job.error = {code: "registration_released", message: "原登记已由管理员释放，本任务已终止，不得恢复。"};
      for (const step of job.steps) {
        if (step.state === "running") {
          step.state = "failed";
          step.detail = job.error.message;
          step.finishedAt = record.retiredAt;
        }
      }
    }
    return job;
  }

  finishStep(id: string, key: RealUserIssueStepKey, detail?: string): void {
    this.mutate(id, (job) => {
      const step = job.steps.find((candidate) => candidate.key === key);
      if (step) {
        step.state = "ok";
        step.detail = detail ?? null;
        step.finishedAt = this.now();
      }
    });
  }

  failJob(id: string, key: RealUserIssueStepKey | null, error: { code: string; message: string }): void {
    this.mutate(id, (job) => {
      const step = job.steps.find((candidate) => candidate.key === key);
      if (step) {
        step.state = "failed";
        step.detail = error.message;
        step.finishedAt = this.now();
      }
      job.state = "failed";
      job.error = error;
      job.requiresReview = false;
      job.unifiedKey = null;
      job.unifiedKeyExpiresAt = null;
      this.inFlightExternalUserIds.delete(job.externalUserId);
    });
  }

  succeedJob(id: string, result: RealUserIssueResult, unifiedKey: string): void {
    this.mutate(id, (job) => {
      job.state = "succeeded";
      job.requiresReview = false;
      job.error = null;
      job.compensationError = null;
      job.result = result;
      job.unifiedKey = unifiedKey;
      job.unifiedKeyExpiresAt = new Date(this.now().getTime() + this.keyTtlMs);
      this.inFlightExternalUserIds.delete(job.externalUserId);
    });
  }

  /** Drops expired keys and jobs. Called on every read and write. */
  sweep(): void {
    const now = this.now().getTime();
    for (const [id, job] of this.jobs) {
      if (job.unifiedKey && job.unifiedKeyExpiresAt && job.unifiedKeyExpiresAt.getTime() <= now) {
        job.unifiedKey = null;
      }
      const terminal = job.state === "succeeded" || job.state === "failed";
      if (terminal && now - job.updatedAt.getTime() > this.jobTtlMs) {
        this.jobs.delete(id);
      }
    }
  }

  private mutate(id: string, mutator: (job: RealUserIssueJob) => void): void {
    this.assertOwner(id);
    const job = this.get(id);
    if (!job) {
      return;
    }
    mutator(job);
    job.updatedAt = this.now();
    if (this.persistence) this.persistence.saveIssuanceTask(this.record(job), this.leases.get(id)!, this.now());
  }

  private enforceMaxJobs(): void {
    if (this.jobs.size <= this.maxJobs) {
      return;
    }
    const ordered = [...this.jobs.values()].sort(
      (left, right) => left.createdAt.getTime() - right.createdAt.getTime()
    );
    for (const job of ordered) {
      if (this.jobs.size <= this.maxJobs) {
        break;
      }
      if (job.state === "succeeded" || job.state === "failed") {
        this.jobs.delete(job.id);
      }
    }
  }
}

export interface CreatedSubject {
  subjectId: string;
  opaqueKey: string | null;
  created: boolean;
  idempotentReplay: boolean;
}

export interface ResolvedUnifiedKey {
  valid: boolean;
  subjectId: string | null;
  codexApiKey: string | null;
  codexKeyPrefix: string | null;
  medevidenceApiKey: string | null;
  medevidencePrefix: string | null;
  endpointBaseUrl: string | null;
  credentialValidationUrl: string | null;
}

export interface CurrentCredential {
  valid: boolean;
  subjectId: string | null;
  entitlementState: string | null;
  capabilities: string[];
}

export interface RealUserIssueRunnerDeps {
  assertAccountUnchanged?(subjectId: string): void;
  normalizeAccount?(subjectId: string, credentialLabel: string): void;
  canDiscardFailedCreate?(input: RealUserIssueInput): boolean;
  createSubject(input: {
    provider: string;
    externalUserId: string;
    phone: string;
    displayName: string;
    scope: string;
    metadata: Record<string, unknown>;
    idempotencyKey: string;
    recoveryTaskId?: string;
    keyExpiresAt?: Date;
    rate?: RateLimitPolicy;
  }): Promise<CreatedSubject>;
  grantEntitlement(input: {
    provider: string;
    subjectId: string;
    planId: string;
    externalOrderId: string;
    externalEventId: string;
    idempotencyKey: string;
    periodStart: Date;
    periodEnd: Date;
  }): Promise<{ applied: boolean; entitlementState: string | null }>;
  resolveUnifiedKey(opaqueKey: string): Promise<ResolvedUnifiedKey>;
  updateSubjectMetadata(
    subjectId: string,
    input: { label: string; name: string; phoneNumber: string }
  ): void;
  updateCredential(
    prefix: string,
    input: { label: string; expiresAt: Date; rate: RateLimitPolicy }
  ): void;
  currentCredential(codexApiKey: string): Promise<CurrentCredential>;
  preparePhoneIdentity(input: {
    phone: string;
    subjectId: string;
    unifiedKey: string;
    requestId: string;
  }): void;
  disableSubject(subjectId: string, reason: string): Promise<void>;
  publicBaseUrl: string | null;
  now(): Date;
}

class IssueStepError extends Error {
  constructor(
    readonly step: RealUserIssueStepKey,
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

/** Public validation errors must not be confused with destructive business-step failures. */
export class IssueValidationError extends GatewayError {
  constructor(code: string, httpStatus: number) {
    const safeCode = (gatewayErrorCodes as readonly string[]).includes(code) ? code as GatewayErrorCode : "issue_validation_failed";
    super({code: safeCode, httpStatus, message: `Public credential validation failed (HTTP ${httpStatus}, ${safeCode}); inspect the original account before recovery.`});
  }
}

/**
 * Runs the issuance to completion, recording progress on the job as it goes.
 * Business failures land on the task; ownership/storage failures stop the worker.
 */
export async function runRealUserIssueJob(
  store: RealUserIssueJobStore,
  jobId: string,
  deps: RealUserIssueRunnerDeps,
  input: RealUserIssueInput,
  acquired = false
): Promise<void> {
  if (!acquired) store.acquire(jobId);
  const originalJob = store.get(jobId)!;
  input = originalJob.input ?? input;
  let subjectId: string | null = null;
  let createdSubjectThisRun = false;

  try {
    if (input.rate.requestsPerMinute < minimumRealUserRequestsPerMinute) {
      throw new IssueStepError(
        "create_subject",
        "rpm_below_minimum",
        `Real-user RPM must be at least ${minimumRealUserRequestsPerMinute}.`
      );
    }
    store.startStep(jobId, "create_subject");
    const created = await deps.createSubject({
      provider: input.provider,
      externalUserId: input.externalUserId,
      phone: input.phone,
      displayName: input.name,
      scope: input.scope,
      metadata: {
        purpose: "real_user_manual_trial",
        issued_by: "real-user-issue-ui",
        ...(store.durable ? { issuance_task_id: jobId } : {})
      },
      idempotencyKey: store.durable ? `${jobId}:create_subject` : `${input.provider}:${input.externalUserId}:create_subject`,
      ...(store.durable ? { recoveryTaskId: jobId } : {}),
      keyExpiresAt: input.keyExpiresAt, rate: input.rate
    });
    if (created.idempotentReplay && !created.opaqueKey) {
      throw new IssueStepError(
        "create_subject",
        "idempotent_replay_without_key",
        "该手机号此前已发过 key，完整 key 只在首次创建时返回。请改用轮换(rotate)，或换一个 external_user_id。"
      );
    }
    if (!created.opaqueKey || !created.opaqueKey.startsWith("cgu_live_")) {
      throw new IssueStepError(
        "create_subject",
        "missing_unified_key",
        "创建计费主体没有返回 cgu_live key。"
      );
    }
    if (!created.subjectId) {
      throw new IssueStepError("create_subject", "missing_subject_id", "创建计费主体没有返回 subject id。");
    }
    subjectId = created.subjectId;
    createdSubjectThisRun = (created.created && !created.idempotentReplay) || store.durable;
    store.checkpointSubject(jobId, subjectId);
    const opaqueKey = created.opaqueKey;
    store.finishStep(jobId, "create_subject", `subject ${subjectId}`);
    deps.assertAccountUnchanged?.(subjectId);

    store.startStep(jobId, "grant_entitlement");
    const stamp = store.durable ? jobId : utcStamp(deps.now());
    const entitlement = await deps.grantEntitlement({
      provider: input.provider,
      subjectId,
      planId: input.planId,
      externalOrderId: `manual_trial_${stamp}`,
      externalEventId: `evt_${stamp}`,
      idempotencyKey: `${input.provider}:${input.externalUserId}:purchase:${stamp}`,
      periodStart: new Date(originalJob.createdAt.getTime() - 60_000),
      periodEnd: input.entitlementEnd
    });
    deps.assertAccountUnchanged?.(subjectId);
    if (!entitlement.applied || entitlement.entitlementState !== "active") {
      throw new IssueStepError("grant_entitlement", "entitlement_not_active", "Plan 权益没有生效。");
    }
    store.finishStep(jobId, "grant_entitlement", input.planId);

    store.startStep(jobId, "resolve_key");
    const resolved = await deps.resolveUnifiedKey(opaqueKey);
    deps.assertAccountUnchanged?.(subjectId);
    if (!resolved.valid || resolved.subjectId !== subjectId) {
      throw new IssueStepError("resolve_key", "resolve_failed", "opaque key 解析校验失败。");
    }
    if (!resolved.codexApiKey || !resolved.codexKeyPrefix) {
      throw new IssueStepError(
        "resolve_key",
        "missing_backing_key",
        "解析结果没有返回后端 Gateway 运行态 key。"
      );
    }
    if (!resolved.codexApiKey.startsWith("cgw.")) {
      throw new IssueStepError(
        "resolve_key",
        "unexpected_backing_key",
        "解析结果返回的 Gateway 运行态 key 格式不正确。"
      );
    }
    if (!resolved.codexApiKey.startsWith(`${resolved.codexKeyPrefix}.`)) {
      throw new IssueStepError(
        "resolve_key",
        "unexpected_backing_key",
        "解析结果返回的 Gateway 运行态 key 与公开前缀不一致。"
      );
    }
    if (!resolved.medevidenceApiKey) {
      throw new IssueStepError(
        "resolve_key",
        "missing_medevidence_key",
        "解析结果没有返回 MedEvidence 运行态 key。"
      );
    }
    if (deps.publicBaseUrl) {
      if (resolved.endpointBaseUrl && resolved.endpointBaseUrl !== `${deps.publicBaseUrl}/v1`) {
        throw new IssueStepError(
          "resolve_key",
          "unexpected_endpoint",
          "解析结果返回了非预期的 Gateway endpoint。"
        );
      }
      if (
        resolved.credentialValidationUrl &&
        resolved.credentialValidationUrl !== `${deps.publicBaseUrl}/gateway/credentials/current`
      ) {
        throw new IssueStepError(
          "resolve_key",
          "unexpected_validation_url",
          "解析结果返回了非预期的凭据校验地址。"
        );
      }
    }
    store.finishStep(jobId, "resolve_key", resolved.codexKeyPrefix);

    store.startStep(jobId, "normalize_metadata");
    const label = credentialLabel(originalJob.createdAt, input.name);
    if (deps.normalizeAccount) {
      deps.normalizeAccount(subjectId, label);
    } else {
      deps.updateSubjectMetadata(subjectId, {
        label: input.name, name: input.name, phoneNumber: input.phone
      });
      deps.updateCredential(normalizeAccessCredentialStoredPrefix(resolved.codexKeyPrefix), {
        label, expiresAt: input.keyExpiresAt, rate: input.rate
      });
    }
    store.finishStep(
      jobId,
      "normalize_metadata",
      `${input.rate.requestsPerMinute} rpm / ${input.rate.requestsPerDay ?? "∞"} rpd / ${
        input.rate.concurrentRequests ?? "∞"
      } 并发`
    );

    store.startStep(jobId, "validate_credential");
    const current = await deps.currentCredential(resolved.codexApiKey);
    deps.assertAccountUnchanged?.(subjectId);
    if (!current.valid || current.subjectId !== subjectId) {
      throw new IssueStepError("validate_credential", "credential_invalid", "Gateway 凭据校验失败。");
    }
    if (current.entitlementState !== "active") {
      throw new IssueStepError(
        "validate_credential",
        "entitlement_inactive",
        "凭据校验没有返回 active 权益。"
      );
    }
    if (input.requireImageCapability && !current.capabilities.includes("image_generation")) {
      throw new IssueStepError(
        "validate_credential",
        "missing_image_capability",
        "签发的凭据不含 image_generation 能力。"
      );
    }
    store.finishStep(jobId, "validate_credential", current.capabilities.join(", "));

    store.startStep(jobId, "prepare_phone_login");
    try {
      deps.preparePhoneIdentity({
        phone: input.phone,
        subjectId,
        unifiedKey: opaqueKey,
        requestId: `real-user-issue:${jobId}`
      });
    } catch (error) {
      if (error instanceof GatewayError) throw error;
      throw new IssueStepError(
        "prepare_phone_login",
        "phone_identity_prepare_failed",
        "手机号登录身份准备失败。"
      );
    }
    store.finishStep(jobId, "prepare_phone_login", "active");

    store.succeedJob(
      jobId,
      {
        subjectId,
        keyPrefix: publicKeyPrefix(opaqueKey),
        codexGatewayPrefix: resolved.codexKeyPrefix,
        medevidencePrefix: resolved.medevidencePrefix,
        planId: input.planId,
        entitlementState: current.entitlementState,
        capabilities: current.capabilities,
        imageGeneration: current.capabilities.includes("image_generation"),
        rate: input.rate,
        backingKeyExpiresAt: input.keyExpiresAt,
        entitlementEnd: input.entitlementEnd,
        endpointBaseUrl: resolved.endpointBaseUrl
      },
      opaqueKey
    );
  } catch (err) {
    // An expired worker must not write state or start compensation after another
    // worker has taken ownership. The new owner will inspect the business ledger.
    store.assertOwner(jobId);
    const step = err instanceof IssueStepError ? err.step : null;
    const code = err instanceof IssueStepError || err instanceof GatewayError ? err.code : "issue_failed";
    const failure = {
      code,
      message: redactIssueMessage(err instanceof Error ? err.message : String(err))
    };
    const deterministicConflict = ["subject_already_exists", "identity_conflict", "account_disabled", "account_migration_required",
      "phone_identity_conflict", "phone_login_disabled", "invalid_request", "idempotency_conflict", "registration_released"].includes(code);
    if (!subjectId && !originalJob.subjectId && deterministicConflict && deps.canDiscardFailedCreate?.(input)) {
      store.failJob(jobId, "create_subject", failure);
    } else if (store.durable && (["issue_recovery_requires_review", "entitlement_already_active", "invalid_entitlement_transition"].includes(code) ||
        (err instanceof IssueValidationError && err.httpStatus < 500 && ![408, 425, 429].includes(err.httpStatus)) ||
        (!subjectId && deterministicConflict))) {
      store.requireReview(jobId, failure);
    } else if (store.durable && (!subjectId || err instanceof IssueValidationError || (!(err instanceof IssueStepError) &&
        (!(err instanceof GatewayError) || err.httpStatus >= 500)))) {
      store.markRetryable(jobId, failure);
    } else if (subjectId && createdSubjectThisRun) {
      store.beginCompensation(jobId, failure);
      try {
        await deps.disableSubject(subjectId, `real_user_issue_failed:${code}`);
        store.failJob(jobId, step, failure);
      } catch (error) {
        store.failCompensation(jobId, compensationFailure(error));
      }
    } else {
      store.failJob(jobId, step, failure);
    }
  } finally {
    store.release(jobId);
  }
}

export async function retryRealUserIssueCompensation(
  store: RealUserIssueJobStore, jobId: string, deps: RealUserIssueRunnerDeps, acquired = false
): Promise<void> {
  if (!acquired) store.acquire(jobId, "retry-disable");
  try {
    const job = store.get(jobId)!;
    if (!job.subjectId || !job.error) throw new Error("Compensation target is missing.");
    store.beginCompensation(jobId, job.error);
    await deps.disableSubject(job.subjectId, `real_user_issue_failed:${job.error.code}`);
    store.failJob(jobId, null, job.error);
  } catch (error) {
    store.failCompensation(jobId, compensationFailure(error));
  } finally {
    store.release(jobId);
  }
}

function compensationFailure(error: unknown): { code: string; message: string } {
  if (error instanceof GatewayError && ["issue_recovery_requires_review", "disable_target_changed"].includes(error.code)) {
    return {code: error.code, message: "Account or original disable target changed. Inspect the original task; do not retry disable until reconciliation is complete."};
  }
  return { code: error instanceof GatewayError ? error.code : "compensation_failed",
    message: "Account disable has not completed; retry disable from the original issuance task." };
}

export function publicKeyPrefix(opaqueKey: string): string {
  const withoutScheme = opaqueKey.startsWith("cgu_live_") ? opaqueKey.slice("cgu_live_".length) : opaqueKey;
  return `cgu_live_${withoutScheme.slice(0, 16)}`;
}

export function credentialLabel(now: Date, name: string): string {
  const day = now.toISOString().slice(0, 10).replace(/-/g, "");
  return `medevidence-unified-${day}-${safeSlug(name).slice(0, 32)}`;
}

function safeSlug(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "user";
}

function utcStamp(now: Date): string {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

/** Keeps any accidental credential-shaped substring out of a stored message. */
export function redactIssueMessage(message: string): string {
  return message
    .replace(/cgu_live_[A-Za-z0-9_-]+/g, "cgu_live_<redacted>")
    .replace(/cgw\.[A-Za-z0-9_.-]+/g, "cgw.<redacted>")
    .replace(/mev2_live_[A-Za-z0-9_-]+/g, "mev2_live_<redacted>")
    .replace(/bat_(test|live)_[A-Za-z0-9_.-]+/g, "bat_$1_<redacted>")
    .slice(0, 600);
}

export function defaultExternalUserId(phone: string): string {
  const normalized = normalizeMainlandChinaPhone(phone);
  const digits = normalized ? normalized.slice(3) : phone.replace(/\D/g, "");
  return `phone_${digits}`;
}

export function publicRealUserIssueJob(
  job: RealUserIssueJob,
  options: { includeKey: boolean }
): Record<string, unknown> {
  return {
    job_id: job.id,
    state: job.state,
    display_name: job.displayName,
    phone_tail: job.phoneTail,
    external_user_id: job.externalUserId,
    created_at: job.createdAt.toISOString(),
    updated_at: job.updatedAt.toISOString(),
    authority_mode: "r760_only",
    steps: job.steps.map((step) => ({
      key: step.key,
      label: step.label,
      state: step.state,
      detail: step.detail,
      started_at: step.startedAt ? step.startedAt.toISOString() : null,
      finished_at: step.finishedAt ? step.finishedAt.toISOString() : null
    })),
    error: job.error,
    subject_id: job.subjectId,
    compensation_error: job.compensationError,
    requires_review: Boolean(job.requiresReview),
    recovery_action: job.state === "compensating" || job.state === "compensation_failed"
      ? "retry-disable" : ["queued", "running", "retryable"].includes(job.state) ? "resume" : null,
    result: job.result
      ? {
          subject_id: job.result.subjectId,
          key_prefix: job.result.keyPrefix,
          codex_gateway_prefix: job.result.codexGatewayPrefix,
          medevidence_prefix: job.result.medevidencePrefix,
          plan_id: job.result.planId,
          entitlement_state: job.result.entitlementState,
          capabilities: job.result.capabilities,
          image_generation: job.result.imageGeneration,
          rate: {
            requestsPerMinute: job.result.rate.requestsPerMinute,
            requestsPerDay: job.result.rate.requestsPerDay ?? null,
            concurrentRequests: job.result.rate.concurrentRequests ?? null
          },
          backing_key_expires_at: job.result.backingKeyExpiresAt.toISOString(),
          entitlement_end: job.result.entitlementEnd.toISOString(),
          endpoint_base_url: job.result.endpointBaseUrl
        }
      : null,
    key_available: Boolean(job.unifiedKey),
    key_expires_at: job.unifiedKeyExpiresAt ? job.unifiedKeyExpiresAt.toISOString() : null,
    ...(options.includeKey && job.unifiedKey ? { unified_key: job.unifiedKey } : {})
  };
}
