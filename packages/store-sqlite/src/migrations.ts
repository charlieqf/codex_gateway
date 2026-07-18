import type { DatabaseSync } from "node:sqlite";
import {
  applyMigration,
  columnExists,
  tableExists
} from "./sqlite-managed.js";
import type { SqliteStoreLogger } from "./types.js";

export function migrateGatewaySchema(db: DatabaseSync, logger?: SqliteStoreLogger): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  applyMigration(
    db,
    1,
    `
      CREATE TABLE IF NOT EXISTS subjects (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        state TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS upstream_accounts (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        label TEXT NOT NULL,
        credential_ref TEXT NOT NULL,
        image_api_key_env TEXT,
        state TEXT NOT NULL,
        health_json TEXT,
        last_used_at TEXT,
        cooldown_until TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS access_credentials (
        id TEXT PRIMARY KEY,
        prefix TEXT NOT NULL UNIQUE,
        hash TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        label TEXT NOT NULL,
        scope TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        revoked_at TEXT,
        rate_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        rotates_id TEXT,
        FOREIGN KEY(subject_id) REFERENCES subjects(id),
        FOREIGN KEY(rotates_id) REFERENCES access_credentials(id)
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        subject_id TEXT NOT NULL,
        upstream_account_id TEXT NOT NULL,
        provider_session_ref TEXT,
        title TEXT,
        state TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(subject_id) REFERENCES subjects(id),
        FOREIGN KEY(upstream_account_id) REFERENCES upstream_accounts(id)
      );

      CREATE INDEX IF NOT EXISTS idx_sessions_subject_updated
        ON sessions(subject_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS request_events (
        request_id TEXT PRIMARY KEY,
        credential_id TEXT,
        subject_id TEXT,
        scope TEXT,
        session_id TEXT,
        upstream_account_id TEXT,
        provider TEXT,
        started_at TEXT NOT NULL,
        duration_ms INTEGER,
        first_byte_ms INTEGER,
        status TEXT NOT NULL,
        error_code TEXT,
        rate_limited INTEGER NOT NULL DEFAULT 0
      );
    `,
    logger
  );

  applyMigration(
    db,
    2,
    `
      CREATE INDEX IF NOT EXISTS idx_request_events_started_at
        ON request_events(started_at);

      CREATE INDEX IF NOT EXISTS idx_request_events_credential_started
        ON request_events(credential_id, started_at);

      CREATE INDEX IF NOT EXISTS idx_request_events_subject_started
        ON request_events(subject_id, started_at);
    `,
    logger
  );

  applyMigration(
    db,
    3,
    `
      CREATE TABLE IF NOT EXISTS admin_audit_events (
        id TEXT PRIMARY KEY,
        action TEXT NOT NULL,
        target_user_id TEXT,
        target_credential_id TEXT,
        target_credential_prefix TEXT,
        status TEXT NOT NULL,
        params_json TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_admin_audit_created_at
        ON admin_audit_events(created_at);

      CREATE INDEX IF NOT EXISTS idx_admin_audit_user_created
        ON admin_audit_events(target_user_id, created_at);

      CREATE INDEX IF NOT EXISTS idx_admin_audit_action_created
        ON admin_audit_events(action, created_at);
    `,
    logger
  );

  applyMigration(
    db,
    4,
    `
      ALTER TABLE request_events ADD COLUMN prompt_tokens INTEGER;
      ALTER TABLE request_events ADD COLUMN completion_tokens INTEGER;
      ALTER TABLE request_events ADD COLUMN total_tokens INTEGER;
      ALTER TABLE request_events ADD COLUMN cached_prompt_tokens INTEGER;
      ALTER TABLE request_events ADD COLUMN estimated_tokens INTEGER;
      ALTER TABLE request_events ADD COLUMN usage_source TEXT;
    `,
    logger
  );

  applyMigration(
    db,
    5,
    `
      ALTER TABLE subjects ADD COLUMN name TEXT;
      ALTER TABLE subjects ADD COLUMN phone_number TEXT;
    `,
    logger
  );

  applyMigration(
    db,
    6,
    `
      ALTER TABLE access_credentials ADD COLUMN token_ciphertext TEXT;
    `,
    logger
  );

  applyMigration(db, 7, () => migrateLegacyUpstreamAccountSchema(db), logger);

  applyMigration(
    db,
    8,
    `
      ALTER TABLE request_events ADD COLUMN limit_kind TEXT;
      ALTER TABLE request_events ADD COLUMN reservation_id TEXT;
      ALTER TABLE request_events ADD COLUMN over_request_limit INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE request_events ADD COLUMN identity_guard_hit INTEGER NOT NULL DEFAULT 0;

      CREATE TABLE IF NOT EXISTS token_windows (
        subject_id TEXT NOT NULL,
        window_kind TEXT NOT NULL CHECK (window_kind IN ('minute', 'day', 'month')),
        window_start TEXT NOT NULL,
        prompt_tokens INTEGER NOT NULL DEFAULT 0,
        completion_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        cached_prompt_tokens INTEGER NOT NULL DEFAULT 0,
        estimated_tokens INTEGER NOT NULL DEFAULT 0,
        requests INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(subject_id, window_kind, window_start),
        FOREIGN KEY(subject_id) REFERENCES subjects(id)
      );

      CREATE TABLE IF NOT EXISTS token_reservations (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL CHECK (kind IN ('reservation', 'soft_write')),
        credential_id TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        scope TEXT NOT NULL,
        upstream_account_id TEXT,
        provider TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT,
        finalized_at TEXT,
        estimated_prompt_tokens INTEGER NOT NULL DEFAULT 0,
        estimated_total_tokens INTEGER NOT NULL DEFAULT 0,
        reserved_tokens INTEGER NOT NULL DEFAULT 0,
        final_prompt_tokens INTEGER NOT NULL DEFAULT 0,
        final_completion_tokens INTEGER NOT NULL DEFAULT 0,
        final_total_tokens INTEGER NOT NULL DEFAULT 0,
        final_cached_prompt_tokens INTEGER NOT NULL DEFAULT 0,
        final_estimated_tokens INTEGER NOT NULL DEFAULT 0,
        final_usage_source TEXT,
        charge_policy_snapshot TEXT NOT NULL CHECK (charge_policy_snapshot IN ('none', 'estimate', 'reserve')),
        minute_window_start TEXT NOT NULL,
        day_window_start TEXT NOT NULL,
        month_window_start TEXT NOT NULL,
        max_prompt_tokens_per_request INTEGER,
        max_total_tokens_per_request INTEGER,
        over_request_limit INTEGER NOT NULL DEFAULT 0,
        policy_json TEXT,
        FOREIGN KEY(subject_id) REFERENCES subjects(id),
        FOREIGN KEY(credential_id) REFERENCES access_credentials(id)
      );

      CREATE INDEX IF NOT EXISTS idx_token_reservations_subject_created
        ON token_reservations(subject_id, created_at);

      CREATE INDEX IF NOT EXISTS idx_token_reservations_subject_active_minute
        ON token_reservations(subject_id, minute_window_start, finalized_at, expires_at);

      CREATE INDEX IF NOT EXISTS idx_token_reservations_subject_active_day
        ON token_reservations(subject_id, day_window_start, finalized_at, expires_at);

      CREATE INDEX IF NOT EXISTS idx_token_reservations_subject_active_month
        ON token_reservations(subject_id, month_window_start, finalized_at, expires_at);

      CREATE INDEX IF NOT EXISTS idx_token_reservations_finalized
        ON token_reservations(finalized_at);
    `,
    logger
  );

  applyMigration(
    db,
    9,
    () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS plans (
          id TEXT PRIMARY KEY,
          display_name TEXT NOT NULL,
          policy_json TEXT NOT NULL,
          scope_allowlist_json TEXT NOT NULL,
          priority_class INTEGER NOT NULL DEFAULT 5,
          team_pool_id TEXT,
          state TEXT NOT NULL CHECK (state IN ('active', 'deprecated')),
          created_at TEXT NOT NULL,
          metadata_json TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_plans_state
          ON plans(state);

        CREATE TRIGGER IF NOT EXISTS trg_plans_policy_immutable
        BEFORE UPDATE OF policy_json ON plans
        BEGIN
          SELECT RAISE(ABORT, 'plans.policy_json is immutable');
        END;

        CREATE TABLE IF NOT EXISTS entitlements (
          id TEXT PRIMARY KEY,
          subject_id TEXT NOT NULL,
          plan_id TEXT NOT NULL,
          policy_snapshot_json TEXT NOT NULL,
          scope_allowlist_json TEXT NOT NULL,
          period_kind TEXT NOT NULL CHECK (period_kind IN ('monthly', 'one_off', 'unlimited')),
          period_start TEXT NOT NULL,
          period_end TEXT,
          state TEXT NOT NULL CHECK (state IN ('scheduled', 'active', 'paused', 'expired', 'cancelled')),
          team_seat_id TEXT,
          created_at TEXT NOT NULL,
          cancelled_at TEXT,
          cancelled_reason TEXT,
          notes TEXT,
          FOREIGN KEY(subject_id) REFERENCES subjects(id),
          FOREIGN KEY(plan_id) REFERENCES plans(id)
        );

        CREATE INDEX IF NOT EXISTS idx_entitlements_subject_active
          ON entitlements(subject_id, state, period_end);

        CREATE INDEX IF NOT EXISTS idx_entitlements_plan
          ON entitlements(plan_id);

        CREATE TABLE IF NOT EXISTS entitlement_token_windows (
          entitlement_id TEXT NOT NULL,
          window_kind TEXT NOT NULL CHECK (window_kind IN ('minute', 'day', 'month')),
          window_start TEXT NOT NULL,
          prompt_tokens INTEGER NOT NULL DEFAULT 0,
          completion_tokens INTEGER NOT NULL DEFAULT 0,
          total_tokens INTEGER NOT NULL DEFAULT 0,
          cached_prompt_tokens INTEGER NOT NULL DEFAULT 0,
          estimated_tokens INTEGER NOT NULL DEFAULT 0,
          requests INTEGER NOT NULL DEFAULT 0,
          updated_at TEXT NOT NULL,
          PRIMARY KEY(entitlement_id, window_kind, window_start),
          FOREIGN KEY(entitlement_id) REFERENCES entitlements(id)
        );

        CREATE INDEX IF NOT EXISTS idx_entitlement_token_windows_kind
          ON entitlement_token_windows(entitlement_id, window_kind, window_start DESC);
      `);
      if (!columnExists(db, "token_reservations", "entitlement_id")) {
        db.exec("ALTER TABLE token_reservations ADD COLUMN entitlement_id TEXT REFERENCES entitlements(id)");
      }
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_token_reservations_entitlement_created
          ON token_reservations(entitlement_id, created_at);
      `);
    },
    logger
  );

  applyMigration(
    db,
    10,
    `
      CREATE TABLE IF NOT EXISTS unified_client_keys (
        id TEXT PRIMARY KEY,
        prefix TEXT NOT NULL UNIQUE,
        hash TEXT NOT NULL UNIQUE,
        subject_id TEXT NOT NULL,
        label TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        revoked_at TEXT,
        codex_credential_id TEXT NOT NULL,
        codex_credential_prefix TEXT NOT NULL,
        codex_key_ciphertext TEXT NOT NULL,
        medevidence_key_ciphertext TEXT NOT NULL,
        medevidence_key_prefix TEXT,
        created_at TEXT NOT NULL,
        metadata_json TEXT,
        FOREIGN KEY(subject_id) REFERENCES subjects(id),
        FOREIGN KEY(codex_credential_id) REFERENCES access_credentials(id)
      );

      CREATE INDEX IF NOT EXISTS idx_unified_client_keys_subject_created
        ON unified_client_keys(subject_id, created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_unified_client_keys_codex_credential
        ON unified_client_keys(codex_credential_id);
    `,
    logger
  );

  applyMigration(
    db,
    11,
    () => {
      if (!columnExists(db, "plans", "feature_policy_json")) {
        db.exec(
          `ALTER TABLE plans ADD COLUMN feature_policy_json TEXT NOT NULL DEFAULT '{"capabilities":["chat","tools"]}'`
        );
      }
      if (!columnExists(db, "entitlements", "feature_policy_snapshot_json")) {
        db.exec(
          `ALTER TABLE entitlements ADD COLUMN feature_policy_snapshot_json TEXT NOT NULL DEFAULT '{"capabilities":["chat","tools"]}'`
        );
      }
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS trg_plans_feature_policy_immutable
        BEFORE UPDATE OF feature_policy_json ON plans
        BEGIN
          SELECT RAISE(ABORT, 'plans.feature_policy_json is immutable');
        END;
      `);
    },
    logger
  );

  applyMigration(
    db,
    12,
    `
      CREATE TABLE IF NOT EXISTS billing_events (
        id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        payload_hash TEXT NOT NULL,
        provider TEXT NOT NULL,
        external_order_id TEXT NOT NULL,
        external_event_id TEXT,
        event_type TEXT NOT NULL,
        apply_mode TEXT NOT NULL DEFAULT 'apply',
        subject_id TEXT NOT NULL,
        plan_id TEXT,
        entitlement_id TEXT,
        status TEXT NOT NULL,
        amount_minor INTEGER,
        currency TEXT,
        period_kind TEXT,
        period_start TEXT,
        period_end TEXT,
        applied_at TEXT,
        error_message TEXT,
        metadata_json TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY(subject_id) REFERENCES subjects(id),
        FOREIGN KEY(plan_id) REFERENCES plans(id),
        FOREIGN KEY(entitlement_id) REFERENCES entitlements(id)
      );

      CREATE INDEX IF NOT EXISTS idx_billing_events_provider_order_type
        ON billing_events(provider, external_order_id, event_type);

      CREATE INDEX IF NOT EXISTS idx_billing_events_subject_created
        ON billing_events(subject_id, created_at DESC);
    `,
    logger
  );

  applyMigration(
    db,
    13,
    () => {
      if (!columnExists(db, "subjects", "external_provider")) {
        db.exec("ALTER TABLE subjects ADD COLUMN external_provider TEXT");
      }
      if (!columnExists(db, "subjects", "external_user_id")) {
        db.exec("ALTER TABLE subjects ADD COLUMN external_user_id TEXT");
      }
      if (!columnExists(db, "subjects", "display_name")) {
        db.exec("ALTER TABLE subjects ADD COLUMN display_name TEXT");
      }
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_subjects_external_provider_user
          ON subjects(external_provider, external_user_id)
          WHERE external_provider IS NOT NULL AND external_user_id IS NOT NULL;

        CREATE TABLE IF NOT EXISTS upstream_v2_bindings (
          subject_id TEXT PRIMARY KEY,
          v2_user_id TEXT NOT NULL,
          v2_key_id TEXT,
          state TEXT NOT NULL CHECK (state IN ('active', 'disabled', 'pending')),
          last_synced_at TEXT,
          metadata_json TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(subject_id) REFERENCES subjects(id)
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_upstream_v2_user
          ON upstream_v2_bindings(v2_user_id);

        CREATE TABLE IF NOT EXISTS billing_subject_events (
          id TEXT PRIMARY KEY,
          idempotency_key TEXT NOT NULL UNIQUE,
          payload_hash TEXT NOT NULL,
          event_type TEXT NOT NULL,
          provider TEXT NOT NULL,
          external_user_id TEXT NOT NULL,
          subject_id TEXT NOT NULL,
          credential_id TEXT,
          credential_prefix TEXT,
          unified_key_id TEXT,
          unified_key_prefix TEXT,
          status TEXT NOT NULL,
          error_message TEXT,
          metadata_json TEXT,
          applied_at TEXT,
          created_at TEXT NOT NULL,
          FOREIGN KEY(subject_id) REFERENCES subjects(id),
          FOREIGN KEY(credential_id) REFERENCES access_credentials(id),
          FOREIGN KEY(unified_key_id) REFERENCES unified_client_keys(id)
        );

        CREATE INDEX IF NOT EXISTS idx_billing_subject_events_external
          ON billing_subject_events(provider, external_user_id, created_at DESC);

        CREATE INDEX IF NOT EXISTS idx_billing_subject_events_subject_created
          ON billing_subject_events(subject_id, created_at DESC);
      `);
    },
    logger
  );

  applyMigration(
    db,
    14,
    () => {
      if (!columnExists(db, "upstream_accounts", "image_api_key_env")) {
        db.exec("ALTER TABLE upstream_accounts ADD COLUMN image_api_key_env TEXT");
      }
    },
    logger
  );

  applyMigration(
    db,
    15,
    `
      CREATE TABLE IF NOT EXISTS billing_admin_tokens (
        id TEXT PRIMARY KEY,
        prefix TEXT NOT NULL UNIQUE,
        hash TEXT NOT NULL UNIQUE,
        label TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('test', 'live')),
        state TEXT NOT NULL CHECK (state IN ('active', 'revoked')),
        expires_at TEXT NOT NULL,
        revoked_at TEXT,
        created_at TEXT NOT NULL,
        last_used_at TEXT,
        metadata_json TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_billing_admin_tokens_state_expires
        ON billing_admin_tokens(state, expires_at);
    `,
    logger
  );

  applyMigration(
    db,
    16,
    () => {
      if (!columnExists(db, "request_events", "public_model_id")) {
        db.exec("ALTER TABLE request_events ADD COLUMN public_model_id TEXT");
      }
      if (!columnExists(db, "request_events", "upstream_runtime")) {
        db.exec("ALTER TABLE request_events ADD COLUMN upstream_runtime TEXT");
      }
      if (!columnExists(db, "request_events", "upstream_model")) {
        db.exec("ALTER TABLE request_events ADD COLUMN upstream_model TEXT");
      }
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_request_events_public_model_started
          ON request_events(public_model_id, started_at);

        CREATE INDEX IF NOT EXISTS idx_request_events_runtime_started
          ON request_events(upstream_runtime, started_at);
      `);
    },
    logger
  );

  applyMigration(
    db,
    17,
    () => {
      if (!columnExists(db, "request_events", "reasoning_effort")) {
        db.exec("ALTER TABLE request_events ADD COLUMN reasoning_effort TEXT");
      }
      if (!columnExists(db, "request_events", "reasoning_tokens")) {
        db.exec("ALTER TABLE request_events ADD COLUMN reasoning_tokens INTEGER");
      }
      if (!columnExists(db, "token_reservations", "public_model_id")) {
        db.exec("ALTER TABLE token_reservations ADD COLUMN public_model_id TEXT");
      }
      if (!columnExists(db, "token_reservations", "upstream_runtime")) {
        db.exec("ALTER TABLE token_reservations ADD COLUMN upstream_runtime TEXT");
      }
      if (!columnExists(db, "token_reservations", "upstream_model")) {
        db.exec("ALTER TABLE token_reservations ADD COLUMN upstream_model TEXT");
      }
      if (!columnExists(db, "token_reservations", "reasoning_effort")) {
        db.exec("ALTER TABLE token_reservations ADD COLUMN reasoning_effort TEXT");
      }
      if (!columnExists(db, "token_reservations", "final_reasoning_tokens")) {
        db.exec("ALTER TABLE token_reservations ADD COLUMN final_reasoning_tokens INTEGER");
      }
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_token_reservations_public_model_created
          ON token_reservations(public_model_id, created_at);

        CREATE INDEX IF NOT EXISTS idx_token_reservations_runtime_created
          ON token_reservations(upstream_runtime, created_at);
      `);
    },
    logger
  );

  applyMigration(
    db,
    18,
    () => {
      const columns: Array<[string, string]> = [
        ["client_turn_id", "TEXT"],
        ["turn_code", "TEXT"],
        ["client_session_id", "TEXT"],
        ["client_message_id", "TEXT"],
        ["client_app_version", "TEXT"],
        ["tool_choice", "TEXT"],
        ["upstream_finish_reason", "TEXT"],
        ["upstream_request_id", "TEXT"],
        ["upstream_http_status", "INTEGER"],
        ["upstream_content_chars", "INTEGER"],
        ["upstream_tool_call_count", "INTEGER"],
        ["upstream_tool_names_json", "TEXT"],
        ["upstream_raw_response_hash", "TEXT"],
        ["upstream_raw_response_chars", "INTEGER"],
        ["upstream_empty_stop", "INTEGER"]
      ];
      for (const [column, type] of columns) {
        if (!columnExists(db, "request_events", column)) {
          db.exec(`ALTER TABLE request_events ADD COLUMN ${column} ${type}`);
        }
      }

      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_request_events_client_turn_started
          ON request_events(client_turn_id, started_at DESC)
          WHERE client_turn_id IS NOT NULL;

        CREATE INDEX IF NOT EXISTS idx_request_events_turn_code_started
          ON request_events(turn_code, started_at DESC)
          WHERE turn_code IS NOT NULL;

        CREATE INDEX IF NOT EXISTS idx_request_events_client_message_started
          ON request_events(client_message_id, started_at DESC)
          WHERE client_message_id IS NOT NULL;
      `);
    },
    logger
  );

  applyMigration(
    db,
    19,
    () => {
      const columns: Array<[string, string]> = [
        ["upstream_attempt_count", "INTEGER"],
        ["upstream_attempts_json", "TEXT"]
      ];
      for (const [column, type] of columns) {
        if (!columnExists(db, "request_events", column)) {
          db.exec(`ALTER TABLE request_events ADD COLUMN ${column} ${type}`);
        }
      }
    },
    logger
  );

  applyMigration(
    db,
    20,
    () => {
      const columns: Array<[string, string]> = [
        ["gateway_estimated_prompt_tokens", "INTEGER"],
        ["gateway_prompt_estimate_method", "TEXT"],
        ["model_context_tokens", "INTEGER"],
        ["model_max_output_tokens", "INTEGER"],
        ["active_tool_count", "INTEGER"],
        ["client_tool_mode", "TEXT"],
        ["tool_loop_guard_json", "TEXT"]
      ];
      for (const [column, type] of columns) {
        if (!columnExists(db, "request_events", column)) {
          db.exec(`ALTER TABLE request_events ADD COLUMN ${column} ${type}`);
        }
      }
    },
    logger
  );

  applyMigration(
    db,
    21,
    () => {
      if (tableExists(db, "plans")) {
        db.exec(`
          DROP TRIGGER IF EXISTS trg_plans_policy_immutable;
          UPDATE plans
          SET policy_json = json_set(policy_json, '$.tokensPerMinute', 300000)
          WHERE json_valid(policy_json)
            AND json_type(policy_json, '$.tokensPerMinute') IN ('integer', 'real')
            AND json_extract(policy_json, '$.tokensPerMinute') < 300000;
          CREATE TRIGGER IF NOT EXISTS trg_plans_policy_immutable
          BEFORE UPDATE OF policy_json ON plans
          BEGIN
            SELECT RAISE(ABORT, 'plans.policy_json is immutable');
          END;
        `);
      }
      if (tableExists(db, "entitlements")) {
        db.exec(`
          UPDATE entitlements
          SET policy_snapshot_json = json_set(policy_snapshot_json, '$.tokensPerMinute', 300000)
          WHERE json_valid(policy_snapshot_json)
            AND json_type(policy_snapshot_json, '$.tokensPerMinute') IN ('integer', 'real')
            AND json_extract(policy_snapshot_json, '$.tokensPerMinute') < 300000;
        `);
      }
      if (tableExists(db, "access_credentials")) {
        db.exec(`
          UPDATE access_credentials
          SET rate_json = json_set(rate_json, '$.token.tokensPerMinute', 300000)
          WHERE json_valid(rate_json)
            AND json_type(rate_json, '$.token.tokensPerMinute') IN ('integer', 'real')
            AND json_extract(rate_json, '$.token.tokensPerMinute') < 300000;
        `);
      }
    },
    logger
  );

  applyMigration(
    db,
    22,
    () => {
      if (!tableExists(db, "access_credentials")) {
        return;
      }
      if (!columnExists(db, "access_credentials", "allowed_public_models_json")) {
        db.exec(
          "ALTER TABLE access_credentials ADD COLUMN allowed_public_models_json TEXT"
        );
      }
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS trg_access_credentials_allowed_public_models_insert
        BEFORE INSERT ON access_credentials
        WHEN NEW.allowed_public_models_json IS NOT NULL
        BEGIN
          SELECT CASE
            WHEN json_valid(NEW.allowed_public_models_json) = 0
              THEN RAISE(ABORT, 'access_credentials.allowed_public_models_json is invalid')
            WHEN json_type(NEW.allowed_public_models_json) <> 'array'
              THEN RAISE(ABORT, 'access_credentials.allowed_public_models_json is invalid')
            WHEN json_array_length(NEW.allowed_public_models_json) = 0
              THEN RAISE(ABORT, 'access_credentials.allowed_public_models_json is invalid')
            WHEN EXISTS (
              SELECT 1
              FROM json_each(NEW.allowed_public_models_json)
              WHERE type <> 'text'
                 OR value = ''
                 OR value <> trim(value)
                 OR length(value) > 64
                 OR value <> lower(value)
                 OR value NOT GLOB '[a-z]*'
                 OR value GLOB '*[^a-z0-9._-]*'
            )
              THEN RAISE(ABORT, 'access_credentials.allowed_public_models_json is invalid')
            WHEN (
              SELECT COUNT(*) FROM json_each(NEW.allowed_public_models_json)
            ) <> (
              SELECT COUNT(DISTINCT value) FROM json_each(NEW.allowed_public_models_json)
            )
              THEN RAISE(ABORT, 'access_credentials.allowed_public_models_json is invalid')
          END;
        END;

        CREATE TRIGGER IF NOT EXISTS trg_access_credentials_allowed_public_models_update
        BEFORE UPDATE OF allowed_public_models_json ON access_credentials
        WHEN NEW.allowed_public_models_json IS NOT NULL
        BEGIN
          SELECT CASE
            WHEN json_valid(NEW.allowed_public_models_json) = 0
              THEN RAISE(ABORT, 'access_credentials.allowed_public_models_json is invalid')
            WHEN json_type(NEW.allowed_public_models_json) <> 'array'
              THEN RAISE(ABORT, 'access_credentials.allowed_public_models_json is invalid')
            WHEN json_array_length(NEW.allowed_public_models_json) = 0
              THEN RAISE(ABORT, 'access_credentials.allowed_public_models_json is invalid')
            WHEN EXISTS (
              SELECT 1
              FROM json_each(NEW.allowed_public_models_json)
              WHERE type <> 'text'
                 OR value = ''
                 OR value <> trim(value)
                 OR length(value) > 64
                 OR value <> lower(value)
                 OR value NOT GLOB '[a-z]*'
                 OR value GLOB '*[^a-z0-9._-]*'
            )
              THEN RAISE(ABORT, 'access_credentials.allowed_public_models_json is invalid')
            WHEN (
              SELECT COUNT(*) FROM json_each(NEW.allowed_public_models_json)
            ) <> (
              SELECT COUNT(DISTINCT value) FROM json_each(NEW.allowed_public_models_json)
            )
              THEN RAISE(ABORT, 'access_credentials.allowed_public_models_json is invalid')
          END;
        END;
      `);
    },
    logger
  );

  applyMigration(
    db,
    23,
    () => {
      if (
        tableExists(db, "sessions") &&
        !columnExists(db, "sessions", "public_model_id")
      ) {
        db.exec("ALTER TABLE sessions ADD COLUMN public_model_id TEXT");
      }
    },
    logger
  );
}

export function migrateClientEventsSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  applyMigration(
    db,
    1,
    `
      CREATE TABLE IF NOT EXISTS client_message_events (
        id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        credential_id TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        scope TEXT NOT NULL,
        session_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        agent TEXT,
        provider_id TEXT,
        model_id TEXT,
        engine TEXT,
        text TEXT NOT NULL,
        text_sha256 TEXT NOT NULL,
        attachments_json TEXT NOT NULL,
        app_name TEXT,
        app_version TEXT,
        created_at TEXT NOT NULL,
        received_at TEXT NOT NULL,
        UNIQUE(subject_id, event_id)
      );

      CREATE INDEX IF NOT EXISTS idx_client_message_events_received_at
        ON client_message_events(received_at);

      CREATE INDEX IF NOT EXISTS idx_client_message_events_subject_received
        ON client_message_events(subject_id, received_at);

      CREATE INDEX IF NOT EXISTS idx_client_message_events_credential_received
        ON client_message_events(credential_id, received_at);

      CREATE INDEX IF NOT EXISTS idx_client_message_events_session_received
        ON client_message_events(session_id, received_at);

      CREATE INDEX IF NOT EXISTS idx_client_message_events_text_sha256
        ON client_message_events(text_sha256);
    `
  );

  applyMigration(
    db,
    2,
    `
      CREATE TABLE IF NOT EXISTS client_diagnostic_events (
        id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        credential_id TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        scope TEXT NOT NULL,
        session_id TEXT,
        message_id TEXT,
        category TEXT NOT NULL,
        action TEXT NOT NULL,
        status TEXT NOT NULL,
        method TEXT,
        path TEXT,
        duration_ms INTEGER,
        http_status INTEGER,
        error_code TEXT,
        error_message TEXT,
        metadata_json TEXT NOT NULL,
        app_name TEXT,
        app_version TEXT,
        created_at TEXT NOT NULL,
        received_at TEXT NOT NULL,
        UNIQUE(subject_id, event_id)
      );

      CREATE INDEX IF NOT EXISTS idx_client_diagnostic_events_received_at
        ON client_diagnostic_events(received_at);

      CREATE INDEX IF NOT EXISTS idx_client_diagnostic_events_subject_received
        ON client_diagnostic_events(subject_id, received_at);

      CREATE INDEX IF NOT EXISTS idx_client_diagnostic_events_credential_received
        ON client_diagnostic_events(credential_id, received_at);

      CREATE INDEX IF NOT EXISTS idx_client_diagnostic_events_session_received
        ON client_diagnostic_events(session_id, received_at);

      CREATE INDEX IF NOT EXISTS idx_client_diagnostic_events_action_received
        ON client_diagnostic_events(action, received_at);
    `
  );

  applyMigration(
    db,
    3,
    () => {
      if (!columnExists(db, "client_diagnostic_events", "tool_call_id")) {
        db.exec("ALTER TABLE client_diagnostic_events ADD COLUMN tool_call_id TEXT");
      }
      if (!columnExists(db, "client_diagnostic_events", "provider_id")) {
        db.exec("ALTER TABLE client_diagnostic_events ADD COLUMN provider_id TEXT");
      }
      if (!columnExists(db, "client_diagnostic_events", "model_id")) {
        db.exec("ALTER TABLE client_diagnostic_events ADD COLUMN model_id TEXT");
      }
      if (!columnExists(db, "client_diagnostic_events", "mono_ms")) {
        db.exec("ALTER TABLE client_diagnostic_events ADD COLUMN mono_ms REAL");
      }

      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_client_diag_session_message
          ON client_diagnostic_events(session_id, message_id, received_at);

        CREATE INDEX IF NOT EXISTS idx_client_diag_category_action
          ON client_diagnostic_events(category, action, status, received_at DESC);

        CREATE INDEX IF NOT EXISTS idx_client_diag_tool_call
          ON client_diagnostic_events(tool_call_id, received_at DESC)
          WHERE tool_call_id IS NOT NULL;
      `);
    }
  );

  applyMigration(
    db,
    4,
    `
      CREATE INDEX IF NOT EXISTS idx_client_diag_metadata_client_turn
        ON client_diagnostic_events(json_extract(metadata_json, '$.client_turn_id'), received_at DESC)
        WHERE json_extract(metadata_json, '$.client_turn_id') IS NOT NULL;

      CREATE INDEX IF NOT EXISTS idx_client_diag_metadata_turn_code
        ON client_diagnostic_events(json_extract(metadata_json, '$.turn_code'), received_at DESC)
        WHERE json_extract(metadata_json, '$.turn_code') IS NOT NULL;

      CREATE INDEX IF NOT EXISTS idx_client_diag_metadata_gateway_request
        ON client_diagnostic_events(json_extract(metadata_json, '$.gateway_request_id'), received_at DESC)
        WHERE json_extract(metadata_json, '$.gateway_request_id') IS NOT NULL;
    `
  );
}

function migrateLegacyUpstreamAccountSchema(db: DatabaseSync): void {
  if (tableExists(db, "subscriptions") && !tableExists(db, "upstream_accounts")) {
    db.exec("ALTER TABLE subscriptions RENAME TO upstream_accounts");
  }
  if (columnExists(db, "sessions", "subscription_id")) {
    db.exec("ALTER TABLE sessions RENAME COLUMN subscription_id TO upstream_account_id");
  }
  if (columnExists(db, "request_events", "subscription_id")) {
    db.exec("ALTER TABLE request_events RENAME COLUMN subscription_id TO upstream_account_id");
  }
}
