import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
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
        expires_at: string;
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
      "2026-06-01T00:00:00Z",
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
      expires_at: "2026-06-01T00:00:00.000Z",
      rate: {
        requestsPerMinute: 5,
        requestsPerDay: null,
        concurrentRequests: 2
      }
    });

    const users = runCli(dbPath, ["list-users"]) as { users: Array<{ id: string }> };
    expect(users.users.map((user) => user.id)).toEqual(["alice"]);

    const keys = runCli(dbPath, ["list", "--user", "alice", "--active-only"]) as {
      credentials: Array<{ prefix: string; user_id: string }>;
    };
    expect(keys.credentials).toEqual([
      {
        ...keys.credentials[0],
        prefix: issued.credential.prefix,
        user_id: "alice"
      }
    ]);

    const store = createSqliteStore({ path: dbPath });
    store.insertRequestEvent({
      requestId: "req_1",
      credentialId: issued.credential.id,
      subjectId: "alice",
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
    store.close();

    const events = runCli(dbPath, ["events", "--user", "alice"]) as {
      events: Array<{ request_id: string; subject_id: string }>;
    };
    expect(events.events).toEqual([
      {
        ...events.events[0],
        request_id: "req_1",
        subject_id: "alice"
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
    ]) as { rows: Array<{ subject_id: string; requests: number; ok: number }> };
    expect(usage.rows).toEqual([
      {
        ...usage.rows[0],
        subject_id: "alice",
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
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
}
