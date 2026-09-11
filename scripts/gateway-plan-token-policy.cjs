// Invoked only by the R760 control wrapper after its verified online backup.
const { DatabaseSync } = require('node:sqlite');
const { createHash, randomUUID } = require('node:crypto');

function tokenLimitValue(value, field) {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid ${field} token value`);
  return value;
}

function changePlanTokenPolicy(db, input) {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(input.planId) ||
      typeof input.apply !== 'boolean') throw new Error('Invalid plan policy operation');
  const expectedMonthly = tokenLimitValue(input.expected, 'monthly');
  const monthly = tokenLimitValue(input.monthly, 'monthly');
  const hasDaily = input.daily !== undefined || input.expectedDaily !== undefined;
  if (hasDaily && (input.daily === undefined || input.expectedDaily === undefined)) {
    throw new Error('Daily policy changes require both the expected and the new value');
  }
  const expectedDaily = hasDaily ? tokenLimitValue(input.expectedDaily, 'daily') : undefined;
  const daily = hasDaily ? tokenLimitValue(input.daily, 'daily') : undefined;
  db.exec(input.apply ? 'BEGIN IMMEDIATE' : 'BEGIN');
  try {
    const before = db.prepare('SELECT * FROM plans WHERE id = ?').get(input.planId);
    if (!before || before.state !== 'active') throw new Error('Active plan not found');
    const policy = JSON.parse(before.policy_json);
    if (policy.tokensPerMonth !== expectedMonthly) throw new Error('Monthly policy differs from expected value');
    if (hasDaily && policy.tokensPerDay !== expectedDaily) throw new Error('Daily policy differs from expected value');
    const trigger = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'trg_plans_policy_immutable'").get();
    if (!trigger || trigger.sql.replace(/\s+/g, ' ').trim() !==
        "CREATE TRIGGER trg_plans_policy_immutable BEFORE UPDATE OF policy_json ON plans BEGIN SELECT RAISE(ABORT, 'plans.policy_json is immutable'); END") {
      throw new Error('Unexpected plan immutability trigger');
    }
    const snapshots = () => db.prepare(
      'SELECT id, policy_snapshot_json FROM entitlements WHERE plan_id = ? ORDER BY id'
    ).all(input.planId);
    const digest = (rows) => createHash('sha256').update(JSON.stringify(rows)).digest('hex');
    const existing = snapshots();
    const next = hasDaily
      ? { ...policy, tokensPerMonth: monthly, tokensPerDay: daily }
      : { ...policy, tokensPerMonth: monthly };
    const result = {
      plan_id: input.planId, before: policy, after: next,
      existing_entitlements: existing.length,
      entitlement_snapshots_sha256: digest(existing),
      existing_entitlements_changed: false, applied: input.apply
    };
    if (!input.apply) {
      db.exec('ROLLBACK');
      return result;
    }
    // The write lock prevents other writers from observing this temporary exception.
    // DDL is transactional: any failure also restores the original trigger.
    db.exec('DROP TRIGGER trg_plans_policy_immutable');
    const update = db.prepare(
      'UPDATE plans SET policy_json = ? WHERE id = ? AND policy_json = ? AND state = ?'
    ).run(JSON.stringify(next), input.planId, before.policy_json, 'active');
    if (update.changes !== 1) throw new Error('Expected exactly one plan update');
    db.exec(trigger.sql);
    if (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'trg_plans_policy_immutable'").get()?.sql !== trigger.sql) {
      throw new Error('Plan immutability trigger was not restored');
    }
    const after = db.prepare('SELECT * FROM plans WHERE id = ?').get(input.planId);
    if (JSON.stringify(after) !== JSON.stringify({ ...before, policy_json: JSON.stringify(next) }) ||
        digest(snapshots()) !== result.entitlement_snapshots_sha256) {
      throw new Error('Post-write plan or entitlement verification failed');
    }
    const auditId = `audit_${randomUUID().replaceAll('-', '')}`;
    db.prepare(`INSERT INTO admin_audit_events
      (id, action, status, params_json, created_at) VALUES (?, ?, ?, ?, ?)`
    ).run(auditId, 'plan-token-policy-update', 'success', JSON.stringify(result), new Date().toISOString());
    db.exec('COMMIT');
    return { ...result, audit_id: auditId };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

module.exports = { changePlanTokenPolicy };
if (process.env.R760_PLAN_OPERATION_B64) {
  const input = JSON.parse(Buffer.from(process.env.R760_PLAN_OPERATION_B64, 'base64').toString('utf8'));
  const db = new DatabaseSync('/var/lib/codex-gateway/gateway.db', { readOnly: !input.apply });
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 10000');
  if (!input.apply) db.exec('PRAGMA query_only = ON');
  try {
    console.log(JSON.stringify(changePlanTokenPolicy(db, input)));
  } finally {
    db.close();
  }
}
