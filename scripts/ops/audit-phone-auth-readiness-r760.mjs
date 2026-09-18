import { DatabaseSync } from 'node:sqlite';
import { PhoneAuthService, resolvePhoneAuthServiceOptions } from '/app/apps/gateway/dist/services/phone-auth-service.js';
import * as subjects from '/app/packages/store-sqlite/dist/subjects.js';
import * as phoneAuth from '/app/packages/store-sqlite/dist/phone-auth.js';
import * as credentials from '/app/packages/store-sqlite/dist/access-credentials.js';

// Execute the deployed identity/runtime checks against strictly read-only stores.
// Stop at entitlement evaluation: the real entitlement accessor can write time transitions.
// Never call login(), bootstrap(), the regular store constructor, or emit secret values.
const db = new DatabaseSync('/var/lib/codex-gateway/gateway.db', { readOnly: true });
db.exec('PRAGMA query_only=ON; BEGIN');
const now = new Date();
const hasIdentityAudit = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='identity_request_events'").get());
const latestLogin = hasIdentityAudit
  ? db.prepare("SELECT request_id,operation,outcome,reason_code,completed_at FROM identity_request_events WHERE subject_id=? AND operation='phone_login' ORDER BY completed_at DESC,request_id DESC LIMIT 1")
  : db.prepare("SELECT action,outcome,reason_code,created_at FROM phone_auth_audit_events WHERE subject_id=? AND action='login' ORDER BY created_at DESC LIMIT 1");
const reachedEntitlement = Symbol('identity-and-runtime-checks-passed');
const readStore = {
  getSubject: id => subjects.get(db, id),
  listSubjects: input => subjects.list(db, input),
  getPhoneAuthUnifiedKey: id => phoneAuth.getUnifiedKey(db, id),
  getAccessCredentialByPrefix: prefix => credentials.getByPrefix(db, prefix)
};
const options = resolvePhoneAuthServiceOptions(process.env, {
  store: readStore, credentialStore: readStore, unifiedKeyStore: readStore,
  entitlementStore: { entitlementAccessForSubject() { throw reachedEntitlement; } },
  now: () => now
});
const service = new PhoneAuthService(options);
if (typeof service.requireReadyAccountForIdentity !== 'function') throw new Error('Readiness method not available');
const rows = db.prepare("SELECT subject_id FROM phone_auth_identities WHERE state='active' ORDER BY subject_id").all();
const counts = {};
const problems = [];
const scrub = value => String(value ?? '').replace(/(?:\+86)?1[3-9][0-9]{9}/g, '[phone-redacted]');
for (const { subject_id } of rows) {
  const identity = phoneAuth.getIdentityBySubjectId(db, subject_id);
  const subject = readStore.getSubject(subject_id);
  let result;
  try {
    service.requireReadyAccountForIdentity(identity, now);
    throw new Error('Expected stop before entitlement evaluation');
  } catch (error) {
    if (error === reachedEntitlement) result = 'identity_and_runtime_ready';
    else if (typeof error?.code === 'string') result = error.code;
    else throw new Error('Unclassified readiness check failure');
  }
  counts[result] = (counts[result] ?? 0) + 1;
  if (result !== 'identity_and_runtime_ready') {
    const key = readStore.getPhoneAuthUnifiedKey(identity.unifiedKeyId);
    const credential = key ? readStore.getAccessCredentialByPrefix(key.codexCredentialPrefix) : null;
    problems.push({
      subject_id, name: scrub(subject?.displayName || subject?.label), subject_state: subject?.state,
      result, identity_updated_at: identity.updatedAt,
      key: key ? {expires_at:key.expiresAt, revoked_at:key.revokedAt, is_current:key.isCurrent, credential_class:key.credentialClass, recoverable:Boolean(key.tokenCiphertext)} : null,
      backing_credential: credential ? {expires_at:credential.expiresAt, revoked_at:credential.revokedAt, scope:credential.scope, credential_class:credential.credentialClass} : null,
      entitlements: db.prepare('SELECT plan_id,state,period_start,period_end FROM entitlements WHERE subject_id=? ORDER BY created_at DESC LIMIT 3').all(subject_id),
      latest_login: { source: hasIdentityAudit ? 'identity_http_requests' : 'legacy_security_events', event: latestLogin.get(subject_id) ?? null }
    });
  }
}
console.log(JSON.stringify({inspected_at_utc:now.toISOString(), active_identities_checked:rows.length, counts, problems,
  identity_audit_source: hasIdentityAudit ? 'identity_http_requests' : 'legacy_security_events',
  coverage_note: 'Missing observations do not prove no failures; check cutover/restart/write-failure gaps. Legacy session creation is not final HTTP success.',
  limit:'Deployed identity and runtime readiness checks only; entitlement evaluation is deliberately not executed because it may write state transitions. No login sessions created.'}));
db.exec('ROLLBACK'); db.close();
