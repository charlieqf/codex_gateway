import { type CredentialAuthStore } from "@codex-gateway/core";
import type { GatewayAuthMode } from "../gateway-options.js";
import { parseImagePrimaryProvider } from "./image-providers.js";

export function resolveAuthMode(input: {
  configured?: GatewayAuthMode;
  accessToken?: string;
  credentialStore?: CredentialAuthStore;
}): GatewayAuthMode {
  if (input.configured) {
    return input.configured;
  }
  if (input.credentialStore) {
    return "credential";
  }
  return "dev";
}

export function validateAuthModeForEnvironment(authMode: GatewayAuthMode, nodeEnv: string | undefined) {
  if (nodeEnv === "production" && authMode === "dev") {
    throw new Error("Dev auth mode is not allowed when NODE_ENV=production.");
  }
}

export function validateRuntimeEnvironment(env: NodeJS.ProcessEnv) {
  if (env.NODE_ENV !== "production") {
    return;
  }

  if (env.GATEWAY_AUTH_MODE !== "credential") {
    throw new Error("Production runtime requires GATEWAY_AUTH_MODE=credential.");
  }
  if (!env.GATEWAY_SQLITE_PATH) {
    throw new Error("Production runtime requires GATEWAY_SQLITE_PATH.");
  }
  if (!env.CODEX_HOME && !env.GATEWAY_UPSTREAM_ACCOUNTS_JSON) {
    throw new Error("Production runtime requires CODEX_HOME or GATEWAY_UPSTREAM_ACCOUNTS_JSON.");
  }
  if (env.GATEWAY_DEV_ACCESS_TOKEN) {
    throw new Error("Production runtime must not set GATEWAY_DEV_ACCESS_TOKEN.");
  }
  if (env.MEDCODE_IMAGE_GENERATION_ENABLED === "1") {
    const imagePrimaryProvider = parseImagePrimaryProvider(env.MEDCODE_IMAGE_PRIMARY_PROVIDER);
    if (imagePrimaryProvider === "llada" && !env.MEDCODE_IMAGE_LLADA_API_KEY) {
      throw new Error("Production LLaDA image generation requires MEDCODE_IMAGE_LLADA_API_KEY.");
    }
    if (imagePrimaryProvider === "openai" && !env.MEDCODE_IMAGE_OPENAI_API_KEY) {
      throw new Error("Production OpenAI image generation requires MEDCODE_IMAGE_OPENAI_API_KEY.");
    }
  }
  if (Boolean(env.GATEWAY_UPSTREAM_V2_BASE_URL) !== Boolean(env.GATEWAY_UPSTREAM_V2_TOKEN)) {
    throw new Error("Production upstream v2 config requires GATEWAY_UPSTREAM_V2_BASE_URL and GATEWAY_UPSTREAM_V2_TOKEN together.");
  }
  if (env.GATEWAY_BILLING_ADMIN_TOKEN) {
    if (!env.GATEWAY_API_KEY_ENCRYPTION_SECRET) {
      throw new Error("Production billing admin API requires GATEWAY_API_KEY_ENCRYPTION_SECRET.");
    }
  }
}
