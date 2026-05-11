import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ThreadEvent, ThreadOptions, TurnOptions } from "@openai/codex-sdk";
import { describe, expect, it } from "vitest";
import {
  CodexProviderAdapter,
  type CodexClientLike,
  type CodexThreadLike
} from "./codex-adapter.js";
import type {
  GatewaySession,
  MessageInput,
  ProviderErrorDiagnostic,
  Subject,
  UpstreamAccount
} from "@codex-gateway/core";

class FakeThread implements CodexThreadLike {
  readonly runInputs: string[] = [];

  constructor(
    readonly id: string | null,
    private readonly events: ThreadEvent[]
  ) {}

  async runStreamed(input: string, _turnOptions?: TurnOptions) {
    this.runInputs.push(input);
    return {
      events: asyncGenerator(this.events)
    };
  }
}

class FakeClient implements CodexClientLike {
  readonly startedOptions: ThreadOptions[] = [];
  readonly resumed: Array<{ id: string; options?: ThreadOptions }> = [];

  constructor(private readonly thread: FakeThread) {}

  startThread(options?: ThreadOptions): CodexThreadLike {
    this.startedOptions.push(options ?? {});
    return this.thread;
  }

  resumeThread(id: string, options?: ThreadOptions): CodexThreadLike {
    this.resumed.push({ id, options });
    return this.thread;
  }
}

describe("CodexProviderAdapter", () => {
  it("reports healthy when the Codex auth cache is present", async () => {
    const codexHome = mkdtempSync(path.join(tmpdir(), "codex-provider-health-"));
    writeFileSync(path.join(codexHome, "auth.json"), "{}");
    const adapter = createAdapter(new FakeClient(new FakeThread(null, [])), { codexHome });

    const health = await adapter.health(upstreamAccount());

    expect(health.state).toBe("healthy");
    expect(health.checkedAt).toBeInstanceOf(Date);
    expect(health.detail).toBe("Codex auth cache is present.");
  });

  it("reports reauth required when the Codex auth cache is missing", async () => {
    const codexHome = mkdtempSync(path.join(tmpdir(), "codex-provider-health-"));
    const adapter = createAdapter(new FakeClient(new FakeThread(null, [])), { codexHome });

    const health = await adapter.health(upstreamAccount());

    expect(health.state).toBe("reauth_required");
    expect(health.checkedAt).toBeInstanceOf(Date);
    expect(health.detail).toBe("Codex auth cache is missing; run device-code authorization.");
  });

  it("maps streamed agent message updates into gateway deltas", async () => {
    const thread = new FakeThread(null, [
      { type: "thread.started", thread_id: "thread_1" },
      {
        type: "item.started",
        item: { id: "msg_1", type: "agent_message", text: "hello" }
      },
      {
        type: "item.updated",
        item: { id: "msg_1", type: "agent_message", text: "hello world" }
      },
      {
        type: "item.completed",
        item: { id: "msg_1", type: "agent_message", text: "hello world" }
      },
      {
        type: "turn.completed",
        usage: {
          input_tokens: 1,
          cached_input_tokens: 0,
          output_tokens: 2,
          reasoning_output_tokens: 0
        }
      }
    ]);
    const client = new FakeClient(thread);
    const adapter = createAdapter(client);

    const events = await collect(adapter.message(messageInput({ providerSessionRef: null })));

    expect(thread.runInputs).toEqual(["hello"]);
    expect(events).toEqual([
      { type: "message_delta", text: "hello" },
      { type: "message_delta", text: " world" },
      {
        type: "completed",
        providerSessionRef: "thread_1",
        usage: {
          promptTokens: 1,
          completionTokens: 2,
          totalTokens: 3
        }
      }
    ]);
  });

  it("resumes an existing provider session ref", async () => {
    const thread = new FakeThread("thread_existing", [
      {
        type: "turn.completed",
        usage: {
          input_tokens: 1,
          cached_input_tokens: 0,
          output_tokens: 1,
          reasoning_output_tokens: 0
        }
      }
    ]);
    const client = new FakeClient(thread);
    const adapter = createAdapter(client);

    const events = await collect(
      adapter.message(messageInput({ providerSessionRef: "thread_existing" }))
    );

    expect(client.startedOptions).toEqual([]);
    expect(client.resumed.map((entry) => entry.id)).toEqual(["thread_existing"]);
    expect(events).toEqual([
      {
        type: "completed",
        providerSessionRef: "thread_existing",
        usage: {
          promptTokens: 1,
          completionTokens: 1,
          totalTokens: 2
        }
      }
    ]);
  });

  it("passes explicit model and reasoning effort to Codex threads", async () => {
    const thread = new FakeThread(null, [
      {
        type: "turn.completed",
        usage: {
          input_tokens: 1,
          cached_input_tokens: 0,
          output_tokens: 1,
          reasoning_output_tokens: 0
        }
      }
    ]);
    const client = new FakeClient(thread);
    const adapter = createAdapter(client, {
      model: "gpt-5.5",
      modelReasoningEffort: "high"
    });

    await collect(adapter.message(messageInput({ providerSessionRef: null })));

    expect(client.startedOptions[0]).toMatchObject({
      model: "gpt-5.5",
      modelReasoningEffort: "high"
    });
  });

  it("maps tool calls once", async () => {
    const thread = new FakeThread(null, [
      { type: "thread.started", thread_id: "thread_1" },
      {
        type: "item.started",
        item: {
          id: "tool_1",
          type: "mcp_tool_call",
          server: "evidence",
          tool: "search",
          arguments: { q: "abc" },
          status: "in_progress"
        }
      },
      {
        type: "item.completed",
        item: {
          id: "tool_1",
          type: "mcp_tool_call",
          server: "evidence",
          tool: "search",
          arguments: { q: "abc" },
          status: "completed"
        }
      }
    ]);
    const adapter = createAdapter(new FakeClient(thread));

    const events = await collect(adapter.message(messageInput({ providerSessionRef: null })));

    expect(events).toEqual([
      {
        type: "tool_call",
        name: "evidence.search",
        callId: "tool_1",
        arguments: { q: "abc" }
      },
      { type: "completed", providerSessionRef: "thread_1" }
    ]);
  });

  it("normalizes auth and rate limit failures", () => {
    const adapter = createAdapter(new FakeClient(new FakeThread(null, [])));
    const normalize = normalizeForTest(adapter);

    expect(normalize(new Error("Not logged in")).code).toBe("provider_reauth_required");
    expect(normalize(new Error("Not logged in")).message).toBe(
      "MedCode service requires administrator reauthorization."
    );
    expect(normalize(new Error("HTTP 429 rate limit")).code).toBe("rate_limited");
    expect(normalize(new Error("HTTP 429 rate limit")).message).toBe(
      "MedCode service rate limit reached."
    );
    expect(normalize(new Error("connection reset")).code).toBe("service_unavailable");
    expect(normalize(new Error("connection reset")).message).toBe(
      "MedCode service is temporarily unavailable."
    );
  });

  it("sanitizes provider stream error messages before returning them", async () => {
    const thread = new FakeThread(null, [
      {
        type: "error",
        message: "Codex is not logged in to ChatGPT"
      } as ThreadEvent
    ]);
    const adapter = createAdapter(new FakeClient(thread));

    const events = await collect(adapter.message(messageInput({ providerSessionRef: null })));

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "error",
      code: "provider_reauth_required",
      message: "MedCode service requires administrator reauthorization."
    });
    expect(JSON.stringify(events)).not.toContain("Codex");
    expect(JSON.stringify(events)).not.toContain("ChatGPT");
  });

  it("stops provider streams after turn failures", async () => {
    const thread = new FakeThread(null, [
      {
        type: "turn.failed",
        error: { message: "HTTP 429 rate limit" }
      } as ThreadEvent,
      {
        type: "turn.completed",
        usage: {
          input_tokens: 1,
          cached_input_tokens: 0,
          output_tokens: 1,
          reasoning_output_tokens: 0
        }
      }
    ]);
    const adapter = createAdapter(new FakeClient(thread));

    const events = await collect(adapter.message(messageInput({ providerSessionRef: null })));

    expect(events).toEqual([
      {
        type: "error",
        code: "rate_limited",
        message: "MedCode service rate limit reached."
      }
    ]);
  });

  it("reports sanitized raw provider errors through the diagnostics callback", async () => {
    const composedUnifiedKey =
      "cmev1.cgw.abcdefghij.abcdefghijklmnopqrstuvwxyz123456.mev2_live_secret";
    const opaqueUnifiedKey =
      "cgu_live_7KpQ2mN9vX4aRt6Bc8YwL3sD0fGhJkPq9UzEaVnTbR5xM1HdS7rZ2yA4C6mNp8Qz";
    const thread = new FakeThread(null, [
      {
        type: "turn.failed",
        error: {
          message:
            `HTTP 503 upstream reset Authorization: Bearer secretBearerToken123 cgw.abcdefghij.abcdefghijklmnopqrstuvwxyz123456 ${composedUnifiedKey} ${opaqueUnifiedKey} mev2_live_secret {"refresh_token":"jsonSecret123","password":"pwSecret123"}`
        }
      } as ThreadEvent
    ]);
    const adapter = createAdapter(new FakeClient(thread));
    const diagnostics: ProviderErrorDiagnostic[] = [];

    const events = await collect(
      adapter.message(
        messageInput({
          providerSessionRef: null,
          onProviderError: (diagnostic) => diagnostics.push(diagnostic)
        })
      )
    );

    expect(events).toEqual([
      {
        type: "error",
        code: "service_unavailable",
        message: "MedCode service is temporarily unavailable."
      }
    ]);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      source: "turn.failed",
      code: "service_unavailable",
      publicMessage: "MedCode service is temporarily unavailable.",
      rawName: "Error"
    });
    expect(diagnostics[0].rawMessage).toContain("HTTP 503 upstream reset");
    expect(diagnostics[0].rawMessage).toContain("Authorization=<redacted>");
    expect(diagnostics[0].rawMessage).toContain("cgw.<redacted>");
    expect(diagnostics[0].rawMessage).toContain("cmev1.<redacted>");
    expect(diagnostics[0].rawMessage).toContain("cgu_live_<redacted>");
    expect(diagnostics[0].rawMessage).toContain("mev2_live_<redacted>");
    expect(diagnostics[0].rawMessage).not.toContain(composedUnifiedKey);
    expect(diagnostics[0].rawMessage).not.toContain(opaqueUnifiedKey);
    expect(diagnostics[0].rawMessage).not.toContain("secretBearerToken123");
    expect(diagnostics[0].rawMessage).not.toContain("abcdefghijklmnopqrstuvwxyz123456");
    expect(diagnostics[0].rawMessage).not.toContain("mev2_live_secret");
    expect(diagnostics[0].rawMessage).not.toContain("jsonSecret123");
    expect(diagnostics[0].rawMessage).not.toContain("pwSecret123");
  });

  it("sanitizes item-level provider errors and stops the stream", async () => {
    const thread = new FakeThread(null, [
      { type: "thread.started", thread_id: "thread_1" },
      {
        type: "item.completed",
        item: {
          id: "err_1",
          type: "error",
          message: "Codex is not logged in to ChatGPT"
        }
      } as ThreadEvent,
      {
        type: "turn.completed",
        usage: {
          input_tokens: 1,
          cached_input_tokens: 0,
          output_tokens: 1,
          reasoning_output_tokens: 0
        }
      }
    ]);
    const adapter = createAdapter(new FakeClient(thread));

    const events = await collect(adapter.message(messageInput({ providerSessionRef: null })));

    expect(events).toEqual([
      {
        type: "error",
        code: "provider_reauth_required",
        message: "MedCode service requires administrator reauthorization."
      }
    ]);
    expect(JSON.stringify(events)).not.toContain("Codex");
    expect(JSON.stringify(events)).not.toContain("ChatGPT");
  });
});

function createAdapter(
  client: CodexClientLike,
  options: Partial<ConstructorParameters<typeof CodexProviderAdapter>[0]> = {}
) {
  return new CodexProviderAdapter({
    codexHome: mkdtempSync(path.join(tmpdir(), "codex-provider-test-")),
    makeClient: () => client,
    ...options
  });
}

function normalizeForTest(
  adapter: CodexProviderAdapter
): (err: unknown) => { code: string; message: string } {
  type TestableAdapter = {
    normalize(err: unknown): { code: string; message: string };
  };

  return (adapter as unknown as TestableAdapter).normalize.bind(adapter);
}

function messageInput(input: {
  providerSessionRef: string | null;
  onProviderError?: (diagnostic: ProviderErrorDiagnostic) => void;
}): MessageInput {
  return {
    upstreamAccount: upstreamAccount(),
    subject: subject(),
    scope: "code",
    session: session(input.providerSessionRef),
    message: "hello",
    onProviderError: input.onProviderError
  };
}

function upstreamAccount(): UpstreamAccount {
  return {
    id: "sub_1",
    provider: "openai-codex",
    label: "test",
    credentialRef: "codex-home",
    state: "active",
    lastUsedAt: null,
    cooldownUntil: null
  };
}

function subject(): Subject {
  return {
    id: "subject_1",
    label: "test",
    state: "active",
    createdAt: new Date("2026-01-01T00:00:00Z")
  };
}

function session(providerSessionRef: string | null): GatewaySession {
  return {
    id: "sess_1",
    subjectId: "subject_1",
    upstreamAccountId: "sub_1",
    providerSessionRef,
    title: null,
    state: "active",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z")
  };
}

async function* asyncGenerator<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) {
    yield item;
  }
}

async function collect<T>(input: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const item of input) {
    result.push(item);
  }
  return result;
}
