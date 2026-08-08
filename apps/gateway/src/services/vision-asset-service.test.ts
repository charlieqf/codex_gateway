import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  R2VisionAssetService,
  readR2CredentialsFile,
  resolveVisionAssetService
} from "./vision-asset-service.js";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);
const pngSha256 = createHash("sha256").update(png).digest("hex");
const fixedUuid = "11111111-2222-4333-8444-555555555555";
const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("R2 vision asset service", () => {
  it("creates an immutable upload grant and completes a verified image", async () => {
    let now = new Date("2026-08-08T12:00:00.000Z");
    let markerReady = false;
    let imageDeleted = false;
    const requests: Array<{
      method: string;
      path: string;
      authorization: string | null;
    }> = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      const method = init?.method ?? "GET";
      const headers = new Headers(init?.headers);
      requests.push({
        method,
        path: url.pathname,
        authorization: headers.get("authorization")
      });
      const marker = url.pathname.endsWith(".ready");
      if (method === "HEAD" && marker) {
        return markerReady
          ? headResponse(120, "application/json")
          : new Response(null, { status: 404 });
      }
      if (method === "HEAD") {
        return imageDeleted
          ? new Response(null, { status: 404 })
          : headResponse(png.length, "image/png");
      }
      if (method === "GET") {
        return imageDeleted
          ? new Response(null, { status: 404 })
          : new Response(png, {
              status: 200,
              headers: {
                "content-length": String(png.length),
                "content-type": "image/png"
              }
            });
      }
      if (method === "PUT" && marker) {
        expect(headers.get("if-none-match")).toBe("*");
        expect(headers.get("content-type")).toBe("application/json");
        markerReady = true;
        return new Response(null, { status: 200 });
      }
      if (method === "DELETE") {
        if (marker) {
          markerReady = false;
        } else {
          imageDeleted = true;
        }
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 500 });
    }) as unknown as typeof fetch;
    const service = createService({
      now: () => now,
      fetchImpl
    });

    const upload = service.createAsset("subject-private", {
      contentType: "image/png",
      sizeBytes: png.length,
      sha256: pngSha256
    });
    const uploadUrl = new URL(upload.uploadUrl);
    expect(upload.uploadHeaders).toEqual({
      "Content-Type": "image/png",
      "If-None-Match": "*"
    });
    expect(uploadUrl.searchParams.get("X-Amz-Expires")).toBe("600");
    expect(uploadUrl.searchParams.get("X-Amz-SignedHeaders")).toBe(
      "content-type;host;if-none-match"
    );
    expect(upload.assetId).not.toContain("subject-private");
    const encodedPayload = upload.assetId.split(".")[1]!;
    expect(Buffer.from(encodedPayload, "base64url").toString("utf8")).not.toContain(
      "subject-private"
    );

    await expect(
      service.createReadUrl("subject-private", upload.assetId)
    ).rejects.toMatchObject({ code: "vision_asset_not_found", httpStatus: 404 });

    const completed = await service.completeAsset("subject-private", upload.assetId);
    const imageUrl = new URL(completed.imageUrl);
    expect(completed).toMatchObject({
      assetId: upload.assetId,
      contentType: "image/png",
      sizeBytes: png.length,
      sha256: pngSha256
    });
    expect(imageUrl.searchParams.get("X-Amz-Expires")).toBe("1800");
    expect(imageUrl.searchParams.get("X-Amz-SignedHeaders")).toBe("host");
    expect(requests.some((request) => request.method === "PUT" && request.path.endsWith(".ready"))).toBe(true);
    expect(
      requests
        .filter((request) => request.authorization)
        .every(
          (request) =>
            request.authorization!.includes("test-access-key-id") &&
            !request.authorization!.includes("test-secret-access-key")
        )
    ).toBe(true);

    now = new Date("2026-08-08T12:10:00.000Z");
    const refreshed = await service.createReadUrl("subject-private", upload.assetId);
    expect(refreshed.imageUrl).not.toBe(completed.imageUrl);
    await expect(
      service.createReadUrl("different-subject", upload.assetId)
    ).rejects.toMatchObject({ code: "vision_asset_not_found", httpStatus: 404 });

    now = new Date("2026-08-09T12:00:01.000Z");
    await expect(
      service.createReadUrl("subject-private", upload.assetId)
    ).rejects.toMatchObject({ code: "vision_asset_expired", httpStatus: 410 });
    await service.deleteAsset("subject-private", upload.assetId);
    expect(imageDeleted).toBe(true);
    expect(markerReady).toBe(false);
  });

  it("deletes an upload that fails digest validation", async () => {
    const wrongImage = Buffer.concat([png.subarray(0, -1), Buffer.from([0])]);
    const deleted: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      const method = init?.method ?? "GET";
      if (method === "HEAD" && url.pathname.endsWith(".ready")) {
        return new Response(null, { status: 404 });
      }
      if (method === "HEAD") {
        return headResponse(wrongImage.length, "image/png");
      }
      if (method === "GET") {
        return new Response(wrongImage, { status: 200 });
      }
      if (method === "DELETE") {
        deleted.push(url.pathname);
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 500 });
    }) as unknown as typeof fetch;
    const service = createService({ fetchImpl });
    const upload = service.createAsset("subject-private", {
      contentType: "image/png",
      sizeBytes: wrongImage.length,
      sha256: pngSha256
    });

    await expect(
      service.completeAsset("subject-private", upload.assetId)
    ).rejects.toMatchObject({ code: "vision_asset_invalid", httpStatus: 422 });
    expect(deleted).toHaveLength(2);
    expect(deleted.some((value) => value.endsWith(".ready"))).toBe(true);
    expect(deleted.some((value) => value.endsWith(".png"))).toBe(true);
  });

  it("fails closed for tampered tokens and unavailable R2 responses", async () => {
    const service = createService({
      fetchImpl: vi.fn(async () => new Response(null, { status: 503 })) as unknown as typeof fetch
    });
    const upload = service.createAsset("subject-private", {
      contentType: "image/png",
      sizeBytes: png.length,
      sha256: pngSha256
    });
    const tampered = `${upload.assetId.slice(0, -1)}${upload.assetId.endsWith("A") ? "B" : "A"}`;
    await expect(
      service.createReadUrl("subject-private", tampered)
    ).rejects.toMatchObject({ code: "vision_asset_not_found", httpStatus: 404 });
    await expect(
      service.completeAsset("subject-private", upload.assetId)
    ).rejects.toMatchObject({ code: "service_unavailable", httpStatus: 503 });
  });
});

describe("R2 vision credential resolution", () => {
  it("reads exactly two credentials from a restricted file", () => {
    const filename = createCredentialFile(
      "R2_ACCESS_KEY_ID=test-access-key-id\nR2_SECRET_ACCESS_KEY=test-secret-access-key\n"
    );
    expect(readR2CredentialsFile(filename)).toEqual({
      accessKeyId: "test-access-key-id",
      secretAccessKey: "test-secret-access-key"
    });
    expect(
      resolveVisionAssetService({
        MEDCODE_VISION_R2_ENABLED: "1",
        MEDCODE_VISION_R2_ENDPOINT: "https://account.example.com",
        MEDCODE_VISION_R2_BUCKET: "vision-test",
        MEDCODE_VISION_R2_CREDENTIALS_FILE: filename
      })
    ).toBeInstanceOf(R2VisionAssetService);
  });

  it("rejects missing, duplicate, extra and broadly-readable credentials", () => {
    const missing = createCredentialFile("R2_ACCESS_KEY_ID=test-access-key-id\n");
    expect(() => readR2CredentialsFile(missing)).toThrow("is invalid");

    const duplicate = createCredentialFile(
      "R2_ACCESS_KEY_ID=test-access-key-id\nR2_ACCESS_KEY_ID=duplicate-access-key\nR2_SECRET_ACCESS_KEY=test-secret-access-key\n"
    );
    expect(() => readR2CredentialsFile(duplicate)).toThrow("is invalid");

    const extra = createCredentialFile(
      "R2_ACCESS_KEY_ID=test-access-key-id\nR2_SECRET_ACCESS_KEY=test-secret-access-key\nUNEXPECTED=value-value\n"
    );
    expect(() => readR2CredentialsFile(extra)).toThrow("is invalid");

    if (process.platform !== "win32") {
      const broad = createCredentialFile(
        "R2_ACCESS_KEY_ID=test-access-key-id\nR2_SECRET_ACCESS_KEY=test-secret-access-key\n"
      );
      chmodSync(broad, 0o644);
      expect(() => readR2CredentialsFile(broad)).toThrow(
        "permissions are too broad"
      );
    }
  });

  it("requires complete configuration only when explicitly enabled", () => {
    expect(resolveVisionAssetService({})).toBeNull();
    expect(resolveVisionAssetService({ MEDCODE_VISION_R2_ENABLED: "0" })).toBeNull();
    expect(() =>
      resolveVisionAssetService({ MEDCODE_VISION_R2_ENABLED: "1" })
    ).toThrow("MEDCODE_VISION_R2_ENDPOINT is required");
  });
});

function createService(overrides: {
  now?: () => Date;
  fetchImpl?: typeof fetch;
} = {}): R2VisionAssetService {
  return new R2VisionAssetService({
    endpoint: "https://account.example.com",
    bucket: "vision-test",
    accessKeyId: "test-access-key-id",
    secretAccessKey: "test-secret-access-key",
    now: overrides.now ?? (() => new Date("2026-08-08T12:00:00.000Z")),
    randomUUID: () => fixedUuid,
    fetchImpl: overrides.fetchImpl ?? fetch
  });
}

function headResponse(sizeBytes: number, contentType: string): Response {
  return new Response(null, {
    status: 200,
    headers: {
      "content-length": String(sizeBytes),
      "content-type": contentType
    }
  });
}

function createCredentialFile(value: string): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "gateway-r2-vision-secret-"));
  temporaryDirectories.push(directory);
  const filename = path.join(directory, "credentials");
  writeFileSync(filename, value, { encoding: "utf8", mode: 0o600 });
  chmodSync(filename, 0o600);
  return filename;
}
