const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { changePlanTokenPolicy } = require('./gateway-plan-token-policy.cjs');

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE plans (id TEXT PRIMARY KEY, state TEXT, policy_json TEXT, display_name TEXT);
    CREATE TABLE entitlements (id TEXT PRIMARY KEY, plan_id TEXT, policy_snapshot_json TEXT);
    CREATE TABLE admin_audit_events (id TEXT PRIMARY KEY, action TEXT, status TEXT, params_json TEXT, created_at TEXT);
    CREATE TRIGGER trg_plans_policy_immutable BEFORE UPDATE OF policy_json ON plans
    BEGIN SELECT RAISE(ABORT, 'plans.policy_json is immutable'); END;`);
  const monthlyPolicy = JSON.stringify({ tokensPerMonth: 100000000, tokensPerDay: 5000000, tokensPerMinute: 300000 });
  const yearlyPolicy = JSON.stringify({ tokensPerMonth: null, tokensPerDay: null, tokensPerMinute: 300000 });
  db.prepare('INSERT INTO plans VALUES (?, ?, ?, ?)').run('plan_paid_monthly_v1', 'active', monthlyPolicy, 'Paid monthly');
  db.prepare('INSERT INTO plans VALUES (?, ?, ?, ?)').run('plan_paid_yearly_v1', 'active', yearlyPolicy, 'Paid yearly');
  db.prepare('INSERT INTO entitlements VALUES (?, ?, ?)').run('existing', 'plan_paid_monthly_v1', monthlyPolicy);
  return db;
}
const monthlyInput = { planId: 'plan_paid_monthly_v1', expected: 100000000, monthly: 50000000, apply: true };
const yearlyInput = { planId: 'plan_paid_yearly_v1', expected: null, monthly: 200000000,
  expectedDaily: null, daily: 6000000, apply: true };

test('dry run and apply preserve existing entitlement snapshots and unrelated plan fields', () => {
  const db = fixture();
  try {
    const before = db.prepare('SELECT * FROM plans ORDER BY id').all();
    const entitlements = db.prepare('SELECT * FROM entitlements').all();
    changePlanTokenPolicy(db, { ...monthlyInput, apply: false });
    assert.deepEqual(db.prepare('SELECT * FROM plans ORDER BY id').all(), before);
    assert.equal(db.prepare('SELECT count(*) AS n FROM admin_audit_events').get().n, 0);
    const result = changePlanTokenPolicy(db, monthlyInput);
    assert.equal(result.applied, true);
    assert.equal(result.existing_entitlements, 1);
    assert.deepEqual(db.prepare('SELECT * FROM entitlements').all(), entitlements);
    const after = db.prepare('SELECT * FROM plans ORDER BY id').all();
    assert.deepEqual(after[1], before[1]);
    assert.deepEqual({ ...after[0] }, { ...before[0], policy_json: JSON.stringify({ tokensPerMonth: 50000000, tokensPerDay: 5000000, tokensPerMinute: 300000 }) });
    assert.equal(db.prepare('SELECT count(*) AS n FROM admin_audit_events').get().n, 1);
    assert.throws(() => db.exec("UPDATE plans SET policy_json = '{}'"), /immutable/);
    assert.throws(() => changePlanTokenPolicy(db, monthlyInput), /expected value/);
  } finally { db.close(); }
});

test('sets monthly and daily limits together on a previously uncapped yearly plan', () => {
  const db = fixture();
  try {
    const before = db.prepare('SELECT * FROM plans ORDER BY id').all();
    const entitlements = db.prepare('SELECT * FROM entitlements').all();
    changePlanTokenPolicy(db, { ...yearlyInput, apply: false });
    assert.deepEqual(db.prepare('SELECT * FROM plans ORDER BY id').all(), before);
    const result = changePlanTokenPolicy(db, yearlyInput);
    assert.equal(result.applied, true);
    assert.deepEqual(result.after, { tokensPerMonth: 200000000, tokensPerDay: 6000000, tokensPerMinute: 300000 });
    assert.deepEqual(db.prepare('SELECT * FROM entitlements').all(), entitlements);
    assert.throws(() => changePlanTokenPolicy(db, yearlyInput), /Monthly policy differs/);
    const restored = changePlanTokenPolicy(db, { planId: 'plan_paid_yearly_v1', expected: 200000000, monthly: null,
      expectedDaily: 6000000, daily: null, apply: true });
    assert.deepEqual(restored.after, { tokensPerMonth: null, tokensPerDay: null, tokensPerMinute: 300000 });
    assert.equal(db.prepare('SELECT count(*) AS n FROM admin_audit_events').get().n, 2);
  } finally { db.close(); }
});

test('an audit insertion failure rolls the plan update back', () => {
  const db = fixture();
  try {
    const before = db.prepare('SELECT * FROM plans ORDER BY id').all();
    db.exec("CREATE TRIGGER reject_audit BEFORE INSERT ON admin_audit_events BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END;");
    assert.throws(() => changePlanTokenPolicy(db, monthlyInput), /audit unavailable/);
    assert.deepEqual(db.prepare('SELECT * FROM plans ORDER BY id').all(), before);
    assert.throws(() => db.exec("UPDATE plans SET policy_json = '{}'"), /immutable/);
  } finally { db.close(); }
});

test('missing, deprecated, stale, and invalid updates do not change data', () => {
  const db = fixture();
  try {
    const before = db.prepare('SELECT * FROM plans ORDER BY id').all();
    for (const override of [{ planId: 'missing' }, { monthly: -1 }, { expected: 1 }, { expected: null },
      { daily: 4000000 }, { expectedDaily: 6000000, daily: 4000000 }]) {
      assert.throws(() => changePlanTokenPolicy(db, { ...monthlyInput, ...override }));
    }
    assert.deepEqual(db.prepare('SELECT * FROM plans ORDER BY id').all(), before);
    db.prepare("UPDATE plans SET state = 'deprecated' WHERE id = ?").run(monthlyInput.planId);
    assert.throws(() => changePlanTokenPolicy(db, monthlyInput), /Active plan not found/);
    assert.equal(db.prepare('SELECT count(*) AS n FROM admin_audit_events').get().n, 0);
  } finally { db.close(); }
});
