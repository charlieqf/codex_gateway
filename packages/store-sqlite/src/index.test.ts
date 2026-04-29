import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  issueAccessCredential,
  type ClientMessageEventRecord,
  type Subject,
  type UpstreamAccount
} from "@codex-gateway/core";
import {
  createSqliteClientEventsStore,
  createSqliteTokenBudgetLimiter,
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
      upstreamAccountId: "sub_openai_codex"
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

  it("migrates legacy upstream account tables and columns without stdout", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "codex-gateway-store-legacy-"));
    cleanupDirs.push(dir);
    const dbPath = path.join(dir, "gateway.db");
    createLegacyUpstreamAccountDb(dbPath);

    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    let store: SqliteGatewayStore | undefined;
    try {
      store = createSqliteStore({ path: dbPath });
      expect(stdoutWrite).not.toHaveBeenCalled();
      expect(store.get("sess_legacy")).toMatchObject({
        id: "sess_legacy",
        upstreamAccountId: "sub_legacy"
      });
      expect(store.listRequestEvents()).toMatchObject([
        {
          requestId: "req_legacy",
          upstreamAccountId: "sub_legacy"
        }
      ]);
    } finally {
      store?.close();
      stdoutWrite.mockRestore();
    }

    const db = new DatabaseSync(dbPath);
    try {
      expect(tableExists(db, "upstream_accounts")).toBe(true);
      expect(tableExists(db, "subscriptions")).toBe(false);
      expect(columnNames(db, "sessions")).toContain("upstream_account_id");
      expect(columnNames(db, "sessions")).not.toContain("subscription_id");
      expect(columnNames(db, "request_events")).toContain("upstream_account_id");
      expect(columnNames(db, "request_events")).not.toContain("subscription_id");
    } finally {
      db.close();
    }
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
      upstreamAccountId: "sub_openai_codex",
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
        upstreamAccountId: "sub_openai_codex",
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
      upstreamAccountId: "sub_openai_codex",
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
      upstreamAccountId: "sub_openai_codex",
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
      upstreamAccountId: "sub_openai_codex",
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
      upstreamAccountId: "sub_openai_codex",
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
      upstreamAccountId: "sub_openai_codex",
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
        upstreamAccountId: "sub_openai_codex",
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
        estimatedTokens: 0,
        rateLimitedBy: {
          request_minute: 0,
          request_day: 0,
          concurrency: 0,
          token_minute: 0,
          token_day: 0,
          token_month: 0,
          token_request_prompt: 0,
          token_request_total: 0
        },
        overRequestLimit: 0,
        identityGuardHit: 0
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

  it("reports token usage from token reservations, not request event token copies", async () => {
    const store = createSeededStore(":memory:");
    const issued = issueAccessCredential({
      subjectId: "subj_1",
      label: "Token budget credential",
      scope: "code",
      expiresAt: new Date("2030-01-01T00:00:00Z"),
      rate: {
        requestsPerMinute: 30,
        requestsPerDay: null,
        concurrentRequests: 1,
        token: {
          tokensPerMinute: 1_000,
          tokensPerDay: 10_000,
          tokensPerMonth: null,
          maxPromptTokensPerRequest: null,
          maxTotalTokensPerRequest: null,
          reserveTokensPerRequest: 20,
          missingUsageCharge: "reserve"
        }
      }
    });
    store.insertAccessCredential(issued.record);

    const limiter = createSqliteTokenBudgetLimiter({ db: store.database });
    const acquired = await limiter.acquire({
      requestId: "req_token",
      credentialId: issued.record.id,
      subjectId: "subj_1",
      scope: "code",
      upstreamAccountId: "sub_openai_codex",
      provider: "openai-codex",
      policy: issued.record.rate.token!,
      estimatedPromptTokens: 5,
      now: new Date("2026-01-01T00:00:00Z")
    });
    expect(acquired.ok).toBe(true);
    if (!acquired.ok) {
      throw new Error("token acquire unexpectedly failed");
    }
    await limiter.finalize({
      reservationId: acquired.reservationId,
      usage: {
        promptTokens: 10,
        completionTokens: 2,
        totalTokens: 12,
        cachedPromptTokens: 4
      },
      now: new Date("2026-01-01T00:00:01Z")
    });
    store.insertRequestEvent({
      requestId: "req_token",
      credentialId: issued.record.id,
      subjectId: "subj_1",
      scope: "code",
      sessionId: "sess_1",
      upstreamAccountId: "sub_openai_codex",
      provider: "openai-codex",
      startedAt: new Date("2026-01-01T00:00:00Z"),
      durationMs: 10,
      firstByteMs: 5,
      status: "ok",
      errorCode: null,
      rateLimited: false,
      reservationId: acquired.reservationId
    });

    expect(
      store.reportRequestUsage({
        since: new Date("2026-01-01T00:00:00Z"),
        until: new Date("2026-01-02T00:00:00Z"),
        credentialId: issued.record.id
      })[0]
    ).toMatchObject({
      requests: 1,
      promptTokens: 10,
      completionTokens: 2,
      totalTokens: 12,
      cachedPromptTokens: 4
    });

    store.close();
  });

  it("cleans up stale soft-write reservations without charging tokens", async () => {
    const store = createSeededStore(":memory:");
    const issued = issueAccessCredential({
      subjectId: "subj_1",
      label: "Legacy credential",
      scope: "code",
      expiresAt: new Date("2030-01-01T00:00:00Z")
    });
    store.insertAccessCredential(issued.record);

    const limiter = createSqliteTokenBudgetLimiter({ db: store.database });
    const softWrite = await limiter.beginSoftWrite({
      requestId: "req_soft_crash",
      credentialId: issued.record.id,
      subjectId: "subj_1",
      scope: "code",
      upstreamAccountId: "sub_openai_codex",
      provider: "openai-codex",
      now: new Date("2026-01-01T00:00:00Z")
    });
    const cleanup = await limiter.cleanupExpired(new Date("2026-01-01T02:00:00Z"));
    const reservation = limiter.listReservations({
      subjectId: "subj_1",
      includeFinalized: true,
      limit: 1
    })[0];

    expect(cleanup).toEqual({
      count: 1,
      sampleIds: [softWrite.reservationId]
    });
    expect(reservation).toMatchObject({
      id: softWrite.reservationId,
      kind: "soft_write",
      finalUsageSource: "none",
      finalTotalTokens: 0
    });
    expect(reservation.finalizedAt).not.toBeNull();

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
  store.upsertUpstreamAccount(upstreamAccount());
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

function upstreamAccount(): UpstreamAccount {
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

function createLegacyUpstreamAccountDb(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
      INSERT INTO schema_migrations (version, applied_at) VALUES
        (1, '2026-01-01T00:00:00.000Z'),
        (2, '2026-01-01T00:00:00.000Z'),
        (3, '2026-01-01T00:00:00.000Z'),
        (4, '2026-01-01T00:00:00.000Z'),
        (5, '2026-01-01T00:00:00.000Z'),
        (6, '2026-01-01T00:00:00.000Z');

      CREATE TABLE subjects (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        state TEXT NOT NULL,
        created_at TEXT NOT NULL,
        name TEXT,
        phone_number TEXT
      );
      CREATE TABLE subscriptions (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        label TEXT NOT NULL,
        credential_ref TEXT NOT NULL,
        state TEXT NOT NULL,
        health_json TEXT,
        last_used_at TEXT,
        cooldown_until TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        subject_id TEXT NOT NULL,
        subscription_id TEXT NOT NULL,
        provider_session_ref TEXT,
        title TEXT,
        state TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(subject_id) REFERENCES subjects(id),
        FOREIGN KEY(subscription_id) REFERENCES subscriptions(id)
      );
      CREATE TABLE request_events (
        request_id TEXT PRIMARY KEY,
        credential_id TEXT,
        subject_id TEXT,
        scope TEXT,
        session_id TEXT,
        subscription_id TEXT,
        provider TEXT,
        started_at TEXT NOT NULL,
        duration_ms INTEGER,
        first_byte_ms INTEGER,
        status TEXT NOT NULL,
        error_code TEXT,
        rate_limited INTEGER NOT NULL DEFAULT 0,
        prompt_tokens INTEGER,
        completion_tokens INTEGER,
        total_tokens INTEGER,
        cached_prompt_tokens INTEGER,
        estimated_tokens INTEGER,
        usage_source TEXT
      );

      INSERT INTO subjects (id, label, state, created_at)
        VALUES ('subj_legacy', 'Legacy Subject', 'active', '2026-01-01T00:00:00.000Z');
      INSERT INTO subscriptions (
        id, provider, label, credential_ref, state, created_at, updated_at
      ) VALUES (
        'sub_legacy', 'openai-codex', 'Legacy Codex', 'CODEX_HOME', 'active',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      );
      INSERT INTO sessions (
        id, subject_id, subscription_id, provider_session_ref, title, state, created_at, updated_at
      ) VALUES (
        'sess_legacy', 'subj_legacy', 'sub_legacy', 'thread_legacy', 'Legacy', 'active',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      );
      INSERT INTO request_events (
        request_id, subject_id, session_id, subscription_id, provider, started_at, status
      ) VALUES (
        'req_legacy', 'subj_legacy', 'sess_legacy', 'sub_legacy', 'openai-codex',
        '2026-01-01T00:00:00.000Z', 'ok'
      );
    `);
  } finally {
    db.close();
  }
}

function tableExists(db: DatabaseSync, table: string): boolean {
  return Boolean(
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)
  );
}

function columnNames(db: DatabaseSync, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
    (row) => row.name
  );
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
