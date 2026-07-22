import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  type AcquiredResearchLease,
  type AcquireResearchMaintenanceLockInput,
  type AcquireResearchLeaseInput,
  type ChargeResearchRunBudgetInput,
  type ChargeResearchRunBudgetResult,
  type CleanupResearchDataInput,
  type CleanupResearchDataResult,
  type CompleteResearchCancellationInput,
  type CompleteResearchCancellationResult,
  type CompleteResearchStageRunInput,
  type CompleteSuccessfulResearchRunInput,
  type CompleteSuccessfulResearchRunResult,
  type CreateResearchRunInput,
  type CreateResearchRunResult,
  type DoctorResearchRunInput,
  type FailResearchRunInput,
  type FailResearchRunResult,
  type InspectCreateResearchRunIdempotencyInput,
  type InspectCreateResearchRunIdempotencyResult,
  type ListResearchRunsInput,
  type ListResearchWorkerHeartbeatsInput,
  type MaintainResearchIdempotencyInput,
  type MaintainResearchIdempotencyResult,
  type PauseResearchForIdentityInput,
  type PauseResearchForIdentityResult,
  type ReconcileResearchTtlInput,
  type ReconcileResearchTtlResult,
  type RecordResearchWorkerHeartbeatInput,
  type RecordResearchWorkerHeartbeatResult,
  type RecordResearchBackupCompletedInput,
  type RecordResearchBackupStartedInput,
  type RequeueResearchRunInput,
  type RequeueResearchRunResult,
  type ReleaseResearchMaintenanceLockInput,
  type RenewResearchMaintenanceLockInput,
  type RenewResearchLeaseInput,
  type RenewResearchLeaseResult,
  type RequestResearchRunCancelInput,
  type RequestResearchRunCancelResult,
  type ResolveResearchIdentityInput,
  type ResolveResearchIdentityReceipt,
  type ResolveResearchIdentityResult,
  type ResearchIdentityCandidate,
  type ResearchArtifactRecord,
  type ResearchLeaseToken,
  type ResearchRunRecord,
  type ResearchRunCancelReceipt,
  type ResearchRunReceipt,
  type ResearchRunResultRecord,
  type ResearchRunStage,
  type ResearchRunStatus,
  researchRunStages,
  type ResearchStore,
  type ResearchWorkerHeartbeat,
  type ResearchWorkerStore,
  type StartResearchStageRunInput,
  type WriteResearchCheckpointInput,
  type WriteResearchCheckpointResult,
  type WriteResearchStageRunResult
} from "@codex-gateway/core";
import {
  type DoctorResearchResult,
  validateDoctorResearchResultValue
} from "@codex-gateway/research-agent";
import { migrateResearchSchema } from "./research-migrations.js";
import {
  openConfiguredSqliteDatabase,
  tightenSqliteFilePermissions
} from "./sqlite-managed.js";
import type { SqliteStoreLogger } from "./types.js";

const createRunEndpoint = "/gateway/research/v1/doctor-runs";
const dayMs = 24 * 60 * 60 * 1000;

export interface ResearchAdmissionLimits {
  dailyRunsPerSubject: number;
  uniqueDoctors30dPerSubject: number;
  globalActiveRuns: number;
  needsInputPerSubject: number;
}

export interface ResearchSqliteStoreOptions {
  path: string;
  limits: ResearchAdmissionLimits;
  busyTimeoutMs?: number;
  idempotencyReplaySeconds?: number;
  idempotencyTombstoneSeconds?: number;
  resultTtlSeconds?: number;
  runRetentionSeconds?: number;
  needsInputTtlSeconds?: number;
  maximumCheckpointBytes?: number;
  maximumResultBytes?: number;
  logger?: SqliteStoreLogger;
}

export class ResearchSqliteStore implements ResearchStore, ResearchWorkerStore {
  readonly kind = "research-sqlite";
  readonly path: string;
  private readonly db: DatabaseSync;
  private readonly limits: ResearchAdmissionLimits;
  private readonly replayMs: number;
  private readonly tombstoneMs: number;
  private readonly resultTtlMs: number;
  private readonly runRetentionMs: number;
  private readonly needsInputTtlMs: number;
  private readonly maximumCheckpointBytes: number;
  private readonly maximumResultBytes: number;

  constructor(options: ResearchSqliteStoreOptions) {
    this.path = options.path;
    this.limits = validateLimits(options.limits);
    this.replayMs = secondsToMs(
      options.idempotencyReplaySeconds ?? 604_800,
      "idempotencyReplaySeconds"
    );
    this.tombstoneMs = secondsToMs(
      options.idempotencyTombstoneSeconds ?? 2_592_000,
      "idempotencyTombstoneSeconds"
    );
    if (this.tombstoneMs <= this.replayMs) {
      throw new Error(
        "idempotencyTombstoneSeconds must be greater than idempotencyReplaySeconds."
      );
    }
    this.resultTtlMs = secondsToMs(
      options.resultTtlSeconds ?? 2_592_000,
      "resultTtlSeconds"
    );
    this.runRetentionMs = secondsToMs(
      options.runRetentionSeconds ?? 7_776_000,
      "runRetentionSeconds"
    );
    if (this.runRetentionMs < this.resultTtlMs) {
      throw new Error(
        "runRetentionSeconds must be greater than or equal to resultTtlSeconds."
      );
    }
    this.needsInputTtlMs = secondsToMs(
      options.needsInputTtlSeconds ?? 259_200,
      "needsInputTtlSeconds"
    );
    this.maximumCheckpointBytes = positiveInteger(
      options.maximumCheckpointBytes ?? 1_048_576,
      "maximumCheckpointBytes"
    );
    this.maximumResultBytes = positiveInteger(
      options.maximumResultBytes ?? 4_194_304,
      "maximumResultBytes"
    );

    const busyTimeoutMs = positiveInteger(
      options.busyTimeoutMs ?? 5_000,
      "busyTimeoutMs"
    );
    const database = openConfiguredSqliteDatabase(options.path);
    try {
      database.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
      migrateResearchSchema(database, options.logger);
      tightenSqliteFilePermissions(options.path);
    } catch (error) {
      database.close();
      throw error;
    }
    this.db = database;
  }

  get database(): DatabaseSync {
    return this.db;
  }

  inspectCreateRunIdempotency(
    input: InspectCreateResearchRunIdempotencyInput
  ): InspectCreateResearchRunIdempotencyResult {
    const now = input.now ?? new Date();
    return inImmediateTransaction(this.db, () => {
      const idempotency = resolveIdempotency(this.db, {
        subjectId: input.subjectId,
        credentialId: input.credentialId,
        requestId: input.requestId,
        endpoint: createRunEndpoint,
        idempotencyKey: input.idempotencyKey,
        requestHash: input.requestHash,
        expectedResponseStatus: 202,
        now
      });
      if (idempotency.outcome === "proceed") {
        return { outcome: "not_found" };
      }
      if (idempotency.outcome === "conflict") {
        return { outcome: "idempotency_conflict" };
      }
      if (idempotency.outcome === "expired") {
        return { outcome: "idempotency_expired" };
      }
      const run = getRun(this.db, idempotency.runId, input.subjectId);
      if (!run) {
        throw new Error("Research idempotency record references a missing run.");
      }
      return {
        outcome: "replayed",
        run,
        receipt: parseRunReceipt(idempotency.responseBodyJson)
      };
    });
  }

  createRun(input: CreateResearchRunInput): CreateResearchRunResult {
    const now = input.now ?? new Date();
    return inImmediateTransaction(this.db, () => {
      const idempotency = resolveIdempotency(this.db, {
        subjectId: input.subjectId,
        credentialId: input.credentialId,
        requestId: input.requestId,
        endpoint: createRunEndpoint,
        idempotencyKey: input.idempotencyKey,
        requestHash: input.requestHash,
        expectedResponseStatus: 202,
        now
      });
      if (idempotency.outcome === "conflict") {
        return { outcome: "idempotency_conflict" };
      }
      if (idempotency.outcome === "replay") {
        const run = getRun(this.db, idempotency.runId, input.subjectId);
        if (!run) {
          throw new Error("Research idempotency record references a missing run.");
        }
        return {
          outcome: "replayed",
          run,
          receipt: parseRunReceipt(idempotency.responseBodyJson)
        };
      }
      if (idempotency.outcome === "expired") {
        return { outcome: "idempotency_expired" };
      }

      const activeBriefs = count(
        this.db,
        `SELECT COUNT(*) AS count
         FROM research_runs
         WHERE subject_id = ?
           AND mode = 'brief'
           AND status IN ('queued', 'running')`,
        input.subjectId
      );
      if (activeBriefs >= 1) {
        return admissionRejected(
          this.db,
          input,
          "research_active_brief",
          now
        );
      }

      const needsInput = count(
        this.db,
        `SELECT COUNT(*) AS count
         FROM research_runs
         WHERE subject_id = ?
           AND status = 'needs_input'
           AND needs_input_expires_at > ?`,
        input.subjectId,
        now.toISOString()
      );
      if (needsInput >= this.limits.needsInputPerSubject) {
        return admissionRejected(
          this.db,
          input,
          "research_needs_input",
          now
        );
      }

      const utcDayStart = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
      );
      const dailyRuns = count(
        this.db,
        `SELECT COUNT(*) AS count
         FROM research_doctor_admissions
         WHERE subject_id = ?
           AND admitted_at >= ?`,
        input.subjectId,
        utcDayStart.toISOString()
      );
      if (dailyRuns >= this.limits.dailyRunsPerSubject) {
        return admissionRejected(
          this.db,
          input,
          "research_daily_runs",
          now
        );
      }

      const alias = this.db
        .prepare(
          `SELECT canonical_identity_id
           FROM research_subject_identity_aliases
           WHERE subject_id = ? AND identity_fingerprint = ?`
        )
        .get(input.subjectId, input.identityFingerprint) as
        | { canonical_identity_id: string }
        | undefined;
      const doctorKey = alias
        ? `dci:${alias.canonical_identity_id}`
        : `fp:${input.identityFingerprint}`;
      const windowStart = new Date(now.getTime() - 30 * dayMs).toISOString();
      const doctorSeen = count(
        this.db,
        `SELECT COUNT(*) AS count
         FROM research_doctor_admissions
         WHERE subject_id = ?
           AND doctor_key = ?
           AND admitted_at >= ?`,
        input.subjectId,
        doctorKey,
        windowStart
      );
      const uniqueDoctors = count(
        this.db,
        `SELECT COUNT(DISTINCT doctor_key) AS count
         FROM research_doctor_admissions
         WHERE subject_id = ?
           AND admitted_at >= ?`,
        input.subjectId,
        windowStart
      );
      if (
        doctorSeen === 0 &&
        uniqueDoctors >= this.limits.uniqueDoctors30dPerSubject
      ) {
        return admissionRejected(
          this.db,
          input,
          "research_unique_doctors_30d",
          now
        );
      }

      const globalActive = count(
        this.db,
        `SELECT COUNT(*) AS count
         FROM research_runs
         WHERE status IN ('queued', 'running')`
      );
      if (globalActive >= this.limits.globalActiveRuns) {
        return admissionRejected(
          this.db,
          input,
          "research_global_queue",
          now
        );
      }

      const runId = `drr_${randomUUID().replaceAll("-", "")}`;
      const timestamp = now.toISOString();
      const receipt: ResearchRunReceipt = {
        schema_version: "doctor_research_run.v1",
        request_id: input.requestId,
        run_id: runId,
        status: "queued",
        stage: "validate_input",
        mode: "brief",
        skill: {
          name: "doctor-research-query",
          version: "1.6.67"
        },
        created_at: timestamp,
        status_url: `${createRunEndpoint}/${runId}`,
        result_url: `${createRunEndpoint}/${runId}/result`
      };
      this.db
        .prepare(
          `INSERT INTO research_runs (
            run_id, subject_id, credential_id, skill_name, skill_version,
            prompt_version, input_schema_version, output_schema_version,
            mode, language, input_json, status, stage, progress_percent,
            warning_codes_json, queued_at, created_at, updated_at
          ) VALUES (
            ?, ?, ?, 'doctor-research-query', '1.6.67',
            'doctor-research-prompt.v28', 'doctor_research_run_input.v2',
            'doctor_research_result.v1', ?, ?, ?, 'queued', 'validate_input',
            0, '[]', ?, ?, ?
          )`
        )
        .run(
          runId,
          input.subjectId,
          input.credentialId,
          input.input.mode,
          input.input.language,
          JSON.stringify(input.input),
          timestamp,
          timestamp,
          timestamp
        );
      this.db
        .prepare(
          `INSERT INTO research_doctor_admissions (
            run_id, subject_id, identity_fingerprint, canonical_identity_id,
            doctor_key, admitted_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          runId,
          input.subjectId,
          input.identityFingerprint,
          alias?.canonical_identity_id ?? null,
          doctorKey,
          timestamp,
          timestamp
        );
      insertIdempotencyRecord(this.db, {
        subjectId: input.subjectId,
        endpoint: createRunEndpoint,
        idempotencyKey: input.idempotencyKey,
        requestHash: input.requestHash,
        runId,
        responseStatus: 202,
        responseBody: receipt,
        replayExpiresAt: new Date(now.getTime() + this.replayMs),
        tombstoneExpiresAt: new Date(now.getTime() + this.tombstoneMs),
        createdAt: now
      });
      insertAuditEvent(this.db, {
        input,
        action: "run_create",
        outcome: "ok",
        runId,
        now,
        params: {
            mode: input.input.mode,
            language: input.input.language,
            identity_fingerprint: input.identityFingerprint
        }
      });

      const run = getRun(this.db, runId, input.subjectId);
      if (!run) {
        throw new Error("Research run was not readable after creation.");
      }
      return { outcome: "created", run, receipt };
    });
  }

  getRunForSubject(runId: string, subjectId: string): ResearchRunRecord | null {
    return getRun(this.db, runId, subjectId);
  }

  getRunResultForSubject(
    runId: string,
    subjectId: string
  ): ResearchRunResultRecord | null {
    const row = this.db
      .prepare(
        `SELECT result.run_id, result.schema_version, result.result_json,
                result.result_sha256, result.size_bytes, result.created_at,
                result.expires_at
         FROM research_run_results AS result
         INNER JOIN research_runs AS run ON run.run_id = result.run_id
         WHERE result.run_id = ?
           AND run.subject_id = ?`
      )
      .get(runId, subjectId) as
      | {
          run_id: string;
          schema_version: string;
          result_json: string;
          result_sha256: string;
          size_bytes: number;
          created_at: string;
          expires_at: string;
        }
      | undefined;
    if (!row) {
      return null;
    }
    const resultBytes = Buffer.from(row.result_json, "utf8");
    const observedSha256 = createHash("sha256")
      .update(resultBytes)
      .digest("hex");
    if (
      resultBytes.length !== row.size_bytes ||
      observedSha256 !== row.result_sha256
    ) {
      throw new Error("Stored Research result integrity check failed.");
    }
    const result = JSON.parse(row.result_json) as unknown;
    const validation = validateDoctorResearchResultValue(result);
    if (row.schema_version !== "doctor_research_result.v1" || !validation.ok) {
      throw new Error("Stored Research result is invalid.");
    }
    return {
      runId: row.run_id,
      schemaVersion: row.schema_version,
      result: result as Record<string, unknown>,
      sha256: row.result_sha256,
      sizeBytes: row.size_bytes,
      createdAt: new Date(row.created_at),
      expiresAt: new Date(row.expires_at)
    };
  }

  getArtifactForSubject(
    artifactId: string,
    subjectId: string
  ): ResearchArtifactRecord | null {
    const row = this.db
      .prepare(
        `SELECT artifact_id, run_id, subject_id, kind, filename_ascii,
                filename_utf8, content_type, storage_path, storage_version,
                sha256, size_bytes, created_at, expires_at
         FROM research_artifacts
         WHERE artifact_id = ?
           AND subject_id = ?`
      )
      .get(artifactId, subjectId) as
      | {
          artifact_id: string;
          run_id: string;
          subject_id: string;
          kind: ResearchArtifactRecord["kind"];
          filename_ascii: string;
          filename_utf8: string;
          content_type: ResearchArtifactRecord["contentType"];
          storage_path: string;
          storage_version: number;
          sha256: string;
          size_bytes: number;
          created_at: string;
          expires_at: string;
        }
      | undefined;
    if (!row) {
      return null;
    }
    return {
      artifactId: row.artifact_id,
      runId: row.run_id,
      subjectId: row.subject_id,
      kind: row.kind,
      filenameAscii: row.filename_ascii,
      filenameUtf8: row.filename_utf8,
      contentType: row.content_type,
      storageRelativePath: row.storage_path,
      storageVersion: row.storage_version,
      sha256: row.sha256,
      sizeBytes: row.size_bytes,
      createdAt: new Date(row.created_at),
      expiresAt: new Date(row.expires_at)
    };
  }

  listRunsForSubject(input: ListResearchRunsInput): ResearchRunRecord[] {
    const logicalNow = input.now ?? new Date();
    const statusFilter = input.status
      ? researchStatusFilter(input.status, logicalNow)
      : { clause: "", parameters: [] };
    const cursorClause = input.before
      ? "AND (created_at < ? OR (created_at = ? AND run_id < ?))"
      : "";
    const parameters: Array<string | number> = [input.subjectId];
    parameters.push(...statusFilter.parameters);
    if (input.before) {
      const createdAt = input.before.createdAt.toISOString();
      parameters.push(createdAt, createdAt, input.before.runId);
    }
    parameters.push(input.limit);
    const rows = this.db
      .prepare(
        `SELECT ${researchRunColumns}
         FROM research_runs
         WHERE subject_id = ?
           ${statusFilter.clause}
           ${cursorClause}
         ORDER BY created_at DESC, run_id DESC
         LIMIT ?`
      )
      .all(...parameters);
    return rows.map(rowToResearchRun);
  }

  listIdentityCandidatesForSubject(
    runId: string,
    subjectId: string
  ): ResearchIdentityCandidate[] {
    const rows = this.db
      .prepare(
        `SELECT candidate_json
         FROM research_identity_candidates
         WHERE run_id = ?
           AND EXISTS (
             SELECT 1
             FROM research_runs
             WHERE research_runs.run_id = research_identity_candidates.run_id
               AND research_runs.subject_id = ?
           )
         ORDER BY score DESC, candidate_id ASC`
      )
      .all(runId, subjectId) as Array<{ candidate_json: string }>;
    return rows.map((row) => parseIdentityCandidate(row.candidate_json));
  }

  resolveIdentity(
    input: ResolveResearchIdentityInput
  ): ResolveResearchIdentityResult {
    const now = input.now ?? new Date();
    const endpoint = `${createRunEndpoint}/${input.runId}/identity-selection`;
    return inImmediateTransaction(this.db, () => {
      let run = getRun(this.db, input.runId, input.subjectId);
      if (!run) {
        return { outcome: "not_found" };
      }
      const idempotency = resolveIdempotency(this.db, {
        subjectId: input.subjectId,
        credentialId: input.credentialId,
        requestId: input.requestId,
        endpoint,
        idempotencyKey: input.idempotencyKey,
        requestHash: input.requestHash,
        expectedResponseStatus: 200,
        now
      });
      if (idempotency.outcome === "conflict") {
        return { outcome: "idempotency_conflict" };
      }
      if (idempotency.outcome === "replay") {
        return {
          outcome: "replayed",
          run,
          receipt: parseIdentityReceipt(idempotency.responseBodyJson)
        };
      }
      if (idempotency.outcome === "expired") {
        return { outcome: "idempotency_expired" };
      }
      if (
        run.status !== "needs_input" ||
        !run.needsInputExpiresAt ||
        run.needsInputExpiresAt.getTime() <= now.getTime()
      ) {
        return { outcome: "identity_selection_not_expected" };
      }

      let receipt: ResolveResearchIdentityReceipt;
      if (input.selection.action === "select") {
        const candidateRow = this.db
          .prepare(
            `SELECT candidate_json
             FROM research_identity_candidates
             WHERE run_id = ?
               AND candidate_id = ?
               AND selected_at IS NULL
               AND rejected_at IS NULL`
          )
          .get(input.runId, input.selection.candidateId) as
          | { candidate_json: string }
          | undefined;
        if (!candidateRow) {
          return { outcome: "candidate_not_found" };
        }
        const candidate = parseIdentityCandidate(
          candidateRow.candidate_json
        );
        const activeBriefs = count(
          this.db,
          `SELECT COUNT(*) AS count
           FROM research_runs
           WHERE subject_id = ?
             AND run_id <> ?
             AND mode = 'brief'
             AND status IN ('queued', 'running')`,
          input.subjectId,
          input.runId
        );
        if (activeBriefs >= 1) {
          insertRawAuditEvent(this.db, {
            occurredAt: now,
            requestId: input.requestId,
            actorType: "subject",
            subjectId: input.subjectId,
            credentialId: input.credentialId,
            runId: input.runId,
            action: "identity_selection",
            outcome: "rejected",
            params: { limit_kind: "research_active_brief" }
          });
          return {
            outcome: "rate_limited",
            limitKind: "research_active_brief"
          };
        }
        const updated = this.db
          .prepare(
            `UPDATE research_runs
             SET status = 'queued',
                 stage = 'collect_profile_evidence',
                 canonical_identity_id = ?,
                 resume_count = resume_count + 1,
                 queued_at = ?,
                 needs_input_started_at = NULL,
                 needs_input_expires_at = NULL,
                 updated_at = ?
             WHERE run_id = ?
               AND subject_id = ?
               AND status = 'needs_input'
               AND needs_input_expires_at > ?`
          )
          .run(
            candidate.canonicalIdentityId,
            now.toISOString(),
            now.toISOString(),
            input.runId,
            input.subjectId,
            now.toISOString()
          );
        if (updated.changes !== 1) {
          throw new Error("Research identity selection invariant violation.");
        }
        this.db
          .prepare(
            `UPDATE research_identity_candidates
             SET selected_at = CASE WHEN candidate_id = ? THEN ? ELSE NULL END,
                 rejected_at = CASE WHEN candidate_id <> ? THEN ? ELSE NULL END
             WHERE run_id = ?`
          )
          .run(
            candidate.candidateId,
            now.toISOString(),
            candidate.candidateId,
            now.toISOString(),
            input.runId
          );
        const admission = this.db
          .prepare(
            `SELECT identity_fingerprint
             FROM research_doctor_admissions
             WHERE run_id = ? AND subject_id = ?`
          )
          .get(input.runId, input.subjectId) as
          | { identity_fingerprint: string }
          | undefined;
        if (!admission) {
          throw new Error("Research identity selection admission is missing.");
        }
        this.db
          .prepare(
            `INSERT INTO research_subject_identity_aliases (
              subject_id, identity_fingerprint, canonical_identity_id, verified_at
            ) VALUES (?, ?, ?, ?)
            ON CONFLICT(subject_id, identity_fingerprint) DO UPDATE SET
              canonical_identity_id = excluded.canonical_identity_id,
              verified_at = excluded.verified_at`
          )
          .run(
            input.subjectId,
            admission.identity_fingerprint,
            candidate.canonicalIdentityId,
            now.toISOString()
          );
        this.db
          .prepare(
            `UPDATE research_doctor_admissions
             SET canonical_identity_id = ?,
                 doctor_key = ?,
                 updated_at = ?
             WHERE subject_id = ?
               AND identity_fingerprint = ?`
          )
          .run(
            candidate.canonicalIdentityId,
            `dci:${candidate.canonicalIdentityId}`,
            now.toISOString(),
            input.subjectId,
            admission.identity_fingerprint
          );
        receipt = {
          schema_version: "doctor_research_run.v1",
          request_id: input.requestId,
          run_id: input.runId,
          status: "queued",
          stage: "collect_profile_evidence",
          canonical_identity_id: candidate.canonicalIdentityId,
          terminal_reason: null,
          updated_at: now.toISOString()
        };
      } else {
        const expiresAt = new Date(now.getTime() + this.resultTtlMs);
        const purgeAfter = new Date(now.getTime() + this.runRetentionMs);
        const updated = this.db
          .prepare(
            `UPDATE research_runs
             SET status = 'failed',
                 terminal_reason = 'identity_rejected_by_user',
                 terminal_detail_public = 'The available identities were rejected.',
                 completed_at = ?,
                 expires_at = ?,
                 purge_after = ?,
                 updated_at = ?
             WHERE run_id = ?
               AND subject_id = ?
               AND status = 'needs_input'
               AND needs_input_expires_at > ?`
          )
          .run(
            now.toISOString(),
            expiresAt.toISOString(),
            purgeAfter.toISOString(),
            now.toISOString(),
            input.runId,
            input.subjectId,
            now.toISOString()
          );
        if (updated.changes !== 1) {
          throw new Error("Research identity rejection invariant violation.");
        }
        this.db
          .prepare(
            `UPDATE research_identity_candidates
             SET rejected_at = ?
             WHERE run_id = ? AND selected_at IS NULL`
          )
          .run(now.toISOString(), input.runId);
        receipt = {
          schema_version: "doctor_research_run.v1",
          request_id: input.requestId,
          run_id: input.runId,
          status: "failed",
          stage: "resolve_identity",
          canonical_identity_id: null,
          terminal_reason: "identity_rejected_by_user",
          updated_at: now.toISOString()
        };
      }

      insertRawAuditEvent(this.db, {
        occurredAt: now,
        requestId: input.requestId,
        actorType: "subject",
        subjectId: input.subjectId,
        credentialId: input.credentialId,
        runId: input.runId,
        action: "identity_selection",
        outcome: "ok",
        params: { action: input.selection.action }
      });
      insertIdempotencyRecord(this.db, {
        subjectId: input.subjectId,
        endpoint,
        idempotencyKey: input.idempotencyKey,
        requestHash: input.requestHash,
        runId: input.runId,
        responseStatus: 200,
        responseBody: receipt,
        replayExpiresAt: new Date(now.getTime() + this.replayMs),
        tombstoneExpiresAt: new Date(now.getTime() + this.tombstoneMs),
        createdAt: now
      });
      run = getRun(this.db, input.runId, input.subjectId);
      if (!run) {
        throw new Error("Research run disappeared after identity selection.");
      }
      return { outcome: "accepted", run, receipt };
    });
  }

  requestCancel(
    input: RequestResearchRunCancelInput
  ): RequestResearchRunCancelResult {
    const now = input.now ?? new Date();
    const endpoint = `${createRunEndpoint}/${input.runId}/cancel`;
    return inImmediateTransaction(this.db, () => {
      let run = getRun(this.db, input.runId, input.subjectId);
      if (!run) {
        return { outcome: "not_found" };
      }

      const idempotency = resolveIdempotency(this.db, {
        subjectId: input.subjectId,
        credentialId: input.credentialId,
        requestId: input.requestId,
        endpoint,
        idempotencyKey: input.idempotencyKey,
        requestHash: input.requestHash,
        expectedResponseStatus: 200,
        now
      });
      if (idempotency.outcome === "conflict") {
        return { outcome: "idempotency_conflict" };
      }
      if (idempotency.outcome === "replay") {
        return {
          outcome: "replayed",
          run,
          receipt: parseCancelReceipt(idempotency.responseBodyJson)
        };
      }
      if (idempotency.outcome === "expired") {
        return { outcome: "idempotency_expired" };
      }

      if (
        run.status === "needs_input" &&
        run.needsInputExpiresAt !== null &&
        run.needsInputExpiresAt.getTime() <= now.getTime()
      ) {
        const normalized = transitionExpiredNeedsInputRun(this.db, {
          runId: run.runId,
          subjectId: run.subjectId,
          requestId: input.requestId,
          now,
          resultTtlMs: this.resultTtlMs,
          runRetentionMs: this.runRetentionMs
        });
        if (!normalized) {
          throw new Error(
            "Research needs-input timeout normalization invariant violation."
          );
        }
        const normalizedRun = getRun(this.db, input.runId, input.subjectId);
        if (!normalizedRun) {
          throw new Error(
            "Research run disappeared after needs-input timeout normalization."
          );
        }
        run = normalizedRun;
      }

      if (
        run.status === "succeeded" ||
        run.status === "failed" ||
        run.status === "expired" ||
        (run.status === "cancelled" &&
          run.expiresAt !== null &&
          run.expiresAt.getTime() <= now.getTime())
      ) {
        return {
          outcome: "invalid_transition",
          status:
            run.status === "cancelled" ? ("expired" as const) : run.status
        };
      }

      let changed = false;
      if (run.status === "queued" || run.status === "needs_input") {
        const timestamp = now.toISOString();
        const updated = this.db
          .prepare(
            `UPDATE research_runs
             SET status = 'cancelled',
                 terminal_reason = 'cancelled_by_user',
                 terminal_detail_public = 'The Research run was cancelled by the user.',
                 cancel_requested_at = ?,
                 cancel_requested_by = 'subject',
                 cancel_request_id = ?,
                 active_started_at = NULL,
                 lease_owner = NULL,
                 lease_until = NULL,
                 completed_at = ?,
                 expires_at = ?,
                 purge_after = ?,
                 updated_at = ?
             WHERE run_id = ?
               AND subject_id = ?
               AND status IN ('queued', 'needs_input')`
          )
          .run(
            timestamp,
            input.requestId,
            timestamp,
            new Date(now.getTime() + this.resultTtlMs).toISOString(),
            new Date(now.getTime() + this.runRetentionMs).toISOString(),
            timestamp,
            input.runId,
            input.subjectId
          );
        if (updated.changes !== 1) {
          throw new Error("Research immediate cancellation invariant violation.");
        }
        changed = true;
      } else if (run.status === "running" && !run.cancelRequestedAt) {
        const updated = this.db
          .prepare(
            `UPDATE research_runs
             SET cancel_requested_at = ?,
                 cancel_requested_by = 'subject',
                 cancel_request_id = ?,
                 updated_at = ?
             WHERE run_id = ?
               AND subject_id = ?
               AND status = 'running'
               AND cancel_requested_at IS NULL`
          )
          .run(
            now.toISOString(),
            input.requestId,
            now.toISOString(),
            input.runId,
            input.subjectId
          );
        if (updated.changes !== 1) {
          throw new Error("Research running cancellation invariant violation.");
        }
        changed = true;
      }

      if (changed) {
        insertRawAuditEvent(this.db, {
          occurredAt: now,
          requestId: input.requestId,
          actorType: "subject",
          subjectId: input.subjectId,
          credentialId: input.credentialId,
          runId: input.runId,
          action:
            run.status === "running"
              ? "cancel_requested"
              : "cancel_completed",
          outcome: "ok",
          params: {}
        });
      }

      run = getRun(this.db, input.runId, input.subjectId);
      if (!run || (run.status !== "running" && run.status !== "cancelled")) {
        throw new Error("Research run was not readable after cancellation.");
      }
      const receipt: ResearchRunCancelReceipt = {
        schema_version: "doctor_research_run.v1",
        request_id: input.requestId,
        run_id: input.runId,
        status: run.status,
        cancel_requested: run.status === "running",
        terminal_reason: run.terminalReason,
        updated_at: run.updatedAt.toISOString()
      };
      insertIdempotencyRecord(this.db, {
        subjectId: input.subjectId,
        endpoint,
        idempotencyKey: input.idempotencyKey,
        requestHash: input.requestHash,
        runId: input.runId,
        responseStatus: 200,
        responseBody: receipt,
        replayExpiresAt: new Date(now.getTime() + this.replayMs),
        tombstoneExpiresAt: new Date(now.getTime() + this.tombstoneMs),
        createdAt: now
      });
      return { outcome: "accepted", run, receipt };
    });
  }

  acquireLease(input: AcquireResearchLeaseInput): AcquiredResearchLease | null {
    const now = input.now ?? new Date();
    const leaseMs = secondsToMs(input.leaseSeconds, "leaseSeconds");
    requireNonEmpty(input.workerId, "workerId");
    return inImmediateTransaction(this.db, () => {
      const candidate = this.db
        .prepare(
          `SELECT run_id, subject_id, status, lease_generation, lease_until,
                  active_started_at
           FROM research_runs
           WHERE status = 'queued'
              OR (
                status = 'running'
                AND lease_until IS NOT NULL
                AND lease_until <= ?
              )
           ORDER BY
             CASE status WHEN 'queued' THEN 0 ELSE 1 END,
             queued_at ASC,
             run_id ASC
           LIMIT 1`
        )
        .get(now.toISOString()) as
        | {
            run_id: string;
            subject_id: string;
            status: "queued" | "running";
            lease_generation: number;
            lease_until: string | null;
            active_started_at: string | null;
          }
        | undefined;
      if (!candidate) {
        return null;
      }

      const activeDeltaMs =
        candidate.status === "running"
          ? expiredLeaseActiveDeltaMs(candidate, now)
          : 0;
      const nextGeneration = candidate.lease_generation + 1;
      const leaseUntil = new Date(now.getTime() + leaseMs);
      const guard =
        candidate.status === "queued"
          ? "status = 'queued'"
          : `status = 'running'
             AND lease_generation = ?
             AND lease_until IS NOT NULL
             AND lease_until <= ?`;
      const updated = this.db
        .prepare(
          `UPDATE research_runs
           SET status = 'running',
               active_elapsed_ms = active_elapsed_ms + ?,
               active_started_at = ?,
               lease_owner = ?,
               lease_until = ?,
               lease_generation = ?,
               attempt_count = attempt_count + 1,
               updated_at = ?
           WHERE run_id = ?
             AND ${guard}`
        )
        .run(
          activeDeltaMs,
          now.toISOString(),
          input.workerId,
          leaseUntil.toISOString(),
          nextGeneration,
          now.toISOString(),
          candidate.run_id,
          ...(candidate.status === "running"
            ? [candidate.lease_generation, now.toISOString()]
            : [])
        );
      if (updated.changes !== 1) {
        throw new Error("Research lease acquisition invariant violation.");
      }
      insertRawAuditEvent(this.db, {
        occurredAt: now,
        actorType: "worker",
        subjectId: candidate.subject_id,
        runId: candidate.run_id,
        action:
          candidate.status === "running" ? "lease_takeover" : "lease_acquire",
        outcome: "ok",
        params: {
          worker_id: input.workerId,
          lease_generation: nextGeneration
        }
      });
      const run = getRunById(this.db, candidate.run_id);
      if (!run) {
        throw new Error("Research run was not readable after lease acquisition.");
      }
      const token: ResearchLeaseToken = {
        runId: run.runId,
        owner: input.workerId,
        generation: nextGeneration,
        leaseUntil
      };
      return {
        run,
        token,
        cancelRequested: run.cancelRequestedAt !== null
      };
    });
  }

  renewLease(input: RenewResearchLeaseInput): RenewResearchLeaseResult {
    const now = input.now ?? new Date();
    const leaseMs = secondsToMs(input.leaseSeconds, "leaseSeconds");
    validateLeaseToken(input.token);
    const leaseUntil = new Date(now.getTime() + leaseMs);
    const renewed = this.db
      .prepare(
        `UPDATE research_runs
         SET lease_until = ?, updated_at = ?
         WHERE run_id = ?
           AND status = 'running'
           AND lease_owner = ?
           AND lease_generation = ?
           AND lease_until > ?
         RETURNING cancel_requested_at, cancel_requested_by`
      )
      .get(
        leaseUntil.toISOString(),
        now.toISOString(),
        input.token.runId,
        input.token.owner,
        input.token.generation,
        now.toISOString()
      ) as
      | {
          cancel_requested_at: string | null;
          cancel_requested_by:
            | ResearchRunRecord["cancelRequestedBy"]
            | null;
        }
      | undefined;
    if (!renewed) {
      return lostLeaseResult(this.db, input.token.runId);
    }
    return {
      outcome: "renewed",
      token: { ...input.token, leaseUntil },
      cancelRequested: renewed.cancel_requested_at !== null,
      cancelRequestedBy: renewed.cancel_requested_by
    };
  }

  completeCancellation(
    input: CompleteResearchCancellationInput
  ): CompleteResearchCancellationResult {
    const now = input.now ?? new Date();
    validateLeaseToken(input.token);
    return inImmediateTransaction(this.db, () => {
      const current = getRunById(this.db, input.token.runId);
      if (
        !current ||
        current.status !== "running" ||
        current.leaseOwner !== input.token.owner ||
        current.leaseGeneration !== input.token.generation ||
        !current.leaseUntil ||
        current.leaseUntil.getTime() <= now.getTime() ||
        !current.cancelRequestedAt
      ) {
        return lostLeaseResult(this.db, input.token.runId);
      }
      const terminalReason = cancellationTerminalReason(current);
      const activeDeltaMs = current.activeStartedAt
        ? Math.max(0, now.getTime() - current.activeStartedAt.getTime())
        : 0;
      const updated = this.db
        .prepare(
          `UPDATE research_runs
           SET status = 'cancelled',
               terminal_reason = ?,
               terminal_detail_public = ?,
               active_elapsed_ms = active_elapsed_ms + ?,
               active_started_at = NULL,
               lease_owner = NULL,
               lease_until = NULL,
               completed_at = ?,
               expires_at = ?,
               purge_after = ?,
               updated_at = ?
           WHERE run_id = ?
             AND status = 'running'
             AND lease_owner = ?
             AND lease_generation = ?
             AND lease_until > ?
             AND cancel_requested_at IS NOT NULL`
        )
        .run(
          terminalReason,
          terminalReason === "cancelled_by_user"
            ? "The Research run was cancelled by the user."
            : "The Research run was cancelled by an operator.",
          activeDeltaMs,
          now.toISOString(),
          new Date(now.getTime() + this.resultTtlMs).toISOString(),
          new Date(now.getTime() + this.runRetentionMs).toISOString(),
          now.toISOString(),
          input.token.runId,
          input.token.owner,
          input.token.generation,
          now.toISOString()
        );
      if (updated.changes !== 1) {
        return lostLeaseResult(this.db, input.token.runId);
      }
      insertRawAuditEvent(this.db, {
        occurredAt: now,
        requestId: current.cancelRequestId ?? undefined,
        actorType: "worker",
        subjectId: current.subjectId,
        runId: current.runId,
        action: "cancel_completed",
        outcome: "ok",
        params: {
          requested_by: current.cancelRequestedBy,
          lease_generation: input.token.generation
        }
      });
      const run = getRunById(this.db, input.token.runId);
      if (!run) {
        throw new Error("Research run was not readable after cancellation.");
      }
      return { outcome: "cancelled", run };
    });
  }

  writeCheckpoint(
    input: WriteResearchCheckpointInput
  ): WriteResearchCheckpointResult {
    const now = input.now ?? new Date();
    validateLeaseToken(input.token);
    positiveInteger(input.checkpointVersion, "checkpointVersion");
    if (
      !Number.isSafeInteger(input.progressPercent) ||
      input.progressPercent < 0 ||
      input.progressPercent > 100
    ) {
      throw new Error("progressPercent must be an integer from 0 to 100.");
    }
    const payloadJson = JSON.stringify(input.payload);
    if (payloadJson === undefined) {
      throw new Error("checkpoint payload must be JSON serializable.");
    }
    const payloadBytes = Buffer.from(payloadJson, "utf8");
    if (payloadBytes.length > this.maximumCheckpointBytes) {
      throw new Error("Research checkpoint exceeds maximumCheckpointBytes.");
    }
    const payloadSha256 = createHash("sha256")
      .update(payloadBytes)
      .digest("hex");
    if (input.payloadSha256 !== payloadSha256) {
      throw new Error("Research checkpoint payloadSha256 does not match payload.");
    }
    return inImmediateTransaction(this.db, () => {
      const fenced = this.db
        .prepare(
          `UPDATE research_runs
           SET stage = ?, progress_percent = ?, updated_at = ?
           WHERE run_id = ?
             AND status = 'running'
             AND lease_owner = ?
             AND lease_generation = ?
             AND lease_until > ?
             AND cancel_requested_at IS NULL`
        )
        .run(
          input.stage,
          input.progressPercent,
          now.toISOString(),
          input.token.runId,
          input.token.owner,
          input.token.generation,
          now.toISOString()
        );
      if (fenced.changes !== 1) {
        return { outcome: "fenced_or_cancelled" };
      }
      const inserted = this.db
        .prepare(
          `INSERT INTO research_checkpoints (
            run_id, stage, checkpoint_version, payload_json, payload_sha256,
            lease_generation, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(run_id, stage, checkpoint_version) DO UPDATE SET
            payload_json = excluded.payload_json,
            payload_sha256 = excluded.payload_sha256,
            lease_generation = excluded.lease_generation,
            created_at = excluded.created_at
          WHERE research_checkpoints.lease_generation <
            excluded.lease_generation`
        )
        .run(
          input.token.runId,
          input.stage,
          input.checkpointVersion,
          payloadJson,
          payloadSha256,
          input.token.generation,
          now.toISOString()
        );
      if (inserted.changes === 0) {
        const existing = this.db
          .prepare(
            `SELECT payload_sha256
             FROM research_checkpoints
             WHERE run_id = ?
               AND stage = ?
               AND checkpoint_version = ?`
          )
          .get(
            input.token.runId,
            input.stage,
            input.checkpointVersion
          ) as { payload_sha256: string } | undefined;
        if (existing?.payload_sha256 !== payloadSha256) {
          throw new Error(
            "Research checkpoint replay conflicts with committed checkpoint data."
          );
        }
      }
      return { outcome: "written" };
    });
  }

  completeSuccessfulRun(
    input: CompleteSuccessfulResearchRunInput
  ): CompleteSuccessfulResearchRunResult {
    const now = input.now ?? new Date();
    validateLeaseToken(input.token);
    validateCommitArtifacts(input.token.runId, input.artifacts);
    if (input.resultSchemaVersion !== "doctor_research_result.v1") {
      throw new Error("Unsupported Research result schema version.");
    }
    const validatedResult = validateDoctorResearchResultValue(input.result);
    if (!validatedResult.ok) {
      throw new Error(
        `Research result does not satisfy doctor_research_result.v1: ${validatedResult.errors.join(", ")}`
      );
    }
    if (validatedResult.value.run_id !== input.token.runId) {
      throw new Error("Research result run_id does not match the lease token.");
    }
    const resultJson = JSON.stringify(validatedResult.value);
    const resultBytes = Buffer.from(resultJson, "utf8");
    if (resultBytes.length > this.maximumResultBytes) {
      throw new Error("Research result exceeds maximumResultBytes.");
    }
    const resultSha256 = createHash("sha256")
      .update(resultBytes)
      .digest("hex");
    return inImmediateTransaction(this.db, () => {
      const current = getRunById(this.db, input.token.runId);
      const activeDeltaMs = current?.activeStartedAt
        ? Math.max(0, now.getTime() - current.activeStartedAt.getTime())
        : 0;
      const expiresAt = new Date(now.getTime() + this.resultTtlMs);
      const purgeAfter = new Date(now.getTime() + this.runRetentionMs);
      validateResultArtifactBinding(
        validatedResult.value,
        input.artifacts,
        expiresAt
      );
      const updated = this.db
        .prepare(
          `UPDATE research_runs
           SET status = 'succeeded',
               stage = 'complete',
               progress_percent = 100,
               canonical_identity_id = ?,
               warning_codes_json = ?,
               active_elapsed_ms = active_elapsed_ms + ?,
               active_started_at = NULL,
               lease_owner = NULL,
               lease_until = NULL,
               completed_at = ?,
               expires_at = ?,
               purge_after = ?,
               updated_at = ?
           WHERE run_id = ?
             AND status = 'running'
             AND lease_owner = ?
             AND lease_generation = ?
             AND lease_until > ?
             AND cancel_requested_at IS NULL`
        )
        .run(
          validatedResult.value.identity_resolution.canonical_identity_id,
          JSON.stringify([
            ...new Set([
              ...validatedResult.value.source_coverage.warnings,
              ...validatedResult.value.quality.warnings
            ])
          ]),
          activeDeltaMs,
          now.toISOString(),
          expiresAt.toISOString(),
          purgeAfter.toISOString(),
          now.toISOString(),
          input.token.runId,
          input.token.owner,
          input.token.generation,
          now.toISOString()
        );
      if (updated.changes !== 1) {
        return { outcome: "fenced_or_cancelled" };
      }
      const run = getRunById(this.db, input.token.runId);
      if (!run) {
        throw new Error("Research run disappeared during completion.");
      }
      const admission = this.db
        .prepare(
          `SELECT identity_fingerprint
           FROM research_doctor_admissions
           WHERE run_id = ? AND subject_id = ?`
        )
        .get(input.token.runId, run.subjectId) as
        | { identity_fingerprint: string }
        | undefined;
      if (!admission) {
        throw new Error("Research run admission disappeared during completion.");
      }
      const canonicalIdentityId =
        validatedResult.value.identity_resolution.canonical_identity_id;
      this.db
        .prepare(
          `INSERT INTO research_subject_identity_aliases (
             subject_id, identity_fingerprint, canonical_identity_id, verified_at
           ) VALUES (?, ?, ?, ?)
           ON CONFLICT(subject_id, identity_fingerprint) DO UPDATE SET
             canonical_identity_id = excluded.canonical_identity_id,
             verified_at = excluded.verified_at`
        )
        .run(
          run.subjectId,
          admission.identity_fingerprint,
          canonicalIdentityId,
          now.toISOString()
        );
      this.db
        .prepare(
          `UPDATE research_doctor_admissions
           SET canonical_identity_id = ?,
               doctor_key = ?,
               updated_at = ?
           WHERE subject_id = ?
             AND identity_fingerprint = ?`
        )
        .run(
          canonicalIdentityId,
          `dci:${canonicalIdentityId}`,
          now.toISOString(),
          run.subjectId,
          admission.identity_fingerprint
        );
      this.db
        .prepare(
          `INSERT INTO research_run_results (
            run_id, schema_version, result_json, result_sha256, size_bytes,
            created_at, expires_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          input.token.runId,
          input.resultSchemaVersion,
          resultJson,
          resultSha256,
          resultBytes.length,
          now.toISOString(),
          expiresAt.toISOString()
        );
      const insertSource = this.db.prepare(
        `INSERT INTO research_sources (
           source_id, run_id, source_type, url, title, content_sha256,
           trust_tier, accessed_at, metadata_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '{}')`
      );
      for (const source of validatedResult.value.sources) {
        insertSource.run(
          source.source_id,
          input.token.runId,
          source.source_type,
          source.url,
          source.title,
          source.content_sha256,
          source.source_type === "official_web" ||
            source.source_type === "orcid"
            ? "primary_public"
            : "first_party_metadata",
          source.accessed_at
        );
      }
      const insertClaim = this.db.prepare(
        `INSERT INTO research_claims (
           claim_id, run_id, claim_type, claim_text, source_ids_json,
           verification_status, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`
      );
      for (const claim of validatedResult.value.profile.claims) {
        insertClaim.run(
          claim.claim_id,
          input.token.runId,
          claim.claim_type,
          claim.text,
          JSON.stringify(claim.source_ids),
          claim.verification_status,
          now.toISOString()
        );
      }
      const studyTypes = new Map(
        validatedResult.value.review.core_evidence.map((evidence) => [
          evidence.reference_id,
          evidence.study_type
        ])
      );
      const insertReference = this.db.prepare(
        `INSERT INTO research_references (
           reference_id, run_id, pmid, doi, title, authors_json, journal,
           publication_year, study_type, verification_status, metadata_json
         ) VALUES (?, ?, ?, ?, ?, '[]', ?, ?, ?, ?, '{}')`
      );
      for (const reference of validatedResult.value.review.references) {
        insertReference.run(
          reference.reference_id,
          input.token.runId,
          reference.pmid,
          reference.doi,
          reference.title,
          reference.journal,
          reference.publication_year,
          studyTypes.get(reference.reference_id) ?? null,
          reference.verification_status
        );
      }
      const insertArtifact = this.db.prepare(
        `INSERT INTO research_artifacts (
          artifact_id, run_id, subject_id, kind, filename_ascii, filename_utf8,
          content_type, storage_path, storage_version, sha256, size_bytes,
          created_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const artifact of input.artifacts) {
        insertArtifact.run(
          artifact.artifactId,
          input.token.runId,
          run.subjectId,
          artifact.kind,
          artifact.filenameAscii,
          artifact.filenameUtf8,
          artifact.contentType,
          artifact.storageRelativePath,
          artifact.storageVersion,
          artifact.sha256,
          artifact.sizeBytes,
          now.toISOString(),
          expiresAt.toISOString()
        );
      }
      insertRawAuditEvent(this.db, {
        occurredAt: now,
        actorType: "worker",
        subjectId: run.subjectId,
        runId: run.runId,
        action: "run_succeeded",
        outcome: "ok",
        params: {
          lease_generation: input.token.generation,
          artifact_count: input.artifacts.length,
          result_sha256: resultSha256
        }
      });
      return { outcome: "succeeded", run };
    });
  }

  pauseForIdentity(
    input: PauseResearchForIdentityInput
  ): PauseResearchForIdentityResult {
    const now = input.now ?? new Date();
    validateLeaseToken(input.token);
    validateIdentityCandidates(input.candidates);
    return inImmediateTransaction(this.db, () => {
      const current = getRunById(this.db, input.token.runId);
      const activeDeltaMs = current?.activeStartedAt
        ? Math.max(0, now.getTime() - current.activeStartedAt.getTime())
        : 0;
      const needsInputExpiresAt = new Date(
        now.getTime() + this.needsInputTtlMs
      );
      const updated = this.db
        .prepare(
          `UPDATE research_runs
           SET status = 'needs_input',
               stage = 'resolve_identity',
               progress_percent = ?,
               active_elapsed_ms = active_elapsed_ms + ?,
               active_started_at = NULL,
               lease_owner = NULL,
               lease_until = NULL,
               needs_input_started_at = ?,
               needs_input_expires_at = ?,
               updated_at = ?
           WHERE run_id = ?
             AND status = 'running'
             AND lease_owner = ?
             AND lease_generation = ?
             AND lease_until > ?
             AND cancel_requested_at IS NULL`
        )
        .run(
          13,
          activeDeltaMs,
          now.toISOString(),
          needsInputExpiresAt.toISOString(),
          now.toISOString(),
          input.token.runId,
          input.token.owner,
          input.token.generation,
          now.toISOString()
        );
      if (updated.changes !== 1) {
        return { outcome: "fenced_or_cancelled" };
      }
      const insertCandidate = this.db.prepare(
        `INSERT INTO research_identity_candidates (
          candidate_id, run_id, candidate_json, evidence_json, score, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)`
      );
      for (const candidate of input.candidates) {
        insertCandidate.run(
          candidate.candidateId,
          input.token.runId,
          JSON.stringify(candidate),
          JSON.stringify(candidate.evidenceTypes),
          candidate.score,
          now.toISOString()
        );
      }
      const run = getRunById(this.db, input.token.runId);
      if (!run) {
        throw new Error("Research run disappeared while awaiting identity.");
      }
      insertRawAuditEvent(this.db, {
        occurredAt: now,
        actorType: "worker",
        subjectId: run.subjectId,
        runId: run.runId,
        action: "identity_required",
        outcome: "ok",
        params: {
          candidate_count: input.candidates.length,
          lease_generation: input.token.generation
        }
      });
      return { outcome: "needs_input", run };
    });
  }

  failRun(input: FailResearchRunInput): FailResearchRunResult {
    const now = input.now ?? new Date();
    validateLeaseToken(input.token);
    const publicDetail = failurePublicDetail(input.terminalReason);
    return inImmediateTransaction(this.db, () => {
      const current = getRunById(this.db, input.token.runId);
      const activeDeltaMs = current?.activeStartedAt
        ? Math.max(0, now.getTime() - current.activeStartedAt.getTime())
        : 0;
      const expiresAt = new Date(now.getTime() + this.resultTtlMs);
      const purgeAfter = new Date(now.getTime() + this.runRetentionMs);
      const updated = this.db
        .prepare(
          `UPDATE research_runs
           SET status = 'failed',
               terminal_reason = ?,
               terminal_detail_public = ?,
               active_elapsed_ms = active_elapsed_ms + ?,
               active_started_at = NULL,
               lease_owner = NULL,
               lease_until = NULL,
               completed_at = ?,
               expires_at = ?,
               purge_after = ?,
               updated_at = ?
           WHERE run_id = ?
             AND status = 'running'
             AND lease_owner = ?
             AND lease_generation = ?
             AND lease_until > ?
             AND cancel_requested_at IS NULL`
        )
        .run(
          input.terminalReason,
          publicDetail,
          activeDeltaMs,
          now.toISOString(),
          expiresAt.toISOString(),
          purgeAfter.toISOString(),
          now.toISOString(),
          input.token.runId,
          input.token.owner,
          input.token.generation,
          now.toISOString()
        );
      if (updated.changes !== 1) {
        return { outcome: "fenced_or_cancelled" };
      }
      const run = getRunById(this.db, input.token.runId);
      if (!run) {
        throw new Error("Research run disappeared during failure.");
      }
      insertRawAuditEvent(this.db, {
        occurredAt: now,
        actorType: "worker",
        subjectId: run.subjectId,
        runId: run.runId,
        action: "run_failed",
        outcome: "ok",
        params: {
          terminal_reason: input.terminalReason,
          lease_generation: input.token.generation
        }
      });
      return { outcome: "failed", run };
    });
  }

  requeueRun(input: RequeueResearchRunInput): RequeueResearchRunResult {
    const now = input.now ?? new Date();
    validateLeaseToken(input.token);
    return inImmediateTransaction(this.db, () => {
      const current = getRunById(this.db, input.token.runId);
      const activeDeltaMs = current?.activeStartedAt
        ? Math.max(0, now.getTime() - current.activeStartedAt.getTime())
        : 0;
      const updated = this.db
        .prepare(
          `UPDATE research_runs
           SET status = 'queued',
               active_elapsed_ms = active_elapsed_ms + ?,
               active_started_at = NULL,
               lease_owner = NULL,
               lease_until = NULL,
               queued_at = ?,
               updated_at = ?
           WHERE run_id = ?
             AND status = 'running'
             AND lease_owner = ?
             AND lease_generation = ?
             AND lease_until > ?
             AND cancel_requested_at IS NULL`
        )
        .run(
          activeDeltaMs,
          now.toISOString(),
          now.toISOString(),
          input.token.runId,
          input.token.owner,
          input.token.generation,
          now.toISOString()
        );
      if (updated.changes !== 1) {
        return { outcome: "fenced_or_cancelled" };
      }
      const run = getRunById(this.db, input.token.runId);
      if (!run) {
        throw new Error("Research run disappeared while requeueing.");
      }
      insertRawAuditEvent(this.db, {
        occurredAt: now,
        actorType: "worker",
        subjectId: run.subjectId,
        runId: run.runId,
        action: "run_requeued",
        outcome: "ok",
        params: {
          reason: input.reason,
          lease_generation: input.token.generation
        }
      });
      return { outcome: "queued", run };
    });
  }

  reconcileTtl(
    input: ReconcileResearchTtlInput = {}
  ): ReconcileResearchTtlResult {
    const now = input.now ?? new Date();
    const batchSize = input.batchSize ?? 100;
    if (!Number.isSafeInteger(batchSize) || batchSize <= 0 || batchSize > 100) {
      throw new Error("batchSize must be an integer from 1 to 100.");
    }
    return inImmediateTransaction(this.db, () => {
      let needsInputCancelled = 0;
      let terminalExpired = 0;
      const needsInputRows = this.db
        .prepare(
          `SELECT run_id, subject_id
           FROM research_runs
           WHERE status = 'needs_input'
             AND needs_input_expires_at IS NOT NULL
             AND needs_input_expires_at <= ?
           ORDER BY needs_input_expires_at ASC, run_id ASC
           LIMIT ?`
        )
        .all(now.toISOString(), batchSize) as Array<{
        run_id: string;
        subject_id: string;
      }>;
      for (const row of needsInputRows) {
        if (
          transitionExpiredNeedsInputRun(this.db, {
            runId: row.run_id,
            subjectId: row.subject_id,
            now,
            resultTtlMs: this.resultTtlMs,
            runRetentionMs: this.runRetentionMs
          })
        ) {
          needsInputCancelled += 1;
        }
      }

      const remaining = batchSize - needsInputCancelled;
      if (remaining > 0) {
        const terminalRows = this.db
          .prepare(
            `SELECT run_id, subject_id
             FROM research_runs
             WHERE status IN ('succeeded', 'failed', 'cancelled')
               AND expires_at IS NOT NULL
               AND expires_at <= ?
             ORDER BY expires_at ASC, run_id ASC
             LIMIT ?`
          )
          .all(now.toISOString(), remaining) as Array<{
          run_id: string;
          subject_id: string;
        }>;
        for (const row of terminalRows) {
          const changed = this.db
            .prepare(
              `UPDATE research_runs
               SET status = 'expired', updated_at = ?
               WHERE run_id = ?
                 AND status IN ('succeeded', 'failed', 'cancelled')
                 AND expires_at IS NOT NULL
                 AND expires_at <= ?`
            )
            .run(now.toISOString(), row.run_id, now.toISOString());
          if (changed.changes === 1) {
            terminalExpired += 1;
            insertRawAuditEvent(this.db, {
              occurredAt: now,
              actorType: "system",
              subjectId: row.subject_id,
              runId: row.run_id,
              action: "ttl_terminal_expired",
              outcome: "ok",
              params: {}
            });
          }
        }
      }
      return { needsInputCancelled, terminalExpired };
    });
  }

  recordWorkerHeartbeat(
    input: RecordResearchWorkerHeartbeatInput
  ): RecordResearchWorkerHeartbeatResult {
    requireNonEmpty(input.workerId, "workerId");
    requireNonEmpty(input.processInstanceId, "processInstanceId");
    requireNonEmpty(input.version, "version");
    const now = input.now ?? new Date();
    if (input.startedAt.getTime() > now.getTime()) {
      throw new Error(
        "Research Worker startedAt must not be later than the heartbeat."
      );
    }
    const changed = this.db
      .prepare(
        `INSERT INTO research_worker_heartbeats (
          worker_id, process_instance_id, version, state, started_at, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(worker_id) DO UPDATE SET
          process_instance_id = excluded.process_instance_id,
          version = excluded.version,
          state = excluded.state,
          started_at = excluded.started_at,
          last_seen_at = excluded.last_seen_at
        WHERE research_worker_heartbeats.process_instance_id =
                excluded.process_instance_id
           OR research_worker_heartbeats.started_at < excluded.started_at`
      )
      .run(
        input.workerId,
        input.processInstanceId,
        input.version,
        input.state,
        input.startedAt.toISOString(),
        now.toISOString()
      );
    return changed.changes === 1
      ? { outcome: "recorded" }
      : { outcome: "stale_process_ignored" };
  }

  listWorkerHeartbeats(
    input: ListResearchWorkerHeartbeatsInput
  ): ResearchWorkerHeartbeat[] {
    const staleAfterMs =
      secondsToMs(input.staleAfterSeconds, "staleAfterSeconds");
    const now = input.now ?? new Date();
    const rows = this.db
      .prepare(
        `SELECT worker_id, process_instance_id, version, state,
                started_at, last_seen_at
         FROM research_worker_heartbeats
         ORDER BY worker_id ASC`
      )
      .all() as Array<{
      worker_id: string;
      process_instance_id: string;
      version: string;
      state: ResearchWorkerHeartbeat["state"];
      started_at: string;
      last_seen_at: string;
    }>;
    return rows.map((row) => {
      const startedAt = requiredDate(row.started_at, "worker.started_at");
      const lastSeenAt = requiredDate(row.last_seen_at, "worker.last_seen_at");
      const ageMs = Math.max(0, now.getTime() - lastSeenAt.getTime());
      return {
        workerId: row.worker_id,
        processInstanceId: row.process_instance_id,
        version: row.version,
        state: row.state,
        startedAt,
        lastSeenAt,
        ageSeconds: ageMs / 1000,
        available:
          row.state === "ready" &&
          lastSeenAt.getTime() >= startedAt.getTime() &&
          lastSeenAt.getTime() <= now.getTime() &&
          ageMs <= staleAfterMs
      };
    });
  }

  maintainIdempotency(
    input: MaintainResearchIdempotencyInput = {}
  ): MaintainResearchIdempotencyResult {
    const now = input.now ?? new Date();
    const batchSize = input.batchSize ?? 100;
    if (!Number.isSafeInteger(batchSize) || batchSize <= 0 || batchSize > 100) {
      throw new Error("batchSize must be an integer from 1 to 100.");
    }
    return inImmediateTransaction(this.db, () => {
      const deleted = Number(
        this.db
          .prepare(
            `DELETE FROM research_idempotency_keys
           WHERE rowid IN (
             SELECT rowid
             FROM research_idempotency_keys
             WHERE tombstone_expires_at <= ?
             ORDER BY tombstone_expires_at ASC
             LIMIT ?
           )`
          )
          .run(now.toISOString(), batchSize).changes
      );
      const remaining = batchSize - deleted;
      const scrubbed =
        remaining > 0
          ? Number(
              this.db
                .prepare(
                  `UPDATE research_idempotency_keys
                 SET response_status = NULL, response_body_json = NULL
                 WHERE rowid IN (
                   SELECT rowid
                   FROM research_idempotency_keys
                   WHERE replay_expires_at <= ?
                     AND tombstone_expires_at > ?
                     AND (
                       response_status IS NOT NULL
                       OR response_body_json IS NOT NULL
                     )
                   ORDER BY replay_expires_at ASC
                   LIMIT ?
                 )`
                )
                .run(now.toISOString(), now.toISOString(), remaining).changes
            )
          : 0;
      if (deleted > 0 || scrubbed > 0) {
        insertRawAuditEvent(this.db, {
          occurredAt: now,
          actorType: "system",
          action: "idempotency_maintenance",
          outcome: "ok",
          params: {
            replay_bodies_scrubbed: scrubbed,
            tombstones_deleted: deleted
          }
        });
      }
      return {
        replayBodiesScrubbed: scrubbed,
        tombstonesDeleted: deleted
      };
    });
  }

  cleanupExpiredData(
    input: CleanupResearchDataInput = {}
  ): CleanupResearchDataResult {
    const now = input.now ?? new Date();
    const batchSize = input.batchSize ?? 100;
    if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 100) {
      throw new Error("batchSize must be an integer from 1 to 100.");
    }
    const auditCutoff = new Date(now.getTime() - 90 * dayMs).toISOString();
    const heartbeatCutoff = new Date(now.getTime() - 7 * dayMs).toISOString();
    return inImmediateTransaction(this.db, () => {
      let auditEventsDeleted = Number(
        this.db
          .prepare(
            `DELETE FROM research_audit_events
             WHERE event_id IN (
               SELECT event_id
               FROM research_audit_events
               WHERE occurred_at <= ?
               ORDER BY occurred_at ASC
               LIMIT ?
             )`
          )
          .run(auditCutoff, batchSize).changes
      );

      const candidates = this.db
        .prepare(
          `SELECT run_id
           FROM research_runs
           WHERE status = 'expired'
             AND purge_after IS NOT NULL
             AND purge_after <= ?
             AND NOT EXISTS (
               SELECT 1
               FROM research_audit_events
               WHERE research_audit_events.run_id = research_runs.run_id
                 AND occurred_at > ?
             )
           ORDER BY purge_after ASC, run_id ASC
           LIMIT ?`
        )
        .all(now.toISOString(), auditCutoff, batchSize) as Array<{
        run_id: string;
      }>;
      const runIds = candidates.map((candidate) => candidate.run_id);
      const artifactStorageRelativePaths: string[] = [];
      let admissionsDeleted = 0;
      if (runIds.length > 0) {
        const placeholders = runIds.map(() => "?").join(", ");
        const artifacts = this.db
          .prepare(
            `SELECT storage_path
             FROM research_artifacts
             WHERE run_id IN (${placeholders})`
          )
          .all(...runIds) as Array<{ storage_path: string }>;
        artifactStorageRelativePaths.push(
          ...artifacts.map((artifact) => artifact.storage_path)
        );
        auditEventsDeleted += Number(
          this.db
            .prepare(
              `DELETE FROM research_audit_events
               WHERE run_id IN (${placeholders})`
            )
            .run(...runIds).changes
        );
        for (const table of [
          "research_idempotency_keys",
          "research_stage_runs",
          "research_checkpoints",
          "research_identity_candidates",
          "research_sources",
          "research_claims",
          "research_references",
          "research_run_results",
          "research_artifacts",
          "research_run_budgets"
        ]) {
          this.db
            .prepare(`DELETE FROM ${table} WHERE run_id IN (${placeholders})`)
            .run(...runIds);
        }
        admissionsDeleted = Number(
          this.db
            .prepare(
              `DELETE FROM research_doctor_admissions
               WHERE run_id IN (${placeholders})`
            )
            .run(...runIds).changes
        );
        this.db
          .prepare(`DELETE FROM research_runs WHERE run_id IN (${placeholders})`)
          .run(...runIds);
      }

      const identityAliasesDeleted = Number(
        this.db
          .prepare(
            `DELETE FROM research_subject_identity_aliases
             WHERE verified_at <= ?
               AND NOT EXISTS (
                 SELECT 1
                 FROM research_doctor_admissions
                 WHERE research_doctor_admissions.subject_id =
                         research_subject_identity_aliases.subject_id
                   AND research_doctor_admissions.identity_fingerprint =
                         research_subject_identity_aliases.identity_fingerprint
               )`
          )
          .run(auditCutoff).changes
      );
      const workerHeartbeatsDeleted = Number(
        this.db
          .prepare(
            `DELETE FROM research_worker_heartbeats
             WHERE last_seen_at <= ?`
          )
          .run(heartbeatCutoff).changes
      );
      return {
        runsDeleted: runIds.length,
        auditEventsDeleted,
        admissionsDeleted,
        identityAliasesDeleted,
        workerHeartbeatsDeleted,
        artifactStorageRelativePaths
      };
    });
  }

  chargeRunBudget(
    input: ChargeResearchRunBudgetInput
  ): ChargeResearchRunBudgetResult {
    const now = input.now ?? new Date();
    validateLeaseToken(input.token);
    validateBudgetValues(input.charge, "charge", true);
    validateBudgetValues(input.limits, "limits", false);
    return inImmediateTransaction(this.db, () => {
      const run = getRunById(this.db, input.token.runId);
      if (
        !run ||
        run.status !== "running" ||
        run.leaseOwner !== input.token.owner ||
        run.leaseGeneration !== input.token.generation ||
        !run.leaseUntil ||
        run.leaseUntil.getTime() <= now.getTime() ||
        run.cancelRequestedAt
      ) {
        return { outcome: "fenced_or_cancelled" };
      }
      const current = this.db
        .prepare(
          `SELECT external_requests, external_response_bytes, llm_calls,
                  input_tokens, output_tokens
           FROM research_run_budgets
           WHERE run_id = ?`
        )
        .get(input.token.runId) as
        | {
            external_requests: number;
            external_response_bytes: number;
            llm_calls: number;
            input_tokens: number;
            output_tokens: number;
          }
        | undefined;
      const currentTotals = {
        externalRequests: current?.external_requests ?? 0,
        externalResponseBytes: current?.external_response_bytes ?? 0,
        llmCalls: current?.llm_calls ?? 0,
        inputTokens: current?.input_tokens ?? 0,
        outputTokens: current?.output_tokens ?? 0
      };
      validateBudgetValues(currentTotals, "stored", true);
      const exceeded: Array<
        [
          keyof typeof currentTotals,
          Extract<
            ChargeResearchRunBudgetResult,
            { outcome: "budget_exceeded" }
          >["limit"]
        ]
      > = [
        ["externalRequests", "external_requests"],
        ["externalResponseBytes", "external_response_bytes"],
        ["llmCalls", "llm_calls"],
        ["inputTokens", "input_tokens"],
        ["outputTokens", "output_tokens"]
      ];
      for (const [key, publicLimit] of exceeded) {
        if (
          currentTotals[key] > input.limits[key] ||
          input.charge[key] > input.limits[key] - currentTotals[key]
        ) {
          return { outcome: "budget_exceeded", limit: publicLimit };
        }
      }
      const totals = {
        externalRequests:
          currentTotals.externalRequests + input.charge.externalRequests,
        externalResponseBytes:
          currentTotals.externalResponseBytes +
          input.charge.externalResponseBytes,
        llmCalls: currentTotals.llmCalls + input.charge.llmCalls,
        inputTokens:
          currentTotals.inputTokens + input.charge.inputTokens,
        outputTokens:
          currentTotals.outputTokens + input.charge.outputTokens
      };
      this.db
        .prepare(
          `INSERT INTO research_run_budgets (
             run_id, external_requests, external_response_bytes, llm_calls,
             input_tokens, output_tokens, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(run_id) DO UPDATE SET
             external_requests = excluded.external_requests,
             external_response_bytes = excluded.external_response_bytes,
             llm_calls = excluded.llm_calls,
             input_tokens = excluded.input_tokens,
             output_tokens = excluded.output_tokens,
             updated_at = excluded.updated_at`
        )
        .run(
          input.token.runId,
          totals.externalRequests,
          totals.externalResponseBytes,
          totals.llmCalls,
          totals.inputTokens,
          totals.outputTokens,
          now.toISOString()
        );
      return { outcome: "charged", totals };
    });
  }

  startStageRun(
    input: StartResearchStageRunInput
  ): WriteResearchStageRunResult {
    const now = input.now ?? new Date();
    validateLeaseToken(input.token);
    validateResearchStage(input.stage);
    boundedStageAttempt(input.attempt);
    validateSha256(input.inputSha256, "inputSha256");
    return inImmediateTransaction(this.db, () => {
      if (!leaseAllowsWorkerWrite(this.db, input.token, now)) {
        return { outcome: "fenced_or_cancelled" };
      }
      const inserted = this.db
        .prepare(
          `INSERT INTO research_stage_runs (
             run_id, stage, attempt, lease_generation, input_sha256, started_at
           ) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(run_id, stage, attempt, lease_generation) DO NOTHING`
        )
        .run(
          input.token.runId,
          input.stage,
          input.attempt,
          input.token.generation,
          input.inputSha256,
          now.toISOString()
        );
      if (inserted.changes === 0) {
        const existing = this.db
          .prepare(
            `SELECT input_sha256
             FROM research_stage_runs
             WHERE run_id = ?
               AND stage = ?
               AND attempt = ?
               AND lease_generation = ?`
          )
          .get(
            input.token.runId,
            input.stage,
            input.attempt,
            input.token.generation
          ) as { input_sha256: string | null } | undefined;
        if (existing?.input_sha256 !== input.inputSha256) {
          throw new Error(
            "Research stage-run replay conflicts with its committed input hash."
          );
        }
      }
      return { outcome: "written" };
    });
  }

  completeStageRun(
    input: CompleteResearchStageRunInput
  ): WriteResearchStageRunResult {
    const now = input.now ?? new Date();
    validateLeaseToken(input.token);
    validateResearchStage(input.stage);
    boundedStageAttempt(input.attempt);
    if (input.outputSha256 !== null) {
      validateSha256(input.outputSha256, "outputSha256");
    }
    nonNegativeSafeInteger(input.durationMs, "durationMs");
    nullableTokenCount(input.promptTokens, "promptTokens");
    nullableTokenCount(input.completionTokens, "completionTokens");
    nullableNonNegativeSafeInteger(input.promptChars, "promptChars");
    nullablePositiveSafeInteger(input.maximumOutputTokens, "maximumOutputTokens");
    nullableNonNegativeSafeInteger(input.admissionWaitMs, "admissionWaitMs");
    nullableNonNegativeSafeInteger(input.clientTotalMs, "clientTotalMs");
    if (
      input.requestSentAt !== undefined &&
      input.requestSentAt !== null &&
      (!(input.requestSentAt instanceof Date) || !Number.isFinite(input.requestSentAt.getTime()))
    ) {
      throw new Error("requestSentAt is invalid.");
    }
    nullableBoundedSingleLine(input.terminalSource ?? null, "terminalSource", 64);
    if (
      (input.cancelRequested !== undefined &&
        input.cancelRequested !== null &&
        typeof input.cancelRequested !== "boolean") ||
      (input.cancelObserved !== undefined &&
        input.cancelObserved !== null &&
        typeof input.cancelObserved !== "boolean")
    ) {
      throw new Error("Research stage cancellation telemetry is invalid.");
    }
    nullableBoundedSingleLine(
      input.gatewayRequestId,
      "gatewayRequestId",
      200
    );
    if (
      input.errorCode !== null &&
      !/^[a-z][a-z0-9_]{0,99}$/u.test(input.errorCode)
    ) {
      throw new Error("errorCode is invalid.");
    }
    if ((input.outputSha256 === null) === (input.errorCode === null)) {
      throw new Error(
        "A Research stage run must complete with either an output hash or an error code."
      );
    }
    return inImmediateTransaction(this.db, () => {
      if (!leaseAllowsWorkerWrite(this.db, input.token, now)) {
        return { outcome: "fenced_or_cancelled" };
      }
      const completed = this.db
        .prepare(
          `UPDATE research_stage_runs
           SET output_sha256 = ?,
               duration_ms = ?,
               prompt_tokens = ?,
               completion_tokens = ?,
               gateway_request_id = ?,
               error_code = ?,
               error_detail_sanitized = NULL,
               prompt_chars = ?,
               maximum_output_tokens = ?,
               admission_wait_ms = ?,
               request_sent_at = ?,
               client_total_ms = ?,
               terminal_source = ?,
               cancel_requested = ?,
               cancel_observed = ?,
               completed_at = ?
           WHERE run_id = ?
             AND stage = ?
             AND attempt = ?
             AND lease_generation = ?
             AND completed_at IS NULL`
        )
        .run(
          input.outputSha256,
          input.durationMs,
          input.promptTokens,
          input.completionTokens,
          input.gatewayRequestId,
          input.errorCode,
          input.promptChars ?? null,
          input.maximumOutputTokens ?? null,
          input.admissionWaitMs ?? null,
          input.requestSentAt?.toISOString() ?? null,
          input.clientTotalMs ?? null,
          input.terminalSource ?? null,
          input.cancelRequested === undefined || input.cancelRequested === null
            ? null
            : input.cancelRequested
              ? 1
              : 0,
          input.cancelObserved === undefined || input.cancelObserved === null
            ? null
            : input.cancelObserved
              ? 1
              : 0,
          now.toISOString(),
          input.token.runId,
          input.stage,
          input.attempt,
          input.token.generation
        );
      if (completed.changes !== 1) {
        throw new Error(
          "Research stage run was missing or had already completed."
        );
      }
      return { outcome: "written" };
    });
  }

  listCommittedArtifactStoragePaths(): string[] {
    return (
      this.db
        .prepare(
          `SELECT storage_path
           FROM research_artifacts
           ORDER BY storage_path ASC`
        )
        .all() as Array<{ storage_path: string }>
    ).map((row) => row.storage_path);
  }

  recordBackupStarted(input: RecordResearchBackupStartedInput): void {
    validateBackupId(input.backupId);
    requireNonEmpty(input.schemaVersion, "schemaVersion");
    const now = input.now ?? new Date();
    this.db
      .prepare(
        `INSERT INTO research_backup_runs (
           backup_id, schema_version, state, started_at
         ) VALUES (?, ?, 'running', ?)`
      )
      .run(input.backupId, input.schemaVersion, now.toISOString());
  }

  recordBackupCompleted(input: RecordResearchBackupCompletedInput): void {
    validateBackupId(input.backupId);
    const now = input.now ?? new Date();
    if (
      input.outcome === "succeeded" &&
      !/^[a-f0-9]{64}$/.test(input.manifestSha256 ?? "")
    ) {
      throw new Error("A successful Research backup requires a manifest hash.");
    }
    if (
      input.errorCode !== undefined &&
      !/^[a-z][a-z0-9_]{2,63}$/.test(input.errorCode)
    ) {
      throw new Error("Research backup errorCode is invalid.");
    }
    const updated = this.db
      .prepare(
        `UPDATE research_backup_runs
         SET state = ?,
             completed_at = ?,
             manifest_sha256 = ?,
             error_code = ?
         WHERE backup_id = ?
           AND state = 'running'`
      )
      .run(
        input.outcome,
        now.toISOString(),
        input.outcome === "succeeded" ? input.manifestSha256 ?? null : null,
        input.outcome === "failed"
          ? input.errorCode ?? "backup_failed"
          : null,
        input.backupId
      );
    if (updated.changes !== 1) {
      throw new Error("Research backup completion invariant violation.");
    }
  }

  latestSuccessfulBackupAt(): Date | null {
    const row = this.db
      .prepare(
        `SELECT completed_at
         FROM research_backup_runs
         WHERE state = 'succeeded'
           AND completed_at IS NOT NULL
         ORDER BY completed_at DESC
         LIMIT 1`
      )
      .get() as { completed_at: string } | undefined;
    return row ? requiredDate(row.completed_at, "completed_at") : null;
  }

  acquireMaintenanceLock(
    input: AcquireResearchMaintenanceLockInput
  ): boolean {
    validateMaintenanceLockIdentity(input.name, input.owner);
    const now = input.now ?? new Date();
    const leaseUntil = new Date(
      now.getTime() +
        secondsToMs(input.leaseSeconds, "maintenanceLock.leaseSeconds")
    );
    const changed = this.db
      .prepare(
        `INSERT INTO research_maintenance_locks (
           lock_name, owner, lease_until, updated_at
         ) VALUES (?, ?, ?, ?)
         ON CONFLICT(lock_name) DO UPDATE SET
           owner = excluded.owner,
           lease_until = excluded.lease_until,
           updated_at = excluded.updated_at
         WHERE research_maintenance_locks.lease_until <= excluded.updated_at
            OR research_maintenance_locks.owner = excluded.owner`
      )
      .run(
        input.name,
        input.owner,
        leaseUntil.toISOString(),
        now.toISOString()
      );
    return changed.changes === 1;
  }

  renewMaintenanceLock(
    input: RenewResearchMaintenanceLockInput
  ): boolean {
    validateMaintenanceLockIdentity(input.name, input.owner);
    const now = input.now ?? new Date();
    const leaseUntil = new Date(
      now.getTime() +
        secondsToMs(input.leaseSeconds, "maintenanceLock.leaseSeconds")
    );
    const changed = this.db
      .prepare(
        `UPDATE research_maintenance_locks
         SET lease_until = ?, updated_at = ?
         WHERE lock_name = ?
           AND owner = ?
           AND lease_until > ?`
      )
      .run(
        leaseUntil.toISOString(),
        now.toISOString(),
        input.name,
        input.owner,
        now.toISOString()
      );
    return changed.changes === 1;
  }

  releaseMaintenanceLock(
    input: ReleaseResearchMaintenanceLockInput
  ): void {
    validateMaintenanceLockIdentity(input.name, input.owner);
    this.db
      .prepare(
        `DELETE FROM research_maintenance_locks
         WHERE lock_name = ? AND owner = ?`
      )
      .run(input.name, input.owner);
  }

  close(): void {
    this.db.close();
  }
}

function admissionRejected(
  db: DatabaseSync,
  input: CreateResearchRunInput,
  limitKind: Extract<
    CreateResearchRunResult,
    { outcome: "rate_limited" }
  >["limitKind"],
  now: Date
): CreateResearchRunResult {
  const minuteStart = new Date(
    Math.floor(now.getTime() / 60_000) * 60_000
  ).toISOString();
  const alreadyAudited = db
    .prepare(
      `SELECT 1
       FROM research_audit_events
       WHERE subject_id = ?
         AND action = 'admission_quota'
         AND outcome = 'rejected'
         AND occurred_at >= ?
         AND json_extract(params_json, '$.limit_kind') = ?
       LIMIT 1`
    )
    .get(input.subjectId, minuteStart, limitKind);
  if (!alreadyAudited) {
    insertAuditEvent(db, {
      input,
      action: "admission_quota",
      outcome: "rejected",
      now,
      params: {
        limit_kind: limitKind,
        mode: input.input.mode,
        identity_fingerprint: input.identityFingerprint
      }
    });
  }
  return { outcome: "rate_limited", limitKind };
}

function insertAuditEvent(
  db: DatabaseSync,
  event: {
    input: CreateResearchRunInput;
    action: string;
    outcome: string;
    runId?: string;
    now: Date;
    params?: Record<string, unknown>;
  }
): void {
  insertRawAuditEvent(db, {
    occurredAt: event.now,
    requestId: event.input.requestId,
    actorType: "subject",
    subjectId: event.input.subjectId,
    credentialId: event.input.credentialId,
    runId: event.runId,
    action: event.action,
    outcome: event.outcome,
    params: event.params
  });
}

function insertRawAuditEvent(
  db: DatabaseSync,
  event: {
    occurredAt: Date;
    requestId?: string;
    actorType: "subject" | "worker" | "operator" | "system";
    subjectId?: string;
    credentialId?: string | null;
    operatorId?: string;
    runId?: string;
    action: string;
    outcome: string;
    params?: Record<string, unknown>;
  }
): void {
  db.prepare(
    `INSERT INTO research_audit_events (
      event_id, occurred_at, request_id, actor_type, subject_id,
      credential_id, operator_id, run_id, action, outcome, params_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    `drae_${randomUUID().replaceAll("-", "")}`,
    event.occurredAt.toISOString(),
    event.requestId ?? null,
    event.actorType,
    event.subjectId ?? null,
    event.credentialId ?? null,
    event.operatorId ?? null,
    event.runId ?? null,
    event.action,
    event.outcome,
    JSON.stringify(event.params ?? {})
  );
}

function transitionExpiredNeedsInputRun(
  db: DatabaseSync,
  input: {
    runId: string;
    subjectId: string;
    requestId?: string;
    now: Date;
    resultTtlMs: number;
    runRetentionMs: number;
  }
): boolean {
  const timestamp = input.now.toISOString();
  const changed = db
    .prepare(
      `UPDATE research_runs
       SET status = 'cancelled',
           terminal_reason = 'identity_selection_timeout',
           terminal_detail_public = 'Identity selection timed out.',
           completed_at = ?,
           expires_at = ?,
           purge_after = ?,
           updated_at = ?
       WHERE run_id = ?
         AND subject_id = ?
         AND status = 'needs_input'
         AND needs_input_expires_at IS NOT NULL
         AND needs_input_expires_at <= ?`
    )
    .run(
      timestamp,
      new Date(input.now.getTime() + input.resultTtlMs).toISOString(),
      new Date(input.now.getTime() + input.runRetentionMs).toISOString(),
      timestamp,
      input.runId,
      input.subjectId,
      timestamp
    );
  if (changed.changes !== 1) {
    return false;
  }
  insertRawAuditEvent(db, {
    occurredAt: input.now,
    ...(input.requestId ? { requestId: input.requestId } : {}),
    actorType: "system",
    subjectId: input.subjectId,
    runId: input.runId,
    action: "ttl_needs_input_timeout",
    outcome: "ok",
    params: {}
  });
  return true;
}

interface ResearchIdempotencyRow {
  request_hash: string;
  run_id: string;
  response_status: number | null;
  response_body_json: string | null;
  replay_expires_at: string;
  tombstone_expires_at: string;
}

type ResearchIdempotencyResolution =
  | { outcome: "proceed" }
  | { outcome: "conflict"; runId: string }
  | { outcome: "replay"; runId: string; responseBodyJson: string }
  | { outcome: "expired"; runId: string };

function resolveIdempotency(
  db: DatabaseSync,
  input: {
    subjectId: string;
    credentialId: string | null;
    requestId: string;
    endpoint: string;
    idempotencyKey: string;
    requestHash: string;
    expectedResponseStatus: number;
    now: Date;
  }
): ResearchIdempotencyResolution {
  const row = db
    .prepare(
      `SELECT request_hash, run_id, response_status, response_body_json,
              replay_expires_at, tombstone_expires_at
       FROM research_idempotency_keys
       WHERE subject_id = ?
         AND endpoint = ?
         AND idempotency_key = ?`
    )
    .get(input.subjectId, input.endpoint, input.idempotencyKey) as
    | ResearchIdempotencyRow
    | undefined;
  if (!row) {
    return { outcome: "proceed" };
  }
  if (new Date(row.tombstone_expires_at).getTime() <= input.now.getTime()) {
    db.prepare(
      `DELETE FROM research_idempotency_keys
       WHERE subject_id = ? AND endpoint = ? AND idempotency_key = ?`
    ).run(input.subjectId, input.endpoint, input.idempotencyKey);
    return { outcome: "proceed" };
  }

  let resolution: Exclude<ResearchIdempotencyResolution, { outcome: "proceed" }>;
  if (row.request_hash !== input.requestHash) {
    resolution = { outcome: "conflict", runId: row.run_id };
  } else if (
    new Date(row.replay_expires_at).getTime() > input.now.getTime() &&
    row.response_status === input.expectedResponseStatus &&
    row.response_body_json
  ) {
    resolution = {
      outcome: "replay",
      runId: row.run_id,
      responseBodyJson: row.response_body_json
    };
  } else {
    resolution = { outcome: "expired", runId: row.run_id };
  }

  insertRawAuditEvent(db, {
    occurredAt: input.now,
    requestId: input.requestId,
    actorType: "subject",
    subjectId: input.subjectId,
    credentialId: input.credentialId,
    runId: row.run_id,
    action: `idempotency_${resolution.outcome}`,
    outcome: resolution.outcome === "replay" ? "ok" : "rejected",
    params: { endpoint: input.endpoint }
  });
  return resolution;
}

function insertIdempotencyRecord(
  db: DatabaseSync,
  input: {
    subjectId: string;
    endpoint: string;
    idempotencyKey: string;
    requestHash: string;
    runId: string;
    responseStatus: number;
    responseBody: object;
    replayExpiresAt: Date;
    tombstoneExpiresAt: Date;
    createdAt: Date;
  }
): void {
  db.prepare(
    `INSERT INTO research_idempotency_keys (
      subject_id, endpoint, idempotency_key, request_hash, run_id,
      response_status, response_body_json, replay_expires_at,
      tombstone_expires_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    input.subjectId,
    input.endpoint,
    input.idempotencyKey,
    input.requestHash,
    input.runId,
    input.responseStatus,
    JSON.stringify(input.responseBody),
    input.replayExpiresAt.toISOString(),
    input.tombstoneExpiresAt.toISOString(),
    input.createdAt.toISOString()
  );
}

function researchStatusFilter(
  status: ResearchRunStatus,
  now: Date
): { clause: string; parameters: string[] } {
  const timestamp = now.toISOString();
  if (status === "expired") {
    return {
      clause: `AND (
        status = 'expired'
        OR (
          status IN ('succeeded', 'failed', 'cancelled')
          AND expires_at IS NOT NULL
          AND expires_at <= ?
        )
      )`,
      parameters: [timestamp]
    };
  }
  if (status === "needs_input") {
    return {
      clause: `AND status = 'needs_input'
        AND (needs_input_expires_at IS NULL OR needs_input_expires_at > ?)`,
      parameters: [timestamp]
    };
  }
  if (status === "cancelled") {
    return {
      clause: `AND (
        (
          status = 'cancelled'
          AND (expires_at IS NULL OR expires_at > ?)
        )
        OR (
          status = 'needs_input'
          AND needs_input_expires_at IS NOT NULL
          AND needs_input_expires_at <= ?
        )
      )`,
      parameters: [timestamp, timestamp]
    };
  }
  if (status === "succeeded" || status === "failed") {
    return {
      clause: `AND status = ?
        AND (expires_at IS NULL OR expires_at > ?)`,
      parameters: [status, timestamp]
    };
  }
  return {
    clause: "AND status = ?",
    parameters: [status]
  };
}

export function createResearchSqliteStore(
  options: ResearchSqliteStoreOptions
): ResearchSqliteStore {
  return new ResearchSqliteStore(options);
}

const researchRunColumns = [
  "run_id",
  "subject_id",
  "credential_id",
  "skill_name",
  "skill_version",
  "prompt_version",
  "input_schema_version",
  "output_schema_version",
  "mode",
  "language",
  "input_json",
  "status",
  "stage",
  "progress_percent",
  "canonical_identity_id",
  "warning_codes_json",
  "terminal_reason",
  "terminal_detail_public",
  "cancel_requested_at",
  "cancel_requested_by",
  "cancel_request_id",
  "needs_input_expires_at",
  "needs_input_started_at",
  "queued_at",
  "active_started_at",
  "active_elapsed_ms",
  "lease_owner",
  "lease_until",
  "lease_generation",
  "attempt_count",
  "resume_count",
  "created_at",
  "updated_at",
  "completed_at",
  "expires_at",
  "purge_after"
].join(", ");

function getRun(
  db: DatabaseSync,
  runId: string,
  subjectId: string
): ResearchRunRecord | null {
  const row = db
    .prepare(
      `SELECT ${researchRunColumns}
       FROM research_runs
       WHERE run_id = ? AND subject_id = ?`
    )
    .get(runId, subjectId);
  return row ? rowToResearchRun(row) : null;
}

function getRunById(
  db: DatabaseSync,
  runId: string
): ResearchRunRecord | null {
  const row = db
    .prepare(
      `SELECT ${researchRunColumns}
       FROM research_runs
       WHERE run_id = ?`
    )
    .get(runId);
  return row ? rowToResearchRun(row) : null;
}

function lostLeaseResult(
  db: DatabaseSync,
  runId: string
): Extract<RenewResearchLeaseResult, { outcome: "lost" }> {
  const current = db
    .prepare(
      `SELECT status, lease_owner, lease_generation
       FROM research_runs
       WHERE run_id = ?`
    )
    .get(runId) as
    | {
        status: ResearchRunStatus;
        lease_owner: string | null;
        lease_generation: number;
      }
    | undefined;
  return {
    outcome: "lost",
    observedStatus: current?.status ?? null,
    observedOwner: current?.lease_owner ?? null,
    observedGeneration: current?.lease_generation ?? null
  };
}

function expiredLeaseActiveDeltaMs(
  candidate: {
    lease_until: string | null;
    active_started_at: string | null;
  },
  now: Date
): number {
  if (!candidate.active_started_at || !candidate.lease_until) {
    return 0;
  }
  const activeStartedAt = new Date(candidate.active_started_at);
  const oldLeaseUntil = new Date(candidate.lease_until);
  if (
    Number.isNaN(activeStartedAt.getTime()) ||
    Number.isNaN(oldLeaseUntil.getTime())
  ) {
    throw new Error("Stored Research active lease timestamps are invalid.");
  }
  return Math.max(
    0,
    Math.min(now.getTime(), oldLeaseUntil.getTime()) -
      activeStartedAt.getTime()
  );
}

function cancellationTerminalReason(
  run: ResearchRunRecord
): "cancelled_by_user" | "cancelled_by_operator" {
  if (run.cancelRequestedBy === "subject") {
    return "cancelled_by_user";
  }
  if (run.cancelRequestedBy === "operator") {
    return "cancelled_by_operator";
  }
  throw new Error(
    "A running system cancellation requires a registered terminal reason."
  );
}

function failurePublicDetail(
  reason: FailResearchRunInput["terminalReason"]
): string {
  const details: Record<
    FailResearchRunInput["terminalReason"],
    string
  > = {
    identity_not_resolved: "The doctor identity could not be resolved.",
    insufficient_research_evidence:
      "There was not enough verified public evidence to produce the result.",
    upstream_unavailable:
      "A required research source was temporarily unavailable.",
    quality_gate_failed:
      "The generated result did not pass the required quality checks.",
    model_contract_error:
      "The research model did not return a valid structured result.",
    deadline_exceeded:
      "The Research run exceeded its active execution deadline."
  };
  return details[reason];
}

function validateLeaseToken(token: ResearchLeaseToken): void {
  requireNonEmpty(token.runId, "token.runId");
  requireNonEmpty(token.owner, "token.owner");
  positiveInteger(token.generation, "token.generation");
  if (
    !(token.leaseUntil instanceof Date) ||
    Number.isNaN(token.leaseUntil.getTime())
  ) {
    throw new Error("token.leaseUntil must be a valid Date.");
  }
}

function validateCommitArtifacts(
  runId: string,
  artifacts: CompleteSuccessfulResearchRunInput["artifacts"]
): void {
  const requiredKinds = new Set(["profile", "review", "questions", "answers"]);
  if (
    artifacts.length !== 4 ||
    new Set(artifacts.map((artifact) => artifact.kind)).size !== 4 ||
    artifacts.some((artifact) => !requiredKinds.has(artifact.kind))
  ) {
    throw new Error("Exactly four standard Research artifacts are required.");
  }
  const artifactIds = new Set<string>();
  const storagePaths = new Set<string>();
  for (const artifact of artifacts) {
    if (
      !/^dra_[a-f0-9]{32}$/.test(artifact.artifactId) ||
      artifactIds.has(artifact.artifactId)
    ) {
      throw new Error("Research artifact IDs must be unique and canonical.");
    }
    artifactIds.add(artifact.artifactId);
    positiveInteger(artifact.storageVersion, "artifact.storageVersion");
    const expectedPath = `${runId}/${artifact.artifactId}.v${artifact.storageVersion}`;
    if (
      artifact.storageRelativePath !== expectedPath ||
      storagePaths.has(artifact.storageRelativePath)
    ) {
      throw new Error("Research artifact storage paths must be canonical.");
    }
    storagePaths.add(artifact.storageRelativePath);
    if (!/^[a-f0-9]{64}$/.test(artifact.sha256)) {
      throw new Error("Research artifact sha256 is invalid.");
    }
    if (!Number.isSafeInteger(artifact.sizeBytes) || artifact.sizeBytes < 0) {
      throw new Error("Research artifact sizeBytes is invalid.");
    }
    if (
      !/^[\x20-\x7e]{1,255}$/.test(artifact.filenameAscii) ||
      /[\\/\r\n]/.test(artifact.filenameUtf8) ||
      artifact.filenameUtf8.length === 0 ||
      artifact.filenameUtf8.length > 255
    ) {
      throw new Error("Research artifact filename is invalid.");
    }
    const expectedContentType =
      artifact.kind === "questions"
        ? "text/plain; charset=utf-8"
        : "text/markdown; charset=utf-8";
    if (artifact.contentType !== expectedContentType) {
      throw new Error("Research artifact content type is invalid.");
    }
  }
}

function validateResultArtifactBinding(
  result: DoctorResearchResult,
  artifacts: CompleteSuccessfulResearchRunInput["artifacts"],
  expiresAt: Date
): void {
  const committedByKind = new Map(
    artifacts.map((artifact) => [artifact.kind, artifact])
  );
  for (const manifest of result.artifacts) {
    const committed = committedByKind.get(manifest.kind);
    if (
      !committed ||
      manifest.artifact_id !== committed.artifactId ||
      manifest.filename !== committed.filenameUtf8 ||
      manifest.content_type !== committed.contentType ||
      manifest.size_bytes !== committed.sizeBytes ||
      manifest.sha256 !== committed.sha256 ||
      manifest.expires_at !== expiresAt.toISOString() ||
      manifest.download_url !==
        `/gateway/research/v1/artifacts/${committed.artifactId}/download`
    ) {
      throw new Error(
        `Research result artifact manifest does not match committed ${manifest.kind} metadata.`
      );
    }
  }
}

function validateIdentityCandidates(
  candidates: readonly ResearchIdentityCandidate[]
): void {
  if (candidates.length < 2 || candidates.length > 3) {
    throw new Error("Identity disambiguation requires two or three candidates.");
  }
  const ids = new Set<string>();
  for (const candidate of candidates) {
    validateIdentityCandidate(candidate);
    if (ids.has(candidate.candidateId)) {
      throw new Error("Identity candidate IDs must be unique.");
    }
    ids.add(candidate.candidateId);
  }
}

function validateIdentityCandidate(
  candidate: ResearchIdentityCandidate
): void {
  if (
    !/^dc_[a-f0-9]{16,64}$/.test(candidate.candidateId) ||
    !/^dci_[a-z0-9]{8,64}$/.test(candidate.canonicalIdentityId)
  ) {
    throw new Error("Identity candidate identifiers are invalid.");
  }
  for (const value of [
    candidate.name,
    candidate.hospital,
    candidate.department
  ]) {
    if (
      value.length === 0 ||
      value.length > 200 ||
      /[\u0000-\u001f\u007f]/u.test(value)
    ) {
      throw new Error("Identity candidate text is invalid.");
    }
  }
  if (
    candidate.city !== null &&
    (candidate.city.length === 0 ||
      candidate.city.length > 100 ||
      /[\u0000-\u001f\u007f]/u.test(candidate.city))
  ) {
    throw new Error("Identity candidate city is invalid.");
  }
  if (
    !Number.isFinite(candidate.score) ||
    candidate.score < 0 ||
    candidate.score > 1
  ) {
    throw new Error("Identity candidate score is invalid.");
  }
  if (
    candidate.evidenceTypes.length < 2 ||
    new Set(candidate.evidenceTypes).size !== candidate.evidenceTypes.length
  ) {
    throw new Error("Identity candidates require two evidence types.");
  }
  if (
    candidate.sources.length === 0 ||
    candidate.sources.some(
      (source) =>
        source.title.length === 0 ||
        source.title.length > 500 ||
        !/^https:\/\//.test(source.url) ||
        source.url.length > 2048
    )
  ) {
    throw new Error("Identity candidate sources are invalid.");
  }
}

function secondsToMs(value: number, name: string): number {
  const milliseconds = positiveInteger(value, name) * 1_000;
  if (!Number.isSafeInteger(milliseconds)) {
    throw new Error(`${name} exceeds the safe millisecond range.`);
  }
  return milliseconds;
}

function rowToResearchRun(row: unknown): ResearchRunRecord {
  const value = row as Record<string, unknown>;
  return {
    runId: requiredString(value.run_id, "run_id"),
    subjectId: requiredString(value.subject_id, "subject_id"),
    credentialId: nullableString(value.credential_id, "credential_id"),
    skillName: requiredString(value.skill_name, "skill_name"),
    skillVersion: requiredString(value.skill_version, "skill_version"),
    promptVersion: requiredString(value.prompt_version, "prompt_version"),
    inputSchemaVersion: requiredString(
      value.input_schema_version,
      "input_schema_version"
    ),
    outputSchemaVersion: requiredString(
      value.output_schema_version,
      "output_schema_version"
    ),
    mode: requiredString(value.mode, "mode") as ResearchRunRecord["mode"],
    language: requiredString(
      value.language,
      "language"
    ) as ResearchRunRecord["language"],
    input: parseRunInput(requiredString(value.input_json, "input_json")),
    status: requiredString(value.status, "status") as ResearchRunStatus,
    stage: requiredString(value.stage, "stage") as ResearchRunStage,
    progressPercent: requiredNumber(value.progress_percent, "progress_percent"),
    canonicalIdentityId: nullableString(
      value.canonical_identity_id,
      "canonical_identity_id"
    ),
    warningCodes: parseStringArray(
      requiredString(value.warning_codes_json, "warning_codes_json")
    ),
    terminalReason: nullableString(value.terminal_reason, "terminal_reason"),
    terminalDetailPublic: nullableString(
      value.terminal_detail_public,
      "terminal_detail_public"
    ),
    cancelRequestedAt: nullableDate(
      value.cancel_requested_at,
      "cancel_requested_at"
    ),
    cancelRequestedBy: nullableString(
      value.cancel_requested_by,
      "cancel_requested_by"
    ) as ResearchRunRecord["cancelRequestedBy"],
    cancelRequestId: nullableString(value.cancel_request_id, "cancel_request_id"),
    needsInputExpiresAt: nullableDate(
      value.needs_input_expires_at,
      "needs_input_expires_at"
    ),
    needsInputStartedAt: nullableDate(
      value.needs_input_started_at,
      "needs_input_started_at"
    ),
    queuedAt: requiredDate(value.queued_at, "queued_at"),
    activeStartedAt: nullableDate(value.active_started_at, "active_started_at"),
    activeElapsedMs: requiredNumber(value.active_elapsed_ms, "active_elapsed_ms"),
    leaseOwner: nullableString(value.lease_owner, "lease_owner"),
    leaseUntil: nullableDate(value.lease_until, "lease_until"),
    leaseGeneration: requiredNumber(value.lease_generation, "lease_generation"),
    attemptCount: requiredNumber(value.attempt_count, "attempt_count"),
    resumeCount: requiredNumber(value.resume_count, "resume_count"),
    createdAt: requiredDate(value.created_at, "created_at"),
    updatedAt: requiredDate(value.updated_at, "updated_at"),
    completedAt: nullableDate(value.completed_at, "completed_at"),
    expiresAt: nullableDate(value.expires_at, "expires_at"),
    purgeAfter: nullableDate(value.purge_after, "purge_after")
  };
}

function parseRunInput(value: string): DoctorResearchRunInput {
  const parsed = JSON.parse(value) as DoctorResearchRunInput;
  if (!parsed || typeof parsed !== "object" || !parsed.doctor) {
    throw new Error("Stored Research run input is invalid.");
  }
  return parsed;
}

function parseRunReceipt(value: string): ResearchRunReceipt {
  const parsed = JSON.parse(value) as ResearchRunReceipt;
  if (
    !parsed ||
    typeof parsed !== "object" ||
    parsed.schema_version !== "doctor_research_run.v1" ||
    typeof parsed.run_id !== "string" ||
    typeof parsed.request_id !== "string"
  ) {
    throw new Error("Stored Research idempotency receipt is invalid.");
  }
  return parsed;
}

function parseCancelReceipt(value: string): ResearchRunCancelReceipt {
  const parsed = JSON.parse(value) as ResearchRunCancelReceipt;
  if (
    !parsed ||
    typeof parsed !== "object" ||
    parsed.schema_version !== "doctor_research_run.v1" ||
    typeof parsed.run_id !== "string" ||
    typeof parsed.request_id !== "string" ||
    (parsed.status !== "running" && parsed.status !== "cancelled") ||
    typeof parsed.cancel_requested !== "boolean"
  ) {
    throw new Error("Stored Research cancellation receipt is invalid.");
  }
  return parsed;
}

function parseIdentityCandidate(value: string): ResearchIdentityCandidate {
  const parsed = JSON.parse(value) as ResearchIdentityCandidate;
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Stored Research identity candidate is invalid.");
  }
  validateIdentityCandidate(parsed);
  return parsed;
}

function parseIdentityReceipt(value: string): ResolveResearchIdentityReceipt {
  const parsed = JSON.parse(value) as ResolveResearchIdentityReceipt;
  if (
    !parsed ||
    typeof parsed !== "object" ||
    parsed.schema_version !== "doctor_research_run.v1" ||
    typeof parsed.run_id !== "string" ||
    typeof parsed.request_id !== "string" ||
    (parsed.status !== "queued" && parsed.status !== "failed")
  ) {
    throw new Error("Stored Research identity receipt is invalid.");
  }
  return parsed;
}

function parseStringArray(value: string): string[] {
  const parsed = JSON.parse(value) as unknown;
  if (
    !Array.isArray(parsed) ||
    !parsed.every((item) => typeof item === "string")
  ) {
    throw new Error("Stored Research string array is invalid.");
  }
  return parsed;
}

function count(
  db: DatabaseSync,
  sql: string,
  ...parameters: Array<string | number>
): number {
  const row = db.prepare(sql).get(...parameters) as { count: number };
  return row.count;
}

function inImmediateTransaction<T>(db: DatabaseSync, action: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = action();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function validateLimits(limits: ResearchAdmissionLimits): ResearchAdmissionLimits {
  return {
    dailyRunsPerSubject: positiveInteger(
      limits.dailyRunsPerSubject,
      "limits.dailyRunsPerSubject"
    ),
    uniqueDoctors30dPerSubject: positiveInteger(
      limits.uniqueDoctors30dPerSubject,
      "limits.uniqueDoctors30dPerSubject"
    ),
    globalActiveRuns: positiveInteger(
      limits.globalActiveRuns,
      "limits.globalActiveRuns"
    ),
    needsInputPerSubject: positiveInteger(
      limits.needsInputPerSubject,
      "limits.needsInputPerSubject"
    )
  };
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function validateBudgetValues(
  value: ChargeResearchRunBudgetInput["limits"],
  name: string,
  allowZero: boolean
): void {
  for (const [field, amount] of Object.entries(value)) {
    if (
      !Number.isSafeInteger(amount) ||
      amount < 0 ||
      (!allowZero && amount === 0)
    ) {
      throw new Error(
        `${name}.${field} must be a ${allowZero ? "non-negative" : "positive"} safe integer.`
      );
    }
  }
}

function leaseAllowsWorkerWrite(
  db: DatabaseSync,
  token: ResearchLeaseToken,
  now: Date
): boolean {
  return Boolean(
    db
      .prepare(
        `SELECT 1 AS active
         FROM research_runs
         WHERE run_id = ?
           AND status = 'running'
           AND lease_owner = ?
           AND lease_generation = ?
           AND lease_until > ?
           AND cancel_requested_at IS NULL`
      )
      .get(
        token.runId,
        token.owner,
        token.generation,
        now.toISOString()
      )
  );
}

function validateResearchStage(stage: ResearchRunStage): void {
  if (!researchRunStages.includes(stage)) {
    throw new Error("Research stage is invalid.");
  }
}

function boundedStageAttempt(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) {
    throw new Error("Research stage attempt must be an integer from 1 to 100.");
  }
}

function validateSha256(value: string, name: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`${name} must be a canonical SHA-256 digest.`);
  }
}

function nonNegativeSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer.`);
  }
}

function nullableNonNegativeSafeInteger(
  value: number | null | undefined,
  name: string
): void {
  if (value !== null && value !== undefined) {
    nonNegativeSafeInteger(value, name);
  }
}

function nullablePositiveSafeInteger(
  value: number | null | undefined,
  name: string
): void {
  if (
    value !== null &&
    value !== undefined &&
    (!Number.isSafeInteger(value) || value <= 0)
  ) {
    throw new Error(`${name} must be a positive safe integer.`);
  }
}

function nullableTokenCount(value: number | null, name: string): void {
  if (value !== null) {
    nonNegativeSafeInteger(value, name);
  }
}

function nullableBoundedSingleLine(
  value: string | null,
  name: string,
  maximumLength: number
): void {
  if (
    value !== null &&
    (value.length === 0 ||
      value.length > maximumLength ||
      /[\r\n]/u.test(value))
  ) {
    throw new Error(`${name} must be a bounded single-line value.`);
  }
}

function validateBackupId(value: string): void {
  if (!/^drb_[a-f0-9]{16,64}$/.test(value)) {
    throw new Error("Invalid Research backup ID.");
  }
}

function validateMaintenanceLockIdentity(
  name: AcquireResearchMaintenanceLockInput["name"],
  owner: string
): void {
  if (!["reconcile", "cleanup", "backup"].includes(name)) {
    throw new Error("Invalid Research maintenance lock name.");
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u.test(owner)) {
    throw new Error("Invalid Research maintenance lock owner.");
  }
}

function requireNonEmpty(value: string, name: string): string {
  if (value.trim().length === 0) {
    throw new Error(`${name} must not be empty.`);
  }
  return value;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string") {
    throw new Error(`Stored Research ${name} is invalid.`);
  }
  return value;
}

function nullableString(value: unknown, name: string): string | null {
  if (value === null) {
    return null;
  }
  return requiredString(value, name);
}

function requiredNumber(value: unknown, name: string): number {
  if (typeof value !== "number") {
    throw new Error(`Stored Research ${name} is invalid.`);
  }
  return value;
}

function requiredDate(value: unknown, name: string): Date {
  const date = new Date(requiredString(value, name));
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Stored Research ${name} is invalid.`);
  }
  return date;
}

function nullableDate(value: unknown, name: string): Date | null {
  if (value === null) {
    return null;
  }
  return requiredDate(value, name);
}
