import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  issueAccessCredential,
  type ClientMessageEventRecord,
  type Subject,
  type Subscription
} from "@codex-gateway/core";
import {
  createSqliteClientEventsStore,
  createSqliteStore,
  type SqliteGatewayStore
} from "./index.js";

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
      name: "Alice Zhang",
      phoneNumber: "+15551234567",
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
      name: "Alice Zhang",
      phoneNumber: "+15551234567",
      state: "disabled"
    });
    const updated = store.updateSubject("alice", {
      label: "Alice managed",
      name: "Alice Chen",
      phoneNumber: null
    });
    expect(updated).toMatchObject({
      id: "alice",
      label: "Alice managed",
      name: "Alice Chen",
      phoneNumber: null,
      state: "disabled"
    });
    expect(store.listSubjects({ state: "active" }).map((subject) => subject.id)).toEqual([
      "subj_1"
    ]);
    expect(store.setSubjectState("missing", "disabled")).toBeNull();
    expect(store.updateSubject("missing", { name: "Nope" })).toBeNull();

    store.close();
  });

  it("does not overwrite subject state during bootstrap upserts", () => {
    const store = createSeededStore(":memory:");

    store.setSubjectState("subj_1", "disabled");
    store.upsertSubject({
      id: "subj_1",
      label: "Renamed Subject",
      name: "Test User",
      phoneNumber: "+15550000000",
      state: "active",
      createdAt: new Date("2026-01-02T00:00:00Z")
    });

    expect(store.getSubject("subj_1")).toMatchObject({
      id: "subj_1",
      label: "Renamed Subject",
      name: "Test User",
      phoneNumber: "+15550000000",
      state: "disabled"
    });

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

    store.insertAccessCredential({
      ...issued.record,
      tokenCiphertext: "v1.encrypted"
    });
    expect(store.getAccessCredentialByPrefix(issued.record.prefix)).toMatchObject({
      id: issued.record.id,
      prefix: issued.record.prefix,
      hash: issued.record.hash,
      tokenCiphertext: "v1.encrypted",
      subjectId: "subj_1",
      scope: "code"
    });
    expect(store.listAccessCredentials({ includeRevoked: false })).toHaveLength(1);

    const updated = store.updateAccessCredentialByPrefix(issued.record.prefix, {
      label: "Updated token",
      scope: "medical",
      expiresAt: new Date("2026-03-01T00:00:00Z"),
      rate: {
        requestsPerMinute: 5,
        requestsPerDay: 20,
        concurrentRequests: 2
      }
    });
    expect(updated).toMatchObject({
      id: issued.record.id,
      label: "Updated token",
      scope: "medical",
      rate: {
        requestsPerMinute: 5,
        requestsPerDay: 20,
        concurrentRequests: 2
      }
    });
    expect(updated?.expiresAt.toISOString()).toBe("2026-03-01T00:00:00.000Z");
    expect(store.updateAccessCredentialByPrefix("missing", { label: "Nope" })).toBeNull();

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
      rateLimited: true,
      promptTokens: 10,
      completionTokens: 2,
      totalTokens: 12,
      cachedPromptTokens: 4,
      estimatedTokens: null,
      usageSource: "provider"
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
        rateLimited: true,
        promptTokens: 10,
        completionTokens: 2,
        totalTokens: 12,
        cachedPromptTokens: 4,
        estimatedTokens: null,
        usageSource: "provider"
      }
    ]);
    store.close();
  });

  it("refreshes request event timestamps when a request id is reused", () => {
    const store = createSeededStore(":memory:");
    const event = {
      requestId: "req_reused",
      credentialId: "cred_1",
      subjectId: "subj_1",
      scope: "code" as const,
      sessionId: "sess_1",
      subscriptionId: "sub_openai_codex",
      provider: "openai-codex" as const,
      startedAt: new Date("2026-01-01T00:00:00Z"),
      durationMs: 25,
      firstByteMs: 10,
      status: "ok" as const,
      errorCode: null,
      rateLimited: false,
      promptTokens: 10,
      completionTokens: 2,
      totalTokens: 12,
      cachedPromptTokens: 4,
      estimatedTokens: null,
      usageSource: "provider" as const
    };

    store.insertRequestEvent(event);
    store.insertRequestEvent({
      ...event,
      startedAt: new Date("2026-01-02T00:00:00Z"),
      promptTokens: 20,
      completionTokens: 3,
      totalTokens: 23
    });

    expect(store.listRequestEvents({ credentialId: "cred_1" })).toMatchObject([
      {
        requestId: "req_reused",
        startedAt: new Date("2026-01-02T00:00:00Z"),
        promptTokens: 20,
        completionTokens: 3,
        totalTokens: 23
      }
    ]);
    expect(
      store.reportRequestUsage({
        subjectId: "subj_1",
        since: new Date("2026-01-02T00:00:00Z"),
        until: new Date("2026-01-03T00:00:00Z")
      })
    ).toMatchObject([
      {
        date: "2026-01-02",
        totalTokens: 23
      }
    ]);
    store.close();
  });

  it("persists and filters admin audit events", () => {
    const store = createSeededStore(":memory:");
    store.insertAdminAuditEvent({
      id: "audit_1",
      action: "issue",
      targetUserId: "alice",
      targetCredentialId: "cred_1",
      targetCredentialPrefix: "prefix_1",
      status: "ok",
      params: {
        scope: "code",
        rpm: 30
      },
      errorMessage: null,
      createdAt: new Date("2026-01-01T00:00:00Z")
    });
    store.insertAdminAuditEvent({
      id: "audit_2",
      action: "disable-user",
      targetUserId: "bob",
      targetCredentialId: null,
      targetCredentialPrefix: null,
      status: "error",
      params: null,
      errorMessage: "User not found: bob",
      createdAt: new Date("2026-01-02T00:00:00Z")
    });

    expect(store.listAdminAuditEvents({ userId: "alice" })).toEqual([
      {
        id: "audit_1",
        action: "issue",
        targetUserId: "alice",
        targetCredentialId: "cred_1",
        targetCredentialPrefix: "prefix_1",
        status: "ok",
        params: {
          scope: "code",
          rpm: 30
        },
        errorMessage: null,
        createdAt: new Date("2026-01-01T00:00:00Z")
      }
    ]);
    expect(store.listAdminAuditEvents({ status: "error" })).toMatchObject([
      {
        id: "audit_2",
        action: "disable-user",
        targetUserId: "bob",
        status: "error",
        errorMessage: "User not found: bob"
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
      rateLimited: false,
      promptTokens: 10,
      completionTokens: 2,
      totalTokens: 12,
      cachedPromptTokens: 4,
      estimatedTokens: null,
      usageSource: "provider"
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
        avgFirstByteMs: 15,
        promptTokens: 10,
        completionTokens: 2,
        totalTokens: 12,
        cachedPromptTokens: 4,
        estimatedTokens: 0
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

describe("SqliteClientEventsStore", () => {
  it("migrates idempotently and persists client message events", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "codex-gateway-client-events-"));
    cleanupDirs.push(dir);
    const dbPath = path.join(dir, "client-events.db");

    const first = createSqliteClientEventsStore({ path: dbPath });
    first.insertClientMessageEvent(clientMessageEventRecord());
    first.close();

    const second = createSqliteClientEventsStore({ path: dbPath });
    expect(second.getClientMessageEvent("subj_1", "evt_1")).toMatchObject({
      id: "cme_1",
      eventId: "evt_1",
      requestId: "req_1",
      credentialId: "cred_1",
      subjectId: "subj_1",
      scope: "code",
      sessionId: "ses_1",
      messageId: "msg_1",
      text: "What is the evidence?",
      textSha256: "0".repeat(64),
      attachmentsJson: "[]",
      appName: "medevidence-desktop",
      appVersion: "1.4.6"
    });
    second.close();
  });

  it("keeps subject-scoped event ids unique without overwriting existing rows", () => {
    const store = createSqliteClientEventsStore({ path: ":memory:" });
    store.insertClientMessageEvent(clientMessageEventRecord());

    expect(() =>
      store.insertClientMessageEvent({
        ...clientMessageEventRecord(),
        id: "cme_conflict",
        requestId: "req_conflict",
        text: "Changed text",
        textSha256: "1".repeat(64)
      })
    ).toThrow();
    expect(store.getClientMessageEvent("subj_1", "evt_1")?.text).toBe(
      "What is the evidence?"
    );

    store.insertClientMessageEvent(
      clientMessageEventRecord({
        id: "cme_other_subject",
        subjectId: "subj_2"
      })
    );
    expect(store.getClientMessageEvent("subj_2", "evt_1")?.id).toBe("cme_other_subject");
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

function clientMessageEventRecord(
  overrides: Partial<ClientMessageEventRecord> = {}
): ClientMessageEventRecord {
  return {
    id: "cme_1",
    eventId: "evt_1",
    requestId: "req_1",
    credentialId: "cred_1",
    subjectId: "subj_1",
    scope: "code",
    sessionId: "ses_1",
    messageId: "msg_1",
    agent: "research",
    providerId: "medcode",
    modelId: "medcode",
    engine: "agent",
    text: "What is the evidence?",
    textSha256: "0".repeat(64),
    attachmentsJson: "[]",
    appName: "medevidence-desktop",
    appVersion: "1.4.6",
    createdAt: new Date("2026-04-29T10:00:00Z"),
    receivedAt: new Date("2026-04-29T10:00:01Z"),
    ...overrides
  };
}
