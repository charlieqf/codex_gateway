import Fastify from "fastify";
import { GatewayError } from "@codex-gateway/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayRequestContext } from "./http/context.js";
import type {
  VisionAssetService,
  VisionAssetUploadGrant,
  VisionAssetReadGrant
} from "./services/vision-asset-service.js";
import { registerVisionAssetRoutes } from "./vision-asset-routes.js";

const apps: ReturnType<typeof Fastify>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  vi.restoreAllMocks();
});

describe("vision asset routes", () => {
  it("returns a private direct-upload contract and binds it to the subject", async () => {
    const service = fakeService();
    const app = testApp(service);
    const response = await app.inject({
      method: "POST",
      url: "/gateway/vision/assets",
      payload: {
        content_type: "image/png",
        size_bytes: 68,
        sha256: "A".repeat(64)
      }
    });

    expect(response.statusCode).toBe(201);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({
      asset_id: "va1.test.signature",
      state: "pending_upload",
      content_type: "image/png",
      size_bytes: 68,
      sha256: "a".repeat(64),
      upload: {
        method: "PUT",
        url: "https://account.example.com/upload-signed",
        headers: {
          "Content-Type": "image/png",
          "If-None-Match": "*"
        },
        expires_at: "2026-08-08T12:10:00.000Z"
      },
      asset_expires_at: "2026-08-09T12:00:00.000Z",
      limits: {
        maximum_bytes: 20 * 1_024 * 1_024,
        maximum_images_per_model_request: 8
      }
    });
    expect(service.createAsset).toHaveBeenCalledWith("subject-test", {
      contentType: "image/png",
      sizeBytes: 68,
      sha256: "a".repeat(64)
    });
  });

  it("completes, refreshes and deletes a stable asset ID", async () => {
    const service = fakeService();
    const app = testApp(service);
    const complete = await app.inject({
      method: "POST",
      url: "/gateway/vision/assets/va1.test.signature/complete"
    });
    expect(complete.statusCode).toBe(200);
    expect(complete.json()).toMatchObject({
      asset_id: "va1.test.signature",
      state: "ready",
      image_url: "https://account.example.com/read-signed"
    });
    expect(service.completeAsset).toHaveBeenCalledWith(
      "subject-test",
      "va1.test.signature"
    );

    const read = await app.inject({
      method: "POST",
      url: "/gateway/vision/assets/va1.test.signature/read-url",
      payload: {}
    });
    expect(read.statusCode).toBe(200);
    expect(read.headers["cache-control"]).toBe("no-store");
    expect(service.createReadUrl).toHaveBeenCalledWith(
      "subject-test",
      "va1.test.signature"
    );

    const deleted = await app.inject({
      method: "DELETE",
      url: "/gateway/vision/assets/va1.test.signature"
    });
    expect(deleted.statusCode).toBe(204);
    expect(service.deleteAsset).toHaveBeenCalledWith(
      "subject-test",
      "va1.test.signature"
    );
  });

  it("rejects invalid bodies, unavailable storage and denied plans", async () => {
    const service = fakeService();
    const app = testApp(service);
    const invalid = await app.inject({
      method: "POST",
      url: "/gateway/vision/assets",
      payload: {
        content_type: "image/gif",
        size_bytes: 10,
        sha256: "a".repeat(64)
      }
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error.code).toBe("unsupported_format");

    const unavailable = testApp(null);
    const missing = await unavailable.inject({
      method: "POST",
      url: "/gateway/vision/assets",
      payload: {
        content_type: "image/png",
        size_bytes: 10,
        sha256: "a".repeat(64)
      }
    });
    expect(missing.statusCode).toBe(503);
    expect(missing.json().error.code).toBe("service_unavailable");

    const denied = testApp(service, () =>
      new GatewayError({
        code: "plan_inactive",
        message: "Plan entitlement is inactive.",
        httpStatus: 402
      })
    );
    const deniedResponse = await denied.inject({
      method: "POST",
      url: "/gateway/vision/assets",
      payload: {
        content_type: "image/png",
        size_bytes: 10,
        sha256: "a".repeat(64)
      }
    });
    expect(deniedResponse.statusCode).toBe(402);
    expect(deniedResponse.json().error.code).toBe("plan_inactive");
  });
});

function testApp(
  service: VisionAssetService | null,
  authorize?: () => GatewayError | null
) {
  const app = Fastify({ logger: false });
  apps.push(app);
  app.addHook("onRequest", async (request) => {
    request.gatewayContext = {
      subject: {
        id: "subject-test",
        label: "Subject test",
        state: "active",
        createdAt: new Date("2026-08-08T00:00:00.000Z")
      }
    } as unknown as GatewayRequestContext;
  });
  registerVisionAssetRoutes(app, { service, authorize });
  return app;
}

function fakeService(): VisionAssetService & {
  createAsset: ReturnType<typeof vi.fn>;
  completeAsset: ReturnType<typeof vi.fn>;
  createReadUrl: ReturnType<typeof vi.fn>;
  deleteAsset: ReturnType<typeof vi.fn>;
} {
  const uploadGrant: VisionAssetUploadGrant = {
    assetId: "va1.test.signature",
    contentType: "image/png",
    sizeBytes: 68,
    sha256: "a".repeat(64),
    uploadUrl: "https://account.example.com/upload-signed",
    uploadHeaders: {
      "Content-Type": "image/png",
      "If-None-Match": "*"
    },
    uploadExpiresAt: new Date("2026-08-08T12:10:00.000Z"),
    assetExpiresAt: new Date("2026-08-09T12:00:00.000Z")
  };
  const readGrant: VisionAssetReadGrant = {
    assetId: "va1.test.signature",
    contentType: "image/png",
    sizeBytes: 68,
    sha256: "a".repeat(64),
    imageUrl: "https://account.example.com/read-signed",
    readUrlExpiresAt: new Date("2026-08-08T12:30:00.000Z"),
    assetExpiresAt: new Date("2026-08-09T12:00:00.000Z")
  };
  return {
    createAsset: vi.fn(() => uploadGrant),
    completeAsset: vi.fn(async () => readGrant),
    createReadUrl: vi.fn(async () => readGrant),
    deleteAsset: vi.fn(async () => undefined)
  };
}
