const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { raiseInternalDailyLimits } = require('./gateway-internal-daily-limits.cjs');

const reason = 'Internal daily limit raised to 50m; monthly allowances and usage retained';
const policy = (daily = 20000000, monthly = 500000000) => ({ tokensPerMinute: 600000,
  tokensPerDay: daily, tokensPerMonth: monthly, tokensTotal: null,
  maxPromptTokensPerRequest: 200000, maxTotalTokensPerRequest: 300000,
  reserveTokensPerRequest: 0, missingUsageCharge: 'none' });

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE plans(id TEXT PRIMARY KEY,state TEXT,policy_json TEXT,display_name TEXT);
    CREATE TABLE entitlements(id TEXT PRIMARY KEY,subject_id TEXT,plan_id TEXT,policy_snapshot_json TEXT,
      state TEXT,period_start TEXT,period_end TEXT,notes TEXT);
    CREATE TABLE access_credentials(id TEXT PRIMARY KEY,subject_id TEXT,rate_json TEXT,revoked_at TEXT,expires_at TEXT,hash TEXT);
    CREATE TABLE admin_audit_events(id TEXT PRIMARY KEY,action TEXT,status TEXT,params_json TEXT,created_at TEXT);
    CREATE TABLE usage_fixture(id TEXT PRIMARY KEY,total_tokens INTEGER);
    CREATE TABLE credits_fixture(id TEXT PRIMARY KEY,balance INTEGER);
    CREATE TRIGGER trg_plans_policy_immutable BEFORE UPDATE OF policy_json ON plans
      BEGIN SELECT RAISE(ABORT, 'plans.policy_json is immutable'); END;`);
  for (const [id,p] of [['plan_internal_high_quota_v1',policy()],['plan_internal_high_quota_image_v1',policy(20000000,500000000)],['free',policy(10000,100000)]]) {
    db.prepare('INSERT INTO plans VALUES (?,?,?,?)').run(id,'active',JSON.stringify(p),id);
  }
  for (const [id,plan,state,end] of [
    ['active','plan_internal_high_quota_v1','active','2099-01-01'],
    ['paused','plan_internal_high_quota_v1','paused',null],
    ['scheduled','plan_internal_high_quota_image_v1','scheduled','2099-01-01'],
    ['cancelled','plan_internal_high_quota_v1','cancelled','2099-01-01'],
    ['expired','plan_internal_high_quota_v1','active','2020-01-01'],
    ['free','free','active',null]
  ]) db.prepare('INSERT INTO entitlements VALUES (?,?,?,?,?,?,?,?)')
    .run(id,id,plan,JSON.stringify(policy(20000000,100000000)),state,'2020-01-01',end,'keep');
  for (const id of ['active','free','revoked']) db.prepare('INSERT INTO access_credentials VALUES (?,?,?,?,?,?)')
    .run(id,id==='revoked'?'active':id,JSON.stringify({requestsPerDay:500,token:policy(20000000,500000000)}),id==='revoked'?'2020-01-01':null,'2099-01-01','secret-never-audited');
  db.exec("INSERT INTO usage_fixture VALUES ('active',25000000); INSERT INTO credits_fixture VALUES ('active',12345)");
  return db;
}
const rows = (db, table) => db.prepare(`SELECT * FROM ${table} ORDER BY id`).all().map(row=>({...row}));
const preview = db => raiseInternalDailyLimits(db,{apply:false,reason});
const apply = (db,revision=preview(db).revision) => raiseInternalDailyLimits(db,{apply:true,reason,expectedRevision:revision});

test('preview is read-only; apply raises only daily limits and keeps historical, free, monthly, usage and credits data', () => {
  const db=fixture();
  try {
    const tables=['plans','entitlements','access_credentials','usage_fixture','credits_fixture','admin_audit_events'];
    const before=Object.fromEntries(tables.map(t=>[t,rows(db,t)]));
    const p=preview(db);
    for (const t of tables) assert.deepEqual(rows(db,t),before[t]);
    assert.equal(p.plans_changed,2);assert.equal(p.entitlements_changed,3);assert.equal(p.credentials_changed,1);
    const result=apply(db,p.revision);assert.equal(result.applied,true);
    for (const table of ['plans','entitlements','access_credentials']) {
      const column=table==='plans'?'policy_json':table==='entitlements'?'policy_snapshot_json':'rate_json';
      const changedIds=table==='plans'?['plan_internal_high_quota_v1','plan_internal_high_quota_image_v1']:table==='entitlements'?['active','paused','scheduled']:['active'];
      const expected=before[table].map(row=>{
        if(!changedIds.includes(row.id))return row;
        const p=JSON.parse(row[column]);if(table==='access_credentials')p.token.tokensPerDay=50000000;else p.tokensPerDay=50000000;
        return {...row,[column]:JSON.stringify(p)};
      });
      assert.deepEqual(rows(db,table),expected);
    }
    for (const t of ['usage_fixture','credits_fixture']) assert.deepEqual(rows(db,t),before[t]);
    assert.equal(rows(db,'admin_audit_events').length,1);
    assert(!JSON.stringify(rows(db,'admin_audit_events')).includes('secret-never-audited'));
    assert.throws(()=>db.exec("UPDATE plans SET policy_json='{}'"),/immutable/);
    assert.throws(()=>apply(db,p.revision),/changed since preview/);
    assert.throws(()=>apply(db),/already raised/);
  } finally {db.close();}
});

for (const [name,mutate] of [
  ['new entitlement',db=>db.exec("INSERT INTO entitlements SELECT 'new','new',plan_id,policy_snapshot_json,state,period_start,period_end,notes FROM entitlements WHERE id='active'")],
  ['changed snapshot',db=>db.exec("UPDATE entitlements SET policy_snapshot_json=json_set(policy_snapshot_json,'$.tokensPerMonth',99999999) WHERE id='active'")],
  ['changed credential',db=>db.exec("UPDATE access_credentials SET rate_json=json_set(rate_json,'$.requestsPerDay',1000) WHERE id='active'")]
]) test(`${name} invalidates the reviewed revision without partial writes`,()=>{
  const db=fixture();try{const p=preview(db);mutate(db);const before=rows(db,'plans');
    assert.throws(()=>apply(db,p.revision),/changed since preview/);assert.deepEqual(rows(db,'plans'),before);
    assert.equal(rows(db,'admin_audit_events').length,0);
  }finally{db.close();}
});

test('audit failure rolls back plans, snapshots, overrides and the immutability trigger',()=>{
  const db=fixture();try{
    const tables=['plans','entitlements','access_credentials'];const before=tables.map(t=>rows(db,t));
    db.exec("CREATE TRIGGER reject_audit BEFORE INSERT ON admin_audit_events BEGIN SELECT RAISE(ABORT,'audit unavailable'); END");
    assert.throws(()=>apply(db),/audit unavailable/);tables.forEach((t,i)=>assert.deepEqual(rows(db,t),before[i]));
    assert.throws(()=>db.exec("UPDATE plans SET policy_json='{}'"),/immutable/);
  }finally{db.close();}
});

test('missing plans, invalid monthly limits and unexpected triggers fail closed',()=>{
  for(const sql of ["DELETE FROM plans WHERE id='plan_internal_high_quota_image_v1'",
    "UPDATE entitlements SET policy_snapshot_json=json_set(policy_snapshot_json,'$.tokensPerMonth',null) WHERE id='active'",
    'DROP TRIGGER trg_plans_policy_immutable']) {
    const db=fixture();try{db.exec(sql);assert.throws(()=>preview(db));assert.equal(rows(db,'admin_audit_events').length,0);}finally{db.close();}
  }
});

test('runtime accepts usage above the former daily cap, enforces the month, and new grants inherit 50m daily limits',async()=>{
  const {createSqliteStore,createSqliteTokenBudgetLimiter}=await import('../packages/store-sqlite/dist/index.js');
  const {issueAccessCredential,mergeEntitlementTokenPolicy}=await import('../packages/core/dist/index.js');
  const store=createSqliteStore({path:':memory:'}),db=store.database,now=new Date();
  const start=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),1)),end=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth()+1,1));
  try{
    store.upsertSubject({id:'paid',label:'paid',state:'active',createdAt:now});
    for(const [id,p] of [['plan_internal_high_quota_v1',policy()],['plan_internal_high_quota_image_v1',policy(20000000,500000000)]])
      store.createPlan({id,displayName:id,policy:p,scopeAllowlist:['code'],now});
    const entitlement=store.grantEntitlement({subjectId:'paid',planId:'plan_internal_high_quota_v1',periodKind:'monthly',periodStart:start,now});
    const issued=issueAccessCredential({subjectId:'paid',label:'paid',scope:'code',expiresAt:end,now});store.insertAccessCredential(issued.record);
    const day=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate())).toISOString();
    for(const [kind,at] of [['day',day],['month',start.toISOString()]])
      db.prepare('INSERT INTO entitlement_token_windows (entitlement_id,window_kind,window_start,total_tokens,updated_at) VALUES (?,?,?,?,?)')
        .run(entitlement.id,kind,at,25000000,now.toISOString());
    const limiter=createSqliteTokenBudgetLimiter({db});
    const acquire=requestId=>limiter.acquire({requestId,credentialId:issued.record.id,subjectId:'paid',entitlementId:entitlement.id,
      entitlementPeriodStart:start,entitlementPeriodEnd:end,scope:'code',upstreamAccountId:null,provider:null,
      policy:mergeEntitlementTokenPolicy(store.getEntitlement(entitlement.id).policySnapshot,null),estimatedPromptTokens:10,now});
    const before=await acquire('before');assert.equal(before.ok,false);assert.equal(before.limitKind,'token_day');
    apply(db);
    const admitted=await acquire('after');assert.equal(admitted.ok,true);
    await limiter.finalize({reservationId:admitted.reservationId,requestId:'after',usage:{promptTokens:10,completionTokens:2,totalTokens:12},now});
    const month=db.prepare("SELECT total_tokens FROM entitlement_token_windows WHERE entitlement_id=? AND window_kind='month'").get(entitlement.id);
    assert.equal(month.total_tokens,25000012);
    db.prepare("UPDATE entitlement_token_windows SET total_tokens=50000000 WHERE entitlement_id=? AND window_kind='day'").run(entitlement.id);
    const dayCapped=await acquire('day-exhausted');assert.equal(dayCapped.ok,false);assert.equal(dayCapped.limitKind,'token_day');
    db.prepare("UPDATE entitlement_token_windows SET total_tokens=25000012 WHERE entitlement_id=? AND window_kind='day'").run(entitlement.id);
    db.prepare("UPDATE entitlement_token_windows SET total_tokens=500000000 WHERE entitlement_id=? AND window_kind='month'").run(entitlement.id);
    const capped=await acquire('month-exhausted');assert.equal(capped.ok,false);assert.equal(capped.limitKind,'token_month');
    store.upsertSubject({id:'new-paid',label:'new',state:'active',createdAt:now});
    const newlyGranted=store.grantEntitlement({subjectId:'new-paid',planId:'plan_internal_high_quota_image_v1',periodKind:'one_off',periodStart:start,periodEnd:end,now});
    assert.equal(newlyGranted.policySnapshot.tokensPerDay,50000000);assert.equal(newlyGranted.policySnapshot.tokensPerMonth,500000000);
  }finally{store.close();}
});

test('unexpected lower credential limit aborts; already higher credential limit is preserved',()=>{
  const db=fixture();try{
    db.exec("UPDATE access_credentials SET rate_json=json_set(rate_json,'$.token.tokensPerDay',10000000) WHERE id='active'");
    assert.throws(()=>preview(db),/Unexpected credential daily override/);
    db.exec("UPDATE access_credentials SET rate_json=json_set(rate_json,'$.token.tokensPerDay',100000000) WHERE id='active'");
    const before=rows(db,'access_credentials');apply(db);assert.deepEqual(rows(db,'access_credentials'),before);
  }finally{db.close();}
});
