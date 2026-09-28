import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import {
  modelCallSchema,
  SqliteModelCalls,
} from "../../../packages/store-sqlite/src/model-calls.js";
import {
  registerModelCallRecovery,
  modelCallHeader,
  modelCallContractHeader,
} from "./model-call-recovery.js";
import { setupSseResponse } from "./http/sse.js";
import type { GatewayRequestContext } from "./http/context.js";
import { createSqliteStore } from "@codex-gateway/store-sqlite";
import { buildGateway } from "./index.js";
import { issueAccessCredential, type ProviderAdapter } from "@codex-gateway/core";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
  vi.restoreAllMocks();
});

function credentialGateway(provider: ProviderAdapter, requestsPerMinute = 30) {
  const store = createSqliteStore({ path: ":memory:" });
  store.upsertSubject({ id: "recovery-subject", label: "Recovery test", state: "active", createdAt: new Date() });
  const issued = issueAccessCredential({
    subjectId: "recovery-subject", label: "Recovery test", scope: "code",
    expiresAt: new Date(Date.now() + 86_400_000),
    rate: { requestsPerMinute, concurrentRequests: 1 },
  });
  store.insertAccessCredential(issued.record);
  const app = buildGateway({ authMode: "credential", logger: false, sessionStore: store, provider });
  cleanup.push(() => app.close());
  return { app, store, headers: { authorization: `Bearer ${issued.token}` } };
}

const modelPayload = { model: "medcode", stream: true, messages: [{ role: "user", content: "hello" }] };
const newCallId = () => `${Date.now()}_${randomUUID()}`;

function fixture(
  db = new DatabaseSync(":memory:"),
  now = Date.now,
  gate?: { entered(): void; wait: Promise<void> },
) {
  if (
    !db.prepare("SELECT name FROM sqlite_master WHERE name='model_calls'").get()
  )
    db.exec(modelCallSchema);
  const app = Fastify();
  const store = new SqliteModelCalls(db);
  app.addHook("onRequest", async (request, reply) => {
    if (!request.headers.authorization) return reply.code(401).send();
    request.gatewayContext = {
      subject: { id: request.headers.authorization },
      scope: "code",
    } as GatewayRequestContext;
    reply.header("x-request-id", request.id);
  });
  registerModelCallRecovery(app, store, now);
  const calls = { count: 0 };
  app.post("/v1/chat/completions", async (request, reply) => {
    calls.count++;
    reply.header("x-medcode-accepted-artifact-contract-version", "1");
    gate?.entered();
    await gate?.wait;
    if ((request.body as { stream?: boolean }).stream) {
      const stream = setupSseResponse(reply);
      stream.writeData({ choices: [{ delta: { content: "original" } }] });
      stream.writeDone();
      stream.end();
      return;
    }
    return { choices: [{ message: { content: "original" } }] };
  });
  cleanup.push(() => app.close());
  return { app, store, db, calls };
}

describe("durable model call recovery", () => {
  it("queries an in-flight call and rejects concurrent duplicate execution", async () => {
    let entered!: () => void;
    let release!: () => void;
    const running = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = fixture(undefined, Date.now, { entered, wait });
    const id = `${Date.now()}_${randomUUID()}`;
    const headers = { authorization: "user-a", [modelCallHeader]: id };
    const request = {
      method: "POST" as const,
      url: "/v1/chat/completions",
      headers,
      payload: { stream: true },
    };
    const original = f.app.inject(request).then((response) => response);
    await running;
    try {
      expect(
        (
          await f.app.inject({ url: `/gateway/model-calls/${id}`, headers })
        ).json().state,
      ).toBe("running");
      const duplicate = await f.app.inject(request);
      expect(duplicate.statusCode).toBe(409);
      expect(duplicate.json().error).toMatchObject({
        code: "model_call_pending",
        automatic_retry_allowed: false,
      });
      expect(f.calls.count).toBe(1);
    } finally {
      release();
    }
    await original;
    expect(
      (
        await f.app.inject({ url: `/gateway/model-calls/${id}`, headers })
      ).json().state,
    ).toBe("completed");
  });

  it("records the real Gateway model route before completion and serves it without provider work", async () => {
    const calls = { count: 0 };
    const app = buildGateway({
      authMode: "dev",
      accessToken: "recovery-test-only",
      logger: false,
      sessionStore: createSqliteStore({ path: ":memory:" }),
      provider: {
        kind: "recovery-test",
        health: async () => ({ state: "healthy", checkedAt: new Date() }),
        async *message() {
          calls.count++;
          yield { type: "message_delta", text: "original result" };
          yield { type: "completed", providerSessionRef: "recovery-test" };
        },
      },
    });
    cleanup.push(() => app.close());
    const id = `${Date.now()}_${randomUUID()}`;
    const headers = {
      authorization: "Bearer recovery-test-only",
      [modelCallHeader]: id,
    };
    const original = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers,
      payload: {
        model: "medcode",
        stream: true,
        messages: [{ role: "user", content: "hello" }],
      },
    });
    expect(original.statusCode).toBe(200);
    expect(original.headers[modelCallContractHeader]).toBe("1");
    expect(original.headers[modelCallHeader]).toBe(id);
    const receipt = await app.inject({
      url: `/gateway/model-calls/${id}`,
      headers,
    });
    expect(receipt.json()).toMatchObject({
      state: "completed",
      response: { body: original.body },
    });
    expect(calls.count).toBe(1);
  });
  it.each([true, false])(
    "recovers and deduplicates a completed response (stream=%s)",
    async (stream) => {
      const f = fixture();
      const id = `${Date.now()}_${randomUUID()}`;
      const request = {
        method: "POST" as const,
        url: "/v1/chat/completions",
        headers: {
          authorization: "user-a",
          [modelCallHeader]: id,
        },
        payload: { model: "goldencode", stream },
      };
      const original = await f.app.inject(request);
      const receipt = await f.app.inject({
        url: `/gateway/model-calls/${id}`,
        headers: { authorization: "user-a" },
      });
      expect(receipt.json()).toMatchObject({
        version: 1,
        state: "completed",
        response: { body: original.body },
      });
      const duplicate = await f.app.inject(request);
      expect(duplicate.body).toBe(original.body);
      expect(
        duplicate.headers["x-medcode-accepted-artifact-contract-version"],
      ).toBe("1");
      expect(f.calls.count).toBe(1);
      const conflict = await f.app.inject({
        ...request,
        payload: { ...request.payload, temperature: 1 },
      });
      expect(conflict.statusCode).toBe(409);
      expect(conflict.json().error.code).toBe("model_call_conflict");
      expect(f.calls.count).toBe(1);
      expect(
        (await f.app.inject({ url: `/gateway/model-calls/${id}` })).statusCode,
      ).toBe(401);
      expect(
        (
          await f.app.inject({
            url: `/gateway/model-calls/${id}`,
            headers: { authorization: "user-b" },
          })
        ).json().state,
      ).toBe("unknown");
    },
  );

  it("retains completed results across restart and never replays an abandoned in-flight call", async () => {
    const first = fixture();
    const id = `${Date.now()}_${randomUUID()}`;
    await first.app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: "user-a", [modelCallHeader]: id },
      payload: {},
    });
    const abandoned = `${Date.now()}_${randomUUID()}`;
    first.store.admit({
      subject: "user-a",
      scope: "code",
      id: abandoned,
      request: "req-old",
      fingerprint: first.store.get("user-a", "code", id)!.fingerprint,
      owner: "old-process",
      now: Date.now(),
    });
    await first.app.close();
    const next = fixture(first.db);
    expect(
      (
        await next.app.inject({
          url: `/gateway/model-calls/${id}`,
          headers: { authorization: "user-a" },
        })
      ).json().state,
    ).toBe("completed");
    expect(
      (
        await next.app.inject({
          url: `/gateway/model-calls/${abandoned}`,
          headers: { authorization: "user-a" },
        })
      ).json().state,
    ).toBe("unknown");
    expect((await next.app.inject({ method: "POST", url: "/v1/chat/completions",
      headers: { authorization: "user-a", [modelCallHeader]: abandoned }, payload: {},
    })).json().error.code).toBe("model_call_unconfirmed");
    expect(next.calls.count).toBe(0);
  });

  it("expires stored content and rejects stale IDs after tombstone removal", async () => {
    const time = { now: Date.now() };
    const f = fixture(undefined, () => time.now);
    const id = `${time.now}_${randomUUID()}`;
    const request = {
      method: "POST" as const,
      url: "/v1/chat/completions",
      headers: { authorization: "user-a", [modelCallHeader]: id },
      payload: {},
    };
    await f.app.inject(request);
    time.now += 86_400_001;
    f.store.prune(time.now);
    expect(f.store.get("user-a", "code", id)?.response_json).toBeNull();
    expect(
      (
        await f.app.inject({
          url: `/gateway/model-calls/${id}`,
          headers: { authorization: "user-a" },
        })
      ).json().state,
    ).toBe("expired");
    expect((await f.app.inject(request)).json().error.code).toBe("model_call_expired");
    time.now += 8 * 86_400_000;
    f.store.prune(time.now);
    expect((await f.app.inject(request)).statusCode).toBe(409);
    expect(f.calls.count).toBe(1);
  });

  it("never treats an oversized result as safe to execute again", () => {
    const f = fixture();
    f.store.admit({
      subject: "a",
      scope: "code",
      id: "call",
      fingerprint: "hash",
      request: "req",
      owner: "owner",
      now: Date.now(),
    });
    f.store.finish("a", "code", "call", {
      status: 200,
      headers: {},
      body: "x".repeat(8 * 1024 * 1024),
    });
    expect(f.store.get("a", "code", "call")).toMatchObject({
      state: "unknown",
      response_json: null,
    });
    expect(
      f.store.admit({
        subject: "a",
        scope: "code",
        id: "call",
        fingerprint: "hash",
        request: "req",
        owner: "owner",
        now: Date.now(),
      }),
    ).toBe(false);
  });

  it.each([false, true])("persists and replays a real SSE failure (partial=%s)", async (partial) => {
    let calls = 0;
    const f = credentialGateway({
      kind: "recovery-test", health: async () => ({ state: "healthy", checkedAt: new Date() }),
      async *message() {
        calls++;
        if (partial) yield { type: "message_delta", text: "partial" };
        yield { type: "error", code: "upstream_timeout", message: "Synthetic timeout" };
      },
    });
    const id = newCallId();
    const request = { method: "POST" as const, url: "/v1/chat/completions",
      headers: { ...f.headers, [modelCallHeader]: id }, payload: modelPayload };
    const original = await f.app.inject(request);
    expect(original.statusCode).toBe(partial ? 200 : 504);
    expect(original.body).toContain('"code":"upstream_timeout"');
    const receipt = (await f.app.inject({ url: `/gateway/model-calls/${id}`, headers: f.headers })).json();
    expect(receipt).toMatchObject({ state: "failed", response: {
      status: original.statusCode, body: original.body,
      headers: { "content-type": original.headers["content-type"], "x-request-id": original.headers["x-request-id"] },
    } });
    const replay = await f.app.inject(request);
    expect(replay.statusCode).toBe(original.statusCode);
    expect(replay.body).toBe(original.body);
    expect(calls).toBe(1);
  });

  it("does not consume model frequency for replay and saves a model admission rejection", async () => {
    let calls = 0;
    const f = credentialGateway({
      kind: "recovery-test", health: async () => ({ state: "healthy", checkedAt: new Date() }),
      async *message() { calls++; yield { type: "message_delta", text: "original" }; yield { type: "completed" }; },
    }, 2);
    const id = newCallId();
    const request = { method: "POST" as const, url: "/v1/chat/completions",
      headers: { ...f.headers, [modelCallHeader]: id }, payload: modelPayload };
    const original = await f.app.inject(request);
    for (let n = 0; n < 3; n++) expect((await f.app.inject(request)).body).toBe(original.body);
    expect((await f.app.inject({ ...request, headers: { ...f.headers, [modelCallHeader]: newCallId() } })).statusCode).toBe(200);
    const rejectedId = newCallId();
    const rejected = await f.app.inject({ ...request, headers: { ...f.headers, [modelCallHeader]: rejectedId } });
    expect(rejected.statusCode).toBe(429);
    const receipt = (await f.app.inject({ url: `/gateway/model-calls/${rejectedId}`, headers: f.headers })).json();
    expect(receipt).toMatchObject({ state: "failed", response: { status: 429, body: rejected.body,
      headers: { "retry-after": rejected.headers["retry-after"], "x-gateway-limit-kind": "request_minute",
        "x-gateway-rate-limit-origin": "gateway" } } });
    expect((await f.app.inject(request)).statusCode).toBe(200);
    expect(calls).toBe(2);
  });

  it("allows same-subject credential rotation but isolates subjects and scopes", async () => {
    const f = credentialGateway({ kind: "recovery-test", health: async () => ({ state: "healthy", checkedAt: new Date() }),
      async *message() { yield { type: "message_delta", text: "private result" }; yield { type: "completed" }; } });
    const id = newCallId();
    await f.app.inject({ method: "POST", url: "/v1/chat/completions",
      headers: { ...f.headers, [modelCallHeader]: id }, payload: modelPayload });
    f.store.upsertSubject({ id: "other", label: "Other", state: "active", createdAt: new Date() });
    for (const [subjectId, scope, expected] of [
      ["recovery-subject", "code", "completed"], ["recovery-subject", "medical", "unknown"], ["other", "code", "unknown"],
    ] as const) {
      const key = issueAccessCredential({ subjectId, scope, label: "Rotated or isolated", expiresAt: new Date(Date.now() + 60_000) });
      f.store.insertAccessCredential(key.record);
      const receipt = (await f.app.inject({ url: `/gateway/model-calls/${id}`, headers: { authorization: `Bearer ${key.token}` } })).json();
      expect(receipt.state).toBe(expected);
      if (expected === "unknown") expect(receipt.response).toBeUndefined();
    }
  });

  it("can query and replay while the model concurrency slot is occupied", async () => {
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const wait = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const f = credentialGateway({
      kind: "recovery-test", health: async () => ({ state: "healthy", checkedAt: new Date() }),
      async *message() {
        if (++calls === 2) { entered(); await wait; }
        yield { type: "message_delta", text: "original" }; yield { type: "completed" };
      },
    });
    const id = newCallId(), runningId = newCallId();
    const request = { method: "POST" as const, url: "/v1/chat/completions",
      headers: { ...f.headers, [modelCallHeader]: id }, payload: modelPayload };
    const original = await f.app.inject(request);
    const runningRequest = { ...request, headers: { ...f.headers, [modelCallHeader]: runningId } };
    const running = f.app.inject(runningRequest).then((r) => r);
    await started;
    try {
      expect((await f.app.inject({ url: `/gateway/model-calls/${runningId}`, headers: f.headers })).json().state).toBe("running");
      expect((await f.app.inject(runningRequest)).json().error.code).toBe("model_call_pending");
      expect((await f.app.inject(request)).body).toBe(original.body);
      const blocked = await f.app.inject({ ...request, headers: { ...f.headers, [modelCallHeader]: newCallId() } });
      expect(blocked.statusCode).toBe(429);
      expect(blocked.json().error.limit_kind).toBe("concurrency");
      expect(calls).toBe(2);
    } finally { release(); await running; }
  });

  it("ignores observation headers and JSON property ordering, but binds arrays and execution headers", async () => {
    const f = fixture();
    const request = { method: "POST" as const, url: "/v1/chat/completions",
      headers: { authorization: "user-a", [modelCallHeader]: newCallId(), "x-medcode-client-app-version": "2.0.0-beta.85" },
      payload: { model: "medcode", messages: [{ role: "user", content: "one" }, { role: "user", content: "two" }] } };
    const original = await f.app.inject(request);
    const replay = await f.app.inject({ ...request,
      headers: { ...request.headers, "x-medcode-client-app-version": "2.0.0-beta.86", "x-medcode-client-message-id": "new-observation" },
      payload: { messages: request.payload.messages.map(({ role, content }) => ({ content, role })), model: "medcode" } });
    expect(replay.body).toBe(original.body);
    expect((await f.app.inject({ ...request, payload: { ...request.payload, messages: [...request.payload.messages].reverse() } })).json().error.code).toBe("model_call_conflict");
    for (const name of ["x-medcode-request-timeout-ms", "x-medcode-vision-recovery-contract", "x-medcode-client-capabilities",
      "x-medcode-client-session-id", "x-medcode-client-turn-id", "x-medcode-write-delivery-nonce"]) {
      expect((await f.app.inject({ ...request, headers: { ...request.headers, [name]: "changed" } })).json().error.code).toBe("model_call_conflict");
    }
    expect(f.calls.count).toBe(1);
  });

  it("fails closed before execution if admission cannot be stored", async () => {
    const f = fixture();
    vi.spyOn(f.store, "admit").mockImplementation(() => { throw new Error("Synthetic disk failure"); });
    const response = await f.app.inject({ method: "POST", url: "/v1/chat/completions",
      headers: { authorization: "user-a", [modelCallHeader]: newCallId() }, payload: {} });
    expect(response.statusCode).toBe(500);
    expect(f.calls.count).toBe(0);
  });

  it("keeps the original stream intact but blocks reexecution if receipt storage fails", async () => {
    const f = fixture();
    const id = newCallId();
    vi.spyOn(f.store, "finish").mockImplementation(() => { throw new Error("Synthetic disk failure"); });
    const request = { method: "POST" as const, url: "/v1/chat/completions",
      headers: { authorization: "user-a", [modelCallHeader]: id }, payload: { stream: true } };
    const original = await f.app.inject(request);
    expect(original.body).toContain("data: [DONE]");
    expect((await f.app.inject({ url: `/gateway/model-calls/${id}`, headers: request.headers })).json().state).toBe("unknown");
    expect((await f.app.inject(request)).json().error.code).toBe("model_call_unconfirmed");
    expect(f.calls.count).toBe(1);
  });

  it("limits receipt traffic independently and returns the actual reset delay", async () => {
    const now = Date.UTC(2026, 8, 28, 0, 0, 10);
    const f = fixture(undefined, () => now);
    const query = { url: `/gateway/model-calls/${now}_${randomUUID()}`, headers: { authorization: "user-a" } };
    for (let n = 0; n < 120; n++) expect((await f.app.inject(query)).statusCode).toBe(200);
    const limited = await f.app.inject(query);
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["retry-after"]).toBe("50");
    expect(limited.json().error.code).toBe("model_call_query_limited");
    expect((await f.app.inject({ ...query, headers: { authorization: "user-b" } })).statusCode).toBe(200);
    expect(f.calls.count).toBe(0);
  });

  it("recovers a completed result when the real socket is destroyed before DONE is delivered", async () => {
    const f = fixture();
    let closed!: () => void;
    const socketClosed = new Promise<void>((resolve) => { closed = resolve; });
    f.app.addHook("preHandler", async (request, reply) => {
      if (request.method !== "POST") return;
      reply.raw.once("close", closed);
      const write = reply.raw.write.bind(reply.raw);
      reply.raw.write = ((chunk: unknown, ...args: unknown[]) => {
        if (String(chunk) === "data: [DONE]\n\n") { reply.raw.destroy(); return false; }
        return Reflect.apply(write, reply.raw, [chunk, ...args]);
      }) as typeof reply.raw.write;
    });
    const address = await f.app.listen({ port: 0, host: "127.0.0.1" });
    const id = newCallId();
    const headers = { authorization: "user-a", [modelCallHeader]: id, "content-type": "application/json" };
    const received = fetch(`${address}/v1/chat/completions`, {
      method: "POST", headers, body: JSON.stringify({ stream: true }),
    }).then((response) => response.text()).catch(() => "");
    await socketClosed;
    expect(await received).not.toContain("data: [DONE]");
    const receipt = (await f.app.inject({ url: `/gateway/model-calls/${id}`, headers })).json();
    expect(receipt.state).toBe("completed");
    expect(receipt.response.body).toContain("original");
    expect(receipt.response.body).toContain("data: [DONE]");
    expect(f.calls.count).toBe(1);
  });
});
