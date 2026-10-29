// Plan-owned live request benefit; run only through the guarded R760 wrapper.
const { DatabaseSync } = require('node:sqlite');
const { createHash, randomUUID } = require('node:crypto');

const PLAN_IDS = [
  'plan_internal_high_quota_v1',
  'plan_internal_high_quota_image_v1',
  'plan_internal_elevated_quota_image_v1',
  'plan_internal_100m_day_2b_month_image_v1',
  'plan_internal_desktop_test_1b_day_v1',
];
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function raiseInternalRequestFloor(db, input) {
  if (typeof input.apply !== 'boolean' || typeof input.reason !== 'string' ||
      !input.reason.trim() || input.reason.length > 500 ||
      (input.apply && !/^[a-f0-9]{64}$/.test(input.expectedRevision))) {
    throw new Error('Reason and reviewed revision are required');
  }
  db.exec(input.apply ? 'BEGIN IMMEDIATE' : 'BEGIN');
  try {
    const now = new Date().toISOString();
    const readPlans = () => db.prepare('SELECT * FROM plans ORDER BY id').all();
    const plans = readPlans();
    const selected = PLAN_IDS.map(id => {
      const row = plans.find(p => p.id === id && p.state === 'active');
      if (!row) throw new Error(`Active internal plan missing: ${id}`);
      return row;
    });
    // Only Plan data is edited: membership is intentionally dynamic, including
    // users enrolled after preview and future renewals. No roster is encoded.
    const revision = hash(selected);
    if (input.expectedRevision !== undefined && input.expectedRevision !== revision) {
      throw new Error('Internal plans changed since preview');
    }
    const changes = selected.flatMap(before => {
      const metadata = before.metadata_json === null ? {} : JSON.parse(before.metadata_json);
      if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new Error('Invalid Plan metadata');
      const floor = metadata.requestRateFloor ?? {};
      if (!floor || typeof floor !== 'object' || Array.isArray(floor)) throw new Error('Invalid request rate floor');
      const daily = floor.requestsPerDay;
      if (daily !== undefined && (!Number.isSafeInteger(daily) || daily < 1)) throw new Error('Invalid daily request floor');
      if (daily >= 1000) return [];
      const after = { ...before, metadata_json: JSON.stringify({ ...metadata,
        requestRateFloor: { ...floor, requestsPerDay: 1000 } }) };
      return [{ before, after }];
    });
    const result = { applied: input.apply, revision, plans_changed: changes.length,
      plans: selected.map(p => ({ id: p.id,
        before: JSON.parse(p.metadata_json ?? '{}')?.requestRateFloor?.requestsPerDay ?? null,
        after: Math.max(1000, JSON.parse(p.metadata_json ?? '{}')?.requestRateFloor?.requestsPerDay ?? 0) })),
      credentials_changed: 0, entitlement_snapshots_changed: 0,
      higher_and_unlimited_credential_limits_preserved: true };
    if (!input.apply) { db.exec('ROLLBACK'); return result; }
    if (!changes.length) throw new Error('Internal request floors are already raised');
    for (const c of changes) {
      if (db.prepare('UPDATE plans SET metadata_json=? WHERE id=? AND metadata_json IS ?')
        .run(c.after.metadata_json, c.before.id, c.before.metadata_json).changes !== 1) throw new Error('Plan update failed');
    }
    const replacements = new Map(changes.map(c => [c.before.id, c.after]));
    if (hash(readPlans()) !== hash(plans.map(p => replacements.get(p.id) ?? p))) {
      throw new Error('Plan preservation check failed');
    }
    const auditId = `audit_${randomUUID().replaceAll('-', '')}`;
    db.prepare('INSERT INTO admin_audit_events (id,action,status,params_json,created_at) VALUES (?,?,?,?,?)')
      .run(auditId, 'plan-request-policy-update', 'ok', JSON.stringify({ ...result,
        operation: 'raise-internal-request-floor', reason: input.reason,
        metadata: changes.map(c => ({ planId: c.before.id, before: c.before.metadata_json, after: c.after.metadata_json })) }), now);
    db.exec('COMMIT');
    return { ...result, audit_id: auditId, completed_at: now };
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

module.exports = { PLAN_IDS, raiseInternalRequestFloor };
if (process.env.R760_INTERNAL_REQUEST_FLOOR_B64) {
  const input = JSON.parse(Buffer.from(process.env.R760_INTERNAL_REQUEST_FLOOR_B64, 'base64').toString('utf8'));
  if (input.apply && typeof require('/app/packages/core/dist/index.js').applyEntitlementRequestRateFloor !== 'function') {
    throw new Error('Deploy the live Plan request-floor runtime before applying this operation');
  }
  const db = new DatabaseSync('/var/lib/codex-gateway/gateway.db', { readOnly: !input.apply });
  db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=10000');
  if (!input.apply) db.exec('PRAGMA query_only=ON');
  try { console.log(JSON.stringify(raiseInternalRequestFloor(db, input))); } finally { db.close(); }
}
