const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { createHash } = require('node:crypto');
const { upgradeFreeAllowance } = require('./gateway-free-allowance-upgrade.cjs');
const hash = s => createHash('sha256').update(s).digest('hex');
const rows = (db, t) => JSON.stringify(db.prepare(`SELECT * FROM ${t}`).all());

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE subjects (id TEXT PRIMARY KEY,state TEXT);
    CREATE TABLE plans (id TEXT PRIMARY KEY,state TEXT,display_name TEXT,policy_json TEXT);
    CREATE TRIGGER trg_plans_policy_immutable BEFORE UPDATE OF policy_json ON plans
      BEGIN SELECT RAISE(ABORT, 'plans.policy_json is immutable'); END;
    CREATE TABLE entitlements (id TEXT PRIMARY KEY,subject_id TEXT,plan_id TEXT,state TEXT,
      period_kind TEXT,period_start TEXT,period_end TEXT,policy_snapshot_json TEXT);
    CREATE TABLE entitlement_token_windows (entitlement_id TEXT,window_kind TEXT,window_start TEXT,total_tokens INTEGER);
    CREATE TABLE token_reservations (id TEXT,subject_id TEXT,finalized_at TEXT);
    CREATE TABLE request_events (id TEXT,total_tokens INTEGER);
    CREATE TABLE admin_audit_events (id TEXT,action TEXT,target_user_id TEXT,status TEXT,params_json TEXT,created_at TEXT);
    INSERT INTO subjects VALUES ('s_used','active'),('s_unused','active'),('s_paid','active'),('s_disabled','disabled');
    INSERT INTO request_events VALUES ('historical',600000);
    INSERT INTO token_reservations VALUES ('settled','s_used','2026-01-01');`);
  const policy = JSON.stringify({ tokensTotal: 1000000, tokensPerDay: null, tokensPerMonth: null,
    tokensPerMinute: 300000, missingUsageCharge: 'estimate' });
  db.prepare('INSERT INTO plans VALUES (?,?,?,?)').run('plan_free_once_1m_v1','active','Free · 1,000,000 tokens once',policy);
  for (const id of ['used','unused','paid','disabled']) db.prepare('INSERT INTO entitlements VALUES (?,?,?,?,?,?,?,?)')
    .run('e_'+id,'s_'+id,'plan_free_once_1m_v1','active','unlimited','2026-01-01T00:00:00.000Z',null,policy);
  db.prepare('INSERT INTO entitlements VALUES (?,?,?,?,?,?,?,?)')
    .run('e_purchase','s_paid','plan_paid_yearly_v1','active','one_off','2026-01-01T00:00:00.000Z','2099-01-01',policy);
  db.exec(`INSERT INTO entitlement_token_windows VALUES
    ('e_used','period','2026-01-01T00:00:00.000Z',600000),
    ('e_used','day','2026-09-24T00:00:00.000Z',500),
    ('e_paid','period','2026-01-01T00:00:00.000Z',100);`);
  const input = { version: 1, expectedTotal: 1000000, total: 5000000, expectedPlanHash: hash(policy),
    reason: 'User approved Free upgrade and full balance reset', apply: true,
    targets: ['used','unused'].map(id => ({ subjectId:'s_'+id,entitlementId:'e_'+id,
      expectedSnapshotHash:hash(policy),expectedUsed:id==='used'?600000:0 })) };
  return { db, input };
}

test('upgrades signup template and full reviewed Free-only cohort atomically, preserving other data', () => {
  const {db,input}=fixture();
  const protectedTables=['subjects','request_events','token_reservations'];
  const before=protectedTables.map(t=>rows(db,t));
  const protectedGrants=db.prepare("SELECT * FROM entitlements WHERE subject_id IN ('s_paid','s_disabled')").all();
  const result=upgradeFreeAllowance(db,input);
  assert.equal(result.users,2);assert.equal(result.total_used_reset,600000);assert.equal(result.remaining_per_user,5000000);
  assert.equal(JSON.parse(db.prepare('SELECT policy_json FROM plans').get().policy_json).tokensTotal,5000000);
  for(const t of input.targets) assert.equal(JSON.parse(db.prepare('SELECT policy_snapshot_json FROM entitlements WHERE id=?').get(t.entitlementId).policy_snapshot_json).tokensTotal,5000000);
  assert.deepEqual(protectedTables.map(t=>rows(db,t)),before);
  assert.deepEqual(db.prepare("SELECT * FROM entitlements WHERE subject_id IN ('s_paid','s_disabled')").all(),protectedGrants);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM entitlement_token_windows WHERE entitlement_id='e_used' AND window_kind='period'").get().n,0);
  assert.equal(db.prepare("SELECT total_tokens FROM entitlement_token_windows WHERE window_kind='day'").get().total_tokens,500);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM admin_audit_events').get().n,3);
  const audit=JSON.parse(db.prepare("SELECT params_json FROM admin_audit_events WHERE target_user_id='s_used'").get().params_json);
  assert.equal(audit.ledger_before.total_tokens,600000);
  assert.equal(JSON.parse(audit.entitlement_before.policy_snapshot_json).tokensTotal,1000000);
  assert.throws(()=>upgradeFreeAllowance(db,input),/Plan changed/);
  assert.throws(()=>db.exec("UPDATE plans SET policy_json='{}'"),/immutable/);
  db.close();
});

test('read-only preview performs no writes',()=>{
  const {db,input}=fixture();const before=['plans','entitlements','entitlement_token_windows'].map(t=>rows(db,t));
  db.exec('PRAGMA query_only=ON');
  assert.equal(upgradeFreeAllowance(db,{...input,apply:false}).applied,false);
  assert.deepEqual(['plans','entitlements','entitlement_token_windows'].map(t=>rows(db,t)),before);
  db.close();
});

for(const [name,change,mutate] of [
  ['stale usage',"UPDATE entitlement_token_windows SET total_tokens=700000 WHERE entitlement_id='e_used' AND window_kind='period'",()=>{}],
  ['pending settlement',"UPDATE token_reservations SET finalized_at=NULL",()=>{}],
  ['disabled user',"UPDATE subjects SET state='disabled' WHERE id='s_used'",()=>{}],
  ['new paid grant',"INSERT INTO entitlements SELECT 'e_new','s_used',plan_id,state,period_kind,period_start,period_end,policy_snapshot_json FROM entitlements WHERE id='e_purchase'",()=>{}],
  ['new signup',"INSERT INTO subjects VALUES ('s_new','active'); INSERT INTO entitlements SELECT 'e_new','s_new',plan_id,state,period_kind,period_start,period_end,policy_snapshot_json FROM entitlements WHERE id='e_unused'",()=>{}],
  ['stale snapshot',"UPDATE entitlements SET policy_snapshot_json='{}' WHERE id='e_unused'",()=>{}],
  ['missing target','',i=>i.targets.pop()],
  ['duplicate target','',i=>i.targets.push(i.targets[0])],
  ['decreasing total','',i=>i.total=500000],
  ['audit failure',"CREATE TRIGGER fail_audit BEFORE INSERT ON admin_audit_events BEGIN SELECT RAISE(ABORT,'audit failed'); END",()=>{}],
  ['unknown trigger',"DROP TRIGGER trg_plans_policy_immutable",()=>{}],
]) test(`rejects ${name} without partial writes`,()=>{
  const {db,input}=fixture();if(change)db.exec(change);mutate(input);
  const tables=['plans','entitlements','entitlement_token_windows','admin_audit_events'];
  const before=tables.map(t=>rows(db,t));const triggers=rows(db,'sqlite_master');
  assert.throws(()=>upgradeFreeAllowance(db,input));
  assert.deepEqual(tables.map(t=>rows(db,t)),before);assert.equal(rows(db,'sqlite_master'),triggers);
  db.close();
});
