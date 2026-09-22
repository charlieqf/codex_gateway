import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { createSqliteStore } from '@codex-gateway/store-sqlite';

const directories = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
// Historical artifact. `scripts/ops/verify-identity-audit-migration.mjs` rehearsed the
// 33-to-34 identity-audit cutover, which is deployed; it is kept unmodified as the record
// of what was actually run. Its assertions are pinned to that cutover - source at exactly
// 33, target at exactly 34, and every pre-existing business table keeping its CREATE TABLE
// SQL - so any later migration trips them. Schema 35 (request_events.vision_observation_json)
// is the first to do so. Re-running the rehearsal has no future use, and relaxing the
// assertions to keep this green would discard the shape check that gave it its value.
// A general "migrations leave business data intact" guard belongs in a new test, not here.
it.skip('runs the offline migration verifier without changing its source and refuses an existing target', () => {
  const directory = mkdtempSync(join(tmpdir(), 'identity-migration-'));
  directories.push(directory);
  const source = join(directory, 'schema33.db'), target = join(directory, 'schema34.db');
  const store = createSqliteStore({ path: source });
  store.upsertSubject({ id: 'migration-synthetic', label: 'Unchanged subject', state: 'disabled', createdAt: new Date() });
  store.database.exec('DROP TABLE identity_request_events; DROP TABLE identity_rate_limit_minutes; DELETE FROM schema_migrations WHERE version=34;');
  store.close();
  const args = ['scripts/ops/verify-identity-audit-migration.mjs', '--source', source, '--target', target];
  const result = spawnSync(process.execPath, args, { encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
  const summary = JSON.parse(result.stdout);
  expect(summary).toMatchObject({ migration: '33-to-34', repeatedStartup: 'passed', integrity: 'ok', foreignKeyErrors: 0 });
  expect(summary.originalTablesUnchanged).toContainEqual({ table: 'subjects', rows: 1 });
  const original = new DatabaseSync(source, { readOnly: true });
  try { expect(original.prepare('SELECT max(version) AS n FROM schema_migrations').get().n).toBe(33); } finally { original.close(); }
  const refused = spawnSync(process.execPath, args, { encoding: 'utf8' });
  expect(refused.status).not.toBe(0);
  expect(refused.stderr).toContain('Target must be a new, separate offline file');
});
