import type { RequestEventRecord } from "@codex-gateway/core";
import { describe, expect, it } from "vitest";
import {
  assessToolLoopShadow,
  parseToolLoopShadowPolicy,
  toolLoopGuardAssessed,
  toolLoopGuardAssessmentFailed,
  toolLoopGuardNotAssessed
} from "./tool-loop-shadow.js";

describe("tool loop shadow", () => {
  it("uses reviewed shadow defaults and rejects unsafe threshold ordering", () => {
    const warnings: string[] = [];
    const policy = parseToolLoopShadowPolicy(
      {
        MEDCODE_TOOL_LOOP_WARNING_CALLS: "20",
        MEDCODE_TOOL_LOOP_HARD_CALLS: "10",
        MEDCODE_TOOL_LOOP_PROMPT_WARNING_TOKENS: "130000",
        MEDCODE_TOOL_LOOP_PROMPT_HARD_TOKENS: "120000"
      },
      (warning) => warnings.push(warning)
    );
    expect(policy).toMatchObject({
      mode: "shadow",
      warningCalls: 20,
      hardCalls: 21,
      promptWarningTokens: 130_000,
      promptHardTokens: 130_001,
      maxElapsedMs: 600_000
    });
    expect(warnings).toHaveLength(2);
  });

  it("preserves the operator's original invalid mode value in warnings", () => {
    const warnings: string[] = [];
    expect(
      parseToolLoopShadowPolicy(
        { MEDCODE_TOOL_LOOP_GUARD_MODE: "EnFoRcE" },
        (warning) => warnings.push(warning)
      ).mode
    ).toBe("shadow");
    expect(warnings).toEqual([
      "Invalid MEDCODE_TOOL_LOOP_GUARD_MODE=EnFoRcE; using shadow."
    ]);
  });

  it("counts only the newest consecutive successful tool-call events for the same model", () => {
    const now = new Date("2026-07-14T02:20:00.000Z");
    const policy = parseToolLoopShadowPolicy({});
    const events = [
      event("current-7", "tool_calls", new Date("2026-07-14T02:11:00.000Z")),
      event("current-6", "tool_calls", new Date("2026-07-14T02:10:00.000Z")),
      event("stop", "stop", new Date("2026-07-14T02:09:00.000Z")),
      event("ignored-old", "tool_calls", new Date("2026-07-14T02:08:00.000Z"))
    ];

    expect(
      assessToolLoopShadow({ events, publicModelId: "expert", now, promptTokens: 121_000, policy })
    ).toEqual({
      priorConsecutiveToolCalls: 2,
      candidateCallCount: 3,
      elapsedMs: 600_000,
      promptTokens: 121_000,
      warningReasons: ["prompt_tokens"],
      hardReasons: ["elapsed", "prompt_tokens"],
      wouldWarn: true,
      wouldFinalize: true
    });
  });

  it("marks the candidate eighth and twelfth calls without enforcing either", () => {
    const now = new Date("2026-07-14T02:20:00.000Z");
    const policy = parseToolLoopShadowPolicy({});
    const seven = Array.from({ length: 7 }, (_, index) =>
      event(`req-${index}`, "tool_calls", new Date(now.getTime() - index * 1000))
    );
    const eleven = Array.from({ length: 11 }, (_, index) =>
      event(`req-hard-${index}`, "tool_calls", new Date(now.getTime() - index * 1000))
    );

    expect(
      assessToolLoopShadow({ events: seven, publicModelId: "expert", now, promptTokens: 100, policy })
    ).toMatchObject({ candidateCallCount: 8, wouldWarn: true, wouldFinalize: false });
    expect(
      assessToolLoopShadow({ events: eleven, publicModelId: "expert", now, promptTokens: 100, policy })
    ).toMatchObject({ candidateCallCount: 12, wouldWarn: true, wouldFinalize: true });
  });

  it("emits versioned diagnostics for assessed and unassessed requests", () => {
    const policy = parseToolLoopShadowPolicy({});
    const assessment = assessToolLoopShadow({
      events: [],
      publicModelId: "expert",
      now: new Date("2026-07-14T02:20:00.000Z"),
      promptTokens: 121_000,
      policy
    });

    expect(toolLoopGuardAssessed(policy, assessment)).toMatchObject({
      policyVersion: "tool_loop_shadow_v1",
      assessmentStatus: "assessed",
      decision: "shadow_finalize",
      candidateCallCount: 1,
      hardReasons: ["prompt_tokens"]
    });
    expect(toolLoopGuardNotAssessed(policy, "client_turn_id_unavailable")).toMatchObject({
      assessmentStatus: "not_assessed",
      assessmentReason: "client_turn_id_unavailable",
      decision: "not_assessed"
    });
    expect(toolLoopGuardAssessmentFailed(policy)).toMatchObject({
      assessmentStatus: "failed",
      assessmentReason: "assessment_error",
      decision: "assessment_failed"
    });
  });
});

function event(
  requestId: string,
  finishReason: string,
  startedAt: Date
): RequestEventRecord {
  return {
    requestId,
    credentialId: "cred-1",
    subjectId: "subject-1",
    scope: "code",
    sessionId: null,
    upstreamAccountId: "account-1",
    provider: "openrouter",
    publicModelId: "expert",
    upstreamRuntime: "openrouter",
    upstreamModel: "z-ai/glm-5.2",
    clientTurnId: "msg-1",
    startedAt,
    durationMs: 1000,
    firstByteMs: 500,
    status: "ok",
    errorCode: null,
    rateLimited: false,
    upstreamFinishReason: finishReason,
    upstreamToolCallCount: finishReason === "tool_calls" ? 1 : 0
  };
}
