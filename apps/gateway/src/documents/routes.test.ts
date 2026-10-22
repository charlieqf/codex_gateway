import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { issueAccessCredential, issueUnifiedClientKey, type ProviderAdapter } from "@codex-gateway/core";
import { createSqliteStore } from "@codex-gateway/store-sqlite";
import { buildGateway } from "../index.js";

const cleanups: (() => unknown | Promise<unknown>)[] = [];
const prefix = "/gateway/documents/v1", id = "a".repeat(64), token = "internal-service-secret-".repeat(2);
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function setup(enabled = true, handler?: (request: IncomingMessage, response: ServerResponse, body: Buffer) => void | Promise<void>, env: NodeJS.ProcessEnv = {}, logs?: string[]) {
  const calls: { url: string; owner: string; authorization: string; sha: string; body: Buffer }[] = [];
  const upstream = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    calls.push({ url: request.url!, owner: String(request.headers["x-document-owner"]), authorization: String(request.headers.authorization), sha: String(request.headers["x-content-sha256"]), body: Buffer.concat(chunks) });
    if (handler) { await handler(request, response, Buffer.concat(chunks)); return; }
    if (request.url?.endsWith("/select")) { response.writeHead(500); response.end("private upstream exception and token"); return; }
    response.writeHead(request.method === "POST" ? 202 : 200, { "content-type": "application/json" });
    response.end(JSON.stringify({ document_id: id, state: "queued" }));
  });
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve, reject) => { upstream.close(error => error ? reject(error) : resolve()); upstream.closeAllConnections(); }));
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("missing upstream address");
  const identity = createSqliteStore({ path: ":memory:" });
  const keys = ["document-owner-a", "document-owner-b", "new-account-c", "new-account-d", "new-account-e"].map(subjectId => {
    identity.upsertSubject({ id: subjectId, label: subjectId, state: "active", createdAt: new Date() });
    const key = issueAccessCredential({ subjectId, scope: "code", label: "test", expiresAt: new Date(Date.now() + 600000) });
    identity.insertAccessCredential(key.record); return key.token;
  });
  const provider: ProviderAdapter = { kind: "fake", health: async () => ({ state: "healthy", checkedAt: new Date() }), async *message() { yield { type: "completed" }; } };
  const app = buildGateway({ provider, sessionStore: identity, authMode: "credential", logger: logs ? { stream: { write(line: string) { logs.push(line); } } } : false, phoneAuthService: null, clientEventsStore: null, imagingService: null, aipalService: null, panechoService: null, echonetService: null, echonextService: null, alphafold3Service: null,
    documentEvidence: enabled ? { CODEX_DOCUMENT_EVIDENCE_URL: `http://127.0.0.1:${address.port}`, CODEX_DOCUMENT_EVIDENCE_TOKEN: token, ...env } : {},
  });
  cleanups.push(() => app.close());
  const headers = (account = 0) => ({ authorization: "Bearer " + keys[account] });
  return { app, calls, headers, identity, keys };
}

it("authenticates through the real Gateway and derives ownership without trusting client headers", async () => {
  const t = await setup();
  expect((await t.app.inject({ url: prefix + "/documents/" + id })).statusCode).toBe(401);
  expect(t.calls).toHaveLength(0);
  for (const account of [0, 1]) {
    const response = await t.app.inject({ url: prefix + "/documents/" + id, headers: { ...t.headers(account), "x-document-owner": "spoofed-owner", "x-service-token": "spoofed-token" } });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toContain("no-store");
  }
  expect(t.calls[0]!.owner).toMatch(/^[a-f0-9]{64}$/);
  expect(t.calls[0]!.owner).not.toBe(t.calls[1]!.owner);
  expect(t.calls.map(call => call.authorization)).toEqual(["Bearer " + token, "Bearer " + token]);
});

it("forwards exact PDF bytes and source hash, rejects invalid uploads and non-contract paths", async () => {
  const t = await setup();
  const pdf = Buffer.from("%PDF-1.7\noriginal test bytes\n"), sha = createHash("sha256").update(pdf).digest("hex");
  const response = await t.app.inject({ method: "POST", url: prefix + "/documents", headers: { ...t.headers(), "content-type": "application/pdf", "x-content-sha256": sha }, payload: pdf });
  expect(response.statusCode).toBe(202);
  expect(t.calls[0]!.body).toEqual(pdf);
  expect(t.calls[0]!.sha).toBe(sha);
  expect((await t.app.inject({ method: "POST", url: prefix + "/documents", headers: { ...t.headers(), "content-type": "application/pdf" }, payload: pdf })).statusCode).toBe(400);
  expect((await t.app.inject({ url: prefix + "/documents/" + id + "?other=private", headers: t.headers() })).statusCode).toBe(404);
  expect((await t.app.inject({ url: prefix + "/documents/not-a-document", headers: t.headers() })).statusCode).toBe(404);
  expect(t.calls).toHaveLength(1);
});

it("defaults to disabled and bounds control input without exposing upstream errors", async () => {
  const disabled = await setup(false);
  expect((await disabled.app.inject({ url: prefix + "/documents/" + id, headers: disabled.headers() })).statusCode).toBe(503);
  expect(disabled.calls).toHaveLength(0);
  const t = await setup();
  const request = { method: "POST" as const, url: prefix + "/documents/" + id + "/select", headers: { ...t.headers(), "content-type": "application/json" } };
  expect((await t.app.inject({ ...request, payload: JSON.stringify({ padding: "x".repeat(8192) }) })).statusCode).toBe(413);
  expect(t.calls).toHaveLength(0);
  const response = await t.app.inject({ ...request, payload: JSON.stringify({ asset_id: "a".repeat(24), rows: [1], columns: [1, 2] }) });
  expect(response.statusCode).toBe(502);
  expect(response.json()).toEqual({ error: { code: "document_service_failed" } });
  expect(response.body).not.toContain("private");
});

it("admits current and newly issued accounts without a pilot list or model allowance", async () => {
  const t = await setup(true, undefined, { CODEX_DOCUMENT_EVIDENCE_SUBJECTS: "obsolete-pilot" });
  const before = t.identity.database.prepare("SELECT count(*) AS n FROM token_reservations").get();
  for (const account of [0, 1, 2]) {
    expect((await t.app.inject({ url: prefix + "/documents/" + id, headers: t.headers(account) })).statusCode).toBe(200);
  }
  t.identity.upsertSubject({ id: "registered-after-start", label: "new", state: "active", createdAt: new Date() });
  const key = issueAccessCredential({ subjectId: "registered-after-start", scope: "code", label: "new", expiresAt: new Date(Date.now() + 600000) });
  t.identity.insertAccessCredential(key.record);
  expect((await t.app.inject({ url: prefix + "/documents/" + id, headers: { authorization: "Bearer " + key.token } })).statusCode).toBe(200);
  expect(t.identity.database.prepare("SELECT count(*) AS n FROM token_reservations").get()).toEqual(before);
  expect(t.calls).toHaveLength(4);
});

it("uses stable subject ownership across keys and denies cross-account operations", async () => {
  let owner = "";
  const t = await setup(true, (request, response) => {
    if (request.url === "/documents") owner = String(request.headers["x-document-owner"]);
    const allowed = request.headers["x-document-owner"] === owner;
    response.writeHead(allowed ? 200 : 404, { "content-type": "application/json" });
    response.end(JSON.stringify(allowed ? { state: "completed" } : { error: { code: "not_found" } }));
  });
  const pdf = Buffer.from("%PDF-1.7\nowner test");
  expect((await t.app.inject({ method: "POST", url: prefix + "/documents", headers: { ...t.headers(), "content-type": "application/pdf", "x-content-sha256": createHash("sha256").update(pdf).digest("hex") }, payload: pdf })).statusCode).toBe(200);
  for (const [method, suffix] of [["GET", ""], ["GET", "/catalog"], ["GET", "/assets/" + "b".repeat(24) + ".png"], ["POST", "/refine"], ["POST", "/select"], ["DELETE", ""]] as const) {
    const response = await t.app.inject({ method, url: prefix + "/documents/" + id + suffix,
      headers: { ...t.headers(1), "x-document-owner": owner, "x-service-token": token },
      ...(method === "POST" ? { payload: { asset_id: "b".repeat(24), rows: [1], columns: [1], owner, token } } : {}) });
    expect(response.statusCode).toBe(404);
  }
  const rotated = issueAccessCredential({ subjectId: "document-owner-a", scope: "code", label: "rotated", expiresAt: new Date(Date.now() + 600000) });
  t.identity.insertAccessCredential(rotated.record);
  expect((await t.app.inject({ url: prefix + "/documents/" + id, headers: { authorization: "Bearer " + rotated.token } })).statusCode).toBe(200);
  const forwarded = JSON.parse(t.calls.find(call => call.url.endsWith("/select"))!.body.toString());
  expect(forwarded).toEqual({ asset_id: "b".repeat(24), rows: [1], columns: [1] });
});

it("bounds uploads at 50 MiB and control bodies at 8 KiB, then releases failed admissions", async () => {
  const t = await setup();
  const pdf = Buffer.alloc(50 * 1024 * 1024, 32); pdf.write("%PDF-1.7");
  const headers = { ...t.headers(), "content-type": "application/pdf", "x-content-sha256": createHash("sha256").update(pdf).digest("hex") };
  expect((await t.app.inject({ method: "POST", url: prefix + "/documents", headers, payload: pdf })).statusCode).toBe(202);
  expect(t.calls[0]!.body.length).toBe(pdf.length);
  expect((await t.app.inject({ method: "POST", url: prefix + "/documents", headers, payload: Buffer.alloc(pdf.length + 1) })).statusCode).toBe(413);
  for (let i = 0; i < 4; i++) {
    expect((await t.app.inject({ method: "POST", url: prefix + "/documents/" + id + "/select", headers: { ...t.headers(), "content-type": "application/json" }, payload: "{" })).statusCode).toBe(400);
  }
  expect((await t.app.inject({ url: prefix + "/documents/" + id, headers: t.headers() })).statusCode).toBe(200);
});

it("preserves explicit worker errors and suppresses internal exception bodies", async () => {
  let status = 429;
  const t = await setup(true, (_request, response) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { code: status === 429 ? "queue_full" : "private_internal_secret", message: "sensitive details" } }));
  });
  for (const expected of [429, 400, 404, 409, 413, 503, 500, 401]) {
    status = expected;
    const response = await t.app.inject({ url: prefix + "/documents/" + id, headers: t.headers() });
    expect(response.statusCode).toBe([500, 401].includes(status) ? 502 : status);
    expect(response.body).not.toContain("sensitive details");
    if (status >= 500 || status === 401) expect(response.body).not.toContain("private_internal_secret");
    if (status === 429) expect(response.json().error.code).toBe("queue_full");
  }
});

it("bounds upstream declared and streamed sizes and checks response formats", async () => {
  let mode = "declared";
  const t = await setup(true, (request, response) => {
    const png = request.url!.endsWith(".png");
    response.setHeader("content-type", png ? "image/png" : "application/json");
    if (mode === "declared") { response.setHeader("content-length", (png ? 20 : 8) * 1024 * 1024 + 1); response.flushHeaders(); return; }
    if (mode === "streamed") { response.end(Buffer.alloc((png ? 20 : 8) * 1024 * 1024 + 1)); return; }
    response.end(mode === "valid" ? Buffer.from("89504e470d0a1a0a0000", "hex") : Buffer.from("private broken output"));
  });
  for (const value of ["declared", "streamed", "invalid"]) {
    mode = value;
    for (const suffix of ["/catalog", "/assets/" + "b".repeat(24) + ".png"]) {
      const response = await t.app.inject({ url: prefix + "/documents/" + id + suffix, headers: t.headers() });
      expect(response.statusCode).toBe(502);
      expect(response.body).not.toContain("private broken output");
    }
  }
  mode = "valid";
  const response = await t.app.inject({ url: prefix + "/documents/" + id + "/assets/" + "b".repeat(24) + ".png", headers: t.headers() });
  expect(response.statusCode).toBe(200);
  expect(response.rawPayload).toEqual(Buffer.from("89504e470d0a1a0a0000", "hex"));
});

it("limits per-subject and global work and releases permits after completion", async () => {
  const pending: ServerResponse[] = [];
  const t = await setup(true, (_request, response) => { pending.push(response); });
  const jobs: Promise<unknown>[] = [];
  for (let account = 0; account < 4; account++) {
    for (let n = 0; n < 2; n++) jobs.push(Promise.resolve(t.app.inject({ url: prefix + "/documents/" + id, headers: t.headers(account) })));
    await vi.waitFor(() => expect(pending).toHaveLength((account + 1) * 2));
    expect((await t.app.inject({ url: prefix + "/documents/" + id, headers: t.headers(account) })).statusCode).toBe(429);
  }
  expect((await t.app.inject({ url: prefix + "/documents/" + id, headers: t.headers(4) })).statusCode).toBe(429);
  for (const response of pending.splice(0)) response.writeHead(200, { "content-type": "application/json" }).end("{}");
  await Promise.all(jobs);
  const next = Promise.resolve(t.app.inject({ url: prefix + "/documents/" + id, headers: t.headers(4) }));
  await vi.waitFor(() => expect(pending).toHaveLength(1));
  pending[0]!.writeHead(200, { "content-type": "application/json" }).end("{}");
  expect((await next).statusCode).toBe(200);
});

it("admits before reading slow upload bodies and frees permits on disconnect", async () => {
  const t = await setup();
  let parsing = 0;
  t.app.addHook("preParsing", async request => { if (request.method === "POST") parsing++; });
  const address = await t.app.listen({ port: 0, host: "127.0.0.1" });
  const requests = [0, 1].map(() => {
    const request = httpRequest(address + prefix + "/documents", { method: "POST", headers: { ...t.headers(), "content-type": "application/pdf", "x-content-sha256": id, "content-length": "100" } });
    request.on("error", () => {}); request.write("%PDF-"); return request;
  });
  try {
    await vi.waitFor(() => expect(parsing).toBe(2), { timeout: 4000 });
    expect((await t.app.inject({ url: prefix + "/documents/" + id, headers: t.headers() })).statusCode).toBe(429);
    expect(t.calls).toHaveLength(0);
  } finally { for (const request of requests) request.destroy(); }
  await vi.waitFor(async () => expect((await t.app.inject({ url: prefix + "/documents/" + id, headers: t.headers() })).statusCode).toBe(200));
});

it("returns a bounded unavailable error on timeout and recovers permits", async () => {
  let stall = true;
  const t = await setup(true, (_request, response) => {
    if (!stall) response.writeHead(200, { "content-type": "application/json" }).end("{}");
  }, { CODEX_DOCUMENT_EVIDENCE_TIMEOUT_MS: "250" });
  for (let i = 0; i < 3; i++) {
    const response = await t.app.inject({ url: prefix + "/documents/" + id, headers: t.headers() });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("document_transport_failed");
  }
  stall = false;
  expect((await t.app.inject({ url: prefix + "/documents/" + id, headers: t.headers() })).statusCode).toBe(200);
});

it("never logs documents, sensitive headers, malformed paths or URL queries", async () => {
  const logs: string[] = [];
  const t = await setup(true, undefined, {}, logs);
  for (const url of [prefix + "/documents/" + id + "?secret=private-patient", prefix + "/unknown/private-patient.pdf", "/gateway/%64ocuments/v1/unknown/private-patient"]) {
    await t.app.inject({ url, headers: { authorization: "Bearer private-credential", "x-document-owner": "private-owner", "x-service-token": "private-token" } });
  }
  const pdf = Buffer.from("%PDF-1.7\nprivate-paper");
  await t.app.inject({ method: "POST", url: prefix + "/documents", headers: { ...t.headers(), "content-type": "application/pdf", "x-content-sha256": createHash("sha256").update(pdf).digest("hex") }, payload: pdf });
  expect(logs.join("\n")).toContain("/gateway/documents/:operation");
  for (const secret of ["private-patient", "private-credential", "private-owner", "private-token", "private-paper", token, t.keys[0]!]) expect(logs.join("\n")).not.toContain(secret);
});

it("accepts the Desktop unified credential and rejects disabled or expired identities", async () => {
  const t = await setup();
  const expiresAt = new Date(Date.now() + 600000);
  const backing = issueAccessCredential({ subjectId: "document-owner-a", scope: "code", label: "Desktop", expiresAt });
  t.identity.insertAccessCredential(backing.record);
  const unified = issueUnifiedClientKey({ subjectId: "document-owner-a", label: "Desktop", expiresAt,
    codexCredentialId: backing.record.id, codexCredentialPrefix: backing.record.prefix,
    codexKeyCiphertext: "unused-in-auth-test", medevidenceKeyCiphertext: "unused-in-auth-test", medevidenceKeyPrefix: "test" });
  t.identity.insertUnifiedClientKey(unified.record);
  const request = { url: prefix + "/documents/" + id, headers: { authorization: "Bearer " + unified.token } };
  expect((await t.app.inject(request)).statusCode).toBe(200);
  const expired = issueAccessCredential({ subjectId: "document-owner-a", scope: "code", label: "expired",
    now: new Date(Date.now() - 100000), expiresAt: new Date(Date.now() - 1000) });
  t.identity.insertAccessCredential(expired.record);
  expect((await t.app.inject({ ...request, headers: { authorization: "Bearer " + expired.token } })).statusCode).toBe(401);
  t.identity.setSubjectState("document-owner-a", "disabled");
  expect((await t.app.inject(request)).statusCode).toBe(401);
  expect(t.calls).toHaveLength(1);
});
