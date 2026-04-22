import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { GatewaySession, Subject, Subscription } from "@codex-gateway/core";

export interface SqliteStoreOptions {
  path: string;
}

export interface CreateSessionInput {
  subjectId: string;
  subscriptionId: string;
  now?: Date;
}

export interface GatewaySessionStore {
  upsertSubject(subject: Subject): void;
  upsertSubscription(subscription: Subscription): void;
  create(input: CreateSessionInput): GatewaySession;
  list(subjectId: string): GatewaySession[];
  get(id: string): GatewaySession | null;
  setProviderSessionRef(id: string, providerSessionRef: string): GatewaySession | null;
  close?(): void;
}

export class SqliteGatewayStore implements GatewaySessionStore {
  readonly kind = "sqlite";
  readonly path: string;
  private readonly db: DatabaseSync;

  constructor(options: SqliteStoreOptions) {
    this.path = options.path;
    if (options.path !== ":memory:") {
      mkdirSync(path.dirname(options.path), { recursive: true });
    }
    this.db = new DatabaseSync(options.path);
    this.configure();
    this.migrate();
  }

  upsertSubject(subject: Subject): void {
    this.db
      .prepare(
        `INSERT INTO subjects (id, label, state, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           label = excluded.label,
           state = excluded.state`
      )
      .run(subject.id, subject.label, subject.state, subject.createdAt.toISOString());
  }

  upsertSubscription(subscription: Subscription): void {
    this.db
      .prepare(
        `INSERT INTO subscriptions (
          id, provider, label, credential_ref, state, last_used_at, cooldown_until, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          provider = excluded.provider,
          label = excluded.label,
          credential_ref = excluded.credential_ref,
          state = excluded.state,
          last_used_at = excluded.last_used_at,
          cooldown_until = excluded.cooldown_until,
          updated_at = excluded.updated_at`
      )
      .run(
        subscription.id,
        subscription.provider,
        subscription.label,
        subscription.credentialRef,
        subscription.state,
        subscription.lastUsedAt?.toISOString() ?? null,
        subscription.cooldownUntil?.toISOString() ?? null,
        new Date().toISOString()
      );
  }

  create(input: CreateSessionInput): GatewaySession {
    const now = input.now ?? new Date();
    const session: GatewaySession = {
      id: `sess_${randomUUID()}`,
      subjectId: input.subjectId,
      subscriptionId: input.subscriptionId,
      providerSessionRef: null,
      title: null,
      state: "active",
      createdAt: now,
      updatedAt: now
    };

    this.db
      .prepare(
        `INSERT INTO sessions (
          id, subject_id, subscription_id, provider_session_ref, title, state, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        session.id,
        session.subjectId,
        session.subscriptionId,
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
        `SELECT id, subject_id, subscription_id, provider_session_ref, title, state, created_at, updated_at
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
        `SELECT id, subject_id, subscription_id, provider_session_ref, title, state, created_at, updated_at
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

      CREATE TABLE IF NOT EXISTS subscriptions (
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
        subscription_id TEXT NOT NULL,
        provider_session_ref TEXT,
        title TEXT,
        state TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(subject_id) REFERENCES subjects(id),
        FOREIGN KEY(subscription_id) REFERENCES subscriptions(id)
      );

      CREATE INDEX IF NOT EXISTS idx_sessions_subject_updated
        ON sessions(subject_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS request_events (
        request_id TEXT PRIMARY KEY,
        credential_id TEXT,
        subject_id TEXT,
        scope TEXT,
        session_id TEXT,
        subscription_id TEXT,
        provider TEXT,
        started_at TEXT NOT NULL,
        duration_ms INTEGER,
        first_byte_ms INTEGER,
        status TEXT NOT NULL,
        error_code TEXT,
        rate_limited INTEGER NOT NULL DEFAULT 0
      );
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
}

export function createSqliteStore(options: SqliteStoreOptions): SqliteGatewayStore {
  return new SqliteGatewayStore(options);
}

function rowToSession(row: unknown): GatewaySession {
  const value = row as {
    id: string;
    subject_id: string;
    subscription_id: string;
    provider_session_ref: string | null;
    title: string | null;
    state: GatewaySession["state"];
    created_at: string;
    updated_at: string;
  };

  return {
    id: value.id,
    subjectId: value.subject_id,
    subscriptionId: value.subscription_id,
    providerSessionRef: value.provider_session_ref,
    title: value.title,
    state: value.state,
    createdAt: new Date(value.created_at),
    updatedAt: new Date(value.updated_at)
  };
}
