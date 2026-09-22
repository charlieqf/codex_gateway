import { afterEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { QwenImageGenerationProvider, finalizeImageGenerationResult, type ImageGenerationRequest } from "./image-generation.js";
import { createDefaultImageGenerationProvider, parseImagePrimaryProvider, resolveImageGenerationBillingFallbacks } from "./runtime/image-providers.js";
import { validateRuntimeEnvironment } from "./runtime/auth-config.js";

const request: ImageGenerationRequest = { prompt: "Three ceramic cups.", model: "medcode-image-default", size: "auto", outputSize: "1024x1024", quality: "low", outputFormat: "jpeg", outputCompression: 20, metadata: {} };
afterEach(() => vi.unstubAllGlobals());

describe("Qwen image primary", () => {
  it("receives PNG from Qwen and returns real JPEG bytes at the requested size", async () => {
    const png = await sharp({ create: { width: 1024, height: 1024, channels: 4, background: "#fff" } }).png().toBuffer();
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ data: [{ b64_json: png.toString("base64"), mime_type: "image/png" }] }), { status: 200 }));
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

  it("selects Qwen and ignores stale LLaDA credentials in the fallback chain", () => {
    const env = { MEDCODE_IMAGE_GENERATION_ENABLED: "1", MEDCODE_IMAGE_PRIMARY_PROVIDER: "qwen", MEDCODE_IMAGE_QWEN_API_KEY: "test", MEDCODE_IMAGE_QWEN_BASE_URL: "http://private-qwen:8191", MEDCODE_IMAGE_LLADA_API_KEY: "llada", MEDCODE_IMAGE_OPENAI_API_KEY: "openai", MEDCODE_IMAGE_BILLING_FALLBACK_OPENAI_API_KEY: "last" };
    expect(parseImagePrimaryProvider(" Qwen ")).toBe("qwen");
    expect(createDefaultImageGenerationProvider(env)?.providerKind).toBe("qwen-image");
    const chain = resolveImageGenerationBillingFallbacks({}, env, { info() {} });
    expect(chain.map(item => [item.provider.providerKind, item.upstreamModel])).toEqual([["openai-api", "gpt-image-2"], ["openai-api", "gpt-image-1.5"]]);
    expect(() => createDefaultImageGenerationProvider({ ...env, MEDCODE_IMAGE_QWEN_API_KEY: "" })).toThrow("QWEN_API_KEY");
    expect(() => validateRuntimeEnvironment({ ...env, NODE_ENV: "production", GATEWAY_AUTH_MODE: "credential", GATEWAY_SQLITE_PATH: "/db", CODEX_HOME: "/codex", MEDCODE_IMAGE_QWEN_BASE_URL: "" })).toThrow("QWEN_BASE_URL");
  });
});
