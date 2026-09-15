import { GatewayError } from "@codex-gateway/core";
import {
  classifyOversizedWrite,
  oversizedWriteError,
  buildWriteDelivery,
  writeDeliveryToolName
} from "./write-delivery.js";
import {
  openAIUsageFromTokenUsage,
  parseStrictToolDecision,
  type ChatCompletionRequest,
  type OpenAIChatUsage
} from "../openai-compat.js";
import {
  assessProviderCompletion,
  attachProviderStreamSummary,
  combineProviderStreamSummaries,
  collectProviderMessage,
  providerCompletionError,
  providerStreamSummaryFromError,
  providerToolOutputLengthError,
  providerToolOutputReachedTokenLimit,
  type CollectedProviderMessage,
  type ProviderStreamSummary
} from "./provider-stream.js";
import { estimatePromptTokens } from "./token-budget-hook.js";
import { type ChatRuntimeContext } from "./chat-runtime-dispatcher.js";
import { NativeCallBudget, runNativeToolFailover } from "./native-tool-failover.js";
import { VisionRequestRecovery, runVisionRequestRecovery } from "./vision-request-recovery.js";
import type {
  NativeClientToolsInput,
  StrictClientToolsInput,
  StrictClientToolsResult
} from "./client-tool-types.js";
import {
  initialNativeToolChoice,
  nativeAutoToolRetryPlan,
  nativeValidationRetryPlan
} from "./native-tool-policy.js";
import { addOpenAIUsage, createToolCallId, providerToolCallToOpenAI } from "./client-tool-output.js";
import { chatCompletionEstimateExtras, serializeToolChoice } from "./chat-request-shaping.js";
import { strictDecisionToResult } from "./strict-client-tools.js";

export async function runNativeWithFailover(input: NativeClientToolsInput & {
  failover: boolean;
  visionRecovery?: VisionRequestRecovery;
  runtime: ChatRuntimeContext;
  deadlineAt: Date | null;
  now: () => Date;
  outputCommitted: () => boolean;
  selected: (runtime: ChatRuntimeContext) => void;
}): Promise<StrictClientToolsResult | GatewayError> {
  const execute = (runtime: ChatRuntimeContext, callBudget?: NativeCallBudget, retry = false) => runNativeClientTools({
    ...input, callBudget,
    request: { ...input.request, maximumOutputTokens: input.request.maximumOutputTokens ?? runtime.limits.maxOutputTokens },
    onNativeCall: runtime.updateQuotaRequest,
    failoverAttempt: retry || runtime.runtimeInstanceId !== input.runtime.runtimeInstanceId,
    provider: runtime.adapter, upstreamAccount: runtime.adapterInputUpstreamAccount,
    upstreamRuntime: runtime.runtime, upstreamModel: runtime.upstreamModel,
    subject: runtime.subject, scope: runtime.scope, session: runtime.session,
    reasoningEffort: runtime.reasoningEffort
  });
  if (input.visionRecovery) {
    const result = await runVisionRequestRecovery({ ...input, recovery: input.visionRecovery, signal: input.signal!,
      execute: (budget, retry) => execute(input.runtime, budget, retry) });
    if (result instanceof GatewayError) return result;
    return { ...result, usage: openAIUsageFromTokenUsage(result.providerSummary?.usage ?? undefined) };
  }
  if (!input.failover) {
    return input.runtime.updateQuotaRequest ? execute(input.runtime) : runNativeClientTools(input);
  }
  const result = await runNativeToolFailover({
    ...input,
    signal: input.signal!,
    onDecision: (fields) => input.log?.info({ request_id: input.requestId, ...fields }, "Native tool provider failover assessed."),
    execute
  });
  if (result instanceof GatewayError) return result;
  return { ...result, usage: openAIUsageFromTokenUsage(result.providerSummary?.usage ?? undefined) };
}

async function runNativeClientTools(
  input: NativeClientToolsInput
): Promise<StrictClientToolsResult | GatewayError> {
  const firstToolChoice = initialNativeToolChoice(
    input.request,
    input.upstreamModel,
    input.nativeToolForceRequiredMode
  );
  if (firstToolChoice !== input.request.toolChoice) {
    input.log?.info(
      {
        request_id: input.requestId,
        native_tools_initial_tool_choice: "auto_to_required"
      },
      "Native client-defined tools request looks like a file generation task; using required tool_choice."
    );
  }

  const first = await collectNativeClientTools(input, firstToolChoice, input.prompt,
    input.failoverAttempt ? "stateless_retry" : "native_initial");
  if (first instanceof GatewayError) {
    return first;
  }

  const firstUsage = openAIUsageFromTokenUsage(first.usage);
  const firstResult = nativeCollectionToResult(
    input,
    first,
    firstUsage,
    firstToolChoice
  );
  if (firstResult instanceof GatewayError) {
    const firstResultSummary =
      providerStreamSummaryFromError(firstResult) ?? first.providerSummary;
    const retryPlan = nativeValidationRetryPlan(
      input.request,
      input.upstreamModel,
      firstToolChoice,
      firstResult,
      input.prompt
    );
    if (!retryPlan || input.callBudget?.remaining === 0) {
      return firstResult;
    }

    input.log?.info(
      {
        request_id: input.requestId,
        native_tools_retry: retryPlan.kind,
        validation_error: firstResult.message,
        retry_tool_choice: retryPlan.toolChoice
      },
      "Native client-defined tool output failed validation; retrying tool call request."
    );

    const second = await collectNativeClientTools(
      input,
      retryPlan.toolChoice,
      retryPlan.prompt,
      retryPlan.kind
    );
    if (second instanceof GatewayError) {
      return attachPreviousProviderStreamSummaries(second, [firstResultSummary]);
    }

    const secondResult = nativeCollectionToResult(
      input,
      second,
      addOpenAIUsage(firstUsage, openAIUsageFromTokenUsage(second.usage)),
      retryPlan.validationToolChoice,
      combineProviderStreamSummaries([firstResultSummary, second.providerSummary]) ??
        second.providerSummary
    );
    if (secondResult instanceof GatewayError) {
      return secondResult;
    }
    return validateNativeCompletion(secondResult);
  }
  const retryPlan = nativeAutoToolRetryPlan(
    input.request,
    input.upstreamModel,
    firstToolChoice,
    firstResult,
    input.prompt,
    input.nativeToolForceRequiredMode
  );
  if (!retryPlan || input.callBudget?.remaining === 0) {
    return validateNativeCompletion(firstResult);
  }

  input.log?.info(
    {
      request_id: input.requestId,
      native_tools_retry: retryPlan.kind,
      first_output_chars: firstResult.content.length
    },
    "Native client-defined tools auto response did not call a tool; retrying tool call request."
  );

  const second = await collectNativeClientTools(
    input,
    retryPlan.toolChoice,
    retryPlan.prompt,
    retryPlan.kind
  );
  if (second instanceof GatewayError) {
    return attachPreviousProviderStreamSummaries(second, [first.providerSummary]);
  }

  const secondUsage = openAIUsageFromTokenUsage(second.usage);
  const secondResult = nativeCollectionToResult(
    input,
    second,
    addOpenAIUsage(firstUsage, secondUsage),
    retryPlan.toolChoice,
    combineProviderStreamSummaries([first.providerSummary, second.providerSummary]) ??
      second.providerSummary
  );
  if (secondResult instanceof GatewayError) {
    return secondResult;
  }
  if (retryPlan.kind === "auto_ack_after_tool_to_auto") {
    return validateNativeCompletion(secondResult);
  }
  if (secondResult.toolCalls.length > 0) {
    return validateNativeCompletion(secondResult);
  }
  return validateNativeCompletion({
    ...firstResult,
    usage: secondResult.usage,
    providerSummary: secondResult.providerSummary
  });
}

function attachPreviousProviderStreamSummaries(
  error: GatewayError,
  previous: ProviderStreamSummary[]
): GatewayError {
  const current = providerStreamSummaryFromError(error);
  const combined = combineProviderStreamSummaries([
    ...previous,
    ...(current ? [current] : [])
  ]);
  return combined ? attachProviderStreamSummary(error, combined) : error;
}

async function collectNativeClientTools(
  input: NativeClientToolsInput,
  toolChoice: ChatCompletionRequest["toolChoice"],
  prompt = input.prompt,
  attemptKind = "native"
): Promise<CollectedProviderMessage | GatewayError> {
  if (input.signal?.aborted) {
    return input.signal.reason instanceof GatewayError ? input.signal.reason : new GatewayError({
      code: "client_aborted", message: "Request ended before native provider execution.", httpStatus: 499
    });
  }
  input.callBudget?.consume();
  input.onNativeCall?.({
    promptTokens: estimatePromptTokens(prompt, chatCompletionEstimateExtras(input.request, false, input.upstreamRuntime)),
    maximumOutputTokens: input.request.maximumOutputTokens!
  });
  const chatMessages = localOpenAIChatMessagesForAttempt(input, prompt);
  return collectProviderMessage({
    provider: input.provider,
    upstreamAccount: input.upstreamAccount,
    subject: input.subject,
    scope: input.scope,
    session: input.session,
    message: prompt,
    ...(chatMessages ? { chatMessages } : {}),
    images: input.request.images,
    reasoningEffort: input.reasoningEffort,
    maximumOutputTokens: input.request.maximumOutputTokens,
    clientTools: input.request.tools,
    clientToolChoice: toolChoice,
    attemptKind,
    attemptToolChoice: serializeToolChoice(toolChoice),
    upstreamRuntime: input.upstreamRuntime,
    upstreamModel: input.upstreamModel,
    signal: input.signal,
    onProviderError: input.onProviderError,
    onProviderEvent: input.onProviderEvent,
    suppressTextAfterToolCall: true,
    deferEmptyCompletionError: true,
    outputTruncationMode: input.nativeFileToolRecoveryPolicy.mode,
    outputKind: "auto",
    softToolArgumentBytes: input.nativeFileToolRecoveryPolicy.softArgumentBytes,
    hardToolArgumentBytes: input.nativeFileToolRecoveryPolicy.hardArgumentBytes
  });
}

function localOpenAIChatMessagesForAttempt(
  input: StrictClientToolsInput,
  prompt: string
): ChatCompletionRequest["messages"] | undefined {
  if (input.provider.kind !== "local-openai") {
    return undefined;
  }
  if (prompt === input.prompt) {
    return input.request.messages;
  }
  const retryInstruction = prompt.startsWith(input.prompt)
    ? prompt.slice(input.prompt.length).trim()
    : prompt;
  return retryInstruction
    ? [...input.request.messages, { role: "user", content: retryInstruction }]
    : input.request.messages;
}

function validateNativeCompletion(
  result: StrictClientToolsResult
): StrictClientToolsResult | GatewayError {
  if (result.content.length > 0 || result.toolCalls.length > 0 || !result.providerSummary) {
    return result;
  }
  return providerCompletionError(result.providerSummary) ?? result;
}

function nativeCollectionToResult(
  input: NativeClientToolsInput,
  collected: CollectedProviderMessage,
  usage: OpenAIChatUsage | null,
  toolChoice: ChatCompletionRequest["toolChoice"],
  providerSummary: ProviderStreamSummary | null = collected.providerSummary
): StrictClientToolsResult | GatewayError {
  const toolCalls = collected.toolCalls.map(providerToolCallToOpenAI);
  if (toolCalls.some((call) => call.function.name.toLowerCase() === writeDeliveryToolName)) {
    const error = new GatewayError({ code: "tool_call_validation_failed", httpStatus: 502,
      message: "The provider returned a reserved delivery receiver; it was not executed.",
      contractVersion: 1, failureKind: "undeclared_tool", transformedRetryAllowed: false,
      recommendedAction: "report_protocol_error" });
    return providerSummary ? attachProviderStreamSummary(error, providerSummary) : error;
  }
  const serializedToolCalls =
    toolCalls.length === 0 ? serializedAssistantToolCalls(collected.content) : null;
  const parsed = parseStrictToolDecision({
    text:
      serializedToolCalls ??
      JSON.stringify(
        toolCalls.length > 0
          ? { type: "tool_calls", tool_calls: toolCalls }
          : { type: "message", content: collected.content }
      ),
    tools: input.request.tools ?? [],
    toolChoice,
    createToolCallId
  });
  if (parsed instanceof GatewayError) {
    if (input.boundedWriteEnabled && providerSummary?.completed && !providerSummary.streamIncomplete &&
        !providerSummary.outputLimitHit && !providerSummary.argumentBudgetExceeded &&
        !providerToolOutputReachedTokenLimit(providerSummary, input.request.maximumOutputTokens) &&
        parsed.failureKind === "schema_mismatch") {
      const write = classifyOversizedWrite(input.request, toolCalls);
      if (write) {
        const remainingMs = input.deadlineAt ? Math.max(0, input.deadlineAt.getTime() - (input.now?.() ?? new Date()).getTime()) : null;
        let stopReason = "write_delivery_not_negotiated";
        const retried = providerSummary.attempts.length > 1 || input.failoverAttempt === true || (input.callBudget?.used ?? 0) > 1;
        if (input.writeDelivery) {
          input.log?.info({ request_id: input.requestId, lossless_delivery_attempted: true,
            ...write.details }, "Assessing lossless ordinary write delivery.");
          if (input.signal?.aborted || remainingMs === 0) stopReason = "write_delivery_request_ended";
          else if (retried) stopReason = "write_delivery_not_first_attempt";
          else if (collected.providerSummary.finishReason !== "tool_calls" ||
              collected.providerSummary.upstreamHttpStatus !== 200 ||
              collected.providerSummary.errorCode || collected.providerSummary.failure ||
              collected.providerSummary.truncationConfidence !== "none") stopReason = "write_delivery_incomplete_output";
          else {
            const delivery = buildWriteDelivery({ write, ...input.writeDelivery, content: collected.content, usage });
            if (!("stopReason" in delivery)) return { content: collected.content,
              toolCalls: [delivery.toolCall], usage, providerSummary, writeDelivery: delivery };
            stopReason = delivery.stopReason;
          }
        }
        const error = oversizedWriteError({ original: parsed, write, stopReason, remainingMs, retried });
        input.log?.info({ request_id: input.requestId, tool_validation: error.toolValidationDetails },
          "Ordinary write content exceeded its limit; full regeneration suppressed.");
        return attachProviderStreamSummary(error, providerSummary);
      }
    }
    if (!providerSummary) {
      return parsed;
    }
    const assessment = assessProviderCompletion(
      providerSummary,
      parsed.failureKind === "invalid_json" ||
      parsed.failureKind === "schema_mismatch" ||
      parsed.failureKind === "undeclared_tool" ||
      parsed.failureKind === "tool_choice_mismatch"
        ? parsed.failureKind
        : "none"
    );
    const validationError = attachProviderStreamSummary(parsed, providerSummary);
    if (
      assessment.validationKind === "invalid_json" &&
      (assessment.outputLimitHit ||
        providerToolOutputReachedTokenLimit(
          providerSummary,
          input.request.maximumOutputTokens
        ))
    ) {
      return providerToolOutputLengthError(
        providerStreamSummaryFromError(validationError) ?? providerSummary
      );
    }
    if (
      assessment.validationKind !== "invalid_json" ||
      !assessment.argumentBudgetExceeded
    ) {
      return validationError;
    }
    const validationSummary =
      providerStreamSummaryFromError(validationError) ?? providerSummary;
    return attachProviderStreamSummary(
      new GatewayError({
        code: "tool_call_validation_failed",
        message:
          "The tool call arguments exceeded the configured byte budget and were not delivered.",
        httpStatus: 502,
        contractVersion: 1,
        failureKind: "argument_budget_exceeded",
        transformedRetryAllowed: true,
        recommendedAction: "compact_and_generate_in_chunks",
        recoveryOwner: "client"
      }),
      validationSummary
    );
  }
  const result = strictDecisionToResult(parsed, usage, providerSummary);
  if (serializedToolCalls && result.toolCalls.length > 0) {
    input.log?.info(
      {
        request_id: input.requestId,
        native_tools_recovered: "assistant_tool_calls_transcript",
        recovered_tool_call_count: result.toolCalls.length
      },
      "Recovered a schema-valid native tool call from the upstream assistant transcript."
    );
  } else if (result.toolCalls.length > 0 && collected.content.length > 0) {
    result.content = collected.content;
  }
  return result;
}

function serializedAssistantToolCalls(content: string): string | null {
  const match = content.trim().match(/^\[assistant tool_calls\]\s+([\s\S]+)$/);
  if (!match) {
    return null;
  }

  try {
    return JSON.stringify({
      type: "tool_calls",
      tool_calls: JSON.parse(match[1])
    });
  } catch {
    return match[1];
  }
}
