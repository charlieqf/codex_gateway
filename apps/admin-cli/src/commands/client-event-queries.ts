import { existsSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Command } from "commander";
import {
  extractAccessCredentialPrefix,
  hashAccessCredential,
  type AccessCredentialRecord,
  type ClientDiagnosticEventRecord,
  type ClientDiagnosticEventStatus,
  type ClientMessageEventRecord,
  type Scope,
  type Subject
} from "@codex-gateway/core";

import { parseDate, parsePositiveInteger } from "../parsers.js";
import { credentialStatus, publicCredential, publicSubject } from "../serializers.js";

export interface ClientEventQueryCommandDeps {
  gatewayDbPath(): string;
  clientEventsDbPath(): string;
  printJson(value: unknown): void;
}

interface ClientMessageQueryOptions extends ClientEventIdentityOptions {
  sessionId?: string;
  messageId?: string;
  requestId?: string;
  limit: number;
  json?: boolean;
  includeText?: boolean;
  previewChars: number;
  since?: Date;
  timezone: string;
}

interface ClientDiagnosticQueryOptions extends ClientEventIdentityOptions {
  sessionId?: string;
  messageId?: string;
  toolCallId?: string;
  requestId?: string;
  articleId?: string;
  category?: string;
  action?: string;
  status?: ClientDiagnosticEventStatus;
  limit: number;
  json?: boolean;
  includeMetadata?: boolean;
  since?: Date;
  timezone: string;
}

interface ClientEventIdentityOptions {
  user?: string;
  subjectId?: string;
  credentialPrefix?: string;
  unifiedKeyEnv?: string;
}

interface QueryContext {
  gateway: DatabaseSync;
  clientEvents: DatabaseSync;
  now: Date;
}

interface ResolvedIdentity {
  subject: Subject | null;
  credential: AccessCredentialRecord | null;
}

type ClientMessageRow = ClientMessageEventRecord;
type ClientDiagnosticRow = ClientDiagnosticEventRecord;

export function registerClientEventQueryCommands(
  program: Command,
  deps: ClientEventQueryCommandDeps
): void {
  program
    .command("client-messages")
    .description("Query Desktop client message uploads from the client events SQLite database.")
    .option("--user <display-name-or-subject-id>", "filter by user id, label, or stored name")
    .option("--subject-id <id>", "filter by subject id")
    .option("--credential-prefix <prefix>", "filter by API key prefix")
    .option("--unified-key-env <env-name>", "read a cmev1 unified key from an environment variable")
    .option("--session-id <id>", "filter by Desktop session id")
    .option("--message-id <id>", "filter by Desktop message id")
    .option("--request-id <id>", "filter by Gateway ingest request id")
    .option("--limit <n>", "maximum messages to return", parsePositiveInteger, 10)
    .option("--json", "emit JSON output; accepted for runbook compatibility")
    .option("--include-text", "include full prompt text in stdout")
    .option("--preview-chars <n>", "prompt preview length", parsePositiveInteger, 160)
    .option("--since <iso>", "inclusive ISO start time", parseDate)
    .option("--timezone <iana-zone>", "IANA timezone for local timestamp fields", "UTC")
    .action((options: ClientMessageQueryOptions) => {
      withClientEventQuery(deps, (context) => {
        assertTimezone(options.timezone);
        const identity = resolveIdentity(context.gateway, options);
        const rows = queryClientMessages(context.clientEvents, options, identity);
        deps.printJson({
          subject: identity.subject ? publicSubject(identity.subject) : null,
          credential: identity.credential
            ? publicCredential(identity.credential, identity.subject, context.now)
            : null,
          messages: rows.map((row) =>
            publicClientMessage(row, context, options.timezone, {
              includeText: Boolean(options.includeText),
              previewChars: options.previewChars
            })
          )
        });
      });
    });

  program
    .command("client-diagnostics")
    .description("Query Desktop client diagnostic uploads from the client events SQLite database.")
    .option("--user <display-name-or-subject-id>", "filter by user id, label, or stored name")
    .option("--subject-id <id>", "filter by subject id")
    .option("--credential-prefix <prefix>", "filter by API key prefix")
    .option("--unified-key-env <env-name>", "read a cmev1 unified key from an environment variable")
    .option("--session-id <id>", "filter by Desktop session id")
    .option("--message-id <id>", "filter by Desktop message id")
    .option("--tool-call-id <id>", "filter by Desktop tool call id")
    .option("--request-id <id>", "filter by Gateway ingest request id or metadata.request_id")
    .option("--article-id <id>", "filter by metadata.article_id")
    .option("--category <category>", "filter by diagnostic category")
    .option("--action <action>", "filter by diagnostic action")
    .option("--status <status>", "filter by diagnostic status", parseClientDiagnosticStatus)
    .option("--limit <n>", "maximum diagnostics to return", parsePositiveInteger, 25)
    .option("--json", "emit JSON output; accepted for runbook compatibility")
    .option("--include-metadata", "include parsed diagnostic metadata JSON")
    .option("--since <iso>", "inclusive ISO start time", parseDate)
    .option("--timezone <iana-zone>", "IANA timezone for local timestamp fields", "UTC")
    .action((options: ClientDiagnosticQueryOptions) => {
      withClientEventQuery(deps, (context) => {
        assertTimezone(options.timezone);
        const identity = resolveIdentity(context.gateway, options);
        const rows = queryClientDiagnostics(context.clientEvents, options, identity);
        deps.printJson({
          subject: identity.subject ? publicSubject(identity.subject) : null,
          credential: identity.credential
            ? publicCredential(identity.credential, identity.subject, context.now)
            : null,
          diagnostics: rows.map((row) =>
            publicClientDiagnostic(row, context, options.timezone, {
              includeMetadata: Boolean(options.includeMetadata)
            })
          )
        });
      });
    });
}

export function defaultClientEventsDbPath(gatewayDbPath: string): string {
  if (gatewayDbPath === ":memory:") {
    throw new Error("Client events SQLite database path is required for :memory: gateway DB.");
  }
  return path.join(path.dirname(gatewayDbPath), "client-events.db");
}

function withClientEventQuery<T>(
  deps: ClientEventQueryCommandDeps,
  fn: (context: QueryContext) => T
): T {
  const gatewayPath = deps.gatewayDbPath();
  const clientEventsPath = deps.clientEventsDbPath();
  const gateway = openReadOnlyDatabase(gatewayPath, "Gateway SQLite database");
  const clientEvents = openReadOnlyDatabase(clientEventsPath, "Client events SQLite database");
  try {
    return fn({
      gateway,
      clientEvents,
      now: new Date()
    });
  } finally {
    clientEvents.close();
    gateway.close();
  }
}

function openReadOnlyDatabase(dbPath: string, label: string): DatabaseSync {
  if (dbPath !== ":memory:" && !existsSync(dbPath)) {
    throw new Error(`${label} does not exist: ${dbPath}`);
  }
  const db = new DatabaseSync(dbPath, { readOnly: true, timeout: 1000 });
  db.exec("PRAGMA query_only = ON");
  return db;
}

function resolveIdentity(
  gateway: DatabaseSync,
  options: ClientEventIdentityOptions
): ResolvedIdentity {
  if (options.subjectId && options.user) {
    throw new Error("Use --subject-id or --user, not both.");
  }
  if (options.credentialPrefix && options.unifiedKeyEnv) {
    throw new Error("Use --credential-prefix or --unified-key-env, not both.");
  }

  const subject = resolveSubject(gateway, options);
  const credential = resolveCredential(gateway, options);
  if (subject && credential && credential.subjectId !== subject.id) {
    throw new Error(
      `Credential prefix does not belong to user ${subject.id}: ${credential.prefix}`
    );
  }

  return {
    subject: subject ?? (credential ? getSubject(gateway, credential.subjectId) : null),
    credential
  };
}

function resolveSubject(gateway: DatabaseSync, options: ClientEventIdentityOptions): Subject | null {
  if (options.subjectId) {
    const subject = getSubject(gateway, options.subjectId);
    if (!subject) {
      throw new Error(`User not found: ${options.subjectId}`);
    }
    return subject;
  }
  if (!options.user) {
    return null;
  }

  const rows = gateway
    .prepare(
      `SELECT id, label, name, phone_number, state, created_at
       FROM subjects
       WHERE id = ? OR label = ? OR name = ?
       ORDER BY CASE WHEN id = ? THEN 0 WHEN name = ? THEN 1 ELSE 2 END, id`
    )
    .all(options.user, options.user, options.user, options.user, options.user)
    .map(rowToSubject);
  if (rows.length === 0) {
    throw new Error(`User not found: ${options.user}`);
  }
  if (rows.length > 1) {
    throw new Error(
      `User is ambiguous: ${options.user}. Use --subject-id with one of: ${rows
        .map((row) => row.id)
        .join(", ")}`
    );
  }
  return rows[0] ?? null;
}

function resolveCredential(
  gateway: DatabaseSync,
  options: ClientEventIdentityOptions
): AccessCredentialRecord | null {
  if (options.credentialPrefix) {
    const credential = getCredentialByPrefix(gateway, options.credentialPrefix);
    if (!credential) {
      throw new Error(`Credential prefix not found: ${options.credentialPrefix}`);
    }
    return credential;
  }
  if (!options.unifiedKeyEnv) {
    return null;
  }

  const unifiedKey = process.env[options.unifiedKeyEnv];
  if (!unifiedKey) {
    throw new Error(`Unified key environment variable is empty or missing: ${options.unifiedKeyEnv}`);
  }
  const medcodeKey = parseUnifiedKeyMedCodeHalf(unifiedKey);
  const prefix = extractAccessCredentialPrefix(medcodeKey);
  if (!prefix) {
    throw new Error("Unified key does not contain a valid MedCode API key.");
  }
  const credential = getCredentialByPrefix(gateway, prefix);
  if (!credential || credential.hash !== hashAccessCredential(medcodeKey)) {
    throw new Error("Unified key does not match a stored Gateway credential.");
  }
  return credential;
}

function parseUnifiedKeyMedCodeHalf(unifiedKey: string): string {
  const marker = "cmev1.";
  if (!unifiedKey.startsWith(marker)) {
    throw new Error("Unified key must start with cmev1.");
  }
  const body = unifiedKey.slice(marker.length);
  const splitAt = body.lastIndexOf(".");
  if (splitAt <= 0 || splitAt === body.length - 1) {
    throw new Error("Unified key must contain MedCode and MedEvidence key parts.");
  }
  return body.slice(0, splitAt);
}

function queryClientMessages(
  db: DatabaseSync,
  options: ClientMessageQueryOptions,
  identity: ResolvedIdentity
): ClientMessageRow[] {
  const query = buildBaseClientEventQuery("client_message_events", options, identity);
  if (options.sessionId) {
    query.where.push("session_id = ?");
    query.params.push(options.sessionId);
  }
  if (options.messageId) {
    query.where.push("message_id = ?");
    query.params.push(options.messageId);
  }
  if (options.requestId) {
    query.where.push("request_id = ?");
    query.params.push(options.requestId);
  }
  if (options.since) {
    query.where.push("received_at >= ?");
    query.params.push(options.since.toISOString());
  }
  query.params.push(options.limit);

  return db
    .prepare(
      `SELECT id, event_id, request_id, credential_id, subject_id, scope, session_id,
              message_id, agent, provider_id, model_id, engine, text, text_sha256,
              attachments_json, app_name, app_version, created_at, received_at
       FROM client_message_events
       ${whereSql(query.where)}
       ORDER BY received_at DESC
       LIMIT ?`
    )
    .all(...query.params)
    .map(rowToClientMessage);
}

function queryClientDiagnostics(
  db: DatabaseSync,
  options: ClientDiagnosticQueryOptions,
  identity: ResolvedIdentity
): ClientDiagnosticRow[] {
  const query = buildBaseClientEventQuery("client_diagnostic_events", options, identity);
  if (options.sessionId) {
    query.where.push("session_id = ?");
    query.params.push(options.sessionId);
  }
  if (options.messageId) {
    query.where.push("message_id = ?");
    query.params.push(options.messageId);
  }
  if (options.toolCallId) {
    query.where.push("tool_call_id = ?");
    query.params.push(options.toolCallId);
  }
  if (options.requestId) {
    query.where.push("(request_id = ? OR json_extract(metadata_json, '$.request_id') = ?)");
    query.params.push(options.requestId, options.requestId);
  }
  if (options.articleId) {
    query.where.push("json_extract(metadata_json, '$.article_id') = ?");
    query.params.push(options.articleId);
  }
  if (options.category) {
    query.where.push("category = ?");
    query.params.push(options.category);
  }
  if (options.action) {
    query.where.push("action = ?");
    query.params.push(options.action);
  }
  if (options.status) {
    query.where.push("status = ?");
    query.params.push(options.status);
  }
  if (options.since) {
    query.where.push("received_at >= ?");
    query.params.push(options.since.toISOString());
  }
  query.params.push(options.limit);

  return db
    .prepare(
      `SELECT id, event_id, request_id, credential_id, subject_id, scope, session_id,
              message_id, tool_call_id, provider_id, model_id, category, action,
              status, method, path, mono_ms, duration_ms, http_status, error_code,
              error_message, metadata_json, app_name, app_version, created_at,
              received_at
       FROM client_diagnostic_events
       ${whereSql(query.where)}
       ORDER BY received_at DESC
       LIMIT ?`
    )
    .all(...query.params)
    .map(rowToClientDiagnostic);
}

function buildBaseClientEventQuery(
  _table: "client_message_events" | "client_diagnostic_events",
  _options: ClientEventIdentityOptions,
  identity: ResolvedIdentity
): { where: string[]; params: Array<string | number> } {
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (identity.subject) {
    where.push("subject_id = ?");
    params.push(identity.subject.id);
  }
  if (identity.credential) {
    where.push("credential_id = ?");
    params.push(identity.credential.id);
  }
  return { where, params };
}

function whereSql(where: string[]): string {
  return where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
}

function publicClientMessage(
  row: ClientMessageRow,
  context: QueryContext,
  timezone: string,
  options: { includeText: boolean; previewChars: number }
) {
  const subject = getSubject(context.gateway, row.subjectId);
  const credential = getCredentialById(context.gateway, row.credentialId);
  const output: Record<string, unknown> = {
    id: row.id,
    event_id: row.eventId,
    request_id: row.requestId,
    credential_id: row.credentialId,
    credential_prefix: credential?.prefix ?? null,
    credential_status: credential ? credentialStatus(credential, subject, context.now) : "missing",
    subject_id: row.subjectId,
    user: subject ? publicSubject(subject) : null,
    scope: row.scope,
    session_id: row.sessionId,
    message_id: row.messageId,
    agent: row.agent,
    provider_id: row.providerId,
    model_id: row.modelId,
    engine: row.engine,
    app_name: row.appName,
    app_version: row.appVersion,
    created_at: row.createdAt.toISOString(),
    created_at_local: formatInTimezone(row.createdAt, timezone),
    received_at: row.receivedAt.toISOString(),
    received_at_local: formatInTimezone(row.receivedAt, timezone),
    timezone,
    text_sha256: row.textSha256,
    text_preview: previewText(row.text, options.previewChars),
    attachments: parseJson(row.attachmentsJson)
  };
  if (options.includeText) {
    output.text = row.text;
  }
  return output;
}

function publicClientDiagnostic(
  row: ClientDiagnosticRow,
  context: QueryContext,
  timezone: string,
  options: { includeMetadata: boolean }
) {
  const subject = getSubject(context.gateway, row.subjectId);
  const credential = getCredentialById(context.gateway, row.credentialId);
  const metadata = parseJson(row.metadataJson);
  const output: Record<string, unknown> = {
    id: row.id,
    event_id: row.eventId,
    request_id: row.requestId,
    credential_id: row.credentialId,
    credential_prefix: credential?.prefix ?? null,
    credential_status: credential ? credentialStatus(credential, subject, context.now) : "missing",
    subject_id: row.subjectId,
    user: subject ? publicSubject(subject) : null,
    scope: row.scope,
    session_id: row.sessionId,
    message_id: row.messageId,
    tool_call_id: row.toolCallId,
    provider_id: row.providerId,
    model_id: row.modelId,
    category: row.category,
    action: row.action,
    status: row.status,
    method: row.method,
    path: row.path,
    mono_ms: row.monoMs,
    duration_ms: row.durationMs,
    http_status: row.httpStatus,
    error_code: row.errorCode,
    error_message: row.errorMessage,
    metadata_request_id: metadataField(metadata, "request_id"),
    metadata_article_id: metadataField(metadata, "article_id"),
    app_name: row.appName,
    app_version: row.appVersion,
    created_at: row.createdAt.toISOString(),
    created_at_local: formatInTimezone(row.createdAt, timezone),
    received_at: row.receivedAt.toISOString(),
    received_at_local: formatInTimezone(row.receivedAt, timezone),
    timezone
  };
  if (options.includeMetadata) {
    output.metadata = metadata;
  }
  return output;
}

function getSubject(db: DatabaseSync, id: string): Subject | null {
  const row = db
    .prepare(
      `SELECT id, label, name, phone_number, state, created_at
       FROM subjects
       WHERE id = ?`
    )
    .get(id);
  return row ? rowToSubject(row) : null;
}

function getCredentialByPrefix(db: DatabaseSync, prefix: string): AccessCredentialRecord | null {
  const row = db
    .prepare(
      `SELECT id, prefix, hash, token_ciphertext, subject_id, label, scope, expires_at,
              revoked_at, rate_json, created_at, rotates_id
       FROM access_credentials
       WHERE prefix = ?`
    )
    .get(prefix);
  return row ? rowToAccessCredential(row) : null;
}

function getCredentialById(db: DatabaseSync, id: string): AccessCredentialRecord | null {
  const row = db
    .prepare(
      `SELECT id, prefix, hash, token_ciphertext, subject_id, label, scope, expires_at,
              revoked_at, rate_json, created_at, rotates_id
       FROM access_credentials
       WHERE id = ?`
    )
    .get(id);
  return row ? rowToAccessCredential(row) : null;
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
    scope: Scope;
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
    rate: JSON.parse(value.rate_json),
    createdAt: new Date(value.created_at),
    rotatesId: value.rotates_id
  };
}

function rowToClientMessage(row: unknown): ClientMessageRow {
  const value = row as {
    id: string;
    event_id: string;
    request_id: string;
    credential_id: string;
    subject_id: string;
    scope: Scope;
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

function rowToClientDiagnostic(row: unknown): ClientDiagnosticRow {
  const value = row as {
    id: string;
    event_id: string;
    request_id: string;
    credential_id: string;
    subject_id: string;
    scope: Scope;
    session_id: string | null;
    message_id: string | null;
    tool_call_id: string | null;
    provider_id: string | null;
    model_id: string | null;
    category: string;
    action: string;
    status: ClientDiagnosticEventStatus;
    method: string | null;
    path: string | null;
    mono_ms: number | null;
    duration_ms: number | null;
    http_status: number | null;
    error_code: string | null;
    error_message: string | null;
    metadata_json: string;
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
    toolCallId: value.tool_call_id,
    providerId: value.provider_id,
    modelId: value.model_id,
    category: value.category,
    action: value.action,
    status: value.status,
    method: value.method,
    path: value.path,
    monoMs: value.mono_ms,
    durationMs: value.duration_ms,
    httpStatus: value.http_status,
    errorCode: value.error_code,
    errorMessage: value.error_message,
    metadataJson: value.metadata_json,
    appName: value.app_name,
    appVersion: value.app_version,
    createdAt: new Date(value.created_at),
    receivedAt: new Date(value.received_at)
  };
}

function previewText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}...`;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function metadataField(metadata: unknown, field: string): string | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return null;
  }
  const value = (metadata as Record<string, unknown>)[field];
  return typeof value === "string" ? value : null;
}

function formatInTimezone(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day} ${value.hour}:${value.minute}:${value.second} ${timezone}`;
}

function assertTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
  } catch {
    throw new Error(`Invalid IANA timezone: ${timezone}`);
  }
}

function parseClientDiagnosticStatus(value: string): ClientDiagnosticEventStatus {
  const statuses = new Set<ClientDiagnosticEventStatus>([
    "started",
    "ok",
    "error",
    "aborted",
    "timeout",
    "queued",
    "dropped"
  ]);
  if (!statuses.has(value as ClientDiagnosticEventStatus)) {
    throw new Error("status must be started, ok, error, aborted, timeout, queued, or dropped");
  }
  return value as ClientDiagnosticEventStatus;
}
