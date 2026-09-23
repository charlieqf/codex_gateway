const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { resetFreeTotal } = require('./gateway-free-total-reset.cjs');

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE subjects (id TEXT PRIMARY KEY, state TEXT);
    CREATE TABLE entitlements (id TEXT PRIMARY KEY, subject_id TEXT, state TEXT, plan_id TEXT,
      period_kind TEXT, period_start TEXT, period_end TEXT, policy_snapshot_json TEXT);
    CREATE TABLE token_reservations (id TEXT, subject_id TEXT, finalized_at TEXT, final_total_tokens INTEGER);
    CREATE TABLE request_events (id TEXT, subject_id TEXT, total_tokens INTEGER);
    CREATE TABLE entitlement_token_windows (entitlement_id TEXT, window_kind TEXT, window_start TEXT,
      total_tokens INTEGER, PRIMARY KEY(entitlement_id, window_kind, window_start));
    CREATE TABLE admin_audit_events (id TEXT PRIMARY KEY, action TEXT, target_user_id TEXT,
      status TEXT, params_json TEXT, created_at TEXT);
    INSERT INTO subjects VALUES ('subj_test','active'), ('subj_other','active');
    INSERT INTO entitlements VALUES ('ent_test','subj_test','active','plan_free_once_1m_v1',
      'unlimited','2026-01-01T00:00:00.000Z',NULL,'{"tokensTotal":1000000}');
    INSERT INTO entitlement_token_windows VALUES
      ('ent_test','period','2026-01-01T00:00:00.000Z',985925),
      ('ent_test','month','2026-09-01T00:00:00.000Z',200000),
      ('ent_other','period','2026-01-01T00:00:00.000Z',42);
    INSERT INTO token_reservations VALUES ('res_test','subj_test','2026-09-15T00:00:00.000Z',985925);
    INSERT INTO request_events VALUES ('req_test','subj_test',985925);`);
  return { db, input: { subjectId: 'subj_test', entitlementId: 'ent_test', expectedUsed: 985925,
    expectedLimit: 1000000, reason: 'Explicit user reset instruction', apply: true } };
}
const rows = (db, table) => JSON.stringify(db.prepare(`SELECT * FROM ${table}`).all());

test('resets only the target lifetime balance, preserves historical usage and audits before image', () => {
  const { db, input } = fixture();
  const protectedTables = ['subjects', 'entitlements', 'token_reservations', 'request_events'];
  const snapshots = protectedTables.map(t => rows(db, t));
  const result = resetFreeTotal(db, input);
  assert.equal(result.remaining_after, 1000000);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM entitlement_token_windows').get().n, 2);
  assert.equal(db.prepare("SELECT total_tokens FROM entitlement_token_windows WHERE entitlement_id='ent_other'").get().total_tokens, 42);
  assert.equal(db.prepare("SELECT total_tokens FROM entitlement_token_windows WHERE window_kind='month'").get().total_tokens, 200000);
  assert.deepEqual(protectedTables.map(t => rows(db, t)), snapshots);
  const audit = db.prepare('SELECT * FROM admin_audit_events').get();
  assert.equal(audit.target_user_id, input.subjectId);
  assert.equal(JSON.parse(audit.params_json).ledger_before.total_tokens, 985925);
  assert.throws(() => resetFreeTotal(db, input), /expected value/);
  db.close();
});

test('dry run leaves all rows unchanged', () => {
  const { db, input } = fixture();
  db.exec('PRAGMA query_only=ON');
  const before = rows(db, 'entitlement_token_windows');
  assert.equal(resetFreeTotal(db, { ...input, apply: false }).applied, false);
  assert.equal(rows(db, 'entitlement_token_windows'), before);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM admin_audit_events').get().n, 0);
  db.close();
});

for (const [name, change, inputChange] of [
  ['stale usage', '', { expectedUsed: 1 }],
  ['wrong limit', '', { expectedLimit: 2000000 }],
  ['wrong subject', '', { subjectId: 'subj_other' }],
  ['pending settlement', "UPDATE token_reservations SET finalized_at=NULL", {}],
  ['disabled subject', "UPDATE subjects SET state='disabled' WHERE id='subj_test'", {}],
  ['paid plan', "UPDATE entitlements SET plan_id='plan_paid_monthly_v1'", {}],
  ['other live entitlement', "INSERT INTO entitlements SELECT 'ent_paid',subject_id,state,'plan_paid_monthly_v1',period_kind,period_start,period_end,policy_snapshot_json FROM entitlements", {}],
  ['audit failure', "CREATE TRIGGER reject_audit BEFORE INSERT ON admin_audit_events BEGIN SELECT RAISE(ABORT,'audit unavailable'); END", {}],
]) test(`rejects ${name} without changing the balance`, () => {
  const { db, input } = fixture();
  if (change) db.exec(change);
  const before = rows(db, 'entitlement_token_windows');
  assert.throws(() => resetFreeTotal(db, { ...input, ...inputChange }));
  assert.equal(rows(db, 'entitlement_token_windows'), before);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM admin_audit_events').get().n, 0);
  db.close();
});
