// Guarded wrapper helper: reset exactly one credential's live daily request counter.
// All database access here is read-only; the supported Billing API owns the write.
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');

async function main() {
  const op = JSON.parse(Buffer.from(process.env.R760_REQUEST_DAY_RESET_B64 || '', 'base64').toString('utf8'));
  assert.match(op.subjectId, /^[A-Za-z0-9_-]{1,128}$/);
  assert.match(op.credentialId, /^[A-Za-z0-9_-]{1,128}$/);
  assert.equal(typeof op.apply, 'boolean');
  assert.ok(typeof op.reason === 'string' && op.reason.trim() && op.reason.length <= 500);
  const db = new DatabaseSync('/var/lib/codex-gateway/gateway.db', { readOnly: true });
  db.exec('PRAGMA query_only=ON');
  try {
    const subject = db.prepare('SELECT id,state FROM subjects WHERE id=?').get(op.subjectId);
    const credential = db.prepare('SELECT id,prefix,subject_id,expires_at,revoked_at FROM access_credentials WHERE id=?').get(op.credentialId);
    assert.equal(subject?.state, 'active', 'Subject must be active');
    assert.equal(credential?.subject_id, op.subjectId, 'Credential must belong to the exact subject');
    assert.equal(credential.revoked_at, null, 'Credential must not be revoked');
    assert.ok(Date.parse(credential.expires_at) > Date.now(), 'Credential must not be expired');
    const recentRejection = db.prepare("SELECT request_id,started_at FROM request_events WHERE credential_id=? AND limit_kind='request_day' AND started_at>=? ORDER BY started_at DESC LIMIT 1")
      .get(op.credentialId, new Date(Date.now() - 60 * 60 * 1000).toISOString());
    assert.ok(recentRejection, 'Require a daily quota rejection within the last hour');
    assert.ok(process.env.GATEWAY_BILLING_ADMIN_TOKEN, 'Billing admin credential required');
    const plan = { subject_id: op.subjectId, credential_id: op.credentialId,
      request_windows: ['day'], token_windows: [], recent_rejection: recentRejection };
    if (!op.apply) return { status: 'preview', ...plan };
    const started = new Date().toISOString();
    const response = await fetch('https://goldencode.instmarket.com.au:1443/gateway/admin/billing/v1/users/' + encodeURIComponent(op.subjectId) + '/quota-reset', {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + process.env.GATEWAY_BILLING_ADMIN_TOKEN,
        'content-type': 'application/json',
        'x-medevidence-client-version': process.env.GATEWAY_MINIMUM_DESKTOP_VERSION || '2.0.0-beta.76',
      },
      body: JSON.stringify({ request_windows: ['day'], token_windows: [], credential_prefix: credential.prefix, reason: op.reason }),
      signal: AbortSignal.timeout(30000),
    });
    const result = await response.json();
    const receipt = { ...plan, http_status: response.status, request_id: response.headers.get('x-request-id') };
    assert.equal(response.status, 200, 'Billing quota reset failed: ' + (result.error?.code || response.status));
    assert.equal(result.subject_id, op.subjectId);
    assert.equal(result.token_reset?.status, 'skipped');
    assert.equal(result.request_reset?.status, 'reset');
    assert.equal(result.request_reset.credentials.length, 1);
    const item = result.request_reset.credentials[0];
    assert.equal(item.credential_id, op.credentialId);
    assert.deepEqual(item.reset.windows, ['day']);
    assert.equal(item.reset.found, true, 'Live counter must be present');
    assert.equal(item.reset.after.day_count, 0);
    assert.equal(item.reset.after.active, item.reset.before.active);
    assert.equal(item.reset.after.minute_count, item.reset.before.minute_count);
    const audit = db.prepare("SELECT id,status,created_at FROM admin_audit_events WHERE action='quota-reset' AND target_user_id=? AND target_credential_prefix=? AND created_at>=? ORDER BY created_at DESC LIMIT 1")
      .get(op.subjectId, credential.prefix, started);
    assert.equal(audit?.status, 'ok', 'Successful audit must be recorded');
    return { status: 'reset', ...receipt, before: item.reset.before, after: item.reset.after, token_reset: result.token_reset, audit };
  } finally { db.close(); }
}
main().then(result => console.log(JSON.stringify(result))).catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
