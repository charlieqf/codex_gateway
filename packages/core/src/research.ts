import type { LimitKind } from "./token-budget.js";

export const researchRunStatuses = [
  "queued",
  "running",
  "needs_input",
  "succeeded",
  "failed",
  "cancelled",
  "expired"
] as const;

export type ResearchRunStatus = (typeof researchRunStatuses)[number];
export type ResearchRunMode = "brief" | "full";
export type ResearchRunLanguage = "zh-CN" | "en";

export const researchRunStages = [
  "validate_input",
  "discover_identity",
  "resolve_identity",
  "collect_profile_evidence",
  "infer_research_topics",
  "build_search_strategy",
  "search_literature",
  "verify_metadata",
  "screen_and_extract_evidence",
  "synthesize_review",
  "generate_questions",
  "generate_answers",
  "validate_outputs",
  "render_artifacts",
  "complete"
] as const;

export type ResearchRunStage = (typeof researchRunStages)[number];

const researchRunTransitions: Readonly<
  Record<ResearchRunStatus, readonly ResearchRunStatus[]>
> = {
  queued: ["running", "cancelled"],
  running: ["running", "queued", "needs_input", "succeeded", "failed", "cancelled"],
  needs_input: ["queued", "failed", "cancelled"],
  succeeded: ["expired"],
  failed: ["expired"],
  cancelled: ["expired"],
  expired: []
};

export function isResearchRunTransitionAllowed(
  from: ResearchRunStatus,
  to: ResearchRunStatus
): boolean {
  return researchRunTransitions[from].includes(to);
}

export interface ResearchDoctorInput {
  name: string;
  hospital: string | null;
  department: string | null;
  title: string | null;
  city: string | null;
  orcid: string | null;
  officialProfileUrls?: string[];
  literatureIdentity?: {
    name: string;
    hospital: string;
    department: string;
  };
}

export interface DoctorResearchRunInput {
  doctor: ResearchDoctorInput;
  mode: ResearchRunMode;
  language: ResearchRunLanguage;
  options: {
    publicationYears: number;
    citationStyle: "vancouver";
  };
  clientReference: string | null;
}

export interface ResearchRunRecord {
  runId: string;
  subjectId: string;
  credentialId: string | null;
  skillName: string;
  skillVersion: string;
  promptVersion: string;
  inputSchemaVersion: string;
  outputSchemaVersion: string;
  mode: ResearchRunMode;
  language: ResearchRunLanguage;
  input: DoctorResearchRunInput;
  status: ResearchRunStatus;
  stage: ResearchRunStage;
  progressPercent: number;
  canonicalIdentityId: string | null;
  warningCodes: string[];
  terminalReason: string | null;
  terminalDetailPublic: string | null;
  cancelRequestedAt: Date | null;
  cancelRequestedBy: "subject" | "operator" | "system" | null;
  cancelRequestId: string | null;
  needsInputExpiresAt: Date | null;
  needsInputStartedAt: Date | null;
  queuedAt: Date;
  activeStartedAt: Date | null;
  activeElapsedMs: number;
  leaseOwner: string | null;
  leaseUntil: Date | null;
  leaseGeneration: number;
  attemptCount: number;
  resumeCount: number;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
  expiresAt: Date | null;
  purgeAfter: Date | null;
}

export interface ResearchRunResultRecord {
  runId: string;
  schemaVersion: "doctor_research_result.v1";
  result: Record<string, unknown>;
  sha256: string;
  sizeBytes: number;
  createdAt: Date;
  expiresAt: Date;
}

export interface ResearchArtifactRecord {
  artifactId: string;
  runId: string;
  subjectId: string;
  kind: ResearchArtifactKind;
  filenameAscii: string;
  filenameUtf8: string;
  contentType:
    | "text/markdown; charset=utf-8"
    | "text/plain; charset=utf-8";
  storageRelativePath: string;
  storageVersion: number;
  sha256: string;
  sizeBytes: number;
  createdAt: Date;
  expiresAt: Date;
}

export interface CreateResearchRunInput {
  subjectId: string;
  credentialId: string | null;
  requestId: string;
  idempotencyKey: string;
  requestHash: string;
  identityFingerprint: string;
  input: DoctorResearchRunInput;
  now?: Date;
}

export interface ResearchRunReceipt {
  schema_version: "doctor_research_run.v1";
  request_id: string;
  run_id: string;
  status: "queued";
  stage: "validate_input";
  mode: "brief";
  skill: {
    name: string;
    version: string;
  };
  created_at: string;
  status_url: string;
  result_url: string;
}

export type CreateResearchRunResult =
  | {
      outcome: "created";
      run: ResearchRunRecord;
      receipt: ResearchRunReceipt;
    }
  | {
      outcome: "replayed";
      run: ResearchRunRecord;
      receipt: ResearchRunReceipt;
    }
  | {
      outcome: "idempotency_conflict";
    }
  | {
      outcome: "idempotency_expired";
    }
  | {
      outcome: "rate_limited";
      limitKind: Extract<
        LimitKind,
        | "research_active_brief"
        | "research_needs_input"
        | "research_daily_runs"
        | "research_unique_doctors_30d"
        | "research_global_queue"
      >;
    };

export interface InspectCreateResearchRunIdempotencyInput {
  subjectId: string;
  credentialId: string | null;
  requestId: string;
  idempotencyKey: string;
  requestHash: string;
  now?: Date;
}

export type InspectCreateResearchRunIdempotencyResult =
  | { outcome: "not_found" }
  | Extract<
      CreateResearchRunResult,
      {
        outcome:
          | "replayed"
          | "idempotency_conflict"
          | "idempotency_expired";
      }
    >;

export interface ListResearchRunsInput {
  subjectId: string;
  status?: ResearchRunStatus;
  limit: number;
  now?: Date;
  before?: {
    createdAt: Date;
    runId: string;
  };
}

export interface ResearchLeaseToken {
  runId: string;
  owner: string;
  generation: number;
  leaseUntil: Date;
}

export interface AcquireResearchLeaseInput {
  workerId: string;
  leaseSeconds: number;
  now?: Date;
}

export interface AcquiredResearchLease {
  run: ResearchRunRecord;
  token: ResearchLeaseToken;
  cancelRequested: boolean;
}

export interface RenewResearchLeaseInput {
  token: ResearchLeaseToken;
  leaseSeconds: number;
  now?: Date;
}

export type RenewResearchLeaseResult =
  | {
      outcome: "renewed";
      token: ResearchLeaseToken;
      cancelRequested: boolean;
      cancelRequestedBy: ResearchRunRecord["cancelRequestedBy"];
    }
  | {
      outcome: "lost";
      observedStatus: ResearchRunStatus | null;
      observedOwner: string | null;
      observedGeneration: number | null;
    };

export interface RequestResearchRunCancelInput {
  runId: string;
  subjectId: string;
  credentialId: string | null;
  requestId: string;
  idempotencyKey: string;
  requestHash: string;
  now?: Date;
}

export interface ResearchRunCancelReceipt {
  schema_version: "doctor_research_run.v1";
  request_id: string;
  run_id: string;
  status: "running" | "cancelled";
  cancel_requested: boolean;
  terminal_reason: string | null;
  updated_at: string;
}

export type RequestResearchRunCancelResult =
  | {
      outcome: "accepted" | "replayed";
      run: ResearchRunRecord;
      receipt: ResearchRunCancelReceipt;
    }
  | { outcome: "not_found" }
  | { outcome: "invalid_transition"; status: ResearchRunStatus }
  | { outcome: "idempotency_conflict" }
  | { outcome: "idempotency_expired" };

export interface CompleteResearchCancellationInput {
  token: ResearchLeaseToken;
  now?: Date;
}

export type CompleteResearchCancellationResult =
  | { outcome: "cancelled"; run: ResearchRunRecord }
  | {
      outcome: "lost";
      observedStatus: ResearchRunStatus | null;
      observedOwner: string | null;
      observedGeneration: number | null;
    };

export interface WriteResearchCheckpointInput {
  token: ResearchLeaseToken;
  stage: ResearchRunStage;
  checkpointVersion: number;
  payload: unknown;
  payloadSha256: string;
  progressPercent: number;
  now?: Date;
}

export type WriteResearchCheckpointResult =
  | { outcome: "written" }
  | { outcome: "fenced_or_cancelled" };

export type ResearchArtifactKind =
  | "profile"
  | "review"
  | "questions"
  | "answers";

export interface CommitResearchArtifact {
  artifactId: string;
  kind: ResearchArtifactKind;
  filenameAscii: string;
  filenameUtf8: string;
  contentType:
    | "text/markdown; charset=utf-8"
    | "text/plain; charset=utf-8";
  storageRelativePath: string;
  storageVersion: number;
  sha256: string;
  sizeBytes: number;
}

export interface CompleteSuccessfulResearchRunInput {
  token: ResearchLeaseToken;
  resultSchemaVersion: "doctor_research_result.v1";
  result: object;
  artifacts: readonly CommitResearchArtifact[];
  now?: Date;
}

export type CompleteSuccessfulResearchRunResult =
  | { outcome: "succeeded"; run: ResearchRunRecord }
  | { outcome: "fenced_or_cancelled" };

export interface ResearchIdentityCandidate {
  candidateId: string;
  canonicalIdentityId: string;
  name: string;
  hospital: string;
  department: string;
  city: string | null;
  sources: ReadonlyArray<{
    title: string;
    url: string;
  }>;
  evidenceTypes: ReadonlyArray<
    "institution" | "department" | "coauthor" | "research_topic" | "orcid"
  >;
  score: number;
}

export interface PauseResearchForIdentityInput {
  token: ResearchLeaseToken;
  candidates: readonly ResearchIdentityCandidate[];
  now?: Date;
}

export type PauseResearchForIdentityResult =
  | { outcome: "needs_input"; run: ResearchRunRecord }
  | { outcome: "fenced_or_cancelled" };

export type ResearchFailureReason =
  | "identity_not_resolved"
  | "insufficient_research_evidence"
  | "upstream_unavailable"
  | "quality_gate_failed"
  | "model_contract_error"
  | "deadline_exceeded";

export interface FailResearchRunInput {
  token: ResearchLeaseToken;
  terminalReason: ResearchFailureReason;
  now?: Date;
}

export type FailResearchRunResult =
  | { outcome: "failed"; run: ResearchRunRecord }
  | { outcome: "fenced_or_cancelled" };

export interface RequeueResearchRunInput {
  token: ResearchLeaseToken;
  reason:
    | "retriable_upstream_failure"
    | "worker_draining"
    | "checkpoint_recovery";
  now?: Date;
}

export type RequeueResearchRunResult =
  | { outcome: "queued"; run: ResearchRunRecord }
  | { outcome: "fenced_or_cancelled" };

export interface ResolveResearchIdentityInput {
  runId: string;
  subjectId: string;
  credentialId: string | null;
  requestId: string;
  idempotencyKey: string;
  requestHash: string;
  selection:
    | { action: "select"; candidateId: string }
    | { action: "reject_all" };
  now?: Date;
}

export interface ResolveResearchIdentityReceipt {
  schema_version: "doctor_research_run.v1";
  request_id: string;
  run_id: string;
  status: "queued" | "failed";
  stage: ResearchRunStage;
  canonical_identity_id: string | null;
  terminal_reason: string | null;
  updated_at: string;
}

export type ResolveResearchIdentityResult =
  | {
      outcome: "accepted" | "replayed";
      run: ResearchRunRecord;
      receipt: ResolveResearchIdentityReceipt;
    }
  | { outcome: "not_found" }
  | { outcome: "identity_selection_not_expected" }
  | { outcome: "candidate_not_found" }
  | { outcome: "idempotency_conflict" }
  | { outcome: "idempotency_expired" }
  | { outcome: "rate_limited"; limitKind: "research_active_brief" };

export interface ReconcileResearchTtlInput {
  now?: Date;
  batchSize?: number;
}

export interface ReconcileResearchTtlResult {
  needsInputCancelled: number;
  terminalExpired: number;
}

export type ResearchWorkerState = "starting" | "ready" | "draining";

export interface RecordResearchWorkerHeartbeatInput {
  workerId: string;
  processInstanceId: string;
  version: string;
  state: ResearchWorkerState;
  startedAt: Date;
  now?: Date;
}

export type RecordResearchWorkerHeartbeatResult =
  | { outcome: "recorded" }
  | { outcome: "stale_process_ignored" };

export interface ResearchWorkerHeartbeat {
  workerId: string;
  processInstanceId: string;
  version: string;
  state: ResearchWorkerState;
  startedAt: Date;
  lastSeenAt: Date;
  ageSeconds: number;
  available: boolean;
}

export interface ListResearchWorkerHeartbeatsInput {
  now?: Date;
  staleAfterSeconds: number;
}

export interface MaintainResearchIdempotencyInput {
  now?: Date;
  batchSize?: number;
}

export interface MaintainResearchIdempotencyResult {
  replayBodiesScrubbed: number;
  tombstonesDeleted: number;
}

export interface CleanupResearchDataInput {
  now?: Date;
  batchSize?: number;
}

export interface CleanupResearchDataResult {
  runsDeleted: number;
  auditEventsDeleted: number;
  admissionsDeleted: number;
  identityAliasesDeleted: number;
  workerHeartbeatsDeleted: number;
  artifactStorageRelativePaths: string[];
}

export interface ResearchRunBudgetLimits {
  externalRequests: number;
  externalResponseBytes: number;
  llmCalls: number;
  inputTokens: number;
  outputTokens: number;
}

export interface ChargeResearchRunBudgetInput {
  token: ResearchLeaseToken;
  charge: ResearchRunBudgetLimits;
  limits: ResearchRunBudgetLimits;
  now?: Date;
}

export type ChargeResearchRunBudgetResult =
  | {
      outcome: "charged";
      totals: ResearchRunBudgetLimits;
    }
  | {
      outcome: "budget_exceeded";
      limit:
        | "external_requests"
        | "external_response_bytes"
        | "llm_calls"
        | "input_tokens"
        | "output_tokens";
    }
  | { outcome: "fenced_or_cancelled" };

export interface StartResearchStageRunInput {
  token: ResearchLeaseToken;
  stage: ResearchRunStage;
  attempt: number;
  inputSha256: string;
  now?: Date;
}

export interface CompleteResearchStageRunInput {
  token: ResearchLeaseToken;
  stage: ResearchRunStage;
  attempt: number;
  outputSha256: string | null;
  durationMs: number;
  promptTokens: number | null;
  completionTokens: number | null;
  gatewayRequestId: string | null;
  errorCode: string | null;
  now?: Date;
}

export type WriteResearchStageRunResult =
  | { outcome: "written" }
  | { outcome: "fenced_or_cancelled" };

export interface RecordResearchBackupStartedInput {
  backupId: string;
  schemaVersion: string;
  now?: Date;
}

export interface RecordResearchBackupCompletedInput {
  backupId: string;
  outcome: "succeeded" | "failed";
  manifestSha256?: string;
  errorCode?: string;
  now?: Date;
}

export type ResearchMaintenanceLockName =
  | "reconcile"
  | "cleanup"
  | "backup";

export interface AcquireResearchMaintenanceLockInput {
  name: ResearchMaintenanceLockName;
  owner: string;
  leaseSeconds: number;
  now?: Date;
}

export interface RenewResearchMaintenanceLockInput
  extends AcquireResearchMaintenanceLockInput {}

export interface ReleaseResearchMaintenanceLockInput {
  name: ResearchMaintenanceLockName;
  owner: string;
}

export interface ResearchStore {
  inspectCreateRunIdempotency(
    input: InspectCreateResearchRunIdempotencyInput
  ): InspectCreateResearchRunIdempotencyResult;
  createRun(input: CreateResearchRunInput): CreateResearchRunResult;
  getRunForSubject(runId: string, subjectId: string): ResearchRunRecord | null;
  getRunResultForSubject(
    runId: string,
    subjectId: string
  ): ResearchRunResultRecord | null;
  getArtifactForSubject(
    artifactId: string,
    subjectId: string
  ): ResearchArtifactRecord | null;
  listRunsForSubject(input: ListResearchRunsInput): ResearchRunRecord[];
  requestCancel(
    input: RequestResearchRunCancelInput
  ): RequestResearchRunCancelResult;
  listIdentityCandidatesForSubject(
    runId: string,
    subjectId: string
  ): ResearchIdentityCandidate[];
  resolveIdentity(
    input: ResolveResearchIdentityInput
  ): ResolveResearchIdentityResult;
  close?(): void;
}

export interface ResearchWorkerStore {
  acquireLease(input: AcquireResearchLeaseInput): AcquiredResearchLease | null;
  renewLease(input: RenewResearchLeaseInput): RenewResearchLeaseResult;
  completeCancellation(
    input: CompleteResearchCancellationInput
  ): CompleteResearchCancellationResult;
  writeCheckpoint(
    input: WriteResearchCheckpointInput
  ): WriteResearchCheckpointResult;
  completeSuccessfulRun(
    input: CompleteSuccessfulResearchRunInput
  ): CompleteSuccessfulResearchRunResult;
  pauseForIdentity(
    input: PauseResearchForIdentityInput
  ): PauseResearchForIdentityResult;
  failRun(input: FailResearchRunInput): FailResearchRunResult;
  requeueRun(input: RequeueResearchRunInput): RequeueResearchRunResult;
  reconcileTtl(input?: ReconcileResearchTtlInput): ReconcileResearchTtlResult;
  recordWorkerHeartbeat(
    input: RecordResearchWorkerHeartbeatInput
  ): RecordResearchWorkerHeartbeatResult;
  listWorkerHeartbeats(
    input: ListResearchWorkerHeartbeatsInput
  ): ResearchWorkerHeartbeat[];
  maintainIdempotency(
    input?: MaintainResearchIdempotencyInput
  ): MaintainResearchIdempotencyResult;
  cleanupExpiredData(
    input?: CleanupResearchDataInput
  ): CleanupResearchDataResult;
  chargeRunBudget(
    input: ChargeResearchRunBudgetInput
  ): ChargeResearchRunBudgetResult;
  startStageRun(
    input: StartResearchStageRunInput
  ): WriteResearchStageRunResult;
  completeStageRun(
    input: CompleteResearchStageRunInput
  ): WriteResearchStageRunResult;
  listCommittedArtifactStoragePaths(): string[];
  recordBackupStarted(input: RecordResearchBackupStartedInput): void;
  recordBackupCompleted(input: RecordResearchBackupCompletedInput): void;
  latestSuccessfulBackupAt(): Date | null;
  acquireMaintenanceLock(
    input: AcquireResearchMaintenanceLockInput
  ): boolean;
  renewMaintenanceLock(input: RenewResearchMaintenanceLockInput): boolean;
  releaseMaintenanceLock(input: ReleaseResearchMaintenanceLockInput): void;
}
