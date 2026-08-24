#!/usr/bin/env node
"use strict";

const { createHash, randomUUID } = require("node:crypto");
const { chmodSync, existsSync, readFileSync, statSync } = require("node:fs");
const { DatabaseSync, backup } = require("node:sqlite");

const FORMAT = "codex_gateway_usage_history.v1";
const MIN_SCHEMA_VERSION = 24;
const PHASE0_REQUEST_EVENT_COLUMNS = [
  "upstream_failure_origin", "upstream_failure_kind", "upstream_failure_stage",
  "upstream_transport_code", "upstream_failure_retry_count",
  "upstream_recovery_attempt_count", "upstream_unclassified_additional_attempt_count"
];
const REASONING_OBSERVABILITY_REQUEST_EVENT_COLUMNS = [
  "requested_reasoning_effort", "effective_reasoning_effort",
  "reasoning_effort_source", "reasoning_effort_normalized",
  "reasoning_effort_normalization_reason"
];

const COLUMNS = {
  request_events: [
    "request_id", "credential_id", "subject_id", "scope", "session_id",
    "upstream_account_id", "provider", "started_at", "duration_ms", "first_byte_ms",
    "status", "error_code", "rate_limited", "prompt_tokens", "completion_tokens",
    "total_tokens", "cached_prompt_tokens", "estimated_tokens", "usage_source", "limit_kind",
    "reservation_id", "over_request_limit", "identity_guard_hit", "public_model_id",
    "upstream_runtime", "upstream_model", "reasoning_effort", "reasoning_tokens",
    "client_turn_id", "turn_code", "client_session_id", "client_message_id",
    "client_app_version", "tool_choice", "upstream_finish_reason", "upstream_request_id",
    "upstream_http_status", "upstream_content_chars", "upstream_tool_call_count",
    "upstream_tool_names_json", "upstream_raw_response_hash", "upstream_raw_response_chars",
    "upstream_empty_stop", "upstream_attempt_count", "upstream_attempts_json",
    "gateway_estimated_prompt_tokens", "gateway_prompt_estimate_method", "model_context_tokens",
    "model_max_output_tokens", "active_tool_count", "client_tool_mode", "tool_loop_guard_json",
    "prompt_chars", "maximum_output_tokens", "gateway_admitted_ms", "provider_first_event_ms",
    "provider_duration_ms", "terminal_source", "cancel_requested", "cancel_observed",
    ...PHASE0_REQUEST_EVENT_COLUMNS,
    ...REASONING_OBSERVABILITY_REQUEST_EVENT_COLUMNS
  ],
  token_reservations: [
    "id", "request_id", "kind", "credential_id", "subject_id", "scope",
    "upstream_account_id", "provider", "created_at", "expires_at", "finalized_at",
    "estimated_prompt_tokens", "estimated_total_tokens", "reserved_tokens",
    "final_prompt_tokens", "final_completion_tokens", "final_total_tokens",
    "final_cached_prompt_tokens", "final_estimated_tokens", "final_usage_source",
    "charge_policy_snapshot", "minute_window_start", "day_window_start", "month_window_start",
    "max_prompt_tokens_per_request", "max_total_tokens_per_request", "over_request_limit",
    "policy_json", "entitlement_id", "public_model_id", "upstream_runtime", "upstream_model",
    "reasoning_effort", "final_reasoning_tokens"
  ],
  admin_audit_events: [
    "id", "action", "target_user_id", "target_credential_id", "target_credential_prefix",
    "status", "params_json", "error_message", "created_at"
  ]
};

const PRIMARY_KEY = {
  request_events: "request_id",
  token_reservations: "id",
  admin_audit_events: "id"
};

const TIMESTAMP_COLUMN = {
  request_events: "started_at",
  token_reservations: "created_at",
  admin_audit_events: "created_at"
};

const IMMUTABLE = {
  request_events: ["request_id", "started_at"],
  token_reservations: [
    "id", "request_id", "kind", "credential_id", "subject_id", "entitlement_id", "scope",
    "created_at", "charge_policy_snapshot", "minute_window_start", "day_window_start",
    "month_window_start"
  ],
  admin_audit_events: COLUMNS.admin_audit_events
};

const USAGE_FIELDS = [
  "final_prompt_tokens", "final_completion_tokens", "final_total_tokens",
  "final_cached_prompt_tokens", "final_estimated_tokens"
];

function fail(message) {
  throw new Error(message);
}

function quoteIdentifier(value) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) fail("Unsafe SQL identifier.");
  return `"${value}"`;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function payloadBody(payload) {
  return {
    format: payload.format,
    migration: payload.migration,
    since: payload.since,
    until: payload.until,
    columns: payload.columns,
    tables: payload.tables
  };
}

function payloadDigest(payload) {
  return sha256(stableJson(payloadBody(payload)));
}

function schemaVersion(db) {
  return Number(db.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations").get().version);
}

function tableColumns(db, table) {
  return db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all().map((row) => row.name);
}

function arraysEqual(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function requestEventColumnVariants() {
  const groups = [
    PHASE0_REQUEST_EVENT_COLUMNS,
    REASONING_OBSERVABILITY_REQUEST_EVENT_COLUMNS
  ];
  let variants = [COLUMNS.request_events];
  for (const group of groups) {
    variants = [
      ...variants,
      ...variants.map((columns) => columns.filter((column) => !group.includes(column)))
    ];
  }
  return variants;
}

function supportedColumns(table, columns) {
  const variants = table === "request_events"
    ? requestEventColumnVariants()
    : [COLUMNS[table]];
  return variants.some((expected) => arraysEqual(columns, expected));
}

function missingColumnValue(table, column) {
  if (table === "request_events" && column === "reasoning_effort_normalized") {
    return 0;
  }
  return null;
}

function validateSchema(db) {
  const migration = schemaVersion(db);
  if (migration < MIN_SCHEMA_VERSION) fail(`Gateway schema v${MIN_SCHEMA_VERSION} or newer is required.`);
  const columns = {};
  for (const [table, expected] of Object.entries(COLUMNS)) {
    columns[table] = tableColumns(db, table);
    if (!supportedColumns(table, columns[table])) {
      fail(`Unsupported schema columns for ${table}; update the usage helper first.`);
    }
  }
  return { migration, columns };
}

function assertIso(value, label) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) fail(`${label} must be an ISO timestamp.`);
}

function readRows(db, table, since, until, finalizedOnly = true, selectedColumns = COLUMNS[table]) {
  const columns = selectedColumns.map(quoteIdentifier).join(", ");
  const time = quoteIdentifier(TIMESTAMP_COLUMN[table]);
  const finalized = table === "token_reservations" && finalizedOnly ? " AND finalized_at IS NOT NULL" : "";
  return db.prepare(
    `SELECT ${columns} FROM ${quoteIdentifier(table)} ` +
    `WHERE ${time} >= ? AND ${time} < ?${finalized} ORDER BY ${time}, ${quoteIdentifier(PRIMARY_KEY[table])}`
  ).all(since, until);
}

function readTables(db, since, until, finalizedOnly = true, columns = COLUMNS) {
  return Object.fromEntries(
    Object.keys(COLUMNS).map((table) => [
      table,
      readRows(db, table, since, until, finalizedOnly, columns[table])
    ])
  );
}

function rowExact(table, left, right) {
  return COLUMNS[table].every((column) => left[column] === right[column]);
}

function validatePayload(payload, targetSchema) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) fail("Usage payload must be an object.");
  if (payload.format !== FORMAT) fail("Unsupported usage payload format.");
  if (!Number.isInteger(payload.migration) || payload.migration < MIN_SCHEMA_VERSION) {
    fail(`Source Gateway schema v${MIN_SCHEMA_VERSION} or newer is required.`);
  }
  if (payload.migration > targetSchema.migration) fail("Source Gateway schema is newer than target.");
  assertIso(payload.since, "since");
  assertIso(payload.until, "until");
  if (Date.parse(payload.until) <= Date.parse(payload.since)) fail("Usage payload window is empty.");
  if (typeof payload.digest !== "string" || !/^[a-f0-9]{64}$/.test(payload.digest)) fail("Usage payload digest is invalid.");
  if (payloadDigest(payload) !== payload.digest) fail("Usage payload digest verification failed.");
  for (const table of Object.keys(COLUMNS)) {
    const sourceColumns = payload.columns?.[table] || [];
    if (!supportedColumns(table, sourceColumns) ||
        !arraysEqual(targetSchema.columns[table], COLUMNS[table])) {
      fail(`Source and target columns differ for ${table}.`);
    }
    if (!Array.isArray(payload.tables?.[table])) fail(`Usage payload is missing ${table}.`);
    const seen = new Set();
    for (const row of payload.tables[table]) {
      if (!row || typeof row !== "object" || Array.isArray(row) ||
          !arraysEqual(Object.keys(row), sourceColumns)) fail(`Invalid row shape for ${table}.`);
      const key = String(row[PRIMARY_KEY[table]]);
      if (seen.has(key)) fail(`Duplicate primary key in ${table}.`);
      seen.add(key);
    }
  }
  return {
    ...payload,
    columns: COLUMNS,
    tables: Object.fromEntries(Object.keys(COLUMNS).map((table) => [
      table,
      payload.tables[table].map((row) => Object.fromEntries(
        COLUMNS[table].map((column) => [
          column,
          row[column] ?? missingColumnValue(table, column)
        ])
      ))
    ]))
  };
}

function assertDependencies(db, reservations) {
  const subject = db.prepare("SELECT 1 FROM subjects WHERE id = ?");
  const credential = db.prepare("SELECT 1 FROM access_credentials WHERE id = ?");
  const entitlement = db.prepare("SELECT 1 FROM entitlements WHERE id = ?");
  for (const row of reservations) {
    if (!subject.get(row.subject_id) || !credential.get(row.credential_id) ||
        (row.entitlement_id !== null && !entitlement.get(row.entitlement_id))) {
      fail("Usage payload references control state missing from the target; sync control state first.");
    }
  }
}

function analyze(db, payload) {
  const schema = validateSchema(db);
  const normalizedPayload = validatePayload(payload, schema);
  assertDependencies(db, normalizedPayload.tables.token_reservations);
  const targetTables = readTables(
    db,
    normalizedPayload.since,
    normalizedPayload.until,
    false,
    schema.columns
  );
  const targetMaps = {};
  const summary = {};

  for (const table of Object.keys(COLUMNS)) {
    const target = new Map(targetTables[table].map((row) => [String(row[PRIMARY_KEY[table]]), row]));
    targetMaps[table] = target;
    let inserted = 0;
    let updated = 0;
    let unchanged = 0;
    for (const row of normalizedPayload.tables[table]) {
      const existing = target.get(String(row[PRIMARY_KEY[table]]));
      if (!existing) {
        if (table === "token_reservations") {
          const conflict = db.prepare("SELECT id FROM token_reservations WHERE request_id = ?").get(row.request_id);
          if (conflict) fail("Token reservation request identity conflict; no rows were changed.");
        }
        inserted += 1;
        continue;
      }
      for (const column of IMMUTABLE[table]) {
        if (existing[column] !== row[column]) fail(`Immutable identity conflict in ${table}.${column}; no rows were changed.`);
      }
      if (rowExact(table, row, existing)) unchanged += 1;
      else if (table === "admin_audit_events") fail("Admin audit rows are immutable; no rows were changed.");
      else updated += 1;
    }
    summary[table] = {
      source: normalizedPayload.tables[table].length,
      target_in_window: targetTables[table].length,
      insert: inserted,
      update: updated,
      unchanged
    };
  }
  const changedRows = Object.values(summary).reduce((sum, row) => sum + row.insert + row.update, 0);
  return { summary, changedRows, targetMaps, payload: normalizedPayload };
}

function insertOrUpdate(db, table, row) {
  const columns = COLUMNS[table];
  const pk = PRIMARY_KEY[table];
  const updates = columns.filter((column) => column !== pk);
  const sql = `INSERT INTO ${quoteIdentifier(table)} (${columns.map(quoteIdentifier).join(", ")}) ` +
    `VALUES (${columns.map(() => "?").join(", ")}) ON CONFLICT(${quoteIdentifier(pk)}) DO UPDATE SET ` +
    updates.map((column) => `${quoteIdentifier(column)} = excluded.${quoteIdentifier(column)}`).join(", ");
  db.prepare(sql).run(...columns.map((column) => row[column]));
}

function insertOnly(db, table, row) {
  const columns = COLUMNS[table];
  db.prepare(
    `INSERT INTO ${quoteIdentifier(table)} (${columns.map(quoteIdentifier).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`
  ).run(...columns.map((column) => row[column]));
}

function usageDelta(row, existing) {
  const delta = Object.fromEntries(USAGE_FIELDS.map((field) => [field, Number(row[field] || 0) - Number(existing?.[field] || 0)]));
  delta.requests = 1 - (existing?.finalized_at ? 1 : 0);
  return delta;
}

function applyWindowDelta(db, table, identityColumn, identity, kind, start, delta, updatedAt) {
  if (Object.values(delta).every((value) => value === 0)) return;
  const sql = `INSERT INTO ${quoteIdentifier(table)} (` +
    `${quoteIdentifier(identityColumn)}, window_kind, window_start, prompt_tokens, completion_tokens, ` +
    `total_tokens, cached_prompt_tokens, estimated_tokens, requests, updated_at) ` +
    `VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(${quoteIdentifier(identityColumn)}, window_kind, window_start) DO UPDATE SET ` +
    `prompt_tokens = prompt_tokens + excluded.prompt_tokens, ` +
    `completion_tokens = completion_tokens + excluded.completion_tokens, ` +
    `total_tokens = total_tokens + excluded.total_tokens, ` +
    `cached_prompt_tokens = cached_prompt_tokens + excluded.cached_prompt_tokens, ` +
    `estimated_tokens = estimated_tokens + excluded.estimated_tokens, ` +
    `requests = requests + excluded.requests, updated_at = excluded.updated_at`;
  db.prepare(sql).run(
    identity, kind, start, delta.final_prompt_tokens, delta.final_completion_tokens,
    delta.final_total_tokens, delta.final_cached_prompt_tokens, delta.final_estimated_tokens,
    delta.requests, updatedAt
  );
  const row = db.prepare(
    `SELECT prompt_tokens, completion_tokens, total_tokens, cached_prompt_tokens, estimated_tokens, requests ` +
    `FROM ${quoteIdentifier(table)} WHERE ${quoteIdentifier(identityColumn)} = ? AND window_kind = ? AND window_start = ?`
  ).get(identity, kind, start);
  if (!row || Object.values(row).some((value) => Number(value) < 0)) fail(`Usage window underflow in ${table}.`);
}

function applyReservation(db, row, existing) {
  const delta = usageDelta(row, existing);
  insertOrUpdate(db, "token_reservations", row);
  const windows = [
    ["minute", row.minute_window_start],
    ["day", row.day_window_start],
    ["month", row.month_window_start]
  ];
  for (const [kind, start] of windows) {
    applyWindowDelta(db, "token_windows", "subject_id", row.subject_id, kind, start, delta, row.finalized_at);
    if (row.entitlement_id !== null) {
      applyWindowDelta(db, "entitlement_token_windows", "entitlement_id", row.entitlement_id, kind, start, delta, row.finalized_at);
    }
  }
}

function assertHealthy(db) {
  const quick = db.prepare("PRAGMA quick_check").all().map((row) => Object.values(row)[0]);
  if (quick.length !== 1 || quick[0] !== "ok") fail("SQLite quick_check failed.");
  if (db.prepare("PRAGMA foreign_key_check").all().length !== 0) fail("SQLite foreign_key_check failed.");
  return { quick_check: "ok", foreign_key_violations: 0 };
}

function assertSourceSubset(db, payload) {
  const actual = readTables(db, payload.since, payload.until, false);
  for (const table of Object.keys(COLUMNS)) {
    const map = new Map(actual[table].map((row) => [String(row[PRIMARY_KEY[table]]), row]));
    for (const row of payload.tables[table]) {
      if (!map.has(String(row[PRIMARY_KEY[table]])) || !rowExact(table, row, map.get(String(row[PRIMARY_KEY[table]])))) {
        fail(`Post-apply source subset verification failed for ${table}.`);
      }
    }
  }
}

function writeAudit(db, payload, analysis, backupId, sourceName, targetName) {
  db.prepare(
    `INSERT INTO admin_audit_events (id, action, target_user_id, target_credential_id, ` +
    `target_credential_prefix, status, params_json, error_message, created_at) ` +
    `VALUES (?, 'gateway-usage-history-sync', NULL, NULL, NULL, 'ok', ?, NULL, ?)`
  ).run(
    `audit_${randomUUID()}`,
    JSON.stringify({
      format: FORMAT,
      source: sourceName,
      target: targetName,
      source_digest: payload.digest,
      since: payload.since,
      until: payload.until,
      backup_id: backupId || null,
      counts: Object.fromEntries(Object.entries(analysis.summary).map(([table, row]) => [table, { insert: row.insert, update: row.update }]))
    }),
    new Date().toISOString()
  );
}

function exportPayload(db, since, until) {
  const schema = validateSchema(db);
  const payload = { format: FORMAT, migration: schema.migration, since, until, columns: schema.columns, tables: readTables(db, since, until, true, schema.columns) };
  payload.digest = payloadDigest(payload);
  return payload;
}

function applyPayload(db, payload, backupId, sourceName, targetName) {
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 15000");
  db.exec("BEGIN IMMEDIATE");
  try {
    const analysis = analyze(db, payload);
    const normalizedPayload = analysis.payload;
    if (analysis.changedRows === 0) {
      db.exec("COMMIT");
      return { applied: false, changed_rows: 0, source_digest: payload.digest, tables: analysis.summary, integrity: assertHealthy(db) };
    }
    for (const row of normalizedPayload.tables.request_events) insertOrUpdate(db, "request_events", row);
    for (const row of normalizedPayload.tables.token_reservations) {
      applyReservation(db, row, analysis.targetMaps.token_reservations.get(String(row.id)));
    }
    for (const row of normalizedPayload.tables.admin_audit_events) {
      if (!analysis.targetMaps.admin_audit_events.has(String(row.id))) insertOnly(db, "admin_audit_events", row);
    }
    assertSourceSubset(db, normalizedPayload);
    const integrity = assertHealthy(db);
    writeAudit(db, payload, analysis, backupId, sourceName, targetName);
    db.exec("COMMIT");
    return { applied: true, changed_rows: analysis.changedRows, source_digest: payload.digest, tables: analysis.summary, integrity };
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

async function readStdin() {
  const chunks = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    length += chunk.length;
    if (length > 128 * 1024 * 1024) fail("Usage payload exceeds 128 MiB.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function argument(name, required = true) {
  const index = process.argv.indexOf(name);
  if (index === -1 || index + 1 >= process.argv.length) {
    if (required) fail(`Missing required argument ${name}.`);
    return null;
  }
  return process.argv[index + 1];
}

async function main() {
  const command = process.argv[2];
  const dbPath = argument("--db");
  if (command === "inspect") {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const schema = validateSchema(db);
      const secret = process.env.GATEWAY_API_KEY_ENCRYPTION_SECRET || "";
      process.stdout.write(JSON.stringify({
        format: FORMAT,
        migration: schema.migration,
        integrity: assertHealthy(db),
        encryption_secret_sha256: secret ? sha256(secret) : null,
        open_reservations: Number(db.prepare("SELECT COUNT(*) AS count FROM token_reservations WHERE finalized_at IS NULL").get().count)
      }));
    } finally { db.close(); }
    return;
  }
  if (command === "export") {
    const since = argument("--since");
    const until = argument("--until");
    assertIso(since, "since");
    assertIso(until, "until");
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      db.exec("BEGIN");
      const payload = exportPayload(db, since, until);
      db.exec("COMMIT");
      process.stdout.write(JSON.stringify(payload));
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch {}
      throw error;
    } finally { db.close(); }
    return;
  }
  if (command === "plan" || command === "apply") {
    const payload = JSON.parse(await readStdin());
    const db = new DatabaseSync(dbPath, { readOnly: command === "plan" });
    try {
      if (command === "plan") {
        const analysis = analyze(db, payload);
        process.stdout.write(JSON.stringify({ apply_required: analysis.changedRows > 0, changed_rows: analysis.changedRows, source_digest: payload.digest, tables: analysis.summary }));
      } else {
        process.stdout.write(JSON.stringify(applyPayload(
          db, payload, argument("--backup-id", false),
          argument("--source-name", false) || "unknown",
          argument("--target-name", false) || "unknown"
        )));
      }
    } finally { db.close(); }
    return;
  }
  if (command === "backup") {
    const output = argument("--output");
    if (existsSync(output)) fail("Backup output already exists.");
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try { validateSchema(db); await backup(db, output); } finally { db.close(); }
    chmodSync(output, 0o600);
    const snapshot = new DatabaseSync(output, { readOnly: true });
    try {
      process.stdout.write(JSON.stringify({ size_bytes: statSync(output).size, sha256: sha256(readFileSync(output)), integrity: assertHealthy(snapshot) }));
    } finally { snapshot.close(); }
    return;
  }
  fail("Command must be inspect, export, plan, apply, or backup.");
}

main().catch((error) => {
  process.stderr.write(JSON.stringify({ error: error instanceof Error ? error.message : "Unknown usage sync error." }) + "\n");
  process.exitCode = 1;
});
