import { afterEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { GatewayError } from "@codex-gateway/core";
import {
  finalizeImageGenerationResult,
  GeminiImageGenerationProvider,
  isImageBillingLimitError,
  OpenAIImageGenerationProvider,
  parseImageGenerationRequest,
  resolveImageUpstreamModel,
  XAIImageGenerationProvider,
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

  it("maps insufficient quota errors as billing-limit upstream failures", async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          error: {
            code: "insufficient_quota",
            message: "You exceeded your current quota."
          }
        }),
        { status: 429 }
      );
    }) as unknown as typeof fetch;

    const provider = new OpenAIImageGenerationProvider({
      apiKey: "sk-test",
      timeoutMs: 30_000
    });

    await expect(
      provider.generate({
        request,
        upstreamModel: "gpt-image-2"
      })
    ).rejects.toMatchObject({
      code: "upstream_unavailable",
      httpStatus: 503,
      upstreamStatus: 429
    });
  });
});

describe("XAIImageGenerationProvider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch;
  });

  it("uses the xAI image endpoint with base64 output", async () => {
    let url: string | undefined;
    let body: Record<string, unknown> | undefined;
    globalThis.fetch = vi.fn(async (input, init) => {
      url = String(input);
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

    const provider = new XAIImageGenerationProvider({
      apiKey: "xai-test",
      timeoutMs: 30_000
    });

    const result = await provider.generate({
      request: {
        ...request,
        size: "1536x1024",
        outputSize: "1536x1024"
      },
      upstreamModel: "grok-imagine-image-quality"
    });

    expect(url).toBe("https://api.x.ai/v1/images/generations");
    expect(body).toMatchObject({
      model: "grok-imagine-image-quality",
      prompt: "Create a diagram.",
      response_format: "b64_json",
      aspect_ratio: "3:2",
      resolution: "1k"
    });
    expect(result.data[0].b64_json).toBe("ZmFrZS1pbWFnZQ==");
  });
});

describe("GeminiImageGenerationProvider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch;
  });

  it("uses the Gemini Interactions image API", async () => {
    let url: string | undefined;
    let headers: HeadersInit | undefined;
    let body: Record<string, unknown> | undefined;
    globalThis.fetch = vi.fn(async (input, init) => {
      url = String(input);
      headers = init?.headers;
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          output_image: {
            data: "ZmFrZS1pbWFnZQ==",
            mime_type: "image/jpeg"
          }
        }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    const provider = new GeminiImageGenerationProvider({
      apiKey: "gemini-test",
      timeoutMs: 30_000
    });

    const result = await provider.generate({
      request,
      upstreamModel: "gemini-3.1-flash-image"
    });

    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/interactions");
    expect(headers).toMatchObject({
      "x-goog-api-key": "gemini-test"
    });
    expect(body).toMatchObject({
      model: "gemini-3.1-flash-image",
      input: [{ type: "text", text: "Create a diagram." }],
      response_format: {
        type: "image",
        mime_type: "image/jpeg",
        aspect_ratio: "1:1",
        image_size: "1K"
      }
    });
    expect(result.data[0]).toMatchObject({
      b64_json: "ZmFrZS1pbWFnZQ==",
      mime_type: "image/jpeg"
    });
  });

  it("maps Gemini quota exhaustion as a billing-limit upstream failure", async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          error: {
            status: "RESOURCE_EXHAUSTED",
            message: "Quota exceeded for image generation."
          }
        }),
        { status: 429 }
      );
    }) as unknown as typeof fetch;

    const provider = new GeminiImageGenerationProvider({
      apiKey: "gemini-test",
      timeoutMs: 30_000
    });

    try {
      await provider.generate({
        request,
        upstreamModel: "gemini-3.1-flash-image"
      });
      throw new Error("expected provider.generate to fail");
    } catch (err) {
      expect(err).toBeInstanceOf(GatewayError);
      const error = err as GatewayError;
      expect(error).toMatchObject({
        code: "upstream_unavailable",
        httpStatus: 503,
        upstreamStatus: 429
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
