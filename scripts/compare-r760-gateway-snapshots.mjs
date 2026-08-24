#!/usr/bin/env node

import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const [prePath, postPath] = process.argv.slice(2);
if (!prePath || !postPath) {
  console.error(
    "usage: node scripts/compare-r760-gateway-snapshots.mjs <pre.db> <post.db>"
  );
  process.exit(2);
}

const pre = new DatabaseSync(prePath, { readOnly: true });
const post = new DatabaseSync(postPath, { readOnly: true });

try {
  const exact = Object.fromEntries(
    [
      "subjects",
      "access_credentials",
      "unified_client_keys",
      "plans",
      "entitlements"
    ].map((table) => [table, compareExistingRowsExactly(table, "id")])
  );
  const requestEvents = compareExistingRowsExactly("request_events", "request_id", [
    "request_id",
    "credential_id",
    "subject_id",
    "scope",
    "status",
    "error_code",
    "rate_limited",
    "prompt_tokens",
    "completion_tokens",
    "total_tokens",
    "cached_prompt_tokens",
    "estimated_tokens",
    "usage_source",
    "limit_kind",
    "reservation_id",
    "over_request_limit",
    "identity_guard_hit"
  ]);
  const tokenWindows = compareMonotonicWindows(
    "token_windows",
    ["subject_id", "window_kind", "window_start"]
  );
  const entitlementWindows = compareMonotonicWindows(
    "entitlement_token_windows",
    ["entitlement_id", "window_kind", "window_start"]
  );
  const reservations = comparePresence("token_reservations", "id");
  const report = {
    pre_schema_max: pre.prepare("select max(version) value from schema_migrations").get().value,
    post_schema_max: post.prepare("select max(version) value from schema_migrations").get().value,
    protected_existing_rows: exact,
    existing_request_events: requestEvents,
    token_windows: tokenWindows,
    entitlement_token_windows: entitlementWindows,
    token_reservations: reservations
  };
  const valid =
    Object.values(exact).every((result) => result.ok) &&
    requestEvents.ok &&
    tokenWindows.ok &&
    entitlementWindows.ok &&
    reservations.ok;
  process.stdout.write(
    `${JSON.stringify({ ...report, existing_production_state_preserved: valid })}\n`
  );
  if (!valid) process.exitCode = 1;
} finally {
  pre.close();
  post.close();
}

function compareExistingRowsExactly(table, primaryKey, selectedColumns = null) {
  const columns = selectedColumns ?? commonColumns(table);
  const preRows = pre
    .prepare(`select ${columns.join(",")} from ${table} order by ${primaryKey}`)
    .all();
  const postRows = post
    .prepare(`select ${columns.join(",")} from ${table} order by ${primaryKey}`)
    .all();
  const postById = new Map(postRows.map((row) => [row[primaryKey], row]));
  let missing = 0;
  let changed = 0;
  const matchingPostRows = [];
  for (const preRow of preRows) {
    const postRow = postById.get(preRow[primaryKey]);
    if (!postRow) {
      missing += 1;
      continue;
    }
    matchingPostRows.push(postRow);
    if (JSON.stringify(preRow) !== JSON.stringify(postRow)) changed += 1;
  }
  return {
    pre_rows: preRows.length,
    post_rows: postRows.length,
    missing,
    changed,
    sha_equal:
      missing === 0 &&
      changed === 0 &&
      digest(preRows) === digest(matchingPostRows),
    ok: missing === 0 && changed === 0
  };
}

function compareMonotonicWindows(table, keyColumns) {
  const numericColumns = [
    "prompt_tokens",
    "completion_tokens",
    "total_tokens",
    "cached_prompt_tokens",
    "estimated_tokens",
    "requests"
  ];
  const columns = [...keyColumns, ...numericColumns];
  const preRows = pre.prepare(`select ${columns.join(",")} from ${table}`).all();
  const postRows = post.prepare(`select ${columns.join(",")} from ${table}`).all();
  const key = (row) => keyColumns.map((column) => row[column]).join("\u0000");
  const postByKey = new Map(postRows.map((row) => [key(row), row]));
  let missing = 0;
  let regressed = 0;
  for (const preRow of preRows) {
    const postRow = postByKey.get(key(preRow));
    if (!postRow) {
      missing += 1;
      continue;
    }
    if (
      numericColumns.some(
        (column) => Number(postRow[column] ?? 0) < Number(preRow[column] ?? 0)
      )
    ) {
      regressed += 1;
    }
  }
  return {
    pre_rows: preRows.length,
    post_rows: postRows.length,
    missing,
    regressed,
    ok: missing === 0 && regressed === 0
  };
}

function comparePresence(table, primaryKey) {
  const preIds = pre.prepare(`select ${primaryKey} from ${table}`).all();
  const postIds = new Set(
    post.prepare(`select ${primaryKey} from ${table}`).all().map((row) => row[primaryKey])
  );
  const missing = preIds.filter((row) => !postIds.has(row[primaryKey])).length;
  return {
    pre_rows: preIds.length,
    post_rows: postIds.size,
    missing,
    ok: missing === 0
  };
}

function commonColumns(table) {
  const preColumns = pre
    .prepare(`pragma table_info(${table})`)
    .all()
    .map((row) => row.name);
  const postColumns = new Set(
    post.prepare(`pragma table_info(${table})`).all().map((row) => row.name)
  );
  return preColumns.filter((column) => postColumns.has(column));
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
