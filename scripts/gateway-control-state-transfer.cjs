#!/usr/bin/env node
"use strict";

const { createHash, randomUUID } = require("node:crypto");
const { chmodSync, existsSync, statSync } = require("node:fs");
const { DatabaseSync, backup } = require("node:sqlite");

const FORMAT = "codex_gateway_control_state.v1";
const MIN_SCHEMA_VERSION = 25;

const TABLES = {
  plans: {
    primaryKey: ["id"],
    immutable: ["policy_json", "feature_policy_json", "created_at"],
    unique: []
  },
  subjects: {
    primaryKey: ["id"],
    immutable: ["created_at", "external_provider", "external_user_id"],
    unique: [["external_provider", "external_user_id"]]
  },
  access_credentials: {
    primaryKey: ["id"],
    immutable: [
      "prefix",
      "hash",
      "subject_id",
      "scope",
      "created_at",
      "token_ciphertext"
    ],
    unique: [["prefix"]]
  },
  entitlements: {
    primaryKey: ["id"],
    immutable: [
      "subject_id",
      "plan_id",
      "policy_snapshot_json",
      "scope_allowlist_json",
      "period_kind",
      "period_start",
      "created_at",
      "feature_policy_snapshot_json"
    ],
    unique: []
  },
  unified_client_keys: {
    primaryKey: ["id"],
    immutable: [
      "prefix",
      "hash",
      "subject_id",
      "codex_credential_id",
      "codex_credential_prefix",
      "codex_key_ciphertext",
      "medevidence_key_ciphertext",
      "medevidence_key_prefix",
      "token_ciphertext",
      "created_at"
    ],
    unique: [["prefix"], ["hash"]]
  },
  upstream_v2_bindings: {
    primaryKey: ["subject_id"],
    immutable: ["subject_id", "v2_user_id", "created_at"],
    unique: [["v2_user_id"]]
  },
  billing_events: {
    primaryKey: ["id"],
    immutable: [
      "idempotency_key",
      "payload_hash",
      "provider",
      "external_order_id",
      "external_event_id",
      "event_type",
      "apply_mode",
      "subject_id",
      "plan_id",
      "amount_minor",
      "currency",
      "period_kind",
      "period_start",
      "period_end",
      "created_at"
    ],
    unique: [["idempotency_key"]]
  },
  billing_subject_events: {
    primaryKey: ["id"],
    immutable: [
      "idempotency_key",
      "payload_hash",
      "event_type",
      "provider",
      "external_user_id",
      "subject_id",
      "created_at"
    ],
    unique: [["idempotency_key"]]
  }
};

const EXPECTED_COLUMNS = {
  plans: [
    "id", "display_name", "policy_json", "scope_allowlist_json",
    "priority_class", "team_pool_id", "state", "created_at",
    "metadata_json", "feature_policy_json"
  ],
  subjects: [
    "id", "label", "state", "created_at", "name", "phone_number",
    "external_provider", "external_user_id", "display_name"
  ],
  access_credentials: [
    "id", "prefix", "hash", "subject_id", "label", "scope",
    "expires_at", "revoked_at", "rate_json", "created_at", "rotates_id",
    "token_ciphertext", "allowed_public_models_json", "credential_class"
  ],
  entitlements: [
    "id", "subject_id", "plan_id", "policy_snapshot_json",
    "scope_allowlist_json", "period_kind", "period_start", "period_end",
    "state", "team_seat_id", "created_at", "cancelled_at",
    "cancelled_reason", "notes", "feature_policy_snapshot_json"
  ],
  unified_client_keys: [
    "id", "prefix", "hash", "subject_id", "label", "expires_at",
    "revoked_at", "codex_credential_id", "codex_credential_prefix",
    "codex_key_ciphertext", "medevidence_key_ciphertext",
    "medevidence_key_prefix", "created_at", "metadata_json",
    "token_ciphertext", "credential_class", "is_current"
  ],
  upstream_v2_bindings: [
    "subject_id", "v2_user_id", "v2_key_id", "state", "last_synced_at",
    "metadata_json", "created_at", "updated_at"
  ],
  billing_events: [
    "id", "idempotency_key", "payload_hash", "provider",
    "external_order_id", "external_event_id", "event_type", "apply_mode",
    "subject_id", "plan_id", "entitlement_id", "status", "amount_minor",
    "currency", "period_kind", "period_start", "period_end", "applied_at",
    "error_message", "metadata_json", "created_at"
  ],
  billing_subject_events: [
    "id", "idempotency_key", "payload_hash", "event_type", "provider",
    "external_user_id", "subject_id", "credential_id", "credential_prefix",
    "unified_key_id", "unified_key_prefix", "status", "error_message",
    "metadata_json", "applied_at", "created_at"
  ]
};

function fail(message) {
  throw new Error(message);
}

function quoteIdentifier(value) {
  if (!/^[a-z0-9_]+$/.test(value)) {
    fail("Unsafe SQL identifier.");
  }
  return `"${value}"`;
}

function arraysEqual(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function stableValue(value) {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, stableValue(value[key])])
    );
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
    columns: payload.columns,
    tables: payload.tables
  };
}

function payloadDigest(payload) {
  return sha256(stableJson(payloadBody(payload)));
}

function schemaVersion(db) {
  const row = db.prepare(
    "SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations"
  ).get();
  return Number(row.version);
}

function tableColumns(db, table) {
  return db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all().map((row) => row.name);
}

function validateDatabaseSchema(db) {
  const migration = schemaVersion(db);
  if (migration < MIN_SCHEMA_VERSION) {
    fail(`Gateway schema v${MIN_SCHEMA_VERSION} or newer is required.`);
  }
  const columns = {};
  for (const table of Object.keys(TABLES)) {
    columns[table] = tableColumns(db, table);
    if (!arraysEqual(columns[table], EXPECTED_COLUMNS[table])) {
      fail(`Unsupported schema columns for ${table}; update the sync helper first.`);
    }
  }
  return { migration, columns };
}

function readTable(db, table) {
  const columns = EXPECTED_COLUMNS[table];
  const order = TABLES[table].primaryKey.map(quoteIdentifier).join(", ");
  const selection = columns.map(quoteIdentifier).join(", ");
  return db.prepare(
    `SELECT ${selection} FROM ${quoteIdentifier(table)} ORDER BY ${order}`
  ).all();
}

function readAllTables(db) {
  return Object.fromEntries(Object.keys(TABLES).map((table) => [table, readTable(db, table)]));
}

function primaryKey(table, row) {
  return stableJson(TABLES[table].primaryKey.map((column) => row[column]));
}

function naturalKey(row, columns) {
  const values = columns.map((column) => row[column]);
  if (values.some((value) => value === null || value === undefined)) {
    return null;
  }
  return stableJson(values);
}

function rowIsExact(table, left, right) {
  return EXPECTED_COLUMNS[table].every((column) => left[column] === right[column]);
}

function validatePayload(payload, targetSchema) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    fail("Control-state payload must be a JSON object.");
  }
  if (payload.format !== FORMAT) {
    fail("Unsupported control-state payload format.");
  }
  if (!Number.isInteger(payload.migration) || payload.migration !== targetSchema.migration) {
    fail("Source and target Gateway schema versions differ.");
  }
  if (typeof payload.digest !== "string" || !/^[a-f0-9]{64}$/.test(payload.digest)) {
    fail("Control-state payload digest is missing or invalid.");
  }
  if (payloadDigest(payload) !== payload.digest) {
    fail("Control-state payload digest verification failed.");
  }
  for (const table of Object.keys(TABLES)) {
    if (!Array.isArray(payload.columns?.[table]) ||
        !arraysEqual(payload.columns[table], EXPECTED_COLUMNS[table]) ||
        !arraysEqual(payload.columns[table], targetSchema.columns[table])) {
      fail(`Source and target columns differ for ${table}.`);
    }
    if (!Array.isArray(payload.tables?.[table])) {
      fail(`Control-state payload is missing table ${table}.`);
    }
    const seen = new Set();
    for (const row of payload.tables[table]) {
      if (!row || typeof row !== "object" || Array.isArray(row) ||
          !arraysEqual(Object.keys(row), EXPECTED_COLUMNS[table])) {
        fail(`Control-state row shape is invalid for ${table}.`);
      }
      const key = primaryKey(table, row);
      if (seen.has(key)) {
        fail(`Duplicate primary key in source table ${table}.`);
      }
      seen.add(key);
    }
  }
}

function analyze(db, payload) {
  const targetSchema = validateDatabaseSchema(db);
  validatePayload(payload, targetSchema);
  const targetTables = readAllTables(db);
  const summary = {};
  const targetMaps = {};

  for (const table of Object.keys(TABLES)) {
    const sourceRows = payload.tables[table];
    const targetRows = targetTables[table];
    const targetByPrimary = new Map(targetRows.map((row) => [primaryKey(table, row), row]));
    targetMaps[table] = targetByPrimary;

    for (const uniqueColumns of TABLES[table].unique) {
      const targetByNatural = new Map();
      for (const row of targetRows) {
        const key = naturalKey(row, uniqueColumns);
        if (key !== null) {
          targetByNatural.set(key, primaryKey(table, row));
        }
      }
      for (const row of sourceRows) {
        const key = naturalKey(row, uniqueColumns);
        if (key === null) {
          continue;
        }
        const targetPrimary = targetByNatural.get(key);
        if (targetPrimary !== undefined && targetPrimary !== primaryKey(table, row)) {
          fail(`Unique identity conflict in ${table}; no rows were changed.`);
        }
      }
    }

    let inserted = 0;
    let updated = 0;
    let unchanged = 0;
    for (const row of sourceRows) {
      const target = targetByPrimary.get(primaryKey(table, row));
      if (!target) {
        inserted += 1;
        continue;
      }
      for (const column of TABLES[table].immutable) {
        if (target[column] !== row[column]) {
          fail(`Immutable identity conflict in ${table}.${column}; no rows were changed.`);
        }
      }
      if (rowIsExact(table, row, target)) {
        unchanged += 1;
      } else {
        updated += 1;
      }
    }
    summary[table] = {
      source: sourceRows.length,
      target_before: targetRows.length,
      target_only: targetRows.length - sourceRows.filter(
        (row) => targetByPrimary.has(primaryKey(table, row))
      ).length,
      insert: inserted,
      update: updated,
      unchanged
    };
  }

  const changedRows = Object.values(summary).reduce(
    (total, value) => total + value.insert + value.update,
    0
  );
  return { summary, changedRows, targetMaps };
}

function insertRow(db, table, row, overrides = {}) {
  const columns = EXPECTED_COLUMNS[table];
  const values = columns.map((column) =>
    Object.prototype.hasOwnProperty.call(overrides, column) ? overrides[column] : row[column]
  );
  const statement = `INSERT INTO ${quoteIdentifier(table)} (${columns.map(quoteIdentifier).join(", ")}) ` +
    `VALUES (${columns.map(() => "?").join(", ")})`;
  db.prepare(statement).run(...values);
}

function updateRow(db, table, row, excluded = []) {
  const excludedSet = new Set([
    ...TABLES[table].primaryKey,
    ...TABLES[table].immutable,
    ...excluded
  ]);
  const columns = EXPECTED_COLUMNS[table].filter((column) => !excludedSet.has(column));
  if (columns.length === 0) {
    return;
  }
  const where = TABLES[table].primaryKey.map((column) => `${quoteIdentifier(column)} = ?`).join(" AND ");
  const statement = `UPDATE ${quoteIdentifier(table)} SET ` +
    columns.map((column) => `${quoteIdentifier(column)} = ?`).join(", ") +
    ` WHERE ${where}`;
  const values = [
    ...columns.map((column) => row[column]),
    ...TABLES[table].primaryKey.map((column) => row[column])
  ];
  const result = db.prepare(statement).run(...values);
  if (Number(result.changes) !== 1) {
    fail(`Unexpected update count for ${table}.`);
  }
}

function applyTable(db, table, sourceRows, targetMap) {
  for (const row of sourceRows) {
    const target = targetMap.get(primaryKey(table, row));
    if (!target) {
      const overrides = table === "access_credentials" ? { rotates_id: null } : {};
      insertRow(db, table, row, overrides);
    } else if (!rowIsExact(table, row, target)) {
      updateRow(db, table, row, table === "access_credentials" ? ["rotates_id"] : []);
    }
  }
  if (table === "access_credentials") {
    const statement = db.prepare("UPDATE access_credentials SET rotates_id = ? WHERE id = ?");
    for (const row of sourceRows) {
      const target = targetMap.get(primaryKey(table, row));
      if (!target || target.rotates_id !== row.rotates_id) {
        statement.run(row.rotates_id, row.id);
      }
    }
  }
}

function assertDatabaseHealthy(db) {
  const quick = db.prepare("PRAGMA quick_check").all().map((row) => Object.values(row)[0]);
  if (quick.length !== 1 || quick[0] !== "ok") {
    fail("SQLite quick_check failed.");
  }
  const foreignKeys = db.prepare("PRAGMA foreign_key_check").all();
  if (foreignKeys.length !== 0) {
    fail("SQLite foreign_key_check failed.");
  }
  return { quick_check: "ok", foreign_key_violations: 0 };
}

function assertSourceSubset(db, payload) {
  for (const table of Object.keys(TABLES)) {
    const targetMap = new Map(readTable(db, table).map((row) => [primaryKey(table, row), row]));
    for (const row of payload.tables[table]) {
      const target = targetMap.get(primaryKey(table, row));
      if (!target || !rowIsExact(table, row, target)) {
        fail(`Post-apply source subset verification failed for ${table}.`);
      }
    }
  }
}

function writeAudit(db, payload, analysis, backupId, sourceName, targetName) {
  const counts = Object.fromEntries(
    Object.entries(analysis.summary).map(([table, value]) => [
      table,
      { insert: value.insert, update: value.update, source: value.source }
    ])
  );
  db.prepare(
    `INSERT INTO admin_audit_events (
      id, action, target_user_id, target_credential_id,
      target_credential_prefix, status, params_json, error_message, created_at
    ) VALUES (?, ?, NULL, NULL, NULL, ?, ?, NULL, ?)`
  ).run(
    `audit_${randomUUID()}`,
    "gateway-control-state-sync",
    "ok",
    JSON.stringify({
      format: FORMAT,
      source_digest: payload.digest,
      source: sourceName,
      target: targetName,
      backup_id: backupId || null,
      counts
    }),
    new Date().toISOString()
  );
}

function exportPayload(db) {
  const schema = validateDatabaseSchema(db);
  db.exec("BEGIN");
  try {
    const payload = {
      format: FORMAT,
      migration: schema.migration,
      columns: schema.columns,
      tables: readAllTables(db)
    };
    payload.digest = payloadDigest(payload);
    db.exec("COMMIT");
    return payload;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function applyPayload(db, payload, backupId, sourceName, targetName) {
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 15000");
  db.exec("BEGIN IMMEDIATE");
  try {
    const analysis = analyze(db, payload);
    if (analysis.changedRows === 0) {
      db.exec("COMMIT");
      return {
        applied: false,
        changed_rows: 0,
        source_digest: payload.digest,
        tables: analysis.summary,
        integrity: assertDatabaseHealthy(db)
      };
    }
    for (const table of Object.keys(TABLES)) {
      applyTable(db, table, payload.tables[table], analysis.targetMaps[table]);
    }
    assertSourceSubset(db, payload);
    const integrity = assertDatabaseHealthy(db);
    writeAudit(db, payload, analysis, backupId, sourceName, targetName);
    db.exec("COMMIT");
    return {
      applied: true,
      changed_rows: analysis.changedRows,
      source_digest: payload.digest,
      tables: analysis.summary,
      integrity
    };
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw error;
  }
}

async function readStdin() {
  const chunks = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    length += chunk.length;
    if (length > 64 * 1024 * 1024) {
      fail("Control-state payload exceeds 64 MiB.");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function argument(name, required = true) {
  const index = process.argv.indexOf(name);
  if (index === -1 || index + 1 >= process.argv.length) {
    if (required) {
      fail(`Missing required argument ${name}.`);
    }
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
      const schema = validateDatabaseSchema(db);
      const counts = Object.fromEntries(
        Object.keys(TABLES).map((table) => [table, readTable(db, table).length])
      );
      const secret = process.env.GATEWAY_API_KEY_ENCRYPTION_SECRET || "";
      process.stdout.write(JSON.stringify({
        format: FORMAT,
        migration: schema.migration,
        counts,
        integrity: assertDatabaseHealthy(db),
        encryption_secret_sha256: secret ? sha256(secret) : null
      }));
    } finally {
      db.close();
    }
    return;
  }

  if (command === "export") {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      process.stdout.write(JSON.stringify(exportPayload(db)));
    } finally {
      db.close();
    }
    return;
  }

  if (command === "plan" || command === "apply") {
    const payload = JSON.parse(await readStdin());
    const db = new DatabaseSync(dbPath, { readOnly: command === "plan" });
    try {
      if (command === "plan") {
        const analysis = analyze(db, payload);
        process.stdout.write(JSON.stringify({
          apply_required: analysis.changedRows > 0,
          changed_rows: analysis.changedRows,
          source_digest: payload.digest,
          tables: analysis.summary
        }));
      } else {
        const result = applyPayload(
          db,
          payload,
          argument("--backup-id", false),
          argument("--source-name", false) || "unknown",
          argument("--target-name", false) || "unknown"
        );
        process.stdout.write(JSON.stringify(result));
      }
    } finally {
      db.close();
    }
    return;
  }

  if (command === "backup") {
    const output = argument("--output");
    if (existsSync(output)) {
      fail("Backup output already exists.");
    }
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      validateDatabaseSchema(db);
      await backup(db, output);
    } finally {
      db.close();
    }
    chmodSync(output, 0o600);
    const snapshot = new DatabaseSync(output, { readOnly: true });
    try {
      const integrity = assertDatabaseHealthy(snapshot);
      const bytes = require("node:fs").readFileSync(output);
      process.stdout.write(JSON.stringify({
        size_bytes: statSync(output).size,
        sha256: sha256(bytes),
        integrity
      }));
    } finally {
      snapshot.close();
    }
    return;
  }

  fail("Command must be inspect, export, plan, apply, or backup.");
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : "Unknown sync helper error.";
  process.stderr.write(JSON.stringify({ error: message }) + "\n");
  process.exitCode = 1;
});
