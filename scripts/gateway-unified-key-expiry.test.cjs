const {test}=require('node:test');
const assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const {extendUnifiedKeyExpiry}=require('./gateway-unified-key-expiry.cjs');
const OLD='2026-10-01T00:00:00.000Z', END='2027-01-01T00:00:00.000Z';
const NOW=new Date('2026-09-17T00:00:00.000Z');
function fixture(){
 const db=new DatabaseSync(':memory:');
 db.exec(`CREATE TABLE subjects(id TEXT PRIMARY KEY,state TEXT);
 CREATE TABLE unified_client_keys(id TEXT PRIMARY KEY,subject_id TEXT,expires_at TEXT,revoked_at TEXT,is_current INTEGER,
 credential_class TEXT,token_ciphertext TEXT,codex_credential_id TEXT,codex_credential_prefix TEXT,hash TEXT);
 CREATE TABLE access_credentials(id TEXT PRIMARY KEY,subject_id TEXT,prefix TEXT,expires_at TEXT,revoked_at TEXT,scope TEXT,credential_class TEXT);
 CREATE TABLE phone_auth_identities(subject_id TEXT,state TEXT,unified_key_id TEXT);
 CREATE TABLE plans(id TEXT PRIMARY KEY,state TEXT);
 CREATE TABLE entitlements(id TEXT PRIMARY KEY,subject_id TEXT,plan_id TEXT,state TEXT,period_start TEXT,period_end TEXT,scope_allowlist_json TEXT,feature_policy_snapshot_json TEXT);
 CREATE TABLE admin_audit_events(id TEXT PRIMARY KEY,action TEXT,target_user_id TEXT,status TEXT,params_json TEXT,created_at TEXT);
 CREATE TABLE usage_windows(subject_id TEXT,total_tokens INTEGER);
 INSERT INTO plans VALUES ('plan','active');`);
 const items=[];
 for(let i=1;i<=2;i++){
  db.prepare("INSERT INTO subjects VALUES (?,'active')").run(`s${i}`);
  db.prepare("INSERT INTO unified_client_keys VALUES (?,?,?,NULL,1,'desktop','cipher',?,?,'hash')")
   .run(`k${i}`,`s${i}`,OLD,`c${i}`,`prefix${i}`);
  db.prepare("INSERT INTO access_credentials VALUES (?,?,?,?,NULL,'code','desktop')")
   .run(`c${i}`,`s${i}`,`prefix${i}`,END);
  db.prepare("INSERT INTO phone_auth_identities VALUES (?,'active',?)").run(`s${i}`,`k${i}`);
  for(const [id,state,start,end] of [[`old${i}`,'active','2026-01-01T00:00:00.000Z',OLD],[`new${i}`,'scheduled',OLD,END]]){
   db.prepare(`INSERT INTO entitlements VALUES (?,?,'plan',?,?,?,'["code"]','{"capabilities":["chat"]}')`).run(id,`s${i}`,state,start,end);
  }
  db.prepare('INSERT INTO usage_windows VALUES (?,12345)').run(`s${i}`);
  items.push({subjectId:`s${i}`,keyId:`k${i}`,expectedExpiresAt:OLD,expiresAt:END});
 }
 return {db,input:{version:1,reason:'Authorized renewal',items,apply:true}};
}
const dump=(db,t)=>JSON.stringify(db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all());
test('extends both keys atomically, preserving tokens, bindings and usage, with before/after audits',()=>{
 const {db,input}=fixture();
 const protectedTables=['subjects','access_credentials','phone_auth_identities','plans','entitlements','usage_windows'];
 const snapshots=protectedTables.map(t=>dump(db,t));
 const before=db.prepare('SELECT * FROM unified_client_keys').all();
 const result=extendUnifiedKeyExpiry(db,input,NOW);
 assert.equal(result.count,2);assert.equal(result.audit_ids.length,2);
 assert.deepEqual(db.prepare('SELECT * FROM unified_client_keys').all().map(k=>({...k})),before.map(k=>({...k,expires_at:END})));
 assert.deepEqual(protectedTables.map(t=>dump(db,t)),snapshots);
 const audits=db.prepare('SELECT params_json FROM admin_audit_events').all().map(r=>JSON.parse(r.params_json));
 assert.ok(audits.every(r=>r.old_expires_at===OLD&&r.new_expires_at===END&&r.operation==='extend-unified-key-expiry'));
 assert.throws(()=>extendUnifiedKeyExpiry(db,input,NOW),/expected state/);
 db.close();
});
test('preview runs on a query-only connection without changing keys or auditing',()=>{
 const {db,input}=fixture();const before=dump(db,'unified_client_keys');
 db.exec('PRAGMA query_only=ON');
 assert.equal(extendUnifiedKeyExpiry(db,{...input,apply:false},NOW).applied,false);
 assert.equal(dump(db,'unified_client_keys'),before);
 assert.equal(db.prepare('SELECT count(*) n FROM admin_audit_events').get().n,0);db.close();
});
for(const [name,sql,change] of [
 ['stale second key',"UPDATE unified_client_keys SET expires_at='2026-10-02T00:00:00.000Z' WHERE id='k2'"],
 ['disabled subject',"UPDATE subjects SET state='disabled' WHERE id='s2'"],
 ['revoked key',"UPDATE unified_client_keys SET revoked_at='2026-09-16T00:00:00.000Z' WHERE id='k2'"],
 ['unknown credential class',"UPDATE unified_client_keys SET credential_class='unknown' WHERE id='k2'"],
 ['nonrecoverable key',"UPDATE unified_client_keys SET token_ciphertext=NULL WHERE id='k2'"],
 ['multiple current keys',"INSERT INTO unified_client_keys SELECT 'extra',subject_id,expires_at,revoked_at,is_current,credential_class,token_ciphertext,codex_credential_id,codex_credential_prefix,hash FROM unified_client_keys WHERE id='k2'"],
 ['wrong backing subject',"UPDATE access_credentials SET subject_id='s1' WHERE id='c2'"],
 ['backing too short',"UPDATE access_credentials SET expires_at='2026-12-01T00:00:00.000Z' WHERE id='c2'"],
 ['phone identity mismatch',"UPDATE phone_auth_identities SET unified_key_id='k1' WHERE subject_id='s2'"],
 ['entitlement gap',"UPDATE entitlements SET period_start='2026-10-02T00:00:00.000Z' WHERE id='new2'"],
 ['no chat capability',"UPDATE entitlements SET feature_policy_snapshot_json='{}' WHERE id='new2'"],
 ['audit fails after first update',"CREATE TRIGGER reject_second_audit BEFORE INSERT ON admin_audit_events WHEN NEW.target_user_id='s2' BEGIN SELECT RAISE(ABORT,'audit unavailable'); END"],
 ['duplicate target',null,input=>input.items.push({...input.items[0]})],
 ['shortening',null,input=>input.items[1].expiresAt='2026-09-30T00:00:00.000Z'],
 ['wrong target key',null,input=>input.items[1].keyId='missing'],
 ['timezone ambiguity',null,input=>input.items[1].expiresAt='2027-01-01'],
]) test(`rejects ${name} and preserves the complete batch`,()=>{
 const {db,input}=fixture();if(sql)db.exec(sql);if(change)change(input);
 const before=dump(db,'unified_client_keys');
 assert.throws(()=>extendUnifiedKeyExpiry(db,input,NOW));
 assert.equal(dump(db,'unified_client_keys'),before);
 assert.equal(db.prepare('SELECT count(*) n FROM admin_audit_events').get().n,0);db.close();
});
