import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createSqliteStore } from '@codex-gateway/store-sqlite';
import { queryIdentityRequests } from '../scripts/query-identity-requests.mjs';

const closers = [];
afterEach(() => { for (const close of closers.splice(0)) close(); });
const since = '2026-09-18T00:00:01.000Z', until = '2026-09-18T00:01:01.000Z';
function fixture() {
  const store = createSqliteStore({ path: ':memory:' });
  closers.push(() => store.close());
  for (let i = 0; i < 3; i++) store.recordIdentityRequestEvent({
    requestId: `req-${i}`, operation: 'phone_login', method: 'POST', routeTemplate: '/gateway/auth/v1/login/start',
    startedAt: since, completedAt: '2026-09-18T00:00:30.000Z', durationMs: 5, httpStatus: 403,
    transportOutcome: 'responded', outcome: 'rejected', errorCode: 'phone_not_registered', reasonCode: 'phone_not_registered',
    stage: 'account_readiness', phoneInput: '13800138000', phoneNormalized: '+8613800138000', phoneCaptureStatus: 'captured',
    provider: 'test', externalUserId: 'test-identity', subjectId: null, targetSubjectId: null, conflictingSubjectId: null,
    resolvedPhone: null, sessionId: null, jobId: null, clientVersion: '2.0.0-beta.76'
  });
  for (let i = 0; i < 20; i++) store.recordIdentityRateLimit({ operation: 'phone_login', limitDimension: 'ip',
    limitKind: 'request_minute', origin: 'gateway', errorCode: 'auth_rate_limited', requestId: `limit-${i}`,
    phoneInput: '13800138000', phoneNormalized: '+8613800138000', completedAt: '2026-09-18T00:00:30.000Z' });
  store.database.exec('PRAGMA query_only=ON');
  return store;
}
describe('private identity query', () => {
  it('paginates equal timestamps without duplicating records, and does not count buckets as requests', () => {
    const store = fixture();
    const first = queryIdentityRequests(store.database, { since, until, limit: 2 });
    const next = queryIdentityRequests(store.database, { since, until, limit: 2, cursor: first.nextCursor });
    expect([...first.requests, ...next.requests].map(row => row.request_id)).toEqual(['req-2', 'req-1', 'req-0']);
    expect(next.nextCursor).toBeNull();
    expect(first.rateLimits.rows[0].rejection_count).toBe(20);
    expect(first.rateLimits.actualFrom).toBe('2026-09-18T00:00:00.000Z');
    expect(first.rateLimits.actualUntil).toBe('2026-09-18T00:02:00.000Z');
    expect(JSON.stringify(first)).not.toContain('13800138000');
  });
  it('allows full phone only for a targeted operator query and labels aggregate sample matches', () => {
    const store = fixture();
    expect(() => queryIdentityRequests(store.database, { since, until, includePhone: true })).toThrow();
    const result = queryIdentityRequests(store.database, { since, until, phone: '13800138000', includePhone: true });
    expect(result.requests).toHaveLength(3);
    expect(result.requests[0].phone_input).toBe('13800138000');
    expect(result.rateLimits.attribution).toContain('counts_cover_entire_bucket');
  });

  it('masks submitted phone formatting as well as normalized numbers', () => {
    const store = fixture();
    store.database.exec("PRAGMA query_only=OFF; UPDATE identity_request_events SET phone_input='138 0013 8000'; PRAGMA query_only=ON;");
    const result = queryIdentityRequests(store.database, { since, until });
    expect(result.requests[0].phone_input).toBe('[phone-redacted]');
    expect(JSON.stringify(result)).not.toContain('138 0013 8000');
  });
  it('matches external and subject filters without attributing minute samples to a subject', () => {
    const store = fixture();
    expect(queryIdentityRequests(store.database, { since, until, provider: 'test', externalUserId: 'test-identity' }).requests).toHaveLength(3);
    const result = queryIdentityRequests(store.database, { since, until, subjectId: 'not-confirmed' });
    expect(result.requests).toEqual([]);
    expect(result.rateLimits.rows).toBeNull();
  });
  it('rejects invalid windows, pagination, partial identity and writable connections', () => {
    const store = fixture();
    for (const input of [{ limit: 501 }, { limit: 0 }, { since: until }, { cursor: 'broken' }, { provider: 'test' }, { phone: 'invalid' }]) {
      expect(() => queryIdentityRequests(store.database, { since, until, ...input })).toThrow();
    }
    store.database.exec('PRAGMA query_only=OFF');
    expect(() => queryIdentityRequests(store.database, { since, until })).toThrow('Query-only');
  });
  it('reports a legacy database as unavailable HTTP evidence, without creating tables', () => {
    const db = new DatabaseSync(':memory:');
    closers.push(() => db.close());
    db.exec('PRAGMA query_only=ON');
    expect(queryIdentityRequests(db, { since, until })).toMatchObject({ mode: 'legacy_security_only', requests: null });
    expect(db.prepare('SELECT name FROM sqlite_master').all()).toEqual([]);
  });
  it('runs the conflict consumer read-only against both schemas with explicit source labels', () => {
    const directory = mkdtempSync(join(tmpdir(), 'identity-audit-consumer-'));
    closers.push(() => rmSync(directory, { recursive: true, force: true }));
    const path = join(directory, 'gateway.db');
    const store = createSqliteStore({ path });
    store.close();
    const source = readFileSync(new URL('../scripts/ops/audit-phone-conflicts-r760.mjs', import.meta.url), 'utf8')
      .replace("'/var/lib/codex-gateway/gateway.db'", JSON.stringify(path));
    const run = () => {
      const result = spawnSync(process.execPath, ['--input-type=module', '-'], { input: source, encoding: 'utf8' });
      expect(result.status, result.stderr).toBe(0);
      return JSON.parse(result.stdout);
    };
    expect(run()).toMatchObject({ identity_audit_source: 'identity_http_requests', rate_limits: { detail_level: 'minute_aggregate' } });
    const db = new DatabaseSync(path);
    db.exec('DROP TABLE identity_request_events; DROP TABLE identity_rate_limit_minutes; DELETE FROM schema_migrations WHERE version=34;');
    db.close();
    expect(run()).toMatchObject({ identity_audit_source: 'legacy_security_events', rate_limits: { rows: null } });
    const verify = new DatabaseSync(path, { readOnly: true });
    expect(verify.prepare("SELECT name FROM sqlite_master WHERE name='identity_request_events'").get()).toBeUndefined();
    verify.close();
  });

  it('executes readiness and exporter SQL against new and legacy evidence without writes', () => {
    const directory = mkdtempSync(join(tmpdir(), 'identity-consumers-'));
    closers.push(() => rmSync(directory, { recursive: true, force: true }));
    const path = join(directory, 'gateway.db');
    const store = createSqliteStore({ path });
    store.upsertSubject({ id: 'consumer-test', label: 'Consumer test', state: 'disabled', createdAt: new Date() });
    // Deliberately orphaned identity: the diagnostic must stop at the disabled
    // subject without trying to repair the identity, recover a key or log in.
    store.database.exec(`PRAGMA foreign_keys=OFF;
      INSERT INTO phone_auth_identities VALUES ('test-hash','test-ciphertext','consumer-test','missing-test-key','active','2026-09-18','2026-09-18');
      INSERT INTO phone_auth_audit_events(id,request_id,action,subject_id,outcome,created_at)
      VALUES ('legacy-test','legacy-request','login','consumer-test','ok','2026-09-18T00:00:30.000Z');`);
    const template = fixture().database.prepare('SELECT * FROM identity_request_events LIMIT 1').get();
    const columns = Object.keys(template);
    store.database.prepare(`INSERT INTO identity_request_events(${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`)
      .run(...columns.map(key => key === 'subject_id' ? 'consumer-test' : template[key]));
    store.recordIdentityRateLimit({ operation: 'phone_login', limitDimension: 'ip', limitKind: 'request_minute',
      origin: 'gateway', errorCode: 'auth_rate_limited', requestId: 'sample-test', completedAt: '2026-09-18T00:00:30.000Z',
      phoneInput: '13800138000', phoneNormalized: '+8613800138000' });
    store.close();
    const readiness = readFileSync(new URL('../scripts/ops/audit-phone-auth-readiness-r760.mjs', import.meta.url), 'utf8')
      .replace("'/var/lib/codex-gateway/gateway.db'", JSON.stringify(path))
      .replaceAll(/'\/app\/([^']+)'/g, (_match, relative) => JSON.stringify(pathToFileURL(join(process.cwd(), relative)).href));
    const exporter = readFileSync(new URL('../scripts/export-user-accounts.py', import.meta.url), 'utf8')
      .split('PROBE_SOURCE = r"""')[1].split('"""')[0];
    const run = source => {
      const result = spawnSync(process.execPath, ['--input-type=module', '-'], { input: source, encoding: 'utf8',
        env: { ...process.env, GATEWAY_DB: path, CLIENT_EVENTS_DB: join(directory, 'absent.db'), GATEWAY_PHONE_AUTH_MODE: 'disabled' } });
      expect(result.status, result.stderr).toBe(0);
      return JSON.parse(result.stdout);
    };
    const snapshot = () => {
      const db = new DatabaseSync(path, { readOnly: true });
      db.exec('PRAGMA query_only=ON');
      try { return db.prepare("SELECT * FROM phone_auth_identities").all(); } finally { db.close(); }
    };
    const original = snapshot();
    const current = run(readiness);
    expect(current.counts).toEqual({ account_disabled: 1 });
    expect(current.problems[0].latest_login).toMatchObject({ source: 'identity_http_requests', event: { outcome: 'rejected', request_id: 'req-0' } });
    const exported = run(exporter);
    expect(exported.phone_audit_source).toBe('identity_http_requests');
    expect(exported.phone_audit[0].outcome).toBe('rejected');
    expect(exported.phone_security_audit[0].outcome).toBe('ok');
    expect(exported.identity_rate_limit_minutes[0].requests).toBe(1);
    expect(snapshot()).toEqual(original);
    const db = new DatabaseSync(path);
    db.exec('DROP TABLE identity_request_events; DROP TABLE identity_rate_limit_minutes; DELETE FROM schema_migrations WHERE version=34;');
    db.close();
    expect(run(readiness).problems[0].latest_login).toMatchObject({ source: 'legacy_security_events', event: { outcome: 'ok' } });
    expect(run(exporter)).toMatchObject({ phone_audit_source: 'legacy_security_events', phone_audit_coverage: null, identity_rate_limit_minutes: [] });
    expect(snapshot()).toEqual(original);
  });
});
