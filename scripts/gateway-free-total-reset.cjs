// Explicitly authorized one-off Free resets, invoked by the backup/integrity wrapper.
// The Billing day/month reset endpoint does not cover the lifetime period ledger.
const { DatabaseSync } = require('node:sqlite');
const { randomUUID } = require('node:crypto');

function resetFreeTotal(db, input) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.subjectId) ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(input.entitlementId) ||
      !Number.isSafeInteger(input.expectedUsed) || input.expectedUsed < 1 ||
      !Number.isSafeInteger(input.expectedLimit) || input.expectedLimit < 1 ||
      typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 500 ||
      typeof input.apply !== 'boolean') throw new Error('Invalid free total reset operation');
  db.exec(input.apply ? 'BEGIN IMMEDIATE' : 'BEGIN');
  try {
    const subject = db.prepare('SELECT state FROM subjects WHERE id = ?').get(input.subjectId);
    const entitlement = db.prepare('SELECT * FROM entitlements WHERE id = ? AND subject_id = ?')
      .get(input.entitlementId, input.subjectId);
    const now = new Date().toISOString();
    if (subject?.state !== 'active' || !entitlement || entitlement.state !== 'active' ||
        entitlement.plan_id !== 'plan_free_once_1m_v1' || entitlement.period_kind !== 'unlimited' ||
        entitlement.period_end !== null || !Number.isFinite(Date.parse(entitlement.period_start)) ||
        entitlement.period_start > now ||
        JSON.parse(entitlement.policy_snapshot_json).tokensTotal !== input.expectedLimit) {
      throw new Error('Active one-off Free entitlement differs from expected subject/limit');
    }
    // Narrow scope: paid accounts require a separate reviewed recovery operation.
    if (db.prepare("SELECT 1 FROM entitlements WHERE subject_id = ? AND id <> ? AND state IN ('active','paused','scheduled') LIMIT 1")
      .get(input.subjectId, input.entitlementId)) throw new Error('Other live entitlements exist');
    // Include expired reservations: a late settlement must not undo this reset.
    if (db.prepare('SELECT 1 FROM token_reservations WHERE subject_id = ? AND finalized_at IS NULL LIMIT 1')
      .get(input.subjectId)) throw new Error('quota_reset_conflict: unfinished reservations exist');
    const before = db.prepare("SELECT * FROM entitlement_token_windows WHERE entitlement_id = ? AND window_kind = 'period' AND window_start = ?")
      .get(input.entitlementId, entitlement.period_start);
    if (!before || before.total_tokens !== input.expectedUsed) throw new Error('Free usage differs from expected value');
    const result = {
      subject_id: input.subjectId, entitlement_id: input.entitlementId,
      plan_id: entitlement.plan_id, token_windows: ['total'], reason: input.reason,
      limit: input.expectedLimit, used_before: before.total_tokens, used_after: 0,
      remaining_after: input.expectedLimit, ledger_before: before, applied: input.apply,
      historical_requests_preserved: true, historical_reservations_preserved: true,
    };
    if (!input.apply) { db.exec('ROLLBACK'); return result; }
    const deleted = db.prepare("DELETE FROM entitlement_token_windows WHERE entitlement_id = ? AND window_kind = 'period' AND window_start = ? AND total_tokens = ?")
      .run(input.entitlementId, entitlement.period_start, input.expectedUsed);
    if (deleted.changes !== 1) throw new Error('Expected exactly one lifetime ledger reset');
    const auditId = `audit_${randomUUID().replaceAll('-', '')}`;
    db.prepare(`INSERT INTO admin_audit_events (id, action, target_user_id, status, params_json, created_at)
      VALUES (?, 'quota-reset', ?, 'ok', ?, ?)`)
      .run(auditId, input.subjectId, JSON.stringify(result), now);
    if (db.prepare("SELECT 1 FROM entitlement_token_windows WHERE entitlement_id = ? AND window_kind = 'period' AND window_start = ?")
      .get(input.entitlementId, entitlement.period_start)) throw new Error('Lifetime reset verification failed');
    db.exec('COMMIT');
    return { ...result, audit_id: auditId, reset_at: now };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

module.exports = { resetFreeTotal };
if (process.env.R760_FREE_RESET_B64) {
  const input = JSON.parse(Buffer.from(process.env.R760_FREE_RESET_B64, 'base64').toString('utf8'));
  const db = new DatabaseSync('/var/lib/codex-gateway/gateway.db', { readOnly: !input.apply });
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 10000');
  if (!input.apply) db.exec('PRAGMA query_only = ON');
  try { console.log(JSON.stringify(resetFreeTotal(db, input))); } finally { db.close(); }
}
