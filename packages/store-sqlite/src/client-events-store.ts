import type { DatabaseSync } from "node:sqlite";
import type {
  ClientDiagnosticEventRecord,
  ClientMessageEventRecord,
  ClientMessageEventStore
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
