import type { RequestEventRecord } from "@codex-gateway/core";

export interface ToolLoopShadowPolicy {
  mode: "disabled" | "shadow";
  warningCalls: number;
  hardCalls: number;
  maxElapsedMs: number;
  promptWarningTokens: number;
  promptHardTokens: number;
  historyLimit: number;
}

export interface ToolLoopShadowAssessment {
  priorConsecutiveToolCalls: number;
  candidateCallCount: number;
  elapsedMs: number;
  promptTokens: number;
  warningReasons: Array<"calls" | "prompt_tokens">;
  hardReasons: Array<"calls" | "elapsed" | "prompt_tokens">;
  wouldWarn: boolean;
  wouldFinalize: boolean;
}

const defaults: ToolLoopShadowPolicy = {
  mode: "shadow",
  warningCalls: 8,
  hardCalls: 12,
  maxElapsedMs: 600_000,
  promptWarningTokens: 100_000,
  promptHardTokens: 120_000,
  historyLimit: 64
};

export function parseToolLoopShadowPolicy(
  env: NodeJS.ProcessEnv,
  onWarning?: (message: string) => void
): ToolLoopShadowPolicy {
  const rawModeInput = env.MEDCODE_TOOL_LOOP_GUARD_MODE?.trim();
  const rawMode = rawModeInput?.toLowerCase();
  const mode = rawMode === "disabled" || rawMode === "shadow"
    ? rawMode
    : defaults.mode;
  if (rawMode && rawMode !== "disabled" && rawMode !== "shadow") {
    onWarning?.(`Invalid MEDCODE_TOOL_LOOP_GUARD_MODE=${rawModeInput}; using shadow.`);
  }

  const policy = {
    mode,
    warningCalls: positiveInteger(
      env.MEDCODE_TOOL_LOOP_WARNING_CALLS,
      defaults.warningCalls,
      "MEDCODE_TOOL_LOOP_WARNING_CALLS",
      onWarning
    ),
    hardCalls: positiveInteger(
      env.MEDCODE_TOOL_LOOP_HARD_CALLS,
      defaults.hardCalls,
      "MEDCODE_TOOL_LOOP_HARD_CALLS",
      onWarning
    ),
    maxElapsedMs: positiveInteger(
      env.MEDCODE_TOOL_LOOP_MAX_ELAPSED_MS,
      defaults.maxElapsedMs,
      "MEDCODE_TOOL_LOOP_MAX_ELAPSED_MS",
      onWarning
    ),
    promptWarningTokens: positiveInteger(
      env.MEDCODE_TOOL_LOOP_PROMPT_WARNING_TOKENS,
      defaults.promptWarningTokens,
      "MEDCODE_TOOL_LOOP_PROMPT_WARNING_TOKENS",
      onWarning
    ),
    promptHardTokens: positiveInteger(
      env.MEDCODE_TOOL_LOOP_PROMPT_HARD_TOKENS,
      defaults.promptHardTokens,
      "MEDCODE_TOOL_LOOP_PROMPT_HARD_TOKENS",
      onWarning
    ),
    historyLimit: defaults.historyLimit
  } satisfies ToolLoopShadowPolicy;

  if (policy.hardCalls <= policy.warningCalls) {
    onWarning?.("MEDCODE_TOOL_LOOP_HARD_CALLS must exceed the warning threshold; using 12.");
    policy.hardCalls = Math.max(defaults.hardCalls, policy.warningCalls + 1);
  }
  if (policy.promptHardTokens <= policy.promptWarningTokens) {
    onWarning?.(
      "MEDCODE_TOOL_LOOP_PROMPT_HARD_TOKENS must exceed the warning threshold; using 120000."
    );
    policy.promptHardTokens = Math.max(
      defaults.promptHardTokens,
      policy.promptWarningTokens + 1
    );
  }
  return policy;
}

export function assessToolLoopShadow(input: {
  events: RequestEventRecord[];
  publicModelId: string;
  now: Date;
  promptTokens: number;
  policy: ToolLoopShadowPolicy;
}): ToolLoopShadowAssessment {
  let priorConsecutiveToolCalls = 0;
  let earliestStartedAt = input.now;

  const newestFirst = [...input.events].sort(
    (left, right) => right.startedAt.getTime() - left.startedAt.getTime()
  );
  for (const event of newestFirst) {
    if (event.publicModelId !== input.publicModelId) {
      break;
    }
    if (
      event.status !== "ok" ||
      event.upstreamFinishReason !== "tool_calls" ||
      (event.upstreamToolCallCount ?? 0) <= 0
    ) {
      break;
    }
    priorConsecutiveToolCalls += 1;
    if (event.startedAt < earliestStartedAt) {
      earliestStartedAt = event.startedAt;
    }
  }

  const candidateCallCount = priorConsecutiveToolCalls + 1;
  const elapsedMs = priorConsecutiveToolCalls > 0
    ? Math.max(0, input.now.getTime() - earliestStartedAt.getTime())
    : 0;
  const promptTokens = Math.max(0, Math.floor(input.promptTokens));
  const warningReasons: ToolLoopShadowAssessment["warningReasons"] = [];
  const hardReasons: ToolLoopShadowAssessment["hardReasons"] = [];

  if (candidateCallCount >= input.policy.warningCalls) {
    warningReasons.push("calls");
  }
  if (promptTokens >= input.policy.promptWarningTokens) {
    warningReasons.push("prompt_tokens");
  }
  if (candidateCallCount >= input.policy.hardCalls) {
    hardReasons.push("calls");
  }
  if (elapsedMs >= input.policy.maxElapsedMs) {
    hardReasons.push("elapsed");
  }
  if (promptTokens >= input.policy.promptHardTokens) {
    hardReasons.push("prompt_tokens");
  }

  return {
    priorConsecutiveToolCalls,
    candidateCallCount,
    elapsedMs,
    promptTokens,
    warningReasons,
    hardReasons,
    wouldWarn: warningReasons.length > 0 || hardReasons.length > 0,
    wouldFinalize: hardReasons.length > 0
  };
}

function positiveInteger(
  value: string | undefined,
  fallback: number,
  name: string,
  onWarning?: (message: string) => void
): number {
  if (!value?.trim()) {
    return fallback;
  }
  const parsed = Number(value);
  if (Number.isSafeInteger(parsed) && parsed > 0) {
    return parsed;
  }
  onWarning?.(`Invalid ${name}=${value}; using ${fallback}.`);
  return fallback;
}
