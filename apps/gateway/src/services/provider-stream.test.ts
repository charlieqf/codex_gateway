import { describe, expect, it } from "vitest";
import {
  collectProviderMessage,
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
  it("preserves structured context length errors", () => {
    const error = streamErrorToGatewayError({
      code: "context_length_exceeded",
      message:
        "Current conversation is too long. Start a new conversation or clear earlier history before retrying."
    });

    expect(error.code).toBe("context_length_exceeded");
    expect(error.httpStatus).toBe(413);
    expect(error.message).toBe(
      "Current conversation is too long. Start a new conversation or clear earlier history before retrying."
    );
  });

  it("maps context_too_large aliases to the public context length code", () => {
    const error = streamErrorToGatewayError({
      code: "context_too_large",
      message: "Current conversation is too long."
    });

    expect(error.code).toBe("context_length_exceeded");
    expect(error.httpStatus).toBe(413);
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
