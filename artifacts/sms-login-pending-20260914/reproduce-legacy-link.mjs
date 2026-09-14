import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import Fastify from 'fastify';
import { createSqliteStore } from '../../packages/store-sqlite/dist/index.js';
import { registerBillingAdminRoutes } from '../../apps/gateway/dist/billing-admin.js';
import { PhoneAuthService, phoneAuthGatewayOrigin } from '../../apps/gateway/dist/services/phone-auth-service.js';

// Local in-memory HTTP injection only. All keys/users/phones are synthetic.
// The upstream stub performs no network requests.
const store = createSqliteStore({ path: ':memory:' });
const app = Fastify({ logger: false });
const now = new Date('2026-09-14T00:00:00Z');
const token = 'local-audit-admin-not-live';
const recovery = 'local-audit-recovery-secret-long-enough-not-live';
const encryption = 'local-audit-encryption-secret-long-enough-not-live';
const provider = 'medevidence_billing';
const phoneAuth = new PhoneAuthService({
  mode:'transition', store, credentialStore:store, unifiedKeyStore:store, entitlementStore:store,
  publicGatewayBaseUrl:phoneAuthGatewayOrigin, issuer:phoneAuthGatewayOrigin, audience:'local-audit', activeKid:'local-audit',
  privateKeyPem:generateKeyPairSync('ed25519').privateKey.export({type:'pkcs8',format:'pem'}).toString(),
  phoneLookupSecret:'local-audit-phone-lookup-secret-long-enough-not-live', phoneEncryptionSecret:'local-audit-phone-encryption-secret-long-enough-not-live',
  unifiedKeyRecoverySecret:recovery, apiKeyEncryptionSecret:encryption, now:()=>now
});
let upstreamCreates = 0;
registerBillingAdminRoutes(app, {
  access:{token,nextToken:null},tokenMode:'env',billingStore:store,credentialStore:store,planEntitlementStore:store,
  externalIdentityStore:store,externalIdentityProvider:provider,phoneAuthService:phoneAuth,
  unifiedKeyRecoverySecret:recovery,apiKeyEncryptionSecret:encryption,now:()=>now,
  upstreamV2Client:{
    async createUser(){upstreamCreates++;return {status:'created',user:{id:'local-audit-user'},key:{id:'local-audit-key',key:'local-audit-upstream-not-live',keyPrefix:'local-audit'}};},
    async revokeKey(){return {revoked:true,key:{id:'local-audit-key'}};},
    async disableUser(){return {disabled:true,user:{id:'local-audit-user'}};}
  }
});
const headers = {authorization:`Bearer ${token}`};
const payload = {provider,external_user_id:'local-audit-legacy-user',scope_allowlist:['code']};
try {
  const created = await app.inject({method:'POST',url:'/gateway/admin/billing/v1/subjects',headers:{...headers,'idempotency-key':'local-audit:original'},payload});
  assert.equal(created.statusCode,200);
  const subjectId = created.json().subject.id;
  const keysBefore = store.listUnifiedClientKeys({subjectId});
  const linked = await app.inject({method:'POST',url:'/gateway/admin/billing/v1/subjects/resolve',headers,
    payload:{provider,external_user_id:payload.external_user_id,phone:'13800138000'}});
  assert.equal(linked.statusCode,200);
  assert.equal(linked.json().status,'linked');
  const retried = await app.inject({method:'POST',url:'/gateway/admin/billing/v1/subjects',headers:{...headers,'idempotency-key':'local-audit:separate-attempt'},payload:{...payload,phone:'13800138000'}});
  assert.equal(retried.statusCode,409);
  assert.equal(retried.json().error.code,'subject_already_exists');
  assert.equal(store.getSubject(subjectId).phoneNumber,null);
  assert.equal(store.getPhoneAuthIdentityBySubjectId(subjectId),null);
  assert.deepEqual(store.listUnifiedClientKeys({subjectId}),keysBefore);
  assert.equal(upstreamCreates,1);
  let loginError;
  try {phoneAuth.login({phone:'13800138000',deviceId:'local-audit-device',requestId:'local-audit-login'});}
  catch(error){loginError=error.code;}
  assert.equal(loginError,'phone_not_registered');
  console.log(JSON.stringify({mode:'local_in_memory_no_network',original_legacy_create_http:created.statusCode,
    resolve_http:linked.statusCode,resolve_status:linked.json().status,subsequent_create_with_phone_http:retried.statusCode,
    subsequent_create_error:retried.json().error.code,subject_phone_present:false,phone_identity_present:false,
    current_keys_unchanged:true,upstream_creates:upstreamCreates,phone_auth_login_error:loginError,
    conclusion:'An existing external identity without phone enrollment is returned as linked; resolve/create does not repair that enrollment. This synthetic reproduction does not identify the live incident user.'}));
} finally {await app.close();store.close();}
