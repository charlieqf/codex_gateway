// Bounded internal-account renewal. No migrations, full backup, secret export or usage reset.
// The transaction includes its recovery journal; the audit primary key is the idempotency key.
'use strict';
const {createHash} = require('node:crypto');
const {DatabaseSync} = require('node:sqlite');

const FORMAT = 'account-renewal.v1';
const MAX_ACCOUNTS = 100;
const TABLE_FIELDS = {
  access_credentials: ['expires_at'],
  unified_client_keys: ['expires_at'],
  entitlements: ['state', 'period_end', 'cancelled_at', 'cancelled_reason'],
};
const ENTITLEMENT_FIELDS = ['id', 'subject_id', 'plan_id', 'policy_snapshot_json',
  'feature_policy_snapshot_json', 'scope_allowlist_json', 'period_kind', 'period_start',
  'period_end', 'state', 'team_seat_id', 'created_at', 'cancelled_at', 'cancelled_reason', 'notes'];
function check(value, message) { if (!value) throw new Error(message); }
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  return value;
}
function hash(value) { return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex'); }
function id(value) { return typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value); }
function timestamp(value) {
  check(typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value, 'Expected canonical UTC timestamp');
  return Date.parse(value);
}
function only(value, fields) {
  check(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(k => fields.includes(k)), 'Unexpected operation fields');
}
function auditId(operationId) { return 'audit_account_' + hash(operationId); }
function undoneId(operationId, subjectId) { return 'audit_account_undo_' + hash([operationId, subjectId]); }
function stableRow(row) {
  return Object.fromEntries(Object.entries(row).filter(([key]) => !['last_used_at', 'updated_at'].includes(key)));
}
function accountState(db, subjectId) {
  const subject = db.prepare('SELECT * FROM subjects WHERE id=?').get(subjectId);
  check(subject, 'Subject not found');
  const entitlements = db.prepare('SELECT * FROM entitlements WHERE subject_id=? ORDER BY id').all(subjectId);
  const plans = [...new Set(entitlements.map(e => e.plan_id))].sort().map(planId => db.prepare('SELECT * FROM plans WHERE id=?').get(planId));
  const credentials = db.prepare('SELECT * FROM access_credentials WHERE subject_id=? ORDER BY id').all(subjectId);
  const keys = db.prepare('SELECT * FROM unified_client_keys WHERE subject_id=? ORDER BY id').all(subjectId);
  const identities = db.prepare('SELECT * FROM phone_auth_identities WHERE subject_id=? ORDER BY subject_id').all(subjectId);
  // Secrets and phone numbers are hashed in memory, never copied into the journal or output.
  return {subject, entitlements, plans, credentials, keys, identities,
    revision:hash({subject, entitlements, plans, credentials:credentials.map(stableRow), keys:keys.map(stableRow), identities:identities.map(stableRow)})};
}
function readAudit(db, key) {
  const row = db.prepare('SELECT params_json FROM admin_audit_events WHERE id=?').get(key);
  return row ? JSON.parse(row.params_json) : null;
}
function insertAudit(db, key, subjectId, data, now, action='entitlement-renew') {
  db.prepare(`INSERT INTO admin_audit_events (id,action,target_user_id,status,params_json,created_at)
    VALUES (?,?,?,'ok',?,?)`).run(key,action,subjectId,JSON.stringify(data),now.toISOString());
}
function validateInput(input) {
  only(input, ['version','operationId','reason','items','renewalOperationId','subjectIds','expectedRevision','apply','kind']);
  check(input.version === 1 && typeof input.apply === 'boolean' && id(input.operationId), 'Invalid operation identity');
  check(typeof input.reason === 'string' && input.reason.trim() && input.reason.length <= 500, 'A reason of at most 500 characters is required');
  check(['renew','undo'].includes(input.kind), 'Invalid account operation');
  check(input.expectedRevision === undefined || /^[a-f0-9]{64}$/.test(input.expectedRevision), 'Invalid preview revision');
  if (input.kind === 'renew') {
    check(input.renewalOperationId === undefined && input.subjectIds === undefined, 'Unexpected undo fields');
    check(Array.isArray(input.items) && input.items.length > 0 && input.items.length <= MAX_ACCOUNTS, 'Expected 1 to 100 accounts');
    const subjects = new Set();
    for (const item of input.items) {
      only(item, ['subjectId','entitlementId','expiresAt','startsAt']);
      check(id(item.subjectId) && id(item.entitlementId) && !subjects.has(item.subjectId), 'Invalid or duplicate account');
      subjects.add(item.subjectId); timestamp(item.expiresAt);
      if (item.startsAt !== undefined) timestamp(item.startsAt);
    }
  } else {
    check(input.items === undefined && id(input.renewalOperationId) && input.operationId !== input.renewalOperationId, 'Invalid renewal reference');
    check(Array.isArray(input.subjectIds) && input.subjectIds.length > 0 && input.subjectIds.length <= MAX_ACCOUNTS &&
      input.subjectIds.every(id) && new Set(input.subjectIds).size === input.subjectIds.length, 'Expected distinct account IDs');
  }
}
function requestHash(input) {
  const {apply, expectedRevision, ...request} = input;
  return hash(request);
}
function change(table, row, fields) {
  return {table,id:row.id,before:Object.fromEntries(Object.keys(fields).map(k => [k,row[k]])),after:fields};
}
function assessRenewal(db, input, now) {
  return input.items.map(item => {
    const state = accountState(db,item.subjectId);
    check(state.subject.state === 'active', 'Account must be active');
    const source = state.entitlements.find(e => e.id === item.entitlementId);
    check(source && ['active','scheduled','expired'].includes(source.state) && source.period_end, 'Expected a finite active, scheduled or expired source entitlement');
    check(source.plan_id.startsWith('plan_internal_') && !source.team_seat_id, 'Use the billing or team workflow for non-internal plans');
    check(state.plans.find(p => p?.id === source.plan_id)?.state === 'active', 'Source plan is not active');
    const policy = JSON.parse(source.policy_snapshot_json);
    const features = JSON.parse(source.feature_policy_snapshot_json);
    const scopes = JSON.parse(source.scope_allowlist_json);
    check(policy.tokensTotal == null && Array.isArray(scopes) && scopes.includes('code') && features.capabilities?.includes('chat'), 'Source is not a renewable chat plan');
    const end = timestamp(item.expiresAt), oldEnd = timestamp(source.period_end);
    check(end > Math.max(oldEnd,now.getTime()), 'Renewal must extend coverage into the future');
    check(!state.entitlements.some(e => e.state === 'paused'), 'Paused entitlements require explicit reconciliation');
    const live = state.entitlements.filter(e => ['active','scheduled'].includes(e.state) && (e.period_end === null || timestamp(e.period_end) > now.getTime()));
    let mode, start;
    if (source.state === 'scheduled') {
      check(timestamp(source.period_start) > now.getTime() && live.filter(e => e.state === 'scheduled').length === 1, 'Scheduled entitlement is no longer pending or is ambiguous');
      const current = live.filter(e => e.state === 'active');
      check(current.length === 1 && current[0].period_end === source.period_start && timestamp(current[0].period_start) <= now.getTime() &&
        current[0].plan_id === source.plan_id && current[0].policy_snapshot_json === source.policy_snapshot_json &&
        current[0].feature_policy_snapshot_json === source.feature_policy_snapshot_json && current[0].scope_allowlist_json === source.scope_allowlist_json,
        'Scheduled renewal lacks matching continuous current coverage');
      check(item.startsAt === undefined, 'Scheduled renewal does not accept a new start');
      mode='extend_scheduled'; start=source.period_start;
    } else if (oldEnd > now.getTime()) {
      check(source.state === 'active' && timestamp(source.period_start) <= now.getTime() && live.length === 1 && live[0].id === source.id,
        'Conflicting current or scheduled entitlement');
      check(item.startsAt === undefined, 'Active renewal starts at the existing period end');
      mode='append'; start=source.period_end;
    } else {
      check(live.length === 0 && !state.entitlements.some(e => e.period_end && e.period_end > source.period_end && e.state !== 'cancelled'), 'Expired source is not the latest entitlement');
      check(item.startsAt !== undefined && timestamp(item.startsAt) >= oldEnd && timestamp(item.startsAt) <= now.getTime(), 'Expired renewal requires an explicit start between the old end and now');
      mode='reactivate'; start=item.startsAt;
    }
    const credentials = state.credentials.filter(c => !c.revoked_at);
    check(credentials.length > 0 && credentials.every(c => c.scope === 'code' && ['desktop','unknown','service'].includes(c.credential_class)), 'Unsupported or missing backing credentials');
    const keys = state.keys.filter(k => !k.revoked_at);
    const currentKeys = state.keys.filter(k => k.is_current);
    check(currentKeys.length <= 1 && state.identities.length <= 1, 'Ambiguous key or phone identity');
    if (currentKeys.length) {
      const key=currentKeys[0], identity=state.identities[0];
      check(!key.revoked_at && key.credential_class === 'desktop' && key.token_ciphertext &&
        identity?.state === 'active' && identity.unified_key_id === key.id, 'Current key or phone binding is not active');
    } else check(!state.identities.length, 'Phone identity lacks a current key');
    for (const key of keys) {
      const backing=credentials.find(c => c.id === key.codex_credential_id);
      check(backing && backing.prefix === key.codex_credential_prefix, 'Key backing credential is inactive or mismatched');
      if (key.is_current) check(backing.credential_class === 'desktop', 'Current backing class mismatch');
      else check(key.credential_class === 'unknown' && !key.token_ciphertext &&
        (currentKeys.length ? key.codex_credential_id === currentKeys[0].codex_credential_id : backing.credential_class === 'unknown'), 'Unsupported legacy key binding');
    }
    const changes=[];
    let renewedId=source.id;
    if (mode === 'extend_scheduled') changes.push(change('entitlements',source,{period_end:item.expiresAt}));
    else {
      if (mode === 'reactivate') for (const e of state.entitlements.filter(e => ['active','scheduled'].includes(e.state))) {
        check(e.period_end && timestamp(e.period_end) <= now.getTime(), 'Cannot expire a live entitlement');
        changes.push(change('entitlements',e,{state:'expired'}));
      }
      renewedId='ent_' + hash([input.operationId,item.subjectId]).slice(0,32);
      check(!state.entitlements.some(e => e.id === renewedId), 'Renewal entitlement ID already exists without its receipt');
      const row={id:renewedId,subject_id:item.subjectId,plan_id:source.plan_id,policy_snapshot_json:source.policy_snapshot_json,
        feature_policy_snapshot_json:source.feature_policy_snapshot_json,scope_allowlist_json:source.scope_allowlist_json,
        period_kind:'one_off',period_start:start,period_end:item.expiresAt,state:mode === 'append' ? 'scheduled' : 'active',
        team_seat_id:null,created_at:now.toISOString(),cancelled_at:null,cancelled_reason:null,notes:input.reason};
      changes.push({table:'entitlements',id:renewedId,before:null,after:row});
    }
    for (const [table,rows] of [['access_credentials',credentials],['unified_client_keys',keys]]) {
      for (const row of rows) if (row.expires_at !== null && timestamp(row.expires_at) < end) changes.push(change(table,row,{expires_at:item.expiresAt}));
    }
    return {subject_id:item.subjectId,plan_id:source.plan_id,source_entitlement_id:source.id,renewed_entitlement_id:renewedId,
      old_end:source.period_end,new_end:item.expiresAt,start,mode,before_hash:state.revision,changes};
  });
}
function assessUndo(db,input,now) {
  const receipt=readAudit(db,auditId(input.renewalOperationId));
  check(receipt?.format === FORMAT && receipt.kind === 'renew', 'Renewal receipt not found');
  return input.subjectIds.map(subjectId => {
    const account=receipt.accounts.find(a => a.subject_id === subjectId);
    check(account, 'Account is outside the original renewal');
    check(!readAudit(db,undoneId(input.renewalOperationId,subjectId)), 'Account renewal was already undone');
    check(accountState(db,subjectId).revision === account.after_hash, 'Account changed after renewal; targeted undo requires reconciliation');
    if (account.mode === 'extend_scheduled') check(timestamp(account.old_end) > now.getTime(), 'The extended interval has already begun');
    // Even zero-token calls/reservations may have delivered service. Never undo spent rights.
    check(!db.prepare('SELECT 1 FROM entitlement_token_windows WHERE entitlement_id=? AND (total_tokens<>0 OR requests<>0) LIMIT 1').get(account.renewed_entitlement_id) &&
      !db.prepare('SELECT 1 FROM token_reservations WHERE entitlement_id=? LIMIT 1').get(account.renewed_entitlement_id), 'Renewed entitlement has usage or reservations; automatic undo refused');
    const changes=[...account.changes].reverse().map(c => c.before === null ?
      change('entitlements',c.after,{state:'cancelled',cancelled_at:now.toISOString(),cancelled_reason:input.reason}) :
      {table:c.table,id:c.id,before:c.after,after:c.before});
    return {...account,mode:'undo',old_end:account.new_end,new_end:account.old_end,before_hash:account.after_hash,changes};
  });
}
function applyChange(db, entry) {
  check(Object.hasOwn(TABLE_FIELDS,entry.table) && id(entry.id), 'Invalid recovery table or ID');
  if (entry.before === null) {
    check(entry.table === 'entitlements' && ENTITLEMENT_FIELDS.every(k => Object.hasOwn(entry.after,k)) && Object.keys(entry.after).length === ENTITLEMENT_FIELDS.length, 'Invalid entitlement journal');
    db.prepare(`INSERT INTO entitlements (${ENTITLEMENT_FIELDS.join(',')}) VALUES (${ENTITLEMENT_FIELDS.map(() => '?').join(',')})`)
      .run(...ENTITLEMENT_FIELDS.map(k => entry.after[k]));
  } else {
    const fields=Object.keys(entry.after);
    check(fields.length && fields.every(k => TABLE_FIELDS[entry.table].includes(k)) && hash(fields.sort()) === hash(Object.keys(entry.before).sort()), 'Invalid recovery fields');
    const result=db.prepare(`UPDATE ${entry.table} SET ${fields.map(k => k+'=?').join(',')} WHERE id=? AND ${fields.map(k => k+' IS ?').join(' AND ')}`)
      .run(...fields.map(k => entry.after[k]),entry.id,...fields.map(k => entry.before[k]));
    check(result.changes === 1, 'Expected exactly one account record update');
  }
  const actual=db.prepare(`SELECT * FROM ${entry.table} WHERE id=?`).get(entry.id);
  check(actual && Object.entries(entry.after).every(([k,v]) => actual[k] === v), 'Account change readback failed');
}
function publicAccounts(accounts) {
  return accounts.map(a => ({subject_id:a.subject_id,plan_id:a.plan_id,entitlement_id:a.renewed_entitlement_id,
    old_end:a.old_end,new_end:a.new_end,mode:a.mode,credential_updates:a.changes.filter(c => c.table === 'access_credentials').length,
    unified_key_updates:a.changes.filter(c => c.table === 'unified_client_keys').length}));
}
function runAccountOperation(db,input,now=new Date()) {
  validateInput(input);
  check(db.prepare('PRAGMA foreign_keys').get().foreign_keys === 1, 'Foreign key enforcement is required');
  const digest=requestHash(input), key=auditId(input.operationId);
  db.exec(input.apply ? 'BEGIN IMMEDIATE' : 'BEGIN');
  try {
    const previous=readAudit(db,key);
    if (previous) {
      check(previous.format === FORMAT && previous.request_hash === digest, 'Operation ID was reused with different arguments');
      for (const a of previous.accounts) {
        check(input.kind !== 'renew' || !readAudit(db,undoneId(input.operationId,a.subject_id)), 'This renewal was undone; use a new operation ID');
        check(accountState(db,a.subject_id).revision === a.after_hash, 'Operation already committed but account state has since changed; inspect its receipt');
      }
      db.exec('ROLLBACK');
      return {...previous.result,replayed:true};
    }
    const accounts=input.kind === 'renew' ? assessRenewal(db,input,now) : assessUndo(db,input,now);
    const revision=hash({request_hash:digest,accounts:accounts.map(a => ({subject_id:a.subject_id,revision:a.before_hash}))});
    const result={operation_id:input.operationId,kind:input.kind,count:accounts.length,revision,applied:input.apply,
      protection:'transaction_and_scoped_journal',accounts:publicAccounts(accounts)};
    if (!input.apply) { db.exec('ROLLBACK'); return result; }
    check(input.expectedRevision === revision, 'Preview revision missing or changed; preview the same manifest again');
    for (const account of accounts) {
      for (const entry of account.changes) applyChange(db,entry);
      account.after_hash=accountState(db,account.subject_id).revision;
      const event={format:FORMAT,operation_id:input.operationId,kind:input.kind,reason:input.reason,...account};
      insertAudit(db,key+'_'+hash(account.subject_id).slice(0,16),account.subject_id,event,now,input.kind === 'undo' ? 'entitlement-cancel' : 'entitlement-renew');
      if (input.kind === 'undo') insertAudit(db,undoneId(input.renewalOperationId,account.subject_id),account.subject_id,
        {format:FORMAT,renewal_operation_id:input.renewalOperationId,undo_operation_id:input.operationId},now,'entitlement-cancel');
    }
    result.audit_id=key;
    insertAudit(db,key,null,{format:FORMAT,kind:input.kind,request_hash:digest,reason:input.reason,accounts,result},now);
    db.exec('COMMIT');
    return result;
  } catch(error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
module.exports={runAccountOperation,accountState};
if (globalThis.R760_ACCOUNT_OPERATION) {
  const input=globalThis.R760_ACCOUNT_OPERATION;
  const db=new DatabaseSync('/var/lib/codex-gateway/gateway.db',{readOnly:!input.apply});
  try {
    db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=10000');
    if (!input.apply) db.exec('PRAGMA query_only=ON');
    console.log(JSON.stringify(runAccountOperation(db,input)));
  } finally { db.close(); }
}
