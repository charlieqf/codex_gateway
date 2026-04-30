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
