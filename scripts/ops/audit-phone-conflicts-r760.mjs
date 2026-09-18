import { DatabaseSync } from 'node:sqlite';

// Read-only population audit; never emit phone values, lookup hashes or tokens.
const db = new DatabaseSync('/var/lib/codex-gateway/gateway.db', { readOnly: true });
db.exec('PRAGMA query_only=ON; BEGIN');
const now = new Date().toISOString();
const since3 = new Date(Date.parse(now) - 3 * 86400000).toISOString();
const since30 = new Date(Date.parse(now) - 30 * 86400000).toISOString();
const hasIdentityAudit = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='identity_request_events'").get());
const auditSource = hasIdentityAudit ? 'identity_http_requests' : 'legacy_security_events';
// Fixed SQL projection: old security events are explicitly labeled, never merged into HTTP counts.
const auditRelation = hasIdentityAudit
  ? '(SELECT subject_id,operation AS action,outcome,reason_code,completed_at AS created_at FROM identity_request_events)'
  : 'phone_auth_audit_events';
const normalize = value => {
  const s = (value ?? '').startsWith('+86') ? value.slice(3) : value ?? '';
  return /^1[3-9][0-9]{9}$/u.test(s) ? `+86${s}` : null;
};
const scrub = value => String(value ?? '').replace(/(?:\+86)?1[3-9][0-9]{9}/g, '[phone-redacted]');
const subjects = db.prepare('SELECT id,label,display_name,state,phone_number,created_at FROM subjects').all();
const identities = db.prepare('SELECT subject_id,unified_key_id,state,created_at,updated_at FROM phone_auth_identities').all();
const byIdentity = new Map(identities.map(i => [i.subject_id, i]));
const phones = new Map();
for (const s of subjects) {
  const phone = normalize(s.phone_number);
  if (!phone) continue;
  const group = phones.get(phone) ?? [];
  group.push(s); phones.set(phone, group);
}
const safeSubject = s => ({ id: s.id, name: scrub(s.display_name || s.label), state: s.state, created_at: s.created_at });
const summaryFor = s => ({
  ...safeSubject(s),
  identity: byIdentity.get(s.id) ?? null,
  keys: db.prepare('SELECT id,expires_at,revoked_at,is_current,credential_class,token_ciphertext IS NOT NULL AS recoverable FROM unified_client_keys WHERE subject_id=?').all(s.id),
  credentials: db.prepare('SELECT id,scope,expires_at,revoked_at,credential_class FROM access_credentials WHERE subject_id=?').all(s.id),
  entitlements: db.prepare('SELECT id,plan_id,state,period_start,period_end,cancelled_at,cancelled_reason FROM entitlements WHERE subject_id=?').all(s.id),
  auth_history: { source: auditSource, rows: db.prepare(`SELECT action,outcome,reason_code,count(*) AS count,min(created_at) AS first,max(created_at) AS latest FROM ${auditRelation} WHERE subject_id=? GROUP BY action,outcome,reason_code`).all(s.id) },
  legacy_security_history: db.prepare('SELECT action,outcome,reason_code,count(*) AS count,min(created_at) AS first,max(created_at) AS latest FROM phone_auth_audit_events WHERE subject_id=? GROUP BY action,outcome,reason_code').all(s.id),
  request_history: db.prepare('SELECT count(*) AS count,max(started_at) AS latest FROM request_events WHERE subject_id=?').get(s.id)
});
const duplicateGroups = [...phones.values()].filter(g => g.length > 1);
const errorReasons = ['phone_identity_conflict', 'account_migration_required', 'subject_mismatch', 'phone_multiple_subjects', 'linked_subject_phone_mismatch', 'external_identity_binding_conflict', 'phone_reserved_by_other_identity', 'registration_phone_mismatch', 'registration_state_mismatch'];
const placeholders = errorReasons.map(() => '?').join(',');
const errors = db.prepare(`SELECT subject_id,action,reason_code,count(*) AS count,min(created_at) AS first,max(created_at) AS latest FROM ${auditRelation} WHERE reason_code IN (${placeholders}) GROUP BY subject_id,action,reason_code`).all(...errorReasons);
const safeErrors = errors.map(e => ({...e, name: scrub(subjects.find(s => s.id === e.subject_id)?.display_name || subjects.find(s => s.id === e.subject_id)?.label)}));
const windowSummary = since => ({ source: auditSource, rows: db.prepare(`SELECT action,outcome,reason_code,count(*) AS count,count(DISTINCT subject_id) AS subjects,min(created_at) AS first,max(created_at) AS latest FROM ${auditRelation} WHERE created_at>=? GROUP BY action,outcome,reason_code`).all(since) });
const minuteStart = new Date(Math.floor(Date.parse(since3) / 60000) * 60000).toISOString();
const minuteEnd = new Date(Math.ceil(Date.parse(now) / 60000) * 60000).toISOString();
const rateLimits = hasIdentityAudit ? db.prepare(`SELECT operation,limit_dimension,SUM(rejection_count) AS requests
  FROM identity_rate_limit_minutes WHERE minute_start>=? AND minute_start<? GROUP BY operation,limit_dimension`).all(minuteStart,minuteEnd) : null;
console.log(JSON.stringify({
  inspected_at_utc: now, since3, since30,
  identity_audit_source: auditSource,
  coverage_note: 'Retained observations only. Legacy security events are not HTTP outcomes; check deployment, restart and audit-write-failure gaps separately.',
  rate_limits: { detail_level: 'minute_aggregate', actual_from: minuteStart, actual_until: minuteEnd, rows: rateLimits, subject_attribution: 'not_available' },
  totals: {subjects: subjects.length, active_subjects: subjects.filter(s=>s.state==='active').length, valid_phone_subjects: [...phones.values()].flat().length, distinct_valid_phones: phones.size, identities: identities.length, active_identities: identities.filter(i=>i.state==='active').length, duplicate_phone_groups: duplicateGroups.length, duplicate_subjects: duplicateGroups.flat().length, active_identities_in_duplicate_groups: duplicateGroups.flat().filter(s=>s.state==='active' && byIdentity.get(s.id)?.state==='active').length},
  duplicate_groups: duplicateGroups.map((g,i)=>({group:i+1, subjects:g.map(summaryFor)})),
  auth_last3days: windowSummary(since3), auth_last30days: windowSummary(since30),
  same_banner_errors_retained_history: safeErrors,
  audit_retained_range: db.prepare(`SELECT count(*) AS count,min(created_at) AS first,max(created_at) AS latest FROM ${auditRelation}`).get(),
  failed_issuance_disabled_with_phone: subjects.filter(s=>s.state==='disabled' && normalize(s.phone_number) && db.prepare("SELECT 1 FROM entitlements WHERE subject_id=? AND cancelled_reason LIKE 'real_user_issue_failed:%' LIMIT 1").get(s.id)).map(s=>({...safeSubject(s), phone_group_subjects:phones.get(normalize(s.phone_number)).length, identity_state:byIdentity.get(s.id)?.state ?? null}))
}));
db.exec('ROLLBACK'); db.close();
