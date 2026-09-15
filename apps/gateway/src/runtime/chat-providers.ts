import { type ProviderAdapter, type ProviderHealth, type UpstreamAccount } from "@codex-gateway/core";
import { OpenAICompatibleProviderAdapter } from "../services/openai-compatible-provider.js";
import { resolveProviderApiKey } from "../services/provider-secret.js";
import {
  providerReasoningSettings,
  type OpenAICompatibleRuntimeKind,
  type PublicModelConfig
} from "../services/public-model-registry.js";
import { parsePositiveIntegerEnv } from "./env.js";
import { parseImageBillingFallbackKeysFile } from "./image-providers.js";

export type OpenAICompatibleAdapterMap = Map<string, ProviderAdapter>;

interface OpenAICompatibleAdapterTarget {
  id: string;
  publicModelId: string;
  runtime: OpenAICompatibleRuntimeKind;
  upstreamModel: string;
  reasoning?: Record<string, unknown>;
}

export function createOpenRouterAdapters(
  models: PublicModelConfig[],
  env: NodeJS.ProcessEnv,
  logger?: { warn: (obj: Record<string, unknown>, msg: string) => void }
): OpenAICompatibleAdapterMap {
  return createOpenAICompatibleAdapters({
    models,
    env,
    logger,
    runtime: "openrouter",
    providerKind: "openrouter",
    displayName: "OpenRouter",
    apiKeyEnvName: env.MEDCODE_OPENROUTER_API_KEY_ENV?.trim() || "MEDCODE_OPENROUTER_API_KEY",
    baseUrl: env.MEDCODE_OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1",
    timeoutMs: parsePositiveIntegerEnv(
      env.MEDCODE_OPENROUTER_TIMEOUT_MS,
      300_000,
      "MEDCODE_OPENROUTER_TIMEOUT_MS"
    ),
    reasoningForTarget: (target) => target.reasoning ?? { effort: "none" },
    siteUrl: env.MEDCODE_OPENROUTER_SITE_URL,
    appTitle: env.MEDCODE_OPENROUTER_APP_TITLE ?? "MedCode"
  });
}

export function createQianfanAdapters(
  models: PublicModelConfig[],
  env: NodeJS.ProcessEnv,
  logger?: { warn: (obj: Record<string, unknown>, msg: string) => void }
): OpenAICompatibleAdapterMap {
  return createOpenAICompatibleAdapters({
    models,
    env,
    logger,
    runtime: "qianfan",
    providerKind: "qianfan",
    displayName: "Qianfan",
    apiKeyEnvName: env.MEDCODE_QIANFAN_API_KEY_ENV?.trim() || "MEDCODE_QIANFAN_API_KEY",
    baseUrl: env.MEDCODE_QIANFAN_BASE_URL ?? "https://qianfan.baidubce.com/v2/tokenplan/team",
    timeoutMs: parsePositiveIntegerEnv(
      env.MEDCODE_QIANFAN_TIMEOUT_MS,
      300_000,
      "MEDCODE_QIANFAN_TIMEOUT_MS"
    ),
    reasoningForTarget: (target) => target.reasoning
  });
}

export function createAliyunAdapters(
  models: PublicModelConfig[],
  env: NodeJS.ProcessEnv,
  logger?: { warn: (obj: Record<string, unknown>, msg: string) => void }
): OpenAICompatibleAdapterMap {
  return createOpenAICompatibleAdapters({
    models,
    env,
    logger,
    runtime: "aliyun",
    providerKind: "aliyun",
    displayName: "Aliyun Token Plan",
    apiKeyEnvName:
      env.MEDCODE_ALIYUN_TOKEN_PLAN_API_KEY_ENV?.trim() ||
      env.MEDCODE_ALIYUN_API_KEY_ENV?.trim() ||
      "MEDCODE_ALIYUN_DASHSCOPE_API_KEY",
    baseUrl:
      env.MEDCODE_ALIYUN_TOKEN_PLAN_BASE_URL ??
      env.MEDCODE_ALIYUN_DASHSCOPE_BASE_URL ??
      "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
    timeoutMs: parsePositiveIntegerEnv(
      env.MEDCODE_ALIYUN_TOKEN_PLAN_TIMEOUT_MS ?? env.MEDCODE_ALIYUN_DASHSCOPE_TIMEOUT_MS,
      300_000,
      "MEDCODE_ALIYUN_TOKEN_PLAN_TIMEOUT_MS"
    ),
    reasoningForTarget: (target) => target.reasoning ?? { effort: "none" },
    reasoningParameterStyle: "effort_field"
  });
}

export function createTencentAdapters(
  models: PublicModelConfig[],
  env: NodeJS.ProcessEnv,
  logger?: { warn: (obj: Record<string, unknown>, msg: string) => void }
): OpenAICompatibleAdapterMap {
  return createOpenAICompatibleAdapters({
    models,
    env,
    logger,
    runtime: "tencent",
    providerKind: "tencent",
    displayName: "Tencent TokenHub",
    apiKeyEnvName:
      env.MEDCODE_TENCENT_TOKENHUB_API_KEY_ENV?.trim() ||
      env.MEDCODE_TENCENT_API_KEY_ENV?.trim() ||
      "MEDCODE_TENCENT_TOKENHUB_API_KEY",
    baseUrl: env.MEDCODE_TENCENT_TOKENHUB_BASE_URL ?? "https://tokenhub.tencentmaas.com/plan/v3",
    timeoutMs: parsePositiveIntegerEnv(
      env.MEDCODE_TENCENT_TOKENHUB_TIMEOUT_MS,
      300_000,
      "MEDCODE_TENCENT_TOKENHUB_TIMEOUT_MS"
    ),
    reasoningForTarget: (target) => target.reasoning ?? { effort: "none" },
    reasoningParameterStyle: "effort_field"
  });
}

export function createTiankuanAdapters(
  models: PublicModelConfig[],
  env: NodeJS.ProcessEnv,
  logger?: { warn: (obj: Record<string, unknown>, msg: string) => void }
): OpenAICompatibleAdapterMap {
  return createOpenAICompatibleAdapters({
    models,
    env,
    logger,
    runtime: "tiankuan",
    providerKind: "tiankuan",
    displayName: "TianKuan",
    apiKeyEnvName:
      env.MEDCODE_TIANKUAN_API_KEY_ENV?.trim() || "MEDCODE_TIANKUAN_API_KEY",
    baseUrl: env.MEDCODE_TIANKUAN_BASE_URL ?? "https://tokens.tiankuan.com/v1",
    timeoutMs: parsePositiveIntegerEnv(
      env.MEDCODE_TIANKUAN_TIMEOUT_MS,
      300_000,
      "MEDCODE_TIANKUAN_TIMEOUT_MS"
    ),
    reasoningForTarget: (target) => target.reasoning ?? { effort: "none" },
    reasoningParameterStyle: "effort_field"
  });
}

export function createTokenSwitchAdapters(
  models: PublicModelConfig[],
  env: NodeJS.ProcessEnv,
  logger?: { warn: (obj: Record<string, unknown>, msg: string) => void }
): OpenAICompatibleAdapterMap {
  const baseUrl = env.MEDCODE_TOKENSWITCH_BASE_URL?.trim();
  if (!baseUrl) {
    if (openAICompatibleAdapterTargets(models, "tokenswitch").length > 0) {
      logger?.warn(
        { base_url_env: "MEDCODE_TOKENSWITCH_BASE_URL" },
        "TokenSwitch public models are configured but the Base URL env is missing; those models will not be exposed."
      );
    }
    return new Map();
  }
  return createOpenAICompatibleAdapters({
    models,
    env,
    logger,
    runtime: "tokenswitch",
    providerKind: "tokenswitch",
    displayName: "TokenSwitch",
    apiKeyEnvName:
      env.MEDCODE_TOKENSWITCH_API_KEY_ENV?.trim() || "MEDCODE_TOKENSWITCH_API_KEY",
    baseUrl,
    timeoutMs: parsePositiveIntegerEnv(
      env.MEDCODE_TOKENSWITCH_TIMEOUT_MS,
      300_000,
      "MEDCODE_TOKENSWITCH_TIMEOUT_MS"
    ),
    reasoningForTarget: (target) => target.reasoning ?? { effort: "none" },
    reasoningParameterStyle: "effort_field"
  });
}

export function createLocalOpenAIAdapters(
  models: PublicModelConfig[],
  env: NodeJS.ProcessEnv,
  logger?: { warn: (obj: Record<string, unknown>, msg: string) => void }
): OpenAICompatibleAdapterMap {
  const adapters: OpenAICompatibleAdapterMap = new Map();
  const targets = openAICompatibleAdapterTargets(models, "local_openai");
  if (targets.length === 0) {
    return adapters;
  }

  const configuredBaseUrl = env.MEDCODE_LOCAL_OPENAI_BASE_URL?.trim();
  if (!configuredBaseUrl) {
    logger?.warn(
      {
        base_url_env: "MEDCODE_LOCAL_OPENAI_BASE_URL",
        public_model_ids: uniqueValues(targets.map((target) => target.publicModelId))
      },
      "Local OpenAI-compatible models are configured but the private Base URL env is missing; those models will not be exposed."
    );
    return adapters;
  }
  const baseUrl = validateLocalOpenAIBaseUrl(configuredBaseUrl);
  const apiKeyEnvName =
    env.MEDCODE_LOCAL_OPENAI_API_KEY_ENV?.trim() || "MEDCODE_LOCAL_OPENAI_API_KEY";
  const resolvedSecret = resolveProviderApiKey(env, apiKeyEnvName);
  const timeoutMs = parsePositiveIntegerEnv(
    env.MEDCODE_LOCAL_OPENAI_TIMEOUT_MS,
    900_000,
    "MEDCODE_LOCAL_OPENAI_TIMEOUT_MS"
  );

  assertUniqueOpenAICompatibleAdapterTargetIds(targets);
  for (const target of targets) {
    adapters.set(
      target.id,
      new OpenAICompatibleProviderAdapter({
        providerKind: "local-openai",
        baseUrl,
        apiKey: resolvedSecret.apiKey ?? "",
        apiKeyEnv: resolvedSecret.sourceEnvName,
        apiKeyRequired: false,
        includeIdentityGuard: false,
        preserveChatMessages: true,
        healthCheck: "models",
        upstreamModel: target.upstreamModel,
        reasoning: target.reasoning,
        reasoningParameterStyle: "effort_field",
        timeoutMs
      })
    );
  }
  return adapters;
}

function validateLocalOpenAIBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("MEDCODE_LOCAL_OPENAI_BASE_URL must be a valid private HTTP URL.");
  }
  const hostname = url.hostname.toLowerCase();
  const privateDockerHostname = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(
    hostname
  );
  const loopback = hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
  if (
    url.protocol !== "http:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (!privateDockerHostname && !loopback) ||
    url.pathname.replace(/\/+$/u, "") !== "/v1"
  ) {
    throw new Error(
      "MEDCODE_LOCAL_OPENAI_BASE_URL must target a loopback or single-label private Docker hostname with the /v1 path."
    );
  }
  return url.toString().replace(/\/+$/u, "");
}

export function createXaiVisionAdapters(
  models: PublicModelConfig[],
  env: NodeJS.ProcessEnv,
  logger?: { warn: (obj: Record<string, unknown>, msg: string) => void }
): OpenAICompatibleAdapterMap {
  const adapters: OpenAICompatibleAdapterMap = new Map();
  const targets = models.filter(
    (model) => model.enabled && model.vision?.enabled && model.vision.runtime === "xai"
  );
  if (targets.length === 0) {
    return adapters;
  }

  const apiKeyEnvName = env.MEDCODE_VISION_XAI_API_KEY_ENV?.trim() ||
    "MEDCODE_VISION_XAI_API_KEY";
  const dedicatedSecret = resolveProviderApiKey(env, apiKeyEnvName);
  let apiKey = dedicatedSecret.apiKey;
  let sourceEnvName = dedicatedSecret.sourceEnvName;
  if (!apiKey) {
    const fallbackKeysFile = env.MEDCODE_IMAGE_BILLING_FALLBACK_KEYS_FILE?.trim();
    const fallbackEntry = fallbackKeysFile
      ? parseImageBillingFallbackKeysFile(fallbackKeysFile).find(
          (entry) => entry.provider === "xai"
        )
      : undefined;
    apiKey = fallbackEntry?.apiKey ?? null;
    if (apiKey) {
      sourceEnvName = "MEDCODE_IMAGE_BILLING_FALLBACK_KEYS_FILE[xai]";
    }
  }
  if (!apiKey) {
    logger?.warn(
      {
        api_key_env: apiKeyEnvName,
        api_key_file_env: `${apiKeyEnvName}_FILE`,
        fallback_keys_file_env: "MEDCODE_IMAGE_BILLING_FALLBACK_KEYS_FILE",
        public_model_ids: targets.map((model) => model.id)
      },
      "xAI vision is configured but no xAI API key is available; image requests will be unavailable."
    );
    return adapters;
  }

  const baseUrl = env.MEDCODE_VISION_XAI_BASE_URL?.trim() || "https://api.x.ai/v1";
  const timeoutMs = parsePositiveIntegerEnv(
    env.MEDCODE_VISION_XAI_TIMEOUT_MS,
    300_000,
    "MEDCODE_VISION_XAI_TIMEOUT_MS"
  );
  for (const model of targets) {
    const vision = model.vision!;
    adapters.set(
      model.id,
      new OpenAICompatibleProviderAdapter({
        providerKind: "xai",
        baseUrl,
        apiKey,
        apiKeyEnv: sourceEnvName,
        upstreamModel: vision.upstreamModel,
        reasoning: providerReasoningSettings(vision.reasoning),
        reasoningParameterStyle: "effort_field",
        timeoutMs
      })
    );
  }
  return adapters;
}

function createOpenAICompatibleAdapters(input: {
  models: PublicModelConfig[];
  env: NodeJS.ProcessEnv;
  logger?: { warn: (obj: Record<string, unknown>, msg: string) => void };
  runtime:
    | "openrouter"
    | "qianfan"
    | "aliyun"
    | "tencent"
    | "tiankuan"
    | "tokenswitch";
  providerKind:
    | "openrouter"
    | "qianfan"
    | "aliyun"
    | "tencent"
    | "tiankuan"
    | "tokenswitch";
  displayName: string;
  apiKeyEnvName: string;
  baseUrl: string;
  timeoutMs: number;
  reasoningForTarget: (target: OpenAICompatibleAdapterTarget) => Record<string, unknown> | undefined;
  reasoningParameterStyle?: "object" | "effort_field";
  siteUrl?: string;
  appTitle?: string;
}): OpenAICompatibleAdapterMap {
  const adapters: OpenAICompatibleAdapterMap = new Map();
  const resolvedSecret = resolveProviderApiKey(input.env, input.apiKeyEnvName);
  const apiKey = resolvedSecret.apiKey;
  const enabledTargets = openAICompatibleAdapterTargets(input.models, input.runtime);
  assertUniqueOpenAICompatibleAdapterTargetIds(enabledTargets);
  if (!apiKey) {
    if (enabledTargets.length > 0) {
      input.logger?.warn(
        {
          api_key_env: input.apiKeyEnvName,
          api_key_file_env: `${input.apiKeyEnvName}_FILE`,
          public_model_ids: uniqueValues(enabledTargets.map((target) => target.publicModelId)),
          adapter_ids: enabledTargets.map((target) => target.id)
        },
        `${input.displayName} public models are configured but the API key env is missing; those models will not be exposed.`
      );
    }
    return adapters;
  }

  for (const target of enabledTargets) {
    adapters.set(
      target.id,
      new OpenAICompatibleProviderAdapter({
        providerKind: input.providerKind,
        baseUrl: input.baseUrl,
        apiKey,
        apiKeyEnv: resolvedSecret.sourceEnvName,
        upstreamModel: target.upstreamModel,
        reasoning: input.reasoningForTarget(target),
        reasoningParameterStyle: input.reasoningParameterStyle,
        siteUrl: input.siteUrl,
        appTitle: input.appTitle,
        timeoutMs: input.timeoutMs
      })
    );
  }
  return adapters;
}

function openAICompatibleAdapterTargets(
  models: PublicModelConfig[],
  runtime: OpenAICompatibleRuntimeKind
): OpenAICompatibleAdapterTarget[] {
  const targets: OpenAICompatibleAdapterTarget[] = [];
  for (const model of models) {
    if (!model.enabled) {
      continue;
    }
    if (model.runtime === runtime) {
      const reasoning = providerReasoningSettings(model.reasoning);
      targets.push({
        id: model.id,
        publicModelId: model.id,
        runtime,
        upstreamModel: model.upstreamModel,
        ...(reasoning ? { reasoning } : {})
      });
      continue;
    }
    if (model.runtime !== "pool" || !model.pool) {
      continue;
    }
    for (const member of model.pool.members) {
      if (!member.enabled || member.runtime !== runtime) {
        continue;
      }
      const reasoning = providerReasoningSettings(member.reasoning ?? model.reasoning);
      targets.push({
        id: member.id,
        publicModelId: model.id,
        runtime,
        upstreamModel: member.upstreamModel,
        ...(reasoning ? { reasoning } : {})
      });
    }
  }
  return targets;
}

function assertUniqueOpenAICompatibleAdapterTargetIds(
  targets: OpenAICompatibleAdapterTarget[]
): void {
  const seen = new Set<string>();
  for (const target of targets) {
    if (seen.has(target.id)) {
      throw new Error(`Duplicate OpenAI-compatible adapter id '${target.id}'.`);
    }
    seen.add(target.id);
  }
}

export async function localOpenAIInferenceHealth(
  models: PublicModelConfig[],
  adapters: OpenAICompatibleAdapterMap,
  account: UpstreamAccount
): Promise<ProviderHealth | null> {
  const localModels = models.filter(
    (model) => model.enabled && model.runtime === "local_openai"
  );
  if (localModels.length === 0) {
    return null;
  }
  const configuredAdapters = localModels
    .map((model) => adapters.get(model.id) ?? null)
    .filter((adapter): adapter is ProviderAdapter => adapter !== null);
  if (configuredAdapters.length !== localModels.length) {
    return {
      state: "unhealthy",
      checkedAt: new Date(),
      detail: "Local OpenAI-compatible inference is not configured."
    };
  }
  const health = await Promise.all(
    configuredAdapters.map((adapter) => adapter.health(account))
  );
  if (health.every((result) => result.state === "healthy")) {
    return {
      state: "healthy",
      checkedAt: new Date(),
      detail: "Local OpenAI-compatible inference is ready."
    };
  }
  return {
    state: health.some((result) => result.state === "unhealthy")
      ? "unhealthy"
      : "degraded",
    checkedAt: new Date(),
    detail: "Local OpenAI-compatible inference is not ready."
  };
}

export function localOpenAIInferenceRequiredForReadiness(models: PublicModelConfig[]): boolean {
  const enabledModels = models.filter((model) => model.enabled);
  return (
    enabledModels.length > 0 &&
    enabledModels.every((model) => model.runtime === "local_openai")
  );
}

function uniqueValues(values: string[]): string[] {
  return [...new Set(values)];
}
