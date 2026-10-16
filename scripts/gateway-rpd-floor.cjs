// Invoked only through manage-r760-gateway-control.py after verified backup.
const { DatabaseSync } = require('node:sqlite');
const { randomUUID } = require('node:crypto');
const db = new DatabaseSync('/var/lib/codex-gateway/gateway.db');
db.exec('PRAGMA busy_timeout=10000; BEGIN IMMEDIATE');
try {
  const now = new Date().toISOString();
  const rows = db.prepare(`SELECT c.id,c.rate_json FROM access_credentials c
    JOIN subjects s ON s.id=c.subject_id
    WHERE s.state='active' AND c.revoked_at IS NULL
      AND (c.expires_at IS NULL OR c.expires_at>?)`).all(now);
  const update = db.prepare('UPDATE access_credentials SET rate_json=? WHERE id=? AND rate_json=?');
  let changed = 0;
  const before = [];
  for (const row of rows) {
    const rate = JSON.parse(row.rate_json);
    if (rate.requestsPerDay === null || rate.requestsPerDay >= 500) continue;
    if (!Number.isInteger(rate.requestsPerDay) || rate.requestsPerDay < 1) throw Error('Invalid existing daily quota');
    before.push({ id: row.id, requestsPerDay: rate.requestsPerDay });
    rate.requestsPerDay = 500;
    if (update.run(JSON.stringify(rate), row.id, row.rate_json).changes !== 1) throw Error('Credential changed concurrently');
    changed++;
  }
  db.prepare(`INSERT INTO admin_audit_events(id,action,status,params_json,created_at)
    VALUES(?,?,?,?,?)`).run(randomUUID(), 'update-key', 'ok', JSON.stringify({ operation:'ensure-account-rpd-minimum', minimum:500, before }), now);
  db.exec('COMMIT');
  console.log(JSON.stringify({ eligible:rows.length, changed, unchanged:rows.length-changed, minimum:500 }));
} catch(e) { db.exec('ROLLBACK'); throw e; }
finally { db.close(); }
