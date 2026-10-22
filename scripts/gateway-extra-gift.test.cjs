const { test } = require('node:test');
const assert = require('node:assert/strict');
const { grantExtraGift, hash } = require('./gateway-extra-gift.cjs');

async function setup() {
  const { createSqliteStore, createSqliteTokenBudgetLimiter } = await import('../packages/store-sqlite/dist/index.js');
  const { phoneSignupFreePlan, issueAccessCredential } = await import('../packages/core/dist/index.js');
  const store=createSqliteStore({path:':memory:'}), now=new Date(), end=new Date(Date.now()+86400000);
  store.upsertSubject({id:'fixture',label:'fixture',state:'active',createdAt:now});
  const template=phoneSignupFreePlan(now);
  store.createPlan({...template,id:'plan_internal_test',policy:{...template.policy,tokensTotal:null,tokensPerDay:20000000,tokensPerMonth:500000000}});
  store.createPlan({...template,id:'plan_gift_once_20m_v1',policy:{...template.policy,tokensTotal:20000000}});
  const existing=store.grantEntitlement({subjectId:'fixture',planId:'plan_internal_test',periodKind:'one_off',periodStart:now,periodEnd:end,now});
  const credential=issueAccessCredential({subjectId:'fixture',label:'fixture',scope:'code',expiresAt:end});store.insertAccessCredential(credential.record);
  const input={version:1,apply:false,subjectId:'fixture',planId:'plan_gift_once_20m_v1',operationId:'reviewed-gift',tokens:20000000,reason:'test',
    expectedPlanHash:hash(JSON.stringify(store.database.prepare('SELECT * FROM plans WHERE id=?').get('plan_gift_once_20m_v1'))),
    expectedEntitlementsHash:hash(JSON.stringify(store.database.prepare('SELECT * FROM entitlements WHERE subject_id=? ORDER BY id').all('fixture')))};
  return {store,existing,input,credential,now,end,limiter:createSqliteTokenBudgetLimiter({db:store.database})};
}

test('preview is read-only; apply preserves all existing rights and cannot be repeated',async()=>{
  const t=await setup();try{
    const preview=grantExtraGift(t.store.database,t.input);assert.equal(preview.applied,false);assert.equal(t.store.listEntitlements({subjectId:'fixture'}).length,1);
    const result=grantExtraGift(t.store.database,{...t.input,apply:true});assert.equal(result.tokens_added,20000000);
    assert.deepEqual(t.store.getEntitlement(t.existing.id),t.existing);
    assert.equal(t.store.getEntitlement(result.entitlement_id).policySnapshot.tokensTotal,20000000);
    assert.equal(t.store.getEntitlement(result.entitlement_id).periodEnd,null);
    assert.throws(()=>grantExtraGift(t.store.database,{...t.input,apply:true}),/already applied/);
    const next={...t.input,apply:true,operationId:'another-gift',expectedEntitlementsHash:hash(JSON.stringify(t.store.database.prepare('SELECT * FROM entitlements WHERE subject_id=? ORDER BY id').all('fixture')))};
    assert.throws(()=>grantExtraGift(t.store.database,next),/no live free\/gift/);
  }finally{t.store.close();}
});
test('changed templates, entitlements or subjects are rejected before writes',async()=>{
  const t=await setup();try{
    for(const changed of [{expectedPlanHash:'0'.repeat(64)},{expectedEntitlementsHash:'0'.repeat(64)},{tokens:30000000}]){
      assert.throws(()=>grantExtraGift(t.store.database,{...t.input,...changed,apply:true}));
      assert.equal(t.store.listEntitlements({subjectId:'fixture'}).length,1);
    }
    t.store.setSubjectState('fixture','disabled');assert.throws(()=>grantExtraGift(t.store.database,{...t.input,apply:true}),/Active subject/);
  }finally{t.store.close();}
});
test('unsettled requests block a gift',async()=>{
  const t=await setup();try{
    const admitted=await t.limiter.acquire({requestId:'pending',credentialId:t.credential.record.id,subjectId:'fixture',entitlementId:t.existing.id,entitlementPeriodStart:t.now,entitlementPeriodEnd:t.end,scope:'code',upstreamAccountId:null,provider:null,policy:t.existing.policySnapshot,estimatedPromptTokens:1,now:t.now});assert.ok(admitted.ok);
    assert.throws(()=>grantExtraGift(t.store.database,{...t.input,apply:true}),/Unfinished reservations/);
    assert.equal(t.store.listEntitlements({subjectId:'fixture'}).length,1);
  }finally{t.store.close();}
});
test('audit failure rolls the entitlement insertion back',async()=>{
  const t=await setup();try{
    t.store.database.exec("CREATE TRIGGER fail_gift_audit BEFORE INSERT ON admin_audit_events BEGIN SELECT RAISE(ABORT,'audit unavailable'); END");
    assert.throws(()=>grantExtraGift(t.store.database,{...t.input,apply:true}),/audit unavailable/);
    assert.equal(t.store.listEntitlements({subjectId:'fixture'}).length,1);assert.deepEqual(t.store.getEntitlement(t.existing.id),t.existing);
  }finally{t.store.close();}
});
