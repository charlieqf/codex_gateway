import { describe, expect, it } from "vitest";
import {
  collectProviderMessage,
  providerStreamSummaryFromError,
  streamErrorToGatewayError
} from "./provider-stream.js";
import {
  GatewayError,
  type GatewaySession,
  type ProviderAdapter,
  type ProviderHealth,
  type StreamEvent,
  type Subject,
  type UpstreamAccount
} from "@codex-gateway/core";

describe("streamErrorToGatewayError", () => {
  it("preserves client abort errors without classifying the upstream as unavailable", () => {
    const error = streamErrorToGatewayError({
      code: "client_aborted",
      message: "Client disconnected."
    });

    expect(error.code).toBe("client_aborted");
    expect(error.httpStatus).toBe(499);
    expect(error.message).toBe("Client disconnected.");
  });

  it("normalizes structured context length errors", () => {
    const error = streamErrorToGatewayError({
      code: "context_length_exceeded",
      message:
        "Current conversation is too long. Start a new conversation or clear earlier history before retrying."
    });

    expect(error.code).toBe("context_length_exceeded");
    expect(error.httpStatus).toBe(413);
    expect(error.message).toBe(
      "Current conversation or attached files are too large. Start a new conversation, split large PDFs/files, or clear earlier history before retrying."
    );
  });

  it("maps context_too_large aliases to the public context length code", () => {
    const error = streamErrorToGatewayError({
      code: "context_too_large",
      message: "Current conversation is too long."
    });

    expect(error.code).toBe("context_length_exceeded");
    expect(error.httpStatus).toBe(413);
    expect(error.message).toBe(
      "Current conversation or attached files are too large. Start a new conversation, split large PDFs/files, or clear earlier history before retrying."
    );
  });

  it.each([
    ["upstream_incomplete_stream", "Incomplete upstream stream."],
    ["upstream_empty_response", "Empty upstream response."]
  ])("preserves %s as a retryable upstream protocol error", (code, message) => {
    const error = streamErrorToGatewayError({ code, message });

    expect(error.code).toBe(code);
    expect(error.httpStatus).toBe(502);
    expect(error.message).toBe(message);
  });
});

describe("collectProviderMessage", () => {
  it("maps length-truncated empty provider output to a context error", async () => {
    const result = await collectProviderMessage({
      provider: fakeProvider([
        {
          type: "completed",
          responseSummary: {
            finishReason: "length",
            upstreamRequestId: "upstream_1",
            upstreamHttpStatus: 200,
            rawResponseHash: "hash_1",
            rawResponseChars: 304
          }
        }
      ]),
      upstreamAccount: upstreamAccount(),
      subject: subject(),
      scope: "code",
      session: session(),
      message: "hello",
      upstreamRuntime: "openrouter",
      upstreamModel: "z-ai/glm-5-turbo"
    });

    expect(result).toBeInstanceOf(GatewayError);
    expect((result as GatewayError).code).toBe("context_length_exceeded");
    expect((result as GatewayError).httpStatus).toBe(413);
  });

  it("keeps length-truncated provider output when visible content exists", async () => {
    const result = await collectProviderMessage({
      provider: fakeProvider([
        { type: "message_delta", text: "partial output" },
        {
          type: "completed",
          responseSummary: {
            finishReason: "length",
            upstreamRequestId: "upstream_1",
            upstreamHttpStatus: 200,
            rawResponseHash: "hash_1",
            rawResponseChars: 512
          }
        }
      ]),
      upstreamAccount: upstreamAccount(),
      subject: subject(),
      scope: "code",
      session: session(),
      message: "hello",
      upstreamRuntime: "openrouter",
      upstreamModel: "z-ai/glm-5-turbo"
    });

    expect(result).not.toBeInstanceOf(GatewayError);
    expect(result).toMatchObject({
      content: "partial output",
      providerSummary: {
        finishReason: "length",
        contentChars: "partial output".length,
        toolCallCount: 0
      }
    });
  });

  it("preserves provider response diagnostics attached to an error event", async () => {
    const result = await collectProviderMessage({
      provider: fakeProvider([
        { type: "message_delta", text: "partial" },
        {
          type: "error",
          code: "upstream_incomplete_stream",
          message: "The stream ended early.",
          responseSummary: {
            finishReason: null,
            upstreamRequestId: "upstream_incomplete_1",
            upstreamHttpStatus: 200,
            rawResponseHash: "hash_incomplete",
            rawResponseChars: 234,
            terminationKind: "eof_before_terminal"
          }
        }
      ]),
      upstreamAccount: upstreamAccount(),
      subject: subject(),
      scope: "code",
      session: session(),
      message: "hello",
      upstreamRuntime: "openrouter",
      upstreamModel: "z-ai/glm-5-turbo"
    });

    expect(result).toBeInstanceOf(GatewayError);
    expect((result as GatewayError).code).toBe("upstream_incomplete_stream");
    expect(providerStreamSummaryFromError(result as GatewayError)).toMatchObject({
      finishReason: null,
      upstreamRequestId: "upstream_incomplete_1",
      upstreamHttpStatus: 200,
      errorCode: "upstream_incomplete_stream",
      contentChars: "partial".length,
      rawResponseHash: "hash_incomplete",
      rawResponseChars: 234,
      terminationKind: "eof_before_terminal"
    });
  });

  it("maps a protocol-complete empty provider message to an upstream error", async () => {
    const result = await collectProviderMessage({
      provider: fakeProvider([
        {
          type: "completed",
          responseSummary: {
            upstreamHttpStatus: 200,
            rawResponseHash: "hash_empty",
            rawResponseChars: 8,
            terminationKind: "done"
          }
        }
      ]),
      upstreamAccount: upstreamAccount(),
      subject: subject(),
      scope: "code",
      session: session(),
      message: "hello",
      upstreamRuntime: "openrouter",
      upstreamModel: "z-ai/glm-5-turbo"
    });

    expect(result).toBeInstanceOf(GatewayError);
    expect((result as GatewayError).code).toBe("upstream_empty_response");
    expect((result as GatewayError).httpStatus).toBe(502);
    expect(providerStreamSummaryFromError(result as GatewayError)).toMatchObject({
      finishReason: null,
      upstreamHttpStatus: 200,
      errorCode: "upstream_empty_response",
      contentChars: 0,
      toolCallCount: 0,
      terminationKind: "done"
    });
  });

  it("does not infer an upstream finish reason from visible content", async () => {
    const result = await collectProviderMessage({
      provider: fakeProvider([
        { type: "message_delta", text: "visible" },
        { type: "completed" }
      ]),
      upstreamAccount: upstreamAccount(),
      subject: subject(),
      scope: "code",
      session: session(),
      message: "hello"
    });

    expect(result).not.toBeInstanceOf(GatewayError);
    expect(result).toMatchObject({
      content: "visible",
      providerSummary: {
        finishReason: null,
        contentChars: "visible".length,
        terminationKind: null
      }
    });
  });
});

function fakeProvider(events: StreamEvent[]): ProviderAdapter {
  return {
    kind: "openrouter",
    async health(): Promise<ProviderHealth> {
      return {
        state: "healthy",
        checkedAt: new Date("2026-01-01T00:00:00Z")
      };
    },
    async *message(): AsyncIterable<StreamEvent> {
      yield* events;
    }
  };
}

function upstreamAccount(): UpstreamAccount {
  return {
    id: "openrouter-main",
    provider: "openrouter",
    label: "OpenRouter",
    credentialRef: "openrouter",
    state: "active",
    lastUsedAt: null,
    cooldownUntil: null
  };
}

function subject(): Subject {
  return {
    id: "subject_1",
    label: "Test User",
    state: "active",
    createdAt: new Date("2026-01-01T00:00:00Z")
  };
}

function session(): GatewaySession {
  return {
    id: "session_1",
    subjectId: "subject_1",
    upstreamAccountId: "openrouter-main",
    providerSessionRef: null,
    title: null,
    state: "active",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z")
  };
}
