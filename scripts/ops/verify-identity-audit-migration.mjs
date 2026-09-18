// Offline migration rehearsal. Source MUST be a completed immutable SQLite
// backup, never a live database file copied without its WAL.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants, copyFileSync, chmodSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import { createSqliteStore } from '@codex-gateway/store-sqlite';

const { values } = parseArgs({ options: { source: { type: 'string' }, target: { type: 'string' } } });
assert(values.source && values.target, 'Provide --source <immutable-schema33-backup> --target <new-offline-copy>');
const source = resolve(values.source), target = resolve(values.target);
assert(source !== target && !existsSync(target), 'Target must be a new, separate offline file');
assert(!existsSync(`${source}-wal`), 'Use a completed standalone backup, not a live WAL database');
const quote = name => `"${name.replaceAll('"', '""')}"`;
function open(path) { const db = new DatabaseSync(path, { readOnly: true }); db.exec('PRAGMA query_only=ON'); return db; }
function fingerprint(db, tables) {
  return tables.map(({ name, sql }) => {
    assert.equal(db.prepare('SELECT sql FROM sqlite_master WHERE type=\'table\' AND name=?').get(name)?.sql, sql);
    const hash = createHash('sha256');
    const query = db.prepare(`SELECT * FROM ${quote(name)}`);
    query.setReadBigInts(true);
    let rows = 0;
    for (const row of query.iterate()) { hash.update(JSON.stringify(row, (_key, value) => typeof value === 'bigint' ? value.toString() : value)); hash.update('\n'); rows++; }
    return { table: name, rows, digest: hash.digest('hex') };
  });
}
const original = open(source);
let tables, before;
try {
  assert.equal(original.prepare('SELECT max(version) AS n FROM schema_migrations').get().n, 33);
  assert.equal(original.prepare('PRAGMA quick_check').get().quick_check, 'ok');
  assert.deepEqual(original.prepare('PRAGMA foreign_key_check').all(), []);
  tables = original.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name!='schema_migrations' ORDER BY name").all();
  before = fingerprint(original, tables);
} finally { original.close(); }
copyFileSync(source, target, constants.COPYFILE_EXCL);
chmodSync(target, 0o600);
for (let run = 0; run < 2; run++) createSqliteStore({ path: target }).close();
const migrated = open(target);
try {
  assert.deepEqual(fingerprint(migrated, tables), before, 'Every pre-existing business table and row must remain unchanged');
  assert.equal(migrated.prepare('SELECT max(version) AS n FROM schema_migrations').get().n, 34);
  assert.equal(migrated.prepare('SELECT count(*) AS n FROM schema_migrations WHERE version=34').get().n, 1);
  const names = migrated.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name!='schema_migrations'").all().map(row => row.name);
  assert.deepEqual(names.filter(name => !tables.some(table => table.name === name)).sort(), ['identity_rate_limit_minutes', 'identity_request_events']);
  for (const table of ['identity_request_events', 'identity_rate_limit_minutes']) assert.equal(migrated.prepare(`SELECT count(*) AS n FROM ${quote(table)}`).get().n, 0);
  assert.equal(migrated.prepare('PRAGMA quick_check').get().quick_check, 'ok');
  assert.deepEqual(migrated.prepare('PRAGMA foreign_key_check').all(), []);
  console.log(JSON.stringify({ migration: '33-to-34', repeatedStartup: 'passed', originalTablesUnchanged: before.map(({ table, rows }) => ({ table, rows })),
    addedEmptyTables: ['identity_request_events', 'identity_rate_limit_minutes'], integrity: 'ok', foreignKeyErrors: 0 }));
} finally { migrated.close(); }
