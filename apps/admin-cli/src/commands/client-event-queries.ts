import { createHash } from "node:crypto";
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
  type Subject,
  type UpstreamAttemptSummary
} from "@codex-gateway/core";

import { parseDate, parseNonNegativeInteger, parsePositiveInteger } from "../parsers.js";
import { credentialStatus, publicCredential, publicSubject } from "../serializers.js";

export interface ClientEventQueryCommandDeps {
  gatewayDbPath(): string;
  clientEventsDbPath(): string;
  printJson(value: unknown): void;
  printText(value: string): void;
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

interface ClientTurnQueryOptions extends ClientEventIdentityOptions {
  at?: string;
  windowMinutes: number;
  limit: number;
  json?: boolean;
  includeMetadata?: boolean;
  timezone: string;
}

type ClientMedevidenceToolAuditFormat = "json" | "jsonl" | "csv";

interface ClientMedevidenceToolAuditOptions extends ClientEventIdentityOptions {
  sessionId?: string;
  messageId?: string;
  toolCallId?: string;
  requestId?: string;
  articleId?: string;
  since?: Date;
  hours: number;
  timezone: string;
  limit: number;
  minQuestionLength: number;
  entrypoint: string;
  format: ClientMedevidenceToolAuditFormat;
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

interface GatewayRequestEventRow {
  requestId: string;
  credentialId: string | null;
  subjectId: string | null;
  scope: Scope | null;
  sessionId: string | null;
  upstreamAccountId: string | null;
  provider: string | null;
  publicModelId: string | null;
  upstreamRuntime: string | null;
  upstreamModel: string | null;
  reasoningEffort: string | null;
  clientTurnId: string | null;
  turnCode: string | null;
  clientSessionId: string | null;
  clientMessageId: string | null;
  clientAppVersion: string | null;
  toolChoice: string | null;
  upstreamFinishReason: string | null;
  upstreamRequestId: string | null;
  upstreamHttpStatus: number | null;
  upstreamContentChars: number | null;
  upstreamToolCallCount: number | null;
  upstreamToolNames: string[] | null;
  upstreamRawResponseHash: string | null;
  upstreamRawResponseChars: number | null;
  upstreamEmptyStop: boolean | null;
  upstreamAttemptCount: number | null;
  upstreamAttempts: UpstreamAttemptSummary[] | null;
  startedAt: Date;
  durationMs: number | null;
  firstByteMs: number | null;
  status: string;
  errorCode: string | null;
  rateLimited: boolean;
}

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

  program
    .command("client-turn")
    .description("Join Desktop diagnostic events and Gateway request events by turn_code or client_turn_id.")
    .argument("<turn>", "turn_code such as T:7K3P2, or a client_turn_id/message_id")
    .option("--user <display-name-or-subject-id>", "filter by user id, label, or stored name")
    .option("--subject-id <id>", "filter by subject id")
    .option("--credential-prefix <prefix>", "filter by API key prefix")
    .option("--unified-key-env <env-name>", "read a cmev1 unified key from an environment variable")
    .option("--at <time>", "center of lookup window; ISO, or YYYY-MM-DD HH:mm interpreted in --timezone")
    .option("--window-minutes <n>", "minutes on each side of --at", parsePositiveInteger, 15)
    .option("--limit <n>", "maximum diagnostics and request rows to return per section", parsePositiveInteger, 50)
    .option("--json", "emit JSON output; accepted for runbook compatibility")
    .option("--include-metadata", "include parsed diagnostic metadata JSON")
    .option("--timezone <iana-zone>", "IANA timezone for local timestamp fields and timezone-less --at", "UTC")
    .action((turn: string, options: ClientTurnQueryOptions) => {
      withClientEventQuery(deps, (context) => {
        assertTimezone(options.timezone);
        const identity = resolveIdentity(context.gateway, options);
        const at = options.at ? parseClientTurnAt(options.at, options.timezone) : undefined;
        const window = clientTurnWindow(at, options, context.now);
        const gatewayRequests = queryClientTurnGatewayRequests(
          context.gateway,
          turn,
          options,
          identity,
          window
        );
        const diagnostics = queryClientTurnDiagnostics(
          context.clientEvents,
          turn,
          options,
          identity,
          window,
          gatewayRequests.map((row) => row.requestId)
        );
        deps.printJson({
          query: {
            turn,
            normalized_turn_code: normalizedTurnCode(turn),
            at: at?.toISOString() ?? null,
            window_minutes: options.windowMinutes,
            since: window.since.toISOString(),
            until: window.until.toISOString(),
            timezone: options.timezone
          },
          subject: identity.subject ? publicSubject(identity.subject) : null,
          credential: identity.credential
            ? publicCredential(identity.credential, identity.subject, context.now)
            : null,
          client_diagnostics: diagnostics.map((row) =>
            publicClientDiagnostic(row, context, options.timezone, {
              includeMetadata: Boolean(options.includeMetadata)
            })
          ),
          gateway_requests: gatewayRequests.map((row) =>
            publicGatewayRequestEvent(row, context, options.timezone)
          ),
          timeline: clientTurnTimeline(diagnostics, gatewayRequests, options.timezone)
        });
      });
    });

  program
    .command("client-medevidence-tool-audit")
    .description(
      "Export MedEvidence tool diagnostic audit metadata joined with Desktop client messages."
    )
    .option("--user <display-name-or-subject-id>", "filter by user id, label, or stored name")
    .option("--subject-id <id>", "filter by subject id")
    .option("--credential-prefix <prefix>", "filter by API key prefix")
    .option("--unified-key-env <env-name>", "read a cmev1 unified key from an environment variable")
    .option("--session-id <id>", "filter by Desktop session id")
    .option("--message-id <id>", "filter by Desktop message id")
    .option("--tool-call-id <id>", "filter by Desktop tool call id")
    .option("--request-id <id>", "filter by Gateway ingest request id or metadata.request_id")
    .option("--article-id <id>", "filter by metadata.article_id")
    .option("--since <iso>", "inclusive ISO start time; overrides --hours", parseDate)
    .option("--hours <n>", "lookback window in hours when --since is omitted", parsePositiveInteger, 48)
    .option("--timezone <iana-zone>", "IANA timezone for local timestamp fields", "UTC")
    .option("--limit <n>", "maximum export rows", parsePositiveInteger, 100)
    .option(
      "--min-question-length <n>",
      "minimum extracted MedEvidence question length in characters",
      parseNonNegativeInteger,
      50
    )
    .option(
      "--entrypoint <value>",
      "filter by metadata.entrypoint; missing metadata defaults to gateway for Gateway-ingested tool diagnostics",
      "gateway"
    )
    .option("--format <json|jsonl|csv>", "export format", parseAuditExportFormat, "jsonl")
    .action((options: ClientMedevidenceToolAuditOptions) => {
      withClientEventQuery(deps, (context) => {
        assertTimezone(options.timezone);
        const identity = resolveIdentity(context.gateway, options);
        const rows = queryClientMedevidenceToolAudit(context, options, identity);
        writeMedevidenceToolAuditExport(deps, rows, options, context.now);
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

function queryClientTurnDiagnostics(
  db: DatabaseSync,
  turn: string,
  options: ClientTurnQueryOptions,
  identity: ResolvedIdentity,
  window: { since: Date; until: Date },
  gatewayRequestIds: string[]
): ClientDiagnosticRow[] {
  const query = buildBaseClientEventQuery("client_diagnostic_events", options, identity);
  const candidates = turnCandidates(turn);
  const gatewayIds = gatewayRequestIds.length > 0 ? gatewayRequestIds : ["__none__"];
  query.where.push(
    `(json_extract(metadata_json, '$.turn_code') IN (${placeholders(candidates.turnCodes.length)})
      OR json_extract(metadata_json, '$.client_turn_id') IN (${placeholders(candidates.ids.length)})
      OR message_id IN (${placeholders(candidates.ids.length)})
      OR json_extract(metadata_json, '$.gateway_request_id') IN (${placeholders(gatewayIds.length)}))`
  );
  query.params.push(
    ...candidates.turnCodes,
    ...candidates.ids,
    ...candidates.ids,
    ...gatewayIds
  );
  query.where.push("received_at >= ?");
  query.params.push(window.since.toISOString());
  query.where.push("received_at < ?");
  query.params.push(window.until.toISOString());
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
       ORDER BY received_at ASC
       LIMIT ?`
    )
    .all(...query.params)
    .map(rowToClientDiagnostic);
}

function queryClientTurnGatewayRequests(
  db: DatabaseSync,
  turn: string,
  options: ClientTurnQueryOptions,
  identity: ResolvedIdentity,
  window: { since: Date; until: Date }
): GatewayRequestEventRow[] {
  const candidates = turnCandidates(turn);
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
  where.push(
    `(turn_code IN (${placeholders(candidates.turnCodes.length)})
      OR client_turn_id IN (${placeholders(candidates.ids.length)})
      OR client_message_id IN (${placeholders(candidates.ids.length)}))`
  );
  params.push(...candidates.turnCodes, ...candidates.ids, ...candidates.ids);
  where.push("started_at >= ?");
  params.push(window.since.toISOString());
  where.push("started_at < ?");
  params.push(window.until.toISOString());
  params.push(options.limit);

  return db
    .prepare(
      `SELECT request_id, credential_id, subject_id, scope, session_id, upstream_account_id,
              provider, public_model_id, upstream_runtime, upstream_model, reasoning_effort,
              client_turn_id, turn_code, client_session_id, client_message_id,
              client_app_version, tool_choice, upstream_finish_reason, upstream_request_id,
              upstream_http_status, upstream_content_chars, upstream_tool_call_count,
              upstream_tool_names_json, upstream_raw_response_hash,
              upstream_raw_response_chars, upstream_empty_stop, upstream_attempt_count,
              upstream_attempts_json, started_at, duration_ms, first_byte_ms, status,
              error_code, rate_limited
       FROM request_events
       ${whereSql(where)}
       ORDER BY started_at ASC
       LIMIT ?`
    )
    .all(...params)
    .map(rowToGatewayRequestEvent);
}

function queryClientMedevidenceToolAudit(
  context: QueryContext,
  options: ClientMedevidenceToolAuditOptions,
  identity: ResolvedIdentity
): Array<Record<string, unknown>> {
  const since = options.since ?? new Date(context.now.getTime() - options.hours * 60 * 60 * 1000);
  const query = buildBaseClientEventQuery("client_diagnostic_events", options, identity);
  query.where.push(
    "(lower(category) = ? OR lower(action) = ? OR lower(CAST(json_extract(metadata_json, '$.tool_name') AS TEXT)) = ?)"
  );
  query.params.push("medevidence", "medevidence", "medevidence");
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
  query.where.push("created_at >= ?");
  query.params.push(since.toISOString());

  const scanLimit = Math.max(options.limit, Math.min(options.limit * 10, 2000));
  query.params.push(scanLimit);
  const diagnostics = context.clientEvents
    .prepare(
      `SELECT id, event_id, request_id, credential_id, subject_id, scope, session_id,
              message_id, tool_call_id, provider_id, model_id, category, action,
              status, method, path, mono_ms, duration_ms, http_status, error_code,
              error_message, metadata_json, app_name, app_version, created_at,
              received_at
       FROM client_diagnostic_events
       ${whereSql(query.where)}
       ORDER BY created_at DESC, received_at DESC
       LIMIT ?`
    )
    .all(...query.params)
    .map(rowToClientDiagnostic);

  const output: Array<Record<string, unknown>> = [];
  for (const diagnostic of diagnostics) {
    const message = findMatchingClientMessage(context.clientEvents, diagnostic);
    const row = publicMedevidenceToolAuditRow(diagnostic, message, context, options.timezone);
    if (!auditRowMatchesFilters(row, options)) {
      continue;
    }
    output.push(row);
    if (output.length >= options.limit) {
      break;
    }
  }
  return output;
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
  const attachments = parseJson(row.attachmentsJson);
  const attachmentSummary = summarizeClientMessageAttachments(attachments);
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
    attachments,
    attachments_count: attachmentSummary.attachmentsCount,
    pdf_attachment_count: attachmentSummary.pdfAttachmentCount,
    pdf_total_bytes: attachmentSummary.pdfTotalBytes,
    pdf_max_bytes: attachmentSummary.pdfMaxBytes,
    pdf_total_pages: attachmentSummary.pdfTotalPages,
    pdf_max_pages: attachmentSummary.pdfMaxPages,
    pdf_extracted_chars: attachmentSummary.pdfExtractedChars,
    pdf_chunk_count: attachmentSummary.pdfChunkCount
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
  const requestShape = summarizeDiagnosticRequestShape(metadataObject(metadata));
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
    metadata_client_turn_id: metadataField(metadata, "client_turn_id"),
    metadata_turn_code: metadataField(metadata, "turn_code"),
    metadata_gateway_request_id: metadataField(metadata, "gateway_request_id"),
    request_shape_pdf_count: requestShape.pdfCount,
    request_shape_pdf_total_bytes: requestShape.pdfTotalBytes,
    request_shape_pdf_max_bytes: requestShape.pdfMaxBytes,
    request_shape_file_total_bytes: requestShape.fileTotalBytes,
    request_shape_media_base64_bytes: requestShape.mediaBase64Bytes,
    request_shape_estimated_prompt_tokens: requestShape.estimatedPromptTokens,
    request_shape_tools_schema_bytes: requestShape.toolsSchemaBytes,
    request_shape_pdf_context_overflow: requestShape.pdfContextOverflow,
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

function publicGatewayRequestEvent(
  row: GatewayRequestEventRow,
  context: QueryContext,
  timezone: string
): Record<string, unknown> {
  const subject = row.subjectId ? getSubject(context.gateway, row.subjectId) : null;
  const credential = row.credentialId ? getCredentialById(context.gateway, row.credentialId) : null;
  return {
    request_id: row.requestId,
    credential_id: row.credentialId,
    credential_prefix: credential?.prefix ?? null,
    credential_status: credential ? credentialStatus(credential, subject, context.now) : null,
    subject_id: row.subjectId,
    user: subject ? publicSubject(subject) : null,
    scope: row.scope,
    session_id: row.sessionId,
    client_turn_id: row.clientTurnId,
    turn_code: row.turnCode,
    client_session_id: row.clientSessionId,
    client_message_id: row.clientMessageId,
    client_app_version: row.clientAppVersion,
    public_model_id: row.publicModelId,
    resolved_upstream_model: row.upstreamModel,
    upstream_runtime: row.upstreamRuntime,
    upstream_account_id: row.upstreamAccountId,
    provider: row.provider,
    reasoning_effort: row.reasoningEffort,
    tool_choice: row.toolChoice,
    upstream_finish_reason: row.upstreamFinishReason,
    upstream_request_id: row.upstreamRequestId,
    upstream_http_status: row.upstreamHttpStatus,
    upstream_content_chars: row.upstreamContentChars,
    upstream_tool_call_count: row.upstreamToolCallCount,
    upstream_tool_names: row.upstreamToolNames,
    upstream_raw_response_hash: row.upstreamRawResponseHash,
    upstream_raw_response_chars: row.upstreamRawResponseChars,
    upstream_empty_stop: row.upstreamEmptyStop,
    upstream_attempt_count: row.upstreamAttemptCount,
    upstream_attempts: row.upstreamAttempts,
    started_at: row.startedAt.toISOString(),
    started_at_local: formatInTimezone(row.startedAt, timezone),
    duration_ms: row.durationMs,
    first_byte_ms: row.firstByteMs,
    status: row.status,
    error_code: row.errorCode,
    rate_limited: row.rateLimited,
    timezone
  };
}

function clientTurnTimeline(
  diagnostics: ClientDiagnosticRow[],
  gatewayRequests: GatewayRequestEventRow[],
  timezone: string
): Array<Record<string, unknown>> {
  return [
    ...diagnostics.map((row) => ({
      source: "client_diagnostic",
      at: row.createdAt,
      received_at: row.receivedAt.toISOString(),
      label: `${row.category}.${row.action}`,
      status: row.status,
      event_id: row.eventId,
      request_id: row.requestId,
      session_id: row.sessionId,
      message_id: row.messageId,
      error_code: row.errorCode
    })),
    ...gatewayRequests.map((row) => ({
      source: "gateway_request",
      at: row.startedAt,
      label: "model.request",
      status: row.status,
      request_id: row.requestId,
      session_id: row.sessionId,
      public_model_id: row.publicModelId,
      resolved_upstream_model: row.upstreamModel,
      reasoning_effort: row.reasoningEffort,
      finish_reason: row.upstreamFinishReason,
      tool_call_count: row.upstreamToolCallCount,
      error_code: row.errorCode
    }))
  ]
    .sort((a, b) => a.at.getTime() - b.at.getTime())
    .map(({ at, ...row }) => ({
      ...row,
      at: at.toISOString(),
      at_local: formatInTimezone(at, timezone)
    }));
}

function findMatchingClientMessage(
  db: DatabaseSync,
  diagnostic: ClientDiagnosticRow
): ClientMessageRow | null {
  if (!diagnostic.sessionId) {
    return null;
  }
  if (diagnostic.messageId) {
    const exact = db
      .prepare(
        `SELECT id, event_id, request_id, credential_id, subject_id, scope, session_id,
                message_id, agent, provider_id, model_id, engine, text, text_sha256,
                attachments_json, app_name, app_version, created_at, received_at
         FROM client_message_events
         WHERE subject_id = ? AND session_id = ? AND message_id = ?
         ORDER BY received_at DESC
         LIMIT 1`
      )
      .get(diagnostic.subjectId, diagnostic.sessionId, diagnostic.messageId);
    if (exact) {
      return rowToClientMessage(exact);
    }
  }

  const nearest = db
    .prepare(
      `SELECT id, event_id, request_id, credential_id, subject_id, scope, session_id,
              message_id, agent, provider_id, model_id, engine, text, text_sha256,
              attachments_json, app_name, app_version, created_at, received_at
       FROM client_message_events
       WHERE subject_id = ? AND session_id = ? AND created_at <= ?
       ORDER BY created_at DESC, received_at DESC
       LIMIT 1`
    )
    .get(diagnostic.subjectId, diagnostic.sessionId, diagnostic.createdAt.toISOString());
  return nearest ? rowToClientMessage(nearest) : null;
}

function publicMedevidenceToolAuditRow(
  diagnostic: ClientDiagnosticRow,
  message: ClientMessageRow | null,
  context: QueryContext,
  timezone: string
): Record<string, unknown> {
  const subject = getSubject(context.gateway, diagnostic.subjectId);
  const credential = getCredentialById(context.gateway, diagnostic.credentialId);
  const metadata = metadataObject(parseJson(diagnostic.metadataJson));
  const medevidenceToolText = metadataString(metadata, "medevidence_tool_text");
  const metadataQuestion =
    metadataString(metadata, "question") ?? metadataString(metadata, "medevidence_question");
  const question = metadataQuestion ?? medevidenceToolText;
  const questionSource = metadataQuestion
    ? metadataString(metadata, "question") !== null
      ? "metadata.question"
      : "metadata.medevidence_question"
    : medevidenceToolText
      ? "metadata.medevidence_tool_text"
      : null;
  const originalUserText = metadataString(metadata, "original_user_text") ?? message?.text ?? null;
  const questionLength = question ? charLength(question) : null;
  const originalUserLength =
    metadataNumber(metadata, "original_user_length") ??
    (originalUserText ? charLength(originalUserText) : null);
  const questionSameAsUser =
    metadataBoolean(metadata, "question_same_as_user") ??
    (question && originalUserText ? question === originalUserText : null);
  const questionDerived =
    metadataBoolean(metadata, "question_derived") ??
    (typeof questionSameAsUser === "boolean" ? !questionSameAsUser : null);
  const entrypoint = metadataString(metadata, "entrypoint") ?? "gateway";
  const parentArticleId = metadataString(metadata, "parent_article_id");

  return {
    request_id: metadataString(metadata, "request_id") ?? diagnostic.requestId,
    gateway_diagnostic_ingest_request_id: diagnostic.requestId,
    created_at: diagnostic.createdAt.toISOString(),
    created_at_local: formatInTimezone(diagnostic.createdAt, timezone),
    timezone,
    session_id: diagnostic.sessionId,
    message_id: diagnostic.messageId ?? message?.messageId ?? null,
    tool_call_id: diagnostic.toolCallId ?? metadataString(metadata, "tool_call_id"),
    agent: message?.agent ?? metadataString(metadata, "agent"),
    status: diagnostic.status,
    diagnostic_status: diagnostic.status,
    medevidence_status: metadataString(metadata, "status"),
    result_class: metadataString(metadata, "result_class"),
    error_code: diagnostic.errorCode ?? metadataString(metadata, "error_code"),
    selected_backend: metadataString(metadata, "selected_backend"),
    entrypoint,
    entrypoint_source: metadataString(metadata, "entrypoint") ? "metadata" : "default_gateway",
    question,
    question_source: questionSource,
    question_length: metadataNumber(metadata, "question_length") ?? questionLength,
    question_char_length: questionLength,
    question_hash: metadataString(metadata, "question_hash") ?? (question ? sha256(question) : null),
    original_user_text: originalUserText,
    original_user_length: originalUserLength,
    original_user_hash:
      metadataString(metadata, "original_user_hash") ??
      message?.textSha256 ??
      (originalUserText ? sha256(originalUserText) : null),
    medevidence_tool_text: medevidenceToolText,
    medevidence_tool_text_length: medevidenceToolText ? charLength(medevidenceToolText) : null,
    question_same_as_user: questionSameAsUser,
    question_derived: questionDerived,
    medevidence_question_guard: metadataValue(metadata, "medevidence_question_guard"),
    guard_reject_count: metadataNumber(metadata, "guard_reject_count"),
    tool_outcome: metadataString(metadata, "tool_outcome"),
    article_id: metadataString(metadata, "article_id"),
    medevidence_article_id: metadataString(metadata, "article_id"),
    parent_article_id: parentArticleId,
    parent_article_id_present: parentArticleId !== null,
    subject_id: diagnostic.subjectId,
    credential_prefix: credential?.prefix ?? null,
    credential_status: credential ? credentialStatus(credential, subject, context.now) : "missing",
    category: diagnostic.category,
    action: diagnostic.action,
    app_name: diagnostic.appName,
    app_version: diagnostic.appVersion,
    provider_id: diagnostic.providerId,
    model_id: diagnostic.modelId,
    client_message_ingest_request_id: message?.requestId ?? null
  };
}

function auditRowMatchesFilters(
  row: Record<string, unknown>,
  options: ClientMedevidenceToolAuditOptions
): boolean {
  if (row.entrypoint !== options.entrypoint) {
    return false;
  }
  if (typeof row.question !== "string" || row.question.length === 0) {
    return false;
  }
  return charLength(row.question) > options.minQuestionLength;
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

function rowToGatewayRequestEvent(row: unknown): GatewayRequestEventRow {
  const value = row as {
    request_id: string;
    credential_id: string | null;
    subject_id: string | null;
    scope: Scope | null;
    session_id: string | null;
    upstream_account_id: string | null;
    provider: string | null;
    public_model_id: string | null;
    upstream_runtime: string | null;
    upstream_model: string | null;
    reasoning_effort: string | null;
    client_turn_id: string | null;
    turn_code: string | null;
    client_session_id: string | null;
    client_message_id: string | null;
    client_app_version: string | null;
    tool_choice: string | null;
    upstream_finish_reason: string | null;
    upstream_request_id: string | null;
    upstream_http_status: number | null;
    upstream_content_chars: number | null;
    upstream_tool_call_count: number | null;
    upstream_tool_names_json: string | null;
    upstream_raw_response_hash: string | null;
    upstream_raw_response_chars: number | null;
    upstream_empty_stop: number | null;
    upstream_attempt_count: number | null;
    upstream_attempts_json: string | null;
    started_at: string;
    duration_ms: number | null;
    first_byte_ms: number | null;
    status: string;
    error_code: string | null;
    rate_limited: number;
  };
  return {
    requestId: value.request_id,
    credentialId: value.credential_id,
    subjectId: value.subject_id,
    scope: value.scope,
    sessionId: value.session_id,
    upstreamAccountId: value.upstream_account_id,
    provider: value.provider,
    publicModelId: value.public_model_id,
    upstreamRuntime: value.upstream_runtime,
    upstreamModel: value.upstream_model,
    reasoningEffort: value.reasoning_effort,
    clientTurnId: value.client_turn_id,
    turnCode: value.turn_code,
    clientSessionId: value.client_session_id,
    clientMessageId: value.client_message_id,
    clientAppVersion: value.client_app_version,
    toolChoice: value.tool_choice,
    upstreamFinishReason: value.upstream_finish_reason,
    upstreamRequestId: value.upstream_request_id,
    upstreamHttpStatus: value.upstream_http_status,
    upstreamContentChars: value.upstream_content_chars,
    upstreamToolCallCount: value.upstream_tool_call_count,
    upstreamToolNames: parseStringArray(value.upstream_tool_names_json),
    upstreamRawResponseHash: value.upstream_raw_response_hash,
    upstreamRawResponseChars: value.upstream_raw_response_chars,
    upstreamEmptyStop:
      value.upstream_empty_stop === null ? null : value.upstream_empty_stop === 1,
    upstreamAttemptCount: value.upstream_attempt_count,
    upstreamAttempts: parseUpstreamAttempts(value.upstream_attempts_json),
    startedAt: new Date(value.started_at),
    durationMs: value.duration_ms,
    firstByteMs: value.first_byte_ms,
    status: value.status,
    errorCode: value.error_code,
    rateLimited: value.rate_limited === 1
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

function metadataObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function summarizeClientMessageAttachments(value: unknown): {
  attachmentsCount: number | null;
  pdfAttachmentCount: number | null;
  pdfTotalBytes: number | null;
  pdfMaxBytes: number | null;
  pdfTotalPages: number | null;
  pdfMaxPages: number | null;
  pdfExtractedChars: number | null;
  pdfChunkCount: number | null;
} {
  if (!Array.isArray(value)) {
    return {
      attachmentsCount: null,
      pdfAttachmentCount: null,
      pdfTotalBytes: null,
      pdfMaxBytes: null,
      pdfTotalPages: null,
      pdfMaxPages: null,
      pdfExtractedChars: null,
      pdfChunkCount: null
    };
  }

  let pdfAttachmentCount = 0;
  let pdfTotalBytes = 0;
  let pdfMaxBytes: number | null = null;
  let pdfTotalPages = 0;
  let pdfMaxPages: number | null = null;
  let pdfExtractedChars = 0;
  let pdfChunkCount = 0;
  let hasPdfBytes = false;
  let hasPdfPages = false;
  let hasPdfExtractedChars = false;
  let hasPdfChunkCount = false;

  for (const item of value) {
    const attachment = metadataObject(item);
    if (!isPdfAttachment(attachment)) {
      continue;
    }
    pdfAttachmentCount += 1;

    const size = metadataNumber(attachment, "size");
    if (size !== null) {
      hasPdfBytes = true;
      pdfTotalBytes += size;
      pdfMaxBytes = pdfMaxBytes === null ? size : Math.max(pdfMaxBytes, size);
    }

    const pages = metadataNumber(attachment, "pages");
    if (pages !== null) {
      hasPdfPages = true;
      pdfTotalPages += pages;
      pdfMaxPages = pdfMaxPages === null ? pages : Math.max(pdfMaxPages, pages);
    }

    const extractedChars = metadataNumber(attachment, "extracted_chars");
    if (extractedChars !== null) {
      hasPdfExtractedChars = true;
      pdfExtractedChars += extractedChars;
    }

    const chunkCount = metadataNumber(attachment, "chunk_count");
    if (chunkCount !== null) {
      hasPdfChunkCount = true;
      pdfChunkCount += chunkCount;
    }
  }

  return {
    attachmentsCount: value.length,
    pdfAttachmentCount,
    pdfTotalBytes: hasPdfBytes ? pdfTotalBytes : null,
    pdfMaxBytes,
    pdfTotalPages: hasPdfPages ? pdfTotalPages : null,
    pdfMaxPages,
    pdfExtractedChars: hasPdfExtractedChars ? pdfExtractedChars : null,
    pdfChunkCount: hasPdfChunkCount ? pdfChunkCount : null
  };
}

function summarizeDiagnosticRequestShape(metadata: Record<string, unknown>): {
  pdfCount: number | null;
  pdfTotalBytes: number | null;
  pdfMaxBytes: number | null;
  fileTotalBytes: number | null;
  mediaBase64Bytes: number | null;
  estimatedPromptTokens: number | null;
  toolsSchemaBytes: number | null;
  pdfContextOverflow: boolean | null;
} {
  const requestShape = metadataObject(metadata.request_shape);
  return {
    pdfCount: requestShapeNumber(requestShape, "pdf_count"),
    pdfTotalBytes: requestShapeNumber(requestShape, "pdf_total_bytes"),
    pdfMaxBytes: requestShapeNumber(requestShape, "pdf_max_bytes"),
    fileTotalBytes: requestShapeNumber(requestShape, "file_total_bytes"),
    mediaBase64Bytes: requestShapeNumber(requestShape, "media_base64_bytes"),
    estimatedPromptTokens: requestShapeNumber(requestShape, "estimated_prompt_tokens"),
    toolsSchemaBytes: requestShapeNumber(requestShape, "tools_schema_bytes"),
    pdfContextOverflow: requestShapeBoolean(requestShape, "pdf_context_overflow")
  };
}

function isPdfAttachment(attachment: Record<string, unknown>): boolean {
  const mime = metadataString(attachment, "mime")?.toLowerCase() ?? "";
  const filename = metadataString(attachment, "filename")?.toLowerCase() ?? "";
  return mime === "application/pdf" || filename.endsWith(".pdf");
}

function requestShapeNumber(requestShape: Record<string, unknown>, field: string): number | null {
  for (const scope of requestShapeScopes(requestShape)) {
    const value = metadataNumber(scope, field);
    if (value !== null) {
      return value;
    }
  }
  return null;
}

function requestShapeBoolean(requestShape: Record<string, unknown>, field: string): boolean | null {
  for (const scope of requestShapeScopes(requestShape)) {
    const value = metadataBoolean(scope, field);
    if (value !== null) {
      return value;
    }
  }
  return null;
}

function requestShapeScopes(requestShape: Record<string, unknown>): Array<Record<string, unknown>> {
  const request = metadataObject(requestShape.request);
  return [
    requestShape,
    request,
    metadataObject(request.body),
    metadataObject(request.prompt)
  ];
}

function metadataValue(metadata: Record<string, unknown>, field: string): unknown {
  return metadata[field] === undefined ? null : metadata[field];
}

function metadataString(metadata: Record<string, unknown>, field: string): string | null {
  const value = metadata[field];
  if (typeof value !== "string") {
    return null;
  }
  return value.length > 0 ? value : null;
}

function metadataNumber(metadata: Record<string, unknown>, field: string): number | null {
  const value = metadata[field];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function metadataBoolean(metadata: Record<string, unknown>, field: string): boolean | null {
  const value = metadata[field];
  return typeof value === "boolean" ? value : null;
}

function metadataField(metadata: unknown, field: string): string | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return null;
  }
  const value = (metadata as Record<string, unknown>)[field];
  return typeof value === "string" ? value : null;
}

function clientTurnWindow(
  at: Date | undefined,
  options: ClientTurnQueryOptions,
  now: Date
): { since: Date; until: Date } {
  const center = at ?? now;
  const halfWindowMs = options.windowMinutes * 60 * 1000;
  return {
    since: new Date(center.getTime() - halfWindowMs),
    until: new Date(center.getTime() + halfWindowMs)
  };
}

function turnCandidates(turn: string): { turnCodes: string[]; ids: string[] } {
  const trimmed = turn.trim();
  if (!trimmed) {
    throw new Error("turn must not be blank.");
  }
  const code = normalizedTurnCode(trimmed);
  return {
    turnCodes: [...new Set([trimmed, code].filter(Boolean))],
    ids: [...new Set([trimmed, trimmed.startsWith("T:") ? trimmed.slice(2) : trimmed])]
  };
}

function normalizedTurnCode(turn: string): string {
  const trimmed = turn.trim();
  if (!trimmed) {
    return trimmed;
  }
  return trimmed.startsWith("T:") ? trimmed : `T:${trimmed}`;
}

function placeholders(count: number): string {
  return Array.from({ length: Math.max(1, count) }, () => "?").join(", ");
}

function parseClientTurnAt(value: string, timezone: string): Date {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("--at must not be blank.");
  }
  if (/[zZ]$|[+-]\d{2}:\d{2}$/.test(trimmed)) {
    const date = new Date(trimmed);
    if (Number.isFinite(date.getTime())) {
      return date;
    }
  }
  const local = trimmed.match(
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/
  );
  if (!local) {
    const date = new Date(trimmed);
    if (Number.isFinite(date.getTime())) {
      return date;
    }
    throw new Error("--at must be ISO datetime or YYYY-MM-DD HH:mm.");
  }
  const [, year, month, day, hour, minute, second] = local;
  return zonedDateTimeToUtc(
    {
      year: Number(year),
      month: Number(month),
      day: Number(day),
      hour: Number(hour),
      minute: Number(minute),
      second: second ? Number(second) : 0
    },
    timezone
  );
}

function zonedDateTimeToUtc(
  value: { year: number; month: number; day: number; hour: number; minute: number; second: number },
  timezone: string
): Date {
  let utcMs = Date.UTC(
    value.year,
    value.month - 1,
    value.day,
    value.hour,
    value.minute,
    value.second
  );
  for (let i = 0; i < 3; i += 1) {
    const parts = zonedParts(new Date(utcMs), timezone);
    const asUtc = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second
    );
    const desired = Date.UTC(
      value.year,
      value.month - 1,
      value.day,
      value.hour,
      value.minute,
      value.second
    );
    const diff = desired - asUtc;
    if (diff === 0) {
      break;
    }
    utcMs += diff;
  }
  return new Date(utcMs);
}

function zonedParts(date: Date, timezone: string): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
} {
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
  return {
    year: Number(value.year),
    month: Number(value.month),
    day: Number(value.day),
    hour: Number(value.hour),
    minute: Number(value.minute),
    second: Number(value.second)
  };
}

function parseStringArray(value: string | null): string[] | null {
  if (!value) {
    return null;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function parseUpstreamAttempts(value: string | null): UpstreamAttemptSummary[] | null {
  if (!value) {
    return null;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) {
      return null;
    }
    const attempts = parsed.filter(isUpstreamAttemptSummary);
    return attempts.length > 0 ? attempts : null;
  } catch {
    return null;
  }
}

function isUpstreamAttemptSummary(value: unknown): value is UpstreamAttemptSummary {
  if (!value || typeof value !== "object") {
    return false;
  }
  const attempt = value as Partial<UpstreamAttemptSummary>;
  return (
    typeof attempt.index === "number" &&
    Number.isInteger(attempt.index) &&
    attempt.index > 0 &&
    (attempt.toolNames === undefined ||
      (Array.isArray(attempt.toolNames) &&
        attempt.toolNames.every((name) => typeof name === "string")))
  );
}

function writeMedevidenceToolAuditExport(
  deps: ClientEventQueryCommandDeps,
  rows: Array<Record<string, unknown>>,
  options: ClientMedevidenceToolAuditOptions,
  generatedAt: Date
): void {
  if (options.format === "json") {
    deps.printJson({
      generated_at: generatedAt.toISOString(),
      timezone: options.timezone,
      filters: {
        entrypoint: options.entrypoint,
        min_question_length: options.minQuestionLength,
        limit: options.limit,
        since: (options.since ?? new Date(generatedAt.getTime() - options.hours * 60 * 60 * 1000))
          .toISOString()
      },
      rows
    });
    return;
  }
  if (options.format === "jsonl") {
    deps.printText(rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : ""));
    return;
  }
  deps.printText(toCsv(rows));
}

const medevidenceToolAuditCsvColumns = [
  "request_id",
  "gateway_diagnostic_ingest_request_id",
  "created_at",
  "created_at_local",
  "session_id",
  "message_id",
  "tool_call_id",
  "agent",
  "status",
  "error_code",
  "selected_backend",
  "entrypoint",
  "question",
  "question_length",
  "question_hash",
  "original_user_text",
  "original_user_length",
  "original_user_hash",
  "medevidence_tool_text",
  "question_same_as_user",
  "question_derived",
  "medevidence_question_guard",
  "guard_reject_count",
  "tool_outcome",
  "result_class",
  "article_id",
  "parent_article_id_present"
];

function toCsv(rows: Array<Record<string, unknown>>): string {
  const lines = [medevidenceToolAuditCsvColumns.map(csvCell).join(",")];
  for (const row of rows) {
    lines.push(medevidenceToolAuditCsvColumns.map((column) => csvCell(row[column])).join(","));
  }
  return `${lines.join("\n")}\n`;
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  const text =
    typeof value === "object" ? JSON.stringify(value) : typeof value === "string" ? value : String(value);
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function charLength(value: string): number {
  return Array.from(value).length;
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

function parseAuditExportFormat(value: string): ClientMedevidenceToolAuditFormat {
  if (value === "json" || value === "jsonl" || value === "csv") {
    return value;
  }
  throw new Error("format must be json, jsonl, or csv");
}
