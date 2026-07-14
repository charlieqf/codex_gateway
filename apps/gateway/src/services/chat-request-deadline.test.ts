import { GatewayError } from "@codex-gateway/core";
import { describe, expect, it, vi } from "vitest";
import {
  createChatRequestDeadline,
  parseChatRequestTimeoutPolicy,
  resolveChatRequestTimeoutMs
} from "./chat-request-deadline.js";

describe("chat request deadline", () => {
  it("resolves model, runtime and default timeout precedence", () => {
    const policy = parseChatRequestTimeoutPolicy({
      MEDCODE_CHAT_REQUEST_TIMEOUT_MS: "1000",
      MEDCODE_CHAT_REQUEST_TIMEOUTS_JSON: JSON.stringify({
        defaultMs: 2000,
        runtimes: { codex: 3000 },
        models: { max: 4000 }
      })
    });
    expect(resolveChatRequestTimeoutMs(policy, "max", "codex")).toBe(4000);
    expect(resolveChatRequestTimeoutMs(policy, "fast", "codex")).toBe(3000);
    expect(resolveChatRequestTimeoutMs(policy, "fast", "openrouter")).toBe(2000);
  });

  it("falls back safely when JSON configuration is invalid", () => {
    const warnings: string[] = [];
    const policy = parseChatRequestTimeoutPolicy(
      {
        MEDCODE_CHAT_REQUEST_TIMEOUT_MS: "1500",
        MEDCODE_CHAT_REQUEST_TIMEOUTS_JSON: "[]"
      },
      (warning) => warnings.push(warning)
    );
    expect(policy.defaultMs).toBe(1500);
    expect(warnings).toHaveLength(1);
  });

  it("aborts with upstream_timeout after the configured deadline", async () => {
    vi.useFakeTimers();
    try {
      const deadline = createChatRequestDeadline({ timeoutMs: 500 });
      await vi.advanceTimersByTimeAsync(500);
      expect(deadline.signal.aborted).toBe(true);
      expect(deadline.signal.reason).toBeInstanceOf(GatewayError);
      expect((deadline.signal.reason as GatewayError).code).toBe("upstream_timeout");
      deadline.cleanup();
    } finally {
      vi.useRealTimers();
    }
  });

  it("propagates a parent abort reason and supports disabled deadlines", () => {
    const parent = new AbortController();
    const deadline = createChatRequestDeadline({ timeoutMs: 0, parentSignals: [parent.signal] });
    parent.abort("client_closed");
    expect(deadline.deadlineAt).toBeNull();
    expect(deadline.signal.reason).toBe("client_closed");
    deadline.cleanup();
  });
});
