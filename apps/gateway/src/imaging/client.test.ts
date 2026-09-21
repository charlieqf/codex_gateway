import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { rootCertificates } from "node:tls";
import { afterEach, describe, expect, it } from "vitest";
import { HttpsStarClient } from "./client.js";
import { chunkBytes, sha256 } from "./contract.js";

const fixtures = new URL("../../../../tests/fixtures/imaging/", import.meta.url);
const cert = readFileSync(new URL("test-only-cert.pem", fixtures));
const key = readFileSync(new URL("test-only-key.pem", fixtures));
const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
const owner = "a".repeat(64), token = "test-only-private-service-credential";
async function server(handler: (request: IncomingMessage, response: ServerResponse) => void, host = "127.0.0.1") {
  const srv = createServer({ cert, key }, handler);
  await new Promise<void>(resolve => srv.listen(0, host, resolve));
  cleanup.push(() => new Promise<void>(resolve => { srv.close(() => resolve()); srv.closeAllConnections(); }));
  return `https://${host}:${(srv.address() as AddressInfo).port}/internal/imaging/v1`;
}
function client(baseUrl: string, options: Partial<ConstructorParameters<typeof HttpsStarClient>[0]> = {}) {
  const c = new HttpsStarClient({ baseUrl, token, ca: cert, ...options });
  cleanup.push(() => c.close()); return c;
}
describe("private imaging HTTPS transport", () => {
  it("verifies the supplied CA and certificate hostname; never accepts HTTP or redirects", async () => {
    let calls = 0;
    const url = await server((_req, res) => { calls++; res.end("{}"); });
    expect((await client(url).json(owner, "GET", "/capabilities")).status).toBe(200);
    await expect(client(url, { ca: rootCertificates[0]! }).json(owner, "GET", "/capabilities")).rejects.toMatchObject({ status: 503 });
    expect(calls).toBe(1);
    const wrongHost = await server((_req, res) => res.end("{}"), "127.0.0.2");
    await expect(client(wrongHost).json(owner, "GET", "/capabilities")).rejects.toMatchObject({ status: 503 });
    expect(() => client(url.replace("https:", "http:"))).toThrow();
    const redirect = await server((_req, res) => { res.writeHead(302, { location: url }); res.end("{}"); });
    await expect(client(redirect).json(owner, "GET", "/capabilities")).rejects.toMatchObject({ status: 503 });
    expect(calls).toBe(1);
  });
  it("forwards bytes before upload completion, applies backpressure and sends only private authentication", async () => {
    let first!: () => void;
    const firstReceived = new Promise<void>(resolve => { first = resolve; });
    let observedHeaders: IncomingMessage["headers"] = {};
    let total = 0, largest = 0;
    const hash = createHash("sha256");
    const url = await server((req, res) => {
      observedHeaders = req.headers;
      req.on("data", (data: Buffer) => { first(); hash.update(data); total += data.length; largest = Math.max(largest, data.length); });
      req.on("end", () => res.end(JSON.stringify({ index: 0, size: total, sha256: hash.digest("hex") })));
    });
    const block = Buffer.alloc(64 * 1024, 71);
    const expected = createHash("sha256"); for (let i = 0; i < 128; i++) expected.update(block);
    const digest = expected.digest("hex");
    const stream = Readable.from((async function* () {
      yield block;
      // A buffering implementation would deadlock here: the server must receive the first block before production continues.
      await firstReceived;
      for (let i = 1; i < 128; i++) yield block;
    })());
    const result = await client(url).json(owner, "PUT", "/studies/study_0123456789abcdef0123456789abcdef/upload/parts/0", { stream, length: chunkBytes, digest });
    expect(result.data).toEqual({ index: 0, size: chunkBytes, sha256: digest });
    expect(largest).toBeLessThanOrEqual(64 * 1024);
    expect(observedHeaders.authorization).toBe(`Bearer ${token}`);
    expect(observedHeaders["x-imaging-owner"]).toBe(owner);
    expect(observedHeaders["content-length"]).toBe(String(chunkBytes));
    expect(observedHeaders["transfer-encoding"]).toBeUndefined();
    expect(observedHeaders.cookie).toBeUndefined();
  });
  it("sanitizes upstream errors and bounds JSON response bytes and wall time", async () => {
    const url = await server((req, res) => {
      if (req.url?.endsWith("/oversized")) { res.writeHead(200, { "content-length": 2 * 1024 * 1024 }); res.end(); return; }
      if (req.url?.endsWith("/timeout")) return;
      res.writeHead(409); res.end(JSON.stringify({ error: { code: "hash_mismatch", message: "/private/patient-name KEY=secret", retryable: false } }));
    });
    const c = client(url, { controlTimeoutMs: 100 });
    await expect(c.json(owner, "POST", "/bad", { body: {} })).rejects.toMatchObject({ status: 409, code: "hash_mismatch", message: "Content SHA-256 mismatch." });
    await expect(c.json(owner, "GET", "/oversized")).rejects.toMatchObject({ status: 503, code: "upstream_protocol_error" });
    await expect(c.json(owner, "GET", "/timeout")).rejects.toMatchObject({ status: 503 });
  });
  it("checks artifact length/hash and terminates corrupted or timed-out streams", async () => {
    const bytes = Buffer.from("test artifact"), artifact = { path: "bundle.json", size: bytes.length, sha256: sha256(bytes) };
    const url = await server((req, res) => {
      res.writeHead(200, { "content-length": bytes.length, "x-content-sha256": artifact.sha256 });
      if (req.url?.endsWith("/timeout")) { res.write(bytes.subarray(0, 1)); return; }
      res.end(req.url?.endsWith("/corrupt") ? Buffer.alloc(bytes.length, 0) : bytes);
    });
    const c = client(url, { transferTimeoutMs: 200 });
    async function collect(path: string) { const stream = await c.artifact(owner, path, artifact); const out: Buffer[] = []; for await (const data of stream) out.push(data); return Buffer.concat(out); }
    expect(await collect("/good")).toEqual(bytes);
    await expect(collect("/corrupt")).rejects.toBeTruthy();
    await expect(collect("/timeout")).rejects.toBeTruthy();
  });
});
