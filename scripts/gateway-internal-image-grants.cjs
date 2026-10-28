// Reviewed batch through the R760 wrapper: one backup, one transaction, no key disclosure.
const { DatabaseSync } = require('node:sqlite');
const { createHash, randomUUID } = require('node:crypto');
const { resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const hash = v => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const PLAN = 'plan_internal_high_quota_image_v1';

async function grantInternalImages(db, input) {
  if (input.version !== 1 || typeof input.apply !== 'boolean' || !input.reason?.trim() ||
      input.reason.length > 500 || !Array.isArray(input.targets) || !input.targets.length || input.targets.length > 100 ||
      (input.apply && !/^[a-f0-9]{64}$/.test(input.expectedRevision))) throw new Error('Invalid reviewed batch');
  const ids = input.targets.map(t => t.subjectId);
  if (new Set(ids).size !== ids.length || ids.some(id => !/^[A-Za-z0-9_-]{1,128}$/.test(id))) throw new Error('Invalid or duplicate subject');
  const moduleAt = file => import(pathToFileURL(resolve('packages/store-sqlite/dist', file)).href);
  const [plansApi, grantsApi, credentialsApi] = await Promise.all([
    moduleAt('plans.js'), moduleAt('entitlements.js'), moduleAt('access-credentials.js')
  ]);
  const now = new Date(), at = now.toISOString();
  db.exec(input.apply ? 'BEGIN IMMEDIATE' : 'BEGIN');
  try {
    const plan = plansApi.get(db, PLAN);
    if (plan?.state !== 'active' || plan.policy.tokensPerDay !== 50000000 ||
        plan.policy.tokensPerMonth !== 500000000 || !plan.featurePolicy.capabilities.includes('image_generation') ||
        !plan.featurePolicy.imageGeneration.enabled) throw new Error('Unexpected target plan');
    const reviewed = input.targets.map(t => {
      if (new Date(t.periodEnd).toISOString() !== t.periodEnd || t.periodEnd <= at) throw new Error('Invalid end date');
      const subject = db.prepare('SELECT id,state FROM subjects WHERE id=?').get(t.subjectId);
      const es = db.prepare("SELECT * FROM entitlements WHERE subject_id=? AND state IN ('active','paused','scheduled') AND (period_end IS NULL OR period_end>?) ORDER BY id").all(t.subjectId, at);
      if (subject?.state !== 'active' || es.length !== (t.expectedEntitlementId ? 1 : 0) ||
          (es.length && (es[0].id !== t.expectedEntitlementId || es[0].plan_id !== t.expectedPlanId || es[0].state !== 'active' || es[0].period_start > at ||
            !['plan_free_once_1m_v1','plan_gift_once_20m_v1'].includes(es[0].plan_id)))) throw new Error('Source entitlement differs from review');
      if (db.prepare('SELECT COUNT(*) n FROM token_reservations WHERE subject_id=? AND finalized_at IS NULL').get(t.subjectId).n) throw new Error('Unfinished requests; retry after settlement');
      const keys = db.prepare('SELECT id,expires_at,revoked_at,credential_class,codex_credential_id,token_ciphertext IS NOT NULL AS recoverable FROM unified_client_keys WHERE subject_id=? AND is_current=1').all(t.subjectId);
      if (keys.length !== 1 || keys[0].revoked_at || keys[0].credential_class !== 'desktop' || !keys[0].recoverable || keys[0].expires_at < t.periodEnd) throw new Error('Current key does not cover grant');
      const key = keys[0];
      const credential = db.prepare('SELECT id,subject_id,expires_at,revoked_at,scope,credential_class,rate_json FROM access_credentials WHERE id=?').get(key.codex_credential_id);
      if (!credential || credential.subject_id !== t.subjectId || credential.revoked_at || credential.scope !== 'code' || credential.credential_class !== 'desktop') throw new Error('Backing credential mismatch');
      if (credential.expires_at < t.periodEnd && (!t.credentialExtension || t.credentialExtension.id !== credential.id ||
          t.credentialExtension.expectedExpiresAt !== credential.expires_at || credential.expires_at > at)) throw new Error('Explicit expired credential renewal required');
      const identity = db.prepare('SELECT state,unified_key_id FROM phone_auth_identities WHERE subject_id=?').get(t.subjectId);
      if (identity?.state !== 'active' || identity.unified_key_id !== key.id) throw new Error('Phone identity mismatch');
      return { target: t, subject, entitlements: es, key, credential };
    });
    const revision = hash({ plan, reviewed });
    if (input.expectedRevision !== undefined && input.expectedRevision !== revision) throw new Error('Batch changed since preview');
    const result = { applied: input.apply, revision, count: reviewed.length,
      usage_carried: reviewed.filter(v => v.entitlements.length).length,
      expired_credentials_renewed: reviewed.filter(v => v.credential.expires_at < v.target.periodEnd).length };
    if (!input.apply) { db.exec('ROLLBACK'); return result; }
    const changes = [];
    for (const item of reviewed) {
      const t = item.target;
      const entitlement = grantsApi.grantInTransaction(db, { subjectId: t.subjectId, planId: PLAN,
        periodKind: 'one_off', periodStart: now, periodEnd: new Date(t.periodEnd),
        replace: true, carryCurrentUsage: !!t.expectedEntitlementId, notes: input.reason, now }, {
        getPlan: id => plansApi.get(db, id), listAccessCredentials: args => credentialsApi.list(db, args)
      }, now);
      if (item.credential.expires_at < t.periodEnd) {
        if (db.prepare('UPDATE access_credentials SET expires_at=? WHERE id=? AND expires_at=? AND revoked_at IS NULL')
          .run(t.periodEnd, item.credential.id, item.credential.expires_at).changes !== 1) throw new Error('Credential renewal failed');
        db.prepare('INSERT INTO admin_audit_events (id,action,target_user_id,status,params_json,created_at) VALUES (?,?,?,?,?,?)')
          .run(`audit_${randomUUID().replaceAll('-', '')}`, 'update-key', t.subjectId, 'success',
            JSON.stringify({ operation: 'grant-internal-image-batch', reason: input.reason,
              credential_id: item.credential.id, expires_before: item.credential.expires_at, expires_after: t.periodEnd }), at);
      }
      if (t.expectedEntitlementId) {
        const windows = id => db.prepare('SELECT window_kind,window_start,prompt_tokens,completion_tokens,total_tokens,cached_prompt_tokens,estimated_tokens,requests,updated_at FROM entitlement_token_windows WHERE entitlement_id=? ORDER BY window_kind,window_start').all(id);
        if (hash(windows(t.expectedEntitlementId)) !== hash(windows(entitlement.id))) throw new Error('Usage carry check failed');
      }
      changes.push({ subject_id: t.subjectId, previous_entitlement_id: t.expectedEntitlementId,
        entitlement_id: entitlement.id, plan_id: PLAN, period_end: t.periodEnd,
        credential_expiry_before: item.credential.expires_at,
        credential_expiry_after: item.credential.expires_at < t.periodEnd ? t.periodEnd : item.credential.expires_at });
    }
    const auditId = `audit_${randomUUID().replaceAll('-', '')}`;
    db.prepare('INSERT INTO admin_audit_events (id,action,status,params_json,created_at) VALUES (?,?,?,?,?)')
      .run(auditId, 'entitlement-grant', 'success', JSON.stringify({ ...result,
        operation: 'grant-internal-image-batch', reason: input.reason, changes }), at);
    db.exec('COMMIT');
    return { ...result, audit_id: auditId, changes, completed_at: at };
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
module.exports = { grantInternalImages };
if (process.env.R760_INTERNAL_IMAGE_GRANTS_B64) {
  const input = JSON.parse(Buffer.from(process.env.R760_INTERNAL_IMAGE_GRANTS_B64, 'base64').toString('utf8'));
  const db = new DatabaseSync('/var/lib/codex-gateway/gateway.db', { readOnly: !input.apply });
  db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=10000');
  if (!input.apply) db.exec('PRAGMA query_only=ON');
  grantInternalImages(db, input).then(r => console.log(JSON.stringify(r)))
    .catch(e => { console.error(e.message); process.exitCode = 1; }).finally(() => db.close());
}
