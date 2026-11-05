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
