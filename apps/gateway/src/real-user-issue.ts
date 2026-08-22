import { randomUUID } from "node:crypto";
import { GatewayError, normalizeAccessCredentialStoredPrefix } from "@codex-gateway/core";
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
export type RealUserIssueJobState = "queued" | "running" | "succeeded" | "failed";

const stepLabels: Record<RealUserIssueStepKey, string> = {
  create_subject: "创建计费主体与 key",
  grant_entitlement: "授予 Plan 权益",
  resolve_key: "解析 key 并校验运行态凭据",
  normalize_metadata: "写入姓名/手机并规范限额",
  validate_credential: "校验凭据与能力",
  prepare_phone_login: "准备手机号免验证码登录"
};

export const defaultRealUserIssueRate: RateLimitPolicy = {
  requestsPerMinute: 10,
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

  constructor(options: RealUserIssueJobStoreOptions = {}) {
    this.jobTtlMs = options.jobTtlMs ?? defaultJobTtlMs;
    this.keyTtlMs = options.keyTtlMs ?? defaultKeyTtlMs;
    this.maxJobs = options.maxJobs ?? defaultMaxJobs;
    this.now = options.now ?? (() => new Date());
  }

  create(input: {
    externalUserId: string;
    displayName: string;
    phone: string;
    actorTokenPrefix: string | null;
  }): RealUserIssueJob {
    this.sweep();
    if (this.inFlightExternalUserIds.has(input.externalUserId)) {
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
      updatedAt: now
    };
    this.jobs.set(job.id, job);
    this.inFlightExternalUserIds.add(input.externalUserId);
    this.enforceMaxJobs();
    return job;
  }

  get(id: string): RealUserIssueJob | null {
    this.sweep();
    return this.jobs.get(id) ?? null;
  }

  list(actorTokenPrefix: string | null, limit = 20): RealUserIssueJob[] {
    this.sweep();
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
      job.unifiedKey = null;
      job.unifiedKeyExpiresAt = null;
      this.inFlightExternalUserIds.delete(job.externalUserId);
    });
  }

  succeedJob(id: string, result: RealUserIssueResult, unifiedKey: string): void {
    this.mutate(id, (job) => {
      job.state = "succeeded";
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
    const job = this.jobs.get(id);
    if (!job) {
      return;
    }
    mutator(job);
    job.updatedAt = this.now();
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
  createSubject(input: {
    provider: string;
    externalUserId: string;
    displayName: string;
    scope: string;
    metadata: Record<string, unknown>;
    idempotencyKey: string;
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

/**
 * Runs the issuance to completion, recording progress on the job as it goes.
 * Never throws: every failure lands on the job record instead.
 */
export async function runRealUserIssueJob(
  store: RealUserIssueJobStore,
  jobId: string,
  deps: RealUserIssueRunnerDeps,
  input: RealUserIssueInput
): Promise<void> {
  let subjectId: string | null = null;
  let createdSubjectThisRun = false;

  try {
    store.startStep(jobId, "create_subject");
    const created = await deps.createSubject({
      provider: input.provider,
      externalUserId: input.externalUserId,
      displayName: input.name,
      scope: input.scope,
      metadata: {
        purpose: "real_user_manual_trial",
        issued_by: "real-user-issue-ui",
        created_at: deps.now().toISOString()
      },
      idempotencyKey: `${input.provider}:${input.externalUserId}:create_subject`
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
    createdSubjectThisRun = created.created && !created.idempotentReplay;
    const opaqueKey = created.opaqueKey;
    store.finishStep(jobId, "create_subject", `subject ${subjectId}`);

    store.startStep(jobId, "grant_entitlement");
    const stamp = utcStamp(deps.now());
    const entitlement = await deps.grantEntitlement({
      provider: input.provider,
      subjectId,
      planId: input.planId,
      externalOrderId: `manual_trial_${stamp}`,
      externalEventId: `evt_${stamp}`,
      idempotencyKey: `${input.provider}:${input.externalUserId}:purchase:${stamp}`,
      periodStart: new Date(deps.now().getTime() - 60_000),
      periodEnd: input.entitlementEnd
    });
    if (!entitlement.applied || entitlement.entitlementState !== "active") {
      throw new IssueStepError("grant_entitlement", "entitlement_not_active", "Plan 权益没有生效。");
    }
    store.finishStep(jobId, "grant_entitlement", input.planId);

    store.startStep(jobId, "resolve_key");
    const resolved = await deps.resolveUnifiedKey(opaqueKey);
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
    const label = credentialLabel(deps.now(), input.name);
    deps.updateSubjectMetadata(subjectId, {
      label: input.name,
      name: input.name,
      phoneNumber: input.phone
    });
    deps.updateCredential(normalizeAccessCredentialStoredPrefix(resolved.codexKeyPrefix), {
      label,
      expiresAt: input.keyExpiresAt,
      rate: input.rate
    });
    store.finishStep(
      jobId,
      "normalize_metadata",
      `${input.rate.requestsPerMinute} rpm / ${input.rate.requestsPerDay ?? "∞"} rpd / ${
        input.rate.concurrentRequests ?? "∞"
      } 并发`
    );

    store.startStep(jobId, "validate_credential");
    const current = await deps.currentCredential(resolved.codexApiKey);
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
    } catch {
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
    const step = err instanceof IssueStepError ? err.step : null;
    const code = err instanceof IssueStepError ? err.code : "issue_failed";
    store.failJob(jobId, step, {
      code,
      message: redactIssueMessage(err instanceof Error ? err.message : String(err))
    });
    if (subjectId && createdSubjectThisRun) {
      // Leave no half-provisioned user behind: the subject exists but has no
      // usable entitlement, so disable it rather than letting it linger.
      try {
        await deps.disableSubject(subjectId, `real_user_issue_failed:${code}`);
      } catch {
        // Best effort only; the job already carries the original failure.
      }
    }
  }
}

export function publicKeyPrefix(opaqueKey: string): string {
  const withoutScheme = opaqueKey.startsWith("cgu_live_") ? opaqueKey.slice("cgu_live_".length) : opaqueKey;
  return `cgu_live_${withoutScheme.slice(0, 16)}`;
}

function credentialLabel(now: Date, name: string): string {
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
  const digits = phone.replace(/\D/g, "");
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
