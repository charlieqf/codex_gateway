// Use only through manage-r760-gateway-control.py and its verified online backup.
// Existing grant --replace cancels non-retail entitlements. This narrow operation
// adds a reviewed lifetime gift without touching any existing entitlement/usage.
const { DatabaseSync } = require('node:sqlite');
const { createHash, randomUUID } = require('node:crypto');
const hash = text => createHash('sha256').update(text).digest('hex');
const free = e => e.period_kind === 'unlimited' && e.period_end === null &&
  (e.plan_id.startsWith('plan_gift_once_') || ['plan_free_once_1m_v1','plan_free_once_fixture_v1','plan_free_daily_100k_v1','plan_free_daily_10k_v1','plan_free_daily_1m_v1'].includes(e.plan_id));

function grantExtraGift(db, input) {
  if (input.version !== 1 || typeof input.apply !== 'boolean' ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(input.subjectId ?? '') ||
      !/^plan_gift_once_[A-Za-z0-9_]{1,100}$/.test(input.planId ?? '') ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(input.operationId ?? '') ||
      !/^[a-f0-9]{64}$/.test(input.expectedPlanHash ?? '') ||
      !/^[a-f0-9]{64}$/.test(input.expectedEntitlementsHash ?? '') ||
      !Number.isSafeInteger(input.tokens) || input.tokens < 1 || input.tokens > 1000000000 ||
      typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 500) throw new Error('Invalid extra gift plan');
  db.exec(input.apply ? 'BEGIN IMMEDIATE' : 'BEGIN');
  try {
    const now = new Date().toISOString();
    const entitlementId = 'ent_gift_' + hash(input.operationId + ':' + input.subjectId).slice(0,32);
    if (db.prepare('SELECT 1 FROM entitlements WHERE id=?').get(entitlementId)) throw new Error('Gift operation already applied');
    if (db.prepare('SELECT state FROM subjects WHERE id=?').get(input.subjectId)?.state !== 'active') throw new Error('Active subject required');
    const plan = db.prepare('SELECT * FROM plans WHERE id=?').get(input.planId);
    if (!plan || plan.state !== 'active' || hash(JSON.stringify(plan)) !== input.expectedPlanHash) throw new Error('Gift template changed since review');
    const policy = JSON.parse(plan.policy_json);
    if (policy.tokensTotal !== input.tokens || policy.tokensPerDay != null || policy.tokensPerMonth != null) throw new Error('Lifetime gift policy required');
    const before = db.prepare('SELECT * FROM entitlements WHERE subject_id=? ORDER BY id').all(input.subjectId);
    if (hash(JSON.stringify(before)) !== input.expectedEntitlementsHash) throw new Error('Entitlements changed since review');
    const live = before.filter(e => ['active','paused','scheduled'].includes(e.state) && (e.period_end === null || e.period_end > now));
    if (!live.some(e => e.state === 'active' && e.period_start <= now && !free(e)) || live.some(free)) throw new Error('Requires existing non-free rights and no live free/gift allowance');
    if (db.prepare('SELECT 1 FROM token_reservations WHERE subject_id=? AND finalized_at IS NULL LIMIT 1').get(input.subjectId)) throw new Error('Unfinished reservations exist');
    const scopes = JSON.parse(plan.scope_allowlist_json);
    if (!Array.isArray(scopes) || !scopes.includes('code')) throw new Error('Code gift required');
    const result = { applied: input.apply, subject_id: input.subjectId, plan_id: input.planId,
      entitlement_id: entitlementId, tokens_added: input.tokens, existing_entitlements_preserved: before.length };
    if (!input.apply) { db.exec('ROLLBACK'); return result; }
    db.prepare(`INSERT INTO entitlements
      (id,subject_id,plan_id,policy_snapshot_json,feature_policy_snapshot_json,scope_allowlist_json,
       period_kind,period_start,period_end,state,team_seat_id,created_at,cancelled_at,cancelled_reason,notes)
      VALUES (?,?,?,?,?,?,'unlimited',?,NULL,'active',NULL,?,NULL,NULL,?)`)
      .run(entitlementId,input.subjectId,input.planId,plan.policy_json,plan.feature_policy_json,plan.scope_allowlist_json,now,now,input.reason);
    db.prepare(`INSERT INTO admin_audit_events (id,action,target_user_id,status,params_json,created_at)
      VALUES (?,'entitlement-grant',?,'success',?,?)`).run('audit_'+randomUUID().replaceAll('-',''),input.subjectId,
        JSON.stringify({operation:'grant-extra-gift',operation_id:input.operationId,entitlement_id:entitlementId,
          plan_id:input.planId,tokens_added:input.tokens,reason:input.reason,existing_entitlements_sha256:input.expectedEntitlementsHash}),now);
    const retained = db.prepare('SELECT * FROM entitlements WHERE subject_id=? AND id<>? ORDER BY id').all(input.subjectId,entitlementId);
    if (JSON.stringify(retained) !== JSON.stringify(before)) throw new Error('Existing entitlement preservation failed');
    db.exec('COMMIT'); return result;
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
module.exports = { grantExtraGift, hash };
if (process.env.R760_EXTRA_GIFT_B64) {
  const input = JSON.parse(Buffer.from(process.env.R760_EXTRA_GIFT_B64, 'base64').toString('utf8'));
  const db = new DatabaseSync(process.env.GATEWAY_SQLITE_PATH, { readOnly: !input.apply });
  db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  if (!input.apply) db.exec('PRAGMA query_only=ON');
  try { console.log(JSON.stringify(grantExtraGift(db,input))); } finally { db.close(); }
}
