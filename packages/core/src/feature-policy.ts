import { isRecord } from "./utils.js";

export const gatewayCapabilities = ["chat", "tools", "image_generation"] as const;

export type GatewayCapability = (typeof gatewayCapabilities)[number];

export interface ImageGenerationFeaturePolicy {
  enabled: boolean;
  allowedModels: string[];
  defaultModel: string;
  allowedSizes: string[];
  allowedQualities: string[];
  allowedFormats: string[];
}

export interface FeaturePolicy {
  capabilities: GatewayCapability[];
  imageGeneration: ImageGenerationFeaturePolicy | null;
}

export function defaultFeaturePolicy(): FeaturePolicy {
  return {
    capabilities: ["chat", "tools"],
    imageGeneration: null
  };
}

export function defaultImageGenerationFeaturePolicy(): ImageGenerationFeaturePolicy {
  return {
    enabled: true,
    allowedModels: ["medcode-image-default"],
    defaultModel: "medcode-image-default",
    allowedSizes: ["1024x1024", "1024x1536", "1536x1024", "auto"],
    allowedQualities: ["low", "medium", "high", "auto"],
    allowedFormats: ["jpeg", "webp", "png"]
  };
}

export function validateFeaturePolicy(input: unknown): FeaturePolicy {
  if (!isRecord(input)) {
    throw new Error("Feature policy must be a JSON object.");
  }

  const capabilities = parseCapabilities(input.capabilities);
  const imagePolicyInput = input.imageGeneration ?? input.image_generation;
  const imageGeneration =
    imagePolicyInput === undefined
      ? capabilities.includes("image_generation")
        ? defaultImageGenerationFeaturePolicy()
        : null
      : parseImageGenerationFeaturePolicy(imagePolicyInput);

  if (imageGeneration && !capabilities.includes("image_generation")) {
    throw new Error("Feature policy imageGeneration requires capability image_generation.");
  }

  return {
    capabilities,
    imageGeneration
  };
}

export function publicFeaturePolicy(policy: FeaturePolicy) {
  return {
    capabilities: policy.capabilities,
    ...(policy.imageGeneration
      ? {
          image_generation: {
            enabled: policy.imageGeneration.enabled,
            allowed_models: policy.imageGeneration.allowedModels,
            default_model: policy.imageGeneration.defaultModel,
            allowed_sizes: policy.imageGeneration.allowedSizes,
            allowed_qualities: policy.imageGeneration.allowedQualities,
            allowed_formats: policy.imageGeneration.allowedFormats
          }
        }
      : {})
  };
}

function parseCapabilities(value: unknown): GatewayCapability[] {
  if (value === undefined) {
    return defaultFeaturePolicy().capabilities;
  }
  if (!Array.isArray(value)) {
    throw new Error("Feature policy capabilities must be an array.");
  }
  const capabilities: GatewayCapability[] = [];
  for (const item of value) {
    if (!gatewayCapabilities.includes(item as GatewayCapability)) {
      throw new Error(`Unsupported feature capability: ${String(item)}`);
    }
    if (!capabilities.includes(item as GatewayCapability)) {
      capabilities.push(item as GatewayCapability);
    }
  }
  if (capabilities.length === 0) {
    throw new Error("Feature policy capabilities must not be empty.");
  }
  return capabilities;
}

function parseImageGenerationFeaturePolicy(input: unknown): ImageGenerationFeaturePolicy {
  if (!isRecord(input)) {
    throw new Error("Feature policy imageGeneration must be a JSON object.");
  }
  const defaults = defaultImageGenerationFeaturePolicy();
  const enabled = input.enabled === undefined ? defaults.enabled : parseBoolean(input.enabled, "enabled");
  const allowedModels = parseStringList(
    input.allowedModels ?? input.allowed_models,
    defaults.allowedModels,
    "allowedModels"
  );
  const defaultModel = parseString(
    input.defaultModel ?? input.default_model,
    defaults.defaultModel,
    "defaultModel"
  );
  if (!allowedModels.includes(defaultModel)) {
    throw new Error("Feature policy defaultModel must be included in allowedModels.");
  }

  return {
    enabled,
    allowedModels,
    defaultModel,
    allowedSizes: parseStringList(
      input.allowedSizes ?? input.allowed_sizes,
      defaults.allowedSizes,
      "allowedSizes"
    ),
    allowedQualities: parseStringList(
      input.allowedQualities ?? input.allowed_qualities,
      defaults.allowedQualities,
      "allowedQualities"
    ),
    allowedFormats: parseStringList(
      input.allowedFormats ?? input.allowed_formats,
      defaults.allowedFormats,
      "allowedFormats"
    )
  };
}

function parseBoolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`Feature policy ${name} must be a boolean.`);
  }
  return value;
}

function parseString(value: unknown, fallback: string, name: string): string {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Feature policy ${name} must be a non-empty string.`);
  }
  return value;
}

function parseStringList(value: unknown, fallback: string[], name: string): string[] {
  if (value === undefined) {
    return fallback;
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`Feature policy ${name} must be a non-empty string array.`);
  }
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.length === 0) {
      throw new Error(`Feature policy ${name} must contain only non-empty strings.`);
    }
    if (!result.includes(item)) {
      result.push(item);
    }
  }
  return result;
}
