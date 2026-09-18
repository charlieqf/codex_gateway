// Offline acceptance only. Runs real Gateway HTTP routes, PhoneAuthService and
// disk SQLite with synthetic identities; upstream model execution is a stub.
import assert from 'node:assert/strict';
import { generateKeyPairSync, createHash } from 'node:crypto';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { createSqliteStore } from '@codex-gateway/store-sqlite';
import { issueAccessCredential } from '@codex-gateway/core';
import { buildGateway } from '../apps/gateway/dist/index.js';
import { PhoneAuthService, phoneAuthGatewayOrigin } from '../apps/gateway/dist/services/phone-auth-service.js';
import { InMemoryCredentialRateLimiter } from '../apps/gateway/dist/services/rate-limiter.js';

const seconds = Number(process.env.AUDIT_BENCH_SECONDS ?? 10);
const rounds = Number(process.env.AUDIT_BENCH_ROUNDS ?? 3);
assert(Number.isInteger(seconds) && seconds >= 2 && seconds <= 60);
assert(Number.isInteger(rounds) && rounds >= 1 && rounds <= 5);
const phone = '13800138000', unknownPhone = '13900139000';
const device = 'audit-benchmark-device', attackDevice = 'audit-benchmark-limited-device';
const version = { 'x-medevidence-client-version': '2.0.0-beta.76' };
const secret = 'offline-identity-benchmark-encryption-secret';
const admin = 'offline-identity-benchmark-billing-admin';
const percentile = (values, p) => values.length ? [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(values.length * p) - 1)] : 0;
const size = path => { try { return statSync(path).size; } catch { return 0; } };
const envBefore = Object.fromEntries(['GATEWAY_API_KEY_ENCRYPTION_SECRET', 'GATEWAY_PUBLIC_BASE_URL'].map(key => [key, process.env[key]]));
process.env.GATEWAY_API_KEY_ENCRYPTION_SECRET = secret;
process.env.GATEWAY_PUBLIC_BASE_URL = phoneAuthGatewayOrigin;

async function fixture(enabled) {
  const directory = mkdtempSync(join(process.env.AUDIT_BENCH_ROOT ?? tmpdir(), 'identity-audit-benchmark-'));
  const dbPath = join(directory, 'gateway.db');
  const store = createSqliteStore({ path: dbPath });
  const auditWritesMs = [];
  for (const method of ['recordIdentityRequestEvent', 'recordIdentityRateLimit']) {
    const original = store[method].bind(store);
    store[method] = event => {
      const start = performance.now();
      try { return original(event); } finally { auditWritesMs.push(performance.now() - start); }
    };
  }
  let app;
  try {
  const { privateKey } = generateKeyPairSync('ed25519');
  const service = new PhoneAuthService({ mode: 'transition', store, credentialStore: store, unifiedKeyStore: store,
    entitlementStore: store, publicGatewayBaseUrl: phoneAuthGatewayOrigin, issuer: `${phoneAuthGatewayOrigin}/gateway/auth/v1`,
    audience: 'codex-gateway', activeKid: 'offline-bench', privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    phoneLookupSecret: secret, phoneEncryptionSecret: secret, unifiedKeyRecoverySecret: secret, apiKeyEncryptionSecret: secret });
  // Similar order of magnitude to the observed production subject count. No
  // production data or credentials are copied into this benchmark.
  store.database.exec('BEGIN');
  for (let i = 0; i < 1_026; i++) store.upsertSubject({ id: `offline-subject-${i}`, label: 'Offline benchmark', state: 'active', createdAt: new Date() });
  store.upsertSubject({ id: 'subj_dev', label: 'Offline model benchmark', state: 'active', createdAt: new Date() });
  const modelKey = issueAccessCredential({ subjectId: 'subj_dev', label: 'Offline benchmark', scope: 'code',
    expiresAt: new Date(Date.now() + 86_400_000), rate: { requestsPerMinute: 100_000, requestsPerDay: null, concurrentRequests: null } });
  store.insertAccessCredential(modelKey.record);
  store.database.exec('COMMIT');
  // Keep the controlled rejection mix stable if a run crosses a wall-clock
  // minute. The audit store still buckets by actual completion time.
  const rateWindow = new Date();
  const limiter = new InMemoryCredentialRateLimiter({ now: () => rateWindow });
  const attackedBucket = `phone-auth:device:${createHash('sha256').update(attackDevice).digest('base64url')}`;
  app = buildGateway({ authMode: 'credential', logger: false, sessionStore: store, observationStore: store,
    identityRequestAuditStore: enabled ? store : null, phoneAuthService: service,
    billingAdminToken: admin, billingAdminTokenMode: 'env', externalIdentityProvider: 'offline_benchmark',
    unifiedKeyRecoverySecret: secret, phoneAuthPhoneRequestsPerMinute: 100_000,
    phoneAuthIpRequestsPerMinute: 100_000, phoneAuthDeviceRequestsPerMinute: 100_000,
    phoneAuthLoginRateLimiter: { acquire(input) { return limiter.acquire(input.credentialId === attackedBucket
      ? { ...input, policy: { ...input.policy, requestsPerMinute: 1 } } : input); } },
    desktopVersionGate: { mode: 'auth_only', minimumVersion: '2.0.0-beta.76', downloadUrl: 'https://example.test/download/' },
    upstreamV2Client: { createUser: async () => ({ status: 'created', user: { id: 'offline-upstream' },
      key: { id: 'offline-upstream-key', key: 'offline-upstream-secret', keyPrefix: 'offline' } }),
      disableUser: async () => ({ disabled: true, user: { id: 'offline-upstream' } }), revokeKey: async () => ({ revoked: true, key: { id: 'offline-upstream-key' } }) },
    provider: { kind: 'fake', health: async () => ({ state: 'healthy', checkedAt: new Date() }),
      async *message() { yield { type: 'message_delta', text: 'offline benchmark' }; yield { type: 'completed', providerSessionRef: 'offline' }; } } });
    const signup = await app.inject({ method: 'POST', url: '/gateway/admin/billing/v1/subjects',
      headers: { authorization: `Bearer ${admin}`, 'idempotency-key': 'offline-audit-benchmark' },
      payload: { provider: 'offline_benchmark', external_user_id: 'offline-benchmark', phone, scope_allowlist: ['code'] } });
    assert.equal(signup.statusCode, 200, 'Synthetic signup must succeed');
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    const call = async (path, payload, authorization) => {
      const response = await fetch(`${origin}${path}`, { method: payload === undefined ? 'GET' : 'POST',
        headers: { ...version, ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(authorization ? { authorization: `Bearer ${authorization}` } : {}) }, body: payload === undefined ? undefined : JSON.stringify(payload) });
      const text = await response.text();
      return { status: response.status, json: text ? JSON.parse(text) : null };
    };
    const loginPayload = (number = phone, deviceId = device) => ({ phone: number, device_id: deviceId, client: 'medevidence-desktop', contract_version: 1 });
    // Separate virtual clients: one shared refresh queue would measure load
    // generator head-of-line blocking rather than Gateway request latency.
    const clients = [];
    for (let i = 0; i < 32; i++) {
      const deviceId = `audit-base-device-${i}`;
      const loggedIn = await call('/gateway/auth/v1/login/start', loginPayload(phone, deviceId));
      assert.equal(loggedIn.status, 200);
      clients.push({ deviceId, access: loggedIn.json.access_token, refreshToken: loggedIn.json.refresh_token, refreshQueue: Promise.resolve() });
    }
    const normal = i => {
      const client = clients[i % clients.length];
      if (i % 10 < 2) return call('/gateway/auth/v1/login/start', loginPayload(phone, `audit-login-device-${i}`));
      if (i % 10 === 2) {
        const next = client.refreshQueue.then(async () => {
          const result = await call('/gateway/auth/v1/token/refresh', { refresh_token: client.refreshToken,
            device_id: client.deviceId, client: 'medevidence-desktop', contract_version: 1 });
          if (result.status === 200) client.refreshToken = result.json.refresh_token;
          return result;
        });
        client.refreshQueue = next.then(() => {});
        return next;
      }
      return i % 2 ? call('/gateway/account/v1/current', undefined, client.access) : call('/gateway/auth/v1/session/bootstrap', {}, client.access);
    };
    const model = () => call('/v1/chat/completions', { model: 'medcode', messages: [{ role: 'user', content: 'Offline benchmark' }], stream: false }, modelKey.token);
    assert.equal((await normal(0)).status, 200);
    assert.equal((await model()).status, 200);
    // Spend the one allowed permit for the synthetic device-only attack bucket.
    assert.equal((await call('/gateway/auth/v1/login/start', loginPayload(unknownPhone, attackDevice))).status, 403);
    const rejected = i => i % 4 === 0 ? call('/gateway/auth/v1/login/start', { phone: 123 })
      : i % 4 === 1 ? call('/gateway/auth/v1/session/bootstrap', {})
        : call('/gateway/auth/v1/login/start', loginPayload(unknownPhone, i % 4 === 2 ? 'audit-unknown-device' : attackDevice));
    return { store, dbPath, normal, model, rejected, auditWritesMs,
      async close() { await app.close(); rmSync(directory, { recursive: true, force: true }); } };
  } catch (error) {
    if (app) await app.close(); else store.close();
    rmSync(directory, { recursive: true, force: true }); throw error;
  }
}

async function paced(rps, duration, action, expected) {
  const started = performance.now(), pending = new Set(), latencies = [], statuses = {};
  let launched = 0, maxPending = 0;
  const errors = [];
  while (performance.now() - started < duration * 1_000) {
    const due = Math.floor((performance.now() - started) * rps / 1_000);
    while (launched <= due && launched < rps * duration) {
      const index = launched++, at = performance.now();
      const promise = action(index).then(response => {
        latencies.push(performance.now() - at);
        statuses[response.status] = (statuses[response.status] ?? 0) + 1;
        if (response.status !== expected(index)) errors.push(response.status);
      }).catch(error => errors.push(error.code ?? error.cause?.code ?? error.name)).finally(() => pending.delete(promise));
      pending.add(promise); maxPending = Math.max(maxPending, pending.size);
    }
    await sleep(1);
  }
  await Promise.all(pending);
  return { launched, achievedRps: launched / duration, statuses, errors, p50Ms: percentile(latencies, .5), p95Ms: percentile(latencies, .95), p99Ms: percentile(latencies, .99), maxPending };
}

async function run(enabled, mixed) {
  const f = await fixture(enabled);
  try {
    for (let i = 0; i < 200; i++) assert.equal((await f.normal(i)).status, 200);
    const baseline = f.store.database.prepare('SELECT count(*) AS n FROM identity_request_events').get().n;
    const limitsBefore = f.store.database.prepare('SELECT coalesce(sum(rejection_count),0) AS n FROM identity_rate_limit_minutes').get().n;
    f.auditWritesMs.length = 0;
    const loop = monitorEventLoopDelay({ resolution: 10 }); loop.enable();
    const cpu = process.cpuUsage(), start = performance.now(), walBefore = size(`${f.dbPath}-wal`);
    const [auth, model, rejects] = await Promise.all([
      paced(100, seconds, f.normal, () => 200),
      mixed ? paced(20, seconds, f.model, () => 200) : null,
      mixed ? paced(500, seconds, f.rejected, i => [400, 401, 403, 429][i % 4]) : null
    ]);
    loop.disable();
    for (const result of [auth, model, rejects].filter(Boolean)) assert.equal(result.errors.length, 0,
      `Unexpected responses: ${JSON.stringify(result.errors.slice(0, 5))}`);
    const usage = process.cpuUsage(cpu);
    const counts = f.store.database.prepare('SELECT count(*) AS requests FROM identity_request_events').get();
    const aggregate = f.store.database.prepare('SELECT count(*) AS buckets,coalesce(sum(rejection_count),0) AS rejections FROM identity_rate_limit_minutes').get();
    const addedRequests = counts.requests - baseline, addedLimits = aggregate.rejections - limitsBefore;
    const expectedLimits = rejects?.statuses[429] ?? 0;
    assert.equal(addedRequests, enabled ? auth.launched + (rejects?.launched ?? 0) - expectedLimits : 0);
    assert.equal(addedLimits, enabled ? expectedLimits : 0);
    const result = { enabled, mixed, auth, model, rejects, elapsedMs: performance.now() - start,
      cpuMs: (usage.user + usage.system) / 1_000, eventLoopP95Ms: loop.percentile(95) / 1e6,
      walBeforeBytes: walBefore, walAfterBytes: size(`${f.dbPath}-wal`), dbBytes: size(f.dbPath),
      auditWriteP95Ms: percentile(f.auditWritesMs, .95), auditWriteTotalMs: f.auditWritesMs.reduce((sum, value) => sum + value, 0),
      addedRequests, addedLimits, buckets: aggregate.buckets,
      sqliteIntegrity: f.store.database.prepare('PRAGMA quick_check').get().quick_check };
    console.log(JSON.stringify({ sample: result }));
    return result;
  } finally { await f.close(); }
}

try {
  const samples = [];
  for (let round = 0; round < rounds; round++) for (const enabled of round % 2 ? [true, false] : [false, true]) samples.push(await run(enabled, false));
  for (const enabled of [false, true]) samples.push(await run(enabled, true));
  const normal = enabled => percentile(samples.filter(row => !row.mixed && row.enabled === enabled).map(row => row.auth.p95Ms), .5);
  const baseline = normal(false), enabled = normal(true), overhead = enabled - baseline;
  const result = { settings: { seconds, rounds, authRps: 100, modelRps: 20, rejectionRps: 500, syntheticSubjects: 1_026 },
    baselineP95Ms: baseline, enabledP95Ms: enabled, extraMs: overhead, extraRatio: overhead / baseline,
    passed: overhead <= 5 && overhead <= baseline * .1,
    limits: 'Loopback HTTP, disk SQLite, 32 independent client sessions, 20% login/10% refresh/70% bootstrap-current, synthetic identities and stub provider; measures Gateway overhead, not real model latency or public network.' };
  console.log(JSON.stringify({ acceptance: result }));
  if (!result.passed) process.exitCode = 1;
} finally {
  for (const [key, value] of Object.entries(envBefore)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
}
