import { expect, it } from "vitest";
import type { ProviderAdapter, UpstreamAccount } from "@codex-gateway/core";
import type { GatewayRequestContext } from "../http/context.js";
import { resolvePublicModelRegistry } from "../services/public-model-registry.js";
import { createChatRuntimeDispatcher } from "../services/chat-runtime-dispatcher.js";
import { UpstreamAccountRouter } from "../services/upstream-account-router.js";
import { createSubtitleCleaner } from "./clean.js";
import { CLEANUP_RULES } from "./rules.js";
import { OpenAICompatibleProviderAdapter } from "../services/openai-compatible-provider.js";

it("uses the selected cloud model, fixed rules and credential model access", async () => {
  const calls: { model: string; messages: { role: string; content: string }[]; max_tokens: number }[] = [];
  const provider = (model: string): ProviderAdapter => new OpenAICompatibleProviderAdapter({
    providerKind: "tencent", apiKey: "fixture", apiKeyEnv: "UNUSED", baseUrl: "https://fixture.invalid/v1", upstreamModel: model, timeoutMs: 1000,
    fetchImpl: async (_url, request) => {
      calls.push(JSON.parse(String(request?.body)));
      return new Response('data: {"choices":[{"delta":{"content":"{\\"cues\\":[]}"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    },
  });
  const account: UpstreamAccount = { id: "fixture", provider: "tencent", label: "fixture", credentialRef: "fixture", state: "active", lastUsedAt: null, cooldownUntil: null };
  const registry = resolvePublicModelRegistry({ MEDCODE_PUBLIC_MODEL_ID: "goldencode", MEDCODE_PUBLIC_MODELS_JSON: JSON.stringify(Object.fromEntries(["goldencode", "goldencode-d"].map(id => [id, { runtime: "tencent", upstreamModel: id, contextWindow: 65536, maxOutputTokens: id === "goldencode" ? 8192 : 65536 }]))) });
  const dispatcher = createChatRuntimeDispatcher({ codexRouter: new UpstreamAccountRouter([{ upstreamAccount: account, provider: provider("unused") }]), openRouterAdapterForModel: () => null, tencentAdapterForModel: model => provider(model.id) });
  const clean = createSubtitleCleaner(registry, dispatcher);
  const context: GatewayRequestContext = { subject: { id: "subtitle-owner", label: "fixture", state: "active", createdAt: new Date() }, scope: "code", upstreamAccount: account, provider: provider("unused"), credential: { id: null, prefix: "fixture", label: null, expiresAt: null, rate: null, allowedPublicModels: null, credentialClass: "desktop" } };
  await expect(clean("goldencode", { core: [] }, context)).resolves.toEqual({ cues: [] });
  await expect(clean("goldencode-d", { core: [] }, context)).resolves.toEqual({ cues: [] });
  expect(calls.map(call => call.model)).toEqual(["goldencode", "goldencode-d"]);
  expect(calls.every(call => call.messages.some(message => message.content.includes(CLEANUP_RULES) && message.content.includes('{"core":[]}')))).toBe(true);
  expect(calls.map(call => call.max_tokens)).toEqual([8192, 32768]);
  context.credential.allowedPublicModels = ["goldencode"];
  await expect(clean("goldencode-d", { core: [] }, context)).rejects.toThrow("subtitle_model_not_allowed");
  expect(calls).toHaveLength(2);
});
