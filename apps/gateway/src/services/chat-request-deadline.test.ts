import { GatewayError } from "@codex-gateway/core";
import { describe, expect, it, vi } from "vitest";
import {
  createChatRequestDeadline,
  parseRequestedChatRequestTimeoutMs,
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
    expect(resolveChatRequestTimeoutMs(policy, "max", "codex", 3500)).toBe(3500);
    expect(resolveChatRequestTimeoutMs(policy, "max", "codex", 4500)).toBe(4000);
    expect(resolveChatRequestTimeoutMs(policy, "fast", "codex")).toBe(3000);
    expect(resolveChatRequestTimeoutMs(policy, "fast", "openrouter")).toBe(2000);
    expect(
      resolveChatRequestTimeoutMs(
        { defaultMs: 0, runtimes: {}, models: {} },
        "fast",
        "openrouter",
        1700
      )
    ).toBe(1700);
  });

  it("validates the per-call upper-bound header", () => {
    expect(parseRequestedChatRequestTimeoutMs(undefined)).toBeNull();
    expect(parseRequestedChatRequestTimeoutMs("170000")).toBe(170000);
    expect(parseRequestedChatRequestTimeoutMs("900000")).toBe(900000);
    expect(parseRequestedChatRequestTimeoutMs("1")).toBe(1);
    expect(parseRequestedChatRequestTimeoutMs("0")).toBeInstanceOf(GatewayError);
    expect(parseRequestedChatRequestTimeoutMs("900001")).toBe(900001);
    expect(parseRequestedChatRequestTimeoutMs("1800000")).toBe(1800000);
    expect(parseRequestedChatRequestTimeoutMs("1800001")).toBeInstanceOf(GatewayError);
    expect(parseRequestedChatRequestTimeoutMs(["1000", "2000"])).toBeInstanceOf(
      GatewayError
    );
  });

  it.each(["goldencode", "goldencode-d"])("uses configured 30-minute budgets for %s while honoring shorter callers", model => {
    const policy = parseChatRequestTimeoutPolicy({ MEDCODE_CHAT_REQUEST_TIMEOUT_MS: "600000",
      MEDCODE_CHAT_REQUEST_TIMEOUTS_JSON: JSON.stringify({ models: { goldencode: 1800000, "goldencode-d": 1800000 } }) });
    expect(resolveChatRequestTimeoutMs(policy, model, "tiankuan")).toBe(1800000);
    expect(resolveChatRequestTimeoutMs(policy, model, "tiankuan", 1800000)).toBe(1800000);
    expect(resolveChatRequestTimeoutMs(policy, model, "tiankuan", 900000)).toBe(900000);
    expect(resolveChatRequestTimeoutMs(policy, model, "tiankuan", 120000)).toBe(120000);
    expect(resolveChatRequestTimeoutMs(policy, "other", "tiankuan", 1800000)).toBe(600000);
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
    const deadline = createChatRequestDeadline({ timeoutMs: 900_000 });
    try {
      await vi.advanceTimersByTimeAsync(650_000);
      expect(deadline.signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(249_999);
      expect(deadline.signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(deadline.signal.aborted).toBe(true);
      expect(deadline.signal.reason).toBeInstanceOf(GatewayError);
      expect((deadline.signal.reason as GatewayError).code).toBe("upstream_timeout");
    } finally {
      deadline.cleanup();
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
