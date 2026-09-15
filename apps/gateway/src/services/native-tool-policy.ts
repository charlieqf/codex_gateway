import { GatewayError } from "@codex-gateway/core";
import { type ChatCompletionRequest } from "../openai-compat.js";
import { type OutputTruncationMode } from "./provider-stream.js";
import type {
  NativeFileToolRecoveryPolicy,
  NativeToolForceRequiredMode,
  StrictClientToolsResult
} from "./client-tool-types.js";

interface NativeAutoToolRetryPlan {
  kind:
    | "auto_ack_to_required"
    | "auto_ack_to_auto"
    | "auto_ack_after_tool_to_auto"
    | "auto_empty_to_auto";
  toolChoice: ChatCompletionRequest["toolChoice"];
  prompt: string;
}

interface NativeValidationRetryPlan {
  kind: "validation_failed_to_same" | "validation_failed_to_auto";
  toolChoice: ChatCompletionRequest["toolChoice"];
  validationToolChoice: ChatCompletionRequest["toolChoice"];
  prompt: string;
}

export function nativeAutoToolRetryPlan(
  request: ChatCompletionRequest,
  upstreamModel: string,
  attemptedToolChoice: ChatCompletionRequest["toolChoice"],
  result: StrictClientToolsResult,
  prompt: string,
  forceRequiredMode: NativeToolForceRequiredMode
): NativeAutoToolRetryPlan | null {
  if (request.preserveAutoToolChoice) {
    return null;
  }
  const shouldRetry =
    request.toolChoice === "auto" &&
    attemptedToolChoice === "auto" &&
    result.toolCalls.length === 0;
  if (!shouldRetry) {
    return null;
  }

  if (looksLikeSilentNativeToolNoop(request, result.content)) {
    return {
      kind: "auto_empty_to_auto",
      toolChoice: "auto",
      prompt: nativeToolEmptyRetryPrompt(prompt)
    };
  }

  if (!looksLikeToolUseAcknowledgement(result.content)) {
    return null;
  }

  const completedToolRound = hasCompletedClientToolRound(request);
  // This safety invariant intentionally overrides legacy mode: legacy restores
  // the old initial-choice classifier for diagnostics, never the post-tool loop vector.
  if (completedToolRound) {
    return {
      kind: "auto_ack_after_tool_to_auto",
      toolChoice: "auto",
      prompt: nativePostToolAcknowledgementRetryPrompt(prompt)
    };
  }

  const shouldForceRequired =
    forceRequiredMode === "legacy" ||
    (forceRequiredMode === "first_step" &&
      shouldRequireNativeToolForFileGeneration(request, upstreamModel, forceRequiredMode));
  const shouldUseStrongAutoPrompt =
    usesAutoOnlyNativeTools(upstreamModel) && isFirstStepNativeFileGenerationTask(request);
  if (usesAutoOnlyNativeTools(upstreamModel) || !shouldForceRequired) {
    return {
      kind: "auto_ack_to_auto",
      toolChoice: "auto",
      prompt: shouldForceRequired || shouldUseStrongAutoPrompt
        ? nativeToolAcknowledgementRetryPrompt(prompt)
        : nativeAutoAcknowledgementRetryPrompt(prompt)
    };
  }
  return {
    kind: "auto_ack_to_required",
    toolChoice: "required",
    prompt
  };
}

export function nativeValidationRetryPlan(
  request: ChatCompletionRequest,
  upstreamModel: string,
  attemptedToolChoice: ChatCompletionRequest["toolChoice"],
  error: GatewayError,
  prompt: string
): NativeValidationRetryPlan | null {
  if (error.code !== "tool_call_validation_failed") {
    return null;
  }
  if (error.transformedRetryAllowed === false) return null;
  if (error.failureKind === "argument_budget_exceeded") {
    return null;
  }

  const retryToolChoice = usesAutoRetryNativeTools(upstreamModel)
    ? "auto"
    : attemptedToolChoice;
  return {
    kind: retryToolChoice === attemptedToolChoice
      ? "validation_failed_to_same"
      : "validation_failed_to_auto",
    toolChoice: retryToolChoice,
    validationToolChoice: attemptedToolChoice,
    prompt: nativeToolValidationRetryPrompt(prompt, error.message, attemptedToolChoice, request)
  };
}

export function parseNativeFileToolRecoveryPolicy(
  env: NodeJS.ProcessEnv,
  onWarning?: (message: string) => void
): NativeFileToolRecoveryPolicy {
  const rawMode = env.MEDCODE_NATIVE_FILE_TOOL_RECOVERY_MODE?.trim().toLowerCase();
  const mode: OutputTruncationMode =
    rawMode === "legacy" ||
    rawMode === "shadow" ||
    rawMode === "error" ||
    rawMode === "chunk"
      ? rawMode
      : "shadow";
  if (rawMode && mode === "shadow" && rawMode !== "shadow") {
    onWarning?.(
      `Invalid MEDCODE_NATIVE_FILE_TOOL_RECOVERY_MODE=${rawMode}; using shadow.`
    );
  }

  const softArgumentBytes = parseOptionalPositiveIntegerEnv(
    env.MEDCODE_NATIVE_FILE_TOOL_SOFT_ARGUMENT_BYTES,
    "MEDCODE_NATIVE_FILE_TOOL_SOFT_ARGUMENT_BYTES",
    onWarning
  ) ?? 64 * 1024;
  let hardArgumentBytes = parseOptionalPositiveIntegerEnv(
    env.MEDCODE_NATIVE_FILE_TOOL_HARD_ARGUMENT_BYTES,
    "MEDCODE_NATIVE_FILE_TOOL_HARD_ARGUMENT_BYTES",
    onWarning
  );
  if (hardArgumentBytes !== null && hardArgumentBytes < softArgumentBytes) {
    onWarning?.(
      "MEDCODE_NATIVE_FILE_TOOL_HARD_ARGUMENT_BYTES is below the soft byte candidate; ignoring the hard limit."
    );
    hardArgumentBytes = null;
  }

  const canaryPercent = parsePercentageEnv(
    env.MEDCODE_NATIVE_FILE_TOOL_RECOVERY_CANARY_PERCENT,
    "MEDCODE_NATIVE_FILE_TOOL_RECOVERY_CANARY_PERCENT",
    onWarning
  ) ?? 0;
  if (mode === "chunk" && canaryPercent > 0) {
    onWarning?.(
      "Active artifact chunk recovery is not implemented; chunk mode currently degrades to error."
    );
  }

  return {
    mode,
    softArgumentBytes,
    hardArgumentBytes,
    canaryPercent
  };
}

function parseOptionalPositiveIntegerEnv(
  value: string | undefined,
  name: string,
  onWarning?: (message: string) => void
): number | null {
  if (value === undefined || value.trim() === "") {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    onWarning?.(`Invalid ${name}=${value}; ignoring it.`);
    return null;
  }
  return parsed;
}

function parsePercentageEnv(
  value: string | undefined,
  name: string,
  onWarning?: (message: string) => void
): number | null {
  if (value === undefined || value.trim() === "") {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
    onWarning?.(`Invalid ${name}=${value}; using 0.`);
    return null;
  }
  return parsed;
}

export function parseNativeToolForceRequiredMode(
  value: string | undefined,
  onWarning?: (message: string) => void
): NativeToolForceRequiredMode {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized === "first_step") {
    return "first_step";
  }
  if (normalized === "disabled" || normalized === "legacy") {
    return normalized;
  }
  onWarning?.(
    `Invalid MEDCODE_NATIVE_TOOL_FORCE_REQUIRED_MODE=${value}; using first_step.`
  );
  return "first_step";
}

export function initialNativeToolChoice(
  request: ChatCompletionRequest,
  upstreamModel: string,
  forceRequiredMode: NativeToolForceRequiredMode
): ChatCompletionRequest["toolChoice"] {
  if (request.preserveAutoToolChoice) {
    return request.toolChoice;
  }
  return shouldRequireNativeToolForFileGeneration(request, upstreamModel, forceRequiredMode)
    ? "required"
    : request.toolChoice;
}

function shouldRequireNativeToolForFileGeneration(
  request: ChatCompletionRequest,
  upstreamModel: string,
  forceRequiredMode: NativeToolForceRequiredMode
): boolean {
  if (forceRequiredMode === "disabled") {
    return false;
  }
  if (request.toolChoice !== "auto" || !request.tools?.length) {
    return false;
  }
  if (usesAutoOnlyNativeTools(upstreamModel)) {
    return false;
  }
  if (!request.tools.some((tool) => looksLikeFileOrCodeTool(tool))) {
    return false;
  }
  if (forceRequiredMode === "legacy") {
    return looksLikeLegacyFileGenerationTask(request);
  }
  return isFirstStepNativeFileGenerationTask(request);
}

function isFirstStepNativeFileGenerationTask(request: ChatCompletionRequest): boolean {
  return (
    request.toolChoice === "auto" &&
    request.tools?.some((tool) => looksLikeFileOrCodeTool(tool)) === true &&
    !hasCompletedClientToolRound(request) &&
    looksLikeFileGenerationTask(request)
  );
}

function looksLikeSilentNativeToolNoop(request: ChatCompletionRequest, content: string): boolean {
  return (
    content.trim().length === 0 &&
    request.tools?.some((tool) => looksLikeFileOrCodeTool(tool)) === true &&
    looksLikeFileGenerationTask(request)
  );
}

const modelsWithAutoOnlyNativeTools = new Set(["glm-5-turbo"]);

const modelsWithAutoRetryNativeTools = new Set(["glm-5.2", "glm-5-turbo"]);

function usesAutoOnlyNativeTools(upstreamModel: string): boolean {
  return modelsWithAutoOnlyNativeTools.has(normalizedNativeToolModelName(upstreamModel));
}

function usesAutoRetryNativeTools(upstreamModel: string): boolean {
  return modelsWithAutoRetryNativeTools.has(normalizedNativeToolModelName(upstreamModel));
}

function normalizedNativeToolModelName(upstreamModel: string): string {
  return upstreamModel.toLowerCase().split("/").pop() ?? upstreamModel.toLowerCase();
}

function nativeToolAcknowledgementRetryPrompt(prompt: string): string {
  return [
    prompt,
    "",
    "The previous assistant output only acknowledged the task. Complete the user's requested task now by calling one of the client-declared tools. Do not send another acknowledgement or plain-text description."
  ].join("\n");
}

function nativeAutoAcknowledgementRetryPrompt(prompt: string): string {
  return [
    prompt,
    "",
    "The previous assistant output only acknowledged the task. Do not send another acknowledgement.",
    "If a client-declared tool is genuinely needed, call it now; otherwise provide the final answer now."
  ].join("\n");
}

function nativePostToolAcknowledgementRetryPrompt(prompt: string): string {
  return [
    prompt,
    "",
    "The previous assistant output only acknowledged the task after client tools had already run. Do not send another acknowledgement.",
    "If another client-declared tool call is genuinely needed, call it now; otherwise provide the final answer now using the available tool results."
  ].join("\n");
}

function nativeToolEmptyRetryPrompt(prompt: string): string {
  return [
    prompt,
    "",
    "The previous assistant output was empty and did not call any client-declared tool.",
    "Complete the user's requested file or artifact task now by calling one of the client-declared tools.",
    "Do not return an empty message or a plain-text acknowledgement."
  ].join("\n");
}

function nativeToolValidationRetryPrompt(
  prompt: string,
  validationError: string,
  validationToolChoice: ChatCompletionRequest["toolChoice"],
  request: ChatCompletionRequest
): string {
  return [
    prompt,
    "",
    "The previous assistant tool response was rejected by the gateway.",
    nativeToolValidationRetryInstruction(validationToolChoice, request),
    "Use only client-declared tool names and make the arguments satisfy the selected tool's JSON Schema.",
    "Do not answer in plain text when a tool call is required.",
    "",
    "<validation_error>",
    validationError,
    "</validation_error>"
  ].join("\n");
}

function nativeToolValidationRetryInstruction(
  toolChoice: ChatCompletionRequest["toolChoice"],
  request: ChatCompletionRequest
): string {
  if (toolChoice === "required") {
    return "Call at least one client-declared tool now.";
  }
  const forcedToolName = typeof toolChoice === "object" ? toolChoice.function.name : null;
  if (forcedToolName) {
    return `Call the client-declared tool named ${forcedToolName} now.`;
  }
  if (request.tools?.some((tool) => looksLikeFileOrCodeTool(tool)) && looksLikeFileGenerationTask(request)) {
    return "Complete the requested file or artifact task by calling a valid client-declared tool now.";
  }
  return "If you call a tool, call a valid client-declared tool with schema-valid arguments.";
}

function looksLikeFileOrCodeTool(tool: NonNullable<ChatCompletionRequest["tools"]>[number]): boolean {
  const name = tool.function.name.toLowerCase();
  const description = tool.function.description?.toLowerCase() ?? "";
  return /(^|[_-])(write|edit|create|save|patch|apply|replace)([_-]|$)/.test(name) ||
    /\b(file|fs|workspace|code)\b/.test(name) ||
    /\b(write|edit|create|save|patch|replace).{0,40}\b(file|workspace|code)\b/.test(description);
}

function hasCompletedClientToolRound(request: ChatCompletionRequest): boolean {
  return request.messages.some(
    (message) =>
      message.role === "tool" ||
      (message.role === "assistant" && (message.tool_calls?.length ?? 0) > 0)
  );
}

function latestUserText(request: ChatCompletionRequest): string {
  for (let index = request.messages.length - 1; index >= 0; index -= 1) {
    const message = request.messages[index];
    if (message?.role === "user" && typeof message.content === "string") {
      return message.content;
    }
  }
  return "";
}

function looksLikeLegacyFileGenerationTask(request: ChatCompletionRequest): boolean {
  const text = request.messages
    .map((message) => (typeof message.content === "string" ? message.content : ""))
    .join("\n")
    .toLowerCase();
  return looksLikeFileGenerationText(text);
}

function looksLikeFileGenerationTask(request: ChatCompletionRequest): boolean {
  return looksLikeFileGenerationText(latestUserText(request).toLowerCase());
}

function looksLikeFileGenerationText(text: string): boolean {
  if (!text.trim()) {
    return false;
  }
  return /(<html|html|javascript|css|代码|页面|文件|成品|互动|动画|超链接|跳转|\bcode\b|\bfile\b|\bpage\b|\bapp\b|\bcomponent\b)/i.test(text) &&
    /(写|创建|生成|做|给我|\u66f4\u6539|\u4fee\u6539|\u8c03\u6574|\u4fee\u590d|build|create|generate|write|make|update|change|edit|fix)/i.test(text);
}

function looksLikeToolUseAcknowledgement(content: string): boolean {
  const normalized = content.trim().toLowerCase();
  if (!normalized || normalized.length > 180) {
    return false;
  }

  return [
    /^i(?:'| a)m\s+(?:going\s+to\s+)?(?:create|write|build|generate|make)\b/,
    /^i\s+will\s+(?:create|write|build|generate|make)\b/,
    /^i(?:'| wi)ll\s+(?:create|write|build|generate|make)\b/,
    /^let\s+me\s+(?:create|write|build|generate|make)\b/,
    /^sure[,.\s]+i(?:'| wi)ll\s+(?:create|write|build|generate|make)\b/,
    /^ok(?:ay)?[,.\s]+i(?:'| wi)ll\s+(?:create|write|build|generate|make)\b/,
    /^(?:\u6211\u6765|\u6211\u73b0\u5728|\u597d\u7684[,\uFF0C]?\u6211\u6765)/
  ].some((pattern) => pattern.test(normalized));
}
