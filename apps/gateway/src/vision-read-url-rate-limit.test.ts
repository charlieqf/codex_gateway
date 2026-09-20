import http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayError, issueAccessCredential, type ProviderAdapter, type RateLimitPolicy } from "@codex-gateway/core";
import { createSqliteStore } from "@codex-gateway/store-sqlite";
import { buildGateway } from "./index.js";
import { goldencodePoolConfig } from "./test-support.js";
import { InMemoryRequestRateLimiter } from "./services/rate-limiter.js";
import { R2VisionAssetService, type VisionAssetReadGrant, type VisionAssetService } from "./services/vision-asset-service.js";
import type { VisionReadUrlPolicy } from "./services/vision-read-url-policy.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

class Barrier {
  private completion = deferred();
  private waiters: Array<{ count: number; resolve(): void }> = [];
  count = 0;
  async enter() {
    this.count++;
    for (const waiter of this.waiters) if (this.count >= waiter.count) waiter.resolve();
    await this.completion.promise;
  }
  entered(count: number) {
    if (this.count >= count) return Promise.resolve();
    return new Promise<void>((resolve) => this.waiters.push({ count, resolve }));
  }
  open() { this.completion.resolve(); }
}

const fixtures: Array<{ app: ReturnType<typeof buildGateway>; images: Barrier; ordinary: Barrier }> = [];
const ordinaryPolicy = { requestsPerMinute: 20, requestsPerDay: 200, concurrentRequests: 4 };
const imagePolicy = { requestsPerMinute: 320, requestsPerDay: 3200, concurrentRequests: 20 };
const refreshPath = "/gateway/vision/assets/synthetic-asset/read-url";
const grant: VisionAssetReadGrant = {
  assetId: "synthetic-asset", contentType: "image/png", sizeBytes: 68, sha256: "a".repeat(64),
  imageUrl: "https://example.invalid/read", readUrlExpiresAt: new Date("2026-09-20T02:30:00Z"),
  assetExpiresAt: new Date("2026-09-21T02:00:00Z")
};

beforeEach(() => {
  const model = goldencodePoolConfig();
  model.pool.requireAllMembers = false;
  vi.stubEnv("MEDCODE_PUBLIC_MODELS_JSON", JSON.stringify({ goldencode: { ...model,
    vision: { runtime: "xai", upstreamModel: "grok-4.5", contextWindow: 200000, maxOutputTokens: 128000, enabled: true }
  } }));
  vi.stubEnv("MEDCODE_TENCENT_TOKENHUB_API_KEY", "synthetic-provider-key");
  vi.stubEnv("MEDCODE_VISION_XAI_API_KEY", "synthetic-vision-key");
  vi.stubEnv("MEDCODE_TOKENSWITCH_API_KEY", undefined);
});

afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    f.images.open(); f.ordinary.open();
    await f.app.close();
  }
  vi.restoreAllMocks(); vi.unstubAllEnvs();
});

function fixture(rate: RateLimitPolicy = ordinaryPolicy, vision: VisionReadUrlPolicy = imagePolicy) {
  let now = new Date("2026-09-20T02:00:00Z");
  const store = createSqliteStore({ path: ":memory:" });
  const images = new Barrier(), ordinary = new Barrier();
  const imageLimiter = new InMemoryRequestRateLimiter({ now: () => now });
  const modelLimiter = new InMemoryRequestRateLimiter({ now: () => now });
  for (const id of ["alice", "bob"]) store.upsertSubject({ id, label: id, state: "active", createdAt: now });
  const issue = (subjectId: string) => {
    const issued = issueAccessCredential({ subjectId, scope: "code", label: "synthetic", rate, now,
      expiresAt: new Date("2030-01-01T00:00:00Z") });
    store.insertAccessCredential(issued.record);
    return issued;
  };
  const first = issue("alice"), second = issue("alice"), other = issue("bob");
  const provider: ProviderAdapter = {
    kind: "fake", health: async () => ({ state: "healthy", checkedAt: now }),
    async *message() { yield { type: "completed", providerSessionRef: "synthetic" }; }
  };
  const service: VisionAssetService = {
    createAsset: vi.fn(() => { throw new Error("Unexpected asset creation"); }),
    completeAsset: vi.fn(async () => grant), deleteAsset: vi.fn(async () => undefined),
    createReadUrl: vi.fn(async (_owner, _asset, signal) => {
      await images.enter();
      signal?.throwIfAborted();
      return grant;
    })
  };
  const app = buildGateway({ authMode: "credential", sessionStore: store, provider,
    visionAssetService: service, rateLimiter: modelLimiter, visionReadUrlRateLimiter: imageLimiter,
    visionReadUrlRatePolicy: vision, now: () => now, logger: false });
  app.post("/test/ordinary", async () => { await ordinary.enter(); return { ok: true }; });
  const headers = (key = first) => ({ authorization: `Bearer ${key.token}` });
  const read = (key = first, assetId = "synthetic-asset") => app.inject({ method: "POST", url: `/gateway/vision/assets/${assetId}/read-url`, headers: headers(key), payload: {} });
  const status = () => app.inject({ method: "GET", url: "/gateway/status", headers: headers() });
  const f = { app, store, images, ordinary, service, first, second, other, imageLimiter, modelLimiter, headers, read, status,
    setTime: (value: string) => { now = new Date(value); } };
  fixtures.push(f);
  return f;
}

function snapshot(limiter: InMemoryRequestRateLimiter, key: string) {
  return limiter.reset({ key, windows: [] }).before;
}

describe("read URL independent budget through the real Gateway", () => {
  it("admits the reported batch of eight without spending ordinary quota", async () => {
    const f = fixture();
    const pending = Array.from({ length: 8 }, () => f.read().then((r) => r));
    await f.images.entered(8);
    expect(snapshot(f.imageLimiter, "alice")).toMatchObject({ active: 8, minuteCount: 8, dayCount: 8 });
    expect(snapshot(f.modelLimiter, f.first.record.id)).toBeNull();
    f.images.open();
    expect((await Promise.all(pending)).map((r) => r.statusCode)).toEqual(Array(8).fill(200));
    expect((await f.status()).statusCode).toBe(200);
    expect(snapshot(f.modelLimiter, f.first.record.id)).toMatchObject({ active: 0, minuteCount: 1, dayCount: 1 });
    expect(snapshot(f.imageLimiter, "alice")?.active).toBe(0);
  });

  it("reserves 20 subject slots alongside four ordinary slots, across keys but not subjects", async () => {
    const f = fixture();
    const reads = Array.from({ length: 20 }, (_, i) => f.read(i % 2 ? f.first : f.second).then((r) => r));
    await f.images.entered(20);
    const normals = Array.from({ length: 4 }, () => f.app.inject({ method: "POST", url: "/test/ordinary", headers: f.headers() }).then((r) => r));
    await f.ordinary.entered(4);
    const denied = await f.read(f.second);
    expect(denied.statusCode).toBe(429);
    expect(denied.json().error).toMatchObject({ limit_kind: "concurrency", limit: { scope: "subject", maximum: 20, used: 20 } });
    expect(denied.headers["retry-after"]).toBe("1");
    expect(denied.headers["cache-control"]).toBe("no-store");
    for (const [method, url] of [
      ["POST", "/v1/chat/completions"], ["POST", "/v1/images/generations"], ["POST", "/v1/images/edits"],
      ["POST", "/gateway/vision/assets"], ["POST", "/gateway/vision/assets/test/complete"],
      ["DELETE", "/gateway/vision/assets/test"], ["GET", "/gateway/vision/capabilities"]
    ] as const) {
      const response = await f.app.inject({ method, url: `${url}?rateLimitProfile=vision_read_url`,
        headers: { ...f.headers(), "x-rate-limit-profile": "vision_read_url" } });
      expect(response.statusCode, url).toBe(429);
      expect(response.json().error.limit.scope, url).toBe("credential");
    }
    const bob = f.read(f.other).then((r) => r);
    await f.images.entered(21);
    expect(snapshot(f.imageLimiter, "alice")).toMatchObject({ active: 20, minuteCount: 20, dayCount: 20 });
    expect(snapshot(f.imageLimiter, "bob")?.active).toBe(1);
    expect(snapshot(f.modelLimiter, f.first.record.id)).toMatchObject({ active: 4, minuteCount: 4, dayCount: 4 });
    f.images.open(); f.ordinary.open();
    expect((await Promise.all([...reads, ...normals, bob])).every((r) => r.statusCode === 200)).toBe(true);
  });

  it.each(["minute", "day"] as const)("isolates %s exhaustion in both directions and resets at the UTC boundary", async (window) => {
    const policy = { requestsPerMinute: window === "minute" ? 2 : 100, requestsPerDay: window === "day" ? 2 : 100, concurrentRequests: 20 };
    for (const imageFirst of [true, false]) {
      const f = fixture(policy, policy);
      f.setTime("2026-09-20T23:59:59Z"); f.images.open();
      const ordered = imageFirst ? [f.read, f.status] : [f.status, f.read];
      for (const send of ordered) {
        expect((await send()).statusCode).toBe(200);
        expect((await send()).statusCode).toBe(200);
        const denied = await send();
        expect(denied.statusCode).toBe(429);
        expect(denied.json().error.limit_kind).toBe(`request_${window}`);
        expect(denied.headers["retry-after"]).toBe("1");
      }
      expect(snapshot(f.imageLimiter, "alice")).toMatchObject({ active: 0, minuteCount: 2, dayCount: 2 });
      expect(snapshot(f.modelLimiter, f.first.record.id)).toMatchObject({ active: 0, minuteCount: 2, dayCount: 2 });
      f.setTime("2026-09-21T00:00:00Z");
      expect((await f.read()).statusCode).toBe(200);
      expect((await f.status()).statusCode).toBe(200);
      expect(snapshot(f.imageLimiter, "alice")).toMatchObject({ minuteCount: 1, dayCount: 1 });
    }
  });

  it.each([400, 404, 503, 500])("releases capacity after a %s failure but retains accepted request counts", async (status) => {
    const f = fixture(ordinaryPolicy, { ...imagePolicy, concurrentRequests: 1 });
    vi.mocked(f.service.createReadUrl).mockRejectedValue(status === 500 ? new Error("synthetic failure") :
      new GatewayError({ code: "invalid_request", message: "synthetic failure", httpStatus: status }));
    for (let i = 0; i < 2; i++) expect((await f.read()).statusCode).toBe(status === 500 ? 503 : status);
    expect(snapshot(f.imageLimiter, "alice")).toMatchObject({ active: 0, minuteCount: 2, dayCount: 2 });
    expect(snapshot(f.modelLimiter, f.first.record.id)).toBeNull();
  });

  it("rejects invalid authentication and forged methods before starting refresh work", async () => {
    const f = fixture();
    expect((await f.app.inject({ method: "POST", url: refreshPath, headers: { authorization: "Bearer synthetic-invalid" } })).statusCode).toBe(401);
    expect((await f.app.inject({ method: "GET", url: refreshPath, headers: f.headers() })).statusCode).toBe(404);
    f.store.setSubjectState("alice", "disabled");
    expect((await f.read()).statusCode).toBe(401);
    expect(f.service.createReadUrl).not.toHaveBeenCalled();
    expect(snapshot(f.imageLimiter, "alice")).toBeNull();
  });

  it("records the resource profile and route template without the asset token", async () => {
    const f = fixture(); f.images.open();
    const info = vi.spyOn(f.app.log, "info");
    expect((await f.read()).statusCode).toBe(200);
    const event = info.mock.calls.find((call) => (call[0] as Record<string, unknown>)?.rate_limit_profile === "vision_read_url")?.[0];
    expect(event).toMatchObject({ route: "/gateway/vision/assets/:assetId/read-url", status_code: 200, rejected: false, cancelled: false });
    expect(JSON.stringify(event)).not.toContain("synthetic-asset");
  });

  it("holds a disconnected socket's slot until asynchronous refresh work actually settles", async () => {
    const f = fixture(ordinaryPolicy, { ...imagePolicy, concurrentRequests: 1 });
    const cancelled = deferred();
    const settled = deferred();
    const r2 = new R2VisionAssetService({
      endpoint: "https://synthetic.example.invalid", bucket: "synthetic-images",
      accessKeyId: "synthetic-access-key", secretAccessKey: "synthetic-secret-key",
      now: () => new Date("2026-09-20T02:00:00Z"),
      fetchImpl: async (_url, init) => {
        init!.signal!.addEventListener("abort", () => cancelled.resolve(), { once: true });
        await f.images.enter();
        init!.signal!.throwIfAborted();
        return new Response(null, { status: 200, headers: { "content-type": "image/png", "content-length": "68" } });
      }
    });
    const asset = r2.createAsset("alice", { contentType: "image/png", sizeBytes: 68, sha256: "a".repeat(64) });
    vi.mocked(f.service.createReadUrl).mockImplementation((...args) => r2.createReadUrl(...args));
    const originalAcquire = f.imageLimiter.acquire.bind(f.imageLimiter);
    vi.spyOn(f.imageLimiter, "acquire").mockImplementation((input) => {
      const result = originalAcquire(input);
      if (!("release" in result)) return result;
      return { release: () => { result.release(); settled.resolve(); } };
    });
    const address = await f.app.listen({ host: "127.0.0.1", port: 0 });
    const request = http.request(address + `/gateway/vision/assets/${asset.assetId}/read-url`, { method: "POST", headers: f.headers() });
    request.on("error", () => undefined); request.end();
    await f.images.entered(1);
    request.destroy();
    await cancelled.promise;
    expect(snapshot(f.imageLimiter, "alice")?.active).toBe(1);
    expect((await f.read()).statusCode).toBe(429);
    f.images.open();
    await settled.promise;
    expect(snapshot(f.imageLimiter, "alice")).toMatchObject({ active: 0, minuteCount: 1 });
    expect((await f.read(f.first, asset.assetId)).statusCode).toBe(200);
    // The cancelled refresh made one HEAD; the successful retry made two, but is charged once.
    expect(f.images.count).toBe(3);
    expect(snapshot(f.imageLimiter, "alice")).toMatchObject({ active: 0, minuteCount: 2, dayCount: 2 });
    const events = f.store.listRequestEvents({ credentialId: f.first.record.id });
    expect(events.some((event) => event.errorCode === "client_aborted")).toBe(true);
  });
});
