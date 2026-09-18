#!/usr/bin/env node
/** Private, read-only operator query. No migrations, business lookups or token decoding. */
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { normalizeMainlandChinaPhone } from '@codex-gateway/core';

function timestamp(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error('Valid ISO time required.');
  return new Date(value).toISOString();
}
function bounded(value, maximum = 256) {
  if (value === undefined) return null;
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error('Invalid filter.');
  return value;
}
const mask = value => typeof value === 'string' ? value.replace(/(?:\+86)?1[3-9][0-9]{9}/gu, '[phone-redacted]') : value;
const phoneColumns = new Set(['phone_input', 'phone_normalized', 'resolved_phone',
  'first_phone_input', 'first_phone_normalized', 'last_phone_input', 'last_phone_normalized']);
const maskRow = row => Object.fromEntries(Object.entries(row).map(([key, value]) =>
  [key, phoneColumns.has(key) && value !== null ? '[phone-redacted]' : mask(value)]));

export function queryIdentityRequests(db, input) {
  if (db.prepare('PRAGMA query_only').get().query_only !== 1) throw new Error('Query-only SQLite connection required.');
  const since = timestamp(input.since);
  const until = timestamp(input.until ?? new Date().toISOString());
  if (since >= until || Date.parse(until) - Date.parse(since) > 31 * 86400000) throw new Error('Query window must be positive and at most 31 days.');
  const limit = Number(input.limit ?? 100);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('Limit must be 1..500.');
  const requestId = bounded(input.requestId, 128);
  const provider = bounded(input.provider, 128);
  const externalId = bounded(input.externalUserId);
  const subjectId = bounded(input.subjectId, 128);
  const jobId = bounded(input.jobId, 128);
  const phoneInput = bounded(input.phone, 64);
  const phone = phoneInput === null ? null : normalizeMainlandChinaPhone(phoneInput);
  if (phoneInput !== null && !phone) throw new Error('A supported phone filter is required.');
  if (Boolean(provider) !== Boolean(externalId)) throw new Error('Provider and external ID must be supplied together.');
  const targeted = Boolean(requestId || phone || provider || subjectId || jobId);
  if (input.includePhone && !targeted) throw new Error('Full phone output requires a targeted identity filter.');
  const note = 'Retained HTTP observations only. Check cutover, restart and audit-write-failure gaps. Missing events do not prove no failures; no historical phone values are reconstructed.';
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='identity_request_events'").get()) {
    return { mode: 'legacy_security_only', requests: null, rateLimits: null, nextCursor: null, note };
  }
  const clauses = ['completed_at>=?', 'completed_at<?'];
  const values = [since, until];
  for (const [column, value] of [['request_id', requestId], ['provider', provider], ['external_user_id', externalId], ['job_id', jobId]]) {
    if (value !== null) { clauses.push(`${column}=?`); values.push(value); }
  }
  if (phone) { clauses.push('(phone_normalized=? OR resolved_phone=?)'); values.push(phone, phone); }
  if (subjectId) { clauses.push('(subject_id=? OR target_subject_id=? OR conflicting_subject_id=?)'); values.push(subjectId, subjectId, subjectId); }
  if (input.cursor) {
    const encoded = bounded(input.cursor, 1024);
    let cursor;
    try { cursor = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')); } catch { throw new Error('Invalid cursor.'); }
    const cursorAt = timestamp(cursor.at), cursorId = bounded(cursor.id, 128);
    if (!cursorId) throw new Error('Invalid cursor.');
    clauses.push('(completed_at<? OR (completed_at=? AND request_id<?))'); values.push(cursorAt, cursorAt, cursorId);
  }
  const rows = db.prepare(`SELECT request_id,operation,method,route_template,started_at,completed_at,duration_ms,
    http_status,transport_outcome,outcome,error_code,reason_code,stage,phone_input,phone_normalized,phone_capture_status,
    provider,external_user_id,subject_id,target_subject_id,conflicting_subject_id,resolved_phone,session_id,job_id,client_version
    FROM identity_request_events WHERE ${clauses.join(' AND ')} ORDER BY completed_at DESC,request_id DESC LIMIT ?`).all(...values, limit + 1);
  const more = rows.length > limit;
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  const actualFrom = new Date(Math.floor(Date.parse(since) / 60000) * 60000).toISOString();
  const actualUntil = new Date(Math.ceil(Date.parse(until) / 60000) * 60000).toISOString();
  let buckets = null;
  if (!provider && !subjectId && !jobId) {
    const conditions = ['minute_start>=?', 'minute_start<?'];
    const params = [actualFrom, actualUntil];
    if (requestId) { conditions.push('(first_request_id=? OR last_request_id=?)'); params.push(requestId, requestId); }
    if (phone) { conditions.push('(first_phone_normalized=? OR last_phone_normalized=?)'); params.push(phone, phone); }
    // Three fixed buckets/minute; bounded output separate from ordinary request pagination.
    buckets = db.prepare(`SELECT minute_start,operation,limit_dimension,rejection_count,first_at,last_at,
      first_request_id,last_request_id,first_phone_input,first_phone_normalized,last_phone_input,last_phone_normalized
      FROM identity_rate_limit_minutes WHERE ${conditions.join(' AND ')} ORDER BY minute_start DESC,limit_dimension LIMIT ?`)
      .all(...params, limit + 1);
  }
  return {
    mode: 'identity_http_requests', since, until, note,
    requests: input.includePhone ? page : page.map(maskRow),
    nextCursor: more ? Buffer.from(JSON.stringify({ at: last.completed_at, id: last.request_id })).toString('base64url') : null,
    rateLimits: { detail_level: 'minute_aggregate', actualFrom, actualUntil,
      attribution: targeted ? 'sample_matches_only_or_not_attributable; counts_cover_entire_bucket' : 'all_identities',
      truncated: buckets !== null && buckets.length > limit,
      rows: buckets === null ? null : (input.includePhone ? buckets.slice(0, limit) : buckets.slice(0, limit).map(maskRow)),
      note: 'Only first/last request samples are retained. Narrow the time window if truncated. Samples cannot establish per-phone counts.' }
  };
}

function main() {
  const { values } = parseArgs({ options: {
    db: { type: 'string' }, since: { type: 'string' }, until: { type: 'string' }, limit: { type: 'string' },
    'request-id': { type: 'string' }, phone: { type: 'string' }, provider: { type: 'string' },
    'external-user-id': { type: 'string' }, 'subject-id': { type: 'string' }, 'job-id': { type: 'string' },
    cursor: { type: 'string' }, 'include-phone': { type: 'boolean', default: false }
  } });
  if (!values.db || !values.since) throw new Error('Usage: node scripts/query-identity-requests.mjs --db <path> --since <ISO> [--until <ISO>] [--request-id <id>|--phone <phone>|--provider <p> --external-user-id <id>|--subject-id <id>|--job-id <id>] [--limit 100] [--cursor <cursor>] [--include-phone]');
  const db = new DatabaseSync(values.db, { readOnly: true });
  try {
    db.exec('PRAGMA query_only=ON; BEGIN');
    const result = queryIdentityRequests(db, { ...values, requestId: values['request-id'], externalUserId: values['external-user-id'],
      subjectId: values['subject-id'], jobId: values['job-id'], includePhone: values['include-phone'] });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally { db.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 2; }
}
