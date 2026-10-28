// Run through manage-r760-gateway-control.py after a verified online backup.
const { DatabaseSync } = require('node:sqlite');
const { createHash, randomUUID } = require('node:crypto');

const PLAN_IDS = ['plan_internal_high_quota_v1', 'plan_internal_high_quota_image_v1'];
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function raiseInternalDailyLimits(db, input) {
  if (typeof input.apply !== 'boolean' || typeof input.reason !== 'string' ||
      !input.reason.trim() || input.reason.length > 500 ||
      (input.apply && !/^[a-f0-9]{64}$/.test(input.expectedRevision))) {
    throw new Error('Reason and reviewed revision are required');
  }
  db.exec(input.apply ? 'BEGIN IMMEDIATE' : 'BEGIN');
  try {
    const now = new Date().toISOString();
    const readPlans = () => db.prepare('SELECT * FROM plans ORDER BY id').all();
    const readEntitlements = () => db.prepare('SELECT * FROM entitlements ORDER BY id').all();
    // Never load credential hashes, encrypted keys or secret-bearing fields.
    const readCredentials = () => db.prepare('SELECT id,subject_id,rate_json,revoked_at,expires_at FROM access_credentials ORDER BY id').all();
    const plans = readPlans();
    const entitlements = readEntitlements();
    const credentials = readCredentials();
    const selectedPlans = PLAN_IDS.map(id => {
      const plan = plans.find(p => p.id === id && p.state === 'active');
      if (!plan) throw new Error('Active internal plan missing');
      return plan;
    });
    // Include scheduled renewals and paused grants, even for disabled accounts.
    // Cancelled/expired grants remain historical records.
    const eligible = entitlements.filter(e => PLAN_IDS.includes(e.plan_id) &&
      ['active', 'paused', 'scheduled'].includes(e.state) && (!e.period_end || e.period_end > now));
    const internalSubjects = new Set(eligible.map(e => e.subject_id));
    const internalCredentials = credentials.filter(c => internalSubjects.has(c.subject_id) && c.revoked_at === null);
    const revision = hash({ plans: selectedPlans, entitlements: eligible, credentials: internalCredentials });
    if (input.expectedRevision !== undefined && input.expectedRevision !== revision) {
      throw new Error('Internal policies or entitlement cohort changed since preview');
    }
    function change(row, column) {
      const policy = JSON.parse(row[column]);
      if (!Number.isSafeInteger(policy.tokensPerMonth) || policy.tokensPerMonth < 50000000 ||
          ![20000000, 50000000].includes(policy.tokensPerDay)) {
        throw new Error('Expected internal 20m/50m daily and sufficient monthly policy');
      }
      return { before: row, after: { ...row, [column]: JSON.stringify({ ...policy, tokensPerDay: 50000000 }) } };
    }
    const planChanges = selectedPlans.filter(p => JSON.parse(p.policy_json).tokensPerDay !== 50000000)
      .map(p => change(p, 'policy_json'));
    const entitlementChanges = eligible.filter(e => JSON.parse(e.policy_snapshot_json).tokensPerDay !== 50000000)
      .map(e => change(e, 'policy_snapshot_json'));
    // Validate monthly limits even when the daily limit is already 50m.
    selectedPlans.forEach(p => change(p, 'policy_json'));
    eligible.forEach(e => change(e, 'policy_snapshot_json'));
    const credentialChanges = internalCredentials.flatMap(c => {
      const rate = c.rate_json ? JSON.parse(c.rate_json) : null;
      const daily = rate?.token?.tokensPerDay;
      if (daily === null || daily === undefined || (Number.isSafeInteger(daily) && daily >= 50000000)) return [];
      if (daily !== 20000000) throw new Error('Unexpected credential daily override; review separately');
      return [{ before: c, after: { ...c, rate_json: JSON.stringify({ ...rate,
        token: { ...rate.token, tokensPerDay: 50000000 } }) } }];
    });
    const trigger = db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='trg_plans_policy_immutable'").get();
    if (trigger?.sql.replace(/\s+/g, ' ').trim() !==
        "CREATE TRIGGER trg_plans_policy_immutable BEFORE UPDATE OF policy_json ON plans BEGIN SELECT RAISE(ABORT, 'plans.policy_json is immutable'); END") {
      throw new Error('Unexpected plan immutability trigger');
    }
    const result = {
      applied: input.apply, revision, plans_changed: planChanges.length,
      entitlements_changed: entitlementChanges.length,
      subjects_changed: new Set(entitlementChanges.map(c => c.before.subject_id)).size,
      credentials_changed: credentialChanges.length,
      policies: selectedPlans.map(p => ({ plan_id: p.id,
        monthly: JSON.parse(p.policy_json).tokensPerMonth, daily_after: 50000000,
        entitlements_changed: entitlementChanges.filter(c => c.before.plan_id === p.id).length })),
      monthly_limits_preserved: true, usage_preserved: true, credits_preserved: true
    };
    if (!input.apply) { db.exec('ROLLBACK'); return result; }
    if (!planChanges.length && !entitlementChanges.length && !credentialChanges.length) throw new Error('Daily limits are already raised');
    // The write lock covers both templates and snapshots, including restoration
    // of the exact trigger. Any failure rolls back DDL, policy changes and audit.
    db.exec('DROP TRIGGER trg_plans_policy_immutable');
    for (const c of planChanges) {
      if (db.prepare('UPDATE plans SET policy_json=? WHERE id=? AND policy_json=?')
        .run(c.after.policy_json, c.before.id, c.before.policy_json).changes !== 1) throw new Error('Plan update failed');
    }
    db.exec(trigger.sql);
    for (const c of entitlementChanges) {
      if (db.prepare('UPDATE entitlements SET policy_snapshot_json=? WHERE id=? AND policy_snapshot_json=?')
        .run(c.after.policy_snapshot_json, c.before.id, c.before.policy_snapshot_json).changes !== 1) {
        throw new Error('Entitlement update failed');
      }
    }
    for (const c of credentialChanges) {
      if (db.prepare('UPDATE access_credentials SET rate_json=? WHERE id=? AND rate_json=?')
        .run(c.after.rate_json, c.before.id, c.before.rate_json).changes !== 1) throw new Error('Credential update failed');
    }
    const expectedRows = (rows, changes) => {
      const replacements = new Map(changes.map(c => [c.before.id, c.after]));
      return rows.map(row => replacements.get(row.id) ?? row);
    };
    if (hash(readPlans()) !== hash(expectedRows(plans, planChanges)) ||
        hash(readEntitlements()) !== hash(expectedRows(entitlements, entitlementChanges)) ||
        hash(readCredentials()) !== hash(expectedRows(credentials, credentialChanges)) ||
        db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='trg_plans_policy_immutable'").get()?.sql !== trigger.sql) {
      throw new Error('Post-write policy preservation check failed');
    }
    const auditId = `audit_${randomUUID().replaceAll('-', '')}`;
    db.prepare(`INSERT INTO admin_audit_events (id,action,status,params_json,created_at) VALUES (?,?,?,?,?)`)
      .run(auditId, 'plan-token-policy-update', 'success', JSON.stringify({ ...result,
        operation: 'raise-internal-daily-limits', reason: input.reason,
        plans: planChanges, entitlements: entitlementChanges, credentials: credentialChanges }), now);
    db.exec('COMMIT');
    return { ...result, audit_id: auditId, completed_at: now };
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

module.exports = { raiseInternalDailyLimits };
if (process.env.R760_INTERNAL_DAILY_LIMITS_B64) {
  const input = JSON.parse(Buffer.from(process.env.R760_INTERNAL_DAILY_LIMITS_B64, 'base64').toString('utf8'));
  const db = new DatabaseSync('/var/lib/codex-gateway/gateway.db', { readOnly: !input.apply });
  db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=10000');
  if (!input.apply) db.exec('PRAGMA query_only=ON');
  try { console.log(JSON.stringify(raiseInternalDailyLimits(db, input))); } finally { db.close(); }
}
