import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  AccessCredentialRecord,
  AdminAuditEventRecord,
  ClientMessageEventRecord,
  ClientMessageEventStore,
  CreateGatewaySessionInput,
  GatewaySession,
  GatewayStore,
  ListAccessCredentialsInput,
  ListAdminAuditEventsInput,
  ListRequestEventsInput,
  ListSubjectsInput,
  PruneRequestEventsInput,
  PruneRequestEventsResult,
  RequestEventRecord,
  RequestUsageReportInput,
  RequestUsageReportRow,
  RateLimitPolicy,
  Subject,
  SubjectState,
  UpstreamAccount,
  UpdateAccessCredentialInput
} from "@codex-gateway/core";

export interface SqliteStoreOptions {
  path: string;
  logger?: SqliteStoreLogger;
}

export interface SqliteStoreLogger {
  info(message: string): void;
}

export interface UpdateSubjectInput {
  label?: string;
  name?: string | null;
  phoneNumber?: string | null;
}

export class SqliteGatewayStore implements GatewayStore {
  readonly kind = "sqlite";
  readonly path: string;
  private readonly db: DatabaseSync;
  private readonly logger?: SqliteStoreLogger;

  constructor(options: SqliteStoreOptions) {
    this.path = options.path;
    this.logger = options.logger;
    if (options.path !== ":memory:") {
      mkdirSync(path.dirname(options.path), { recursive: true });
      const fd = openSync(options.path, "a", 0o600);
      closeSync(fd);
      chmodSync(options.path, 0o600);
    }
    this.db = new DatabaseSync(options.path);
    this.configure();
    this.migrate();
    this.tightenFilePermissions();
  }

  get database(): DatabaseSync {
    return this.db;
  }

  upsertSubject(subject: Subject): void {
    this.db
      .prepare(
        `INSERT INTO subjects (id, label, name, phone_number, state, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           label = excluded.label,
           name = COALESCE(excluded.name, subjects.name),
           phone_number = COALESCE(excluded.phone_number, subjects.phone_number)`
      )
      .run(
        subject.id,
        subject.label,
        subject.name ?? null,
        subject.phoneNumber ?? null,
        subject.state,
        subject.createdAt.toISOString()
      );
  }

  upsertUpstreamAccount(upstreamAccount: UpstreamAccount): void {
    this.db
      .prepare(
        `INSERT INTO upstream_accounts (
          id, provider, label, credential_ref, state, last_used_at, cooldown_until, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          provider = excluded.provider,
          label = excluded.label,
          credential_ref = excluded.credential_ref,
          updated_at = excluded.updated_at`
      )
      .run(
        upstreamAccount.id,
        upstreamAccount.provider,
        upstreamAccount.label,
        upstreamAccount.credentialRef,
        upstreamAccount.state,
        upstreamAccount.lastUsedAt?.toISOString() ?? null,
        upstreamAccount.cooldownUntil?.toISOString() ?? null,
        new Date().toISOString()
      );
  }

  getSubject(id: string): Subject | null {
    const row = this.db
      .prepare("SELECT id, label, name, phone_number, state, created_at FROM subjects WHERE id = ?")
      .get(id);

    return row ? rowToSubject(row) : null;
  }

  listSubjects(input: ListSubjectsInput = {}): Subject[] {
    const includeArchived = input.includeArchived ?? true;
    const rows = input.state
      ? this.db
          .prepare(
            `SELECT id, label, name, phone_number, state, created_at
             FROM subjects
             WHERE state = ?
               AND (? = 1 OR state != 'archived')
             ORDER BY id`
          )
          .all(input.state, includeArchived ? 1 : 0)
      : this.db
          .prepare(
            `SELECT id, label, name, phone_number, state, created_at
             FROM subjects
             WHERE (? = 1 OR state != 'archived')
             ORDER BY id`
          )
          .all(includeArchived ? 1 : 0);

    return rows.map(rowToSubject);
  }

  updateSubject(id: string, input: UpdateSubjectInput): Subject | null {
    this.db
      .prepare(
        `UPDATE subjects
         SET label = CASE WHEN ? = 1 THEN ? ELSE label END,
             name = CASE WHEN ? = 1 THEN ? ELSE name END,
             phone_number = CASE WHEN ? = 1 THEN ? ELSE phone_number END
         WHERE id = ?`
      )
      .run(
        input.label === undefined ? 0 : 1,
        input.label ?? null,
        input.name === undefined ? 0 : 1,
        input.name ?? null,
        input.phoneNumber === undefined ? 0 : 1,
        input.phoneNumber ?? null,
        id
      );

    return this.getSubject(id);
  }

  setSubjectState(id: string, state: SubjectState): Subject | null {
    this.db
      .prepare(
        `UPDATE subjects
         SET state = ?
         WHERE id = ?`
      )
      .run(state, id);

    return this.getSubject(id);
  }

  insertAccessCredential(record: AccessCredentialRecord): AccessCredentialRecord {
    this.db
      .prepare(
        `INSERT INTO access_credentials (
          id, prefix, hash, token_ciphertext, subject_id, label, scope, expires_at, revoked_at,
          rate_json, created_at, rotates_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.id,
        record.prefix,
        record.hash,
        record.tokenCiphertext ?? null,
        record.subjectId,
        record.label,
        record.scope,
        record.expiresAt.toISOString(),
        record.revokedAt?.toISOString() ?? null,
        JSON.stringify(record.rate),
        record.createdAt.toISOString(),
        record.rotatesId
      );

    return record;
  }

  getAccessCredentialByPrefix(prefix: string): AccessCredentialRecord | null {
    const row = this.db
      .prepare(
        `SELECT id, prefix, hash, token_ciphertext, subject_id, label, scope, expires_at, revoked_at,
                rate_json, created_at, rotates_id
         FROM access_credentials
         WHERE prefix = ?`
      )
      .get(prefix);

    return row ? rowToAccessCredential(row) : null;
  }

  listAccessCredentials(input: ListAccessCredentialsInput = {}): AccessCredentialRecord[] {
    const includeRevoked = input.includeRevoked ?? true;
    const rows = input.subjectId
      ? this.db
          .prepare(
            `SELECT id, prefix, hash, subject_id, label, scope, expires_at, revoked_at,
                    token_ciphertext, rate_json, created_at, rotates_id
             FROM access_credentials
             WHERE subject_id = ?
               AND (? = 1 OR revoked_at IS NULL)
             ORDER BY created_at DESC`
          )
          .all(input.subjectId, includeRevoked ? 1 : 0)
      : this.db
          .prepare(
            `SELECT id, prefix, hash, subject_id, label, scope, expires_at, revoked_at,
                    token_ciphertext, rate_json, created_at, rotates_id
             FROM access_credentials
             WHERE (? = 1 OR revoked_at IS NULL)
             ORDER BY created_at DESC`
          )
          .all(includeRevoked ? 1 : 0);

    return rows.map(rowToAccessCredential);
  }

  updateAccessCredentialByPrefix(
    prefix: string,
    input: UpdateAccessCredentialInput
  ): AccessCredentialRecord | null {
    this.db
      .prepare(
        `UPDATE access_credentials
         SET label = COALESCE(?, label),
             scope = COALESCE(?, scope),
             expires_at = COALESCE(?, expires_at),
             rate_json = COALESCE(?, rate_json)
         WHERE prefix = ?`
      )
      .run(
        input.label ?? null,
        input.scope ?? null,
        input.expiresAt?.toISOString() ?? null,
        input.rate ? JSON.stringify(input.rate) : null,
        prefix
      );

    return this.getAccessCredentialByPrefix(prefix);
  }

  revokeAccessCredentialByPrefix(
    prefix: string,
    now: Date = new Date()
  ): AccessCredentialRecord | null {
    this.db
      .prepare(
        `UPDATE access_credentials
         SET revoked_at = COALESCE(revoked_at, ?)
         WHERE prefix = ?`
      )
      .run(now.toISOString(), prefix);

    return this.getAccessCredentialByPrefix(prefix);
  }

  setAccessCredentialExpiresAtByPrefix(
    prefix: string,
    expiresAt: Date
  ): AccessCredentialRecord | null {
    this.db
      .prepare(
        `UPDATE access_credentials
         SET expires_at = ?
         WHERE prefix = ?`
      )
      .run(expiresAt.toISOString(), prefix);

    return this.getAccessCredentialByPrefix(prefix);
  }

  insertAdminAuditEvent(record: AdminAuditEventRecord): AdminAuditEventRecord {
    this.db
      .prepare(
        `INSERT INTO admin_audit_events (
          id, action, target_user_id, target_credential_id, target_credential_prefix,
          status, params_json, error_message, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.id,
        record.action,
        record.targetUserId,
        record.targetCredentialId,
        record.targetCredentialPrefix,
        record.status,
        record.params ? JSON.stringify(record.params) : null,
        record.errorMessage,
        record.createdAt.toISOString()
      );

    return record;
  }

  listAdminAuditEvents(input: ListAdminAuditEventsInput = {}): AdminAuditEventRecord[] {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (input.userId) {
      clauses.push("target_user_id = ?");
      params.push(input.userId);
    }
    if (input.action) {
      clauses.push("action = ?");
      params.push(input.action);
    }
    if (input.status) {
      clauses.push("status = ?");
      params.push(input.status);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(
        `SELECT id, action, target_user_id, target_credential_id, target_credential_prefix,
                status, params_json, error_message, created_at
         FROM admin_audit_events
         ${where}
         ORDER BY created_at DESC, id DESC
         LIMIT ?`
      )
      .all(...params, input.limit ?? 100);

    return rows.map(rowToAdminAuditEvent);
  }

  create(input: CreateGatewaySessionInput): GatewaySession {
    const now = input.now ?? new Date();
    const session: GatewaySession = {
      id: `sess_${randomUUID()}`,
      subjectId: input.subjectId,
      upstreamAccountId: input.upstreamAccountId,
      providerSessionRef: null,
      title: null,
      state: "active",
      createdAt: now,
      updatedAt: now
    };

    this.db
      .prepare(
        `INSERT INTO sessions (
          id, subject_id, upstream_account_id, provider_session_ref, title, state, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        session.id,
        session.subjectId,
        session.upstreamAccountId,
        session.providerSessionRef,
        session.title,
        session.state,
        session.createdAt.toISOString(),
        session.updatedAt.toISOString()
      );

    return session;
  }

  list(subjectId: string): GatewaySession[] {
    const rows = this.db
      .prepare(
        `SELECT id, subject_id, upstream_account_id, provider_session_ref, title, state, created_at, updated_at
         FROM sessions
         WHERE subject_id = ?
         ORDER BY updated_at DESC, created_at DESC`
      )
      .all(subjectId);

    return rows.map(rowToSession);
  }

  get(id: string): GatewaySession | null {
    const row = this.db
      .prepare(
        `SELECT id, subject_id, upstream_account_id, provider_session_ref, title, state, created_at, updated_at
         FROM sessions
         WHERE id = ?`
      )
      .get(id);

    return row ? rowToSession(row) : null;
  }

  setProviderSessionRef(id: string, providerSessionRef: string): GatewaySession | null {
    const updatedAt = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE sessions
         SET provider_session_ref = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(providerSessionRef, updatedAt, id);

    return this.get(id);
  }

  insertRequestEvent(record: RequestEventRecord): RequestEventRecord {
    this.db
      .prepare(
        `INSERT INTO request_events (
          request_id, credential_id, subject_id, scope, session_id, upstream_account_id, provider,
          started_at, duration_ms, first_byte_ms, status, error_code, rate_limited,
          prompt_tokens, completion_tokens, total_tokens, cached_prompt_tokens,
          estimated_tokens, usage_source, limit_kind, reservation_id, over_request_limit,
          identity_guard_hit
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(request_id) DO UPDATE SET
          credential_id = excluded.credential_id,
          subject_id = excluded.subject_id,
          scope = excluded.scope,
          session_id = excluded.session_id,
          upstream_account_id = excluded.upstream_account_id,
          provider = excluded.provider,
          started_at = excluded.started_at,
          duration_ms = excluded.duration_ms,
          first_byte_ms = excluded.first_byte_ms,
          status = excluded.status,
          error_code = excluded.error_code,
          rate_limited = excluded.rate_limited,
          prompt_tokens = excluded.prompt_tokens,
          completion_tokens = excluded.completion_tokens,
          total_tokens = excluded.total_tokens,
          cached_prompt_tokens = excluded.cached_prompt_tokens,
          estimated_tokens = excluded.estimated_tokens,
          usage_source = excluded.usage_source,
          limit_kind = excluded.limit_kind,
          reservation_id = excluded.reservation_id,
          over_request_limit = excluded.over_request_limit,
          identity_guard_hit = excluded.identity_guard_hit`
      )
      .run(
        record.requestId,
        record.credentialId,
        record.subjectId,
        record.scope,
        record.sessionId,
        record.upstreamAccountId,
        record.provider,
        record.startedAt.toISOString(),
        record.durationMs,
        record.firstByteMs,
        record.status,
        record.errorCode,
        record.rateLimited ? 1 : 0,
        record.promptTokens ?? null,
        record.completionTokens ?? null,
        record.totalTokens ?? null,
        record.cachedPromptTokens ?? null,
        record.estimatedTokens ?? null,
        record.usageSource ?? null,
        record.limitKind ?? null,
        record.reservationId ?? null,
        record.overRequestLimit === true ? 1 : 0,
        record.identityGuardHit === true ? 1 : 0
      );

    return record;
  }

  listRequestEvents(input: ListRequestEventsInput = {}): RequestEventRecord[] {
    const limit = input.limit ?? 100;
    const rows = input.credentialId
      ? this.db
          .prepare(
            `SELECT request_id, credential_id, subject_id, scope, session_id, upstream_account_id,
                    provider, started_at, duration_ms, first_byte_ms, status, error_code,
                    rate_limited, prompt_tokens, completion_tokens, total_tokens,
                    cached_prompt_tokens, estimated_tokens, usage_source, limit_kind,
                    reservation_id, over_request_limit, identity_guard_hit
             FROM request_events
             WHERE credential_id = ?
             ORDER BY started_at DESC
             LIMIT ?`
          )
          .all(input.credentialId, limit)
      : input.subjectId
        ? this.db
            .prepare(
              `SELECT request_id, credential_id, subject_id, scope, session_id, upstream_account_id,
                      provider, started_at, duration_ms, first_byte_ms, status, error_code,
                      rate_limited, prompt_tokens, completion_tokens, total_tokens,
                      cached_prompt_tokens, estimated_tokens, usage_source, limit_kind,
                      reservation_id, over_request_limit, identity_guard_hit
               FROM request_events
               WHERE subject_id = ?
               ORDER BY started_at DESC
               LIMIT ?`
            )
            .all(input.subjectId, limit)
        : this.db
            .prepare(
              `SELECT request_id, credential_id, subject_id, scope, session_id, upstream_account_id,
                      provider, started_at, duration_ms, first_byte_ms, status, error_code,
                      rate_limited, prompt_tokens, completion_tokens, total_tokens,
                      cached_prompt_tokens, estimated_tokens, usage_source, limit_kind,
                      reservation_id, over_request_limit, identity_guard_hit
               FROM request_events
               ORDER BY started_at DESC
               LIMIT ?`
            )
            .all(limit);

    return rows.map(rowToRequestEvent);
  }

  reportRequestUsage(input: RequestUsageReportInput): RequestUsageReportRow[] {
    const clauses = ["started_at >= ?"];
    const params: string[] = [input.since.toISOString()];
    if (input.until) {
      clauses.push("started_at < ?");
      params.push(input.until.toISOString());
    }
    if (input.credentialId) {
      clauses.push("credential_id = ?");
      params.push(input.credentialId);
    }
    if (input.subjectId) {
      clauses.push("subject_id = ?");
      params.push(input.subjectId);
    }

    const requestRows = this.db
      .prepare(
        `SELECT
           substr(started_at, 1, 10) AS date,
           credential_id,
           subject_id,
           scope,
           upstream_account_id,
           provider,
           COUNT(*) AS requests,
           SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) AS ok,
           SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors,
           SUM(CASE WHEN rate_limited = 1 THEN 1 ELSE 0 END) AS rate_limited,
           AVG(duration_ms) AS avg_duration_ms,
           AVG(first_byte_ms) AS avg_first_byte_ms,
           0 AS prompt_tokens,
           0 AS completion_tokens,
           0 AS total_tokens,
           0 AS cached_prompt_tokens,
           0 AS estimated_tokens,
           SUM(CASE WHEN limit_kind = 'request_minute' THEN 1 ELSE 0 END) AS request_minute,
           SUM(CASE WHEN limit_kind = 'request_day' THEN 1 ELSE 0 END) AS request_day,
           SUM(CASE WHEN limit_kind = 'concurrency' THEN 1 ELSE 0 END) AS concurrency,
           SUM(CASE WHEN limit_kind = 'token_minute' THEN 1 ELSE 0 END) AS token_minute,
           SUM(CASE WHEN limit_kind = 'token_day' THEN 1 ELSE 0 END) AS token_day,
           SUM(CASE WHEN limit_kind = 'token_month' THEN 1 ELSE 0 END) AS token_month,
           SUM(CASE WHEN limit_kind = 'token_request_prompt' THEN 1 ELSE 0 END) AS token_request_prompt,
           SUM(CASE WHEN limit_kind = 'token_request_total' THEN 1 ELSE 0 END) AS token_request_total,
           SUM(CASE WHEN over_request_limit = 1 THEN 1 ELSE 0 END) AS over_request_limit,
           SUM(CASE WHEN identity_guard_hit = 1 THEN 1 ELSE 0 END) AS identity_guard_hit
         FROM request_events
         WHERE ${clauses.join(" AND ")}
         GROUP BY
           substr(started_at, 1, 10),
           credential_id,
           subject_id,
           scope,
           upstream_account_id,
           provider
         ORDER BY date DESC, requests DESC, credential_id, subject_id`
      )
      .all(...params);

    const merged = new Map<string, RequestUsageReportRow>();
    for (const row of requestRows) {
      const report = rowToRequestUsageReport(row);
      merged.set(requestUsageReportKey(report), report);
    }

    for (const row of this.tokenUsageRows(input)) {
      const report =
        merged.get(tokenUsageAggregateKey(row)) ??
        emptyRequestUsageReportRow({
          date: row.date,
          credentialId: row.credential_id,
          subjectId: row.subject_id,
          scope: row.scope,
          upstreamAccountId: row.upstream_account_id,
          provider: row.provider
        });
      report.promptTokens += row.prompt_tokens;
      report.completionTokens += row.completion_tokens;
      report.totalTokens += row.total_tokens;
      report.cachedPromptTokens += row.cached_prompt_tokens;
      report.estimatedTokens += row.estimated_tokens;
      merged.set(requestUsageReportKey(report), report);
    }

    return Array.from(merged.values()).sort(compareRequestUsageRows);
  }

  private tokenUsageRows(input: RequestUsageReportInput): TokenUsageAggregateRow[] {
    const rows: TokenUsageAggregateRow[] = [];
    const reservationClauses = ["finalized_at IS NOT NULL", "created_at >= ?"];
    const reservationParams: string[] = [input.since.toISOString()];
    if (input.until) {
      reservationClauses.push("created_at < ?");
      reservationParams.push(input.until.toISOString());
    }
    if (input.credentialId) {
      reservationClauses.push("credential_id = ?");
      reservationParams.push(input.credentialId);
    }
    if (input.subjectId) {
      reservationClauses.push("subject_id = ?");
      reservationParams.push(input.subjectId);
    }

    rows.push(
      ...(this.db
        .prepare(
          `SELECT
             substr(day_window_start, 1, 10) AS date,
             credential_id,
             subject_id,
             scope,
             upstream_account_id,
             provider,
             COALESCE(SUM(final_prompt_tokens), 0) AS prompt_tokens,
             COALESCE(SUM(final_completion_tokens), 0) AS completion_tokens,
             COALESCE(SUM(final_total_tokens), 0) AS total_tokens,
             COALESCE(SUM(final_cached_prompt_tokens), 0) AS cached_prompt_tokens,
             COALESCE(SUM(final_estimated_tokens), 0) AS estimated_tokens
           FROM token_reservations
           WHERE ${reservationClauses.join(" AND ")}
           GROUP BY
             substr(day_window_start, 1, 10),
             credential_id,
             subject_id,
             scope,
             upstream_account_id,
             provider`
        )
        .all(...reservationParams) as unknown as TokenUsageAggregateRow[])
    );

    const legacyClauses = [
      "started_at >= ?",
      "reservation_id IS NULL",
      "total_tokens IS NOT NULL"
    ];
    const legacyParams: string[] = [input.since.toISOString()];
    if (input.until) {
      legacyClauses.push("started_at < ?");
      legacyParams.push(input.until.toISOString());
    }
    if (input.credentialId) {
      legacyClauses.push("credential_id = ?");
      legacyParams.push(input.credentialId);
    }
    if (input.subjectId) {
      legacyClauses.push("subject_id = ?");
      legacyParams.push(input.subjectId);
    }

    rows.push(
      ...(this.db
        .prepare(
          `SELECT
             substr(started_at, 1, 10) AS date,
             credential_id,
             subject_id,
             scope,
             upstream_account_id,
             provider,
             COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
             COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
             COALESCE(SUM(total_tokens), 0) AS total_tokens,
             COALESCE(SUM(cached_prompt_tokens), 0) AS cached_prompt_tokens,
             COALESCE(SUM(estimated_tokens), 0) AS estimated_tokens
           FROM request_events
           WHERE ${legacyClauses.join(" AND ")}
           GROUP BY
             substr(started_at, 1, 10),
             credential_id,
             subject_id,
             scope,
             upstream_account_id,
             provider`
        )
        .all(...legacyParams) as unknown as TokenUsageAggregateRow[])
    );

    return mergeTokenUsageRows(rows);
  }

  pruneRequestEvents(input: PruneRequestEventsInput): PruneRequestEventsResult {
    if (input.dryRun) {
      const row = this.db
        .prepare("SELECT COUNT(*) AS count FROM request_events WHERE started_at < ?")
        .get(input.before.toISOString()) as { count: number };
      return {
        before: input.before,
        dryRun: true,
        matched: row.count,
        deleted: 0
      };
    }

    const result = this.db
      .prepare("DELETE FROM request_events WHERE started_at < ?")
      .run(input.before.toISOString());
    const deleted = Number(result.changes);

    return {
      before: input.before,
      dryRun: false,
      matched: deleted,
      deleted
    };
  }

  close(): void {
    this.db.close();
  }

  private configure(): void {
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA journal_mode = WAL");
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `);

    this.applyMigration(1, `
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
    `);

    this.applyMigration(2, `
      CREATE INDEX IF NOT EXISTS idx_request_events_started_at
        ON request_events(started_at);

      CREATE INDEX IF NOT EXISTS idx_request_events_credential_started
        ON request_events(credential_id, started_at);

      CREATE INDEX IF NOT EXISTS idx_request_events_subject_started
        ON request_events(subject_id, started_at);
    `);

    this.applyMigration(3, `
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
    `);

    this.applyMigration(4, `
      ALTER TABLE request_events ADD COLUMN prompt_tokens INTEGER;
      ALTER TABLE request_events ADD COLUMN completion_tokens INTEGER;
      ALTER TABLE request_events ADD COLUMN total_tokens INTEGER;
      ALTER TABLE request_events ADD COLUMN cached_prompt_tokens INTEGER;
      ALTER TABLE request_events ADD COLUMN estimated_tokens INTEGER;
      ALTER TABLE request_events ADD COLUMN usage_source TEXT;
    `);

    this.applyMigration(5, `
      ALTER TABLE subjects ADD COLUMN name TEXT;
      ALTER TABLE subjects ADD COLUMN phone_number TEXT;
    `);

    this.applyMigration(6, `
      ALTER TABLE access_credentials ADD COLUMN token_ciphertext TEXT;
    `);

    this.applyMigration(7, () => {
      this.migrateLegacyUpstreamAccountSchema();
    });

    this.applyMigration(8, `
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
    `);
  }

  private applyMigration(version: number, migration: string | (() => void)): void {
    const existing = this.db
      .prepare("SELECT version FROM schema_migrations WHERE version = ?")
      .get(version);
    if (existing) {
      return;
    }

    this.db.exec("BEGIN");
    try {
      if (typeof migration === "string") {
        this.db.exec(migration);
      } else {
        migration();
      }
      this.db
        .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
        .run(version, new Date().toISOString());
      this.db.exec("COMMIT");
      this.logger?.info(`SQLite schema migrated to v${version}.`);
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  private migrateLegacyUpstreamAccountSchema(): void {
    if (this.tableExists("subscriptions") && !this.tableExists("upstream_accounts")) {
      this.db.exec("ALTER TABLE subscriptions RENAME TO upstream_accounts");
    }
    if (this.columnExists("sessions", "subscription_id")) {
      this.db.exec("ALTER TABLE sessions RENAME COLUMN subscription_id TO upstream_account_id");
    }
    if (this.columnExists("request_events", "subscription_id")) {
      this.db.exec(
        "ALTER TABLE request_events RENAME COLUMN subscription_id TO upstream_account_id"
      );
    }
  }

  private tableExists(table: string): boolean {
    const row = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table);
    return Boolean(row);
  }

  private columnExists(table: string, column: string): boolean {
    const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    return rows.some((row) => row.name === column);
  }

  private tightenFilePermissions(): void {
    if (this.path === ":memory:") {
      return;
    }

    for (const file of [this.path, `${this.path}-wal`, `${this.path}-shm`]) {
      if (existsSync(file)) {
        chmodSync(file, 0o600);
      }
    }
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

export class SqliteClientEventsStore implements ClientMessageEventStore {
  readonly kind = "sqlite-client-events";
  readonly path: string;
  private readonly db: DatabaseSync;

  constructor(options: SqliteStoreOptions) {
    this.path = options.path;
    if (options.path !== ":memory:") {
      mkdirSync(path.dirname(options.path), { recursive: true });
      const fd = openSync(options.path, "a", 0o600);
      closeSync(fd);
      chmodSync(options.path, 0o600);
    }
    this.db = new DatabaseSync(options.path);
    this.configure();
    this.migrate();
    this.tightenFilePermissions();
  }

  getClientMessageEvent(subjectId: string, eventId: string): ClientMessageEventRecord | null {
    const row = this.db
      .prepare(
        `SELECT id, event_id, request_id, credential_id, subject_id, scope, session_id,
                message_id, agent, provider_id, model_id, engine, text, text_sha256,
                attachments_json, app_name, app_version, created_at, received_at
         FROM client_message_events
         WHERE subject_id = ? AND event_id = ?`
      )
      .get(subjectId, eventId);

    return row ? rowToClientMessageEvent(row) : null;
  }

  insertClientMessageEvent(record: ClientMessageEventRecord): ClientMessageEventRecord {
    this.db
      .prepare(
        `INSERT INTO client_message_events (
          id, event_id, request_id, credential_id, subject_id, scope, session_id, message_id,
          agent, provider_id, model_id, engine, text, text_sha256, attachments_json,
          app_name, app_version, created_at, received_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.id,
        record.eventId,
        record.requestId,
        record.credentialId,
        record.subjectId,
        record.scope,
        record.sessionId,
        record.messageId,
        record.agent,
        record.providerId,
        record.modelId,
        record.engine,
        record.text,
        record.textSha256,
        record.attachmentsJson,
        record.appName,
        record.appVersion,
        record.createdAt.toISOString(),
        record.receivedAt.toISOString()
      );

    return record;
  }

  close(): void {
    this.db.close();
  }

  private configure(): void {
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA journal_mode = WAL");
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `);

    this.applyMigration(1, `
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
    `);
  }

  private applyMigration(version: number, sql: string): void {
    const existing = this.db
      .prepare("SELECT version FROM schema_migrations WHERE version = ?")
      .get(version);
    if (existing) {
      return;
    }

    this.db.exec("BEGIN");
    try {
      this.db.exec(sql);
      this.db
        .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
        .run(version, new Date().toISOString());
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  private tightenFilePermissions(): void {
    if (this.path === ":memory:") {
      return;
    }

    for (const file of [this.path, `${this.path}-wal`, `${this.path}-shm`]) {
      if (existsSync(file)) {
        chmodSync(file, 0o600);
      }
    }
  }
}

export function createSqliteClientEventsStore(
  options: SqliteStoreOptions
): SqliteClientEventsStore {
  return new SqliteClientEventsStore(options);
}

interface TokenUsageAggregateRow {
  date: string;
  credential_id: string | null;
  subject_id: string | null;
  scope: RequestUsageReportRow["scope"];
  upstream_account_id: string | null;
  provider: RequestUsageReportRow["provider"];
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cached_prompt_tokens: number;
  estimated_tokens: number;
}

function mergeTokenUsageRows(rows: TokenUsageAggregateRow[]): TokenUsageAggregateRow[] {
  const merged = new Map<string, TokenUsageAggregateRow>();
  for (const row of rows) {
    const key = tokenUsageAggregateKey(row);
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, { ...row });
      continue;
    }
    existing.prompt_tokens += row.prompt_tokens;
    existing.completion_tokens += row.completion_tokens;
    existing.total_tokens += row.total_tokens;
    existing.cached_prompt_tokens += row.cached_prompt_tokens;
    existing.estimated_tokens += row.estimated_tokens;
  }
  return Array.from(merged.values());
}

function emptyRequestUsageReportRow(input: {
  date: string;
  credentialId: string | null;
  subjectId: string | null;
  scope: RequestUsageReportRow["scope"];
  upstreamAccountId: string | null;
  provider: RequestUsageReportRow["provider"];
}): RequestUsageReportRow {
  return {
    date: input.date,
    credentialId: input.credentialId,
    subjectId: input.subjectId,
    scope: input.scope,
    upstreamAccountId: input.upstreamAccountId,
    provider: input.provider,
    requests: 0,
    ok: 0,
    errors: 0,
    rateLimited: 0,
    avgDurationMs: null,
    avgFirstByteMs: null,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cachedPromptTokens: 0,
    estimatedTokens: 0,
    rateLimitedBy: {},
    overRequestLimit: 0,
    identityGuardHit: 0
  };
}

function requestUsageReportKey(row: RequestUsageReportRow): string {
  return [
    row.date,
    row.credentialId ?? "",
    row.subjectId ?? "",
    row.scope ?? "",
    row.upstreamAccountId ?? "",
    row.provider ?? ""
  ].join("\u0000");
}

function tokenUsageAggregateKey(row: TokenUsageAggregateRow): string {
  return [
    row.date,
    row.credential_id ?? "",
    row.subject_id ?? "",
    row.scope ?? "",
    row.upstream_account_id ?? "",
    row.provider ?? ""
  ].join("\u0000");
}

function compareRequestUsageRows(
  first: RequestUsageReportRow,
  second: RequestUsageReportRow
): number {
  const dateCompare = second.date.localeCompare(first.date);
  if (dateCompare !== 0) {
    return dateCompare;
  }
  if (second.requests !== first.requests) {
    return second.requests - first.requests;
  }
  return requestUsageReportKey(first).localeCompare(requestUsageReportKey(second));
}

function rowToSession(row: unknown): GatewaySession {
  const value = row as {
    id: string;
    subject_id: string;
    upstream_account_id: string;
    provider_session_ref: string | null;
    title: string | null;
    state: GatewaySession["state"];
    created_at: string;
    updated_at: string;
  };

  return {
    id: value.id,
    subjectId: value.subject_id,
    upstreamAccountId: value.upstream_account_id,
    providerSessionRef: value.provider_session_ref,
    title: value.title,
    state: value.state,
    createdAt: new Date(value.created_at),
    updatedAt: new Date(value.updated_at)
  };
}

function rowToSubject(row: unknown): Subject {
  const value = row as {
    id: string;
    label: string;
    name: string | null;
    phone_number: string | null;
    state: Subject["state"];
    created_at: string;
  };

  return {
    id: value.id,
    label: value.label,
    name: value.name,
    phoneNumber: value.phone_number,
    state: value.state,
    createdAt: new Date(value.created_at)
  };
}

function rowToAccessCredential(row: unknown): AccessCredentialRecord {
  const value = row as {
    id: string;
    prefix: string;
    hash: string;
    token_ciphertext: string | null;
    subject_id: string;
    label: string;
    scope: AccessCredentialRecord["scope"];
    expires_at: string;
    revoked_at: string | null;
    rate_json: string;
    created_at: string;
    rotates_id: string | null;
  };

  return {
    id: value.id,
    prefix: value.prefix,
    hash: value.hash,
    tokenCiphertext: value.token_ciphertext,
    subjectId: value.subject_id,
    label: value.label,
    scope: value.scope,
    expiresAt: new Date(value.expires_at),
    revokedAt: value.revoked_at ? new Date(value.revoked_at) : null,
    rate: JSON.parse(value.rate_json) as RateLimitPolicy,
    createdAt: new Date(value.created_at),
    rotatesId: value.rotates_id
  };
}

function rowToRequestEvent(row: unknown): RequestEventRecord {
  const value = row as {
    request_id: string;
    credential_id: string | null;
    subject_id: string | null;
    scope: RequestEventRecord["scope"];
    session_id: string | null;
    upstream_account_id: string | null;
    provider: RequestEventRecord["provider"];
    started_at: string;
    duration_ms: number | null;
    first_byte_ms: number | null;
    status: RequestEventRecord["status"];
    error_code: string | null;
    rate_limited: number;
    prompt_tokens: number | null;
    completion_tokens: number | null;
    total_tokens: number | null;
    cached_prompt_tokens: number | null;
    estimated_tokens: number | null;
    usage_source: RequestEventRecord["usageSource"];
    limit_kind: RequestEventRecord["limitKind"];
    reservation_id: string | null;
    over_request_limit: number;
    identity_guard_hit: number;
  };

  return {
    requestId: value.request_id,
    credentialId: value.credential_id,
    subjectId: value.subject_id,
    scope: value.scope,
    sessionId: value.session_id,
    upstreamAccountId: value.upstream_account_id,
    provider: value.provider,
    startedAt: new Date(value.started_at),
    durationMs: value.duration_ms,
    firstByteMs: value.first_byte_ms,
    status: value.status,
    errorCode: value.error_code,
    rateLimited: value.rate_limited === 1,
    promptTokens: value.prompt_tokens,
    completionTokens: value.completion_tokens,
    totalTokens: value.total_tokens,
    cachedPromptTokens: value.cached_prompt_tokens,
    estimatedTokens: value.estimated_tokens,
    usageSource: value.usage_source,
    limitKind: value.limit_kind,
    reservationId: value.reservation_id,
    overRequestLimit: value.over_request_limit === 1,
    identityGuardHit: value.identity_guard_hit === 1
  };
}

function rowToAdminAuditEvent(row: unknown): AdminAuditEventRecord {
  const value = row as {
    id: string;
    action: AdminAuditEventRecord["action"];
    target_user_id: string | null;
    target_credential_id: string | null;
    target_credential_prefix: string | null;
    status: AdminAuditEventRecord["status"];
    params_json: string | null;
    error_message: string | null;
    created_at: string;
  };

  return {
    id: value.id,
    action: value.action,
    targetUserId: value.target_user_id,
    targetCredentialId: value.target_credential_id,
    targetCredentialPrefix: value.target_credential_prefix,
    status: value.status,
    params: value.params_json ? (JSON.parse(value.params_json) as Record<string, unknown>) : null,
    errorMessage: value.error_message,
    createdAt: new Date(value.created_at)
  };
}

function rowToClientMessageEvent(row: unknown): ClientMessageEventRecord {
  const value = row as {
    id: string;
    event_id: string;
    request_id: string;
    credential_id: string;
    subject_id: string;
    scope: ClientMessageEventRecord["scope"];
    session_id: string;
    message_id: string;
    agent: string | null;
    provider_id: string | null;
    model_id: string | null;
    engine: string | null;
    text: string;
    text_sha256: string;
    attachments_json: string;
    app_name: string | null;
    app_version: string | null;
    created_at: string;
    received_at: string;
  };

  return {
    id: value.id,
    eventId: value.event_id,
    requestId: value.request_id,
    credentialId: value.credential_id,
    subjectId: value.subject_id,
    scope: value.scope,
    sessionId: value.session_id,
    messageId: value.message_id,
    agent: value.agent,
    providerId: value.provider_id,
    modelId: value.model_id,
    engine: value.engine,
    text: value.text,
    textSha256: value.text_sha256,
    attachmentsJson: value.attachments_json,
    appName: value.app_name,
    appVersion: value.app_version,
    createdAt: new Date(value.created_at),
    receivedAt: new Date(value.received_at)
  };
}

function rowToRequestUsageReport(row: unknown): RequestUsageReportRow {
  const value = row as {
    date: string;
    credential_id: string | null;
    subject_id: string | null;
    scope: RequestUsageReportRow["scope"];
    upstream_account_id: string | null;
    provider: RequestUsageReportRow["provider"];
    requests: number;
    ok: number;
    errors: number;
    rate_limited: number;
    avg_duration_ms: number | null;
    avg_first_byte_ms: number | null;
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    cached_prompt_tokens: number;
    estimated_tokens: number;
    request_minute: number;
    request_day: number;
    concurrency: number;
    token_minute: number;
    token_day: number;
    token_month: number;
    token_request_prompt: number;
    token_request_total: number;
    over_request_limit: number;
    identity_guard_hit: number;
  };

  return {
    date: value.date,
    credentialId: value.credential_id,
    subjectId: value.subject_id,
    scope: value.scope,
    upstreamAccountId: value.upstream_account_id,
    provider: value.provider,
    requests: value.requests,
    ok: value.ok,
    errors: value.errors,
    rateLimited: value.rate_limited,
    avgDurationMs: value.avg_duration_ms,
    avgFirstByteMs: value.avg_first_byte_ms,
    promptTokens: value.prompt_tokens,
    completionTokens: value.completion_tokens,
    totalTokens: value.total_tokens,
    cachedPromptTokens: value.cached_prompt_tokens,
    estimatedTokens: value.estimated_tokens,
    rateLimitedBy: {
      request_minute: value.request_minute,
      request_day: value.request_day,
      concurrency: value.concurrency,
      token_minute: value.token_minute,
      token_day: value.token_day,
      token_month: value.token_month,
      token_request_prompt: value.token_request_prompt,
      token_request_total: value.token_request_total
    },
    overRequestLimit: value.over_request_limit,
    identityGuardHit: value.identity_guard_hit
  };
}
