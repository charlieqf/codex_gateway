import { randomUUID } from "node:crypto";
import { type FastifyRequest } from "fastify";
import { type GatewaySession, type StreamEvent } from "@codex-gateway/core";
import { getGatewayContext } from "../http/context.js";
import { markSession } from "../http/observation.js";
import {
  hasStrictClientTools,
  type ChatCompletionRequest,
  type ChatCompletionShape
} from "../openai-compat.js";
import { type UpstreamAccountSelection, type UpstreamSoftAffinity } from "./upstream-account-router.js";
import { publicModelPoolAffinityKey, type ChatRuntimeContext } from "./chat-runtime-dispatcher.js";
import { type PublicModelConfig } from "./public-model-registry.js";

export const estimatedTokensPerVisionImage = 4_096;

export function publicSessionStreamEvent(event: StreamEvent): StreamEvent {
  if (event.type !== "error") {
    return event;
  }
  const { providerFailure: _providerFailure, ...publicEvent } = event;
  return publicEvent;
}

export function createChatCompletionShape(model: string): ChatCompletionShape {
  return {
    id: `chatcmpl_${randomUUID().replaceAll("-", "")}`,
    created: Math.floor(Date.now() / 1000),
    model
  };
}

export function chatCompletionEstimateExtras(
  request: ChatCompletionRequest,
  strictClientTools: boolean,
  runtime: ChatRuntimeContext["runtime"]
): string {
  const runtimeExtra =
    runtimeAddsOpenAICompatibleIdentityGuard(runtime)
      ? "OpenRouter identity guard is added as an internal system message."
      : "";
  if (strictClientTools) {
    return runtimeExtra;
  }
  const base = {
    tools: request.tools ?? null,
    tool_choice: request.toolChoice
  };
  if (!runtimeExtra) {
    return JSON.stringify(base);
  }
  return JSON.stringify({
    ...base,
    runtime_extra: runtimeExtra
  });
}

export function hasNativeClientTools(
  request: ChatCompletionRequest,
  runtime: ChatRuntimeContext["runtime"]
): boolean {
  return runtime !== "codex" && hasStrictClientTools(request);
}

function isOpenAICompatibleRuntime(runtime: PublicModelConfig["runtime"]): boolean {
  return (
    runtime === "openrouter" ||
    runtime === "qianfan" ||
    runtime === "aliyun" ||
    runtime === "tencent" ||
    runtime === "tiankuan" ||
    runtime === "tokenswitch" ||
    runtime === "local_openai"
  );
}

export function usesOpenAICompatiblePublicRuntime(runtime: PublicModelConfig["runtime"]): boolean {
  return isOpenAICompatibleRuntime(runtime) || runtime === "pool";
}

function runtimeAddsOpenAICompatibleIdentityGuard(
  runtime: ChatRuntimeContext["runtime"]
): boolean {
  return runtime === "openrouter";
}

export function createStatelessSession(subjectId: string, upstreamAccountId: string): GatewaySession {
  const now = new Date();
  return {
    id: `sess_stateless_${randomUUID().replaceAll("-", "")}`,
    subjectId,
    upstreamAccountId,
    publicModelId: null,
    providerSessionRef: null,
    title: null,
    state: "active",
    createdAt: now,
    updatedAt: now
  };
}

export function serializeToolChoice(toolChoice: ChatCompletionRequest["toolChoice"]): string {
  if (typeof toolChoice === "string") {
    return toolChoice;
  }
  return `function:${toolChoice.function.name}`;
}

export function applyUpstreamSelection(
  request: FastifyRequest,
  selection: UpstreamAccountSelection
): void {
  const context = getGatewayContext(request);
  request.gatewayContext = {
    ...context,
    upstreamAccount: selection.upstreamAccount,
    provider: selection.provider
  };
}

export function applyChatRuntimeContext(
  request: FastifyRequest,
  runtime: ChatRuntimeContext
): void {
  const context = getGatewayContext(request);
  request.gatewayContext = {
    ...context,
    upstreamAccount: runtime.adapterInputUpstreamAccount,
    provider: runtime.adapter
  };
  request.gatewayPublicModelId = runtime.publicModelId;
  request.gatewayUpstreamRuntime = runtime.runtime;
  request.gatewayUpstreamModel = runtime.upstreamModel;
  request.gatewayReasoningEffort = runtime.reasoningEffort;
  request.gatewayEffectiveReasoningEffort = runtime.reasoningEffort;
  markSession(request, runtime.session.id);
}

export function chatRuntimeAffinityKey(
  request: FastifyRequest,
  publicModel: PublicModelConfig,
  codexSoftAffinity: UpstreamSoftAffinity
): string | null {
  if (publicModel.runtime !== "pool") {
    return requestAffinityKey(request, codexSoftAffinity);
  }
  const { credential, subject } = getGatewayContext(request);
  return publicModelPoolAffinityKey(publicModel, {
    client_session: request.gatewayClientSessionId ?? null,
    credential: credential.id,
    subject: subject.id
  });
}

export function requestAffinityKey(
  request: FastifyRequest,
  mode: UpstreamSoftAffinity
): string | null {
  if (mode === "none") {
    return null;
  }
  const { credential, subject } = getGatewayContext(request);
  return mode === "credential" ? credential.id : subject.id;
}
