// One account, one daily Token window. The Billing API owns every database write.
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { mkdirSync, mkdtempSync, writeFileSync } = require('node:fs');

async function main() {
  const { phone, apply, reason } = globalThis.operation;
  const db = new DatabaseSync(process.env.GATEWAY_SQLITE_PATH, { readOnly: true });
  db.exec('PRAGMA query_only=ON');
  try {
    const now = new Date().toISOString();
    const subjects = db.prepare('SELECT id,state FROM subjects WHERE phone_number IN (?,?)').all(phone, '+86' + phone);
    assert.equal(subjects.length, 1, 'Phone must resolve to exactly one account');
    const subject = subjects[0];
    assert.equal(subject.state, 'active', 'Account must be active');
    const credentials = db.prepare(`SELECT id,prefix FROM access_credentials
      WHERE subject_id=? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>?)`).all(subject.id, now);
    assert.equal(credentials.length, 1, 'Expected one active credential; review ambiguous accounts separately');
    const entitlements = db.prepare(`SELECT id,policy_snapshot_json,period_end FROM entitlements
      WHERE subject_id=? AND state='active' AND period_start<=? AND (period_end IS NULL OR period_end>?)`).all(subject.id, now, now);
    assert.equal(entitlements.length, 1, 'Expected one current entitlement; review mixed allowances separately');
    const entitlement = entitlements[0];
    const limit = JSON.parse(entitlement.policy_snapshot_json).tokensPerDay;
    assert(Number.isSafeInteger(limit) && limit > 0, 'Account must have a daily Token limit; this is not a lifetime Free reset');
    assert.equal(db.prepare('SELECT count(*) n FROM token_reservations WHERE subject_id=? AND finalized_at IS NULL').get(subject.id).n,
      0, 'A model request is unsettled; retry after it finishes');
    const dayStart = now.slice(0, 10) + 'T00:00:00.000Z';
    const before = db.prepare(`SELECT * FROM entitlement_token_windows
      WHERE entitlement_id=? AND window_kind='day' AND window_start=?`).get(entitlement.id, dayStart) ?? null;
    const report = { subject_id: subject.id, phone_tail: phone.slice(-4), day_limit: limit, used_before: before?.total_tokens ?? 0 };
    if (!apply) return { status: 'preview', ...report };

    assert(process.env.GATEWAY_BILLING_ADMIN_TOKEN, 'Billing admin authentication is required');
    // Small scoped recovery record, retained with Gateway data; no whole-DB backup.
    const root = '/var/lib/codex-gateway/ops/quota-resets';
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const journal = mkdtempSync(root + '/daily-');
    const save = (name, value) => writeFileSync(journal + '/' + name + '.json', JSON.stringify(value), { mode: 0o600, flush: true });
    save('before', { at: now, reason, ...report, entitlement, day_window: before });
    const response = await fetch('https://goldencode.instmarket.com.au:1443/gateway/admin/billing/v1/users/' + subject.id + '/quota-reset', {
      method: 'POST', headers: {
        authorization: 'Bearer ' + process.env.GATEWAY_BILLING_ADMIN_TOKEN,
        'content-type': 'application/json',
        'x-medevidence-client-version': process.env.GATEWAY_MINIMUM_DESKTOP_VERSION || '2.0.0-beta.147'
      }, body: JSON.stringify({ credential_prefix: credentials[0].prefix, request_windows: [], token_windows: ['day'], reason }),
      signal: AbortSignal.timeout(30000)
    });
    const result = await response.json();
    const requestId = response.headers.get('x-request-id');
    save('result', { http: response.status, request_id: requestId, result });
    assert.equal(response.status, 200, 'Billing reset failed: ' + (result.error?.code ?? response.status));
    assert.equal(result.subject_id, subject.id);
    assert.equal(result.request_reset.status, 'skipped');
    const reset = result.token_reset;
    assert.equal(reset.status, 'reset');
    assert.equal(reset.entitlement_id, entitlement.id);
    assert.deepEqual(reset.windows, ['day']);
    assert.equal(reset.usage_after.day.used, 0);
    assert.equal(reset.usage_after.month.used, reset.usage_before.month.used);
    const audit = db.prepare(`SELECT id FROM admin_audit_events WHERE action='quota-reset'
      AND target_user_id=? AND target_credential_prefix=? AND status='ok' AND created_at>=?
      ORDER BY created_at DESC LIMIT 1`).get(subject.id, credentials[0].prefix, now);
    assert(audit, 'Successful reset must have an audit record');
    return { status: 'reset', ...report, used_before: reset.usage_before.day.used,
      remaining: reset.usage_after.day.remaining, day_limit: reset.usage_after.day.limit,
      monthly_usage_unchanged: true, request_id: requestId, audit_id: audit.id, journal };
  } finally { db.close(); }
}

main().then(result => console.log(JSON.stringify(result))).catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
