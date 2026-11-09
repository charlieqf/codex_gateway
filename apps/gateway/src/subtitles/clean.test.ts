import { expect, it } from "vitest";
import type { MessageInput, ProviderAdapter, UpstreamAccount } from "@codex-gateway/core";
import type { GatewayRequestContext } from "../http/context.js";
import { resolvePublicModelRegistry } from "../services/public-model-registry.js";
import { createChatRuntimeDispatcher } from "../services/chat-runtime-dispatcher.js";
import { UpstreamAccountRouter } from "../services/upstream-account-router.js";
import { createSubtitleCleaner } from "./clean.js";
import { CLEANUP_RULES } from "./rules.js";

it("uses the selected cloud model, fixed rules and credential model access", async () => {
  const calls: { model: string; input: MessageInput }[] = [];
  const provider = (model: string): ProviderAdapter => ({ kind: "fake", health: async () => ({ state: "healthy", checkedAt: new Date() }), async *message(input) { calls.push({ model, input }); yield { type: "message_delta", text: '{"cues":[]}' }; yield { type: "completed", responseSummary: { finishReason: "stop" } }; } });
  const account: UpstreamAccount = { id: "fixture", provider: "tencent", label: "fixture", credentialRef: "fixture", state: "active", lastUsedAt: null, cooldownUntil: null };
  const registry = resolvePublicModelRegistry({ MEDCODE_PUBLIC_MODEL_ID: "goldencode", MEDCODE_PUBLIC_MODELS_JSON: JSON.stringify(Object.fromEntries(["goldencode", "goldencode-d"].map(id => [id, { runtime: "tencent", upstreamModel: id, contextWindow: 32768, maxOutputTokens: 8192 }]))) });
  const dispatcher = createChatRuntimeDispatcher({ codexRouter: new UpstreamAccountRouter([{ upstreamAccount: account, provider: provider("unused") }]), openRouterAdapterForModel: () => null, tencentAdapterForModel: model => provider(model.id) });
  const clean = createSubtitleCleaner(registry, dispatcher);
  const context: GatewayRequestContext = { subject: { id: "subtitle-owner", label: "fixture", state: "active", createdAt: new Date() }, scope: "code", upstreamAccount: account, provider: provider("unused"), credential: { id: null, prefix: "fixture", label: null, expiresAt: null, rate: null, allowedPublicModels: null, credentialClass: "desktop" } };
  await expect(clean("goldencode", { core: [] }, context)).resolves.toEqual({ cues: [] });
  await expect(clean("goldencode-d", { core: [] }, context)).resolves.toEqual({ cues: [] });
  expect(calls.map(call => call.model)).toEqual(["goldencode", "goldencode-d"]);
  expect(calls[0].input.chatMessages).toEqual([{ role: "system", content: CLEANUP_RULES }, { role: "user", content: '{"core":[]}' }]);
  expect(calls.every(call => call.input.maximumOutputTokens === 6000 && call.input.signal?.aborted)).toBe(true);
  context.credential.allowedPublicModels = ["goldencode"];
  await expect(clean("goldencode-d", { core: [] }, context)).rejects.toThrow("subtitle_model_not_allowed");
  expect(calls).toHaveLength(2);
});
