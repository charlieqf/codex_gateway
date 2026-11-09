import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GatewayError, type MessageInput } from "@codex-gateway/core";
import { createSqliteStore } from "@codex-gateway/store-sqlite";
import { OpenAICompatibleProviderAdapter } from "./openai-compatible-provider.js";
import { collectProviderMessage, providerStreamSummaryFromError } from "./provider-stream.js";
import { VisionRequestRecovery, runVisionRequestRecovery } from "./vision-request-recovery.js";

const input: MessageInput = {
  upstreamAccount: { id: "synthetic", provider: "tiankuan", label: "test", credentialRef: "unused",
    state: "active", lastUsedAt: null, cooldownUntil: null },
  subject: { id: "test", label: "test", state: "active", createdAt: new Date(0) },
  session: { id: "test", subjectId: "test", upstreamAccountId: "synthetic", publicModelId: null,
    providerSessionRef: null, title: null, state: "active", createdAt: new Date(0), updatedAt: new Date(0) },
  scope: "code", message: "synthetic image task",
  images: [{ imageUrl: "https://synthetic.invalid/image.png" }]
};

function adapter(fetchImpl: typeof fetch) {
  return new OpenAICompatibleProviderAdapter({ providerKind: "tiankuan", apiKey: "sk-synthetic-secret",
    apiKeyEnv: "UNUSED", baseUrl: "https://synthetic.invalid/v1", upstreamModel: "synthetic",
    timeoutMs: 5000, fetchImpl });
}

function streamError(error: unknown, prefix = "", envelope: Record<string, unknown> = {}) {
  return new Response(prefix + `data: ${JSON.stringify({ ...envelope, error })}\n\n`, { status: 200 });
}

const timeout = { type: "invalid_request_error", message: "Error while downloading image: timed out. Request id: req_download_timeout" };

describe("provider error evidence and bounded vision recovery", () => {
  it.each([
    [timeout, "upstream_timeout", "image_download_timeout", 504, "inferred", undefined],
    [{ ...timeout, code: "400" }, "invalid_request", "image_download_timeout", 400, "explicit", undefined],
    [{ type: "api_error", code: "400", message: "Error while downloading: https://private.invalid/a?X-Amz-Signature=private-signature status code: 404 Request id: req_missing" },
      "invalid_request", "image_download_http", 400, "explicit", 404],
    [{ type: "api_error", message: "Error while downloading image: status code: 404" },
      "invalid_request", "image_download_http", 400, "inferred", 404],
    [{ type: "api_error", message: "Error while downloading image: status code: 503" },
      "upstream_unavailable", "image_download_http", 503, "inferred", 503],
    [{ type: "api_error", code: "400", message: "Error while downloading image: status code: 503" },
      "invalid_request", "image_download_http", 400, "explicit", 503],
    [{ type: "invalid_request_error", message: "Invalid timeout parameter while downloading image" },
      "invalid_request", "invalid_request", 400, "inferred", undefined],
    [{ type: "invalid_request_error", message: "Error while downloading: https://private.invalid/timeout?status=504" },
      "invalid_request", "invalid_request", 400, "inferred", undefined],
    [{ code: 504, message: "upstream unavailable" }, "upstream_timeout", "unknown", 504, "explicit", undefined]
  ] as const)("classifies %j without storing private text", async (error, code, category, status, statusSource, downloadStatus) => {
    const result = await collectProviderMessage({ ...input, provider: adapter(async () => streamError(error)) });
    expect(result).toBeInstanceOf(GatewayError);
    expect(result).toMatchObject({ code, providerFailure: { upstreamStatus: status, stage: "streaming" } });
    const summary = providerStreamSummaryFromError(result as GatewayError)!;
    expect(summary).toMatchObject({ upstreamHttpStatus: 200, providerError: {
      source: "stream_error_frame", status, category, statusSource,
      ...(downloadStatus ? { downloadStatus } : {})
    } });
    expect(summary.attempts[0]?.providerError).toEqual(summary.providerError);
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain("private.invalid");
    expect(serialized).not.toContain("private-signature");
    expect(serialized).not.toContain(error.message);
  });

  it.each([
    [{ request_id: "nested_id", message: "Request id: embedded_id" }, {}, "nested_id"],
    [{ request_id: "sk-synthetic-secret", message: "Request id: embedded_id" }, {}, "embedded_id"],
    [{ message: "Request id: embedded_id" }, {}, "embedded_id"],
    [{ message: "Request id: embedded_id" }, { request_id: "envelope_id" }, "envelope_id"],
    [{ message: "Request id: sk-synthetic-secret" }, {}, null],
    [{ request_id: "prefix-sk-synthetic-secret-end", message: "failed" }, {}, null],
    [{ message: "Request id: cgu_sensitive" }, {}, null],
    [{ message: "Request id: " + "a".repeat(161) }, {}, null],
    [{ message: "Error while downloading: https://private.invalid/?request_id=secret" }, {}, null]
  ])("extracts only safe stream request IDs from %j", async (error, envelope, id) => {
    const result = await collectProviderMessage({ ...input, provider: adapter(async () => streamError(error, "", envelope)) });
    expect(providerStreamSummaryFromError(result as GatewayError)?.upstreamRequestId).toBe(id);
  });

  it("retains HTTP status authority and prefers a safe header ID", async () => {
    const result = await collectProviderMessage({ ...input, provider: adapter(async () => new Response(
      JSON.stringify({ error: { ...timeout, code: 504 } }), { status: 400, headers: { "x-request-id": "header_id" } }
    )) });
    expect(result).toMatchObject({ code: "invalid_request" });
    expect(providerStreamSummaryFromError(result as GatewayError)).toMatchObject({ upstreamRequestId: "header_id",
      upstreamHttpStatus: 400, providerError: { status: 400, statusSource: "http", category: "image_download_timeout" } });
  });

  it("skips an unsafe header ID and retains a safe nested ID", async () => {
    const result = await collectProviderMessage({ ...input, provider: adapter(async () => new Response(
      JSON.stringify({ error: { ...timeout, request_id: "nested_id" } }),
      { status: 400, headers: { "x-request-id": "sk-synthetic-secret" } }
    )) });
    expect(providerStreamSummaryFromError(result as GatewayError)?.upstreamRequestId).toBe("nested_id");
  });

  it.each(["success", "fails_twice", "explicit_400", "download_404", "visible_output", "short_deadline", "cancelled"])(
    "keeps the shared two-call budget and delivery/deadline boundaries: %s", async condition => {
      let calls = 0;
      const controller = new AbortController();
      const recovery = new VisionRequestRecovery(1);
      const provider = adapter(async () => {
        calls++;
        if (condition === "cancelled") controller.abort();
        if (condition === "success" && calls === 2) return new Response('data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
        return streamError(condition === "explicit_400" ? { ...timeout, code: 400 }
          : condition === "download_404" ? { type: "api_error", message: "Error while downloading image: status code: 404" } : timeout,
          condition === "visible_output" ? 'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n' : "");
      });
      const result = await runVisionRequestRecovery({ recovery, signal: controller.signal,
        deadlineAt: new Date(Date.now() + (condition === "short_deadline" ? 1000 : 10000)),
        now: () => new Date(), outputCommitted: () => false,
        execute: async budget => {
          budget.consume();
          return collectProviderMessage({ ...input, provider, signal: controller.signal });
        }
      });
      expect(calls).toBe(["success", "fails_twice"].includes(condition) ? 2 : 1);
      if (condition === "success") {
        expect(result).not.toBeInstanceOf(GatewayError);
        if (result instanceof GatewayError) throw result;
        expect(result.content).toBe("OK");
        expect(result.providerSummary?.attempts).toMatchObject([
          { providerError: { category: "image_download_timeout" }, upstreamRequestId: "req_download_timeout" },
          { errorCode: null }
        ]);
      } else {
        expect(result).toBeInstanceOf(GatewayError);
        expect(recovery.stopReason).toBe(({ fails_twice: "calls_exhausted", explicit_400: "not_retryable",
          download_404: "not_retryable", visible_output: "response_started", short_deadline: "deadline_insufficient",
          cancelled: "cancelled" } as Record<string, string>)[condition]);
      }
    }
  );

  it("keeps request ID and safe error facts after SQLite close and reopen", async () => {
    const result = await collectProviderMessage({ ...input, provider: adapter(async () => streamError({
      code: "400", type: "api_error", message: "Error while downloading: https://private.invalid/image?X-Amz-Signature=private-signature status code: 404 Request id: durable_request_id"
    })) });
    const summary = providerStreamSummaryFromError(result as GatewayError)!;
    const directory = mkdtempSync(path.join(tmpdir(), "gateway-error-evidence-"));
    const filename = path.join(directory, "gateway.db");
    let store = createSqliteStore({ path: filename });
    try {
      store.insertRequestEvent({ requestId: "synthetic_error", credentialId: null, subjectId: null, scope: "code",
        sessionId: null, upstreamAccountId: null, provider: "tiankuan", startedAt: new Date(), durationMs: 1,
        firstByteMs: null, status: "error", errorCode: "invalid_request", rateLimited: false,
        upstreamAttempts: summary.attempts });
      store.close();
      store = createSqliteStore({ path: filename });
      const [event] = store.listRequestEvents();
      expect(event?.upstreamAttempts?.[0]).toMatchObject({ upstreamRequestId: "durable_request_id", upstreamHttpStatus: 200,
        providerError: { source: "stream_error_frame", statusSource: "explicit", status: 400,
          category: "image_download_http", downloadStatus: 404 } });
      const serialized = JSON.stringify(event);
      expect(serialized).not.toContain("private.invalid");
      expect(serialized).not.toContain("private-signature");
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
