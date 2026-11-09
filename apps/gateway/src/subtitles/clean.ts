import { credentialAllowsPublicModel, GatewayError } from "@codex-gateway/core";
import type { GatewayRequestContext } from "../http/context.js";
import type { ChatRuntimeDispatcher } from "../services/chat-runtime-dispatcher.js";
import { createStatelessSession } from "../services/chat-request-shaping.js";
import type { PublicModelRegistry } from "../services/public-model-registry.js";
import { CLEANUP_RULES } from "./rules.js";

export type SubtitleCleaner = (model: "goldencode" | "goldencode-d", input: unknown, context: GatewayRequestContext) => Promise<unknown>;

export function createSubtitleCleaner(registry: PublicModelRegistry, dispatcher: ChatRuntimeDispatcher): SubtitleCleaner {
  return async (selected, input, context) => {
    const model = registry.get(selected);
    if (!model?.enabled || !["goldencode", "goldencode-d"].includes(model.id)) throw new Error("subtitle_model_unavailable");
    if (!credentialAllowsPublicModel(context.credential.allowedPublicModels, model.id, registry.models)) throw new Error("subtitle_model_not_allowed");
    // Bound reasoning for this editing task instead of inheriting a provider's maximum default.
    const runtime = dispatcher.begin({ model, modality: "text", reasoningEffort: "low", reasoningEffortSource: "request", subject: context.subject, scope: context.scope, affinityKey: "subtitle:" + context.subject.id, createSession: createStatelessSession });
    if (runtime instanceof GatewayError) throw runtime;
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), 300_000);
    const parts: string[] = [];
    let size = 0;
    try {
      for await (const event of runtime.adapter.message({
        upstreamAccount: runtime.adapterInputUpstreamAccount, session: runtime.session, subject: context.subject, scope: context.scope,
        // Cloud adapters use the flattened prompt, as in the existing chat route.
        message: CLEANUP_RULES + "\n\n待编辑材料 JSON：\n" + JSON.stringify(input),
        responseFormat: { type: "json_object" },
        // DeepSeek counts reasoning in completion tokens; retain the validated normal-model budget.
        reasoningEffort: runtime.reasoningEffort, maximumOutputTokens: Math.min(selected === "goldencode-d" ? 32_768 : 6_000, runtime.limits.maxOutputTokens), signal: deadline.signal,
      })) {
        if (event.type === "error") {
          if (event.gatewayError) runtime.recordError(event.gatewayError);
          throw new Error("subtitle_clean_failed");
        }
        if (event.type === "message_delta") {
          size += event.text.length;
          if (size > 1_000_000) throw new Error("subtitle_response_limit");
          parts.push(event.text);
        }
        if (event.type === "completed") {
          if (event.responseSummary?.finishReason === "length") throw new Error("subtitle_clean_incomplete");
          const result: unknown = JSON.parse(parts.join(""));
          runtime.recordSuccess();
          return result;
        }
      }
      throw new Error("subtitle_clean_incomplete");
    } finally {
      clearTimeout(timer);
      deadline.abort();
      runtime.release();
    }
  };
}
