import { readFileSync } from "node:fs";
import {
  GeminiImageGenerationProvider,
  LLaDAImageGenerationProvider,
  OpenAIImageGenerationProvider,
  XAIImageGenerationProvider,
  type ImageGenerationProvider
} from "../image-generation.js";
import {
  type UpstreamAccountConfigLogger,
  type ParsedUpstreamAccountConfig
} from "../services/upstream-account-router.js";
import { parsePositiveIntegerEnv } from "./env.js";
import type { GatewayOptions } from "../gateway-options.js";

const defaultImageBillingFallbackModel = "gpt-image-1.5";

const defaultXAIImageBillingFallbackModel = "grok-imagine-image-quality";

const defaultGeminiImageBillingFallbackModel = "gemini-3.1-flash-image";

const imageBillingFallbackAccountId = "image-billing-fallback";

export interface ImageGenerationBillingFallback {
  accountId: string;
  provider: ImageGenerationProvider;
  upstreamModel: string;
}

export function createDefaultImageGenerationProvider(
  env: NodeJS.ProcessEnv
): ImageGenerationProvider | undefined {
  if (env.MEDCODE_IMAGE_GENERATION_ENABLED !== "1") {
    return undefined;
  }
  const primaryProvider = parseImagePrimaryProvider(env.MEDCODE_IMAGE_PRIMARY_PROVIDER);
  if (primaryProvider === "llada") {
    if (!env.MEDCODE_IMAGE_LLADA_API_KEY) {
      throw new Error(
        "MEDCODE_IMAGE_LLADA_API_KEY is required when LLaDA image generation is primary."
      );
    }
    return new LLaDAImageGenerationProvider({
      apiKey: env.MEDCODE_IMAGE_LLADA_API_KEY,
      baseUrl: env.MEDCODE_IMAGE_LLADA_BASE_URL,
      timeoutMs: parsePositiveIntegerEnv(
        env.MEDCODE_IMAGE_LLADA_TIMEOUT_MS ?? env.MEDCODE_IMAGE_TIMEOUT_MS,
        240_000,
        "MEDCODE_IMAGE_LLADA_TIMEOUT_MS"
      )
    });
  }
  if (!env.MEDCODE_IMAGE_OPENAI_API_KEY) {
    throw new Error("MEDCODE_IMAGE_OPENAI_API_KEY is required when OpenAI image generation is primary.");
  }
  return new OpenAIImageGenerationProvider({
    apiKey: env.MEDCODE_IMAGE_OPENAI_API_KEY,
    baseUrl: env.MEDCODE_IMAGE_OPENAI_BASE_URL,
    timeoutMs: parsePositiveIntegerEnv(
      env.MEDCODE_IMAGE_TIMEOUT_MS,
      180_000,
      "MEDCODE_IMAGE_TIMEOUT_MS"
    )
  });
}

export function parseImagePrimaryProvider(value: string | undefined): "openai" | "llada" {
  const normalized = value?.trim().toLowerCase() || "openai";
  if (normalized === "openai" || normalized === "llada") {
    return normalized;
  }
  throw new Error("MEDCODE_IMAGE_PRIMARY_PROVIDER must be openai or llada.");
}

export function resolveImageGenerationBillingFallbacks(
  options: GatewayOptions,
  env: NodeJS.ProcessEnv,
  logger: UpstreamAccountConfigLogger
): ImageGenerationBillingFallback[] {
  if (options.imageGenerationBillingFallbacks !== undefined) {
    return options.imageGenerationBillingFallbacks.map((fallback, index) => ({
      accountId: fallback.accountId ?? `${imageBillingFallbackAccountId}-${index + 1}`,
      provider: fallback.provider,
      upstreamModel: fallback.upstreamModel ?? defaultImageBillingFallbackModel
    }));
  }
  if (options.imageGenerationBillingFallbackProvider !== undefined) {
    return options.imageGenerationBillingFallbackProvider
      ? [
          {
            accountId: imageBillingFallbackAccountId,
            provider: options.imageGenerationBillingFallbackProvider,
            upstreamModel:
              options.imageGenerationBillingFallbackModel ?? defaultImageBillingFallbackModel
          }
        ]
      : [];
  }
  return createDefaultImageGenerationBillingFallbacks(env, logger);
}

function createDefaultImageGenerationBillingFallbacks(
  env: NodeJS.ProcessEnv,
  logger: UpstreamAccountConfigLogger
): ImageGenerationBillingFallback[] {
  if (env.MEDCODE_IMAGE_GENERATION_ENABLED !== "1") {
    return [];
  }
  const fallbacks: ImageGenerationBillingFallback[] = [];
  if (
    parseImagePrimaryProvider(env.MEDCODE_IMAGE_PRIMARY_PROVIDER) === "llada" &&
    env.MEDCODE_IMAGE_OPENAI_API_KEY?.trim()
  ) {
    fallbacks.push({
      accountId: `${imageBillingFallbackAccountId}-gpt-image-2`,
      provider: new OpenAIImageGenerationProvider({
        apiKey: env.MEDCODE_IMAGE_OPENAI_API_KEY,
        baseUrl: env.MEDCODE_IMAGE_OPENAI_BASE_URL,
        timeoutMs: parsePositiveIntegerEnv(
          env.MEDCODE_IMAGE_TIMEOUT_MS,
          180_000,
          "MEDCODE_IMAGE_TIMEOUT_MS"
        )
      }),
      upstreamModel: parseImageBillingFallbackModel(
        env.MEDCODE_IMAGE_OPENAI_MODEL,
        "gpt-image-2",
        "MEDCODE_IMAGE_OPENAI_MODEL"
      )
    });
  }
  const apiKey = env.MEDCODE_IMAGE_BILLING_FALLBACK_OPENAI_API_KEY?.trim();
  if (apiKey) {
    fallbacks.push({
      accountId: imageBillingFallbackAccountId,
      provider: new OpenAIImageGenerationProvider({
        apiKey,
        baseUrl:
          env.MEDCODE_IMAGE_BILLING_FALLBACK_OPENAI_BASE_URL ??
          env.MEDCODE_IMAGE_OPENAI_BASE_URL,
        timeoutMs: parsePositiveIntegerEnv(
          env.MEDCODE_IMAGE_BILLING_FALLBACK_TIMEOUT_MS ?? env.MEDCODE_IMAGE_TIMEOUT_MS,
          180_000,
          "MEDCODE_IMAGE_BILLING_FALLBACK_TIMEOUT_MS"
        )
      }),
      upstreamModel: parseImageBillingFallbackModel(
        env.MEDCODE_IMAGE_BILLING_FALLBACK_MODEL,
        defaultImageBillingFallbackModel,
        "MEDCODE_IMAGE_BILLING_FALLBACK_MODEL"
      )
    });
  }
  fallbacks.push(...createExtraImageGenerationBillingFallbacks(env, logger));
  return fallbacks;
}

function createExtraImageGenerationBillingFallbacks(
  env: NodeJS.ProcessEnv,
  logger: UpstreamAccountConfigLogger
): ImageGenerationBillingFallback[] {
  const keysFile = env.MEDCODE_IMAGE_BILLING_FALLBACK_KEYS_FILE?.trim();
  if (!keysFile) {
    return [];
  }
  const entries = parseImageBillingFallbackKeysFile(keysFile);
  const counters = new Map<string, number>();
  const fallbacks = entries.map((entry) => {
    const next = (counters.get(entry.provider) ?? 0) + 1;
    counters.set(entry.provider, next);
    return createExtraImageGenerationBillingFallback(entry.provider, entry.apiKey, next, env);
  });
  logger.info(
    {
      image_billing_fallback_keys_file: keysFile,
      image_billing_fallback_count: fallbacks.length,
      image_billing_fallback_providers: entries.map((entry) => entry.provider)
    },
    "Configured extra image billing fallback providers."
  );
  return fallbacks;
}

function createExtraImageGenerationBillingFallback(
  provider: ImageBillingFallbackProviderKind,
  apiKey: string,
  index: number,
  env: NodeJS.ProcessEnv
): ImageGenerationBillingFallback {
  if (provider === "openai") {
    return {
      accountId: `${imageBillingFallbackAccountId}-openai-${index}`,
      provider: new OpenAIImageGenerationProvider({
        apiKey,
        baseUrl:
          env.MEDCODE_IMAGE_BILLING_FALLBACK_EXTRA_OPENAI_BASE_URL ??
          env.MEDCODE_IMAGE_OPENAI_BASE_URL,
        timeoutMs: parsePositiveIntegerEnv(
          env.MEDCODE_IMAGE_BILLING_FALLBACK_OPENAI_TIMEOUT_MS ??
            env.MEDCODE_IMAGE_BILLING_FALLBACK_TIMEOUT_MS ??
            env.MEDCODE_IMAGE_TIMEOUT_MS,
          180_000,
          "MEDCODE_IMAGE_BILLING_FALLBACK_OPENAI_TIMEOUT_MS"
        )
      }),
      upstreamModel: parseImageBillingFallbackModel(
        env.MEDCODE_IMAGE_BILLING_FALLBACK_OPENAI_MODEL ??
          env.MEDCODE_IMAGE_BILLING_FALLBACK_MODEL,
        defaultImageBillingFallbackModel,
        "MEDCODE_IMAGE_BILLING_FALLBACK_OPENAI_MODEL"
      )
    };
  }
  if (provider === "xai") {
    return {
      accountId: `${imageBillingFallbackAccountId}-xai-${index}`,
      provider: new XAIImageGenerationProvider({
        apiKey,
        baseUrl: env.MEDCODE_IMAGE_BILLING_FALLBACK_XAI_BASE_URL,
        timeoutMs: parsePositiveIntegerEnv(
          env.MEDCODE_IMAGE_BILLING_FALLBACK_XAI_TIMEOUT_MS ??
            env.MEDCODE_IMAGE_BILLING_FALLBACK_TIMEOUT_MS ??
            env.MEDCODE_IMAGE_TIMEOUT_MS,
          180_000,
          "MEDCODE_IMAGE_BILLING_FALLBACK_XAI_TIMEOUT_MS"
        ),
        resolution: parseXAIImageResolution(env.MEDCODE_IMAGE_BILLING_FALLBACK_XAI_RESOLUTION)
      }),
      upstreamModel: parseImageBillingFallbackModel(
        env.MEDCODE_IMAGE_BILLING_FALLBACK_XAI_MODEL,
        defaultXAIImageBillingFallbackModel,
        "MEDCODE_IMAGE_BILLING_FALLBACK_XAI_MODEL"
      )
    };
  }
  return {
    accountId: `${imageBillingFallbackAccountId}-gemini-${index}`,
    provider: new GeminiImageGenerationProvider({
      apiKey,
      baseUrl: env.MEDCODE_IMAGE_BILLING_FALLBACK_GEMINI_BASE_URL,
      timeoutMs: parsePositiveIntegerEnv(
        env.MEDCODE_IMAGE_BILLING_FALLBACK_GEMINI_TIMEOUT_MS ??
          env.MEDCODE_IMAGE_BILLING_FALLBACK_TIMEOUT_MS ??
          env.MEDCODE_IMAGE_TIMEOUT_MS,
        180_000,
        "MEDCODE_IMAGE_BILLING_FALLBACK_GEMINI_TIMEOUT_MS"
      ),
      imageSize: parseGeminiImageSize(env.MEDCODE_IMAGE_BILLING_FALLBACK_GEMINI_IMAGE_SIZE)
    }),
    upstreamModel: parseImageBillingFallbackModel(
      env.MEDCODE_IMAGE_BILLING_FALLBACK_GEMINI_MODEL,
      defaultGeminiImageBillingFallbackModel,
      "MEDCODE_IMAGE_BILLING_FALLBACK_GEMINI_MODEL"
    )
  };
}

type ImageBillingFallbackProviderKind = "openai" | "xai" | "gemini";

export function parseImageBillingFallbackKeysFile(path: string): Array<{
  provider: ImageBillingFallbackProviderKind;
  apiKey: string;
}> {
  const content = readFileSync(path, "utf8");
  const entries: Array<{ provider: ImageBillingFallbackProviderKind; apiKey: string }> = [];
  const lines = content.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const separator = line.indexOf(":");
    if (separator <= 0) {
      throw new Error(
        `MEDCODE_IMAGE_BILLING_FALLBACK_KEYS_FILE line ${index + 1} must use provider:key format.`
      );
    }
    const provider = parseImageBillingFallbackProviderKind(
      line.slice(0, separator).trim(),
      index + 1
    );
    const apiKey = line.slice(separator + 1).trim();
    if (!apiKey) {
      throw new Error(
        `MEDCODE_IMAGE_BILLING_FALLBACK_KEYS_FILE line ${index + 1} has an empty key.`
      );
    }
    entries.push({ provider, apiKey });
  }
  return entries;
}

function parseImageBillingFallbackProviderKind(
  value: string,
  lineNumber: number
): ImageBillingFallbackProviderKind {
  const normalized = value.toLowerCase();
  if (normalized === "openai" || normalized === "xai" || normalized === "gemini") {
    return normalized;
  }
  throw new Error(
    `MEDCODE_IMAGE_BILLING_FALLBACK_KEYS_FILE line ${lineNumber} has unsupported provider: ${value}.`
  );
}

function parseImageBillingFallbackModel(
  value: string | undefined,
  fallback: string,
  envName: string
): string {
  const model = value?.trim() || fallback;
  if (!model) {
    throw new Error(`${envName} must be a non-empty string.`);
  }
  return model;
}

function parseXAIImageResolution(value: string | undefined): "1k" | "2k" | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized === "1k" || normalized === "2k") {
    return normalized;
  }
  throw new Error("MEDCODE_IMAGE_BILLING_FALLBACK_XAI_RESOLUTION must be 1k or 2k.");
}

function parseGeminiImageSize(value: string | undefined): "512" | "1K" | "2K" | "4K" | undefined {
  const normalized = value?.trim();
  if (!normalized) {
    return undefined;
  }
  if (normalized === "512" || normalized === "1K" || normalized === "2K" || normalized === "4K") {
    return normalized;
  }
  throw new Error("MEDCODE_IMAGE_BILLING_FALLBACK_GEMINI_IMAGE_SIZE must be 512, 1K, 2K, or 4K.");
}

export function createImageProviderForAccount(
  config: ParsedUpstreamAccountConfig,
  env: NodeJS.ProcessEnv,
  logger: UpstreamAccountConfigLogger
): ImageGenerationProvider | null {
  if (!config.imageApiKeyEnv) {
    return null;
  }
  if (env.MEDCODE_IMAGE_GENERATION_ENABLED !== "1") {
    logger.info(
      { upstream_account_id: config.id, image_api_key_env: config.imageApiKeyEnv },
      "Image key declared for upstream account but image generation is disabled."
    );
    return null;
  }
  const apiKey = env[config.imageApiKeyEnv]?.trim();
  if (!apiKey) {
    logger.warn?.(
      { upstream_account_id: config.id, image_api_key_env: config.imageApiKeyEnv },
      "Image key env for upstream account is missing or empty."
    );
    return null;
  }
  logger.info(
    { upstream_account_id: config.id, image_api_key_env: config.imageApiKeyEnv },
    "Image key configured for upstream account."
  );
  return new OpenAIImageGenerationProvider({
    apiKey,
    baseUrl: config.imageBaseUrlEnv
      ? env[config.imageBaseUrlEnv]
      : env.MEDCODE_IMAGE_OPENAI_BASE_URL,
    timeoutMs:
      config.imageTimeoutMs ??
      parsePositiveIntegerEnv(
        env.MEDCODE_IMAGE_TIMEOUT_MS,
        180_000,
        "MEDCODE_IMAGE_TIMEOUT_MS"
      )
  });
}
