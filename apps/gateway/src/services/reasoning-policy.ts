import { GatewayError } from "@codex-gateway/core";
import { type PublicModelConfig } from "./public-model-registry.js";
import { usesOpenAICompatiblePublicRuntime } from "./chat-request-shaping.js";

const maxRequestReasoningEfforts = ["minimal", "low", "medium", "high", "xhigh"] as const;

const standardRequestReasoningEfforts = ["none", "low", "medium", "high"] as const;

const localOpenAIReasoningEfforts = ["none", "low", "medium", "high", "xhigh"] as const;

const legacyStandardReasoningModelIds = new Set([
  "specialist",
  "expert",
  "advisor",
  "consultant",
  "pro",
  "standard"
]);

type ReasoningEffortSource = "default" | "request" | "legacy_normalization";

interface ResolvedReasoningEffort {
  requested: string | null;
  effective: string | null;
  source: ReasoningEffortSource;
  normalized: boolean;
  normalizationReason: string | null;
}

export function resolveChatCompletionReasoningEffort(
  model: PublicModelConfig,
  requested: string | undefined,
  requestModelId: string,
  modality: "text" | "vision"
): ResolvedReasoningEffort | GatewayError {
  const reasoning = reasoningConfigForModel(model, modality);
  if (requested === undefined) {
    return {
      requested: null,
      effective: configuredReasoningEffort(reasoning),
      source: "default",
      normalized: false,
      normalizationReason: null
    };
  }

  const supported = supportedReasoningEffortsForModel(model, modality);
  if (!supported) {
    return new GatewayError({
      code: "unsupported_reasoning_effort",
      message: `reasoning_effort is not supported for model '${requestModelId}'.`,
      httpStatus: 400,
      contractVersion: 1,
      recommendedAction: "remove_reasoning_effort",
      recoveryOwner: "client",
      parameter: "reasoning_effort",
      requestedValue: requested,
      supportedValues: []
    });
  }

  if (supported.values.includes(requested)) {
    return {
      requested,
      effective: requested,
      source: "request",
      normalized: false,
      normalizationReason: null
    };
  }

  const normalized = reasoning?.legacyAliases?.[requested];
  if (normalized && supported.values.includes(normalized)) {
    return {
      requested,
      effective: normalized,
      source: "legacy_normalization",
      normalized: true,
      normalizationReason: "legacy_alias"
    };
  }

  return new GatewayError({
    code: "unsupported_reasoning_effort",
    message: `reasoning_effort '${requested}' is not supported for model '${requestModelId}'. Supported values: ${supported.values.join(", ")}.`,
    httpStatus: 400,
    contractVersion: 1,
    recommendedAction: "use_supported_reasoning_effort",
    recoveryOwner: "client",
    parameter: "reasoning_effort",
    requestedValue: requested,
    supportedValues: supported.values
  });
}

function reasoningConfigForModel(
  model: PublicModelConfig,
  modality: "text" | "vision"
): PublicModelConfig["reasoning"] {
  return modality === "vision" ? model.vision?.reasoning : model.reasoning;
}

function configuredReasoningEffort(
  reasoning: PublicModelConfig["reasoning"]
): string | null {
  const effort = reasoning?.effort;
  return typeof effort === "string" && effort.length > 0 ? effort : null;
}

function supportedReasoningEffortsForModel(
  model: PublicModelConfig,
  modality: "text" | "vision"
): { values: readonly string[] } | null {
  const configured = reasoningConfigForModel(model, modality)?.supportedEfforts;
  if (configured) {
    return { values: configured };
  }
  if (isMaxReasoningModel(model)) {
    return { values: maxRequestReasoningEfforts };
  }
  if (model.runtime === "local_openai") {
    return { values: localOpenAIReasoningEfforts };
  }
  if (
    legacyStandardReasoningModelIds.has(model.id) ||
    usesOpenAICompatiblePublicRuntime(model.runtime)
  ) {
    return { values: standardRequestReasoningEfforts };
  }
  return null;
}

function isMaxReasoningModel(model: PublicModelConfig): boolean {
  return (
    model.id === "max" ||
    model.aliases.includes("medcode") ||
    (model.runtime === "codex" && model.displayName.toLowerCase() === "max")
  );
}
