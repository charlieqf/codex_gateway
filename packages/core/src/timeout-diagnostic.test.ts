import { describe, expect, it } from "vitest";
import { diagnoseTimeout } from "./timeout-diagnostic.js";

const attempt = {
  errorCode: "upstream_timeout", durationMs: 600003, contentChars: 0, toolCallCount: 0,
  finishReason: null,
  failure: { origin: "gateway", kind: "deadline_exceeded", stage: "streaming" },
  streamProgress: { responseBytes: 1635207, firstResponseByteMs: 1563, lastResponseByteMs: 599965,
    reasoningChars: 59629, observedToolCallCount: 0, toolArgumentBytes: 0 }
};

describe("timeout diagnostics", () => {
  it("distinguishes the first-output budget from the original request deadline", () => {
    expect(diagnoseTimeout({ errorCode: "upstream_timeout", terminalSource: "gateway_output_budget", attempts: [attempt] }))
      .toMatchObject({ trigger: "gateway_output_budget", phase: "reasoning_only" });
  });
  it("does not infer a timeout phase or transport cause without supporting evidence", () => {
    expect(diagnoseTimeout({ errorCode: "upstream_timeout", attempts: [{
      errorCode: "upstream_timeout", streamProgress: { responseBytes: 0 }
    }] })?.phase).toBe("unknown");
    for (const code of ["ECONNREFUSED", null]) {
      expect(diagnoseTimeout({ errorCode: "upstream_timeout", attempts: [{
        errorCode: "upstream_timeout", failure: { kind: "connect", stage: "before_headers", transportCode: code }
      }] })?.trigger).toBe("unknown");
    }
    expect(diagnoseTimeout({ errorCode: "upstream_timeout", attempts: [{
      errorCode: "upstream_timeout", failure: { kind: "connect", transportCode: "UND_ERR_CONNECT_TIMEOUT" }
    }] })?.trigger).toBe("connect_timeout");
    expect(diagnoseTimeout({ errorCode: "upstream_timeout", attempts: [{ ...attempt,
      streamProgress: { ...attempt.streamProgress, reasoningChars: 0, toolArgumentBytes: 12 }
    }] })?.phase).toBe("unknown");
  });

  it("explains the two incident shapes without equating upstream bytes with delivery", () => {
    expect(diagnoseTimeout({ errorCode: "upstream_timeout", terminalSource: "gateway_deadline", attempts: [attempt] }))
      .toMatchObject({ trigger: "gateway_deadline", phase: "reasoning_only", activity: "recent_bytes",
        first_upstream_byte_ms: 1563, last_byte_gap_ms: 38, client_delivery: "unknown" });
    expect(diagnoseTimeout({ errorCode: "upstream_timeout", terminalSource: "gateway_deadline", attempts: [{
      ...attempt, contentChars: 81, streamProgress: { ...attempt.streamProgress,
        observedToolCallCount: 1, toolArgumentBytes: 9358 }
    }] })).toMatchObject({ phase: "tool_arguments_incomplete" });
  });

  it("distinguishes a body read timeout and does not call a silent body a connection failure", () => {
    expect(diagnoseTimeout({ errorCode: "upstream_timeout", attempts: [{ ...attempt,
      failure: { ...attempt.failure, kind: "body_timeout" },
      streamProgress: { ...attempt.streamProgress, lastResponseByteMs: 10000 }
    }] })).toMatchObject({ trigger: "body_timeout", activity: "no_recent_bytes" });
    expect(diagnoseTimeout({ errorCode: "upstream_timeout", attempts: [{ ...attempt,
      streamProgress: { ...attempt.streamProgress, responseBytes: 0 }
    }] })).toMatchObject({ phase: "awaiting_body" });
  });

  it("retains uncertainty for old, malformed and recovered-attempt records", () => {
    for (const attempts of [null, {}, [null], [{ ...attempt, errorCode: null }],
      [attempt, { errorCode: "upstream_timeout" }]]) {
      expect(diagnoseTimeout({ errorCode: "upstream_timeout", attempts }))
        .toMatchObject({ trigger: "unknown", phase: "unknown", activity: "unknown" });
    }
    expect(diagnoseTimeout({ errorCode: "client_aborted", attempts: [attempt] })).toBeNull();
    expect(diagnoseTimeout({ errorCode: null, attempts: [attempt] })).toBeNull();
  });

  it("does not describe heartbeat bytes as reasoning or return payload fields", () => {
    const result = diagnoseTimeout({ errorCode: "upstream_timeout", attempts: [{ ...attempt,
      prompt: "private sentinel", streamProgress: { ...attempt.streamProgress, reasoningChars: 0 }
    }] });
    expect(result?.phase).toBe("stream_without_semantic_output");
    expect(JSON.stringify(result)).not.toContain("private sentinel");
  });
});
