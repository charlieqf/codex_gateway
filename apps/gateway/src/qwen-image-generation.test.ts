import { afterEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { QwenImageGenerationProvider, finalizeImageGenerationResult, parseImageGenerationRequest, resolveImageUpstreamModel, type ImageGenerationRequest } from "./image-generation.js";
import { GatewayError, defaultImageGenerationFeaturePolicy } from "@codex-gateway/core";
import { createDefaultImageGenerationProvider, parseImagePrimaryProvider, resolveImageGenerationBillingFallbacks } from "./runtime/image-providers.js";
import { validateRuntimeEnvironment } from "./runtime/auth-config.js";

const request: ImageGenerationRequest = { prompt: "Three ceramic cups.", model: "medcode-image-default", size: "auto", outputSize: "1024x1024", quality: "low", outputFormat: "jpeg", outputCompression: 20, metadata: {} };
afterEach(() => vi.unstubAllGlobals());

describe("Qwen image primary", () => {
  it("receives PNG from Qwen and returns real JPEG bytes at the requested size", async () => {
    const png = await sharp({ create: { width: 1024, height: 1024, channels: 4, background: "#fff" } }).png().toBuffer();
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ evaluation: { steps: 30 }, data: [{ b64_json: png.toString("base64"), mime_type: "image/png" }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    const provider = new QwenImageGenerationProvider({ apiKey: "test", baseUrl: "http://private-qwen:8191" });
    const result = await provider.generate({ request, upstreamModel: "qwen-image-2.1" });
    expect(provider.providerKind).toBe("qwen-image");
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://private-qwen:8191/v1/images/generations");
    expect(init.headers).toMatchObject({ authorization: "Bearer test" });
    expect(JSON.parse(String(init.body))).toMatchObject({ model: "qwen-image-2.1", size: "1024x1024", output_format: "png" });
    expect(JSON.parse(String(init.body))).not.toHaveProperty("output_compression");
    expect(result.data[0].mime_type).toBe("image/png");
    const final = await finalizeImageGenerationResult({ request, result });
    const bytes = Buffer.from(final.data[0].b64_json, "base64");
    expect(bytes.subarray(0, 3).toString("hex")).toBe("ffd8ff");
    expect(await sharp(bytes).metadata()).toMatchObject({ format: "jpeg", width: 1024, height: 1024 });
  });

  it.each([429, 503])("preserves upstream %s for the existing fallback policy", async (status) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ detail: "GPU busy" }), { status })));
    const provider = new QwenImageGenerationProvider({ apiKey: "test", baseUrl: "http://private-qwen:8191" });
    await expect(provider.generate({ request, upstreamModel: "qwen-image-2.1" })).rejects.toMatchObject({ upstreamStatus: status });
  });

  it.each([["low", 30], ["medium", 40], ["high", 50], ["auto", 40], [undefined, 40]] as const)(
    "sends and confirms the %s quality profile with a real reference and strict 3:1 output", async (quality, steps) => {
      const reference = (await sharp({ create: { width: 64, height: 64, channels: 4, background: "#05a" } }).png().toBuffer()).toString("base64");
      const png = (await sharp({ create: { width: 1536, height: 512, channels: 4, background: "#fff" } }).png().toBuffer()).toString("base64");
      const parsed = parseImageGenerationRequest({ prompt: "Preserve the logo", size: "1536x512", quality,
        reference_image: { b64_json: reference } }, { maxPromptChars: 1000 });
      if (parsed instanceof GatewayError) throw parsed;
      const fetcher = vi.fn(async () => new Response(JSON.stringify({ evaluation: { steps }, data: [{ b64_json: png, mime_type: "image/png" }] })));
      vi.stubGlobal("fetch", fetcher);
      const provider = new QwenImageGenerationProvider({ apiKey: "test", baseUrl: "http://private-qwen" });
      const result = await provider.generate({ request: parsed, upstreamModel: "qwen-image-2.1" });
      expect(JSON.parse(String((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].body)))
        .toMatchObject({ image_b64: reference, num_inference_steps: steps, size: "1536x512" });
      expect(result.generation_parameters).toMatchObject({ size: "1536x512", inference_steps: steps, reference_images: 1, mode: "edit" });
      const final = await finalizeImageGenerationResult({ request: parsed, result });
      expect(await sharp(Buffer.from(final.data[0].b64_json, "base64")).metadata()).toMatchObject({ width: 1536, height: 512, format: "jpeg" });
    });

  it("rejects malformed, oversized and non-image references before contacting the GPU", async () => {
    const boundary = Buffer.alloc(4 * 1024 * 1024).toString("base64");
    expect(parseImageGenerationRequest({ prompt: "Edit", reference_image: { b64_json: boundary } }, { maxPromptChars: 1000 })).not.toBeInstanceOf(GatewayError);
    for (const value of ["", "not base64!", "YWJj=", Buffer.alloc(4 * 1024 * 1024 + 1).toString("base64")]) {
      expect(parseImageGenerationRequest({ prompt: "Edit", reference_image: { b64_json: value } }, { maxPromptChars: 1000 })).toBeInstanceOf(GatewayError);
    }
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const provider = new QwenImageGenerationProvider({ apiKey: "test", baseUrl: "http://private-qwen" });
    const large = (await sharp({ create: { width: 2049, height: 2049, channels: 3, background: "#fff" } }).png().toBuffer()).toString("base64");
    for (const referenceImage of [Buffer.from("not an image").toString("base64"), large,
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>').toString("base64")]) {
      await expect(provider.generate({ request: { ...request, referenceImage }, upstreamModel: "qwen-image-2.1" })).rejects.toMatchObject({ code: "invalid_request" });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects unconfirmed steps and wrong upstream dimensions instead of stretching them", async () => {
    const png = (await sharp({ create: { width: 1024, height: 1024, channels: 3, background: "#fff" } }).png().toBuffer()).toString("base64");
    const provider = new QwenImageGenerationProvider({ apiKey: "test", baseUrl: "http://private-qwen" });
    for (const steps of [undefined, 40, 30]) {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ evaluation: { steps }, data: [{ b64_json: png, mime_type: "image/png" }] }))));
      await expect(provider.generate({ request: { ...request, size: "1536x512", outputSize: "1536x512" }, upstreamModel: "qwen-image-2.1" })).rejects.toBeInstanceOf(GatewayError);
    }
  });

  it("extends existing landscape entitlement to the smaller banner without granting image access", () => {
    const policy = { capabilities: ["image_generation"], imageGeneration: defaultImageGenerationFeaturePolicy() };
    const banner = { ...request, size: "1536x512" as const, outputSize: "1536x512" as const };
    policy.imageGeneration!.allowedSizes = ["1536x1024"];
    expect(resolveImageUpstreamModel(banner, policy, { "medcode-image-default": "qwen-image-2.1" })).toBe("qwen-image-2.1");
    policy.capabilities = [];
    expect(resolveImageUpstreamModel(banner, policy, { "medcode-image-default": "qwen-image-2.1" })).toBeInstanceOf(GatewayError);
  });

  it("selects Qwen and ignores stale LLaDA credentials in the fallback chain", () => {
    const env = { MEDCODE_IMAGE_GENERATION_ENABLED: "1", MEDCODE_IMAGE_PRIMARY_PROVIDER: "qwen", MEDCODE_IMAGE_QWEN_API_KEY: "test", MEDCODE_IMAGE_QWEN_BASE_URL: "http://private-qwen:8191", MEDCODE_IMAGE_LLADA_API_KEY: "llada", MEDCODE_IMAGE_OPENAI_API_KEY: "openai", MEDCODE_IMAGE_BILLING_FALLBACK_OPENAI_API_KEY: "last" };
    expect(parseImagePrimaryProvider(" Qwen ")).toBe("qwen");
    expect(createDefaultImageGenerationProvider(env)?.providerKind).toBe("qwen-image");
    const chain = resolveImageGenerationBillingFallbacks({}, env, { info() {} });
    expect(chain).toEqual([]);
    const enabledChain = resolveImageGenerationBillingFallbacks({}, { ...env, MEDCODE_IMAGE_FALLBACK_ENABLED: "1" }, { info() {} });
    expect(enabledChain.map(item => [item.provider.providerKind, item.upstreamModel])).toEqual([["openai-api", "gpt-image-2"], ["openai-api", "gpt-image-1.5"]]);
    expect(() => createDefaultImageGenerationProvider({ ...env, MEDCODE_IMAGE_QWEN_API_KEY: "" })).toThrow("QWEN_API_KEY");
    expect(() => validateRuntimeEnvironment({ ...env, NODE_ENV: "production", GATEWAY_AUTH_MODE: "credential", GATEWAY_SQLITE_PATH: "/db", CODEX_HOME: "/codex", MEDCODE_IMAGE_QWEN_BASE_URL: "" })).toThrow("QWEN_BASE_URL");
  });

  it("disables every fallback source before reading retained credentials", () => {
    const env = { MEDCODE_IMAGE_GENERATION_ENABLED: "1", MEDCODE_IMAGE_FALLBACK_ENABLED: "0",
      MEDCODE_IMAGE_OPENAI_API_KEY: "retained", MEDCODE_IMAGE_BILLING_FALLBACK_OPENAI_API_KEY: "retained",
      MEDCODE_IMAGE_BILLING_FALLBACK_KEYS_FILE: "/must-not-read" };
    expect(resolveImageGenerationBillingFallbacks({}, env, { info() {} })).toEqual([]);
    const provider = new QwenImageGenerationProvider({ apiKey: "test", baseUrl: "http://private-qwen" });
    expect(resolveImageGenerationBillingFallbacks({ imageGenerationBillingFallbacks: [{ provider }] }, env, { info() {} })).toEqual([]);
    expect(() => resolveImageGenerationBillingFallbacks({}, { ...env, MEDCODE_IMAGE_FALLBACK_ENABLED: "false" }, { info() {} })).toThrow("must be 0 or 1");
  });
});
