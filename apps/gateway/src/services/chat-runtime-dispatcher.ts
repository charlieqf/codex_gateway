import {
  GatewayError,
  type GatewaySession,
  type ProviderAdapter,
  type Scope,
  type Subject,
  type UpstreamAccount
} from "@codex-gateway/core";
import type {
  OpenAICompatibleRuntimeKind,
  PublicModelConfig,
  PublicModelPoolMemberConfig,
  PublicModelPoolStickyKey
} from "./public-model-registry.js";
import {
  type UpstreamAccountLease,
  type UpstreamAccountOutcome,
  type UpstreamAccountRouter,
  type UpstreamSoftAffinity
} from "./upstream-account-router.js";

export type UpstreamRuntimeKind = "codex" | "openrouter" | "qianfan" | "aliyun" | "tencent";
type ExternalRuntimeKind = OpenAICompatibleRuntimeKind;

export interface ChatRuntimeContext {
  publicModelId: string;
  runtime: UpstreamRuntimeKind;
  runtimeInstanceId: string;
  providerKind: UpstreamAccount["provider"];
  upstreamModel: string;
  reasoningEffort: string | null;
  limits: {
    contextWindow: number;
    maxOutputTokens: number;
  };
  adapter: ProviderAdapter;
  adapterInputUpstreamAccount: UpstreamAccount;
  subject: Subject;
  scope: Scope;
  session: GatewaySession;
  release(): void;
  recordSuccess(): void;
  recordError(error: GatewayError): boolean;
  beginRetry?(input: { excludeAccountIds: Iterable<string> }): ChatRuntimeContext | GatewayError;
}

export interface ChatRuntimeDispatcher {
  begin(input: RuntimeBeginInput): ChatRuntimeContext | GatewayError;
}

interface RuntimeBeginInput {
  model: PublicModelConfig;
  reasoningEffort: string | null;
  reasoningEffortSource: "default" | "request";
  subject: Subject;
  scope: Scope;
  affinityKey: string | null;
  createSession: (subjectId: string, upstreamAccountId: string) => GatewaySession;
}

export type PublicModelPoolAffinityValues = Record<PublicModelPoolStickyKey, string | null>;

export interface ChatRuntimeDispatcherInput {
  codexRouter: UpstreamAccountRouter;
  openRouterAdapterForModel: (model: PublicModelConfig) => ProviderAdapter | null;
  qianfanAdapterForModel?: (model: PublicModelConfig) => ProviderAdapter | null;
  aliyunAdapterForModel?: (model: PublicModelConfig) => ProviderAdapter | null;
  tencentAdapterForModel?: (model: PublicModelConfig) => ProviderAdapter | null;
  poolRouterForModel?: (model: PublicModelConfig) => UpstreamAccountRouter | null;
  openRouterAccount?: UpstreamAccount;
  qianfanAccount?: UpstreamAccount;
  aliyunAccount?: UpstreamAccount;
  tencentAccount?: UpstreamAccount;
}

export function createChatRuntimeDispatcher(
  input: ChatRuntimeDispatcherInput
): ChatRuntimeDispatcher {
  const externalRuntimes: Record<
    ExternalRuntimeKind,
    {
      account: UpstreamAccount;
      adapterForModel: (model: PublicModelConfig) => ProviderAdapter | null;
    }
  > = {
    openrouter: {
      account: input.openRouterAccount ?? defaultOpenRouterVirtualAccount(),
      adapterForModel: input.openRouterAdapterForModel
    },
    qianfan: {
      account: input.qianfanAccount ?? defaultQianfanVirtualAccount(),
      adapterForModel: input.qianfanAdapterForModel ?? (() => null)
    },
    aliyun: {
      account: input.aliyunAccount ?? defaultAliyunVirtualAccount(),
      adapterForModel: input.aliyunAdapterForModel ?? (() => null)
    },
    tencent: {
      account: input.tencentAccount ?? defaultTencentVirtualAccount(),
      adapterForModel: input.tencentAdapterForModel ?? (() => null)
    }
  };
  return {
    begin: (beginInput) => {
      if (beginInput.model.runtime === "codex") {
        return beginCodexRuntime(input.codexRouter, beginInput);
      }
      if (beginInput.model.runtime === "pool") {
        return beginPoolRuntime(input.poolRouterForModel?.(beginInput.model) ?? null, beginInput);
      }

      const externalRuntime = externalRuntimes[beginInput.model.runtime];
      const adapter = externalRuntime.adapterForModel(beginInput.model);
      if (!adapter) {
        return new GatewayError({
          code: "model_not_found",
          message: `Model '${beginInput.model.id}' does not exist.`,
          httpStatus: 404
        });
      }
      const virtualAccount = externalRuntime.account;
      const session = beginInput.createSession(beginInput.subject.id, virtualAccount.id);
      return {
        publicModelId: beginInput.model.id,
        runtime: beginInput.model.runtime,
        runtimeInstanceId: virtualAccount.id,
        providerKind: virtualAccount.provider,
        upstreamModel: beginInput.model.upstreamModel,
        reasoningEffort: beginInput.reasoningEffort,
        limits: {
          contextWindow: beginInput.model.contextWindow,
          maxOutputTokens: beginInput.model.maxOutputTokens
        },
        adapter,
        adapterInputUpstreamAccount: virtualAccount,
        subject: beginInput.subject,
        scope: beginInput.scope,
        session,
        release: () => undefined,
        recordSuccess: () => undefined,
        recordError: () => false
      };
    }
  };
}

function beginPoolRuntime(
  router: UpstreamAccountRouter | null,
  input: RuntimeBeginInput,
  excludeAccountIds?: Iterable<string>
): ChatRuntimeContext | GatewayError {
  if (!router || !input.model.pool) {
    return new GatewayError({
      code: "model_not_found",
      message: `Model '${input.model.id}' does not exist.`,
      httpStatus: 404
    });
  }
  const lease = router.beginStateless({
    affinityKey: input.affinityKey,
    excludeAccountIds
  });
  if (lease instanceof GatewayError) {
    return lease;
  }
  const member = input.model.pool.members.find(
    (candidate) => candidate.id === lease.upstreamAccount.id
  );
  if (!member) {
    lease.release();
    return new GatewayError({
      code: "upstream_unavailable",
      message: "MedCode service is temporarily unavailable.",
      httpStatus: 503
    });
  }
  return contextFromLease({
    router,
    lease,
    input,
    runtime: member.runtime,
    upstreamModel: member.upstreamModel,
    reasoningEffort: poolMemberReasoningEffort(input, member),
    beginRetry: (retryInput) => beginPoolRuntime(router, input, retryInput.excludeAccountIds)
  });
}

function beginCodexRuntime(
  router: UpstreamAccountRouter,
  input: RuntimeBeginInput,
  excludeAccountIds?: Iterable<string>
): ChatRuntimeContext | GatewayError {
  const lease = router.beginStateless({
    affinityKey: input.affinityKey,
    excludeAccountIds
  });
  if (lease instanceof GatewayError) {
    return lease;
  }
  return contextFromLease({
    router,
    lease,
    input,
    runtime: "codex",
    upstreamModel: input.model.upstreamModel,
    reasoningEffort: input.reasoningEffort,
    beginRetry: (retryInput) => beginCodexRuntime(router, input, retryInput.excludeAccountIds)
  });
}

function contextFromLease(input: {
  router: UpstreamAccountRouter;
  lease: UpstreamAccountLease;
  input: RuntimeBeginInput;
  runtime: UpstreamRuntimeKind;
  upstreamModel: string;
  reasoningEffort: string | null;
  beginRetry(input: { excludeAccountIds: Iterable<string> }): ChatRuntimeContext | GatewayError;
}): ChatRuntimeContext {
  const { router, lease } = input;
  const beginInput = input.input;
  const session = beginInput.createSession(beginInput.subject.id, lease.upstreamAccount.id);
  return {
    publicModelId: beginInput.model.id,
    runtime: input.runtime,
    runtimeInstanceId: lease.upstreamAccount.id,
    providerKind: lease.upstreamAccount.provider,
    upstreamModel: input.upstreamModel,
    reasoningEffort: input.reasoningEffort,
    limits: {
      contextWindow: beginInput.model.contextWindow,
      maxOutputTokens: beginInput.model.maxOutputTokens
    },
    adapter: lease.provider,
    adapterInputUpstreamAccount: lease.upstreamAccount,
    subject: beginInput.subject,
    scope: beginInput.scope,
    session,
    release: () => lease.release(),
    recordSuccess: () => {
      router.recordOutcome(lease.upstreamAccount.id, "success");
    },
    recordError: (error) => {
      const outcome = upstreamOutcomeFromError(error);
      if (!outcome) {
        return false;
      }
      router.recordOutcome(lease.upstreamAccount.id, outcome);
      return true;
    },
    beginRetry: input.beginRetry
  };
}

export function publicModelPoolAffinityKey(
  model: PublicModelConfig,
  values: PublicModelPoolAffinityValues
): string | null {
  if (model.runtime !== "pool") {
    return null;
  }
  for (const key of model.pool?.selection.stickyKeyOrder ?? []) {
    const value = values[key]?.trim();
    if (value) {
      return `${key}:${value}`;
    }
  }
  return null;
}

export function requestAffinityKey(
  input: {
    credentialId: string | null;
    subjectId: string;
  },
  mode: UpstreamSoftAffinity
): string | null {
  if (mode === "none") {
    return null;
  }
  return mode === "credential" ? input.credentialId : input.subjectId;
}

function poolMemberReasoningEffort(
  input: RuntimeBeginInput,
  member: PublicModelPoolMemberConfig
): string | null {
  if (input.reasoningEffortSource === "request") {
    return input.reasoningEffort;
  }
  return reasoningEffortFromConfig(member.reasoning) ?? input.reasoningEffort;
}

function reasoningEffortFromConfig(reasoning: Record<string, unknown> | undefined): string | null {
  const effort = reasoning?.effort;
  return typeof effort === "string" && effort.length > 0 ? effort : null;
}

function upstreamOutcomeFromError(error: GatewayError): UpstreamAccountOutcome | null {
  if (error.code === "provider_reauth_required") {
    return "provider_reauth_required";
  }
  if (error.code === "rate_limited") {
    return "rate_limited";
  }
  if (
    error.code === "service_unavailable" ||
    error.code === "upstream_unavailable" ||
    error.code === "upstream_timeout"
  ) {
    return "service_error";
  }
  return null;
}

function defaultOpenRouterVirtualAccount(): UpstreamAccount {
  return {
    id: "openrouter-main",
    provider: "openrouter",
    label: "OpenRouter Main",
    credentialRef: "ENV:MEDCODE_OPENROUTER_API_KEY",
    state: "active",
    lastUsedAt: null,
    cooldownUntil: null
  };
}

function defaultQianfanVirtualAccount(): UpstreamAccount {
  return {
    id: "qianfan-main",
    provider: "qianfan",
    label: "Qianfan Main",
    credentialRef: "ENV:MEDCODE_QIANFAN_API_KEY",
    state: "active",
    lastUsedAt: null,
    cooldownUntil: null
  };
}

function defaultAliyunVirtualAccount(): UpstreamAccount {
  return {
    id: "aliyun-main",
    provider: "aliyun",
    label: "Aliyun Token Plan Main",
    credentialRef: "ENV:MEDCODE_ALIYUN_DASHSCOPE_API_KEY",
    state: "active",
    lastUsedAt: null,
    cooldownUntil: null
  };
}

function defaultTencentVirtualAccount(): UpstreamAccount {
  return {
    id: "tencent-main",
    provider: "tencent",
    label: "Tencent TokenHub Main",
    credentialRef: "ENV:MEDCODE_TENCENT_TOKENHUB_API_KEY",
    state: "active",
    lastUsedAt: null,
    cooldownUntil: null
  };
}
