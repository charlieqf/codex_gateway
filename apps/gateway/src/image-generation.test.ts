import { afterEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { GatewayError } from "@codex-gateway/core";
import {
  finalizeImageGenerationResult,
  isImageBillingLimitError,
  OpenAIImageGenerationProvider,
  parseImageGenerationRequest,
  resolveImageUpstreamModel,
  type ImageGenerationRequest
} from "./image-generation.js";

const originalFetch = globalThis.fetch;

const request: ImageGenerationRequest = {
  model: "medcode-image-default",
  prompt: "Create a diagram.",
  size: "1024x1024",
  outputSize: "1024x1024",
  quality: "low",
  outputFormat: "jpeg",
  metadata: {}
};

describe("OpenAIImageGenerationProvider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch;
  });

  it("maps parent client aborts separately from upstream timeouts", async () => {
    let upstreamSignal: AbortSignal | undefined;
    globalThis.fetch = vi.fn((_url, init) => {
      upstreamSignal = init?.signal as AbortSignal;
      return new Promise<Response>((_resolve, reject) => {
        upstreamSignal?.addEventListener("abort", () => reject(upstreamSignal?.reason), {
          once: true
        });
      });
    }) as unknown as typeof fetch;

    const provider = new OpenAIImageGenerationProvider({
      apiKey: "sk-test",
      timeoutMs: 30_000
    });
    const controller = new AbortController();
    const pending = provider.generate({
      request,
      upstreamModel: "gpt-image-2",
      signal: controller.signal
    });

    controller.abort(new Error("client_aborted"));

    await expect(pending).rejects.toMatchObject({
      code: "client_aborted",
      httpStatus: 499
    });
  });

  it("passes low-quality jpeg output options through to the upstream image API", async () => {
    let body: Record<string, unknown> | undefined;
    globalThis.fetch = vi.fn(async (_url, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          data: [
            {
              b64_json: "ZmFrZS1pbWFnZQ=="
            }
          ]
        }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    const provider = new OpenAIImageGenerationProvider({
      apiKey: "sk-test",
      timeoutMs: 30_000
    });

    await provider.generate({
      request: {
        ...request,
        outputCompression: 40
      },
      upstreamModel: "gpt-image-2"
    });

    expect(body).toMatchObject({
      model: "gpt-image-2",
      prompt: "Create a diagram.",
      size: "1024x1024",
      quality: "low",
      output_format: "jpeg",
      output_compression: 40
    });
  });

  it("maps OpenAI billing hard limit errors as billing-limit upstream failures", async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          error: {
            code: "invalid_request_error",
            message: "Billing hard limit has been reached."
          }
        }),
        { status: 400 }
      );
    }) as unknown as typeof fetch;

    const provider = new OpenAIImageGenerationProvider({
      apiKey: "sk-test",
      timeoutMs: 30_000
    });

    try {
      await provider.generate({
        request,
        upstreamModel: "gpt-image-2"
      });
      throw new Error("expected provider.generate to fail");
    } catch (err) {
      expect(err).toBeInstanceOf(GatewayError);
      const error = err as GatewayError;
      expect(error).toMatchObject({
        code: "upstream_unavailable",
        httpStatus: 503,
        upstreamStatus: 400,
        message: "Billing hard limit has been reached."
      });
      expect(isImageBillingLimitError(error)).toBe(true);
    }
  });
});
describe("parseImageGenerationRequest", () => {
  it("defaults to the fast 1024 square low-quality jpeg profile", () => {
    const parsed = parseImageGenerationRequest(
      {
        prompt: "Create a clean medical mechanism diagram."
      },
      { maxPromptChars: 12_000 }
    );

    expect(parsed).not.toBeInstanceOf(GatewayError);
    expect(parsed).toMatchObject({
      model: "medcode-image-default",
      size: "1024x1024",
      outputSize: "1024x1024",
      quality: "low",
      outputFormat: "jpeg"
    });
  });

  it("normalizes 1080 square requests to 1024 upstream generation plus 1080 output", () => {
    const parsed = parseImageGenerationRequest(
      {
        prompt: "现在请你帮我绘制一张讲述SLE发病机制的机制图1080*1080",
        size: "1080*1080",
        quality: "auto"
      },
      { maxPromptChars: 12_000 }
    );

    expect(parsed).not.toBeInstanceOf(GatewayError);
    expect(parsed).toMatchObject({
      size: "1024x1024",
      outputSize: "1080x1080",
      quality: "low",
      outputFormat: "jpeg"
    });
  });

  it("allows explicit higher quality and compressed webp output", () => {
    const parsed = parseImageGenerationRequest(
      {
        prompt: "Create a diagram.",
        quality: "high",
        output_format: "webp",
        output_compression: 50
      },
      { maxPromptChars: 12_000 }
    );

    expect(parsed).not.toBeInstanceOf(GatewayError);
    expect(parsed).toMatchObject({
      quality: "high",
      outputFormat: "webp",
      outputCompression: 50
    });
  });

  it("rejects output_compression for png output", () => {
    const parsed = parseImageGenerationRequest(
      {
        prompt: "Create a diagram.",
        output_format: "png",
        output_compression: 50
      },
      { maxPromptChars: 12_000 }
    );

    expect(parsed).toBeInstanceOf(GatewayError);
    expect(parsed).toMatchObject({
      code: "invalid_request"
    });
  });
});

describe("resolveImageUpstreamModel", () => {
  it("accepts the new fast defaults for legacy auto/png image policies", () => {
    const upstreamModel = resolveImageUpstreamModel(
      request,
      {
        capabilities: ["chat", "tools", "image_generation"],
        imageGeneration: {
          enabled: true,
          allowedModels: ["medcode-image-default"],
          defaultModel: "medcode-image-default",
          allowedSizes: ["1024x1024", "1024x1536", "1536x1024", "auto"],
          allowedQualities: ["auto"],
          allowedFormats: ["png"]
        }
      },
      {
        "medcode-image-default": "gpt-image-2"
      }
    );

    expect(upstreamModel).toBe("gpt-image-2");
  });
});

describe("finalizeImageGenerationResult", () => {
  it("resizes 1024 upstream images to the requested 1080 square output", async () => {
    const source = await sharp({
      create: {
        width: 1024,
        height: 1024,
        channels: 3,
        background: "#ffffff"
      }
    })
      .jpeg()
      .toBuffer();

    const finalized = await finalizeImageGenerationResult({
      request: {
        ...request,
        outputSize: "1080x1080"
      },
      result: {
        data: [
          {
            b64_json: source.toString("base64")
          }
        ]
      }
    });

    const output = Buffer.from(finalized.data[0].b64_json, "base64");
    const metadata = await sharp(output).metadata();
    expect(metadata.width).toBe(1080);
    expect(metadata.height).toBe(1080);
    expect(finalized.data[0].mime_type).toBe("image/jpeg");
  });

  it("rasterizes SVG upstream output instead of returning SVG to clients", async () => {
    const source = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><rect width="1024" height="1024" fill="white"/><circle cx="512" cy="512" r="240" fill="#1d8cf8"/></svg>'
    );

    const finalized = await finalizeImageGenerationResult({
      request,
      result: {
        data: [
          {
            b64_json: source.toString("base64"),
            mime_type: "image/svg+xml"
          }
        ]
      }
    });

    const output = Buffer.from(finalized.data[0].b64_json, "base64");
    const metadata = await sharp(output).metadata();
    expect(metadata.width).toBe(1024);
    expect(metadata.height).toBe(1024);
    expect(metadata.format).toBe("jpeg");
    expect(finalized.data[0].mime_type).toBe("image/jpeg");
  });
});
