import { afterEach, expect, it } from "vitest";
import { issueAccessCredential, phoneSignupFreePlan, validateTokenPolicy, type TokenLimitPolicy } from "@codex-gateway/core";
import { createSqliteStore, createSqliteTokenBudgetLimiter } from "./index.js";
import { migrateGatewaySchema } from "./migrations.js";

const stores: ReturnType<typeof createSqliteStore>[] = [];
const now = new Date("2026-10-12T05:04:00Z");
const policy: TokenLimitPolicy = { tokensPerMinute: 300_000, tokensPerDay: 2_000_000,
  tokensPerMonth: 10_000_000, tokensTotal: null, maxPromptTokensPerRequest: null,
  maxTotalTokensPerRequest: null, reserveTokensPerRequest: 0, missingUsageCharge: "estimate" };
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

function fixture() {
  const store = createSqliteStore({ path: ":memory:" }); stores.push(store);
  store.upsertSubject({ id: "s", label: "synthetic", state: "active", createdAt: now });
  const credential = issueAccessCredential({ subjectId: "s", label: "synthetic", scope: "code",
    rate: { token: policy }, now, expiresAt: new Date("2027-01-01T00:00:00Z") });
  store.insertAccessCredential(credential.record);
  return { store, credential, limiter: createSqliteTokenBudgetLimiter({ db: store.database }) };
}

it.each([0, 100_000, 300_000, 600_000, 700_000, 1_000_000, null])(
  "migrates TPM %s without changing other policy fields, usage, or immutable protection", async tpm => {
    const { store, credential, limiter } = fixture();
    store.createPlan({ id: "plan_tpm", displayName: "TPM", scopeAllowlist: ["code"], policy, now });
    const entitlement = store.grantEntitlement({ subjectId: "s", planId: "plan_tpm", periodKind: "unlimited", now });
    const acquired = await limiter.acquire({ requestId: "existing", credentialId: credential.record.id,
      subjectId: "s", entitlementId: entitlement.id, scope: "code", upstreamAccountId: null,
      provider: null, policy, estimatedPromptTokens: 100, now });
    expect(acquired.ok).toBe(true);
    if (!acquired.ok) throw new Error("fixture reservation failed");
    await limiter.finalize({ reservationId: acquired.reservationId, now,
      usage: { promptTokens: 90, completionTokens: 10, totalTokens: 100 } });
    const unchangedTables = ["subjects", "token_reservations", "token_windows", "entitlement_token_windows", "token_settlements"];
    const before = unchangedTables.map(t => JSON.stringify(store.database.prepare(`SELECT * FROM ${t}`).all()));
    const trigger = store.database.prepare("SELECT sql FROM sqlite_master WHERE name='trg_plans_policy_immutable'").get() as { sql: string };
    const original = { ...policy, tokensPerMinute: tpm };
    store.database.exec("DROP TRIGGER trg_plans_policy_immutable");
    store.database.prepare("UPDATE plans SET policy_json=? WHERE id='plan_tpm'").run(JSON.stringify(original));
    store.database.exec(trigger.sql);
    store.database.prepare("UPDATE entitlements SET policy_snapshot_json=? WHERE id=?").run(JSON.stringify(original), entitlement.id);
    store.database.prepare("UPDATE access_credentials SET rate_json=? WHERE id=?")
      .run(JSON.stringify({ requestsPerMinute: 37, token: original }), credential.record.id);
    store.database.exec("DELETE FROM schema_migrations WHERE version=41");
    migrateGatewaySchema(store.database);
    migrateGatewaySchema(store.database);
    const expected = { ...original, tokensPerMinute: tpm === null ? null : Math.max(tpm, 600_000) };
    const read = (sql: string) => JSON.parse((store.database.prepare(sql).get() as { value: string }).value);
    expect(read("SELECT policy_json AS value FROM plans WHERE id='plan_tpm'")).toEqual(expected);
    expect(read("SELECT policy_snapshot_json AS value FROM entitlements WHERE plan_id='plan_tpm'")).toEqual(expected);
    expect(read("SELECT rate_json AS value FROM access_credentials")).toEqual({ requestsPerMinute: 37, token: expected });
    expect(unchangedTables.map(t => JSON.stringify(store.database.prepare(`SELECT * FROM ${t}`).all()))).toEqual(before);
    expect(store.database.prepare("SELECT sql FROM sqlite_master WHERE name='trg_plans_policy_immutable'").get()).toEqual(trigger);
    expect(() => store.database.exec("UPDATE plans SET policy_json=policy_json")).toThrow("immutable");
    expect(store.database.prepare("SELECT count(*) AS n FROM schema_migrations WHERE version=41").get()).toEqual({ n: 1 });
    expect(store.database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(validateTokenPolicy(original)).toEqual(expected);
  }
);

it("admits the reported long-context sequence, enforces 600K, and resets at the next minute", async () => {
  const { store, credential, limiter } = fixture();
  const acquire = (requestId: string, tokens: number, at = now) => limiter.acquire({ requestId,
    credentialId: credential.record.id, subjectId: "s", scope: "code", upstreamAccountId: null,
    provider: null, policy, estimatedPromptTokens: tokens, now: at });
  const first = await acquire("first", 215_421);
  if (!first.ok) throw new Error("first request rejected");
  await limiter.finalize({ reservationId: first.reservationId, now,
    usage: { promptTokens: 214_965, completionTokens: 456, totalTokens: 215_421 } });
  expect(await acquire("formerly-rejected", 123_303)).toMatchObject({ ok: true });
  expect(await acquire("boundary", 261_276)).toMatchObject({ ok: true });
  expect(await acquire("over", 1)).toMatchObject({ ok: false, limitKind: "token_minute",
    details: { limit: 600_000, used: 600_000, requested: 1 }, error: { retryAfterSeconds: 60 } });
  expect(await acquire("next-minute", 1, new Date(now.getTime() + 60_000))).toMatchObject({ ok: true });
  expect(store.database.prepare("SELECT count(*) AS n FROM token_reservations WHERE request_id='over'").get()).toEqual({ n: 0 });
});

it("issues new signup plans at the permanent floor without changing the free allowance", () => {
  expect(phoneSignupFreePlan(now).policy).toMatchObject({ tokensPerMinute: 600_000, tokensTotal: 1_000_000 });
});

it("rolls back all policy changes and trigger DDL if migration fails midway", () => {
  const { store } = fixture();
  store.createPlan({ id: "plan_rollback", displayName: "Rollback", scopeAllowlist: ["code"], policy, now });
  store.grantEntitlement({ subjectId: "s", planId: "plan_rollback", periodKind: "unlimited", now });
  const trigger = store.database.prepare("SELECT sql FROM sqlite_master WHERE name='trg_plans_policy_immutable'").get() as { sql: string };
  store.database.exec("DROP TRIGGER trg_plans_policy_immutable; UPDATE plans SET policy_json=json_set(policy_json,'$.tokensPerMinute',300000)");
  store.database.exec(trigger.sql);
  store.database.exec(`UPDATE entitlements SET policy_snapshot_json=json_set(policy_snapshot_json,'$.tokensPerMinute',300000);
    DELETE FROM schema_migrations WHERE version=41;
    CREATE TRIGGER fail_tpm_migration BEFORE UPDATE ON entitlements BEGIN SELECT RAISE(ABORT,'synthetic migration failure'); END;`);
  expect(() => migrateGatewaySchema(store.database)).toThrow("synthetic migration failure");
  expect(store.database.prepare("SELECT json_extract(policy_json,'$.tokensPerMinute') AS tpm FROM plans").get()).toEqual({ tpm: 300_000 });
  expect(store.database.prepare("SELECT sql FROM sqlite_master WHERE name='trg_plans_policy_immutable'").get()).toEqual(trigger);
  expect(store.database.prepare("SELECT count(*) AS n FROM schema_migrations WHERE version=41").get()).toEqual({ n: 0 });
});
