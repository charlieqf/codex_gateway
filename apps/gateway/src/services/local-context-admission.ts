import {
  GatewayError,
  type GatewayContextWindowDetails,
  type ProviderPromptTokenCount
} from "@codex-gateway/core";

export const localContextAdmissionModes = ["disabled", "shadow", "enforce"] as const;

export type LocalContextAdmissionMode = (typeof localContextAdmissionModes)[number];

export function parseLocalContextAdmissionMode(
  value: string | undefined
): LocalContextAdmissionMode {
  if (value === undefined || value.trim().length === 0) {
    return "disabled";
  }
  const normalized = value.trim().toLowerCase();
  if (localContextAdmissionModes.includes(normalized as LocalContextAdmissionMode)) {
    return normalized as LocalContextAdmissionMode;
  }
  throw new Error(
    `MEDCODE_LOCAL_CONTEXT_ADMISSION_MODE must be one of ${localContextAdmissionModes.join(
      ", "
    )}.`
  );
}

export function providerTokenizedContextWindowDetails(input: {
  configuredContextLimitTokens: number;
  requestedOutputTokens: number;
  tokenCount: ProviderPromptTokenCount;
}): GatewayContextWindowDetails | null {
  const contextLimitTokens = Math.min(
    input.configuredContextLimitTokens,
    input.tokenCount.maxContextTokens
  );
  const totalTokens = input.tokenCount.promptTokens + input.requestedOutputTokens;
  if (totalTokens <= contextLimitTokens) {
    return null;
  }
  return {
    contextLimitTokens,
    promptTokens: input.tokenCount.promptTokens,
    requestedOutputTokens: input.requestedOutputTokens,
    totalTokens,
    overflowTokens: totalTokens - contextLimitTokens,
    tokenCountSource: input.tokenCount.source
  };
}

export function contextCompactionRequiredError(
  contextWindowDetails: GatewayContextWindowDetails,
  upstreamStatus?: number
): GatewayError {
  return new GatewayError({
    code: "context_compaction_required",
    message:
      "The request exceeds the effective model context window. Compact earlier context and retry once.",
    httpStatus: 413,
    ...(upstreamStatus === undefined ? {} : { upstreamStatus }),
    contractVersion: 1,
    failureKind: "model_context_overflow",
    transformedRetryAllowed: true,
    recommendedAction: "compact_and_retry_once",
    recoveryOwner: "client",
    contextWindowDetails
  });
}

export function localContextWindowDetails(
  value: string,
  requestedOutputTokens: number | undefined
): GatewayContextWindowDetails | null {
  if (
    !/maximum context length|max(?:imum)?[_ ]model[_ ]len|max(?:imum)?(?: model)? context|context window/i.test(
      value
    )
  ) {
    return null;
  }

  const contextLimitTokens = firstMatchedInteger(value, [
    /maximum context length is\s*(\d+)\s*tokens/i,
    /max(?:imum)?[_ ]model[_ ]len\D{0,24}(\d+)/i,
    /max(?:imum)?(?: model)? context(?: length| window)?\D{0,24}(\d+)/i,
    /context (?:window|length)\D{0,24}(\d+)/i
  ]);
  let promptTokens = firstMatchedInteger(value, [
    /(\d+)\s+(?:in|from)\s+the messages/i,
    /(\d+)\s+(?:input|prompt)\s+tokens/i,
    /(?:input|prompt)(?: prompt| length)?\D{0,24}(\d+)\s*tokens/i
  ]);
  let outputTokens = firstMatchedInteger(value, [
    /(\d+)\s+in\s+the completion/i,
    /(\d+)\s+(?:output|completion)\s+tokens/i,
    /(?:requested )?(?:output|completion)(?: length)?\D{0,24}(\d+)\s*tokens/i
  ]);
  let totalTokens = firstMatchedInteger(value, [
    /you requested\s+(\d+)\s+tokens/i,
    /(?:request|total)(?:ed)?(?: length)?\D{0,24}(\d+)\s+tokens/i
  ]);

  outputTokens ??= requestedOutputTokens ?? null;
  if (promptTokens === null && totalTokens !== null && outputTokens !== null) {
    promptTokens = totalTokens - outputTokens;
  }
  if (totalTokens === null && promptTokens !== null && outputTokens !== null) {
    totalTokens = promptTokens + outputTokens;
  }
  if (
    contextLimitTokens === null ||
    promptTokens === null ||
    outputTokens === null ||
    totalTokens === null ||
    contextLimitTokens <= 0 ||
    promptTokens < 0 ||
    outputTokens <= 0 ||
    totalTokens <= contextLimitTokens
  ) {
    return null;
  }

  return {
    contextLimitTokens,
    promptTokens,
    requestedOutputTokens: outputTokens,
    totalTokens,
    overflowTokens: totalTokens - contextLimitTokens,
    tokenCountSource: "upstream_validation"
  };
}

function firstMatchedInteger(value: string, patterns: readonly RegExp[]): number | null {
  for (const pattern of patterns) {
    const match = pattern.exec(value);
    const parsed = match?.[1] ? Number(match[1]) : NaN;
    if (Number.isSafeInteger(parsed) && parsed >= 0) {
      return parsed;
    }
  }
  return null;
}
