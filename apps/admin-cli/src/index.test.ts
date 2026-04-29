import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSqliteStore } from "@codex-gateway/store-sqlite";

const cleanupDirs: string[] = [];

afterEach(() => {
  for (const dir of cleanupDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("codex-gateway-admin user API key operations", () => {
  it("issues, lists, reports, disables, and enables API keys by user", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "codex-gateway-admin-"));
    cleanupDirs.push(dir);
    const dbPath = path.join(dir, "gateway.db");

    const issued = runCli(dbPath, [
      "issue",
      "--user",
      "alice",
      "--name",
      "Alice Zhang",
      "--phone",
      "+15551234567",
      "--label",
      "Alice laptop",
      "--scope",
      "code",
      "--rpm",
      "2",
      "--rpd",
      "10",
      "--concurrent",
      "1"
    ]) as {
      token: string;
      credential: {
        id: string;
        prefix: string;
        user_id: string;
        subject_id: string;
        label: string;
        scope: string;
        status: string;
        is_currently_valid: boolean;
        expires_at: string;
        user: {
          id: string;
          name: string | null;
          phone_number: string | null;
        };
        rate: {
          requestsPerMinute: number;
          requestsPerDay: number | null;
          concurrentRequests: number | null;
        };
      };
    };

    expect(issued.token).toContain(issued.credential.prefix);
    expect(issued.credential).toMatchObject({
      user_id: "alice",
      subject_id: "alice",
      status: "active",
      is_currently_valid: true,
      user: {
        id: "alice",
        name: "Alice Zhang",
        phone_number: "+15551234567"
      },
      rate: {
        requestsPerMinute: 2,
        requestsPerDay: 10,
        concurrentRequests: 1
      }
    });

    const updatedKey = runCli(dbPath, [
      "update-key",
      issued.credential.prefix,
      "--label",
      "Alice tablet",
      "--scope",
      "medical",
      "--expires-at",
      "2099-06-01T00:00:00Z",
      "--rpm",
      "5",
      "--rpd",
      "none",
      "--concurrent",
      "2"
    ]) as {
      credential: {
        id: string;
        prefix: string;
        user_id: string;
        label: string;
        scope: string;
        expires_at: string;
        rate: {
          requestsPerMinute: number;
          requestsPerDay: number | null;
          concurrentRequests: number | null;
        };
      };
    };
    expect(updatedKey.credential).toMatchObject({
      id: issued.credential.id,
      prefix: issued.credential.prefix,
      user_id: "alice",
      label: "Alice tablet",
      scope: "medical",
      expires_at: "2099-06-01T00:00:00.000Z",
      rate: {
        requestsPerMinute: 5,
        requestsPerDay: null,
        concurrentRequests: 2
      }
    });

    const users = runCli(dbPath, ["list-users"]) as {
      users: Array<{ id: string; name: string | null; phone_number: string | null }>;
    };
    expect(users.users.map((user) => user.id)).toEqual(["alice"]);
    expect(users.users[0]).toMatchObject({
      name: "Alice Zhang",
      phone_number: "+15551234567"
    });

    const updatedUser = runCli(dbPath, [
      "update-user",
      "alice",
      "--name",
      "Alice Chen",
      "--phone",
      "+15557654321"
    ]) as {
      user: { id: string; name: string | null; phone_number: string | null };
    };
    expect(updatedUser.user).toMatchObject({
      id: "alice",
      name: "Alice Chen",
      phone_number: "+15557654321"
    });

    const keys = runCli(dbPath, ["list", "--user", "alice", "--active-only"]) as {
      credentials: Array<{
        prefix: string;
        user_id: string;
        status: string;
        is_currently_valid: boolean;
        user: { name: string | null; phone_number: string | null };
      }>;
    };
    expect(keys.credentials).toEqual([
      {
        ...keys.credentials[0],
        prefix: issued.credential.prefix,
        user_id: "alice",
        status: "active",
        is_currently_valid: true,
        user: {
          ...keys.credentials[0].user,
          name: "Alice Chen",
          phone_number: "+15557654321"
        }
      }
    ]);

    const activeKeys = runCli(dbPath, ["list-active-keys"]) as {
      credentials: Array<{
        prefix: string;
        user: { id: string; name: string | null; phone_number: string | null };
      }>;
    };
    expect(activeKeys.credentials).toEqual([
      {
        ...activeKeys.credentials[0],
        prefix: issued.credential.prefix,
        user: {
          ...activeKeys.credentials[0].user,
          id: "alice",
          name: "Alice Chen",
          phone_number: "+15557654321"
        }
      }
    ]);

    const revealed = runCli(dbPath, ["reveal-key", issued.credential.prefix]) as {
      credential: { prefix: string; token: string; token_available: boolean };
    };
    expect(revealed.credential).toMatchObject({
      prefix: issued.credential.prefix,
      token: issued.token,
      token_available: true
    });

    const revealedActive = runCli(dbPath, ["reveal-keys", "--active-only"]) as {
      credentials: Array<{ prefix: string; token: string }>;
    };
    expect(revealedActive.credentials).toEqual([
      {
        ...revealedActive.credentials[0],
        prefix: issued.credential.prefix,
        token: issued.token
      }
    ]);

    const store = createSqliteStore({ path: dbPath });
    store.insertRequestEvent({
      requestId: "req_1",
      credentialId: issued.credential.id,
      subjectId: "alice",
      scope: "code",
      sessionId: "sess_1",
      upstreamAccountId: "sub_openai_codex",
      provider: "openai-codex",
      startedAt: new Date("2026-01-01T00:00:00Z"),
      durationMs: 20,
      firstByteMs: 10,
      status: "ok",
      errorCode: null,
      rateLimited: false
    });
    store.close();

    const events = runCli(dbPath, ["events", "--user", "alice"]) as {
      events: Array<{ request_id: string; subject_id: string; upstream_account_id: string }>;
    };
    expect(events.events).toEqual([
      {
        ...events.events[0],
        request_id: "req_1",
        subject_id: "alice",
        upstream_account_id: "sub_openai_codex"
      }
    ]);

    const usage = runCli(dbPath, [
      "report-usage",
      "--user",
      "alice",
      "--since",
      "2026-01-01T00:00:00Z",
      "--until",
      "2026-01-02T00:00:00Z"
    ]) as {
      rows: Array<{
        subject_id: string;
        upstream_account_id: string;
        requests: number;
        ok: number;
      }>;
    };
    expect(usage.rows).toEqual([
      {
        ...usage.rows[0],
        subject_id: "alice",
        upstream_account_id: "sub_openai_codex",
        requests: 1,
        ok: 1
      }
    ]);

    const disabled = runCli(dbPath, ["disable-user", "alice"]) as {
      user: { id: string; state: string };
    };
    expect(disabled.user).toMatchObject({ id: "alice", state: "disabled" });
    expect(() =>
      runCli(dbPath, ["issue", "--user", "alice", "--label", "blocked", "--scope", "code"])
    ).toThrow();

    const enabled = runCli(dbPath, ["enable-user", "alice"]) as {
      user: { id: string; state: string };
    };
    expect(enabled.user).toMatchObject({ id: "alice", state: "active" });

    const audit = runCli(dbPath, ["audit", "--user", "alice", "--limit", "10"]) as {
      events: Array<{
        action: string;
        target_user_id: string;
        target_credential_prefix: string | null;
        status: string;
        error_message: string | null;
        params: Record<string, unknown> | null;
      }>;
    };
    expect(audit.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "issue",
          target_user_id: "alice",
          target_credential_prefix: issued.credential.prefix,
          status: "ok",
          error_message: null
        }),
        expect.objectContaining({
          action: "update-key",
          target_user_id: "alice",
          target_credential_prefix: issued.credential.prefix,
          status: "ok",
          error_message: null
        }),
        expect.objectContaining({
          action: "update-user",
          target_user_id: "alice",
          status: "ok",
          error_message: null
        }),
        expect.objectContaining({
          action: "reveal-key",
          target_user_id: "alice",
          target_credential_prefix: issued.credential.prefix,
          status: "ok",
          error_message: null
        }),
        expect.objectContaining({
          action: "disable-user",
          target_user_id: "alice",
          status: "ok",
          error_message: null
        }),
        expect.objectContaining({
          action: "issue",
          target_user_id: "alice",
          status: "error",
          error_message: "User is disabled; enable the user before issuing a new API key."
        }),
        expect.objectContaining({
          action: "enable-user",
          target_user_id: "alice",
          status: "ok",
          error_message: null
        })
      ])
    );
    expect(JSON.stringify(audit.events)).not.toContain(issued.token);

    const issueAudit = runCli(dbPath, ["audit", "--action", "issue", "--status", "ok"]) as {
      events: Array<{ action: string; status: string; params: Record<string, unknown> }>;
    };
    expect(issueAudit.events).toHaveLength(1);
    expect(issueAudit.events[0]).toMatchObject({
      action: "issue",
      status: "ok",
      params: {
        label: "Alice laptop",
        scope: "code"
      }
    });

    const updateAudit = runCli(dbPath, ["audit", "--action", "update-key", "--status", "ok"]) as {
      events: Array<{
        action: string;
        status: string;
        params: {
          before: {
            label: string;
            scope: string;
            rate: { requestsPerMinute: number; requestsPerDay: number | null };
          };
          after: {
            label: string;
            scope: string;
            rate: { requestsPerMinute: number; requestsPerDay: number | null };
          };
        };
      }>;
    };
    expect(updateAudit.events).toHaveLength(1);
    expect(updateAudit.events[0]).toMatchObject({
      action: "update-key",
      status: "ok",
      params: {
        before: {
          label: "Alice laptop",
          scope: "code",
          rate: {
            requestsPerMinute: 2,
            requestsPerDay: 10
          }
        },
        after: {
          label: "Alice tablet",
          scope: "medical",
          rate: {
            requestsPerMinute: 5,
            requestsPerDay: null
          }
        }
      }
    });

    const trialCheck = runCli(dbPath, ["trial-check", "--max-active-users", "2"]) as {
      ready_for_controlled_trial: boolean;
      summary: {
        active_users: number;
        active_api_keys: number;
        uncapped_active_api_keys: number;
      };
      checks: Array<{ name: string; status: string }>;
    };
    expect(trialCheck.ready_for_controlled_trial).toBe(true);
    expect(trialCheck.summary).toMatchObject({
      active_users: 1,
      active_api_keys: 1,
      uncapped_active_api_keys: 1
    });
    expect(trialCheck.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "sqlite_db", status: "ok" }),
        expect.objectContaining({ name: "active_user_count", status: "ok" }),
        expect.objectContaining({ name: "active_api_keys", status: "ok" }),
        expect.objectContaining({ name: "api_key_limits", status: "warning" }),
        expect.objectContaining({ name: "audit_trail", status: "ok" })
      ])
    );
  }, 20_000);

  it("keeps stdout as clean JSON when migrating a legacy request-event database", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "codex-gateway-admin-legacy-"));
    cleanupDirs.push(dir);
    const dbPath = path.join(dir, "gateway.db");
    createLegacyUpstreamAccountDb(dbPath);

    const raw = runCliRaw(dbPath, ["events", "--limit", "1"]);
    const parsed = JSON.parse(raw) as {
      events: Array<{ request_id: string; upstream_account_id: string }>;
    };

    expect(parsed.events).toEqual([
      {
        ...parsed.events[0],
        request_id: "req_legacy",
        upstream_account_id: "sub_legacy"
      }
    ]);
    expect(raw).not.toContain("schema migrated");
  });
});

function runCli(dbPath: string, args: string[]): unknown {
  return JSON.parse(runCliRaw(dbPath, args));
}

function runCliRaw(dbPath: string, args: string[]): string {
  return execFileSync(
    process.execPath,
    ["--import", "tsx", path.resolve("apps/admin-cli/src/index.ts"), "--db", dbPath, ...args],
    {
      cwd: path.resolve("."),
      env: {
        ...process.env,
        GATEWAY_API_KEY_ENCRYPTION_SECRET: "test-api-key-encryption-secret"
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
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
        VALUES ('alice', 'Alice', 'active', '2026-01-01T00:00:00.000Z');
      INSERT INTO subscriptions (
        id, provider, label, credential_ref, state, created_at, updated_at
      ) VALUES (
        'sub_legacy', 'openai-codex', 'Legacy Codex', 'CODEX_HOME', 'active',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      );
      INSERT INTO request_events (
        request_id, subject_id, scope, subscription_id, provider, started_at, status
      ) VALUES (
        'req_legacy', 'alice', 'code', 'sub_legacy', 'openai-codex',
        '2026-01-01T00:00:00.000Z', 'ok'
      );
    `);
  } finally {
    db.close();
  }
}
