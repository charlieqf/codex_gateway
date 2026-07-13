import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ThreadEvent, ThreadOptions, TurnOptions } from "@openai/codex-sdk";
import { describe, expect, it } from "vitest";
import {
  CodexProviderAdapter,
  cleanupStaleCodexRuntimeStateDirs,
  type CodexClientFactoryInput,
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

describe("cleanupStaleCodexRuntimeStateDirs", () => {
  it("removes only stale Gateway runtime-state directories", () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), "codex-runtime-cleanup-test-"));
    const nowMs = Date.UTC(2026, 6, 13, 10, 0, 0);
    const currentPidDir = path.join(rootDir, "codex-gateway-state-4242-Ab12Cd");
    const deadPidDir = path.join(rootDir, "codex-gateway-state-6000-Ef34Gh");
    const activePidDir = path.join(rootDir, "codex-gateway-state-5000-Ij56Kl");
    const oldLegacyDir = path.join(rootDir, "codex-gateway-state-Mn78Op");
    const freshLegacyDir = path.join(rootDir, "codex-gateway-state-Qr90St");
    const unsafeNameDir = path.join(rootDir, "codex-gateway-state-not-a-runtime-dir");
    const matchingFile = path.join(rootDir, "codex-gateway-state-7000-Uv12Wx");
    const unrelatedDir = path.join(rootDir, "other-app-state-Ab12Cd");

    try {
      for (const directory of [
        currentPidDir,
        deadPidDir,
        activePidDir,
        oldLegacyDir,
        freshLegacyDir,
        unsafeNameDir,
        unrelatedDir
      ]) {
        mkdirSync(directory);
      }
      writeFileSync(matchingFile, "not a directory");
      const oldDate = new Date(nowMs - 2 * 60 * 60 * 1000);
      utimesSync(oldLegacyDir, oldDate, oldDate);

      const report = cleanupStaleCodexRuntimeStateDirs({
        rootDir,
        currentPid: 4242,
        nowMs,
        legacyMinAgeMs: 60 * 60 * 1000,
        isProcessAlive: (pid) => pid === 5000
      });

      expect(report).toEqual({
        removed: 3,
        skippedActive: 1,
        skippedFreshLegacy: 1,
        skippedUnsafe: 2,
        errors: 0
      });
      expect(existsSync(currentPidDir)).toBe(false);
      expect(existsSync(deadPidDir)).toBe(false);
      expect(existsSync(oldLegacyDir)).toBe(false);
      expect(existsSync(activePidDir)).toBe(true);
      expect(existsSync(freshLegacyDir)).toBe(true);
      expect(existsSync(unsafeNameDir)).toBe(true);
      expect(existsSync(matchingFile)).toBe(true);
      expect(existsSync(unrelatedDir)).toBe(true);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});

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

  it("isolates and removes Codex state for stateless gateway turns", async () => {
    const client = new FakeClient(new FakeThread(null, []));
    let factoryInput: CodexClientFactoryInput | null = null;
    const adapter = new CodexProviderAdapter({
      codexHome: mkdtempSync(path.join(tmpdir(), "codex-provider-test-")),
      codexPath: "/usr/local/bin/codex-gateway-exec",
      makeClient: (input) => {
        factoryInput = input;
        return client;
      }
    });

    await collect(
      adapter.message(
        messageInput({ providerSessionRef: null, sessionId: "sess_stateless_test" })
      )
    );

    expect(factoryInput).not.toBeNull();
    const captured = factoryInput as unknown as CodexClientFactoryInput;
    expect(captured.codexPath).toBe("/usr/local/bin/codex-gateway-exec");
    expect(captured.env?.CODEX_GATEWAY_EPHEMERAL).toBe("1");
    const sqliteHome = (captured.config as Record<string, unknown>)?.sqlite_home;
    expect(typeof sqliteHome).toBe("string");
    expect(path.basename(String(sqliteHome))).toMatch(
      new RegExp(`^codex-gateway-state-${process.pid}-[A-Za-z0-9]{6}$`)
    );
    expect(existsSync(String(sqliteHome))).toBe(false);
  });

  it("keeps persistent Codex state available for resumable gateway sessions", async () => {
    const client = new FakeClient(new FakeThread("thread_existing", []));
    let factoryInput: CodexClientFactoryInput | null = null;
    const adapter = new CodexProviderAdapter({
      codexHome: mkdtempSync(path.join(tmpdir(), "codex-provider-test-")),
      makeClient: (input) => {
        factoryInput = input;
        return client;
      }
    });

    await collect(adapter.message(messageInput({ providerSessionRef: "thread_existing" })));

    const captured = factoryInput as unknown as CodexClientFactoryInput;
    expect(captured.env?.CODEX_GATEWAY_EPHEMERAL).toBeUndefined();
    expect(captured.config).toBeUndefined();
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

  it("lets request-level reasoning effort override the configured Codex default", async () => {
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

    await collect(
      adapter.message(
        messageInput({
          providerSessionRef: null,
          reasoningEffort: "low"
        })
      )
    );

    expect(client.startedOptions[0]).toMatchObject({
      model: "gpt-5.5",
      modelReasoningEffort: "low"
    });
  });

  it("keeps configured Codex reasoning effort when the request does not override it", async () => {
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

  it("maps minimal reasoning requests to Codex none effort", async () => {
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
    const factoryInputs: CodexClientFactoryInput[] = [];
    const adapter = new CodexProviderAdapter({
      codexHome: mkdtempSync(path.join(tmpdir(), "codex-provider-test-")),
      makeClient: (input) => {
        factoryInputs.push(input);
        return client;
      },
      model: "gpt-5.5",
      modelReasoningEffort: "high"
    });

    await collect(
      adapter.message(
        messageInput({
          providerSessionRef: null,
          reasoningEffort: "minimal"
        })
      )
    );

    expect(factoryInputs[0]?.config).toEqual({
      model_reasoning_effort: "none",
      features: {
        image_generation: false
      }
    });
    expect(client.startedOptions[0]).toMatchObject({
      model: "gpt-5.5"
    });
    expect(client.startedOptions[0]?.modelReasoningEffort).toBeUndefined();
  });

  it("keeps Codex client config unchanged when reasoning effort is not minimal", async () => {
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
    const factoryInputs: CodexClientFactoryInput[] = [];
    const adapter = new CodexProviderAdapter({
      codexHome: mkdtempSync(path.join(tmpdir(), "codex-provider-test-")),
      makeClient: (input) => {
        factoryInputs.push(input);
        return client;
      },
      model: "gpt-5.5",
      modelReasoningEffort: "high"
    });

    await collect(
      adapter.message(
        messageInput({
          providerSessionRef: null,
          reasoningEffort: "low"
        })
      )
    );

    expect(factoryInputs[0]?.config).toBeUndefined();
    expect(client.startedOptions[0]).toMatchObject({
      model: "gpt-5.5",
      modelReasoningEffort: "low"
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
    expect(
      normalize(
        new Error(
          "Codex ran out of room in the model's context window. Start a new thread or clear earlier history before retrying."
        )
      )
    ).toMatchObject({
      code: "context_length_exceeded",
      message:
        "Current conversation or attached files are too large. Start a new conversation, split large PDFs/files, or clear earlier history before retrying."
    });
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

  it("reports context window overflows as structured provider errors", async () => {
    const thread = new FakeThread(null, [
      {
        type: "error",
        message:
          "Codex ran out of room in the model's context window. Start a new thread or clear earlier history before retrying."
      } as ThreadEvent
    ]);
    const diagnostics: ProviderErrorDiagnostic[] = [];
    const adapter = createAdapter(new FakeClient(thread));

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
        code: "context_length_exceeded",
        message:
          "Current conversation or attached files are too large. Start a new conversation, split large PDFs/files, or clear earlier history before retrying."
      }
    ]);
    expect(diagnostics[0]).toMatchObject({
      source: "stream.error",
      code: "context_length_exceeded",
      publicMessage:
        "Current conversation or attached files are too large. Start a new conversation, split large PDFs/files, or clear earlier history before retrying.",
      rawMessage:
        "Codex ran out of room in the model's context window. Start a new thread or clear earlier history before retrying."
    });
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
  sessionId?: string;
  reasoningEffort?: string | null;
  onProviderError?: (diagnostic: ProviderErrorDiagnostic) => void;
}): MessageInput {
  return {
    upstreamAccount: upstreamAccount(),
    subject: subject(),
    scope: "code",
    session: session(input.providerSessionRef, input.sessionId),
    message: "hello",
    reasoningEffort: input.reasoningEffort,
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

function session(providerSessionRef: string | null, sessionId = "sess_1"): GatewaySession {
  return {
    id: sessionId,
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
