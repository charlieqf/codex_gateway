// Invoked by manage-r760-gateway-control.py after its verified backup.
// Extends existing recoverable phone-login keys without issuing or revealing tokens.
const { DatabaseSync } = require('node:sqlite');
const { randomUUID } = require('node:crypto');

function timestamp(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) ||
      new Date(value).toISOString() !== value) throw new Error('Expected canonical UTC timestamp');
  return Date.parse(value);
}

function extendUnifiedKeyExpiry(db, input, now = new Date()) {
  if (input?.version !== 1 || typeof input.apply !== 'boolean' ||
      typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 500 ||
      !Array.isArray(input.items) || input.items.length < 1 || input.items.length > 100) {
    throw new Error('Invalid unified key expiry plan');
  }
  const keyIds = new Set(), subjectIds = new Set();
  for (const item of input.items) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(item.subjectId ?? '') ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(item.keyId ?? '') ||
        keyIds.has(item.keyId) || subjectIds.has(item.subjectId)) throw new Error('Invalid or duplicate target');
    keyIds.add(item.keyId); subjectIds.add(item.subjectId);
    const oldEnd = timestamp(item.expectedExpiresAt), newEnd = timestamp(item.expiresAt);
    if (oldEnd <= now.getTime() || newEnd <= oldEnd) throw new Error('Only extend an unexpired key');
  }
  db.exec(input.apply ? 'BEGIN IMMEDIATE' : 'BEGIN');
  try {
    // Validate every target under the same lock before changing any target.
    const changes = input.items.map(item => {
      const subject = db.prepare('SELECT state FROM subjects WHERE id=?').get(item.subjectId);
      const key = db.prepare(`SELECT id,subject_id,expires_at,revoked_at,is_current,credential_class,
        token_ciphertext IS NOT NULL AS recoverable,codex_credential_id,codex_credential_prefix
        FROM unified_client_keys WHERE id=?`).get(item.keyId);
      if (subject?.state !== 'active' || !key || key.subject_id !== item.subjectId ||
          key.expires_at !== item.expectedExpiresAt || key.revoked_at !== null ||
          key.is_current !== 1 || key.credential_class !== 'desktop' || !key.recoverable) {
        throw new Error(`Current key differs from expected state: ${item.subjectId}`);
      }
      if (db.prepare('SELECT COUNT(*) AS n FROM unified_client_keys WHERE subject_id=? AND is_current=1')
          .get(item.subjectId).n !== 1) throw new Error('Expected one current key');
      const credential = db.prepare('SELECT subject_id,prefix,expires_at,revoked_at,scope,credential_class FROM access_credentials WHERE id=?')
        .get(key.codex_credential_id);
      if (!credential || credential.subject_id !== item.subjectId || credential.prefix !== key.codex_credential_prefix ||
          credential.revoked_at !== null || credential.scope !== 'code' || credential.credential_class !== 'desktop' ||
          timestamp(credential.expires_at) < timestamp(item.expiresAt)) throw new Error('Backing credential does not cover extension');
      const identity = db.prepare('SELECT state,unified_key_id FROM phone_auth_identities WHERE subject_id=?').get(item.subjectId);
      if (identity?.state !== 'active' || identity.unified_key_id !== item.keyId) throw new Error('Phone identity differs from current key');
      const entitlements = db.prepare(`SELECT e.period_start,e.period_end,e.scope_allowlist_json,e.feature_policy_snapshot_json
        FROM entitlements e JOIN plans p ON p.id=e.plan_id WHERE e.subject_id=?
        AND e.state IN ('active','scheduled') AND p.state='active'`).all(item.subjectId);
      const intervals = entitlements.filter(e => JSON.parse(e.scope_allowlist_json).includes('code') &&
        JSON.parse(e.feature_policy_snapshot_json).capabilities?.includes('chat')).map(e => ({
          start: timestamp(e.period_start), end: e.period_end === null ? Infinity : timestamp(e.period_end)
        })).sort((a,b) => a.start-b.start);
      let coveredUntil = now.getTime();
      for (const interval of intervals) {
        if (interval.start > coveredUntil) break;
        coveredUntil = Math.max(coveredUntil, interval.end);
      }
      if (coveredUntil < timestamp(item.expiresAt)) throw new Error('Chat entitlement coverage has a gap or ends too soon');
      return { subject_id:item.subjectId,unified_key_id:item.keyId,
        old_expires_at:key.expires_at,new_expires_at:item.expiresAt };
    });
    if (!input.apply) {
      db.exec('ROLLBACK');
      return { applied:false,count:changes.length,changes };
    }
    const auditIds=[];
    for (const change of changes) {
      const updated = db.prepare(`UPDATE unified_client_keys SET expires_at=?
        WHERE id=? AND subject_id=? AND expires_at=? AND is_current=1 AND revoked_at IS NULL`)
        .run(change.new_expires_at,change.unified_key_id,change.subject_id,change.old_expires_at);
      if (updated.changes !== 1) throw new Error('Expected exactly one key update');
      const auditId=`audit_${randomUUID().replaceAll('-','')}`;
      db.prepare(`INSERT INTO admin_audit_events (id,action,target_user_id,status,params_json,created_at)
        VALUES (?,'update-key',?,'ok',?,?)`).run(auditId,change.subject_id,
          JSON.stringify({operation:'extend-unified-key-expiry',credential_kind:'unified',reason:input.reason,...change}),now.toISOString());
      auditIds.push(auditId);
      if (db.prepare('SELECT expires_at FROM unified_client_keys WHERE id=?').get(change.unified_key_id)?.expires_at !== change.new_expires_at) {
        throw new Error('Unified key expiry readback failed');
      }
    }
    db.exec('COMMIT');
    return {applied:true,count:changes.length,changes,audit_ids:auditIds,applied_at:now.toISOString()};
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

module.exports={extendUnifiedKeyExpiry};
if (process.env.R760_UNIFIED_EXPIRY_B64) {
  const input=JSON.parse(Buffer.from(process.env.R760_UNIFIED_EXPIRY_B64,'base64').toString('utf8'));
  const db=new DatabaseSync('/var/lib/codex-gateway/gateway.db',{readOnly:!input.apply});
  db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=10000');
  if (!input.apply) db.exec('PRAGMA query_only=ON');
  try { console.log(JSON.stringify(extendUnifiedKeyExpiry(db,input))); } finally { db.close(); }
}
