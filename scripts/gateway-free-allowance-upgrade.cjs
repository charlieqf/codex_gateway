// Run only through manage-r760-gateway-control.py after its verified backup.
// Preserve the public Plan ID: signup and existing clients resolve this ID.
const { DatabaseSync } = require('node:sqlite');
const { createHash, randomUUID } = require('node:crypto');
const planId = 'plan_free_once_1m_v1';
const hash = value => createHash('sha256').update(value).digest('hex');

function eligibleFree(db, now) {
  return db.prepare(`SELECT e.* FROM entitlements e JOIN subjects s ON s.id=e.subject_id
    WHERE s.state='active' AND e.plan_id=? AND e.state='active'
      AND e.period_kind='unlimited' AND e.period_end IS NULL AND e.period_start<=?
      AND NOT EXISTS (SELECT 1 FROM entitlements o WHERE o.subject_id=e.subject_id
        AND o.id<>e.id AND o.state IN ('active','paused','scheduled')
        AND (o.period_end IS NULL OR o.period_end>?)) ORDER BY e.id`).all(planId, now, now);
}

function upgradeFreeAllowance(db, input) {
  if (input.version !== 1 || typeof input.apply !== 'boolean' ||
      !Number.isSafeInteger(input.expectedTotal) || input.expectedTotal < 1 ||
      !Number.isSafeInteger(input.total) || input.total <= input.expectedTotal ||
      typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 500 ||
      !/^[a-f0-9]{64}$/.test(input.expectedPlanHash) ||
      !Array.isArray(input.targets) || input.targets.length === 0 || input.targets.length > 10000) {
    throw new Error('Invalid Free allowance upgrade');
  }
  const ids = new Set();
  for (const t of input.targets) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(t.entitlementId) ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(t.subjectId) ||
        !/^[a-f0-9]{64}$/.test(t.expectedSnapshotHash) ||
        !Number.isSafeInteger(t.expectedUsed) || t.expectedUsed < 0 || ids.has(t.entitlementId)) {
      throw new Error('Invalid or duplicate upgrade target');
    }
    ids.add(t.entitlementId);
  }
  db.exec(input.apply ? 'BEGIN IMMEDIATE' : 'BEGIN');
  try {
    const now = new Date().toISOString();
    const plan = db.prepare('SELECT * FROM plans WHERE id=?').get(planId);
    if (!plan || plan.state !== 'active' || hash(plan.policy_json) !== input.expectedPlanHash) {
      throw new Error('Plan changed since review');
    }
    const policy = JSON.parse(plan.policy_json);
    if (policy.tokensTotal !== input.expectedTotal || policy.tokensPerDay !== null || policy.tokensPerMonth !== null) {
      throw new Error('Expected lifetime Free policy not found');
    }
    const cohort = eligibleFree(db, now);
    if (cohort.length !== ids.size || cohort.some(e => !ids.has(e.id))) {
      throw new Error('Free-only cohort changed since review');
    }
    const reviewed = new Map(input.targets.map(t => [t.entitlementId, t]));
    const changes = cohort.map(e => {
      const t = reviewed.get(e.id);
      const snapshot = JSON.parse(e.policy_snapshot_json);
      if (t.subjectId !== e.subject_id || hash(e.policy_snapshot_json) !== t.expectedSnapshotHash ||
          snapshot.tokensTotal !== input.expectedTotal || snapshot.tokensPerDay !== null || snapshot.tokensPerMonth !== null) {
        throw new Error('Entitlement changed since review');
      }
      if (db.prepare('SELECT 1 FROM token_reservations WHERE subject_id=? AND finalized_at IS NULL LIMIT 1').get(e.subject_id)) {
        throw new Error('quota_reset_conflict: unfinished reservations exist');
      }
      const ledgers = db.prepare("SELECT * FROM entitlement_token_windows WHERE entitlement_id=? AND window_kind='period'").all(e.id);
      if (ledgers.length > 1 || (ledgers[0] && ledgers[0].window_start !== e.period_start) ||
          (ledgers[0]?.total_tokens ?? 0) !== t.expectedUsed) throw new Error('Free usage changed since review');
      return { before: e, ledger: ledgers[0] ?? null, after: { ...e,
        policy_snapshot_json: JSON.stringify({ ...snapshot, tokensTotal: input.total }) } };
    });
    const trigger = db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='trg_plans_policy_immutable'").get();
    if (trigger?.sql.replace(/\s+/g, ' ').trim() !==
        "CREATE TRIGGER trg_plans_policy_immutable BEFORE UPDATE OF policy_json ON plans BEGIN SELECT RAISE(ABORT, 'plans.policy_json is immutable'); END") {
      throw new Error('Unexpected plan immutability trigger');
    }
    const untouched = () => hash(JSON.stringify(db.prepare('SELECT * FROM entitlements ORDER BY id').all().filter(e => !ids.has(e.id))));
    const otherHash = untouched();
    const next = { ...plan, display_name: `Free · ${input.total.toLocaleString('en-US')} tokens once`,
      policy_json: JSON.stringify({ ...policy, tokensTotal: input.total }) };
    const result = { applied: input.apply, plan_id: planId, total_before: input.expectedTotal,
      total_after: input.total, users: changes.length, users_with_usage: changes.filter(c => (c.ledger?.total_tokens ?? 0) > 0).length,
      total_used_reset: changes.reduce((n, c) => n + (c.ledger?.total_tokens ?? 0), 0),
      remaining_per_user: input.total, other_entitlements_sha256: otherHash,
      historical_requests_preserved: true, non_lifetime_windows_preserved: true };
    if (!input.apply) { db.exec('ROLLBACK'); return result; }
    const audit = db.prepare(`INSERT INTO admin_audit_events
      (id,action,target_user_id,status,params_json,created_at) VALUES (?,?,?,?,?,?)`);
    const operationId = `audit_${randomUUID().replaceAll('-', '')}`;
    db.exec('DROP TRIGGER trg_plans_policy_immutable');
    if (db.prepare('UPDATE plans SET policy_json=?,display_name=? WHERE id=? AND policy_json=?')
      .run(next.policy_json, next.display_name, planId, plan.policy_json).changes !== 1) throw new Error('Plan update failed');
    db.exec(trigger.sql);
    for (const c of changes) {
      if (db.prepare('UPDATE entitlements SET policy_snapshot_json=? WHERE id=? AND policy_snapshot_json=?')
        .run(c.after.policy_snapshot_json, c.before.id, c.before.policy_snapshot_json).changes !== 1) {
        throw new Error('Entitlement update failed');
      }
      if (c.ledger) {
        if (db.prepare("DELETE FROM entitlement_token_windows WHERE entitlement_id=? AND window_kind='period' AND window_start=? AND total_tokens=?")
          .run(c.before.id, c.before.period_start, c.ledger.total_tokens).changes !== 1) throw new Error('Lifetime reset failed');
      }
      audit.run(`audit_${randomUUID().replaceAll('-', '')}`, 'quota-reset', c.before.subject_id, 'ok',
        JSON.stringify({ operation: 'upgrade-free-allowance', operation_id: operationId, reason: input.reason,
          entitlement_before: c.before, entitlement_after: c.after, ledger_before: c.ledger,
          used_after: 0, remaining_after: input.total }), now);
      if (JSON.stringify(db.prepare('SELECT * FROM entitlements WHERE id=?').get(c.before.id)) !== JSON.stringify(c.after) ||
          db.prepare("SELECT 1 FROM entitlement_token_windows WHERE entitlement_id=? AND window_kind='period'").get(c.before.id)) {
        throw new Error('Post-write entitlement validation failed');
      }
    }
    if (untouched() !== otherHash || JSON.stringify(db.prepare('SELECT * FROM plans WHERE id=?').get(planId)) !== JSON.stringify(next) ||
        db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='trg_plans_policy_immutable'").get()?.sql !== trigger.sql) {
      throw new Error('Post-write policy validation failed');
    }
    audit.run(operationId, 'plan-token-policy-update', null, 'success', JSON.stringify({ ...result,
      reason: input.reason, plan_before: plan, plan_after: next, targets: input.targets }), now);
    db.exec('COMMIT');
    return { ...result, operation_id: operationId, completed_at: now };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

module.exports = { upgradeFreeAllowance, eligibleFree };
if (process.env.R760_FREE_UPGRADE_B64) {
  const input = JSON.parse(Buffer.from(process.env.R760_FREE_UPGRADE_B64, 'base64').toString('utf8'));
  const db = new DatabaseSync('/var/lib/codex-gateway/gateway.db', { readOnly: !input.apply });
  db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=10000');
  if (!input.apply) db.exec('PRAGMA query_only=ON');
  try { console.log(JSON.stringify(upgradeFreeAllowance(db, input))); } finally { db.close(); }
}
