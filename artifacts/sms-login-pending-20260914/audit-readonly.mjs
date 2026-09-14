import { DatabaseSync } from 'node:sqlite';
import { normalizeMainlandChinaPhone, phoneLookupHash } from '/app/packages/core/dist/index.js';
import { resolvePhoneAuthServiceOptions } from '/app/apps/gateway/dist/services/phone-auth-service.js';

// Runs in the deployed container. No service methods or user sessions are invoked.
// Phones, hashes, external IDs, labels, request bodies and credentials stay in memory.
const db = new DatabaseSync('/var/lib/codex-gateway/gateway.db', { readOnly: true });
const telemetry = new DatabaseSync('/var/lib/codex-gateway/client-events.db', { readOnly: true });
db.exec('PRAGMA query_only=ON; BEGIN');
telemetry.exec('PRAGMA query_only=ON; BEGIN');
const requestId = 'req-c16a568d-b565-4e59-81dd-2ec8bdca11d2';
const target = db.prepare('SELECT phone_hash FROM phone_auth_audit_events WHERE request_id=?').get(requestId);
if (!target?.phone_hash) throw new Error('Target phone audit unavailable');
const options = resolvePhoneAuthServiceOptions(process.env, {});
if (!options.phoneLookupSecret) throw new Error('Phone lookup unavailable');
const matches = value => {
  const normalized = typeof value === 'string' ? normalizeMainlandChinaPhone(value) : null;
  return normalized !== null && phoneLookupHash(normalized, options.phoneLookupSecret) === target.phone_hash;
};
const safeSubject = row => ({ id: row.id, state: row.state, created_at: row.created_at });
const subjects = db.prepare('SELECT id,state,created_at,phone_number,external_user_id FROM subjects').all();
const registrations = db.prepare('SELECT * FROM external_subject_registrations').all();
const matchingSubjects = subjects.filter(row => matches(row.phone_number));
const matchingRegistrations = registrations.filter(row => matches(row.phone_number));
const phoneCandidates = value => typeof value === 'string' ? value.match(/(?:\+86)?1[3-9][0-9]{9}/gu) ?? [] : [];
const externalPhoneSubjects = subjects.filter(row => phoneCandidates(row.external_user_id).some(matches));
const auditMatches = [];
for (const row of db.prepare('SELECT id,action,target_user_id,status,params_json,created_at FROM admin_audit_events').all()) {
  let params;
  try { params = JSON.parse(row.params_json); } catch { continue; }
  const visit = obj => obj && typeof obj === 'object' && Object.entries(obj).some(([key,value]) =>
    /^(phone|phone_number|phoneNumber|external_user_id|externalUserId)$/u.test(key)
      ? phoneCandidates(value).some(matches)
      : typeof value === 'object' && visit(value));
  if (visit(params)) auditMatches.push({ id:row.id, action:row.action, subject_id:row.target_user_id, status:row.status, created_at:row.created_at });
}
const subjectIds = [...new Set([...matchingSubjects.map(r=>r.id), ...externalPhoneSubjects.map(r=>r.id),
  ...matchingRegistrations.map(r=>r.subject_id), ...auditMatches.map(r=>r.subject_id)].filter(Boolean))];
const related = db.prepare('SELECT request_id,action,subject_id,outcome,reason_code,created_at FROM phone_auth_audit_events WHERE phone_hash=? ORDER BY created_at').all(target.phone_hash);
const today = related.filter(row => row.created_at >= '2026-09-14T00:00:00.000Z');
const identity = db.prepare('SELECT subject_id,state,created_at,updated_at FROM phone_auth_identities WHERE phone_hash=?').all(target.phone_hash);
const report = {
  checked_at:new Date().toISOString(), request_id:requestId,
  target_audit:related.filter(row=>row.request_id===requestId), related, identity,
  today_summary:{ total:today.length, phone_not_registered:today.filter(r=>r.reason_code==='phone_not_registered').length,
    auth_rate_limited:today.filter(r=>r.reason_code==='auth_rate_limited').length },
  matching_subjects:matchingSubjects.map(safeSubject),
  matching_registrations:matchingRegistrations.map(r=>({state:r.state,subject_id:r.subject_id,request_id:r.request_id,created_at:r.created_at,updated_at:r.updated_at})),
  phone_in_external_id_subjects:externalPhoneSubjects.map(safeSubject), matching_admin_audits:auditMatches,
  candidate_subject_details:subjectIds.map(id=>({
    subject_id:id,
    keys:db.prepare('SELECT id,credential_class,is_current,expires_at,revoked_at,token_ciphertext IS NOT NULL AS recoverable FROM unified_client_keys WHERE subject_id=?').all(id),
    entitlements:db.prepare('SELECT id,plan_id,state,period_start,period_end FROM entitlements WHERE subject_id=?').all(id),
    billing_subject_events:db.prepare('SELECT id,event_type,subject_id,status,created_at,applied_at FROM billing_subject_events WHERE subject_id=?').all(id)
  })),
  population_checked:{subjects:subjects.length,registrations:registrations.length,admin_audits:db.prepare('SELECT COUNT(*) AS n FROM admin_audit_events').get().n},
  model_requests:db.prepare('SELECT request_id,subject_id,status,error_code,started_at FROM request_events WHERE request_id=?').all(requestId),
  diagnostics:telemetry.prepare("SELECT subject_id,action,status,error_code,app_version,created_at FROM client_diagnostic_events WHERE json_extract(metadata_json,'$.gateway_request_id')=?").all(requestId),
  same_day_billing_summary:db.prepare('SELECT event_type,status,COUNT(*) AS count,MIN(created_at) AS first,MAX(created_at) AS latest FROM billing_subject_events WHERE created_at>=? GROUP BY event_type,status').all('2026-09-14T00:00:00.000Z'),
  matching_limit:'No external identity-backend logs or unknown external user ID were available. An existing Subject with no matching phone evidence cannot be excluded.'
};
console.log(JSON.stringify(report));
telemetry.exec('ROLLBACK');telemetry.close();db.exec('ROLLBACK');db.close();
