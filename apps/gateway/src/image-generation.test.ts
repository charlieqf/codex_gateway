import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAIImageGenerationProvider, type ImageGenerationRequest } from "./image-generation.js";

const originalFetch = globalThis.fetch;

const request: ImageGenerationRequest = {
  model: "medcode-image-default",
  prompt: "Create a diagram.",
  size: "1024x1024",
  quality: "auto",
  outputFormat: "png",
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
});
