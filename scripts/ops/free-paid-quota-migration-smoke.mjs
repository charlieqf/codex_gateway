// Run in an isolated, network-disabled candidate container. Mount only a
// read-only gateway.db BACKUP at /input/gateway.db; all writes go to /tmp.
import assert from "node:assert/strict";
import { copyFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createSqliteStore } from "@codex-gateway/store-sqlite";

assert(!process.env.GATEWAY_DATABASE_PATH, "No production configuration permitted");
copyFileSync("/input/gateway.db", "/tmp/quota-migration-smoke.db");
const old = new DatabaseSync("/input/gateway.db", { readOnly: true });
old.exec("PRAGMA query_only=ON");
assert.equal(old.prepare("SELECT MAX(version) AS version FROM schema_migrations").get().version, 28);
const store = createSqliteStore({ path: "/tmp/quota-migration-smoke.db" });
const db = store.database;
const report = { assertions: "passed", schema: 29, preserved: {}, new_free_allowances: 0, production_writes: 0 };
function digest(connection, table, columns) {
  const hash = createHash("sha256");
  let count = 0;
  for (const row of connection.prepare(`SELECT ${columns.join(",")} FROM ${table} ORDER BY rowid`).iterate()) {
    hash.update(JSON.stringify(row));
    count++;
  }
  return { count, hash: hash.digest("hex") };
}
try {
  assert.equal(db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get().version, 29);
  for (const table of ["subjects", "access_credentials", "unified_client_keys", "plans", "phone_auth_identities",
    "token_windows", "entitlement_token_windows", "token_reservations"]) {
    const columns = old.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
    const before = digest(old, table, columns), after = digest(db, table, columns);
    assert.equal(after.count, before.count, `${table} row count changed`);
    assert.equal(after.hash, before.hash, `${table} existing fields changed`);
    report.preserved[table] = before.count;
  }
  const columns = old.prepare("PRAGMA table_info(entitlements)").all().map((row) => row.name);
  const before = old.prepare(`SELECT ${columns.join(",")} FROM entitlements`).all();
  for (const row of before) {
    const current = db.prepare(`SELECT ${columns.join(",")} FROM entitlements WHERE id = ?`).get(row.id);
    assert.equal(createHash("sha256").update(JSON.stringify(current)).digest("hex"),
      createHash("sha256").update(JSON.stringify(row)).digest("hex"), "Pre-existing entitlement changed; review required");
  }
  report.preserved.entitlements = before.length;
  const oldIds = new Set(before.map((row) => row.id));
  const added = db.prepare("SELECT id,subject_id,plan_id,period_kind,period_end,state,policy_snapshot_json FROM entitlements").all()
    .filter((row) => !oldIds.has(row.id));
  const now = new Date().toISOString();
  const eligible = old.prepare(`SELECT DISTINCT subject_id FROM entitlements WHERE
    plan_id IN ('plan_paid_monthly_v1','plan_paid_yearly_v1') AND state IN ('active','paused','scheduled')
    AND (period_end IS NULL OR period_end > ?) AND subject_id IN (SELECT id FROM subjects WHERE state = 'active')`).all(now);
  assert.equal(added.length, eligible.length, "Expected reviewed paid-only accounts to receive a base allowance");
  const subjects = new Set();
  for (const row of added) {
    assert.equal(row.plan_id, "plan_free_daily_100k_v1");
    assert.equal(row.period_kind, "unlimited");
    assert.equal(row.period_end, null);
    assert.equal(row.state, "active");
    assert.equal(JSON.parse(row.policy_snapshot_json).tokensPerDay, 100000);
    assert(eligible.some((paid) => paid.subject_id === row.subject_id));
    assert(!subjects.has(row.subject_id), "Duplicate free allowance");
    subjects.add(row.subject_id);
  }
  report.new_free_allowances = added.length;
  assert.equal(db.prepare("PRAGMA quick_check").get().quick_check, "ok");
  assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
  console.log(JSON.stringify(report));
} finally { store.close(); old.close(); }
