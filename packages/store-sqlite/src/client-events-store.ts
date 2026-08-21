import type { DatabaseSync } from "node:sqlite";
import type {
  ClientDiagnosticEventRecord,
  ClientMessageEventRecord,
  ClientMessageEventStore,
  ListClientMessageEventsInput
} from "@codex-gateway/core";
import { migrateClientEventsSchema } from "./migrations.js";
import { rowToClientDiagnosticEvent, rowToClientMessageEvent } from "./row-mappers.js";
import {
  openConfiguredSqliteDatabase,
  tightenSqliteFilePermissions
} from "./sqlite-managed.js";
import type { SqliteStoreOptions } from "./types.js";

export class SqliteClientEventsStore implements ClientMessageEventStore {
  readonly kind = "sqlite-client-events";
  readonly path: string;
  private readonly db: DatabaseSync;

  constructor(options: SqliteStoreOptions) {
    this.path = options.path;
    this.db = openConfiguredSqliteDatabase(options.path);
    migrateClientEventsSchema(this.db);
    tightenSqliteFilePermissions(this.path);
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

  listClientMessageEvents(
    input: ListClientMessageEventsInput = {}
  ): ClientMessageEventRecord[] {
    const { where, params } = clientMessageWhere(input);
    const limit = clampListLimit(input.limit, 100, 1000);
    const offset = clampOffset(input.offset);
    const rows = this.db
      .prepare(
        `SELECT id, event_id, request_id, credential_id, subject_id, scope, session_id,
                message_id, agent, provider_id, model_id, engine, text, text_sha256,
                attachments_json, app_name, app_version, created_at, received_at
         FROM client_message_events
         ${where}
         ORDER BY received_at DESC, created_at DESC
         LIMIT ? OFFSET ?`
      )
      .all(...params, limit, offset);

    return rows.map(rowToClientMessageEvent);
  }

  countClientMessageEvents(input: ListClientMessageEventsInput = {}): number {
    const { where, params } = clientMessageWhere(input);
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM client_message_events
         ${where}`
      )
      .get(...params) as { count: number };
    return row.count;
  }

  findClientMessageEventByMessageId(
    subjectId: string,
    messageId: string
  ): ClientMessageEventRecord | null {
    const row = this.db
      .prepare(
        `SELECT id, event_id, request_id, credential_id, subject_id, scope, session_id,
                message_id, agent, provider_id, model_id, engine, text, text_sha256,
                attachments_json, app_name, app_version, created_at, received_at
         FROM client_message_events
         WHERE subject_id = ? AND message_id = ?
         ORDER BY received_at DESC
         LIMIT 1`
      )
      .get(subjectId, messageId);

    return row ? rowToClientMessageEvent(row) : null;
  }

  findLatestClientMessageEventForSession(
    subjectId: string,
    sessionId: string,
    createdAt: Date
  ): ClientMessageEventRecord | null {
    const row = this.db
      .prepare(
        `SELECT id, event_id, request_id, credential_id, subject_id, scope, session_id,
                message_id, agent, provider_id, model_id, engine, text, text_sha256,
                attachments_json, app_name, app_version, created_at, received_at
         FROM client_message_events
         WHERE subject_id = ? AND session_id = ? AND created_at <= ?
         ORDER BY created_at DESC, received_at DESC
         LIMIT 1`
      )
      .get(subjectId, sessionId, createdAt.toISOString());

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

  getClientDiagnosticEvent(subjectId: string, eventId: string): ClientDiagnosticEventRecord | null {
    const row = this.db
      .prepare(
        `SELECT id, event_id, request_id, credential_id, subject_id, scope, session_id,
                message_id, tool_call_id, provider_id, model_id, category, action,
                status, method, path, mono_ms, duration_ms, http_status, error_code,
                error_message, metadata_json, app_name, app_version, created_at,
                received_at
         FROM client_diagnostic_events
         WHERE subject_id = ? AND event_id = ?`
      )
      .get(subjectId, eventId);

    return row ? rowToClientDiagnosticEvent(row) : null;
  }

  listClientDiagnosticEventsForSession(
    subjectId: string,
    sessionId: string,
    fromCreatedAt: Date
  ): ClientDiagnosticEventRecord[] {
    return this.db
      .prepare(
        `SELECT id, event_id, request_id, credential_id, subject_id, scope, session_id,
                message_id, tool_call_id, provider_id, model_id, category, action,
                status, method, path, mono_ms, duration_ms, http_status, error_code,
                error_message, metadata_json, app_name, app_version, created_at,
                received_at
         FROM client_diagnostic_events
         WHERE subject_id = ? AND session_id = ? AND created_at >= ?
         ORDER BY created_at ASC, received_at ASC
         LIMIT 500`
      )
      .all(subjectId, sessionId, fromCreatedAt.toISOString())
      .map(rowToClientDiagnosticEvent);
  }

  updateClientDiagnosticEventLink(
    subjectId: string,
    eventId: string,
    input: { sessionId: string; messageId: string; metadataJson: string }
  ): ClientDiagnosticEventRecord | null {
    this.db
      .prepare(
        `UPDATE client_diagnostic_events
         SET session_id = ?, message_id = ?, metadata_json = ?
         WHERE subject_id = ? AND event_id = ?`
      )
      .run(input.sessionId, input.messageId, input.metadataJson, subjectId, eventId);

    return this.getClientDiagnosticEvent(subjectId, eventId);
  }

  insertClientDiagnosticEvent(
    record: ClientDiagnosticEventRecord
  ): ClientDiagnosticEventRecord {
    this.db
      .prepare(
        `INSERT INTO client_diagnostic_events (
          id, event_id, request_id, credential_id, subject_id, scope, session_id, message_id,
          tool_call_id, provider_id, model_id, category, action, status, method, path,
          mono_ms, duration_ms, http_status, error_code, error_message, metadata_json,
          app_name, app_version, created_at, received_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
        record.toolCallId,
        record.providerId,
        record.modelId,
        record.category,
        record.action,
        record.status,
        record.method,
        record.path,
        record.monoMs,
        record.durationMs,
        record.httpStatus,
        record.errorCode,
        record.errorMessage,
        record.metadataJson,
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
}

export function createSqliteClientEventsStore(
  options: SqliteStoreOptions
): SqliteClientEventsStore {
  return new SqliteClientEventsStore(options);
}

function clientMessageWhere(input: ListClientMessageEventsInput): {
  where: string;
  params: Array<string | number>;
} {
  const clauses: string[] = [];
  const params: Array<string | number> = [];
  if (input.subjectId) {
    clauses.push("subject_id = ?");
    params.push(input.subjectId);
  } else if (input.subjectIds !== undefined) {
    const subjectIds = Array.from(new Set(input.subjectIds.filter(Boolean)));
    if (subjectIds.length === 0) {
      clauses.push("1 = 0");
    } else {
      clauses.push(`subject_id IN (${subjectIds.map(() => "?").join(", ")})`);
      params.push(...subjectIds);
    }
  }
  if (input.credentialId) {
    clauses.push("credential_id = ?");
    params.push(input.credentialId);
  }
  if (input.sessionId) {
    clauses.push("session_id = ?");
    params.push(input.sessionId);
  }
  if (input.messageId) {
    clauses.push("message_id = ?");
    params.push(input.messageId);
  }
  const search = input.search?.trim();
  if (search) {
    const searchableColumns = [
      "text",
      "session_id",
      "message_id",
      "request_id",
      "agent",
      "provider_id",
      "model_id",
      "engine"
    ];
    clauses.push(
      `(${searchableColumns
        .map((column) => `instr(lower(COALESCE(${column}, '')), lower(?)) > 0`)
        .join(" OR ")})`
    );
    params.push(...searchableColumns.map(() => search));
  }
  if (input.since) {
    clauses.push("received_at >= ?");
    params.push(input.since.toISOString());
  }
  if (input.until) {
    clauses.push("received_at <= ?");
    params.push(input.until.toISOString());
  }
  return {
    where: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "",
    params
  };
}

function clampListLimit(value: number | undefined, fallback: number, max: number): number {
  if (!Number.isInteger(value) || value === undefined || value <= 0) {
    return fallback;
  }
  return Math.min(value, max);
}

function clampOffset(value: number | undefined): number {
  if (!Number.isInteger(value) || value === undefined || value < 0) {
    return 0;
  }
  return value;
}
