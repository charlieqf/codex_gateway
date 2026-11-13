import { GatewayError, isRecord, type ProviderContentFilter } from "@codex-gateway/core";

export const CONTENT_FILTER_MESSAGE = "模型服务触发内容过滤";
const MAX_FILTER_ENTRIES_PER_FRAME = 32;

export function isContentFilteredFinishReason(reason: string | null | undefined): boolean {
  return reason === "sensitive" || reason === "content_filter";
}

/** A received policy rejection is terminal, even if its trailing stream then times out. */
export function isContentPolicyError(value: unknown): value is GatewayError & { code: "content_policy_violation" } {
  return value instanceof GatewayError && value.code === "content_policy_violation";
}

export function contentPolicyViolationError(upstreamStatus?: number): GatewayError {
  return new GatewayError({
    code: "content_policy_violation",
    message: CONTENT_FILTER_MESSAGE,
    httpStatus: 400,
    ...(upstreamStatus !== undefined ? { upstreamStatus } : {})
  });
}

/** Only role/level enums survive. Dedupe bounds storage to 4 roles × 5 levels (including absent). */
export function collectProviderContentFilter(
  entries: unknown,
  collected: ProviderContentFilter[] = []
): ProviderContentFilter[] {
  if (entries === undefined) return collected;
  const append = (entry: ProviderContentFilter) => {
    if (!collected.some(item => item.role === entry.role && item.level === entry.level)) collected.push(entry);
  };
  if (!Array.isArray(entries)) {
    append({ role: "unknown" });
    return collected;
  }
  // Uninspected data must not imply that the inspected roles are exhaustive.
  if (entries.length > MAX_FILTER_ENTRIES_PER_FRAME) append({ role: "unknown" });
  for (const entry of entries.slice(0, MAX_FILTER_ENTRIES_PER_FRAME)) {
    if (!isRecord(entry)) {
      append({ role: "unknown" });
      continue;
    }
    const role = entry.role === "user" || entry.role === "assistant" || entry.role === "history"
      ? entry.role : "unknown";
    const level = entry.level === 0 || entry.level === 1 || entry.level === 2 || entry.level === 3
      ? entry.level : undefined;
    append({ role, ...(level !== undefined ? { level } : {}) });
  }
  return collected;
}

export function contentFilterStage(entries: ProviderContentFilter[]): "input" | "history" | "output" | "multiple" | "unknown" {
  const roles = new Set(entries.map(entry => entry.role));
  if (!roles.size || roles.has("unknown")) return "unknown";
  if (roles.size > 1) return "multiple";
  return roles.has("user") ? "input" : roles.has("history") ? "history" : "output";
}
