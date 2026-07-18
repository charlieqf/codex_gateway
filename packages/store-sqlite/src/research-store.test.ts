import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  CreateResearchRunInput,
  DoctorResearchRunInput
} from "@codex-gateway/core";
import type { DoctorResearchResult } from "@codex-gateway/research-agent";
import { createResearchSqliteStore } from "./index.js";

const cleanupDirs: string[] = [];

afterEach(() => {
  for (const dir of cleanupDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("ResearchSqliteStore", () => {
  it("creates an independent WAL schema with the Phase 0 invariant tables", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "codex-research-store-"));
    cleanupDirs.push(dir);
    const dbPath = path.join(dir, "research.db");
    const store = createStore(dbPath);
    expect(
      (
        store.database.prepare("PRAGMA journal_mode").get() as {
          journal_mode: string;
        }
      ).journal_mode
    ).toBe("wal");
    expect(
      (
        store.database.prepare("PRAGMA foreign_keys").get() as {
          foreign_keys: number;
        }
      ).foreign_keys
    ).toBe(1);
    store.close();

    const db = new DatabaseSync(dbPath);
    try {
      const tables = (
        db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
          .all() as Array<{ name: string }>
      ).map((row) => row.name);
      expect(tables).toEqual(
        expect.arrayContaining([
          "research_schema_migrations",
          "research_runs",
          "research_run_results",
          "research_idempotency_keys",
          "research_stage_runs",
          "research_checkpoints",
          "research_identity_candidates",
          "research_sources",
          "research_claims",
          "research_references",
          "research_artifacts",
          "research_suppressions",
          "research_doctor_admissions",
          "research_subject_identity_aliases",
          "research_worker_heartbeats",
          "research_audit_events",
          "research_backup_runs",
          "research_run_budgets",
          "research_maintenance_locks"
        ])
      );
      expect(tables).not.toContain("schema_migrations");
      expect(
        db
          .prepare(
            "SELECT version FROM research_schema_migrations WHERE version = 5"
          )
          .get()
      ).toBeTruthy();
      expect(
        (
          db.prepare("PRAGMA table_info(research_artifacts)").all() as Array<{
            name: string;
          }>
        ).map((column) => column.name)
      ).toEqual(
        expect.arrayContaining(["filename_ascii", "filename_utf8"])
      );
      expect(
        (
          db.prepare("PRAGMA table_info(research_artifacts)").all() as Array<{
            name: string;
          }>
        ).map((column) => column.name)
      ).not.toContain("filename");
    } finally {
      db.close();
    }
  });

  it("upgrades an already-recorded Research schema v1 artifact table", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "codex-research-store-v1-"));
    cleanupDirs.push(dir);
    const dbPath = path.join(dir, "research.db");
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE research_schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
      INSERT INTO research_schema_migrations (version, applied_at)
      VALUES (1, '2026-07-17T00:00:00.000Z');
      CREATE TABLE research_runs (run_id TEXT PRIMARY KEY);
      INSERT INTO research_runs (run_id)
      VALUES ('drr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
      CREATE TABLE research_sources (
        source_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES research_runs(run_id),
        source_type TEXT NOT NULL,
        url TEXT,
        title TEXT,
        content_sha256 TEXT,
        trust_tier TEXT NOT NULL,
        accessed_at TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE TABLE research_claims (
        claim_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES research_runs(run_id),
        claim_type TEXT NOT NULL,
        claim_text TEXT NOT NULL,
        source_ids_json TEXT NOT NULL,
        verification_status TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE research_references (
        reference_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES research_runs(run_id),
        pmid TEXT,
        doi TEXT,
        title TEXT NOT NULL,
        authors_json TEXT NOT NULL,
        journal TEXT,
        publication_year INTEGER,
        study_type TEXT,
        verification_status TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE TABLE research_identity_candidates (
        candidate_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES research_runs(run_id),
        candidate_json TEXT NOT NULL,
        evidence_json TEXT NOT NULL,
        score REAL NOT NULL,
        selected_at TEXT,
        rejected_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE research_artifacts (
        artifact_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES research_runs(run_id),
        subject_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        filename TEXT NOT NULL,
        content_type TEXT NOT NULL,
        storage_path TEXT NOT NULL,
        storage_version INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        UNIQUE (run_id, kind),
        UNIQUE (storage_path)
      );
      CREATE INDEX idx_research_artifacts_subject
        ON research_artifacts(subject_id, created_at DESC);
      CREATE INDEX idx_research_artifacts_expires
        ON research_artifacts(expires_at);
      INSERT INTO research_artifacts (
        artifact_id, run_id, subject_id, kind, filename, content_type,
        storage_path, storage_version, sha256, size_bytes, created_at, expires_at
      ) VALUES (
        'dra_11111111111111111111111111111111',
        'drr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        'subj_a',
        'profile',
        'legacy-profile.md',
        'text/markdown; charset=utf-8',
        'drr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/dra_11111111111111111111111111111111.v1',
        1,
        '${"1".repeat(64)}',
        10,
        '2026-07-17T00:00:00.000Z',
        '2026-08-17T00:00:00.000Z'
      );
    `);
    legacy.close();

    const store = createStore(dbPath);
    expect(
      store.database
        .prepare(
          `SELECT filename_ascii, filename_utf8
           FROM research_artifacts`
        )
        .get()
    ).toEqual({
      filename_ascii: "legacy-profile.md",
      filename_utf8: "legacy-profile.md"
    });
    expect(
      store.database
        .prepare(
          `SELECT version
           FROM research_schema_migrations
           ORDER BY version`
        )
        .all()
    ).toEqual([
      { version: 1 },
      { version: 2 },
      { version: 3 },
      { version: 4 },
      { version: 5 }
    ]);
    store.close();
  });

  it("creates, isolates, orders, and replays runs by subject", () => {
    const store = createStore(":memory:");
    const now = new Date("2026-07-17T01:30:00Z");
    const first = store.createRun(command("subj_a", "key-1", "hash-1", "fp-1", now));
    expect(first.outcome).toBe("created");
    if (first.outcome !== "created") {
      throw new Error("Expected a created run.");
    }

    const replay = store.createRun(
      command(
        "subj_a",
        "key-1",
        "hash-1",
        "fp-1",
        new Date(now.getTime() + 1_000)
      )
    );
    expect(replay).toMatchObject({
      outcome: "replayed",
      run: { runId: first.run.runId }
    });
    expect(
      store.createRun(
        command(
          "subj_a",
          "key-1",
          "different",
          "fp-1",
          new Date(now.getTime() + 2_000)
        )
      )
    ).toEqual({ outcome: "idempotency_conflict" });
    expect(store.getRunForSubject(first.run.runId, "subj_b")).toBeNull();
    expect(store.getRunForSubject(first.run.runId, "subj_a")).toMatchObject({
      status: "queued",
      stage: "validate_input"
    });
    expect(
      store.listRunsForSubject({ subjectId: "subj_a", limit: 20 })
    ).toHaveLength(1);
    expect(
      store.listRunsForSubject({ subjectId: "subj_b", limit: 20 })
    ).toHaveLength(0);
    store.close();
  });

  it("keeps replay tombstones and atomically enforces admission limits", () => {
    const store = createResearchSqliteStore({
      path: ":memory:",
      limits: {
        dailyRunsPerSubject: 5,
        uniqueDoctors30dPerSubject: 1,
        globalActiveRuns: 10,
        needsInputPerSubject: 1
      },
      idempotencyReplaySeconds: 10,
      idempotencyTombstoneSeconds: 20
    });
    const now = new Date("2026-07-17T01:30:00Z");
    const first = store.createRun(command("subj_a", "key-1", "hash-1", "fp-1", now));
    if (first.outcome !== "created") {
      throw new Error("Expected a created run.");
    }
    expect(
      store.createRun(
        command(
          "subj_a",
          "key-1",
          "hash-1",
          "fp-1",
          new Date(now.getTime() + 15_000)
        )
      )
    ).toEqual({ outcome: "idempotency_expired" });
    expect(
      store.maintainIdempotency({
        now: new Date(now.getTime() + 15_000),
        batchSize: 100
      })
    ).toEqual({ replayBodiesScrubbed: 1, tombstonesDeleted: 0 });
    expect(
      store.database
        .prepare(
          `SELECT response_status, response_body_json
           FROM research_idempotency_keys
           WHERE idempotency_key = 'key-1'`
        )
        .get()
    ).toEqual({ response_status: null, response_body_json: null });
    expect(
      store.createRun(command("subj_a", "key-2", "hash-2", "fp-1", now))
    ).toEqual({
      outcome: "rate_limited",
      limitKind: "research_active_brief"
    });
    expect(
      store.createRun(command("subj_a", "key-2b", "hash-2b", "fp-1", now))
    ).toEqual({
      outcome: "rate_limited",
      limitKind: "research_active_brief"
    });
    expect(
      store.database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM research_audit_events
           WHERE action = 'admission_quota'
             AND json_extract(params_json, '$.limit_kind') =
               'research_active_brief'`
        )
        .get()
    ).toEqual({ count: 1 });

    store.database
      .prepare(
        `UPDATE research_runs
         SET status = 'needs_input', needs_input_expires_at = ?
         WHERE run_id = ?`
      )
      .run(new Date(now.getTime() + 60_000).toISOString(), first.run.runId);
    expect(
      store.createRun(command("subj_a", "key-3", "hash-3", "fp-1", now))
    ).toEqual({
      outcome: "rate_limited",
      limitKind: "research_needs_input"
    });

    store.database
      .prepare(
        `UPDATE research_runs
         SET status = 'cancelled', needs_input_expires_at = NULL
         WHERE run_id = ?`
      )
      .run(first.run.runId);
    expect(
      store.createRun(command("subj_a", "key-4", "hash-4", "fp-2", now))
    ).toEqual({
      outcome: "rate_limited",
      limitKind: "research_unique_doctors_30d"
    });

    expect(
      store.maintainIdempotency({
        now: new Date(now.getTime() + 21_000),
        batchSize: 100
      })
    ).toEqual({ replayBodiesScrubbed: 0, tombstonesDeleted: 1 });
    const reused = store.createRun(
      command(
        "subj_a",
        "key-1",
        "new-after-tombstone",
        "fp-1",
        new Date(now.getTime() + 21_000)
      )
    );
    expect(reused.outcome).toBe("created");
    store.close();
  });

  it("keeps Research audit rows append-only", () => {
    const store = createStore(":memory:");
    const created = store.createRun(
      command(
        "subj_a",
        "key-1",
        "hash-1",
        "fp-1",
        new Date("2026-07-17T01:30:00Z")
      )
    );
    expect(created.outcome).toBe("created");
    expect(() =>
      store.database
        .prepare("UPDATE research_audit_events SET outcome = 'changed'")
        .run()
    ).toThrow("research_audit_events is append-only");
    expect(() =>
      store.database.prepare("DELETE FROM research_audit_events").run()
    ).toThrow("research_audit_events cannot be deleted during retention");
    store.database
      .prepare(
        `INSERT INTO research_audit_events (
          event_id, occurred_at, actor_type, action, outcome
        ) VALUES ('old-audit', '2000-01-01T00:00:00.000Z', 'system',
          'physical_cleanup_fixture', 'ok')`
      )
      .run();
    expect(
      store.database
        .prepare("DELETE FROM research_audit_events WHERE event_id = 'old-audit'")
        .run().changes
    ).toBe(1);
    store.close();
  });

  it("takes over expired leases and fences every late write from the old worker", () => {
    const store = createStore(":memory:");
    const startedAt = new Date("2026-07-17T01:30:00Z");
    const created = store.createRun(
      command("subj_a", "key-lease", "hash-lease", "fp-lease", startedAt)
    );
    if (created.outcome !== "created") {
      throw new Error("Expected a created run.");
    }

    const oldLease = store.acquireLease({
      workerId: "worker-old",
      leaseSeconds: 120,
      now: startedAt
    });
    expect(oldLease).toMatchObject({
      run: { status: "running", leaseGeneration: 1, attemptCount: 1 },
      cancelRequested: false
    });
    if (!oldLease) {
      throw new Error("Expected the old worker to acquire the run.");
    }
    expect(
      store.writeCheckpoint({
        token: oldLease.token,
        stage: "discover_identity",
        checkpointVersion: 1,
        payload: { firstGeneration: true },
        payloadSha256: checkpointHash({ firstGeneration: true }),
        progressPercent: 10,
        now: new Date(startedAt.getTime() + 1_000)
      })
    ).toEqual({ outcome: "written" });
    expect(
      store.acquireLease({
        workerId: "worker-new",
        leaseSeconds: 120,
        now: new Date(startedAt.getTime() + 119_000)
      })
    ).toBeNull();

    const takeoverAt = new Date(startedAt.getTime() + 121_000);
    const newLease = store.acquireLease({
      workerId: "worker-new",
      leaseSeconds: 120,
      now: takeoverAt
    });
    expect(newLease).toMatchObject({
      run: {
        status: "running",
        leaseOwner: "worker-new",
        leaseGeneration: 2,
        attemptCount: 2,
        activeElapsedMs: 120_000
      }
    });
    if (!newLease) {
      throw new Error("Expected the new worker to take over the run.");
    }

    const afterTakeover = new Date(takeoverAt.getTime() + 1_000);
    expect(
      store.renewLease({
        token: oldLease.token,
        leaseSeconds: 120,
        now: afterTakeover
      })
    ).toEqual({
      outcome: "lost",
      observedStatus: "running",
      observedOwner: "worker-new",
      observedGeneration: 2
    });
    expect(
      store.writeCheckpoint({
        token: oldLease.token,
        stage: "discover_identity",
        checkpointVersion: 1,
        payload: { stale: true },
        payloadSha256: checkpointHash({ stale: true }),
        progressPercent: 10,
        now: afterTakeover
      })
    ).toEqual({ outcome: "fenced_or_cancelled" });
    expect(
      store.writeCheckpoint({
        token: newLease.token,
        stage: "discover_identity",
        checkpointVersion: 1,
        payload: { stale: false },
        payloadSha256: checkpointHash({ stale: false }),
        progressPercent: 10,
        now: afterTakeover
      })
    ).toEqual({ outcome: "written" });
    expect(
      (
        store.database
          .prepare(
            `SELECT lease_generation, payload_sha256
             FROM research_checkpoints
             WHERE run_id = ?`
          )
          .get(created.run.runId) as {
          lease_generation: number;
          payload_sha256: string;
        }
      )
    ).toEqual({
      lease_generation: 2,
      payload_sha256: checkpointHash({ stale: false })
    });
    store.close();
  });

  it("persists conservative run budgets and verified backup freshness", () => {
    const store = createStore(":memory:");
    const now = new Date("2026-07-17T01:30:00Z");
    const created = store.createRun(
      command(
        "subj_a",
        "key-budget",
        "hash-budget",
        "fp-budget",
        now
      )
    );
    if (created.outcome !== "created") {
      throw new Error("Expected a created Research budget run.");
    }
    const lease = store.acquireLease({
      workerId: "worker-budget",
      leaseSeconds: 120,
      now
    });
    if (!lease) {
      throw new Error("Expected a Research budget lease.");
    }
    const limits = {
      externalRequests: 3,
      externalResponseBytes: 300,
      llmCalls: 2,
      inputTokens: 200,
      outputTokens: 100
    };
    expect(
      store.chargeRunBudget({
        token: lease.token,
        charge: {
          externalRequests: 2,
          externalResponseBytes: 200,
          llmCalls: 1,
          inputTokens: 100,
          outputTokens: 50
        },
        limits,
        now
      })
    ).toMatchObject({
      outcome: "charged",
      totals: {
        externalRequests: 2,
        externalResponseBytes: 200,
        llmCalls: 1,
        inputTokens: 100,
        outputTokens: 50
      }
    });
    expect(
      store.chargeRunBudget({
        token: lease.token,
        charge: {
          externalRequests: 2,
          externalResponseBytes: 1,
          llmCalls: 0,
          inputTokens: 0,
          outputTokens: 0
        },
        limits,
        now
      })
    ).toEqual({
      outcome: "budget_exceeded",
      limit: "external_requests"
    });
    expect(
      store.database
        .prepare(
          `SELECT external_requests, external_response_bytes, llm_calls,
                  input_tokens, output_tokens
           FROM research_run_budgets
           WHERE run_id = ?`
        )
        .get(created.run.runId)
    ).toEqual({
      external_requests: 2,
      external_response_bytes: 200,
      llm_calls: 1,
      input_tokens: 100,
      output_tokens: 50
    });
    expect(
      store.startStageRun({
        token: lease.token,
        stage: "synthesize_review",
        attempt: 1,
        inputSha256: "c".repeat(64),
        now
      })
    ).toEqual({ outcome: "written" });
    expect(
      store.completeStageRun({
        token: lease.token,
        stage: "synthesize_review",
        attempt: 1,
        outputSha256: "d".repeat(64),
        durationMs: 25,
        promptTokens: 100,
        completionTokens: 50,
        gatewayRequestId: "req_gateway_stage_1",
        errorCode: null,
        now: new Date(now.getTime() + 1_000)
      })
    ).toEqual({ outcome: "written" });
    expect(
      store.database
        .prepare(
          `SELECT input_sha256, output_sha256, duration_ms, prompt_tokens,
                  completion_tokens, gateway_request_id, error_code
           FROM research_stage_runs
           WHERE run_id = ?`
        )
        .get(created.run.runId)
    ).toEqual({
      input_sha256: "c".repeat(64),
      output_sha256: "d".repeat(64),
      duration_ms: 25,
      prompt_tokens: 100,
      completion_tokens: 50,
      gateway_request_id: "req_gateway_stage_1",
      error_code: null
    });
    expect(
      store.startStageRun({
        token: lease.token,
        stage: "validate_outputs",
        attempt: 2,
        inputSha256: "e".repeat(64),
        now: new Date(now.getTime() + 121_000)
      })
    ).toEqual({ outcome: "fenced_or_cancelled" });

    const backupId = `drb_${"a".repeat(32)}`;
    store.recordBackupStarted({
      backupId,
      schemaVersion: "research_backup_manifest.v1",
      now
    });
    expect(store.latestSuccessfulBackupAt()).toBeNull();
    const completedAt = new Date(now.getTime() + 1_000);
    store.recordBackupCompleted({
      backupId,
      outcome: "succeeded",
      manifestSha256: "b".repeat(64),
      now: completedAt
    });
    expect(store.latestSuccessfulBackupAt()?.toISOString()).toBe(
      completedAt.toISOString()
    );
    store.close();
  });

  it("requeues retriable failures and writes fixed public terminal failures under fencing", () => {
    const store = createStore(":memory:");
    const startedAt = new Date("2026-07-17T01:30:00Z");
    const created = store.createRun(
      command(
        "subj_a",
        "key-failure-paths",
        "hash-failure-paths",
        "fp-failure-paths",
        startedAt
      )
    );
    if (created.outcome !== "created") {
      throw new Error("Expected a created run.");
    }
    const firstLease = store.acquireLease({
      workerId: "worker-failure",
      leaseSeconds: 120,
      now: startedAt
    });
    if (!firstLease) {
      throw new Error("Expected a lease.");
    }
    expect(
      store.requeueRun({
        token: firstLease.token,
        reason: "retriable_upstream_failure",
        now: new Date(startedAt.getTime() + 10_000)
      })
    ).toMatchObject({
      outcome: "queued",
      run: {
        status: "queued",
        activeElapsedMs: 10_000,
        leaseOwner: null,
        attemptCount: 1
      }
    });
    const secondLease = store.acquireLease({
      workerId: "worker-failure",
      leaseSeconds: 120,
      now: new Date(startedAt.getTime() + 20_000)
    });
    if (!secondLease) {
      throw new Error("Expected a second lease.");
    }
    expect(secondLease.token.generation).toBe(2);
    expect(
      store.failRun({
        token: secondLease.token,
        terminalReason: "model_contract_error",
        now: new Date(startedAt.getTime() + 30_000)
      })
    ).toMatchObject({
      outcome: "failed",
      run: {
        status: "failed",
        terminalReason: "model_contract_error",
        terminalDetailPublic:
          "The research model did not return a valid structured result.",
        activeElapsedMs: 20_000,
        leaseOwner: null,
        completedAt: new Date(startedAt.getTime() + 30_000)
      }
    });
    expect(
      store.failRun({
        token: firstLease.token,
        terminalReason: "upstream_unavailable",
        now: new Date(startedAt.getTime() + 31_000)
      })
    ).toEqual({ outcome: "fenced_or_cancelled" });
    expect(
      store.database
        .prepare(
          `SELECT action
           FROM research_audit_events
           WHERE run_id = ?
             AND action IN ('run_requeued', 'run_failed')
           ORDER BY occurred_at`
        )
        .all(created.run.runId)
    ).toEqual([
      { action: "run_requeued" },
      { action: "run_failed" }
    ]);
    store.close();
  });

  it("distinguishes cancellation from lease loss and only the current owner terminates", () => {
    const store = createStore(":memory:");
    const startedAt = new Date("2026-07-17T01:30:00Z");
    const created = store.createRun(
      command("subj_a", "key-cancel", "hash-cancel", "fp-cancel", startedAt)
    );
    if (created.outcome !== "created") {
      throw new Error("Expected a created run.");
    }
    const lease = store.acquireLease({
      workerId: "worker-current",
      leaseSeconds: 120,
      now: startedAt
    });
    if (!lease) {
      throw new Error("Expected a lease.");
    }

    const beforeCancel = store.renewLease({
      token: lease.token,
      leaseSeconds: 120,
      now: new Date(startedAt.getTime() + 30_000)
    });
    expect(beforeCancel).toMatchObject({
      outcome: "renewed",
      cancelRequested: false
    });
    if (beforeCancel.outcome !== "renewed") {
      throw new Error("Expected renewal.");
    }

    const cancelAt = new Date(startedAt.getTime() + 40_000);
    const cancellation = store.requestCancel({
      runId: created.run.runId,
      subjectId: "subj_a",
      credentialId: "cred_subj_a",
      requestId: "req-cancel",
      idempotencyKey: "cancel-key",
      requestHash: "cancel-hash",
      now: cancelAt
    });
    expect(cancellation).toMatchObject({
      outcome: "accepted",
      receipt: {
        status: "running",
        cancel_requested: true,
        terminal_reason: null
      }
    });
    const renewedWithCancel = store.renewLease({
      token: beforeCancel.token,
      leaseSeconds: 120,
      now: new Date(startedAt.getTime() + 50_000)
    });
    expect(renewedWithCancel).toMatchObject({
      outcome: "renewed",
      cancelRequested: true,
      cancelRequestedBy: "subject"
    });
    if (renewedWithCancel.outcome !== "renewed") {
      throw new Error("Expected a renewal carrying cancellation.");
    }
    expect(
      store.writeCheckpoint({
        token: renewedWithCancel.token,
        stage: "discover_identity",
        checkpointVersion: 1,
        payload: {},
        payloadSha256: checkpointHash({}),
        progressPercent: 10,
        now: new Date(startedAt.getTime() + 51_000)
      })
    ).toEqual({ outcome: "fenced_or_cancelled" });

    const completed = store.completeCancellation({
      token: renewedWithCancel.token,
      now: new Date(startedAt.getTime() + 60_000)
    });
    expect(completed).toMatchObject({
      outcome: "cancelled",
      run: {
        status: "cancelled",
        terminalReason: "cancelled_by_user",
        activeElapsedMs: 60_000,
        leaseOwner: null,
        leaseUntil: null
      }
    });
    expect(
      store.completeCancellation({
        token: lease.token,
        now: new Date(startedAt.getTime() + 61_000)
      })
    ).toMatchObject({
      outcome: "lost",
      observedStatus: "cancelled",
      observedOwner: null,
      observedGeneration: 1
    });
    expect(
      (
        store.database
          .prepare(
            `SELECT COUNT(*) AS count
             FROM research_audit_events
             WHERE run_id = ? AND action = 'cancel_completed'`
          )
          .get(created.run.runId) as { count: number }
      ).count
    ).toBe(1);
    store.close();
  });

  it("immediately cancels queued runs with exact idempotency replay", () => {
    const store = createResearchSqliteStore({
      path: ":memory:",
      limits: {
        dailyRunsPerSubject: 10,
        uniqueDoctors30dPerSubject: 10,
        globalActiveRuns: 100,
        needsInputPerSubject: 10
      },
      idempotencyReplaySeconds: 10,
      idempotencyTombstoneSeconds: 20
    });
    const now = new Date("2026-07-17T01:30:00Z");
    const created = store.createRun(
      command("subj_a", "key-immediate", "hash-immediate", "fp-immediate", now)
    );
    if (created.outcome !== "created") {
      throw new Error("Expected a created run.");
    }
    const input = {
      runId: created.run.runId,
      subjectId: "subj_a",
      credentialId: "cred_subj_a",
      requestId: "req-immediate-cancel",
      idempotencyKey: "cancel-immediate",
      requestHash: "cancel-immediate-hash",
      now
    };
    expect(store.requestCancel(input)).toMatchObject({
      outcome: "accepted",
      run: {
        status: "cancelled",
        terminalReason: "cancelled_by_user",
        completedAt: now
      },
      receipt: {
        status: "cancelled",
        cancel_requested: false
      }
    });
    expect(
      store.requestCancel({
        ...input,
        now: new Date(now.getTime() + 1_000)
      })
    ).toMatchObject({
      outcome: "replayed",
      receipt: {
        request_id: "req-immediate-cancel",
        updated_at: now.toISOString()
      }
    });
    expect(
      store.requestCancel({
        ...input,
        requestHash: "different",
        now: new Date(now.getTime() + 2_000)
      })
    ).toEqual({ outcome: "idempotency_conflict" });
    expect(
      store.requestCancel({
        ...input,
        now: new Date(now.getTime() + 11_000)
      })
    ).toEqual({ outcome: "idempotency_expired" });
    expect(
      store.requestCancel({
        ...input,
        subjectId: "subj_other",
        idempotencyKey: "other-key",
        requestHash: "other-hash",
        now: new Date(now.getTime() + 12_000)
      })
    ).toEqual({ outcome: "not_found" });
    expect(
      store.database
        .prepare(
          `SELECT action, outcome, COUNT(*) AS count
           FROM research_audit_events
           WHERE run_id = ?
             AND action IN (
               'idempotency_replay',
               'idempotency_conflict',
               'idempotency_expired'
             )
           GROUP BY action, outcome
           ORDER BY action`
        )
        .all(created.run.runId)
    ).toEqual([
      { action: "idempotency_conflict", outcome: "rejected", count: 1 },
      { action: "idempotency_expired", outcome: "rejected", count: 1 },
      { action: "idempotency_replay", outcome: "ok", count: 1 }
    ]);
    store.close();
  });

  it("persists needs-input and terminal TTL transitions with audit", () => {
    const store = createResearchSqliteStore({
      path: ":memory:",
      limits: {
        dailyRunsPerSubject: 10,
        uniqueDoctors30dPerSubject: 10,
        globalActiveRuns: 100,
        needsInputPerSubject: 10
      },
      resultTtlSeconds: 10,
      runRetentionSeconds: 20
    });
    const now = new Date("2026-07-17T01:30:00Z");
    const created = store.createRun(
      command("subj_a", "key-ttl", "hash-ttl", "fp-ttl", now)
    );
    if (created.outcome !== "created") {
      throw new Error("Expected a created run.");
    }
    const needsInputExpiresAt = new Date(now.getTime() + 72 * 60 * 60 * 1000);
    store.database
      .prepare(
        `UPDATE research_runs
         SET status = 'needs_input',
             needs_input_started_at = ?,
             needs_input_expires_at = ?
         WHERE run_id = ?`
      )
      .run(now.toISOString(), needsInputExpiresAt.toISOString(), created.run.runId);

    expect(
      store.reconcileTtl({
        now: new Date(needsInputExpiresAt.getTime() - 1),
        batchSize: 100
      })
    ).toEqual({ needsInputCancelled: 0, terminalExpired: 0 });
    expect(
      store.reconcileTtl({ now: needsInputExpiresAt, batchSize: 100 })
    ).toEqual({ needsInputCancelled: 1, terminalExpired: 0 });
    const cancelled = store.getRunForSubject(created.run.runId, "subj_a");
    expect(cancelled).toMatchObject({
      status: "cancelled",
      terminalReason: "identity_selection_timeout",
      completedAt: needsInputExpiresAt,
      expiresAt: new Date(needsInputExpiresAt.getTime() + 10_000),
      purgeAfter: new Date(needsInputExpiresAt.getTime() + 20_000)
    });

    const expireAt = new Date(needsInputExpiresAt.getTime() + 10_000);
    expect(store.reconcileTtl({ now: expireAt })).toEqual({
      needsInputCancelled: 0,
      terminalExpired: 1
    });
    expect(
      store.getRunForSubject(created.run.runId, "subj_a")
    ).toMatchObject({
      status: "expired",
      terminalReason: "identity_selection_timeout",
      completedAt: needsInputExpiresAt,
      expiresAt: expireAt,
      purgeAfter: new Date(needsInputExpiresAt.getTime() + 20_000)
    });
    expect(
      (
        store.database
          .prepare(
            `SELECT COUNT(*) AS count
             FROM research_audit_events
             WHERE run_id = ?
               AND action IN ('ttl_needs_input_timeout', 'ttl_terminal_expired')`
          )
          .get(created.run.runId) as { count: number }
      ).count
    ).toBe(2);
    store.close();
  });

  it("prevents an older process instance from overwriting a worker heartbeat", () => {
    const store = createStore(":memory:");
    const oldStartedAt = new Date("2026-07-17T01:00:00Z");
    const newStartedAt = new Date("2026-07-17T02:00:00Z");
    expect(
      store.recordWorkerHeartbeat({
        workerId: "worker-static",
        processInstanceId: "process-new",
        version: "1.0.0",
        state: "ready",
        startedAt: newStartedAt,
        now: new Date("2026-07-17T02:00:15Z")
      })
    ).toEqual({ outcome: "recorded" });
    expect(
      store.recordWorkerHeartbeat({
        workerId: "worker-static",
        processInstanceId: "process-old",
        version: "0.9.0",
        state: "draining",
        startedAt: oldStartedAt,
        now: new Date("2026-07-17T02:00:30Z")
      })
    ).toEqual({ outcome: "stale_process_ignored" });
    expect(
      store.database
        .prepare(
          `SELECT process_instance_id, version, state, last_seen_at
           FROM research_worker_heartbeats
           WHERE worker_id = 'worker-static'`
        )
        .get()
    ).toEqual({
      process_instance_id: "process-new",
      version: "1.0.0",
      state: "ready",
      last_seen_at: "2026-07-17T02:00:15.000Z"
    });
    expect(
      store.recordWorkerHeartbeat({
        workerId: "worker-static",
        processInstanceId: "process-new",
        version: "1.0.1",
        state: "draining",
        startedAt: newStartedAt,
        now: new Date("2026-07-17T02:00:45Z")
      })
    ).toEqual({ outcome: "recorded" });
    expect(
      store.listWorkerHeartbeats({
        now: new Date("2026-07-17T02:00:45Z"),
        staleAfterSeconds: 45
      })
    ).toMatchObject([
      {
        workerId: "worker-static",
        processInstanceId: "process-new",
        state: "draining",
        ageSeconds: 0,
        available: false
      }
    ]);
    expect(
      store.recordWorkerHeartbeat({
        workerId: "worker-ready",
        processInstanceId: "process-ready",
        version: "1.0.1",
        state: "ready",
        startedAt: newStartedAt,
        now: new Date("2026-07-17T02:00:00Z")
      })
    ).toEqual({ outcome: "recorded" });
    expect(
      store.listWorkerHeartbeats({
        now: new Date("2026-07-17T02:00:45.001Z"),
        staleAfterSeconds: 45
      })
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          workerId: "worker-ready",
          ageSeconds: 45.001,
          available: false
        })
      ])
    );
    store.database
      .prepare(
        `UPDATE research_worker_heartbeats
         SET last_seen_at = '2026-07-17T03:00:00.000Z'
         WHERE worker_id = 'worker-ready'`
      )
      .run();
    expect(
      store.listWorkerHeartbeats({
        now: new Date("2026-07-17T02:00:45.001Z"),
        staleAfterSeconds: 45
      })
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          workerId: "worker-ready",
          available: false
        })
      ])
    );
    expect(() =>
      store.recordWorkerHeartbeat({
        workerId: "worker-future",
        processInstanceId: "process-future",
        version: "1.0.0",
        state: "ready",
        startedAt: new Date("2026-07-17T04:00:00Z"),
        now: new Date("2026-07-17T03:00:00Z")
      })
    ).toThrow("must not be later");
    store.close();
  });

  it("serializes maintenance across processes with an expiring owner-fenced lock", () => {
    const store = createStore(":memory:");
    const startedAt = new Date("2026-07-17T01:00:00Z");
    expect(
      store.acquireMaintenanceLock({
        name: "backup",
        owner: "process-one",
        leaseSeconds: 60,
        now: startedAt
      })
    ).toBe(true);
    expect(
      store.acquireMaintenanceLock({
        name: "backup",
        owner: "process-two",
        leaseSeconds: 60,
        now: new Date("2026-07-17T01:00:30Z")
      })
    ).toBe(false);
    expect(
      store.renewMaintenanceLock({
        name: "backup",
        owner: "process-one",
        leaseSeconds: 60,
        now: new Date("2026-07-17T01:00:30Z")
      })
    ).toBe(true);
    expect(
      store.acquireMaintenanceLock({
        name: "backup",
        owner: "process-two",
        leaseSeconds: 60,
        now: new Date("2026-07-17T01:01:29.999Z")
      })
    ).toBe(false);
    expect(
      store.acquireMaintenanceLock({
        name: "backup",
        owner: "process-two",
        leaseSeconds: 60,
        now: new Date("2026-07-17T01:01:30Z")
      })
    ).toBe(true);
    expect(
      store.renewMaintenanceLock({
        name: "backup",
        owner: "process-one",
        leaseSeconds: 60,
        now: new Date("2026-07-17T01:01:31Z")
      })
    ).toBe(false);
    store.releaseMaintenanceLock({
      name: "backup",
      owner: "process-one"
    });
    expect(
      store.acquireMaintenanceLock({
        name: "backup",
        owner: "process-three",
        leaseSeconds: 60,
        now: new Date("2026-07-17T01:01:31Z")
      })
    ).toBe(false);
    store.releaseMaintenanceLock({
      name: "backup",
      owner: "process-two"
    });
    expect(
      store.acquireMaintenanceLock({
        name: "backup",
        owner: "process-three",
        leaseSeconds: 60,
        now: new Date("2026-07-17T01:01:31Z")
      })
    ).toBe(true);
    store.close();
  });

  it("commits result, four artifact rows, audit, and success under one fencing token", () => {
    const store = createStore(":memory:");
    const startedAt = new Date("2026-07-17T01:30:00Z");
    const created = store.createRun(
      command("subj_a", "key-success", "hash-success", "fp-success", startedAt)
    );
    if (created.outcome !== "created") {
      throw new Error("Expected a created run.");
    }
    const lease = store.acquireLease({
      workerId: "worker-success",
      leaseSeconds: 120,
      now: startedAt
    });
    if (!lease) {
      throw new Error("Expected a lease.");
    }
    const completedAt = new Date(startedAt.getTime() + 60_000);
    const artifacts = commitArtifacts(created.run.runId);
    expect(
      store.completeSuccessfulRun({
        token: lease.token,
        resultSchemaVersion: "doctor_research_result.v1",
        result: successfulResult(created.run.runId, completedAt, artifacts),
        artifacts,
        now: completedAt
      })
    ).toMatchObject({
      outcome: "succeeded",
      run: {
        status: "succeeded",
        stage: "complete",
        progressPercent: 100,
        activeElapsedMs: 60_000,
        completedAt
      }
    });
    expect(
      store.database
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM research_run_results) AS results,
             (SELECT COUNT(*) FROM research_artifacts) AS artifacts,
             (SELECT COUNT(*) FROM research_sources) AS sources,
             (SELECT COUNT(*) FROM research_claims) AS claims,
             (SELECT COUNT(*) FROM research_references) AS refs,
             (SELECT COUNT(*) FROM research_audit_events
                WHERE action = 'run_succeeded') AS audits`
        )
        .get()
    ).toEqual({
      results: 1,
      artifacts: 4,
      sources: 2,
      claims: 1,
      refs: 1,
      audits: 1
    });
    expect(
      store.getRunForSubject(created.run.runId, "subj_a")
    ).toMatchObject({
      canonicalIdentityId: "dci_example01"
    });
    expect(
      store.database
        .prepare(
          `SELECT canonical_identity_id, doctor_key
           FROM research_doctor_admissions
           WHERE run_id = ?`
        )
        .get(created.run.runId)
    ).toEqual({
      canonical_identity_id: "dci_example01",
      doctor_key: "dci:dci_example01"
    });
    expect(
      (
        store.database
          .prepare(
            `SELECT COUNT(DISTINCT kind) AS kinds,
                    COUNT(DISTINCT filename_ascii) AS ascii_names,
                    COUNT(DISTINCT filename_utf8) AS utf8_names
             FROM research_artifacts`
          )
          .get() as {
          kinds: number;
          ascii_names: number;
          utf8_names: number;
        }
      )
    ).toEqual({ kinds: 4, ascii_names: 4, utf8_names: 4 });

    const secondCreated = store.createRun(
      command(
        "subj_b",
        "key-success-second",
        "hash-success-second",
        "fp-success-second",
        new Date(completedAt.getTime() + 1_000)
      )
    );
    if (secondCreated.outcome !== "created") {
      throw new Error("Expected a second created run.");
    }
    const secondLease = store.acquireLease({
      workerId: "worker-success",
      leaseSeconds: 120,
      now: new Date(completedAt.getTime() + 1_000)
    });
    if (!secondLease) {
      throw new Error("Expected a second lease.");
    }
    const secondArtifacts = commitArtifacts(secondCreated.run.runId, 4);
    expect(
      store.completeSuccessfulRun({
        token: secondLease.token,
        resultSchemaVersion: "doctor_research_result.v1",
        result: successfulResult(
          secondCreated.run.runId,
          new Date(completedAt.getTime() + 2_000),
          secondArtifacts
        ),
        artifacts: secondArtifacts,
        now: new Date(completedAt.getTime() + 2_000)
      })
    ).toMatchObject({ outcome: "succeeded" });
    expect(
      store.database
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM research_sources) AS sources,
             (SELECT COUNT(*) FROM research_claims) AS claims,
             (SELECT COUNT(*) FROM research_references) AS refs`
        )
        .get()
    ).toEqual({ sources: 4, claims: 2, refs: 2 });
    store.close();
  });

  it("lets a cancellation request win the fenced success race without partial rows", () => {
    const store = createStore(":memory:");
    const startedAt = new Date("2026-07-17T01:30:00Z");
    const created = store.createRun(
      command(
        "subj_a",
        "key-success-race",
        "hash-success-race",
        "fp-success-race",
        startedAt
      )
    );
    if (created.outcome !== "created") {
      throw new Error("Expected a created run.");
    }
    const lease = store.acquireLease({
      workerId: "worker-race",
      leaseSeconds: 120,
      now: startedAt
    });
    if (!lease) {
      throw new Error("Expected a lease.");
    }
    store.requestCancel({
      runId: created.run.runId,
      subjectId: "subj_a",
      credentialId: "cred_subj_a",
      requestId: "req-success-race-cancel",
      idempotencyKey: "cancel-success-race",
      requestHash: "cancel-success-race-hash",
      now: new Date(startedAt.getTime() + 30_000)
    });

    expect(
      store.completeSuccessfulRun({
        token: lease.token,
        resultSchemaVersion: "doctor_research_result.v1",
        result: successfulResult(
          created.run.runId,
          new Date(startedAt.getTime() + 31_000),
          commitArtifacts(created.run.runId)
        ),
        artifacts: commitArtifacts(created.run.runId),
        now: new Date(startedAt.getTime() + 31_000)
      })
    ).toEqual({ outcome: "fenced_or_cancelled" });
    expect(
      store.database
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM research_run_results) AS results,
             (SELECT COUNT(*) FROM research_artifacts) AS artifacts`
        )
        .get()
    ).toEqual({ results: 0, artifacts: 0 });
    expect(
      store.getRunForSubject(created.run.runId, "subj_a")
    ).toMatchObject({
      status: "running",
      cancelRequestedBy: "subject",
      terminalReason: null
    });
    store.close();
  });

  it("pauses for frozen identity candidates and resumes exactly once", () => {
    const store = createStore(":memory:");
    const startedAt = new Date("2026-07-17T01:30:00Z");
    const created = store.createRun(
      command(
        "subj_a",
        "key-identity",
        "hash-identity",
        "fp-identity",
        startedAt
      )
    );
    if (created.outcome !== "created") {
      throw new Error("Expected a created run.");
    }
    const lease = store.acquireLease({
      workerId: "worker-identity",
      leaseSeconds: 120,
      now: startedAt
    });
    if (!lease) {
      throw new Error("Expected a lease.");
    }
    const pausedAt = new Date(startedAt.getTime() + 10_000);
    expect(
      store.pauseForIdentity({
        token: lease.token,
        candidates: identityCandidates(),
        now: pausedAt
      })
    ).toMatchObject({
      outcome: "needs_input",
      run: {
        status: "needs_input",
        stage: "resolve_identity",
        activeElapsedMs: 10_000,
        leaseOwner: null,
        needsInputStartedAt: pausedAt,
        needsInputExpiresAt: new Date(
          pausedAt.getTime() + 72 * 60 * 60 * 1000
        )
      }
    });
    expect(
      store.listIdentityCandidatesForSubject(created.run.runId, "subj_a")
    ).toMatchObject([
      { candidateId: `dc_${"1".repeat(16)}`, score: 0.9 },
      { candidateId: `dc_${"2".repeat(16)}`, score: 0.8 }
    ]);
    expect(
      store.listIdentityCandidatesForSubject(created.run.runId, "subj_other")
    ).toEqual([]);

    const selectedAt = new Date(pausedAt.getTime() + 5_000);
    const selectionInput = {
      runId: created.run.runId,
      subjectId: "subj_a",
      credentialId: "cred_subj_a",
      requestId: "req-select-identity",
      idempotencyKey: "select-identity-key",
      requestHash: "select-identity-hash",
      selection: {
        action: "select" as const,
        candidateId: `dc_${"1".repeat(16)}`
      },
      now: selectedAt
    };
    expect(store.resolveIdentity(selectionInput)).toMatchObject({
      outcome: "accepted",
      run: {
        status: "queued",
        stage: "collect_profile_evidence",
        canonicalIdentityId: "dci_example01",
        resumeCount: 1,
        attemptCount: 1,
        needsInputExpiresAt: null
      }
    });
    expect(
      store.resolveIdentity({
        ...selectionInput,
        now: new Date(selectedAt.getTime() + 1_000)
      })
    ).toMatchObject({
      outcome: "replayed",
      receipt: {
        request_id: "req-select-identity",
        canonical_identity_id: "dci_example01"
      }
    });
    expect(
      store.resolveIdentity({
        ...selectionInput,
        requestHash: "different-selection-hash",
        now: new Date(selectedAt.getTime() + 2_000)
      })
    ).toEqual({ outcome: "idempotency_conflict" });
    expect(
      store.database
        .prepare(
          `SELECT action, outcome, COUNT(*) AS count
           FROM research_audit_events
           WHERE run_id = ?
             AND action IN ('idempotency_replay', 'idempotency_conflict')
           GROUP BY action, outcome
           ORDER BY action`
        )
        .all(created.run.runId)
    ).toEqual([
      { action: "idempotency_conflict", outcome: "rejected", count: 1 },
      { action: "idempotency_replay", outcome: "ok", count: 1 }
    ]);
    expect(
      store.database
        .prepare(
          `SELECT canonical_identity_id, doctor_key
           FROM research_doctor_admissions
           WHERE run_id = ?`
        )
        .get(created.run.runId)
    ).toEqual({
      canonical_identity_id: "dci_example01",
      doctor_key: "dci:dci_example01"
    });
    expect(
      (
        store.database
          .prepare(
            `SELECT COUNT(*) AS count
             FROM research_audit_events
             WHERE run_id = ? AND action = 'identity_selection'
               AND outcome = 'ok'`
          )
          .get(created.run.runId) as { count: number }
      ).count
    ).toBe(1);
    store.close();
  });

  it("keeps needs-input unchanged on active quota rejection and allows same-key retry", () => {
    const store = createStore(":memory:");
    const startedAt = new Date("2026-07-17T01:30:00Z");
    const first = store.createRun(
      command(
        "subj_a",
        "key-needs-quota",
        "hash-needs-quota",
        "fp-needs-quota",
        startedAt
      )
    );
    if (first.outcome !== "created") {
      throw new Error("Expected a created run.");
    }
    const lease = store.acquireLease({
      workerId: "worker-needs-quota",
      leaseSeconds: 120,
      now: startedAt
    });
    if (!lease) {
      throw new Error("Expected a lease.");
    }
    store.pauseForIdentity({
      token: lease.token,
      candidates: identityCandidates(),
      now: new Date(startedAt.getTime() + 10_000)
    });
    const second = store.createRun(
      command(
        "subj_a",
        "key-other-active",
        "hash-other-active",
        "fp-other-active",
        new Date(startedAt.getTime() + 11_000)
      )
    );
    if (second.outcome !== "created") {
      throw new Error("Expected a second active run.");
    }
    const selection = {
      runId: first.run.runId,
      subjectId: "subj_a",
      credentialId: "cred_subj_a",
      requestId: "req-needs-quota",
      idempotencyKey: "needs-quota-selection",
      requestHash: "needs-quota-selection-hash",
      selection: {
        action: "select" as const,
        candidateId: `dc_${"1".repeat(16)}`
      },
      now: new Date(startedAt.getTime() + 12_000)
    };
    expect(store.resolveIdentity(selection)).toEqual({
      outcome: "rate_limited",
      limitKind: "research_active_brief"
    });
    expect(store.getRunForSubject(first.run.runId, "subj_a")).toMatchObject({
      status: "needs_input",
      resumeCount: 0,
      canonicalIdentityId: null
    });
    expect(
      store.database
        .prepare(
          `SELECT selected_at, rejected_at
           FROM research_identity_candidates
           WHERE run_id = ?
           ORDER BY candidate_id`
        )
        .all(first.run.runId)
    ).toEqual([
      { selected_at: null, rejected_at: null },
      { selected_at: null, rejected_at: null }
    ]);
    expect(
      (
        store.database
          .prepare(
            `SELECT COUNT(*) AS count
             FROM research_idempotency_keys
             WHERE endpoint LIKE '%/identity-selection'`
          )
          .get() as { count: number }
      ).count
    ).toBe(0);

    store.requestCancel({
      runId: second.run.runId,
      subjectId: "subj_a",
      credentialId: "cred_subj_a",
      requestId: "req-cancel-other-active",
      idempotencyKey: "cancel-other-active",
      requestHash: "cancel-other-active-hash",
      now: new Date(startedAt.getTime() + 13_000)
    });
    expect(
      store.resolveIdentity({
        ...selection,
        now: new Date(startedAt.getTime() + 14_000)
      })
    ).toMatchObject({
      outcome: "accepted",
      run: { status: "queued", resumeCount: 1 }
    });
    store.close();
  });

  it("enforces checkpoint and public-result byte limits before persistence", () => {
    const store = createResearchSqliteStore({
      path: ":memory:",
      limits: {
        dailyRunsPerSubject: 10,
        uniqueDoctors30dPerSubject: 10,
        globalActiveRuns: 100,
        needsInputPerSubject: 10
      },
      maximumCheckpointBytes: 8,
      maximumResultBytes: 128
    });
    const startedAt = new Date("2026-07-17T01:30:00Z");
    const created = store.createRun(
      command("subj_a", "size-limits", "size-hash", "size-fp", startedAt)
    );
    if (created.outcome !== "created") {
      throw new Error("Expected a created run.");
    }
    const lease = store.acquireLease({
      workerId: "worker-size-limits",
      leaseSeconds: 120,
      now: startedAt
    });
    if (!lease) {
      throw new Error("Expected a lease.");
    }
    const checkpoint = { value: "too large" };
    expect(() =>
      store.writeCheckpoint({
        token: lease.token,
        stage: "discover_identity",
        checkpointVersion: 1,
        payload: checkpoint,
        payloadSha256: checkpointHash(checkpoint),
        progressPercent: 10,
        now: startedAt
      })
    ).toThrow("maximumCheckpointBytes");
    const completedAt = new Date(startedAt.getTime() + 30_000);
    const artifacts = commitArtifacts(created.run.runId);
    expect(() =>
      store.completeSuccessfulRun({
        token: lease.token,
        resultSchemaVersion: "doctor_research_result.v1",
        result: successfulResult(
          created.run.runId,
          completedAt,
          artifacts
        ),
        artifacts,
        now: completedAt
      })
    ).toThrow("maximumResultBytes");
    expect(
      store.database
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM research_checkpoints) AS checkpoints,
             (SELECT COUNT(*) FROM research_run_results) AS results`
        )
        .get()
    ).toEqual({ checkpoints: 0, results: 0 });
    store.close();
  });

  it("purges expired runs only after retained audits age out", () => {
    const store = createStore(":memory:");
    const now = new Date();
    const old = new Date(now.getTime() - 120 * 24 * 60 * 60 * 1_000);
    const created = store.createRun(
      command("subj_cleanup", "cleanup", "cleanup-hash", "cleanup-fp", old)
    );
    if (created.outcome !== "created") {
      throw new Error("Expected a created run.");
    }
    const artifactId = `dra_${"a".repeat(32)}`;
    const storagePath = `${created.run.runId}/${artifactId}.v1`;
    store.database
      .prepare(
        `INSERT INTO research_run_budgets (
           run_id, external_requests, external_response_bytes, llm_calls,
           input_tokens, output_tokens, updated_at
         ) VALUES (?, 1, 100, 1, 100, 100, ?)`
      )
      .run(created.run.runId, old.toISOString());
    store.database
      .prepare(
        `INSERT INTO research_artifacts (
          artifact_id, run_id, subject_id, kind, filename_ascii, filename_utf8,
          content_type, storage_path, storage_version, sha256, size_bytes,
          created_at, expires_at
        ) VALUES (?, ?, ?, 'profile', 'profile.md', 'profile.md',
                  'text/markdown; charset=utf-8', ?, 1, ?, 10, ?, ?)`
      )
      .run(
        artifactId,
        created.run.runId,
        "subj_cleanup",
        storagePath,
        "a".repeat(64),
        old.toISOString(),
        old.toISOString()
      );
    store.database
      .prepare(
        `UPDATE research_runs
         SET status = 'expired',
             purge_after = ?,
             expires_at = ?,
             active_started_at = NULL
         WHERE run_id = ?`
      )
      .run(old.toISOString(), old.toISOString(), created.run.runId);

    const cleaned = store.cleanupExpiredData({ now, batchSize: 100 });
    expect(cleaned).toMatchObject({
      runsDeleted: 1,
      auditEventsDeleted: expect.any(Number),
      admissionsDeleted: 1,
      artifactStorageRelativePaths: [storagePath]
    });
    expect(
      store.database
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM research_runs) AS runs,
             (SELECT COUNT(*) FROM research_run_budgets) AS budgets`
        )
        .get()
    ).toEqual({ runs: 0, budgets: 0 });
    store.close();
  });
});

function createStore(pathname: string) {
  return createResearchSqliteStore({
    path: pathname,
    limits: {
      dailyRunsPerSubject: 10,
      uniqueDoctors30dPerSubject: 10,
      globalActiveRuns: 100,
      needsInputPerSubject: 10
    }
  });
}

function command(
  subjectId: string,
  idempotencyKey: string,
  requestHash: string,
  identityFingerprint: string,
  now: Date
): CreateResearchRunInput {
  return {
    subjectId,
    credentialId: `cred_${subjectId}`,
    requestId: `req_${idempotencyKey}`,
    idempotencyKey,
    requestHash,
    identityFingerprint,
    input: runInput(`Doctor ${identityFingerprint}`),
    now
  };
}

function runInput(name: string): DoctorResearchRunInput {
  return {
    doctor: {
      name,
      hospital: "Example Hospital",
      department: "Cardiology",
      title: null,
      city: "Sydney",
      orcid: null
    },
    mode: "brief",
    language: "en",
    options: {
      publicationYears: 5,
      citationStyle: "vancouver"
    },
    clientReference: null
  };
}

function commitArtifacts(runId: string, suffixOffset = 0) {
  return (
    [
      ["1", "profile", "profile.md", "profile.md", "text/markdown; charset=utf-8"],
      ["2", "review", "review.md", "review.md", "text/markdown; charset=utf-8"],
      [
        "3",
        "questions",
        "questions.txt",
        "questions.txt",
        "text/plain; charset=utf-8"
      ],
      ["4", "answers", "answers.md", "answers.md", "text/markdown; charset=utf-8"]
    ] as const
  ).map(([suffix, kind, filenameAscii, filenameUtf8, contentType]) => {
    const uniqueSuffix = (
      Number.parseInt(suffix, 10) + suffixOffset
    ).toString(16);
    const artifactId = `dra_${uniqueSuffix.repeat(32)}`;
    return {
      artifactId,
      kind,
      filenameAscii,
      filenameUtf8,
      contentType,
      storageRelativePath: `${runId}/${artifactId}.v1`,
      storageVersion: 1,
      sha256: uniqueSuffix.repeat(64),
      sizeBytes: 10
    };
  });
}

function successfulResult(
  runId: string,
  completedAt: Date,
  artifacts: ReturnType<typeof commitArtifacts>
): DoctorResearchResult {
  const expiresAt = new Date(
    completedAt.getTime() + 30 * 24 * 60 * 60 * 1_000
  ).toISOString();
  return {
    schema_version: "doctor_research_result.v1",
    request_id: "req_success",
    run_id: runId,
    doctor: {
      name: "Example Doctor",
      hospital: "Example Hospital",
      department: "Cardiology"
    },
    identity_resolution: {
      status: "verified",
      confidence: "high",
      canonical_identity_id: "dci_example01",
      matched_by: ["institution", "department"]
    },
    sources: [
      {
        source_id: "src_official_1",
        source_type: "official_web",
        title: "Example Hospital Profile",
        url: "https://example.org/doctors/1",
        accessed_at: "2026-07-17T01:00:00.000Z",
        content_sha256: "a".repeat(64)
      },
      {
        source_id: "src_pubmed_1",
        source_type: "pubmed",
        title: "Example Publication",
        url: "https://pubmed.ncbi.nlm.nih.gov/1001/",
        accessed_at: "2026-07-17T01:00:00.000Z",
        content_sha256: "b".repeat(64)
      }
    ],
    profile: {
      positions: ["Consultant"],
      expertise: ["Evidence synthesis"],
      education_and_career: [],
      research_directions: ["Clinical evidence"],
      representative_outputs: ["Example Publication"],
      claims: [
        {
          claim_id: "clm_position_1",
          claim_type: "position",
          text: "Example Doctor is a consultant.",
          source_ids: ["src_official_1"],
          verification_status: "verified"
        }
      ],
      primary_public_source_ids: ["src_official_1"]
    },
    review: {
      title: "Example Evidence Review",
      abstract: "A validated example review.",
      keywords: ["evidence"],
      markdown: "Validated evidence [1].",
      core_evidence: [
        {
          reference_id: "ref_example",
          study_type: "cohort",
          sample_and_source: "Example cohort",
          methods: "Validated method",
          key_results: "Validated result",
          limitations: "Example fixture"
        }
      ],
      references: [
        {
          reference_id: "ref_example",
          title: "Example Publication",
          journal: "Example Journal",
          publication_year: 2025,
          pmid: "1001",
          doi: null,
          verification_status: "verified"
        }
      ],
      search_report: {
        databases: ["pubmed"],
        searched_at: "2026-07-17T01:00:00.000Z",
        queries: ["example query"],
        included_count: 1
      }
    },
    source_coverage: {
      literature_sources: ["pubmed"],
      profile_sources: ["official_web"],
      cutoff_date: "2026-07-17",
      warnings: []
    },
    predicted_questions: [
      "Question one?",
      "Question two?",
      "Question three?",
      "Question four?",
      "Question five?"
    ],
    answers: [1, 2, 3, 4, 5].map((questionIndex) => ({
      question_index: questionIndex,
      answer: `Answer ${questionIndex}.`,
      source_ids: ["src_pubmed_1"]
    })),
    quality: {
      status: "passed",
      checks: ["schema"],
      warnings: []
    },
    artifacts: artifacts.map((artifact) => ({
      artifact_id: artifact.artifactId,
      kind: artifact.kind,
      filename: artifact.filenameUtf8,
      content_type: artifact.contentType,
      size_bytes: artifact.sizeBytes,
      sha256: artifact.sha256,
      expires_at: expiresAt,
      download_url:
        `/gateway/research/v1/artifacts/${artifact.artifactId}/download`
    }))
  };
}

function checkpointHash(payload: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(payload), "utf8")
    .digest("hex");
}

function identityCandidates() {
  return [
    {
      candidateId: `dc_${"1".repeat(16)}`,
      canonicalIdentityId: "dci_example01",
      name: "Example Doctor",
      hospital: "Example Hospital",
      department: "Cardiology",
      city: "Sydney",
      sources: [
        {
          title: "Example Hospital Profile",
          url: "https://example.org/doctors/1"
        }
      ],
      evidenceTypes: ["institution", "department"] as const,
      score: 0.9
    },
    {
      candidateId: `dc_${"2".repeat(16)}`,
      canonicalIdentityId: "dci_example02",
      name: "Example Doctor",
      hospital: "Second Hospital",
      department: "Neurology",
      city: "Melbourne",
      sources: [
        {
          title: "Second Hospital Profile",
          url: "https://example.org/doctors/2"
        }
      ],
      evidenceTypes: ["institution", "research_topic"] as const,
      score: 0.8
    }
  ];
}
