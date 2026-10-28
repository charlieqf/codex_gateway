const {test}=require('node:test');
const assert=require('node:assert/strict');
const {grantInternalImages}=require('./gateway-internal-image-grants.cjs');
const PLAN='plan_internal_high_quota_image_v1',END='2099-01-01T00:00:00.000Z';
async function fixture(){
  const {createSqliteStore}=await import('../packages/store-sqlite/dist/index.js');
  const {issueAccessCredential,issueUnifiedClientKey}=await import('../packages/core/dist/index.js');
  const store=createSqliteStore({path:':memory:'}),db=store.database,now=new Date();
  const policy={tokensPerMinute:1000000,tokensPerDay:50000000,tokensPerMonth:500000000,maxPromptTokensPerRequest:380000,maxTotalTokensPerRequest:400000,reserveTokensPerRequest:10000,missingUsageCharge:'estimate'};
  store.createPlan({id:PLAN,displayName:'Internal image',scopeAllowlist:['code'],policy,
    featurePolicy:{capabilities:['chat','tools','image_generation'],imageGeneration:{enabled:true,allowedModels:['medcode-image-default'],defaultModel:'medcode-image-default',allowedSizes:['1024x1024'],allowedQualities:['low'],allowedFormats:['png']}},now});
  store.createPlan({id:'plan_free_once_1m_v1',displayName:'Free',scopeAllowlist:['code'],policy:{...policy,tokensTotal:5000000},now});
  const targets=[];
  for(let i=1;i<=2;i++){
    const subjectId=`subject_${i}`;store.upsertSubject({id:subjectId,label:subjectId,state:'active',createdAt:now});
    const c=issueAccessCredential({subjectId,label:'test',scope:'code',expiresAt:new Date(END),credentialClass:'desktop',now});
    store.insertAccessCredential({...c.record,credentialClass:'desktop'});
    const k=issueUnifiedClientKey({subjectId,label:'test',expiresAt:new Date(END),codexCredentialId:c.record.id,
      codexCredentialPrefix:c.record.prefix,codexKeyCiphertext:'cipher',medevidenceKeyCiphertext:'cipher',now});
    store.insertUnifiedClientKey({...k.record,credentialClass:'desktop',isCurrent:true,tokenCiphertext:'recoverable'});
    db.prepare("INSERT INTO phone_auth_identities VALUES (?,?,?,?,'active',?,?)").run(subjectId,'cipher',subjectId,k.record.id,now.toISOString(),now.toISOString());
    const t={subjectId,periodEnd:END,expectedEntitlementId:null,expectedPlanId:null};
    if(i===1){
      const e=store.grantEntitlement({subjectId,planId:'plan_free_once_1m_v1',periodKind:'unlimited',now});
      t.expectedEntitlementId=e.id;t.expectedPlanId=e.planId;
      db.prepare("INSERT INTO entitlement_token_windows(entitlement_id,window_kind,window_start,total_tokens,updated_at) VALUES (?,'day',?,12345,?)").run(e.id,now.toISOString(),now.toISOString());
    }else{
      const old='2020-01-01T00:00:00.000Z';db.prepare('UPDATE access_credentials SET expires_at=? WHERE id=?').run(old,c.record.id);
      t.credentialExtension={id:c.record.id,expectedExpiresAt:old};
    }
    targets.push(t);
  }
  return {store,db,input:{version:1,reason:'Authorized workbook upgrade',targets,apply:false}};
}
const tables=['entitlements','entitlement_token_windows','access_credentials','unified_client_keys','phone_auth_identities','admin_audit_events'];
const dump=db=>tables.map(t=>JSON.stringify(db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()));
test('atomic batch carries real usage, grants both users and renews only the expired backing credential',async()=>{
  const {store,db,input}=await fixture();try{
    const before=dump(db);const p=await grantInternalImages(db,input);assert.deepEqual(dump(db),before);
    assert.equal(p.count,2);assert.equal(p.usage_carried,1);assert.equal(p.expired_credentials_renewed,1);
    const r=await grantInternalImages(db,{...input,apply:true,expectedRevision:p.revision});assert.equal(r.changes.length,2);
    for(const c of r.changes){const e=store.getEntitlement(c.entitlement_id);assert.equal(e.policySnapshot.tokensPerDay,50000000);assert(e.featurePolicySnapshot.imageGeneration.enabled);assert.equal(e.periodEnd.toISOString(),END);}
    assert.equal(db.prepare('SELECT total_tokens FROM entitlement_token_windows WHERE entitlement_id=?').get(r.changes[0].entitlement_id).total_tokens,12345);
    assert.equal(db.prepare('SELECT expires_at FROM access_credentials WHERE id=?').get(input.targets[1].credentialExtension.id).expires_at,END);
    assert.equal(dump(db)[3],before[3]);assert.equal(dump(db)[4],before[4]);
    await assert.rejects(grantInternalImages(db,{...input,apply:true,expectedRevision:p.revision}),/differs from review/);
  }finally{store.close();}
});
for(const [name,sql] of [
  ['disabled second subject',"UPDATE subjects SET state='disabled' WHERE id='subject_2'"],
  ['changed credential',"UPDATE access_credentials SET rate_json='{}' WHERE subject_id='subject_2'"],
  ['audit failure',"CREATE TRIGGER reject_batch_audit BEFORE INSERT ON admin_audit_events WHEN NEW.action='entitlement-grant' BEGIN SELECT RAISE(ABORT,'audit unavailable'); END"]
])test(`${name} rolls back the complete batch`,async()=>{
  const {store,db,input}=await fixture();try{
    const p=await grantInternalImages(db,input);db.exec(sql);const before=dump(db);
    await assert.rejects(grantInternalImages(db,{...input,apply:true,expectedRevision:p.revision}));assert.deepEqual(dump(db),before);
  }finally{store.close();}
});
