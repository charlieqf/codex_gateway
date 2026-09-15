import { type CodexProviderOptions } from "@codex-gateway/provider-codex";
import type { GatewayAuthMode } from "../gateway-options.js";

export const maxStatelessAttempts = 2;

export function normalizeBaseUrl(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.replace(/\/+$/, "");
}

export function metadataString(metadata: Record<string, unknown> | null, key: string): string | null {
  const value = metadata?.[key];
  return typeof value === "string" ? value : null;
}

export function parsePositiveIntegerEnv(
  value: string | undefined,
  fallback: number,
  name: string
): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

export function parseRequiredPositiveIntegerEnv(
  value: string | undefined,
  name: string
): number {
  const normalized = value?.trim();
  if (!normalized) {
    throw new Error(`${name} is required when Research API is enabled.`);
  }
  if (!/^[1-9][0-9]*$/u.test(normalized)) {
    throw new Error(`${name} must be a positive integer.`);
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${name} exceeds the safe integer range.`);
  }
  return parsed;
}

export function parseRequiredNonNegativeIntegerEnv(
  value: string | undefined,
  name: string
): number {
  const normalized = value?.trim();
  if (!normalized) {
    throw new Error(`${name} is required when Research API is enabled.`);
  }
  if (!/^(?:0|[1-9][0-9]*)$/u.test(normalized)) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${name} exceeds the safe integer range.`);
  }
  return parsed;
}

export function parseOptionalPositiveInteger(value: string | undefined): number | undefined {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    return undefined;
  }
  return parsed;
}

export function parseOptionalBoolean(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes(String(value ?? "").trim().toLowerCase());
}

export function parseAuthMode(value: string | undefined): GatewayAuthMode | undefined {
  if (!value) {
    return undefined;
  }
  if (value === "dev" || value === "credential") {
    return value;
  }
  throw new Error("GATEWAY_AUTH_MODE must be dev or credential.");
}

export function parseModelReasoningEffort(
  value: string | undefined
): CodexProviderOptions["modelReasoningEffort"] | undefined {
  if (!value) {
    return undefined;
  }
  if (
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh"
  ) {
    return value;
  }
  throw new Error(
    "MEDCODE_UPSTREAM_REASONING_EFFORT must be minimal, low, medium, high, or xhigh."
  );
}
