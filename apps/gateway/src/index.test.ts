import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  issueAccessCredential,
  type MessageInput,
  type ProviderAdapter,
  type ProviderHealth,
  type RateLimitPolicy,
  type StreamEvent,
  type UpstreamAccount
} from "@codex-gateway/core";
import {
  createSqliteClientEventsStore,
  createSqliteTokenBudgetLimiter,
  createSqliteStore
} from "@codex-gateway/store-sqlite";
import { buildGateway, validateRuntimeEnvironment } from "./index.js";

class FakeProvider implements ProviderAdapter {
  readonly kind = "fake";
  readonly messages: MessageInput[] = [];

  constructor(private readonly events?: StreamEvent[]) {}

  async health(_upstreamAccount: UpstreamAccount): Promise<ProviderHealth> {
    return {
      state: "healthy",
      checkedAt: new Date("2026-01-01T00:00:00Z")
    };
  }

  async *message(input: MessageInput): AsyncIterable<StreamEvent> {
    this.messages.push(input);
    if (this.events) {
      for (const event of this.events) {
        yield event;
      }
      return;
    }

    yield { type: "message_delta", text: `echo:${input.message}` };
    yield { type: "completed", providerSessionRef: "provider_thread_1" };
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
    expectRequestIdHeader(health);
    expect(health.json().auth_mode).toBe("dev");
    expect(health.json().store).toEqual({
      session: "memory",
      observation: "disabled"
    });

    const sessions = await app.inject({
      method: "GET",
      url: "/sessions"
    });
    expect(sessions.statusCode).toBe(401);
    expectRequestIdHeader(sessions);
    expect(sessions.json().error.code).toBe("missing_credential");

    await app.close();
  });

  it("exposes MedCode public metadata instead of provider implementation names", async () => {
    const app = buildGateway({
      accessToken: "secret",
      provider: new FakeProvider(),
      logger: false
    });
    const headers = { authorization: "Bearer secret" };

    const health = await app.inject({
      method: "GET",
      url: "/gateway/health"
    });
    expect(health.json()).toMatchObject({
      service: "medcode",
      provider: "medcode",
      phase: "controlled-trial"
    });

    const status = await app.inject({
      method: "GET",
      url: "/gateway/status",
      headers
    });
    expect(status.json().subscription).toMatchObject({
      id: "medcode",
      provider: "medcode",
      detail: "MedCode service is available."
    });
    expect(status.json().upstream_account).toMatchObject({
      label: "medcode",
      provider: "medcode",
      detail: "MedCode service is available."
    });
    expect(status.json().upstream_account).not.toHaveProperty("id");

    const created = await app.inject({
      method: "POST",
      url: "/sessions",
      headers
    });
    expect(created.json().session.subscription_id).toBe("medcode");
    expect(created.json().session.upstream_account_label).toBe("medcode");

    const publicPayloads = [
      JSON.stringify(health.json()),
      JSON.stringify(status.json()),
      JSON.stringify(created.json())
    ].join("\n");
    expect(publicPayloads).not.toContain("openai-codex");
    expect(publicPayloads).not.toContain("codex-gateway");

    await app.close();
  });

  it("prefers credential auth when a credential store and dev token are both present", async () => {
    const store = createSqliteStore({ path: ":memory:" });
    const issued = issueAccessCredential({
      subjectId: "subj_dev",
      label: "Preferred credential",
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
      accessToken: "dev-secret",
      provider: new FakeProvider(),
      sessionStore: store,
      logger: false
    });

    const health = await app.inject({
      method: "GET",
      url: "/gateway/health"
    });
    expect(health.json().auth_mode).toBe("credential");

    const devTokenResponse = await app.inject({
      method: "GET",
      url: "/gateway/status",
      headers: { authorization: "Bearer dev-secret" }
    });
    expect(devTokenResponse.statusCode).toBe(401);
    expect(devTokenResponse.json().error.code).toBe("invalid_credential");

    const credentialResponse = await app.inject({
      method: "GET",
      url: "/gateway/status",
      headers: { authorization: `Bearer ${issued.token}` }
    });
    expect(credentialResponse.statusCode).toBe(200);

    await app.close();
  });

  it("does not reactivate disabled subjects during credential bootstrap", async () => {
    const store = createSqliteStore({ path: ":memory:" });
    const issued = issueAccessCredential({
      subjectId: "subj_dev",
      label: "Disabled default subject credential",
      scope: "code",
      expiresAt: new Date("2030-02-01T00:00:00Z"),
      now: new Date("2026-01-01T00:00:00Z")
    });
    store.upsertSubject({
      id: "subj_dev",
      label: "Default Subject",
      state: "active",
      createdAt: new Date("2026-01-01T00:00:00Z")
    });
    store.insertAccessCredential(issued.record);
    store.setSubjectState("subj_dev", "disabled");

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
    expect(response.json().error.code).toBe("invalid_credential");
    expect(store.getSubject("subj_dev")).toMatchObject({
      label: "Default Subject",
      state: "disabled"
    });

    await app.close();
  });

  it("validates the current API key without consuming request limits", async () => {
    const store = createSqliteStore({ path: ":memory:" });
    const issued = issueAccessCredential({
      subjectId: "subj_dev",
      label: "Client validation credential",
      scope: "code",
      expiresAt: new Date("2030-02-01T00:00:00Z"),
      now: new Date("2026-01-01T00:00:00Z"),
      rate: {
        requestsPerMinute: 1,
        requestsPerDay: null,
        concurrentRequests: 1
      }
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
    const headers = { authorization: `Bearer ${issued.token}` };

    const validation = await app.inject({
      method: "GET",
      url: "/gateway/credentials/current",
      headers
    });
    expect(validation.statusCode).toBe(200);
    expect(validation.json()).toEqual({
      valid: true,
      subject: {
        id: "subj_dev",
        label: "Credential Subject"
      },
      credential: {
        prefix: issued.record.prefix,
        scope: "code",
        expires_at: "2030-02-01T00:00:00.000Z",
        rate: {
          requestsPerMinute: 1,
          requestsPerDay: null,
          concurrentRequests: 1
        }
      }
    });

    const firstLimitedRoute = await app.inject({
      method: "GET",
      url: "/gateway/status",
      headers
    });
    expect(firstLimitedRoute.statusCode).toBe(200);

    const secondLimitedRoute = await app.inject({
      method: "GET",
      url: "/gateway/status",
      headers
    });
    expect(secondLimitedRoute.statusCode).toBe(429);
    expect(secondLimitedRoute.json().error.code).toBe("rate_limited");

    await app.close();
  });

  it("rejects invalid API keys on the current credential validation route", async () => {
    const store = createSqliteStore({ path: ":memory:" });
    const app = buildGateway({
      authMode: "credential",
      provider: new FakeProvider(),
      sessionStore: store,
      logger: false
    });

    const response = await app.inject({
      method: "GET",
      url: "/gateway/credentials/current",
      headers: { authorization: "Bearer wrong" }
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("invalid_credential");

    await app.close();
  });

  it("does not expose internal token budget policy fields on public credential routes", async () => {
    const store = createSqliteStore({ path: ":memory:" });
    const issued = issueAccessCredential({
      subjectId: "subj_dev",
      label: "Token policy credential",
      scope: "code",
      expiresAt: new Date("2030-02-01T00:00:00Z"),
      now: new Date("2026-01-01T00:00:00Z"),
      rate: {
        requestsPerMinute: 30,
        requestsPerDay: null,
        concurrentRequests: 1,
        token: {
          tokensPerMinute: 1_000,
          tokensPerDay: 10_000,
          tokensPerMonth: null,
          maxPromptTokensPerRequest: 500,
          maxTotalTokensPerRequest: 1_000,
          reserveTokensPerRequest: 100,
          missingUsageCharge: "reserve"
        }
      }
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
    const headers = { authorization: `Bearer ${issued.token}` };

    const status = await app.inject({
      method: "GET",
      url: "/gateway/status",
      headers
    });
    const current = await app.inject({
      method: "GET",
      url: "/gateway/credentials/current",
      headers
    });

    expect(status.statusCode).toBe(200);
    expect(current.statusCode).toBe(200);
    expect(status.json().credential.rate.token).toEqual({
      tokensPerMinute: 1_000,
      tokensPerDay: 10_000,
      tokensPerMonth: null,
      maxPromptTokensPerRequest: 500,
      maxTotalTokensPerRequest: 1_000
    });
    expect(current.json().credential.token).toEqual(status.json().credential.rate.token);
    expect(JSON.stringify(status.json())).not.toContain("reserveTokensPerRequest");
    expect(JSON.stringify(status.json())).not.toContain("missingUsageCharge");
    expect(JSON.stringify(current.json())).not.toContain("reserveTokensPerRequest");
    expect(JSON.stringify(current.json())).not.toContain("missingUsageCharge");

    await app.close();
  });

  it("returns service_unavailable for client message events when storage is not configured", async () => {
    const app = buildGateway({
      accessToken: "secret",
      provider: new FakeProvider(),
      clientEventsStore: null,
      logger: false
    });

    const response = await app.inject({
      method: "POST",
      url: "/gateway/client-events/messages",
      payload: clientMessagePayload()
    });

    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("service_unavailable");

    await app.close();
  });

  it("writes client message events to the dedicated store without request observation", async () => {
    const { store, issued, headers } = createCredentialBackedStore();
    const clientEventsStore = createSqliteClientEventsStore({ path: ":memory:" });
    const app = buildGateway({
      authMode: "credential",
      provider: new FakeProvider(),
      sessionStore: store,
      clientEventsStore,
      logger: false
    });

    const response = await app.inject({
      method: "POST",
      url: "/gateway/client-events/messages",
      headers,
      payload: clientMessagePayload({
        event_id: "evt_write_1",
        text: "系统性红斑狼疮最新研究进展",
        attachments: [
          {
            type: "file",
            filename: "report.pdf",
            mime: "application/pdf",
            size: 123456
          }
        ]
      })
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      ok: true,
      event_id: "evt_write_1",
      duplicate: false
    });
    const stored = clientEventsStore.getClientMessageEvent("subj_dev", "evt_write_1");
    expect(stored).toMatchObject({
      eventId: "evt_write_1",
      credentialId: issued.record.id,
      subjectId: "subj_dev",
      scope: "code",
      sessionId: "ses_1",
      messageId: "msg_1",
      text: "系统性红斑狼疮最新研究进展",
      appName: "medevidence-desktop",
      appVersion: "1.4.6"
    });
    expect(stored?.textSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.parse(stored?.attachmentsJson ?? "[]")).toEqual([
      {
        type: "file",
        filename: "report.pdf",
        mime: "application/pdf",
        size: 123456
      }
    ]);
    expect(store.listRequestEvents()).toEqual([]);

    await app.close();
  });

  it("keeps client message event idempotency immutable", async () => {
    const { store, headers } = createCredentialBackedStore();
    const clientEventsStore = createSqliteClientEventsStore({ path: ":memory:" });
    const app = buildGateway({
      authMode: "credential",
      provider: new FakeProvider(),
      sessionStore: store,
      clientEventsStore,
      logger: false
    });
    const payload = clientMessagePayload({
      event_id: "evt_idempotent_1",
      text: "first text"
    });

    const created = await app.inject({
      method: "POST",
      url: "/gateway/client-events/messages",
      headers,
      payload
    });
    const duplicate = await app.inject({
      method: "POST",
      url: "/gateway/client-events/messages",
      headers,
      payload
    });
    const conflict = await app.inject({
      method: "POST",
      url: "/gateway/client-events/messages",
      headers,
      payload: clientMessagePayload({
        event_id: "evt_idempotent_1",
        text: "changed text"
      })
    });

    expect(created.statusCode).toBe(201);
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json()).toMatchObject({
      ok: true,
      event_id: "evt_idempotent_1",
      duplicate: true
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe("idempotency_conflict");
    expect(clientEventsStore.getClientMessageEvent("subj_dev", "evt_idempotent_1")?.text).toBe(
      "first text"
    );

    await app.close();
  });

  it("validates client message text byte length and attachment metadata", async () => {
    const { store, headers } = createCredentialBackedStore();
    const clientEventsStore = createSqliteClientEventsStore({ path: ":memory:" });
    const app = buildGateway({
      authMode: "credential",
      provider: new FakeProvider(),
      sessionStore: store,
      clientEventsStore,
      logger: false
    });

    const oversized = await app.inject({
      method: "POST",
      url: "/gateway/client-events/messages",
      headers,
      payload: clientMessagePayload({
        event_id: "evt_oversized_1",
        text: "a".repeat(64 * 1024 + 1)
      })
    });
    const attachmentContent = await app.inject({
      method: "POST",
      url: "/gateway/client-events/messages",
      headers,
      payload: clientMessagePayload({
        event_id: "evt_attachment_1",
        attachments: [
          {
            type: "file",
            filename: "report.pdf",
            content: "raw body"
          }
        ]
      })
    });

    expect(oversized.statusCode).toBe(413);
    expect(oversized.json().error.code).toBe("invalid_request");
    expect(attachmentContent.statusCode).toBe(400);
    expect(attachmentContent.json().error.message).toContain("content is not allowed");
    expect(clientEventsStore.getClientMessageEvent("subj_dev", "evt_oversized_1")).toBeNull();
    expect(clientEventsStore.getClientMessageEvent("subj_dev", "evt_attachment_1")).toBeNull();

    await app.close();
  });

  it("uses credential auth and an independent rate limit for client message events", async () => {
    const { store, headers } = createCredentialBackedStore({
      requestsPerMinute: 1,
      requestsPerDay: null,
      concurrentRequests: null
    });
    const clientEventsStore = createSqliteClientEventsStore({ path: ":memory:" });
    const app = buildGateway({
      authMode: "credential",
      provider: new FakeProvider(),
      sessionStore: store,
      clientEventsStore,
      clientEventsRatePolicy: {
        requestsPerMinute: 1,
        requestsPerDay: null,
        concurrentRequests: null
      },
      logger: false
    });

    const unauthenticated = await app.inject({
      method: "POST",
      url: "/gateway/client-events/messages",
      payload: clientMessagePayload()
    });
    const firstClientEvent = await app.inject({
      method: "POST",
      url: "/gateway/client-events/messages",
      headers,
      payload: clientMessagePayload({ event_id: "evt_limit_1" })
    });
    const firstModelRoute = await app.inject({
      method: "GET",
      url: "/gateway/status",
      headers
    });
    const secondClientEvent = await app.inject({
      method: "POST",
      url: "/gateway/client-events/messages",
      headers,
      payload: clientMessagePayload({ event_id: "evt_limit_2" })
    });
    const secondModelRoute = await app.inject({
      method: "GET",
      url: "/gateway/status",
      headers
    });

    expect(unauthenticated.statusCode).toBe(401);
    expect(unauthenticated.json().error.code).toBe("missing_credential");
    expect(firstClientEvent.statusCode).toBe(201);
    expect(firstModelRoute.statusCode).toBe(200);
    expect(secondClientEvent.statusCode).toBe(429);
    expect(secondClientEvent.json().error.code).toBe("rate_limited");
    expect(secondModelRoute.statusCode).toBe(429);

    await app.close();
  });

  it("rejects dev auth mode when NODE_ENV is production", () => {
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      expect(() =>
        buildGateway({
          accessToken: "secret",
          provider: new FakeProvider(),
          logger: false
        })
      ).toThrow("Dev auth mode is not allowed");
    } finally {
      if (previousNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = previousNodeEnv;
      }
    }
  });

  it("validates production runtime environment before listening", () => {
    expect(() =>
      validateRuntimeEnvironment({
        NODE_ENV: "production",
        GATEWAY_AUTH_MODE: "credential",
        GATEWAY_SQLITE_PATH: "/var/lib/codex-gateway/gateway.db",
        CODEX_HOME: "/var/lib/codex-gateway/codex-home"
      })
    ).not.toThrow();

    expect(() =>
      validateRuntimeEnvironment({
        NODE_ENV: "production",
        GATEWAY_AUTH_MODE: "credential",
        GATEWAY_SQLITE_PATH: "/var/lib/codex-gateway/gateway.db",
        CODEX_HOME: "/var/lib/codex-gateway/codex-home",
        GATEWAY_DEV_ACCESS_TOKEN: "leftover-dev-token"
      })
    ).toThrow("Production runtime must not set GATEWAY_DEV_ACCESS_TOKEN");

    expect(() =>
      validateRuntimeEnvironment({
        NODE_ENV: "production",
        GATEWAY_SQLITE_PATH: "/var/lib/codex-gateway/gateway.db",
        CODEX_HOME: "/var/lib/codex-gateway/codex-home"
      })
    ).toThrow("Production runtime requires GATEWAY_AUTH_MODE=credential");
  });

  it("validates configured upstream reasoning effort", async () => {
    const previousReasoningEffort = process.env.MEDCODE_UPSTREAM_REASONING_EFFORT;
    process.env.MEDCODE_UPSTREAM_REASONING_EFFORT = "high";
    const app = buildGateway({
      accessToken: "secret",
      logger: false
    });
    await app.close();

    process.env.MEDCODE_UPSTREAM_REASONING_EFFORT = "fast";
    try {
      expect(() =>
        buildGateway({
          accessToken: "secret",
          logger: false
        })
      ).toThrow("MEDCODE_UPSTREAM_REASONING_EFFORT must be minimal, low, medium, high, or xhigh.");
    } finally {
      if (previousReasoningEffort === undefined) {
        delete process.env.MEDCODE_UPSTREAM_REASONING_EFFORT;
      } else {
        process.env.MEDCODE_UPSTREAM_REASONING_EFFORT = previousReasoningEffort;
      }
    }
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

  it("exposes an OpenAI-compatible model list", async () => {
    const app = buildGateway({
      accessToken: "secret",
      provider: new FakeProvider(),
      logger: false
    });

    const response = await app.inject({
      method: "GET",
      url: "/v1/models",
      headers: { authorization: "Bearer secret" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      object: "list",
      data: [
        {
          id: "medcode",
          object: "model",
          created: 0,
          owned_by: "medcode",
          context_window: 400000,
          max_context_window: 400000,
          max_output_tokens: 128000
        }
      ]
    });

    await app.close();
  });

  it("rejects unknown OpenAI chat completion models", async () => {
    const provider = new FakeProvider();
    const app = buildGateway({
      accessToken: "secret",
      provider,
      logger: false
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: "Bearer secret" },
      payload: {
        model: "gpt-4",
        messages: [{ role: "user", content: "hello" }]
      }
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: {
        message: "Model 'gpt-4' does not exist.",
        type: "invalid_request_error",
        code: "model_not_found",
        param: null
      }
    });
    expect(provider.messages).toHaveLength(0);

    await app.close();
  });

  it("creates non-streaming OpenAI chat completions from messages", async () => {
    const provider = new FakeProvider([
      { type: "message_delta", text: "hello" },
      { type: "message_delta", text: " world" },
      { type: "completed", providerSessionRef: "provider_thread_1" }
    ]);
    const app = buildGateway({
      accessToken: "secret",
      provider,
      logger: false
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: "Bearer secret" },
      payload: {
        model: "medcode",
        messages: [
          { role: "developer", content: "Answer briefly." },
          { role: "user", content: "Say hello." }
        ]
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      object: "chat.completion",
      model: "medcode",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "hello world"
          },
          finish_reason: "stop"
        }
      ],
      usage: null
    });
    expect(response.json().id).toMatch(/^chatcmpl_/);
    expect(provider.messages[0].session.id).toMatch(/^sess_stateless_/);
    expect(provider.messages[0].message).toContain("[developer]");
    expect(provider.messages[0].message).toContain("Answer briefly.");
    expect(provider.messages[0].message).toContain("[user]");
    expect(provider.messages[0].message).toContain("Say hello.");

    await app.close();
  });

  it("omits assistant text content when a tool call is returned", async () => {
    const provider = new FakeProvider([
      {
        type: "tool_call",
        callId: "call_1",
        name: "shell",
        arguments: { command: "ls" }
      },
      {
        type: "message_delta",
        text: "I tried to run ls but the server sandbox failed."
      },
      { type: "completed", providerSessionRef: "provider_thread_1" }
    ]);
    const app = buildGateway({
      accessToken: "secret",
      provider,
      logger: false
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: "Bearer secret" },
      payload: {
        model: "medcode",
        messages: [{ role: "user", content: "List files." }]
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().choices[0]).toMatchObject({
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: {
              name: "shell",
              arguments: '{"command":"ls"}'
            }
          }
        ]
      },
      finish_reason: "tool_calls"
    });

    await app.close();
  });

  it("streams OpenAI chat completion chunks", async () => {
    const provider = new FakeProvider([
      { type: "message_delta", text: "hello" },
      { type: "message_delta", text: " world" },
      { type: "completed", providerSessionRef: "provider_thread_1" }
    ]);
    const app = buildGateway({
      accessToken: "secret",
      provider,
      logger: false
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: "Bearer secret" },
      payload: {
        model: "medcode",
        stream: true,
        messages: [{ role: "user", content: "Say hello." }]
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expectRequestIdHeader(response);
    expect(response.payload).toContain('"object":"chat.completion.chunk"');
    expect(response.payload).toContain('"delta":{"role":"assistant"}');
    expect(response.payload).toContain('"delta":{"content":"hello"}');
    expect(response.payload).toContain('"finish_reason":"stop"');
    expect(response.payload).toContain("data: [DONE]");

    await app.close();
  });

  it("returns OpenAI tool calls and usage for non-streaming chat completions", async () => {
    const provider = new FakeProvider([
      {
        type: "tool_call",
        callId: "call_1",
        name: "bash",
        arguments: { command: "ls" }
      },
      {
        type: "completed",
        providerSessionRef: "provider_thread_1",
        usage: {
          promptTokens: 10,
          completionTokens: 2,
          totalTokens: 12,
          cachedPromptTokens: 4
        }
      }
    ]);
    const app = buildGateway({
      accessToken: "secret",
      provider,
      logger: false
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: "Bearer secret" },
      payload: {
        model: "medcode",
        messages: [{ role: "user", content: "List files." }]
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      object: "chat.completion",
      model: "medcode",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: {
                  name: "bash",
                  arguments: '{"command":"ls"}'
                }
              }
            ]
          },
          finish_reason: "tool_calls"
        }
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 2,
        total_tokens: 12,
        prompt_tokens_details: {
          cached_tokens: 4
        }
      }
    });

    await app.close();
  });

  it("returns strict client-defined tool calls for non-streaming chat completions", async () => {
    const provider = new FakeProvider([
      {
        type: "message_delta",
        text: JSON.stringify({
          type: "tool_calls",
          tool_calls: [
            {
              name: "medevidence",
              arguments: {
                question: "What evidence supports aspirin after MI?"
              }
            }
          ]
        })
      },
      {
        type: "completed",
        providerSessionRef: "provider_thread_1",
        usage: {
          promptTokens: 20,
          completionTokens: 3,
          totalTokens: 23
        }
      }
    ]);
    const app = buildGateway({
      accessToken: "secret",
      provider,
      logger: false
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: "Bearer secret" },
      payload: {
        model: "medcode",
        messages: [{ role: "user", content: "Answer with evidence." }],
        tools: [
          {
            type: "function",
            function: {
              name: "medevidence",
              description: "Answer a medical evidence question.",
              parameters: {
                type: "object",
                properties: { question: { type: "string" } },
                required: ["question"],
                additionalProperties: false
              }
            }
          }
        ]
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().choices[0]).toMatchObject({
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            type: "function",
            function: {
              name: "medevidence",
              arguments: '{"question":"What evidence supports aspirin after MI?"}'
            }
          }
        ]
      },
      finish_reason: "tool_calls"
    });
    expect(response.json().choices[0].message.tool_calls[0].id).toMatch(/^call_/);
    expect(provider.messages[0].message).toContain("strict client-defined tools mode");
    expect(provider.messages[0].message).toContain("medevidence");

    await app.close();
  });

  it("accepts draft 2020-12 schemas for strict client-defined tools", async () => {
    const provider = new FakeProvider([
      {
        type: "message_delta",
        text: JSON.stringify({
          type: "tool_calls",
          tool_calls: [
            {
              name: "bash",
              arguments: {
                command: "ls"
              }
            }
          ]
        })
      },
      { type: "completed", providerSessionRef: "provider_thread_1" }
    ]);
    const app = buildGateway({
      accessToken: "secret",
      provider,
      logger: false
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: "Bearer secret" },
      payload: {
        model: "medcode",
        messages: [{ role: "user", content: "List files in current dir via a tool." }],
        tools: [
          {
            type: "function",
            function: {
              name: "bash",
              description: "Run a shell command.",
              parameters: {
                $schema: "https://json-schema.org/draft/2020-12/schema",
                type: "object",
                properties: { command: { type: "string" } },
                required: ["command"],
                additionalProperties: false
              }
            }
          }
        ]
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().choices[0]).toMatchObject({
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            type: "function",
            function: {
              name: "bash",
              arguments: '{"command":"ls"}'
            }
          }
        ]
      },
      finish_reason: "tool_calls"
    });
    expect(provider.messages).toHaveLength(1);

    await app.close();
  });

  it("keeps draft-07 schemas accepted for strict client-defined tools", async () => {
    const provider = new FakeProvider([
      {
        type: "message_delta",
        text: JSON.stringify({
          type: "tool_calls",
          tool_calls: [
            {
              name: "search",
              arguments: {
                query: "heart failure"
              }
            }
          ]
        })
      },
      { type: "completed", providerSessionRef: "provider_thread_1" }
    ]);
    const app = buildGateway({
      accessToken: "secret",
      provider,
      logger: false
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: "Bearer secret" },
      payload: {
        model: "medcode",
        messages: [{ role: "user", content: "Search evidence." }],
        tools: [
          {
            type: "function",
            function: {
              name: "search",
              parameters: {
                $schema: "http://json-schema.org/draft-07/schema#",
                type: "object",
                properties: { query: { type: "string" } },
                required: ["query"],
                additionalProperties: false
              }
            }
          }
        ]
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().choices[0].finish_reason).toBe("tool_calls");
    expect(
      JSON.parse(response.json().choices[0].message.tool_calls[0].function.arguments)
    ).toEqual({
      query: "heart failure"
    });

    await app.close();
  });

  it("rejects undeclared tools in strict client-defined tool mode", async () => {
    const provider = new FakeProvider([
      {
        type: "message_delta",
        text: JSON.stringify({
          type: "tool_calls",
          tool_calls: [
            {
              name: "shell",
              arguments: {
                command: "ls"
              }
            }
          ]
        })
      },
      { type: "completed", providerSessionRef: "provider_thread_1" }
    ]);
    const app = buildGateway({
      accessToken: "secret",
      provider,
      logger: false
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: "Bearer secret" },
      payload: {
        model: "medcode",
        messages: [{ role: "user", content: "Use a medical evidence tool." }],
        tools: [
          {
            type: "function",
            function: {
              name: "medevidence",
              parameters: {
                type: "object",
                properties: { question: { type: "string" } },
                required: ["question"],
                additionalProperties: false
              }
            }
          }
        ]
      }
    });

    expect(response.statusCode).toBe(502);
    expect(response.json().error).toMatchObject({
      code: "tool_call_validation_failed",
      type: "server_error"
    });
    expect(provider.messages).toHaveLength(2);
    expect(provider.messages[1].message).toContain("previous output was invalid");

    await app.close();
  });

  it("rejects strict tool arguments that do not match the client schema", async () => {
    const provider = new FakeProvider([
      {
        type: "message_delta",
        text: JSON.stringify({
          type: "tool_calls",
          tool_calls: [
            {
              name: "medevidence",
              arguments: {
                question: 123
              }
            }
          ]
        })
      },
      { type: "completed", providerSessionRef: "provider_thread_1" }
    ]);
    const app = buildGateway({
      accessToken: "secret",
      provider,
      logger: false
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: "Bearer secret" },
      payload: {
        model: "medcode",
        messages: [{ role: "user", content: "Use a medical evidence tool." }],
        tools: [
          {
            type: "function",
            function: {
              name: "medevidence",
              parameters: {
                type: "object",
                properties: { question: { type: "string" } },
                required: ["question"],
                additionalProperties: false
              }
            }
          }
        ]
      }
    });

    expect(response.statusCode).toBe(502);
    expect(response.json().error.code).toBe("tool_call_validation_failed");
    expect(response.json().error.message).toContain("must be string");

    await app.close();
  });

  it("honors tool_choice none by avoiding strict mode and suppressing tool calls", async () => {
    const provider = new FakeProvider([
      {
        type: "tool_call",
        callId: "call_ignored",
        name: "shell",
        arguments: { command: "pwd" }
      },
      { type: "message_delta", text: "answered without tools" },
      { type: "completed", providerSessionRef: "provider_thread_1" }
    ]);
    const app = buildGateway({
      accessToken: "secret",
      provider,
      logger: false
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: "Bearer secret" },
      payload: {
        model: "medcode",
        messages: [{ role: "user", content: "Answer directly." }],
        tool_choice: "none",
        tools: [
          {
            type: "function",
            function: {
              name: "medevidence",
              parameters: {
                type: "object",
                properties: { question: { type: "string" } },
                required: ["question"],
                additionalProperties: false
              }
            }
          }
        ]
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().choices[0]).toMatchObject({
      message: {
        role: "assistant",
        content: "answered without tools"
      },
      finish_reason: "stop"
    });
    expect(response.json().choices[0].message.tool_calls).toBeUndefined();
    expect(provider.messages[0].message).toContain("tool_choice=none");
    expect(provider.messages[0].message).not.toContain("strict client-defined tools mode");

    await app.close();
  });

  it("requires a strict tool call when tool_choice is required", async () => {
    const provider = new FakeProvider([
      {
        type: "message_delta",
        text: JSON.stringify({
          type: "message",
          content: "I can answer directly."
        })
      },
      { type: "completed", providerSessionRef: "provider_thread_1" }
    ]);
    const app = buildGateway({
      accessToken: "secret",
      provider,
      logger: false
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: "Bearer secret" },
      payload: {
        model: "medcode",
        messages: [{ role: "user", content: "Use the evidence tool." }],
        tool_choice: "required",
        tools: [
          {
            type: "function",
            function: {
              name: "medevidence",
              parameters: {
                type: "object",
                properties: { question: { type: "string" } },
                required: ["question"],
                additionalProperties: false
              }
            }
          }
        ]
      }
    });

    expect(response.statusCode).toBe(502);
    expect(response.json().error).toMatchObject({
      code: "tool_call_validation_failed",
      type: "server_error"
    });
    expect(response.json().error.message).toContain("tool_choice=required");
    expect(provider.messages).toHaveLength(2);
    expect(provider.messages[0].message).toContain("tool_choice=required");

    await app.close();
  });

  it("honors a named function tool_choice", async () => {
    const provider = new FakeProvider([
      {
        type: "message_delta",
        text: JSON.stringify({
          type: "tool_calls",
          tool_calls: [
            {
              name: "search",
              arguments: {
                query: "aspirin myocardial infarction"
              }
            }
          ]
        })
      },
      { type: "completed", providerSessionRef: "provider_thread_1" }
    ]);
    const app = buildGateway({
      accessToken: "secret",
      provider,
      logger: false
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: "Bearer secret" },
      payload: {
        model: "medcode",
        messages: [{ role: "user", content: "Search the literature." }],
        tool_choice: {
          type: "function",
          function: { name: "search" }
        },
        tools: [
          {
            type: "function",
            function: {
              name: "medevidence",
              parameters: {
                type: "object",
                properties: { question: { type: "string" } },
                required: ["question"],
                additionalProperties: false
              }
            }
          },
          {
            type: "function",
            function: {
              name: "search",
              parameters: {
                type: "object",
                properties: { query: { type: "string" } },
                required: ["query"],
                additionalProperties: false
              }
            }
          }
        ]
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().choices[0].message.tool_calls[0].function).toMatchObject({
      name: "search",
      arguments: '{"query":"aspirin myocardial infarction"}'
    });
    expect(provider.messages[0].message).toContain("function.name=search");

    await app.close();
  });

  it("rejects a named tool_choice that is not declared in tools", async () => {
    const provider = new FakeProvider();
    const app = buildGateway({
      accessToken: "secret",
      provider,
      logger: false
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: "Bearer secret" },
      payload: {
        model: "medcode",
        messages: [{ role: "user", content: "Search the literature." }],
        tool_choice: {
          type: "function",
          function: { name: "search" }
        },
        tools: [
          {
            type: "function",
            function: {
              name: "medevidence",
              parameters: {
                type: "object",
                properties: { question: { type: "string" } },
                required: ["question"],
                additionalProperties: false
              }
            }
          }
        ]
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatchObject({
      code: "invalid_request",
      type: "invalid_request_error"
    });
    expect(response.json().error.message).toContain("was not declared");
    expect(provider.messages).toHaveLength(0);

    await app.close();
  });

  it("validates complex strict tool schemas", async () => {
    const provider = new FakeProvider([
      {
        type: "message_delta",
        text: JSON.stringify({
          type: "tool_calls",
          tool_calls: [
            {
              id: "call_search_1",
              name: "search",
              arguments: {
                query: "statins primary prevention",
                filters: {
                  kind: "guideline",
                  years: [2021, 2024]
                },
                tags: ["cardiology", "prevention"]
              }
            }
          ]
        })
      },
      { type: "completed", providerSessionRef: "provider_thread_1" }
    ]);
    const app = buildGateway({
      accessToken: "secret",
      provider,
      logger: false
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: "Bearer secret" },
      payload: {
        model: "medcode",
        messages: [{ role: "user", content: "Find a guideline." }],
        tools: [
          {
            type: "function",
            function: {
              name: "search",
              parameters: {
                type: "object",
                properties: {
                  query: { type: "string" },
                  filters: {
                    type: "object",
                    properties: {
                      kind: { type: "string", enum: ["trial", "guideline"] },
                      years: {
                        type: "array",
                        items: { type: "integer" },
                        minItems: 1
                      }
                    },
                    required: ["kind"],
                    additionalProperties: false
                  },
                  tags: {
                    type: "array",
                    items: { type: "string" }
                  }
                },
                required: ["query", "filters"],
                additionalProperties: false
              }
            }
          }
        ]
      }
    });

    expect(response.statusCode).toBe(200);
    const call = response.json().choices[0].message.tool_calls[0];
    expect(call).toMatchObject({
      id: "call_search_1",
      type: "function",
      function: { name: "search" }
    });
    expect(JSON.parse(call.function.arguments)).toEqual({
      query: "statins primary prevention",
      filters: {
        kind: "guideline",
        years: [2021, 2024]
      },
      tags: ["cardiology", "prevention"]
    });

    await app.close();
  });

  it("rejects additional properties in strict tool schemas", async () => {
    const provider = new FakeProvider([
      {
        type: "message_delta",
        text: JSON.stringify({
          type: "tool_calls",
          tool_calls: [
            {
              name: "search",
              arguments: {
                query: "statins",
                filters: {
                  kind: "guideline",
                  unexpected: true
                }
              }
            }
          ]
        })
      },
      { type: "completed", providerSessionRef: "provider_thread_1" }
    ]);
    const app = buildGateway({
      accessToken: "secret",
      provider,
      logger: false
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: "Bearer secret" },
      payload: {
        model: "medcode",
        messages: [{ role: "user", content: "Find a guideline." }],
        tools: [
          {
            type: "function",
            function: {
              name: "search",
              parameters: {
                type: "object",
                properties: {
                  query: { type: "string" },
                  filters: {
                    type: "object",
                    properties: {
                      kind: { type: "string", enum: ["trial", "guideline"] }
                    },
                    required: ["kind"],
                    additionalProperties: false
                  }
                },
                required: ["query", "filters"],
                additionalProperties: false
              }
            }
          }
        ]
      }
    });

    expect(response.statusCode).toBe(502);
    expect(response.json().error.code).toBe("tool_call_validation_failed");
    expect(response.json().error.message).toContain("additional properties");

    await app.close();
  });

  it("streams OpenAI tool call chunks with tool_calls finish reason", async () => {
    const provider = new FakeProvider([
      {
        type: "tool_call",
        callId: "call_1",
        name: "bash",
        arguments: { command: "ls" }
      },
      { type: "message_delta", text: "server sandbox failed" },
      {
        type: "completed",
        providerSessionRef: "provider_thread_1",
        usage: {
          promptTokens: 5,
          completionTokens: 1,
          totalTokens: 6
        }
      }
    ]);
    const app = buildGateway({
      accessToken: "secret",
      provider,
      logger: false
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: "Bearer secret" },
      payload: {
        model: "medcode",
        stream: true,
        messages: [{ role: "user", content: "List files." }]
      }
    });

    expect(response.statusCode).toBe(200);
    const frames = parseOpenAISseData(response.payload);
    expect(frames[0]).toMatchObject({
      object: "chat.completion.chunk",
      choices: [{ delta: { role: "assistant" }, finish_reason: null }]
    });
    expect(frames[1]).toMatchObject({
      object: "chat.completion.chunk",
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_1",
                type: "function",
                function: {
                  name: "bash",
                  arguments: '{"command":"ls"}'
                }
              }
            ]
          },
          finish_reason: null
        }
      ]
    });
    expect(frames[2]).toMatchObject({
      object: "chat.completion.chunk",
      choices: [{ delta: {}, finish_reason: "tool_calls" }],
      usage: {
        prompt_tokens: 5,
        completion_tokens: 1,
        total_tokens: 6
      }
    });
    expect(response.payload).not.toContain("server sandbox failed");
    expect(response.payload).toContain("data: [DONE]");

    await app.close();
  });

  it("streams strict client-defined tool calls", async () => {
    const provider = new FakeProvider([
      {
        type: "message_delta",
        text: JSON.stringify({
          type: "tool_calls",
          tool_calls: [
            {
              id: "call_medevidence_1",
              name: "medevidence",
              arguments: {
                question: "What is the evidence?"
              }
            }
          ]
        })
      },
      {
        type: "completed",
        providerSessionRef: "provider_thread_1",
        usage: {
          promptTokens: 7,
          completionTokens: 2,
          totalTokens: 9
        }
      }
    ]);
    const app = buildGateway({
      accessToken: "secret",
      provider,
      logger: false
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: "Bearer secret" },
      payload: {
        model: "medcode",
        stream: true,
        messages: [{ role: "user", content: "Use the evidence tool." }],
        tools: [
          {
            type: "function",
            function: {
              name: "medevidence",
              parameters: {
                type: "object",
                properties: { question: { type: "string" } },
                required: ["question"],
                additionalProperties: false
              }
            }
          }
        ]
      }
    });

    expect(response.statusCode).toBe(200);
    const frames = parseOpenAISseData(response.payload);
    expect(frames[1]).toMatchObject({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_medevidence_1",
                type: "function",
                function: {
                  name: "medevidence",
                  arguments: '{"question":"What is the evidence?"}'
                }
              }
            ]
          },
          finish_reason: null
        }
      ]
    });
    expect(frames[2]).toMatchObject({
      choices: [{ delta: {}, finish_reason: "tool_calls" }],
      usage: {
        prompt_tokens: 7,
        completion_tokens: 2,
        total_tokens: 9
      }
    });

    await app.close();
  });

  it("accepts OpenAI tool result messages as chat history context", async () => {
    const provider = new FakeProvider([
      { type: "message_delta", text: "The directory contains file1.txt." },
      { type: "completed", providerSessionRef: "provider_thread_1" }
    ]);
    const app = buildGateway({
      accessToken: "secret",
      provider,
      logger: false
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: "Bearer secret" },
      payload: {
        model: "medcode",
        messages: [
          { role: "user", content: "List files." },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: {
                  name: "bash",
                  arguments: '{"command":"ls"}'
                }
              }
            ]
          },
          { role: "tool", tool_call_id: "call_1", content: "file1.txt" },
          { role: "user", content: "Summarize the result." }
        ]
      }
    });

    expect(response.statusCode).toBe(200);
    expect(provider.messages[0].message).toContain("[assistant tool_calls]");
    expect(provider.messages[0].message).toContain('"id":"call_1"');
    expect(provider.messages[0].message).toContain("[tool tool_call_id=call_1]");
    expect(provider.messages[0].message).toContain("file1.txt");

    await app.close();
  });

  it("uses OpenAI-style error envelopes for /v1 requests", async () => {
    const app = buildGateway({
      accessToken: "secret",
      provider: new FakeProvider(),
      logger: false
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: "Bearer secret" },
      payload: { model: "medcode", messages: [] }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: {
        message: "messages must be a non-empty array.",
        type: "invalid_request_error",
        code: "invalid_request",
        param: null
      }
    });

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
        authMode: "dev",
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
        authMode: "dev",
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

  it("rejects API keys that belong to a disabled user", async () => {
    const store = createSqliteStore({ path: ":memory:" });
    const issued = issueAccessCredential({
      subjectId: "alice",
      label: "Alice token",
      scope: "code",
      expiresAt: new Date("2030-02-01T00:00:00Z"),
      now: new Date("2026-01-01T00:00:00Z")
    });
    store.upsertSubject({
      id: "alice",
      label: "Alice",
      state: "active",
      createdAt: new Date("2026-01-01T00:00:00Z")
    });
    store.insertAccessCredential(issued.record);
    store.setSubjectState("alice", "disabled");
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
    expect(response.json().error.code).toBe("invalid_credential");

    await app.close();
  });

  it("rate-limits sqlite-backed access credentials", async () => {
    const store = createSqliteStore({ path: ":memory:" });
    const issued = issueAccessCredential({
      subjectId: "subj_dev",
      label: "Rate limited token",
      scope: "code",
      expiresAt: new Date("2030-02-01T00:00:00Z"),
      now: new Date("2026-01-01T00:00:00Z"),
      rate: {
        requestsPerMinute: 1,
        requestsPerDay: null,
        concurrentRequests: 1
      }
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
    const headers = { authorization: `Bearer ${issued.token}` };

    const first = await app.inject({
      method: "GET",
      url: "/gateway/status",
      headers
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: "GET",
      url: "/gateway/status",
      headers
    });
    expect(second.statusCode).toBe(429);
    expect(second.json().error).toMatchObject({
      code: "rate_limited",
      retry_after_seconds: expect.any(Number)
    });

    await app.close();
  });

  it("records request events for credential traffic and rate limits", async () => {
    const store = createSqliteStore({ path: ":memory:" });
    const issued = issueAccessCredential({
      subjectId: "subj_dev",
      label: "Observed token",
      scope: "code",
      expiresAt: new Date("2030-02-01T00:00:00Z"),
      now: new Date("2026-01-01T00:00:00Z"),
      rate: {
        requestsPerMinute: 1,
        requestsPerDay: null,
        concurrentRequests: 1
      }
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
    const headers = { authorization: `Bearer ${issued.token}` };

    const first = await app.inject({
      method: "GET",
      url: "/gateway/status",
      headers
    });
    const firstRequestId = expectRequestIdHeader(first);
    await app.inject({
      method: "GET",
      url: "/gateway/status",
      headers
    });

    const events = store.listRequestEvents({ credentialId: issued.record.id });
    expect(events).toHaveLength(2);
    expect(events.map((event) => event.requestId)).toContain(firstRequestId);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          credentialId: issued.record.id,
          subjectId: "subj_dev",
          scope: "code",
          status: "ok",
          errorCode: null,
          rateLimited: false
        }),
        expect.objectContaining({
          credentialId: issued.record.id,
          subjectId: "subj_dev",
          scope: "code",
          status: "error",
          errorCode: "rate_limited",
          rateLimited: true
        })
      ])
    );
    expect(events.every((event) => event.durationMs !== null)).toBe(true);
    expect(events.every((event) => event.firstByteMs !== null)).toBe(true);

    await app.close();
  });

  it("records provider token usage in request observations", async () => {
    const store = createSqliteStore({ path: ":memory:" });
    const issued = issueAccessCredential({
      subjectId: "subj_dev",
      label: "Observed usage token",
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
    const provider = new FakeProvider([
      { type: "message_delta", text: "ok" },
      {
        type: "completed",
        providerSessionRef: "provider_thread_1",
        usage: {
          promptTokens: 10,
          completionTokens: 2,
          totalTokens: 12,
          cachedPromptTokens: 4
        }
      }
    ]);
    const app = buildGateway({
      authMode: "credential",
      provider,
      sessionStore: store,
      logger: false
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${issued.token}` },
      payload: {
        model: "medcode",
        messages: [{ role: "user", content: "Say ok." }]
      }
    });
    const requestId = expectRequestIdHeader(response);

    expect(response.statusCode).toBe(200);
    expect(store.listRequestEvents({ credentialId: issued.record.id })).toEqual([
      expect.objectContaining({
        requestId,
        credentialId: issued.record.id,
        promptTokens: 10,
        completionTokens: 2,
        totalTokens: 12,
        cachedPromptTokens: 4,
        estimatedTokens: null,
        usageSource: "provider"
      })
    ]);

    await app.close();
  });

  it("keeps credentials without token policy usable and records soft-write usage", async () => {
    const store = createSqliteStore({ path: ":memory:" });
    const issued = issueAccessCredential({
      subjectId: "subj_dev",
      label: "Legacy usage token",
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
    const provider = new FakeProvider([
      { type: "message_delta", text: "ok" },
      {
        type: "completed",
        providerSessionRef: "provider_thread_1",
        usage: {
          promptTokens: 10,
          completionTokens: 2,
          totalTokens: 12
        }
      }
    ]);
    const app = buildGateway({
      authMode: "credential",
      provider,
      sessionStore: store,
      logger: false
    });
    const headers = { authorization: `Bearer ${issued.token}` };

    const current = await app.inject({
      method: "GET",
      url: "/gateway/credentials/current",
      headers
    });
    expect(current.statusCode).toBe(200);
    expect(current.json()).not.toHaveProperty("token_usage");

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers,
      payload: {
        model: "medcode",
        messages: [{ role: "user", content: "Say ok." }]
      }
    });

    expect(response.statusCode).toBe(200);
    expect(provider.messages).toHaveLength(1);
    const limiter = createSqliteTokenBudgetLimiter({ db: store.database });
    const reservations = limiter.listReservations({
      subjectId: "subj_dev",
      includeFinalized: true
    });
    expect(reservations).toHaveLength(1);
    expect(reservations[0]).toMatchObject({
      kind: "soft_write",
      reservedTokens: 0,
      finalTotalTokens: 12,
      finalUsageSource: "soft_write"
    });
    expect(store.listRequestEvents({ credentialId: issued.record.id })[0]).toMatchObject({
      reservationId: reservations[0].id,
      totalTokens: 12,
      usageSource: "provider"
    });

    await app.close();
  });

  it("uses active plan entitlements for token budgets without exposing internal charge fields", async () => {
    const store = createSqliteStore({ path: ":memory:" });
    const issued = issueAccessCredential({
      subjectId: "subj_dev",
      label: "Entitled credential",
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
    store.createPlan({
      id: "plan_pro_v1",
      displayName: "Pro",
      scopeAllowlist: ["code"],
      policy: {
        tokensPerMinute: 1_000,
        tokensPerDay: 10_000,
        tokensPerMonth: null,
        maxPromptTokensPerRequest: 500,
        maxTotalTokensPerRequest: 1_000,
        reserveTokensPerRequest: 100,
        missingUsageCharge: "reserve"
      },
      now: new Date("2026-01-01T00:00:00Z")
    });
    const entitlement = store.grantEntitlement({
      subjectId: "subj_dev",
      planId: "plan_pro_v1",
      periodKind: "unlimited",
      now: new Date("2026-01-01T00:00:00Z")
    });
    const provider = new FakeProvider([
      { type: "message_delta", text: "ok" },
      {
        type: "completed",
        providerSessionRef: "provider_thread_1",
        usage: {
          promptTokens: 10,
          completionTokens: 2,
          totalTokens: 12
        }
      }
    ]);
    const app = buildGateway({
      authMode: "credential",
      provider,
      sessionStore: store,
      logger: false
    });
    const headers = { authorization: `Bearer ${issued.token}` };

    const current = await app.inject({
      method: "GET",
      url: "/gateway/credentials/current",
      headers
    });
    expect(current.statusCode).toBe(200);
    expect(current.json()).toMatchObject({
      plan: {
        display_name: "Pro",
        scope_allowlist: ["code"]
      },
      entitlement: {
        period_kind: "unlimited",
        period_end: null,
        state: "active"
      },
      credential: {
        token: {
          tokensPerMinute: 1_000,
          tokensPerDay: 10_000,
          tokensPerMonth: null,
          maxPromptTokensPerRequest: 500,
          maxTotalTokensPerRequest: 1_000
        }
      },
      token_usage: {
        source: "entitlement",
        day: {
          limit: 10_000,
          used: 0,
          reserved: 0,
          remaining: 10_000
        }
      }
    });
    expect(JSON.stringify(current.json())).not.toContain("reserveTokensPerRequest");
    expect(JSON.stringify(current.json())).not.toContain("missingUsageCharge");

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers,
      payload: {
        model: "medcode",
        messages: [{ role: "user", content: "Say ok." }]
      }
    });

    expect(response.statusCode).toBe(200);
    const limiter = createSqliteTokenBudgetLimiter({ db: store.database });
    const reservations = limiter.listReservations({
      subjectId: "subj_dev",
      includeFinalized: true
    });
    expect(reservations).toHaveLength(1);
    expect(reservations[0]).toMatchObject({
      kind: "reservation",
      entitlementId: entitlement.id,
      finalTotalTokens: 12,
      finalUsageSource: "provider"
    });

    await app.close();
  });

  it("shows inactive entitlement state on current credential validation without token fallback", async () => {
    const cases = [
      { state: "expired", reason: undefined },
      { state: "paused", reason: "paused" },
      { state: "cancelled", reason: "cancelled" }
    ] as const;

    for (const item of cases) {
      const store = createSqliteStore({ path: ":memory:" });
      const issued = issueAccessCredential({
        subjectId: "subj_dev",
        label: `${item.state} entitlement credential`,
        scope: "code",
        expiresAt: new Date("2030-02-01T00:00:00Z"),
        now: new Date("2026-01-01T00:00:00Z"),
        rate: {
          requestsPerMinute: 30,
          requestsPerDay: null,
          concurrentRequests: 1,
          token: {
            tokensPerMinute: 1,
            tokensPerDay: 1,
            tokensPerMonth: null,
            maxPromptTokensPerRequest: null,
            maxTotalTokensPerRequest: null,
            reserveTokensPerRequest: 10,
            missingUsageCharge: "reserve"
          }
        }
      });
      store.upsertSubject({
        id: "subj_dev",
        label: "Credential Subject",
        state: "active",
        createdAt: new Date("2026-01-01T00:00:00Z")
      });
      store.insertAccessCredential(issued.record);
      store.createPlan({
        id: `plan_${item.state}_v1`,
        displayName: "Trial",
        scopeAllowlist: ["code"],
        policy: {
          tokensPerMinute: null,
          tokensPerDay: 10_000,
          tokensPerMonth: null,
          maxPromptTokensPerRequest: null,
          maxTotalTokensPerRequest: null,
          reserveTokensPerRequest: 0,
          missingUsageCharge: "none"
        },
        now: new Date("2026-01-01T00:00:00Z")
      });
      const entitlement = store.grantEntitlement({
        subjectId: "subj_dev",
        planId: `plan_${item.state}_v1`,
        periodKind: item.state === "expired" ? "one_off" : "unlimited",
        periodStart:
          item.state === "expired" ? new Date("2000-01-01T00:00:00Z") : undefined,
        periodEnd:
          item.state === "expired" ? new Date("2000-01-02T00:00:00Z") : undefined,
        now: new Date("2026-01-01T00:00:00Z")
      });
      if (item.state === "paused") {
        store.pauseEntitlement({ id: entitlement.id });
      }
      if (item.state === "cancelled") {
        store.cancelEntitlement({ id: entitlement.id, reason: "test" });
      }

      const app = buildGateway({
        authMode: "credential",
        provider: new FakeProvider(),
        sessionStore: store,
        logger: false
      });
      const current = await app.inject({
        method: "GET",
        url: "/gateway/credentials/current",
        headers: { authorization: `Bearer ${issued.token}` }
      });
      const body = current.json();

      expect(current.statusCode).toBe(200);
      expect(body).toMatchObject({
        plan: {
          display_name: "Trial",
          scope_allowlist: ["code"]
        },
        entitlement: {
          period_kind: item.state === "expired" ? "one_off" : "unlimited",
          state: item.state,
          ...(item.reason ? { reason: item.reason } : {})
        }
      });
      expect(body.credential).not.toHaveProperty("token");
      expect(body).not.toHaveProperty("token_usage");
      expect(JSON.stringify(body)).not.toContain("reserveTokensPerRequest");
      expect(JSON.stringify(body)).not.toContain("missingUsageCharge");

      await app.close();
    }
  });

  it("rejects legacy users only when entitlement enforcement is enabled", async () => {
    const previousRequireEntitlement = process.env.GATEWAY_REQUIRE_ENTITLEMENT;
    process.env.GATEWAY_REQUIRE_ENTITLEMENT = "1";
    const store = createSqliteStore({ path: ":memory:" });
    const issued = issueAccessCredential({
      subjectId: "subj_dev",
      label: "Legacy strict credential",
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
    const provider = new FakeProvider();
    const app = buildGateway({
      authMode: "credential",
      provider,
      sessionStore: store,
      logger: false
    });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: { authorization: `Bearer ${issued.token}` },
        payload: {
          model: "medcode",
          messages: [{ role: "user", content: "Say ok." }]
        }
      });

      expect(response.statusCode).toBe(402);
      expect(response.json().error.code).toBe("plan_inactive");
      expect(provider.messages).toHaveLength(0);
    } finally {
      if (previousRequireEntitlement === undefined) {
        delete process.env.GATEWAY_REQUIRE_ENTITLEMENT;
      } else {
        process.env.GATEWAY_REQUIRE_ENTITLEMENT = previousRequireEntitlement;
      }
      await app.close();
    }
  });

  it("does not fall back to legacy token handling after an entitlement expires", async () => {
    const store = createSqliteStore({ path: ":memory:" });
    const issued = issueAccessCredential({
      subjectId: "subj_dev",
      label: "Expired entitlement credential",
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
    store.createPlan({
      id: "plan_trial_v1",
      displayName: "Trial",
      scopeAllowlist: ["code"],
      policy: {
        tokensPerMinute: null,
        tokensPerDay: 10_000,
        tokensPerMonth: null,
        maxPromptTokensPerRequest: null,
        maxTotalTokensPerRequest: null,
        reserveTokensPerRequest: 0,
        missingUsageCharge: "none"
      },
      now: new Date("2026-01-01T00:00:00Z")
    });
    const entitlement = store.grantEntitlement({
      subjectId: "subj_dev",
      planId: "plan_trial_v1",
      periodKind: "one_off",
      periodStart: new Date("2000-01-01T00:00:00Z"),
      periodEnd: new Date("2000-01-02T00:00:00Z"),
      now: new Date("2026-01-01T00:00:00Z")
    });
    const provider = new FakeProvider();
    const app = buildGateway({
      authMode: "credential",
      provider,
      sessionStore: store,
      logger: false
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${issued.token}` },
      payload: {
        model: "medcode",
        messages: [{ role: "user", content: "Say ok." }]
      }
    });

    expect(response.statusCode).toBe(402);
    expect(response.json().error.code).toBe("plan_expired");
    expect(provider.messages).toHaveLength(0);
    expect(store.getEntitlement(entitlement.id)?.state).toBe("expired");

    await app.close();
  });

  it("blocks only credentials with token policy when token budget is exceeded", async () => {
    const store = createSqliteStore({ path: ":memory:" });
    const issued = issueAccessCredential({
      subjectId: "subj_dev",
      label: "Token limited credential",
      scope: "code",
      expiresAt: new Date("2030-02-01T00:00:00Z"),
      now: new Date("2026-01-01T00:00:00Z"),
      rate: {
        requestsPerMinute: 30,
        requestsPerDay: null,
        concurrentRequests: 1,
        token: {
          tokensPerMinute: null,
          tokensPerDay: null,
          tokensPerMonth: null,
          maxPromptTokensPerRequest: null,
          maxTotalTokensPerRequest: 10,
          reserveTokensPerRequest: 100,
          missingUsageCharge: "reserve"
        }
      }
    });
    store.upsertSubject({
      id: "subj_dev",
      label: "Credential Subject",
      state: "active",
      createdAt: new Date("2026-01-01T00:00:00Z")
    });
    store.insertAccessCredential(issued.record);
    const provider = new FakeProvider();
    const app = buildGateway({
      authMode: "credential",
      provider,
      sessionStore: store,
      logger: false
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${issued.token}` },
      payload: {
        model: "medcode",
        messages: [{ role: "user", content: "Say ok." }]
      }
    });

    expect(response.statusCode).toBe(429);
    expect(response.json().error.code).toBe("rate_limited");
    expect(provider.messages).toHaveLength(0);
    expect(store.listRequestEvents({ credentialId: issued.record.id })).toEqual([
      expect.objectContaining({
        status: "error",
        errorCode: "rate_limited",
        rateLimited: true,
        limitKind: "token_request_total",
        reservationId: null
      })
    ]);

    await app.close();
  });

  it("records reserve token finalize source when provider usage is missing", async () => {
    const store = createSqliteStore({ path: ":memory:" });
    const issued = issueAccessCredential({
      subjectId: "subj_dev",
      label: "Reserve usage token",
      scope: "code",
      expiresAt: new Date("2030-02-01T00:00:00Z"),
      now: new Date("2026-01-01T00:00:00Z"),
      rate: {
        requestsPerMinute: 30,
        requestsPerDay: null,
        concurrentRequests: 1,
        token: {
          tokensPerMinute: null,
          tokensPerDay: null,
          tokensPerMonth: null,
          maxPromptTokensPerRequest: null,
          maxTotalTokensPerRequest: null,
          reserveTokensPerRequest: 100,
          missingUsageCharge: "reserve"
        }
      }
    });
    store.upsertSubject({
      id: "subj_dev",
      label: "Credential Subject",
      state: "active",
      createdAt: new Date("2026-01-01T00:00:00Z")
    });
    store.insertAccessCredential(issued.record);
    const provider = new FakeProvider([
      { type: "message_delta", text: "ok" },
      { type: "completed", providerSessionRef: "provider_thread_1" }
    ]);
    const app = buildGateway({
      authMode: "credential",
      provider,
      sessionStore: store,
      logger: false
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${issued.token}` },
      payload: {
        model: "medcode",
        messages: [{ role: "user", content: "Say ok." }]
      }
    });

    expect(response.statusCode).toBe(200);
    const events = store.listRequestEvents({ credentialId: issued.record.id });
    expect(events).toEqual([
      expect.objectContaining({
        usageSource: "reserve",
        promptTokens: null,
        totalTokens: null
      })
    ]);
    expect(events[0].estimatedTokens).toBeGreaterThanOrEqual(100);

    await app.close();
  });

  it("records strict tool validation failures in request observations", async () => {
    const store = createSqliteStore({ path: ":memory:" });
    const issued = issueAccessCredential({
      subjectId: "subj_dev",
      label: "Strict validation observed token",
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
    const provider = new FakeProvider([
      {
        type: "message_delta",
        text: JSON.stringify({
          type: "tool_calls",
          tool_calls: [
            {
              name: "shell",
              arguments: { command: "ls" }
            }
          ]
        })
      },
      { type: "completed", providerSessionRef: "provider_thread_1" }
    ]);
    const app = buildGateway({
      authMode: "credential",
      provider,
      sessionStore: store,
      logger: false
    });
    const headers = { authorization: `Bearer ${issued.token}` };

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers,
      payload: {
        model: "medcode",
        messages: [{ role: "user", content: "Use a medical evidence tool." }],
        tools: [
          {
            type: "function",
            function: {
              name: "medevidence",
              parameters: {
                type: "object",
                properties: { question: { type: "string" } },
                required: ["question"],
                additionalProperties: false
              }
            }
          }
        ]
      }
    });
    const requestId = expectRequestIdHeader(response);

    expect(response.statusCode).toBe(502);
    const events = store.listRequestEvents({ credentialId: issued.record.id });
    expect(events).toEqual([
      expect.objectContaining({
        requestId,
        credentialId: issued.record.id,
        subjectId: "subj_dev",
        scope: "code",
        status: "error",
        errorCode: "tool_call_validation_failed",
        rateLimited: false
      })
    ]);

    await app.close();
  });

  it("can persist sessions through the sqlite store", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "codex-gateway-app-"));
    const dbPath = path.join(dir, "gateway.db");
    const headers = { authorization: "Bearer secret" };

    try {
      const first = buildGateway({
        authMode: "dev",
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
        authMode: "dev",
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

function parseOpenAISseData(payload: string): unknown[] {
  return payload
    .split("\n\n")
    .map((frame) => frame.trim())
    .filter((frame) => frame.startsWith("data: "))
    .map((frame) => frame.slice("data: ".length))
    .filter((data) => data !== "[DONE]")
    .map((data) => JSON.parse(data) as unknown);
}

function expectRequestIdHeader(response: { headers: Record<string, unknown> }): string {
  const value = response.headers["x-request-id"];
  const requestId = Array.isArray(value) ? value[0] : value;
  expect(typeof requestId).toBe("string");
  expect(requestId).toMatch(/^req-/);
  return requestId as string;
}

function createCredentialBackedStore(rate?: RateLimitPolicy) {
  const store = createSqliteStore({ path: ":memory:" });
  const issued = issueAccessCredential({
    subjectId: "subj_dev",
    label: "Client event credential",
    scope: "code",
    expiresAt: new Date("2030-02-01T00:00:00Z"),
    now: new Date("2026-01-01T00:00:00Z"),
    rate
  });
  store.upsertSubject({
    id: "subj_dev",
    label: "Credential Subject",
    state: "active",
    createdAt: new Date("2026-01-01T00:00:00Z")
  });
  store.insertAccessCredential(issued.record);

  return {
    store,
    issued,
    headers: { authorization: `Bearer ${issued.token}` }
  };
}

function clientMessagePayload(overrides: Record<string, unknown> = {}) {
  return {
    schema: "client_message.v1",
    event_id: "evt_1",
    session_id: "ses_1",
    message_id: "msg_1",
    created_at: "2026-04-29T10:00:00.000Z",
    app: {
      name: "medevidence-desktop",
      version: "1.4.6"
    },
    agent: "research",
    provider_id: "medcode",
    model_id: "medcode",
    engine: "agent",
    text: "What is the latest evidence?",
    attachments: [],
    ...overrides
  };
}
