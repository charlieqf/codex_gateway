// Run in an isolated, network-disabled candidate container. Mount only a
// read-only gateway.db BACKUP at /input/gateway.db; all writes go to /tmp.
// Verifies the schema 29 -> 30 one-off Free migration on a production copy:
// entitlements, keys, subjects and unrelated windows are preserved; active
// daily Free grants become plan_free_once_1m_v1 with a lifetime window that
// carries their historical usage.
import assert from "node:assert/strict";
import { copyFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createSqliteStore } from "@codex-gateway/store-sqlite";

assert(!process.env.GATEWAY_DATABASE_PATH, "No production configuration permitted");
copyFileSync("/input/gateway.db", "/tmp/free-once-migration-smoke.db");
const old = new DatabaseSync("/input/gateway.db", { readOnly: true });
old.exec("PRAGMA query_only=ON");
assert.equal(old.prepare("SELECT MAX(version) AS version FROM schema_migrations").get().version, 29);
const store = createSqliteStore({ path: "/tmp/free-once-migration-smoke.db" });
const db = store.database;
const report = { assertions: "passed", schema: 30, preserved: {}, migrated_free: {}, production_writes: 0 };
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
  assert.equal(db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get().version, 30);
  const legacyPlanIds = ["plan_free_daily_100k_v1", "plan_free_daily_10k_v1", "plan_free_daily_1m_v1"];
  const activeFreeOld = old.prepare(`SELECT COUNT(*) AS n FROM entitlements
    WHERE plan_id IN (${legacyPlanIds.map(() => "?").join(",")}) AND state = 'active'`).get(...legacyPlanIds).n;
  const once = db.prepare(`SELECT COUNT(*) AS n FROM entitlements WHERE plan_id = 'plan_free_once_1m_v1' AND state = 'active'`).get().n;
  assert.equal(once, activeFreeOld, "Every active daily Free grant must become a once grant");
  for (const row of db.prepare(`SELECT e.id, e.period_start, e.policy_snapshot_json,
      COALESCE((SELECT total_tokens FROM entitlement_token_windows w
        WHERE w.entitlement_id = e.id AND w.window_kind = 'period' AND w.window_start = e.period_start), 0) AS used
    FROM entitlements e WHERE e.plan_id = 'plan_free_once_1m_v1' AND e.state = 'active'`).all()) {
    const policy = JSON.parse(row.policy_snapshot_json);
    assert.equal(policy.tokensTotal, 1000000);
    assert.equal(policy.tokensPerDay, null);
    assert.equal(policy.tokensPerMonth, null);
    const historical = old.prepare(`SELECT COALESCE(SUM(total_tokens), 0) AS used FROM entitlement_token_windows
      WHERE entitlement_id = ? AND window_kind = 'month'`).get(row.id).used;
    assert.equal(row.used, Math.min(historical, 1000000), "Lifetime window must carry month-window usage once, not day+month double-counted");
  }
  const planOnce = db.prepare("SELECT state FROM plans WHERE id = 'plan_free_once_1m_v1'").get();
  assert.equal(planOnce?.state, "active");
  const subjects = digest(old, "subjects", ["id", "label", "state", "created_at"]);
  assert.deepEqual(digest(db, "subjects", ["id", "label", "state", "created_at"]), subjects);
  const keys = digest(old, "unified_client_keys", ["id", "subject_id", "is_current"]);
  assert.deepEqual(digest(db, "unified_client_keys", ["id", "subject_id", "is_current"]), keys);
  // Non-free entitlements keep id, plan and policy bytes; other shared columns match.
  const paidColumns = ["id", "subject_id", "state", "period_kind", "period_start", "period_end", "created_at"];
  assert.deepEqual(digest(db, "entitlements", paidColumns), digest(old, "entitlements", paidColumns));
  const nonFreeSql = `SELECT id, plan_id, policy_snapshot_json FROM entitlements
    WHERE plan_id NOT IN (${legacyPlanIds.map(() => "?").join(",")}, 'plan_free_once_1m_v1') ORDER BY id`;
  const oldRows = JSON.stringify(old.prepare(nonFreeSql).all(...legacyPlanIds));
  const newRows = JSON.stringify(db.prepare(nonFreeSql).all(...legacyPlanIds));
  assert.equal(newRows, oldRows, "Non-free entitlement plans and policies changed");
  report.migrated_free = { active_daily_before: activeFreeOld, once_after: once };
  report.preserved = { subjects: subjects.count, unified_client_keys: keys.count };
  assert.equal(db.prepare("PRAGMA quick_check").get().quick_check, "ok");
  assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
  console.log(JSON.stringify(report));
} finally { store.close(); old.close(); }
