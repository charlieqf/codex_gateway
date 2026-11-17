import { describe, expect, it } from "vitest";
import { createVisionAdapters } from "./chat-providers.js";
import { resolvePublicModelRegistry } from "../services/public-model-registry.js";

const models = () => resolvePublicModelRegistry({ MEDCODE_PUBLIC_MODELS_JSON: JSON.stringify({
  goldencode: { runtime: "codex", upstreamModel: "text-model", vision: {
    runtime: "tiankuan", upstreamModel: "deepseek-v4.1-flash", contextWindow: 200000, maxOutputTokens: 128000
  } }
}) }).models;

describe("dedicated TianKuan vision credentials", () => {
  it("does not fall back to xAI when TianKuan credentials are missing", () => {
    const adapters = createVisionAdapters(models(), { MEDCODE_VISION_XAI_API_KEY: "synthetic-xai-key",
      MEDCODE_IMAGE_BILLING_FALLBACK_KEYS_FILE: "/must-not-be-read" });
    expect(adapters.size).toBe(0);
  });

  it("uses the configured TianKuan credential reference independently of the text model", () => {
    const adapters = createVisionAdapters(models(), { MEDCODE_TIANKUAN_API_KEY_ENV: "SYNTHETIC_VISION_KEY",
      SYNTHETIC_VISION_KEY: "synthetic-tiankuan-key", MEDCODE_IMAGE_BILLING_FALLBACK_KEYS_FILE: "/must-not-be-read" });
    expect(adapters.size).toBe(1);
    expect(adapters.get("goldencode")?.kind).toBe("tiankuan");
  });
});

describe("vision provider pools", () => {
  const registry = (secondEnabled = true, secondRuntime = "tiankuan") => resolvePublicModelRegistry({
    MEDCODE_PUBLIC_MODELS_JSON: JSON.stringify({ goldencode: { runtime: "codex", upstreamModel: "text-model",
      vision: { runtime: "pool", pool: { members: [
        { id: "vision-tencent", runtime: "tencent", upstreamModel: "deepseek-v4.1-flash-1017" },
        { id: "vision-tiankuan", runtime: secondRuntime, upstreamModel: "deepseek-v4.1-flash", enabled: secondEnabled }
      ] } } } })
  }).models;
  const credentials = { MEDCODE_TENCENT_TOKENHUB_API_KEY: "synthetic-tencent",
    MEDCODE_TIANKUAN_API_KEY: "synthetic-tiankuan" };

  it("creates both vision providers independently of text", () => {
    const adapters = createVisionAdapters(registry(), credentials);
    expect([...adapters].map(([id, adapter]) => [id, adapter.kind])).toEqual([
      ["vision-tencent", "tencent"], ["vision-tiankuan", "tiankuan"]
    ]);
  });

  it("does not instantiate disabled or uncredentialed vision members", () => {
    expect([...createVisionAdapters(registry(false), credentials).keys()]).toEqual(["vision-tencent"]);
    expect([...createVisionAdapters(registry(), { MEDCODE_TIANKUAN_API_KEY: "synthetic" }).keys()]).toEqual(["vision-tiankuan"]);
  });

  it("rejects providers without a supported vision route", () => {
    expect(() => registry(true, "openrouter")).toThrow("vision.pool members must use tencent or tiankuan");
  });
});
