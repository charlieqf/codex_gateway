import { GatewayError } from "@codex-gateway/core";
import {
  chatMessagesToStrictToolRepairPrompt,
  openAIUsageFromTokenUsage,
  parseStrictToolDecision,
  type ChatCompletionRequest,
  type OpenAIChatUsage,
  type StrictToolDecision
} from "../openai-compat.js";
import {
  attachProviderStreamSummary,
  combineProviderStreamSummaries,
  collectProviderMessage,
  providerCompletionError,
  providerStreamSummaryFromError,
  type CollectedProviderMessage,
  type ProviderStreamSummary
} from "./provider-stream.js";
import type { StrictClientToolsInput, StrictClientToolsResult } from "./client-tool-types.js";
import { addOpenAIUsage, createToolCallId } from "./client-tool-output.js";
import { serializeToolChoice } from "./chat-request-shaping.js";

interface StrictToolCollection {
  collected: CollectedProviderMessage;
  parsed: StrictToolDecision | GatewayError;
}

export async function runStrictClientTools(
  input: StrictClientToolsInput
): Promise<StrictClientToolsResult | GatewayError> {
  const first = await collectStrictToolDecision(input, input.prompt, "strict_initial");
  if (first instanceof GatewayError) {
    return first;
  }

  const firstUsage = openAIUsageFromTokenUsage(first.collected.usage);
  const parsed = first.parsed;
  if (!(parsed instanceof GatewayError)) {
      return strictDecisionToResult(parsed, firstUsage, first.collected.providerSummary);
  }
  const firstSummary =
    providerStreamSummaryFromError(parsed) ?? first.collected.providerSummary;

  input.log?.warn(
    {
      request_id: input.requestId,
      code: parsed.code,
      validation_error: parsed.message,
      strict_tools_repair: true
    },
    "Strict client-defined tool output failed validation; attempting repair."
  );

  const repairPrompt = chatMessagesToStrictToolRepairPrompt({
    originalPrompt: input.prompt,
    invalidOutput: first.collected.content,
    validationError: parsed.message
  });
  const repaired = await collectStrictToolDecision(input, repairPrompt, "strict_repair");
  if (repaired instanceof GatewayError) {
    const repairedSummary = providerStreamSummaryFromError(repaired);
    return repairedSummary
      ? attachProviderStreamSummary(
          repaired,
          combineProviderStreamSummaries([firstSummary, repairedSummary]) ??
            repairedSummary
        )
      : repaired;
  }

  const repairedParsed = repaired.parsed;
  if (repairedParsed instanceof GatewayError) {
    const repairedSummary =
      providerStreamSummaryFromError(repairedParsed) ?? repaired.collected.providerSummary;
    const repairedCompletionError = providerCompletionError(
      repaired.collected.providerSummary
    );
    if (repairedCompletionError) {
      const repairedErrorSummary =
        providerStreamSummaryFromError(repairedCompletionError) ??
        repaired.collected.providerSummary;
      return attachProviderStreamSummary(
        repairedCompletionError,
        combineProviderStreamSummaries([
          firstSummary,
          repairedErrorSummary
        ]) ?? repairedErrorSummary
      );
    }
    if (
      shouldFallbackStrictAutoPlainText({
        toolChoice: input.request.toolChoice,
        firstValidationError: parsed.message,
        repairValidationError: repairedParsed.message,
        firstOutput: first.collected.content
      })
    ) {
      input.log?.info(
        {
          request_id: input.requestId,
          strict_tools_fallback: "auto_plain_text",
          tool_choice: "auto",
          validation_error: repairedParsed.message,
          invalid_output_chars: first.collected.content.length,
          repair_invalid_output_chars: repaired.collected.content.length
        },
        "Strict client-defined tool output fell back to plain assistant message."
      );
      return strictDecisionToResult(
        { type: "message", content: first.collected.content },
        addOpenAIUsage(firstUsage, openAIUsageFromTokenUsage(repaired.collected.usage)),
        combineProviderStreamSummaries([
          firstSummary,
          repairedSummary
        ])
      );
    }

    input.log?.warn(
      {
        request_id: input.requestId,
        code: repairedParsed.code,
        validation_error: repairedParsed.message,
        strict_tools_repair: false
      },
      "Strict client-defined tool output repair failed validation."
    );
    return attachProviderStreamSummary(
      repairedParsed,
      combineProviderStreamSummaries([
        firstSummary,
        repairedSummary
      ]) ?? repairedSummary
    );
  }

  input.log?.info(
    {
      request_id: input.requestId,
      strict_tools_repaired: true
    },
    "Strict client-defined tool output repaired successfully."
  );

  return strictDecisionToResult(
    repairedParsed,
    addOpenAIUsage(firstUsage, openAIUsageFromTokenUsage(repaired.collected.usage)),
    combineProviderStreamSummaries([
      firstSummary,
      repaired.collected.providerSummary
    ])
  );
}

function shouldFallbackStrictAutoPlainText(input: {
  toolChoice: ChatCompletionRequest["toolChoice"];
  firstValidationError: string;
  repairValidationError: string;
  firstOutput: string;
}): boolean {
  return (
    input.toolChoice === "auto" &&
    input.firstValidationError === "Expected valid JSON object output." &&
    input.repairValidationError === "Expected valid JSON object output." &&
    input.firstOutput.trim().length > 0 &&
    !looksLikeStrictToolOutputAttempt(input.firstOutput)
  );
}

function looksLikeStrictToolOutputAttempt(output: string): boolean {
  const trimmed = output.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[") || /^```(?:json)?\s*[\[{]/i.test(trimmed)) {
    return true;
  }
  return [
    /["']type["']\s*:\s*["']tool_calls["']/i,
    /["']tool_calls["']\s*:/i,
    /["']function["']\s*:/i,
    /["']arguments["']\s*:/i,
    /\btool_calls?\b/i,
    /\bfunction_call\b/i,
    /<tool_call\b/i
  ].some((pattern) => pattern.test(trimmed));
}

async function collectStrictToolDecision(
  input: StrictClientToolsInput,
  prompt: string,
  attemptKind: string
): Promise<StrictToolCollection | GatewayError> {
  const collected = await collectProviderMessage({
    provider: input.provider,
    upstreamAccount: input.upstreamAccount,
    subject: input.subject,
    scope: input.scope,
    session: input.session,
    message: prompt,
    images: input.request.images,
    reasoningEffort: input.reasoningEffort,
    maximumOutputTokens: input.request.maximumOutputTokens,
    attemptKind,
    attemptToolChoice: serializeToolChoice(input.request.toolChoice),
    upstreamRuntime: input.upstreamRuntime,
    upstreamModel: input.upstreamModel,
    signal: input.signal,
    onProviderError: input.onProviderError,
    onProviderEvent: input.onProviderEvent,
    suppressToolCalls: true,
    deferEmptyCompletionError: true,
    outputTruncationMode: input.nativeFileToolRecoveryPolicy.mode,
    outputKind:
      input.request.toolChoice === "required" ||
      typeof input.request.toolChoice === "object"
        ? "tool_call"
        : "auto",
    softToolArgumentBytes: input.nativeFileToolRecoveryPolicy.softArgumentBytes,
    hardToolArgumentBytes: input.nativeFileToolRecoveryPolicy.hardArgumentBytes
  });
  if (collected instanceof GatewayError) {
    return collected;
  }

  const parsed = parseStrictToolDecision({
    text: collected.content,
    tools: input.request.tools ?? [],
    toolChoice: input.request.toolChoice,
    createToolCallId
  });
  return {
    collected,
    parsed:
      parsed instanceof GatewayError
        ? attachProviderStreamSummary(parsed, collected.providerSummary)
        : parsed
  };
}

export function strictDecisionToResult(
  decision: StrictToolDecision,
  usage: OpenAIChatUsage | null,
  providerSummary: ProviderStreamSummary | null = null
): StrictClientToolsResult {
  if (decision.type === "message") {
    return {
      content: decision.content,
      toolCalls: [],
      usage,
      providerSummary
    };
  }

  return {
    content: "",
    toolCalls: decision.toolCalls,
    usage,
    providerSummary
  };
}
