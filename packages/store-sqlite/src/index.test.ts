import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { issueAccessCredential, type Subject, type Subscription } from "@codex-gateway/core";
import { createSqliteStore, type SqliteGatewayStore } from "./index.js";

const cleanupDirs: string[] = [];

afterEach(() => {
  for (const dir of cleanupDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("SqliteGatewayStore", () => {
  it("migrates idempotently and persists sessions", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "codex-gateway-store-"));
    cleanupDirs.push(dir);
    const dbPath = path.join(dir, "gateway.db");

    const first = createSeededStore(dbPath);
    const session = first.create({
      subjectId: "subj_1",
      subscriptionId: "sub_openai_codex"
    });
    expect(session.providerSessionRef).toBeNull();

    const updated = first.setProviderSessionRef(session.id, "thread_1");
    expect(updated?.providerSessionRef).toBe("thread_1");
    first.close();

    const second = createSeededStore(dbPath);
    expect(second.get(session.id)?.providerSessionRef).toBe("thread_1");
    expect(second.list("subj_1").map((item) => item.id)).toEqual([session.id]);
    second.close();
  });

  it("returns null when updating an unknown session", () => {
    const store = createSeededStore(":memory:");
    expect(store.setProviderSessionRef("missing", "thread_1")).toBeNull();
    store.close();
  });

  it("lists users and updates user state", () => {
    const store = createSeededStore(":memory:");
    store.upsertSubject({
      id: "alice",
      label: "Alice",
      state: "active",
      createdAt: new Date("2026-01-02T00:00:00Z")
    });

    expect(store.listSubjects({ state: "active" }).map((subject) => subject.id)).toEqual([
      "alice",
      "subj_1"
    ]);

    const disabled = store.setSubjectState("alice", "disabled");
    expect(disabled).toMatchObject({
      id: "alice",
      label: "Alice",
      state: "disabled"
    });
    expect(store.listSubjects({ state: "active" }).map((subject) => subject.id)).toEqual([
      "subj_1"
    ]);
    expect(store.setSubjectState("missing", "disabled")).toBeNull();

    store.close();
  });

  it("persists and revokes access credentials", () => {
    const store = createSeededStore(":memory:");
    const issued = issueAccessCredential({
      subjectId: "subj_1",
      label: "Gateway token",
      scope: "code",
      expiresAt: new Date("2026-02-01T00:00:00Z"),
      now: new Date("2026-01-01T00:00:00Z")
    });

    store.insertAccessCredential(issued.record);
    expect(store.getAccessCredentialByPrefix(issued.record.prefix)).toMatchObject({
      id: issued.record.id,
      prefix: issued.record.prefix,
      hash: issued.record.hash,
      subjectId: "subj_1",
      scope: "code"
    });
    expect(store.listAccessCredentials({ includeRevoked: false })).toHaveLength(1);

    const revoked = store.revokeAccessCredentialByPrefix(
      issued.record.prefix,
      new Date("2026-01-02T00:00:00Z")
    );
    expect(revoked?.revokedAt?.toISOString()).toBe("2026-01-02T00:00:00.000Z");
    expect(store.listAccessCredentials({ includeRevoked: false })).toHaveLength(0);

    const expiring = store.setAccessCredentialExpiresAtByPrefix(
      issued.record.prefix,
      new Date("2026-01-03T00:00:00Z")
    );
    expect(expiring?.expiresAt.toISOString()).toBe("2026-01-03T00:00:00.000Z");
    store.close();
  });

  it("persists request events", () => {
    const store = createSeededStore(":memory:");
    store.insertRequestEvent({
      requestId: "req_1",
      credentialId: "cred_1",
      subjectId: "subj_1",
      scope: "code",
      sessionId: "sess_1",
      subscriptionId: "sub_openai_codex",
      provider: "openai-codex",
      startedAt: new Date("2026-01-01T00:00:00Z"),
      durationMs: 25,
      firstByteMs: 10,
      status: "error",
      errorCode: "rate_limited",
      rateLimited: true
    });

    expect(store.listRequestEvents()).toMatchObject([
      {
        requestId: "req_1",
        credentialId: "cred_1",
        subjectId: "subj_1",
        scope: "code",
        sessionId: "sess_1",
        subscriptionId: "sub_openai_codex",
        provider: "openai-codex",
        durationMs: 25,
        firstByteMs: 10,
        status: "error",
        errorCode: "rate_limited",
        rateLimited: true
      }
    ]);
    store.close();
  });

  it("reports usage and prunes old request events", () => {
    const store = createSeededStore(":memory:");
    store.insertRequestEvent({
      requestId: "req_old",
      credentialId: "cred_1",
      subjectId: "subj_1",
      scope: "code",
      sessionId: null,
      subscriptionId: "sub_openai_codex",
      provider: "openai-codex",
      startedAt: new Date("2025-12-31T23:59:59Z"),
      durationMs: 10,
      firstByteMs: 5,
      status: "ok",
      errorCode: null,
      rateLimited: false
    });
    store.insertRequestEvent({
      requestId: "req_ok",
      credentialId: "cred_1",
      subjectId: "subj_1",
      scope: "code",
      sessionId: "sess_1",
      subscriptionId: "sub_openai_codex",
      provider: "openai-codex",
      startedAt: new Date("2026-01-01T00:00:00Z"),
      durationMs: 20,
      firstByteMs: 10,
      status: "ok",
      errorCode: null,
      rateLimited: false
    });
    store.insertRequestEvent({
      requestId: "req_limited",
      credentialId: "cred_1",
      subjectId: "subj_1",
      scope: "code",
      sessionId: "sess_1",
      subscriptionId: "sub_openai_codex",
      provider: "openai-codex",
      startedAt: new Date("2026-01-01T00:01:00Z"),
      durationMs: 40,
      firstByteMs: 20,
      status: "error",
      errorCode: "rate_limited",
      rateLimited: true
    });
    store.insertRequestEvent({
      requestId: "req_other_credential",
      credentialId: "cred_2",
      subjectId: "subj_1",
      scope: "code",
      sessionId: null,
      subscriptionId: "sub_openai_codex",
      provider: "openai-codex",
      startedAt: new Date("2026-01-02T00:00:00Z"),
      durationMs: 100,
      firstByteMs: 50,
      status: "ok",
      errorCode: null,
      rateLimited: false
    });

    expect(
      store.reportRequestUsage({
        since: new Date("2026-01-01T00:00:00Z"),
        until: new Date("2026-01-03T00:00:00Z"),
        credentialId: "cred_1"
      })
    ).toEqual([
      {
        date: "2026-01-01",
        credentialId: "cred_1",
        subjectId: "subj_1",
        scope: "code",
        subscriptionId: "sub_openai_codex",
        provider: "openai-codex",
        requests: 2,
        ok: 1,
        errors: 1,
        rateLimited: 1,
        avgDurationMs: 30,
        avgFirstByteMs: 15
      }
    ]);

    const dryRun = store.pruneRequestEvents({
      before: new Date("2026-01-01T00:00:00Z"),
      dryRun: true
    });
    expect(dryRun).toEqual({
      before: new Date("2026-01-01T00:00:00Z"),
      dryRun: true,
      matched: 1,
      deleted: 0
    });
    expect(store.listRequestEvents({ limit: 10 }).map((event) => event.requestId)).toContain(
      "req_old"
    );

    const pruned = store.pruneRequestEvents({
      before: new Date("2026-01-01T00:00:00Z")
    });
    expect(pruned).toEqual({
      before: new Date("2026-01-01T00:00:00Z"),
      dryRun: false,
      matched: 1,
      deleted: 1
    });
    expect(store.listRequestEvents({ limit: 10 }).map((event) => event.requestId)).not.toContain(
      "req_old"
    );
    store.close();
  });
});

function createSeededStore(dbPath: string): SqliteGatewayStore {
  const store = createSqliteStore({ path: dbPath });
  store.upsertSubject(subject());
  store.upsertSubscription(subscription());
  return store;
}

function subject(): Subject {
  return {
    id: "subj_1",
    label: "Test Subject",
    state: "active",
    createdAt: new Date("2026-01-01T00:00:00Z")
  };
}

function subscription(): Subscription {
  return {
    id: "sub_openai_codex",
    provider: "openai-codex",
    label: "Codex",
    credentialRef: "CODEX_HOME",
    state: "active",
    lastUsedAt: null,
    cooldownUntil: null
  };
}
