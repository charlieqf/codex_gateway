import type { DatabaseSync } from "node:sqlite";
import type { SqliteStoreLogger } from "./types.js";

export function migrateResearchSchema(
  db: DatabaseSync,
  logger?: SqliteStoreLogger
): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS research_schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  applyResearchMigration(
    db,
    1,
    `
      CREATE TABLE research_runs (
        run_id TEXT PRIMARY KEY,
        subject_id TEXT NOT NULL,
        credential_id TEXT,
        skill_name TEXT NOT NULL,
        skill_version TEXT NOT NULL,
        prompt_version TEXT NOT NULL,
        input_schema_version TEXT NOT NULL,
        output_schema_version TEXT NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('brief', 'full')),
        language TEXT NOT NULL CHECK (language IN ('zh-CN', 'en')),
        input_json TEXT NOT NULL CHECK (
          json_valid(input_json) AND json_type(input_json) = 'object'
        ),
        status TEXT NOT NULL CHECK (
          status IN (
            'queued', 'running', 'needs_input', 'succeeded',
            'failed', 'cancelled', 'expired'
          )
        ),
        stage TEXT NOT NULL CHECK (
          stage IN (
            'validate_input',
            'discover_identity',
            'resolve_identity',
            'collect_profile_evidence',
            'infer_research_topics',
            'build_search_strategy',
            'search_literature',
            'verify_metadata',
            'screen_and_extract_evidence',
            'synthesize_review',
            'generate_questions',
            'generate_answers',
            'validate_outputs',
            'render_artifacts',
            'complete'
          )
        ),
        progress_percent INTEGER NOT NULL DEFAULT 0
          CHECK (progress_percent BETWEEN 0 AND 100),
        canonical_identity_id TEXT,
        warning_codes_json TEXT NOT NULL DEFAULT '[]' CHECK (
          json_valid(warning_codes_json)
          AND json_type(warning_codes_json) = 'array'
        ),
        terminal_reason TEXT,
        terminal_detail_public TEXT,
        cancel_requested_at TEXT,
        cancel_requested_by TEXT CHECK (
          cancel_requested_by IN ('subject', 'operator', 'system')
        ),
        cancel_request_id TEXT,
        needs_input_expires_at TEXT,
        needs_input_started_at TEXT,
        queued_at TEXT NOT NULL,
        active_started_at TEXT,
        active_elapsed_ms INTEGER NOT NULL DEFAULT 0
          CHECK (active_elapsed_ms >= 0),
        lease_owner TEXT,
        lease_until TEXT,
        lease_generation INTEGER NOT NULL DEFAULT 0
          CHECK (lease_generation >= 0),
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
        resume_count INTEGER NOT NULL DEFAULT 0 CHECK (resume_count >= 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        expires_at TEXT,
        purge_after TEXT
      );

      CREATE INDEX idx_research_runs_subject_created
        ON research_runs(subject_id, created_at DESC, run_id DESC);
      CREATE INDEX idx_research_runs_status_created
        ON research_runs(status, created_at);
      CREATE INDEX idx_research_runs_status_queued
        ON research_runs(status, queued_at);
      CREATE INDEX idx_research_runs_lease_until
        ON research_runs(lease_until);
      CREATE INDEX idx_research_runs_needs_input_expires
        ON research_runs(needs_input_expires_at);
      CREATE INDEX idx_research_runs_expires
        ON research_runs(expires_at);
      CREATE INDEX idx_research_runs_purge_after
        ON research_runs(purge_after);
      CREATE UNIQUE INDEX uq_research_active_brief_subject
        ON research_runs(subject_id)
        WHERE mode = 'brief'
          AND status IN ('queued', 'running');

      CREATE TABLE research_run_results (
        run_id TEXT PRIMARY KEY REFERENCES research_runs(run_id)
          ON DELETE CASCADE,
        schema_version TEXT NOT NULL,
        result_json TEXT NOT NULL CHECK (
          json_valid(result_json) AND json_type(result_json) = 'object'
        ),
        result_sha256 TEXT NOT NULL,
        size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );

      CREATE TABLE research_idempotency_keys (
        subject_id TEXT NOT NULL,
        endpoint TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        run_id TEXT NOT NULL REFERENCES research_runs(run_id),
        response_status INTEGER,
        response_body_json TEXT CHECK (
          response_body_json IS NULL
          OR (json_valid(response_body_json) AND json_type(response_body_json) = 'object')
        ),
        replay_expires_at TEXT NOT NULL,
        tombstone_expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (subject_id, endpoint, idempotency_key)
      );
      CREATE INDEX idx_research_idempotency_tombstone
        ON research_idempotency_keys(tombstone_expires_at);

      CREATE TABLE research_stage_runs (
        stage_run_id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL REFERENCES research_runs(run_id),
        stage TEXT NOT NULL,
        attempt INTEGER NOT NULL CHECK (attempt > 0),
        lease_generation INTEGER NOT NULL CHECK (lease_generation > 0),
        input_sha256 TEXT,
        output_sha256 TEXT,
        duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
        prompt_tokens INTEGER CHECK (prompt_tokens IS NULL OR prompt_tokens >= 0),
        completion_tokens INTEGER CHECK (
          completion_tokens IS NULL OR completion_tokens >= 0
        ),
        gateway_request_id TEXT,
        error_code TEXT,
        error_detail_sanitized TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        UNIQUE (run_id, stage, attempt, lease_generation)
      );

      CREATE TABLE research_checkpoints (
        run_id TEXT NOT NULL REFERENCES research_runs(run_id),
        stage TEXT NOT NULL,
        checkpoint_version INTEGER NOT NULL CHECK (checkpoint_version > 0),
        payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
        payload_sha256 TEXT NOT NULL,
        lease_generation INTEGER NOT NULL CHECK (lease_generation > 0),
        created_at TEXT NOT NULL,
        PRIMARY KEY (run_id, stage, checkpoint_version)
      );

      CREATE TABLE research_identity_candidates (
        candidate_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES research_runs(run_id),
        candidate_json TEXT NOT NULL CHECK (
          json_valid(candidate_json) AND json_type(candidate_json) = 'object'
        ),
        evidence_json TEXT NOT NULL CHECK (
          json_valid(evidence_json) AND json_type(evidence_json) = 'array'
        ),
        score REAL NOT NULL,
        selected_at TEXT,
        rejected_at TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE research_sources (
        source_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES research_runs(run_id),
        source_type TEXT NOT NULL,
        url TEXT,
        title TEXT,
        content_sha256 TEXT,
        trust_tier TEXT NOT NULL,
        accessed_at TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (
          json_valid(metadata_json) AND json_type(metadata_json) = 'object'
        )
      );

      CREATE TABLE research_claims (
        claim_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES research_runs(run_id),
        claim_type TEXT NOT NULL,
        claim_text TEXT NOT NULL,
        source_ids_json TEXT NOT NULL CHECK (
          json_valid(source_ids_json) AND json_type(source_ids_json) = 'array'
        ),
        verification_status TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE research_references (
        reference_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES research_runs(run_id),
        pmid TEXT,
        doi TEXT,
        title TEXT NOT NULL,
        authors_json TEXT NOT NULL CHECK (
          json_valid(authors_json) AND json_type(authors_json) = 'array'
        ),
        journal TEXT,
        publication_year INTEGER,
        study_type TEXT,
        verification_status TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (
          json_valid(metadata_json) AND json_type(metadata_json) = 'object'
        )
      );

      CREATE TABLE research_artifacts (
        artifact_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES research_runs(run_id),
        subject_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        filename TEXT NOT NULL,
        content_type TEXT NOT NULL,
        storage_path TEXT NOT NULL,
        storage_version INTEGER NOT NULL CHECK (storage_version > 0),
        sha256 TEXT NOT NULL,
        size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        UNIQUE (run_id, kind),
        UNIQUE (storage_path)
      );
      CREATE INDEX idx_research_artifacts_subject
        ON research_artifacts(subject_id, created_at DESC);
      CREATE INDEX idx_research_artifacts_expires
        ON research_artifacts(expires_at);

      CREATE TABLE research_suppressions (
        suppression_id TEXT PRIMARY KEY,
        subject_id TEXT,
        identity_fingerprint TEXT,
        canonical_identity_id TEXT,
        reason_code TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT
      );

      CREATE TABLE research_doctor_admissions (
        run_id TEXT PRIMARY KEY REFERENCES research_runs(run_id),
        subject_id TEXT NOT NULL,
        identity_fingerprint TEXT NOT NULL,
        canonical_identity_id TEXT,
        doctor_key TEXT NOT NULL,
        admitted_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_research_admissions_subject_time
        ON research_doctor_admissions(subject_id, admitted_at);
      CREATE INDEX idx_research_admissions_subject_doctor_time
        ON research_doctor_admissions(subject_id, doctor_key, admitted_at);

      CREATE TABLE research_subject_identity_aliases (
        subject_id TEXT NOT NULL,
        identity_fingerprint TEXT NOT NULL,
        canonical_identity_id TEXT NOT NULL,
        verified_at TEXT NOT NULL,
        PRIMARY KEY (subject_id, identity_fingerprint)
      );

      CREATE TABLE research_worker_heartbeats (
        worker_id TEXT PRIMARY KEY,
        process_instance_id TEXT NOT NULL,
        version TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('starting', 'ready', 'draining')),
        started_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      );
      CREATE INDEX idx_research_worker_last_seen
        ON research_worker_heartbeats(last_seen_at);

      CREATE TABLE research_audit_events (
        event_id TEXT PRIMARY KEY,
        occurred_at TEXT NOT NULL,
        request_id TEXT,
        actor_type TEXT NOT NULL CHECK (
          actor_type IN ('subject', 'worker', 'operator', 'system')
        ),
        subject_id TEXT,
        credential_id TEXT,
        operator_id TEXT,
        run_id TEXT REFERENCES research_runs(run_id),
        artifact_id TEXT,
        action TEXT NOT NULL,
        outcome TEXT NOT NULL,
        params_json TEXT NOT NULL DEFAULT '{}' CHECK (
          json_valid(params_json) AND json_type(params_json) = 'object'
        )
      );
      CREATE INDEX idx_research_audit_time
        ON research_audit_events(occurred_at);
      CREATE INDEX idx_research_audit_run_time
        ON research_audit_events(run_id, occurred_at);
      CREATE TRIGGER trg_research_audit_no_update
        BEFORE UPDATE ON research_audit_events
        BEGIN
          SELECT RAISE(ABORT, 'research_audit_events is append-only');
        END;
      CREATE TRIGGER trg_research_audit_retain_90d
        BEFORE DELETE ON research_audit_events
        WHEN julianday(OLD.occurred_at) IS NULL
          OR julianday(OLD.occurred_at) > julianday('now', '-90 days')
        BEGIN
          SELECT RAISE(
            ABORT,
            'research_audit_events cannot be deleted during retention'
          );
        END;

      CREATE TABLE research_backup_runs (
        backup_id TEXT PRIMARY KEY,
        schema_version TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('running', 'succeeded', 'failed')),
        started_at TEXT NOT NULL,
        completed_at TEXT,
        manifest_sha256 TEXT,
        error_code TEXT
      );
      CREATE INDEX idx_research_backup_completed
        ON research_backup_runs(completed_at DESC);
    `,
    logger
  );

  applyResearchMigration(
    db,
    2,
    `
      DROP INDEX idx_research_artifacts_subject;
      DROP INDEX idx_research_artifacts_expires;

      ALTER TABLE research_artifacts RENAME TO research_artifacts_v1;

      CREATE TABLE research_artifacts (
        artifact_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES research_runs(run_id),
        subject_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (
          kind IN ('profile', 'review', 'questions', 'answers')
        ),
        filename_ascii TEXT NOT NULL,
        filename_utf8 TEXT NOT NULL,
        content_type TEXT NOT NULL,
        storage_path TEXT NOT NULL,
        storage_version INTEGER NOT NULL CHECK (storage_version > 0),
        sha256 TEXT NOT NULL,
        size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        UNIQUE (run_id, kind),
        UNIQUE (storage_path)
      );

      INSERT INTO research_artifacts (
        artifact_id, run_id, subject_id, kind, filename_ascii, filename_utf8,
        content_type, storage_path, storage_version, sha256, size_bytes,
        created_at, expires_at
      )
      SELECT
        artifact_id, run_id, subject_id, kind, filename, filename,
        content_type, storage_path, storage_version, sha256, size_bytes,
        created_at, expires_at
      FROM research_artifacts_v1;

      DROP TABLE research_artifacts_v1;

      CREATE INDEX idx_research_artifacts_subject
        ON research_artifacts(subject_id, created_at DESC);
      CREATE INDEX idx_research_artifacts_expires
        ON research_artifacts(expires_at);
    `,
    logger
  );

  applyResearchMigration(
    db,
    3,
    `
      CREATE TABLE research_run_budgets (
        run_id TEXT PRIMARY KEY REFERENCES research_runs(run_id),
        external_requests INTEGER NOT NULL DEFAULT 0
          CHECK (external_requests >= 0),
        external_response_bytes INTEGER NOT NULL DEFAULT 0
          CHECK (external_response_bytes >= 0),
        llm_calls INTEGER NOT NULL DEFAULT 0 CHECK (llm_calls >= 0),
        input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
        output_tokens INTEGER NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
        updated_at TEXT NOT NULL
      );
    `,
    logger
  );

  applyResearchMigration(
    db,
    4,
    `
      ALTER TABLE research_sources RENAME TO research_sources_v1;
      CREATE TABLE research_sources (
        source_id TEXT NOT NULL,
        run_id TEXT NOT NULL REFERENCES research_runs(run_id),
        source_type TEXT NOT NULL,
        url TEXT,
        title TEXT,
        content_sha256 TEXT,
        trust_tier TEXT NOT NULL,
        accessed_at TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (
          json_valid(metadata_json) AND json_type(metadata_json) = 'object'
        ),
        PRIMARY KEY (run_id, source_id)
      );
      INSERT INTO research_sources (
        source_id, run_id, source_type, url, title, content_sha256,
        trust_tier, accessed_at, metadata_json
      )
      SELECT
        source_id, run_id, source_type, url, title, content_sha256,
        trust_tier, accessed_at, metadata_json
      FROM research_sources_v1;
      DROP TABLE research_sources_v1;
      CREATE INDEX idx_research_sources_source
        ON research_sources(source_id);

      ALTER TABLE research_claims RENAME TO research_claims_v1;
      CREATE TABLE research_claims (
        claim_id TEXT NOT NULL,
        run_id TEXT NOT NULL REFERENCES research_runs(run_id),
        claim_type TEXT NOT NULL,
        claim_text TEXT NOT NULL,
        source_ids_json TEXT NOT NULL CHECK (
          json_valid(source_ids_json) AND json_type(source_ids_json) = 'array'
        ),
        verification_status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (run_id, claim_id)
      );
      INSERT INTO research_claims (
        claim_id, run_id, claim_type, claim_text, source_ids_json,
        verification_status, created_at
      )
      SELECT
        claim_id, run_id, claim_type, claim_text, source_ids_json,
        verification_status, created_at
      FROM research_claims_v1;
      DROP TABLE research_claims_v1;
      CREATE INDEX idx_research_claims_claim
        ON research_claims(claim_id);

      ALTER TABLE research_references RENAME TO research_references_v1;
      CREATE TABLE research_references (
        reference_id TEXT NOT NULL,
        run_id TEXT NOT NULL REFERENCES research_runs(run_id),
        pmid TEXT,
        doi TEXT,
        title TEXT NOT NULL,
        authors_json TEXT NOT NULL CHECK (
          json_valid(authors_json) AND json_type(authors_json) = 'array'
        ),
        journal TEXT,
        publication_year INTEGER,
        study_type TEXT,
        verification_status TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (
          json_valid(metadata_json) AND json_type(metadata_json) = 'object'
        ),
        PRIMARY KEY (run_id, reference_id)
      );
      INSERT INTO research_references (
        reference_id, run_id, pmid, doi, title, authors_json, journal,
        publication_year, study_type, verification_status, metadata_json
      )
      SELECT
        reference_id, run_id, pmid, doi, title, authors_json, journal,
        publication_year, study_type, verification_status, metadata_json
      FROM research_references_v1;
      DROP TABLE research_references_v1;
      CREATE INDEX idx_research_references_reference
        ON research_references(reference_id);

      ALTER TABLE research_identity_candidates
        RENAME TO research_identity_candidates_v1;
      CREATE TABLE research_identity_candidates (
        candidate_id TEXT NOT NULL,
        run_id TEXT NOT NULL REFERENCES research_runs(run_id),
        candidate_json TEXT NOT NULL CHECK (
          json_valid(candidate_json) AND json_type(candidate_json) = 'object'
        ),
        evidence_json TEXT NOT NULL CHECK (
          json_valid(evidence_json) AND json_type(evidence_json) = 'array'
        ),
        score REAL NOT NULL,
        selected_at TEXT,
        rejected_at TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (run_id, candidate_id)
      );
      INSERT INTO research_identity_candidates (
        candidate_id, run_id, candidate_json, evidence_json, score,
        selected_at, rejected_at, created_at
      )
      SELECT
        candidate_id, run_id, candidate_json, evidence_json, score,
        selected_at, rejected_at, created_at
      FROM research_identity_candidates_v1;
      DROP TABLE research_identity_candidates_v1;
      CREATE INDEX idx_research_identity_candidates_candidate
        ON research_identity_candidates(candidate_id);
    `,
    logger
  );

  applyResearchMigration(
    db,
    5,
    `
      CREATE TABLE research_maintenance_locks (
        lock_name TEXT PRIMARY KEY CHECK (
          lock_name IN ('reconcile', 'cleanup', 'backup')
        ),
        owner TEXT NOT NULL,
        lease_until TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `,
    logger
  );

  applyResearchMigration(
    db,
    6,
    `
      CREATE TABLE IF NOT EXISTS research_stage_runs (
        stage_run_id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL REFERENCES research_runs(run_id),
        stage TEXT NOT NULL,
        attempt INTEGER NOT NULL CHECK (attempt > 0),
        lease_generation INTEGER NOT NULL CHECK (lease_generation > 0),
        input_sha256 TEXT,
        output_sha256 TEXT,
        duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
        prompt_tokens INTEGER CHECK (prompt_tokens IS NULL OR prompt_tokens >= 0),
        completion_tokens INTEGER CHECK (
          completion_tokens IS NULL OR completion_tokens >= 0
        ),
        gateway_request_id TEXT,
        error_code TEXT,
        error_detail_sanitized TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        UNIQUE (run_id, stage, attempt, lease_generation)
      );

      ALTER TABLE research_stage_runs ADD COLUMN prompt_chars INTEGER
        CHECK (prompt_chars IS NULL OR prompt_chars >= 0);
      ALTER TABLE research_stage_runs ADD COLUMN maximum_output_tokens INTEGER
        CHECK (maximum_output_tokens IS NULL OR maximum_output_tokens > 0);
      ALTER TABLE research_stage_runs ADD COLUMN admission_wait_ms INTEGER
        CHECK (admission_wait_ms IS NULL OR admission_wait_ms >= 0);
      ALTER TABLE research_stage_runs ADD COLUMN request_sent_at TEXT;
      ALTER TABLE research_stage_runs ADD COLUMN client_total_ms INTEGER
        CHECK (client_total_ms IS NULL OR client_total_ms >= 0);
      ALTER TABLE research_stage_runs ADD COLUMN terminal_source TEXT;
      ALTER TABLE research_stage_runs ADD COLUMN cancel_requested INTEGER
        CHECK (cancel_requested IS NULL OR cancel_requested IN (0, 1));
      ALTER TABLE research_stage_runs ADD COLUMN cancel_observed INTEGER
        CHECK (cancel_observed IS NULL OR cancel_observed IN (0, 1));
    `,
    logger
  );
}

function applyResearchMigration(
  db: DatabaseSync,
  version: number,
  migration: string,
  logger?: SqliteStoreLogger
): void {
  const existing = db
    .prepare("SELECT version FROM research_schema_migrations WHERE version = ?")
    .get(version);
  if (existing) {
    return;
  }
  db.exec("BEGIN");
  try {
    db.exec(migration);
    db.prepare(
      "INSERT INTO research_schema_migrations (version, applied_at) VALUES (?, ?)"
    ).run(version, new Date().toISOString());
    db.exec("COMMIT");
    logger?.info(`Research SQLite schema migrated to v${version}.`);
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
