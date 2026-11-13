import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CosVisionStorage,
  parseCosVisionConfig,
} from "./cos-vision-storage.js";
import {
  CosVisionAssetService,
  R2VisionAssetService,
  readCosVisionCredentialsFile,
  resolveVisionAssetService,
} from "./vision-asset-service.js";
import { resolveVisionFingerprinter } from "./vision-fingerprints.js";

const config = {
  bucket: "synthetic-1234567890",
  region: "ap-shanghai",
  secretId: "syntheticCosAccessId",
  secretKey: "syntheticCosSecretKey",
};
const bytes = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const sha = createHash("sha256").update(bytes).digest("hex");
const input = {
  contentType: "image/png" as const,
  sizeBytes: bytes.length,
  sha256: sha,
};
const time = new Date("2026-11-12T00:00:00Z");
const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  directories
    .splice(0)
    .forEach((p) => rmSync(p, { recursive: true, force: true }));
});

function fixture(
  options: { wrong?: boolean; encrypted?: boolean; markerRace?: boolean } = {},
) {
  const markers = new Set<string>();
  const deleted = new Set<string>();
  const calls: { method: string; url: string; headers: Headers }[] = [];
  const encryption: Record<string, string> =
    options.encrypted === false
      ? {}
      : { "x-cos-server-side-encryption": "AES256" };
  const fetchImpl = vi.fn(
    async (resource: string | URL | Request, init?: RequestInit) => {
      const url = String(resource);
      const method = init?.method ?? "GET";
      const headers = new Headers(init?.headers);
      calls.push({ method, url, headers });
      const isMarker = new URL(url).pathname.endsWith(".ready");
      if (method === "DELETE") {
        if (isMarker) markers.delete(url);
        else deleted.add(url);
        return new Response(null, { status: 204 });
      }
      if (method === "HEAD")
        return new Response(null, {
          status:
            deleted.has(url) || (isMarker && !markers.has(url)) ? 404 : 200,
          headers: {
            "content-length": String(bytes.length),
            "content-type": "image/png",
            ...encryption,
          },
        });
      if (method === "GET")
        return new Response(options.wrong ? Buffer.alloc(bytes.length) : bytes);
      if (method === "PUT" && isMarker) {
        markers.add(url);
        return new Response(null, {
          status: options.markerRace ? 409 : 200,
          headers: encryption,
        });
      }
      throw new Error("Unexpected fixture request");
    },
  );
  return { fetchImpl, calls, deleted: () => deleted.size > 0 };
}

function secretFile(contents: string) {
  const folder = mkdtempSync(path.join(os.tmpdir(), "gateway-cos-test-"));
  directories.push(folder);
  const filename = path.join(folder, "secret.json");
  writeFileSync(filename, contents, { mode: 0o600 });
  chmodSync(filename, 0o600);
  return filename;
}

describe("COS vision assets", () => {
  it("signs immutable encrypted uploads and verifies bytes before issuing renewable GET URLs", async () => {
    const f = fixture();
    let now = time;
    const service = new CosVisionAssetService({
      config,
      now: () => now,
      fetchImpl: f.fetchImpl,
    });
    const upload = service.createAsset("owner", input);
    const url = new URL(upload.uploadUrl);
    expect(url.host).toBe("synthetic-1234567890.cos.ap-shanghai.myqcloud.com");
    expect(url.pathname).toMatch(
      /^\/vision-temp\/2026\/11\/12\/[a-f0-9]{32}\.png$/u,
    );
    expect(upload.assetId).toMatch(/^vc1\./u);
    expect(upload.uploadHeaders).toMatchObject({
      "x-cos-forbid-overwrite": "true",
      "x-cos-server-side-encryption": "AES256",
      "x-cos-meta-sha256": sha,
    });
    expect(url.searchParams.get("q-header-list")).toContain(
      "x-cos-forbid-overwrite",
    );
    expect(upload.uploadUrl).not.toContain(config.secretKey);
    await expect(
      service.createReadUrl("owner", upload.assetId),
    ).rejects.toMatchObject({ code: "vision_asset_not_found" });
    const read = await service.completeAsset("owner", upload.assetId);
    expect(new URL(read.imageUrl).searchParams.get("q-header-list")).toBe(
      "host",
    );
    expect(f.calls.filter((c) => c.method === "GET")).toHaveLength(1);
    const ready = f.calls.find((c) => c.method === "PUT")!;
    expect(ready.headers.get("content-md5")).toBeTruthy();
    expect(ready.headers.get("if-none-match")).toBeNull();
    expect(ready.headers.get("authorization")).toContain(
      "q-sign-algorithm=sha1",
    );
    now = new Date(time.getTime() + 600_000);
    const renewed = await service.createReadUrl("owner", upload.assetId);
    expect(renewed.imageUrl).not.toBe(read.imageUrl);
    expect(f.calls.filter((c) => c.method === "GET")).toHaveLength(1);
    await expect(
      service.createReadUrl("other-owner", upload.assetId),
    ).rejects.toMatchObject({ code: "vision_asset_not_found" });
    now = new Date(time.getTime() + 86_401_000);
    await expect(
      service.createReadUrl("owner", upload.assetId),
    ).rejects.toMatchObject({ code: "vision_asset_expired" });
    await service.deleteAsset("owner", upload.assetId);
    expect(f.deleted()).toBe(true);
  });

  it.each([{ wrong: true }, { encrypted: false }])(
    "rejects and deletes invalid uploads: %j",
    async (options) => {
      const f = fixture(options);
      const service = new CosVisionAssetService({
        config,
        fetchImpl: f.fetchImpl,
      });
      const upload = service.createAsset("owner", input);
      await expect(
        service.completeAsset("owner", upload.assetId),
      ).rejects.toMatchObject({ code: "vision_asset_invalid" });
      expect(f.deleted()).toBe(true);
      expect(f.calls.some((c) => c.method === "PUT")).toBe(false);
    },
  );

  it("accepts a concurrent ready-marker conflict only after checking the existing encrypted marker", async () => {
    const f = fixture({ markerRace: true });
    const service = new CosVisionAssetService({
      config,
      fetchImpl: f.fetchImpl,
    });
    const upload = service.createAsset("owner", input);
    await expect(
      service.completeAsset("owner", upload.assetId),
    ).resolves.toMatchObject({ assetId: upload.assetId });
    expect(
      f.calls.filter((c) => c.method === "HEAD" && c.url.endsWith(".ready")),
    ).toHaveLength(2);
  });

  it("bounds GET URL lifetime by the remaining asset lifetime and binds IDs to the bucket", async () => {
    const f = fixture();
    let now = time;
    const service = new CosVisionAssetService({
      config,
      fetchImpl: f.fetchImpl,
      now: () => now,
    });
    const upload = service.createAsset("owner", input);
    await service.completeAsset("owner", upload.assetId);
    now = new Date(time.getTime() + 86_390_000);
    const read = await service.createReadUrl("owner", upload.assetId);
    expect(read.readUrlExpiresAt).toEqual(upload.assetExpiresAt);
    const range = new URL(read.imageUrl).searchParams
      .get("q-sign-time")!
      .split(";")
      .map(Number);
    expect(range[1]).toBe(upload.assetExpiresAt.getTime() / 1000);
    const other = new CosVisionAssetService({
      config: { ...config, bucket: "other-1234567890" },
      fetchImpl: f.fetchImpl,
    });
    const before = f.calls.length;
    await expect(
      other.createReadUrl("owner", upload.assetId),
    ).rejects.toMatchObject({ code: "vision_asset_not_found" });
    expect(f.calls).toHaveLength(before);
  });

  it.each(["disconnect", "deadline"])(
    "cancels a stalled download on %s without marking ready or deleting",
    async (kind) => {
      let entered!: () => void;
      const downloading = new Promise<void>((r) => (entered = r));
      const cancel = vi.fn();
      const methods: string[] = [];
      const parent = new AbortController();
      const service = new CosVisionAssetService({
        config,
        requestTimeoutMs: 1000,
        fetchImpl: async (url, init) => {
          const method = init?.method ?? "GET";
          methods.push(method);
          if (method === "HEAD")
            return new Response(null, {
              status: String(url).endsWith(".ready") ? 404 : 200,
              headers: {
                "content-length": String(bytes.length),
                "content-type": "image/png",
                "x-cos-server-side-encryption": "AES256",
              },
            });
          if (method === "GET") {
            entered();
            return new Response(new ReadableStream({ cancel }));
          }
          throw new Error("Unexpected mutation");
        },
      });
      const upload = service.createAsset("owner", input);
      const result = expect(
        service.completeAsset("owner", upload.assetId, parent.signal),
      ).rejects.toBeDefined();
      await downloading;
      if (kind === "disconnect") parent.abort();
      await result;
      expect(cancel).toHaveBeenCalledOnce();
      expect(methods).not.toContain("PUT");
      expect(methods).not.toContain("DELETE");
    },
  );
});

describe("COS configuration and R2 migration", () => {
  it("routes uploads by explicit capability and keeps assets isolated during rollback", async () => {
    const f = fixture();
    const cosFile = secretFile(JSON.stringify(config));
    const r2File = secretFile(
      "R2_ACCESS_KEY_ID=synthetic-r2-access\nR2_SECRET_ACCESS_KEY=synthetic-r2-secret\n",
    );
    const env = {
      MEDCODE_VISION_STORAGE_PROVIDER: "cos",
      MEDCODE_VISION_COS_CREDENTIALS_FILE: cosFile,
      MEDCODE_VISION_R2_ENABLED: "1",
      MEDCODE_VISION_R2_ENDPOINT: "https://synthetic.r2.example",
      MEDCODE_VISION_R2_BUCKET: "legacy",
      MEDCODE_VISION_R2_CREDENTIALS_FILE: r2File,
    };
    const old = new R2VisionAssetService({
      endpoint: env.MEDCODE_VISION_R2_ENDPOINT,
      bucket: "legacy",
      accessKeyId: "synthetic-r2-access",
      secretAccessKey: "synthetic-r2-secret",
      fetchImpl: f.fetchImpl,
      now: () => time,
    });
    const asset = old.createAsset("owner", input);
    await old.completeAsset("owner", asset.assetId);
    const current = resolveVisionAssetService(env, {
      now: () => time,
      fetchImpl: f.fetchImpl,
    })!;
    expect(current.createAsset("owner", input).assetId).toMatch(/^va1\./u);
    expect(
      current.createAsset("owner", input, { supportsCos: false }).assetId,
    ).toMatch(/^va1\./u);
    expect(
      current.createAsset("owner", input, { supportsCos: true }).assetId,
    ).toMatch(/^vc1\./u);
    expect(
      (await current.createReadUrl("owner", asset.assetId)).imageUrl,
    ).toContain("synthetic.r2.example");
    const before = f.calls.length;
    for (const id of [
      asset.assetId.replace("va1.", "vc1."),
      "unknown.id",
      asset.assetId + "x",
    ]) {
      await expect(current.createReadUrl("owner", id)).rejects.toMatchObject({
        code: "vision_asset_not_found",
      });
    }
    expect(f.calls).toHaveLength(before);
    const cosAsset = current.createAsset("owner", input, { supportsCos: true });
    await current.completeAsset("owner", cosAsset.assetId);
    const rollback = resolveVisionAssetService(
      { ...env, MEDCODE_VISION_STORAGE_PROVIDER: "r2" },
      { now: () => time, fetchImpl: f.fetchImpl },
    )!;
    expect(
      rollback.createAsset("owner", input, { supportsCos: true }).assetId,
    ).toMatch(/^va1\./u);
    expect(
      (await rollback.createReadUrl("owner", cosAsset.assetId)).imageUrl,
    ).toContain("myqcloud.com");
    await rollback.deleteAsset("owner", cosAsset.assetId);
    await expect(
      rollback.createReadUrl("owner", cosAsset.assetId),
    ).rejects.toMatchObject({ code: "vision_asset_not_found" });
    expect(
      (await rollback.createReadUrl("owner", asset.assetId)).imageUrl,
    ).toContain("synthetic.r2.example");
    const oldFp = resolveVisionFingerprinter({
      ...env,
      MEDCODE_VISION_STORAGE_PROVIDER: "r2",
    });
    const newFp = resolveVisionFingerprinter(env);
    const observation = {
      scanning: true,
      scanned: true,
      lastUserContainer: 0,
      entries: [{ url: "data:image/png;base64,aGVsbG8=", container: 0 }],
    };
    const context = {
      subjectId: "owner",
      sessionId: "session",
      requestId: "request",
    };
    expect(newFp.snapshot(observation, context).keyId).toBe(
      oldFp.snapshot(observation, context).keyId,
    );
  });

  it("requires valid configuration and a restricted secret file; COS-only startup has durable fingerprints", () => {
    const filename = secretFile(JSON.stringify(config));
    expect(readCosVisionCredentialsFile(filename)).toEqual(config);
    expect(() =>
      resolveVisionAssetService({ MEDCODE_VISION_STORAGE_PROVIDER: "typo" }),
    ).toThrow("must be r2 or cos");
    expect(() =>
      resolveVisionAssetService({ MEDCODE_VISION_STORAGE_PROVIDER: "cos" }),
    ).toThrow("is required");
    const env = {
      MEDCODE_VISION_STORAGE_PROVIDER: "cos",
      MEDCODE_VISION_COS_CREDENTIALS_FILE: ` ${filename} `,
    };
    expect(
      resolveVisionAssetService(env)?.createAsset("owner", input, {
        supportsCos: true,
      }).assetId,
    ).toMatch(/^vc1\./u);
    expect(() =>
      resolveVisionAssetService(env)?.createAsset("owner", input, {
        supportsCos: false,
      }),
    ).toThrow("Please update the client");
    expect(() =>
      resolveVisionAssetService(env)?.createAsset("owner", input),
    ).toThrow("Please update the client");
    const observation = {
      scanning: true,
      scanned: true,
      lastUserContainer: 0,
      entries: [],
    };
    const context = { subjectId: "owner", requestId: "request" };
    expect(
      resolveVisionFingerprinter(env).snapshot(observation, context).keySource,
    ).toBe("cos-derived");
    if (process.platform !== "win32") {
      chmodSync(filename, 0o644);
      expect(() => readCosVisionCredentialsFile(filename)).toThrow(
        "permissions are too broad",
      );
    }
  });

  it.each([
    "not json",
    JSON.stringify({ ...config, region: "ap-shanghai.evil" }),
    JSON.stringify({ ...config, secretKey: "bad" }),
    JSON.stringify({ ...config, endpoint: "https://evil.example" }),
  ])("rejects malformed config without echoing it", (value) => {
    expect(() => parseCosVisionConfig(value)).toThrow(
      "MEDCODE_VISION_COS_CREDENTIALS_FILE is invalid.",
    );
  });

  it("matches an independently calculated COS signature for escaped object names", () => {
    // Fixed vector calculated with Python hmac/hashlib using Tencent's documented canonical string:
    // https://cloud.tencent.com/document/product/436/7778 (decoded UriPathname, hex SignKey).
    const store = new CosVisionStorage(config);
    const url = new URL(
      store.signedUrl("PUT", "vision-temp/test (\u56fe).png", 300, time, {
        "Content-Type": "image/png",
        "x-cos-meta-note": "note/ one",
      }),
    );
    expect(url.pathname).toBe("/vision-temp/test%20%28%E5%9B%BE%29.png");
    expect(url.searchParams.get("q-sign-time")).toBe("1794441570;1794441900");
    expect(url.searchParams.get("q-signature")).toBe(
      "4da5f6cc668a6e683c7e6422f283621fbc9665e7",
    );
  });

  it("keeps validated signing configuration stable when the caller mutates its input", () => {
    const mutable = { ...config };
    const store = new CosVisionStorage(mutable);
    const before = store.signedUrl(
      "GET",
      "vision-temp/test.png",
      300,
      time,
      {},
    );
    mutable.secretKey = "differentSecretKey";
    mutable.bucket = "different-1234567890";
    expect(store.signedUrl("GET", "vision-temp/test.png", 300, time, {})).toBe(
      before,
    );
  });

  it("binds signatures to the verb and signed upload headers", () => {
    const store = new CosVisionStorage(config);
    const key = "vision-temp/test.png";
    const get = store.signedUrl("GET", key, 300, time, {});
    const put = store.signedUrl(
      "PUT",
      key,
      300,
      time,
      store.uploadHeaders("image/png", sha),
    );
    expect(new URL(get).searchParams.get("q-signature")).not.toBe(
      new URL(put).searchParams.get("q-signature"),
    );
    expect(() => store.signedUrl("GET", key, 0, time, {})).toThrow("lifetime");
  });
});
