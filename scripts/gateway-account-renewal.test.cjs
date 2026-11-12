'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const {mkdtempSync,rmSync}=require('node:fs');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
const {runAccountOperation,accountState}=require('./gateway-account-renewal.cjs');
const NOW=new Date('2026-11-12T06:00:00.000Z');
const OLD='2027-01-01T00:00:00.000Z', KEY_END='2027-06-01T00:00:00.000Z', END='2027-11-12T06:00:00.000Z';
const START='2026-01-01T00:00:00.000Z', PLAN='plan_internal_high_quota_image_v1';
const POLICY=JSON.stringify({tokensPerMinute:1000000,tokensPerDay:50000000,tokensPerMonth:500000000,tokensTotal:null,
  maxPromptTokensPerRequest:380000,maxTotalTokensPerRequest:400000,reserveTokensPerRequest:10000,missingUsageCharge:'estimate'});
const FEATURES=JSON.stringify({capabilities:['chat','tools','image_generation']});
async function fixture(t, count=4, path=':memory:') {
  const db=new DatabaseSync(path); db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5');
  const {migrateGatewaySchema}=await import('../packages/store-sqlite/src/migrations.ts');
  migrateGatewaySchema(db);
  t.after(()=>db.close());
  db.prepare(`INSERT INTO plans (id,display_name,policy_json,scope_allowlist_json,state,created_at,feature_policy_json)
    VALUES (?,'Internal',?,'["code"]','active',?,?)`).run(PLAN,POLICY,START,FEATURES);
  for(let n=1;n<=count;n++) {
    db.prepare("INSERT INTO subjects (id,label,state,created_at,phone_number) VALUES (?,?,'active',?,?)").run('s'+n,'Account '+n,START,'PRIVATE_PHONE_'+n);
    db.prepare(`INSERT INTO access_credentials (id,prefix,hash,subject_id,label,scope,expires_at,rate_json,created_at,credential_class,token_ciphertext)
      VALUES (?,?,?,?,?,'code',?,'{}',?,'desktop',?)`).run('c'+n,'p'+n,'PRIVATE_HASH_'+n,'s'+n,'Account '+n,KEY_END,START,'PRIVATE_CIPHER_'+n);
    for(const current of [0,1]) {
      db.prepare(`INSERT INTO unified_client_keys (id,prefix,hash,subject_id,label,expires_at,codex_credential_id,codex_credential_prefix,
        codex_key_ciphertext,medevidence_key_ciphertext,created_at,is_current,credential_class,token_ciphertext)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run((current?'k':'legacy')+n,(current?'u':'legacy-prefix')+n,'PRIVATE_UNIFIED_HASH_'+current+n,
          's'+n,'Key '+n,KEY_END,'c'+n,'p'+n,'PRIVATE_BACKING_'+n,'PRIVATE_UPSTREAM_'+n,START,current,current?'desktop':'unknown',current?'PRIVATE_RECOVERY_'+n:null);
    }
    db.prepare(`INSERT INTO phone_auth_identities (phone_hash,phone_ciphertext,subject_id,unified_key_id,state,created_at,updated_at)
      VALUES (?,?,?,?,'active',?,?)`).run('PRIVATE_PHONE_HASH_'+n,'PRIVATE_PHONE_CIPHER_'+n,'s'+n,'k'+n,START,START);
    db.prepare(`INSERT INTO entitlements (id,subject_id,plan_id,policy_snapshot_json,feature_policy_snapshot_json,scope_allowlist_json,
      period_kind,period_start,period_end,state,created_at) VALUES (?,?,?,?,?,'["code"]','one_off',?,?,'active',?)`)
      .run('e'+n,'s'+n,PLAN,POLICY,FEATURES,START,OLD,START);
    addUsage(db,'e'+n,1000);
  }
  const input={version:1,operationId:'test-renewal-1',reason:'Authorized one-year internal renewal',kind:'renew',apply:false,
    items:Array.from({length:count},(_,i)=>({subjectId:'s'+(i+1),entitlementId:'e'+(i+1),expiresAt:END}))};
  return {db,input};
}
function addUsage(db,entitlementId,tokens) {
  db.prepare(`INSERT INTO entitlement_token_windows (entitlement_id,window_kind,window_start,total_tokens,requests,updated_at)
    VALUES (?,'day',?,?,1,?)`).run(entitlementId,START,tokens,START);
}
function prepare(db,input) { return {...input,apply:true,expectedRevision:runAccountOperation(db,input,NOW).revision}; }
function dump(db, table) { return JSON.stringify(db.prepare('SELECT * FROM '+table+' ORDER BY rowid').all()); }
function protectedState(db) { return ['subjects','plans','entitlements','access_credentials','unified_client_keys','phone_auth_identities','entitlement_token_windows','admin_audit_events'].map(t=>dump(db,t)); }
function undoInput(result,subjectIds=['s1']) { return {version:1,operationId:'undo-1',renewalOperationId:result.operation_id,reason:'Correct mistaken renewal',subjectIds,kind:'undo',apply:false}; }

test('query-only preview has zero writes, and exposes neither phone nor key material',async t=>{
  const {db,input}=await fixture(t); const before=protectedState(db);
  db.exec('PRAGMA query_only=ON');
  const result=runAccountOperation(db,input,NOW);
  assert.equal(result.count,4);assert.equal(result.applied,false);
  assert.equal(result.accounts.reduce((n,a)=>n+a.unified_key_updates,0),8);
  assert.ok(!JSON.stringify(result).includes('PRIVATE_'));
  assert.deepEqual(protectedState(db),before);
});

test('one transaction renews four accounts and all old/current keys, preserving existing usage and key contents',async t=>{
  const {db,input}=await fixture(t);
  const keys=db.prepare('SELECT * FROM unified_client_keys ORDER BY id').all();
  const usage=dump(db,'entitlement_token_windows'), plans=dump(db,'plans'), identities=dump(db,'phone_auth_identities');
  const started=performance.now(), result=runAccountOperation(db,prepare(db,input),NOW);
  t.diagnostic('four-account preview + commit: '+(performance.now()-started).toFixed(2)+' ms (local migrated SQLite fixture)');
  assert.equal(result.count,4);assert.equal(result.applied,true);
  assert.equal(db.prepare('SELECT count(*) n FROM entitlements').get().n,8);
  assert.equal(db.prepare("SELECT count(*) n FROM entitlements WHERE state='scheduled' AND period_start=? AND period_end=?").get(OLD,END).n,4);
  assert.deepEqual(db.prepare('SELECT * FROM unified_client_keys ORDER BY id').all().map(k=>({...k})),keys.map(k=>({...k,expires_at:END})));
  assert.equal(dump(db,'entitlement_token_windows'),usage);assert.equal(dump(db,'plans'),plans);assert.equal(dump(db,'phone_auth_identities'),identities);
  assert.equal(db.prepare('SELECT count(*) n FROM admin_audit_events').get().n,5);
  assert.ok(!dump(db,'admin_audit_events').includes('PRIVATE_'));
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length,0);
  const {activeForSubjectInTransaction}=await import('../packages/store-sqlite/src/entitlement-transitions.ts');
  db.exec('BEGIN IMMEDIATE');
  assert.equal(activeForSubjectInTransaction(db,'s1',NOW).id,'e1');
  const active=activeForSubjectInTransaction(db,'s1',new Date(OLD));
  assert.equal(active.periodEnd.toISOString(),END);assert.equal(active.id,result.accounts[0].entitlement_id);
  db.exec('ROLLBACK');
});

test('lost response can be retried with the same operation ID without another grant or audit',async t=>{
  const {db,input}=await fixture(t);const applied=prepare(db,input);
  const first=runAccountOperation(db,applied,NOW), before=protectedState(db);
  assert.equal(runAccountOperation(db,applied,NOW).replayed,true);
  assert.equal(runAccountOperation(db,input,NOW).audit_id,first.audit_id);
  assert.deepEqual(protectedState(db),before);
  assert.throws(()=>runAccountOperation(db,{...applied,reason:'different'},NOW),/different arguments/);
});

for(const [name,sql] of [
  ['second key update fails',"CREATE TRIGGER inject_failure BEFORE UPDATE ON unified_client_keys WHEN OLD.id='k2' BEGIN SELECT RAISE(ABORT,'key write failed'); END"],
  ['second account audit fails',"CREATE TRIGGER inject_failure BEFORE INSERT ON admin_audit_events WHEN NEW.target_user_id='s2' BEGIN SELECT RAISE(ABORT,'audit write failed'); END"],
  ['final receipt fails',"CREATE TRIGGER inject_failure BEFORE INSERT ON admin_audit_events WHEN NEW.target_user_id IS NULL BEGIN SELECT RAISE(ABORT,'receipt write failed'); END"],
]) test('whole batch rolls back when '+name,async t=>{
  const {db,input}=await fixture(t);const operation=prepare(db,input), before=protectedState(db);db.exec(sql);
  assert.throws(()=>runAccountOperation(db,operation,NOW),/failed/);
  assert.deepEqual(protectedState(db),before);
  db.exec('DROP TRIGGER inject_failure');
  assert.equal(runAccountOperation(db,operation,NOW).applied,true);
});

for(const [name,sql,mutate] of [
  ['disabled account',"UPDATE subjects SET state='disabled' WHERE id='s2'"],
  ['revoked current key',"UPDATE unified_client_keys SET revoked_at='2026-11-12T00:00:00.000Z' WHERE id='k2'"],
  ['revoked backing',"UPDATE access_credentials SET revoked_at='2026-11-12T00:00:00.000Z' WHERE id='c2'"],
  ['wrong phone binding',"UPDATE phone_auth_identities SET unified_key_id='legacy2' WHERE subject_id='s2'"],
  ['wrong key binding',"UPDATE unified_client_keys SET codex_credential_id='c1' WHERE id='legacy2'"],
  ['paused entitlement',"UPDATE entitlements SET state='paused' WHERE id='e2'"],
  ['lifetime quota',"UPDATE entitlements SET policy_snapshot_json='{\"tokensTotal\":1000}' WHERE id='e2'"],
  ['deprecated plan',"UPDATE plans SET state='deprecated' WHERE id='"+PLAN+"'"],
  ['duplicate subject',null,input=>input.items.push({...input.items[0]})],
  ['shortening',null,input=>input.items[1].expiresAt=START],
  ['ambiguous date',null,input=>input.items[1].expiresAt='2027-11-12'],
  ['unexpected secret field',null,input=>input.items[1].apiKey='PRIVATE_INPUT'],
]) test('rejects '+name+' before partial changes',async t=>{
  const {db,input}=await fixture(t);if(sql)db.exec(sql);if(mutate)mutate(input);
  const before=protectedState(db);
  assert.throws(()=>runAccountOperation(db,{...input,apply:true,expectedRevision:'f'.repeat(64)},NOW));
  assert.deepEqual(protectedState(db),before);
});

test('stale preview rejects changed control state but ordinary current-period usage does not invalidate it',async t=>{
  const {db,input}=await fixture(t);const operation=prepare(db,input);
  db.exec("UPDATE entitlement_token_windows SET total_tokens=2000 WHERE entitlement_id='e1'");
  db.exec("UPDATE access_credentials SET rate_json='{\"requestsPerDay\":123}' WHERE id='c2'");
  const before=protectedState(db);
  assert.throws(()=>runAccountOperation(db,operation,NOW),/revision/);
  assert.deepEqual(protectedState(db),before);
  const fresh=prepare(db,input);
  db.exec("UPDATE entitlement_token_windows SET total_tokens=3000 WHERE entitlement_id='e1'");
  assert.equal(runAccountOperation(db,fresh,NOW).applied,true);
});

test('expired account renewal requires an explicit start, preserves old usage and revives unrevoked credentials',async t=>{
  const {db,input}=await fixture(t,1);const past='2026-11-10T00:00:00.000Z';
  db.prepare('UPDATE entitlements SET period_end=?').run(past);
  db.prepare('UPDATE access_credentials SET expires_at=?').run(past);
  db.prepare('UPDATE unified_client_keys SET expires_at=?').run(past);
  assert.throws(()=>runAccountOperation(db,input,NOW),/explicit start/);
  input.items[0].startsAt=NOW.toISOString();
  const usage=dump(db,'entitlement_token_windows');
  const result=runAccountOperation(db,prepare(db,input),NOW);
  assert.equal(result.accounts[0].mode,'reactivate');
  assert.equal(db.prepare("SELECT state FROM entitlements WHERE id='e1'").get().state,'expired');
  assert.equal(db.prepare('SELECT state FROM entitlements WHERE id=?').get(result.accounts[0].entitlement_id).state,'active');
  assert.equal(dump(db,'entitlement_token_windows'),usage);
});

test('another renewal extends the existing scheduled continuation instead of creating conflicting schedules',async t=>{
  const {db,input}=await fixture(t,1), first=runAccountOperation(db,prepare(db,input),NOW);
  const next={...input,operationId:'test-renewal-2',items:[{subjectId:'s1',entitlementId:first.accounts[0].entitlement_id,expiresAt:'2028-11-12T06:00:00.000Z'}]};
  const result=runAccountOperation(db,prepare(db,next),NOW);
  assert.equal(result.accounts[0].mode,'extend_scheduled');
  assert.equal(db.prepare('SELECT count(*) n FROM entitlements').get().n,2);
  assert.equal(db.prepare('SELECT count(*) n FROM unified_client_keys').get().n,2);
});

test('service credential renewal never creates a phone identity or personal key',async t=>{
  const {db,input}=await fixture(t,1);
  db.exec("DELETE FROM phone_auth_identities; DELETE FROM unified_client_keys; UPDATE access_credentials SET credential_class='service'");
  const result=runAccountOperation(db,prepare(db,input),NOW);
  assert.equal(result.accounts[0].unified_key_updates,0);
  assert.equal(db.prepare('SELECT count(*) n FROM phone_auth_identities').get().n,0);
});

test('targeted undo preserves the other three accounts, keys, current usage and audit history',async t=>{
  const {db,input}=await fixture(t), usage=dump(db,'entitlement_token_windows');
  const result=runAccountOperation(db,prepare(db,input),NOW);
  const others=[2,3,4].map(n=>accountState(db,'s'+n).revision);
  const undo=undoInput(result), operation=prepare(db,undo);
  const undone=runAccountOperation(db,operation,NOW);
  assert.equal(undone.accounts[0].new_end,OLD);
  assert.equal(db.prepare("SELECT expires_at FROM access_credentials WHERE id='c1'").get().expires_at,KEY_END);
  assert.equal(db.prepare('SELECT state FROM entitlements WHERE id=?').get(result.accounts[0].entitlement_id).state,'cancelled');
  assert.deepEqual([2,3,4].map(n=>accountState(db,'s'+n).revision),others);
  assert.equal(dump(db,'entitlement_token_windows'),usage);
  const before=protectedState(db);
  assert.equal(runAccountOperation(db,operation,NOW).replayed,true);
  assert.deepEqual(protectedState(db),before);
  assert.throws(()=>runAccountOperation(db,prepare(db,input),NOW),/undone/);
});

for(const kind of ['usage','reservation','revocation','scope']) test('undo refuses '+kind+' after the original commit',async t=>{
  const {db,input}=await fixture(t), result=runAccountOperation(db,prepare(db,input),NOW);
  const entitlement=result.accounts[0].entitlement_id;
  if(kind==='usage') addUsage(db,entitlement,1);
  if(kind==='reservation') db.prepare(`INSERT INTO token_reservations (id,request_id,kind,credential_id,subject_id,scope,created_at,
    charge_policy_snapshot,minute_window_start,day_window_start,month_window_start,entitlement_id)
    VALUES ('res1','request1','reservation','c1','s1','code',?,'reserve',?,?,?,?)`).run(START,START,START,START,entitlement);
  if(kind==='revocation') db.exec("UPDATE access_credentials SET revoked_at='2026-11-12T06:01:00.000Z' WHERE id='c1'");
  const before=protectedState(db);
  assert.throws(()=>runAccountOperation(db,undoInput(result,kind==='scope'?['unknown']:['s1']),NOW),/usage|reservations|changed|outside/);
  assert.deepEqual(protectedState(db),before);
});

test('undo also rolls back on journal failure',async t=>{
  const {db,input}=await fixture(t);const result=runAccountOperation(db,prepare(db,input),NOW);
  const operation=prepare(db,undoInput(result,['s1','s2'])), before=protectedState(db);
  db.exec("CREATE TRIGGER reject_undo BEFORE INSERT ON admin_audit_events WHEN NEW.action='entitlement-cancel' AND NEW.target_user_id='s2' BEGIN SELECT RAISE(ABORT,'undo audit failed'); END");
  assert.throws(()=>runAccountOperation(db,operation,NOW),/undo audit failed/);
  assert.deepEqual(protectedState(db),before);
});

test('two database connections cannot overwrite a concurrent administrative change',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'gateway-renewal-'));
  try {
    const path=join(directory,'test.db'), {db,input}=await fixture(t,1,path), operation=prepare(db,input);
    const other=new DatabaseSync(path);other.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5');
    try {
      other.exec('BEGIN IMMEDIATE');
      assert.throws(()=>runAccountOperation(db,operation,NOW),/locked/);
      other.exec("UPDATE subjects SET label='Changed concurrently' WHERE id='s1'; COMMIT");
      assert.throws(()=>runAccountOperation(db,operation,NOW),/revision/);
      assert.equal(db.prepare('SELECT count(*) n FROM entitlements').get().n,1);
      assert.equal(runAccountOperation(db,prepare(db,input),NOW).applied,true);
      assert.equal(runAccountOperation(other,prepare(db,input),NOW).replayed,true);
    } finally {other.close();}
    // Register after fixture's close hook (node:test runs hooks in registration order).
    t.after(()=>rmSync(directory,{recursive:true,force:true}));
  } catch(error) {t.after(()=>rmSync(directory,{recursive:true,force:true}));throw error;}
});

test('missing preview and disabled foreign keys fail closed',async t=>{
  const {db,input}=await fixture(t,1);
  assert.throws(()=>runAccountOperation(db,{...input,apply:true},NOW),/revision/);
  db.exec('PRAGMA foreign_keys=OFF');
  assert.throws(()=>runAccountOperation(db,input,NOW),/Foreign key/);
});
