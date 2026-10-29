const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { PLAN_IDS, raiseInternalRequestFloor } = require('./gateway-internal-request-floor.cjs');
const reason = 'All internal entitlements receive at least 1000 daily requests';
function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE plans(id TEXT PRIMARY KEY,state TEXT,metadata_json TEXT,policy_json TEXT);
    CREATE TABLE admin_audit_events(id TEXT PRIMARY KEY,action TEXT,status TEXT,params_json TEXT,created_at TEXT);
    CREATE TABLE access_credentials(id TEXT PRIMARY KEY,rate_json TEXT);
    CREATE TABLE entitlements(id TEXT PRIMARY KEY,policy_snapshot_json TEXT);
    CREATE TABLE usage(id TEXT PRIMARY KEY,total INTEGER);
    CREATE TRIGGER trg_plans_policy_immutable BEFORE UPDATE OF policy_json ON plans
      BEGIN SELECT RAISE(ABORT, 'immutable'); END;`);
  for (const id of [...PLAN_IDS, 'retail', 'free']) {
    db.prepare('INSERT INTO plans VALUES (?,?,?,?)').run(id, 'active', JSON.stringify({ keep: id }), '{"tokensPerDay":50000000}');
  }
  db.exec(`INSERT INTO access_credentials VALUES ('c','{"requestsPerDay":600}');
    INSERT INTO entitlements VALUES ('e','{"tokensPerDay":50000000}'); INSERT INTO usage VALUES ('u',600);`);
  return db;
}
const rows = (db, table) => db.prepare(`SELECT * FROM ${table} ORDER BY id`).all().map(row => ({ ...row }));
const preview = db => raiseInternalRequestFloor(db, { apply: false, reason });
const apply = (db, expectedRevision = preview(db).revision) => raiseInternalRequestFloor(db, { apply: true, reason, expectedRevision });

test('preview does not write; apply edits only internal Plan metadata, preserves all credential/grant/usage rows', () => {
  const db = fixture();
  try {
    const tables = ['plans', 'access_credentials', 'entitlements', 'usage', 'admin_audit_events'];
    const before = Object.fromEntries(tables.map(t => [t, rows(db, t)]));
    const p = preview(db);
    for (const t of tables) assert.deepEqual(rows(db, t), before[t]);
    assert.equal(p.plans_changed, 5);
    const result = apply(db, p.revision);
    assert.equal(result.credentials_changed, 0);
    assert.equal(result.entitlement_snapshots_changed, 0);
    for (const t of ['access_credentials', 'entitlements', 'usage']) assert.deepEqual(rows(db, t), before[t]);
    assert.deepEqual(rows(db, 'plans'), before.plans.map(p => PLAN_IDS.includes(p.id) ?
      { ...p, metadata_json: JSON.stringify({ keep: p.id, requestRateFloor: { requestsPerDay: 1000 } }) } : p));
    assert.equal(rows(db, 'admin_audit_events').length, 1);
    assert.throws(() => db.exec("UPDATE plans SET policy_json='{}'"), /immutable/);
    assert.throws(() => apply(db, p.revision), /changed since preview/);
    assert.throws(() => apply(db), /already raised/);
  } finally { db.close(); }
});

test('preserves a higher Plan floor and unrelated benefit metadata', () => {
  const db = fixture();
  try {
    const metadata = JSON.stringify({ keep: true, requestRateFloor: { requestsPerDay: 5000, futureBenefit: true } });
    db.prepare('UPDATE plans SET metadata_json=? WHERE id=?').run(metadata, PLAN_IDS[0]);
    assert.equal(apply(db).plans_changed, 4);
    assert.equal(db.prepare('SELECT metadata_json FROM plans WHERE id=?').get(PLAN_IDS[0]).metadata_json, metadata);
  } finally { db.close(); }
});

test('audit failure rolls back all updates; changed or missing plans and malformed policies fail closed', () => {
  for (const failure of ['audit', 'changed', 'missing', 'malformed']) {
    const db = fixture();
    try {
      const p = preview(db);
      if (failure === 'audit') db.exec("CREATE TRIGGER reject_audit BEFORE INSERT ON admin_audit_events BEGIN SELECT RAISE(ABORT,'audit unavailable'); END");
      if (failure === 'changed') db.prepare('UPDATE plans SET metadata_json=? WHERE id=?').run('{"new":true}', PLAN_IDS[0]);
      if (failure === 'missing') db.prepare('DELETE FROM plans WHERE id=?').run(PLAN_IDS[0]);
      if (failure === 'malformed') db.prepare('UPDATE plans SET metadata_json=? WHERE id=?').run('{"requestRateFloor":{"requestsPerDay":null}}', PLAN_IDS[0]);
      const before = rows(db, 'plans');
      assert.throws(() => failure === 'malformed' ? preview(db) : apply(db, p.revision));
      assert.deepEqual(rows(db, 'plans'), before);
      assert.equal(rows(db, 'admin_audit_events').length, 0);
    } finally { db.close(); }
  }
});
