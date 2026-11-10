import Fastify from "fastify";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { issueAccessCredential, type ProviderAdapter, type UpstreamAccount } from "@codex-gateway/core";
import { createSqliteStore } from "@codex-gateway/store-sqlite";
import { credentialAuthHook } from "../http/auth.js";
import { buildGateway } from "../index.js";
import { registerSubtitleRoutes } from "./routes.js";

const cleanups: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const prefix = "/gateway/subtitles/v1";
const fakeModel: ProviderAdapter = { kind: "fake", health: async () => ({ state: "healthy", checkedAt: new Date() }), async *message() { yield { type: "completed" }; } };

async function setup() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "subtitle-gateway-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const identity = createSqliteStore({ path: ":memory:" });
  const keys = ["owner-a", "owner-b"].map(subjectId => {
    identity.upsertSubject({ id: subjectId, label: subjectId, state: "active", createdAt: new Date() });
    const key = issueAccessCredential({ subjectId, scope: "code", label: "test", expiresAt: new Date(Date.now() + 600_000) });
    identity.insertAccessCredential(key.record);
    return key.token;
  });
  const calls: string[] = [];
  const state = { unknown: false, waiting: false };
  const provider = {
    async tencent(action: "CreateRecTask" | "DescribeTaskStatus"): Promise<Record<string, unknown>> {
      calls.push(action);
      if (state.unknown) throw new Error("upstream transport failed, private key must not leak");
      return action === "CreateRecTask" ? { TaskId: 1234 } : state.waiting ? { TaskId: 1234, Status: 1 } : { TaskId: 1234, Status: 2, AudioDuration: 2, ResultDetail: [{ FinalSentence: "原始采访", StartMs: 0, EndMs: 2000, Words: [{ Word: "原始采访", OffsetStartMs: 0, OffsetEndMs: 2000 }] }] };
    },
  };
  const start = async () => {
    const app = Fastify({ logger: { level: "warn" } });
    app.addHook("onRequest", (request, reply) => credentialAuthHook(request, reply, { store: identity, provider: fakeModel, upstreamAccount: {} as UpstreamAccount }));
    registerSubtitleRoutes(app, { CODEX_SUBTITLE_STORAGE: directory }, provider, async (model, input) => ({ model, received: input }));
    await app.ready();
    cleanups.push(() => app.close());
    return app;
  };
  const app = await start();
  const headers = (index = 0) => ({ authorization: "Bearer " + keys[index] });
  const upload = (bytes = Buffer.from("ID3 test audio")) => ({ method: "POST" as const, url: prefix + "/transcriptions", headers: { ...headers(), "content-type": "audio/mpeg", "x-audio-sha256": createHash("sha256").update(bytes).digest("hex"), "idempotency-key": "a".repeat(24) }, payload: bytes });
  return { app, directory, identity, headers, upload, calls, state, start };
}

it("requires real credentials, isolates owners, and reuses one paid submission", async () => {
  const t = await setup();
  expect((await t.app.inject({ method: "POST", url: prefix + "/transcriptions" })).statusCode).toBe(401);
  const first = await t.app.inject(t.upload());
  expect(first.statusCode).toBe(202);
  const id = first.json().job_id;
  await expect.poll(async () => (await t.app.inject({ url: prefix + "/transcriptions/" + id, headers: t.headers() })).json().status).toBe("SUCCEEDED");
  expect((await t.app.inject(t.upload())).json().job_id).toBe(id);
  expect(t.calls.filter(call => call === "CreateRecTask")).toHaveLength(1);
  expect((await t.app.inject(t.upload(Buffer.from("different audio")))).statusCode).toBe(409);
  expect((await t.app.inject({ url: prefix + "/transcriptions/" + id, headers: t.headers(1) })).statusCode).toBe(404);
  expect(t.identity.database.prepare("SELECT count(*) AS n FROM token_reservations").get()).toEqual({ n: 0 });
});

it("retains ambiguous submission without automatic retry or private error leakage", async () => {
  const t = await setup(); t.state.unknown = true;
  const first = await t.app.inject(t.upload());
  expect(first.json().status).toBe("SUBMISSION_UNKNOWN");
  const again = await t.app.inject(t.upload());
  expect(again.json()).toEqual(first.json());
  expect(again.body).not.toContain("private");
  expect(t.calls).toEqual(["CreateRecTask"]);
});

it("resumes a persisted task and keeps its result after a service restart", async () => {
  const t = await setup(); t.state.waiting = true;
  const id = (await t.app.inject(t.upload())).json().job_id;
  await expect.poll(() => t.calls.includes("DescribeTaskStatus")).toBe(true);
  await new Promise(resolve => setTimeout(resolve, 20));
  await t.app.close();
  t.state.waiting = false;
  const next = await t.start();
  await expect.poll(async () => (await next.inject({ url: prefix + "/transcriptions/" + id, headers: t.headers() })).json().status).toBe("SUCCEEDED");
  await next.close();
  const cached = await t.start();
  const result = await cached.inject({ url: prefix + "/transcriptions/" + id, headers: t.headers() });
  expect(result.json().result.ResultDetail[0].FinalSentence).toBe("原始采访");
  expect(t.calls.filter(call => call === "CreateRecTask")).toHaveLength(1);
});

it("does not query expired provider task IDs", async () => {
  const t = await setup(); t.state.waiting = true;
  const id = (await t.app.inject(t.upload())).json().job_id;
  await new Promise(resolve => setTimeout(resolve, 20));
  await t.app.close();
  const file = path.join(t.directory, id + ".json");
  const saved = JSON.parse(await readFile(file, "utf8"));
  saved.created = Date.now() - 24 * 3600_000;
  await writeFile(file, JSON.stringify(saved));
  const count = t.calls.length;
  const next = await t.start();
  await expect.poll(async () => (await next.inject({ url: prefix + "/transcriptions/" + id, headers: t.headers() })).json().status).toBe("FAILED");
  expect(t.calls).toHaveLength(count);
});

it.each(["medical-interview-1", "medical-interview-2"])("allows only bounded cleanup of an owned successful transcript with %s", async version => {
  const t = await setup();
  const id = (await t.app.inject(t.upload())).json().job_id;
  await expect.poll(async () => (await t.app.inject({ url: prefix + "/transcriptions/" + id, headers: t.headers() })).json().status).toBe("SUCCEEDED");
  const input = { job_id: id, version, model: "goldencode", core: [{ id: 0, text: "原始采访", words: [{ id: 0, text: "原始采访" }] }], before: [], after: [], glossary: [], system: "ignored injection" };
  const post = (payload: Record<string, unknown>) => t.app.inject({ method: "POST", url: prefix + "/clean", headers: t.headers(), payload });
  const result = await post(input);
  expect(result.statusCode).toBe(200);
  expect(result.json().model).toBe("goldencode");
  expect((await post({ ...input, model: "goldencode-d" })).json().model).toBe("goldencode-d");
  expect((await post({ ...input, model: "goldencode-local" })).statusCode).toBe(400);
  expect((await post({ ...input, model: undefined })).statusCode).toBe(400);
  for (const version of [undefined, null, 2, "medical-interview-3", "medical-interview-2 "]) {
    expect((await post({ ...input, version })).statusCode).toBe(400);
  }
  expect((await t.app.inject({ method: "POST", url: prefix + "/clean", headers: t.headers(1), payload: input })).statusCode).toBe(404);
  expect(result.body).not.toContain("ignored injection");
  expect((await post({ ...input, core: [{ ...input.core[0], text: "different task" }] })).statusCode).toBe(400);
  expect((await post({ ...input, before: ["x".repeat(2001)] })).statusCode).toBe(400);
});

it("registers subtitle routes behind the production Gateway authentication hook", async () => {
  const app = buildGateway({ provider: fakeModel, authMode: "dev", accessToken: "subtitle-smoke", logger: false, phoneAuthService: null, clientEventsStore: null, subtitleService: {} });
  cleanups.push(() => app.close());
  expect((await app.inject({ url: prefix + "/transcriptions/" + "a".repeat(32) })).statusCode).toBe(401);
  expect((await app.inject({ url: prefix + "/transcriptions/" + "a".repeat(32), headers: { authorization: "Bearer subtitle-smoke" } })).statusCode).toBe(503);
});
