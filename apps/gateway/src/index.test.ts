import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  GatewayError,
  issueAccessCredential,
  type CancelInput,
  type CreateSessionInput,
  type CreateSessionResult,
  type ListSessionInput,
  type MessageInput,
  type ProviderAdapter,
  type ProviderHealth,
  type ProviderSession,
  type RefreshResult,
  type StreamEvent,
  type Subscription
} from "@codex-gateway/core";
import { createSqliteStore } from "@codex-gateway/store-sqlite";
import { buildGateway } from "./index.js";

class FakeProvider implements ProviderAdapter {
  readonly kind = "fake";

  async health(_subscription: Subscription): Promise<ProviderHealth> {
    return {
      state: "healthy",
      checkedAt: new Date("2026-01-01T00:00:00Z")
    };
  }

  async refresh(_subscription: Subscription): Promise<RefreshResult> {
    return { state: "not_needed" };
  }

  async create(_input: CreateSessionInput): Promise<CreateSessionResult> {
    return { providerSessionRef: null };
  }

  async list(_input: ListSessionInput): Promise<ProviderSession[]> {
    return [];
  }

  async *message(input: MessageInput): AsyncIterable<StreamEvent> {
    yield { type: "message_delta", text: `echo:${input.message}` };
    yield { type: "completed", providerSessionRef: "provider_thread_1" };
  }

  async cancel(_input: CancelInput): Promise<void> {
    return;
  }

  normalize(err: unknown): GatewayError {
    return new GatewayError({
      code: "service_unavailable",
      message: String(err),
      httpStatus: 503
    });
  }
}

describe("gateway phase 1 routes", () => {
  it("keeps health public while protecting other routes", async () => {
    const app = buildGateway({
      accessToken: "secret",
      provider: new FakeProvider(),
      logger: false
    });

    const health = await app.inject({
      method: "GET",
      url: "/gateway/health"
    });
    expect(health.statusCode).toBe(200);

    const sessions = await app.inject({
      method: "GET",
      url: "/sessions"
    });
    expect(sessions.statusCode).toBe(401);
    expect(sessions.json().error.code).toBe("missing_credential");

    await app.close();
  });

  it("requires bearer auth for status", async () => {
    const app = buildGateway({
      accessToken: "secret",
      provider: new FakeProvider(),
      logger: false
    });

    const response = await app.inject({
      method: "GET",
      url: "/gateway/status"
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("missing_credential");
    await app.close();
  });

  it("creates a session, streams a message, and stores provider session ref", async () => {
    const app = buildGateway({
      accessToken: "secret",
      provider: new FakeProvider(),
      logger: false
    });
    const headers = { authorization: "Bearer secret" };

    const created = await app.inject({
      method: "POST",
      url: "/sessions",
      headers
    });
    expect(created.statusCode).toBe(201);
    const sessionId = created.json().session.id as string;

    const streamed = await app.inject({
      method: "POST",
      url: `/sessions/${sessionId}/messages`,
      headers,
      payload: { message: "hello" }
    });

    expect(streamed.statusCode).toBe(200);
    expect(streamed.headers["content-type"]).toContain("text/event-stream");
    expect(streamed.payload).toContain("event: message_delta");
    expect(streamed.payload).toContain('data: {"type":"message_delta","text":"echo:hello"}');
    expect(streamed.payload).toContain("event: completed");

    const listed = await app.inject({
      method: "GET",
      url: "/sessions",
      headers
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().sessions[0].provider_session_ref).toBe("provider_thread_1");

    await app.close();
  });

  it("returns invalid_request for an empty message", async () => {
    const app = buildGateway({
      accessToken: "secret",
      provider: new FakeProvider(),
      logger: false
    });
    const headers = { authorization: "Bearer secret" };

    const created = await app.inject({
      method: "POST",
      url: "/sessions",
      headers
    });
    const sessionId = created.json().session.id as string;

    const response = await app.inject({
      method: "POST",
      url: `/sessions/${sessionId}/messages`,
      headers,
      payload: { message: "" }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("invalid_request");

    await app.close();
  });

  it("hides sessions that belong to a different subject", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "codex-gateway-subject-"));
    const dbPath = path.join(dir, "gateway.db");
    const headers = { authorization: "Bearer secret" };

    try {
      const first = buildGateway({
        accessToken: "secret",
        provider: new FakeProvider(),
        sessionStore: createSqliteStore({ path: dbPath }),
        logger: false
      });

      const created = await first.inject({
        method: "POST",
        url: "/sessions",
        headers
      });
      const sessionId = created.json().session.id as string;
      await first.close();

      const second = buildGateway({
        accessToken: "secret",
        provider: new FakeProvider(),
        sessionStore: createSqliteStore({ path: dbPath }),
        subject: {
          id: "subj_other",
          label: "Other",
          state: "active",
          createdAt: new Date("2026-01-01T00:00:00Z")
        },
        logger: false
      });

      const hidden = await second.inject({
        method: "POST",
        url: `/sessions/${sessionId}/messages`,
        headers,
        payload: { message: "hello" }
      });

      expect(hidden.statusCode).toBe(404);
      expect(hidden.json().error.code).toBe("session_not_found");

      await second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("authenticates requests with sqlite-backed access credentials", async () => {
    const store = createSqliteStore({ path: ":memory:" });
    const issued = issueAccessCredential({
      subjectId: "subj_dev",
      label: "Integration token",
      scope: "code",
      expiresAt: new Date("2030-02-01T00:00:00Z"),
      now: new Date("2026-01-01T00:00:00Z")
    });
    store.upsertSubject({
      id: "subj_dev",
      label: "Credential Subject",
      state: "active",
      createdAt: new Date("2026-01-01T00:00:00Z")
    });
    store.insertAccessCredential(issued.record);
    const app = buildGateway({
      authMode: "credential",
      provider: new FakeProvider(),
      sessionStore: store,
      logger: false
    });

    const rejected = await app.inject({
      method: "GET",
      url: "/gateway/status",
      headers: { authorization: "Bearer wrong" }
    });
    expect(rejected.statusCode).toBe(401);
    expect(rejected.json().error.code).toBe("invalid_credential");

    const accepted = await app.inject({
      method: "GET",
      url: "/gateway/status",
      headers: { authorization: `Bearer ${issued.token}` }
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({
      credential: {
        prefix: issued.record.prefix,
        scope: "code",
        expires_at: "2030-02-01T00:00:00.000Z"
      },
      subject: {
        id: "subj_dev"
      }
    });

    await app.close();
  });

  it("rejects revoked sqlite-backed access credentials", async () => {
    const store = createSqliteStore({ path: ":memory:" });
    const issued = issueAccessCredential({
      subjectId: "subj_dev",
      label: "Revoked token",
      scope: "code",
      expiresAt: new Date("2026-02-01T00:00:00Z"),
      now: new Date("2026-01-01T00:00:00Z")
    });
    store.upsertSubject({
      id: "subj_dev",
      label: "Credential Subject",
      state: "active",
      createdAt: new Date("2026-01-01T00:00:00Z")
    });
    store.insertAccessCredential(issued.record);
    store.revokeAccessCredentialByPrefix(issued.record.prefix, new Date("2026-01-02T00:00:00Z"));
    const app = buildGateway({
      authMode: "credential",
      provider: new FakeProvider(),
      sessionStore: store,
      logger: false
    });

    const response = await app.inject({
      method: "GET",
      url: "/gateway/status",
      headers: { authorization: `Bearer ${issued.token}` }
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("revoked_credential");

    await app.close();
  });

  it("can persist sessions through the sqlite store", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "codex-gateway-app-"));
    const dbPath = path.join(dir, "gateway.db");
    const headers = { authorization: "Bearer secret" };

    try {
      const first = buildGateway({
        accessToken: "secret",
        provider: new FakeProvider(),
        sessionStore: createSqliteStore({ path: dbPath }),
        logger: false
      });

      const created = await first.inject({
        method: "POST",
        url: "/sessions",
        headers
      });
      const sessionId = created.json().session.id as string;

      await first.inject({
        method: "POST",
        url: `/sessions/${sessionId}/messages`,
        headers,
        payload: { message: "persist" }
      });
      await first.close();

      const second = buildGateway({
        accessToken: "secret",
        provider: new FakeProvider(),
        sessionStore: createSqliteStore({ path: dbPath }),
        logger: false
      });

      const listed = await second.inject({
        method: "GET",
        url: "/sessions",
        headers
      });

      expect(listed.statusCode).toBe(200);
      expect(listed.json().sessions).toMatchObject([
        {
          id: sessionId,
          provider_session_ref: "provider_thread_1"
        }
      ]);

      await second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
