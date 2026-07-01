import {
  defaultPublicModelAliasGroups,
  normalizePublicModelId,
  type RequestUsageReportInput,
  type RequestUsageReportRow
} from "@codex-gateway/core";

export interface TokenUsageAggregateRow {
  date: string;
  credential_id: string | null;
  subject_id: string | null;
  scope: RequestUsageReportRow["scope"];
  upstream_account_id: string | null;
  provider: RequestUsageReportRow["provider"];
  public_model_id: string | null;
  upstream_runtime: string | null;
  upstream_model: string | null;
  reasoning_effort: string | null;
  entitlement_id: string | null;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cached_prompt_tokens: number;
  estimated_tokens: number;
  reasoning_tokens: number;
  usage_missing: number;
}

export function mergeTokenUsageRows(rows: TokenUsageAggregateRow[]): TokenUsageAggregateRow[] {
  const merged = new Map<string, TokenUsageAggregateRow>();
  for (const row of rows) {
    const key = tokenUsageAggregateKey(row);
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, { ...row });
      continue;
    }
    existing.prompt_tokens += row.prompt_tokens;
    existing.completion_tokens += row.completion_tokens;
    existing.total_tokens += row.total_tokens;
    existing.cached_prompt_tokens += row.cached_prompt_tokens;
    existing.estimated_tokens += row.estimated_tokens;
    existing.reasoning_tokens += row.reasoning_tokens;
    existing.usage_missing += row.usage_missing;
  }
  return Array.from(merged.values());
}

export function emptyRequestUsageReportRow(input: {
  date: string;
  credentialId: string | null;
  subjectId: string | null;
  scope: RequestUsageReportRow["scope"];
  upstreamAccountId: string | null;
  provider: RequestUsageReportRow["provider"];
  publicModelId?: string | null;
  upstreamRuntime?: string | null;
  upstreamModel?: string | null;
  reasoningEffort?: string | null;
  entitlementId?: string | null;
}): RequestUsageReportRow {
  return {
    date: input.date,
    credentialId: input.credentialId,
    subjectId: input.subjectId,
    scope: input.scope,
    upstreamAccountId: input.upstreamAccountId,
    provider: input.provider,
    publicModelId: input.publicModelId ?? null,
    upstreamRuntime: input.upstreamRuntime ?? null,
    upstreamModel: input.upstreamModel ?? null,
    reasoningEffort: input.reasoningEffort ?? null,
    entitlementId: input.entitlementId ?? null,
    requests: 0,
    ok: 0,
    errors: 0,
    rateLimited: 0,
    avgDurationMs: null,
    avgFirstByteMs: null,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cachedPromptTokens: 0,
    estimatedTokens: 0,
    reasoningTokens: 0,
    usageMissing: 0,
    rateLimitedBy: {},
    overRequestLimit: 0,
    identityGuardHit: 0
  };
}

export function requestUsageReportKey(row: RequestUsageReportRow): string {
  return [
    row.date,
    row.credentialId ?? "",
    row.subjectId ?? "",
    row.entitlementId ?? "",
    row.scope ?? "",
    row.upstreamAccountId ?? "",
    row.provider ?? "",
    row.publicModelId ?? "",
    row.upstreamRuntime ?? "",
    row.upstreamModel ?? "",
    row.reasoningEffort ?? ""
  ].join("\u0000");
}

export function tokenUsageAggregateKey(row: TokenUsageAggregateRow): string {
  return [
    row.date,
    row.credential_id ?? "",
    row.subject_id ?? "",
    row.entitlement_id ?? "",
    row.scope ?? "",
    row.upstream_account_id ?? "",
    row.provider ?? "",
    row.public_model_id ?? "",
    row.upstream_runtime ?? "",
    row.upstream_model ?? "",
    row.reasoning_effort ?? ""
  ].join("\u0000");
}

export function normalizeAndAggregateRequestUsageRows(
  rows: RequestUsageReportRow[],
  input: RequestUsageReportInput
): RequestUsageReportRow[] {
  const aliases = input.publicModelAliases ?? defaultPublicModelAliasGroups;
  const requestedModel = input.publicModelId
    ? normalizePublicModelId(input.publicModelId, aliases)
    : null;
  const normalizedRows = rows
    .map((row) => ({
      ...row,
      publicModelId: normalizePublicModelId(row.publicModelId, aliases)
    }))
    .filter((row) => {
      if (requestedModel && row.publicModelId !== requestedModel) {
        return false;
      }
      if (input.upstreamRuntime && row.upstreamRuntime !== input.upstreamRuntime) {
        return false;
      }
      if (input.provider && row.provider !== input.provider) {
        return false;
      }
      return true;
    });

  const groupBy = input.groupBy ?? "default";
  const grouped = new Map<string, RequestUsageReportRow>();
  for (const row of normalizedRows) {
    const base = rowForGroup(row, groupBy);
    const key = requestUsageReportKey(base);
    const existing = grouped.get(key);
    if (!existing) {
      grouped.set(key, { ...base });
      continue;
    }
    mergeRequestUsageRow(existing, base);
  }
  return Array.from(grouped.values()).sort(compareRequestUsageRows);
}

function rowForGroup(
  row: RequestUsageReportRow,
  groupBy: NonNullable<RequestUsageReportInput["groupBy"]>
): RequestUsageReportRow {
  if (groupBy === "default" || groupBy === "entitlement") {
    return {
      ...row,
      entitlementId: groupBy === "entitlement" ? row.entitlementId ?? null : null
    };
  }

  return {
    ...row,
    date: "total",
    credentialId: null,
    subjectId: groupBy === "user-model" ? row.subjectId : null,
    scope: null,
    upstreamAccountId: null,
    provider: null,
    publicModelId: row.publicModelId,
    upstreamRuntime: null,
    upstreamModel: null,
    reasoningEffort: null,
    entitlementId: groupBy === "entitlement-model" ? row.entitlementId ?? null : null
  };
}

function mergeRequestUsageRow(
  target: RequestUsageReportRow,
  source: RequestUsageReportRow
): void {
  const targetRequests = target.requests;
  const sourceRequests = source.requests;
  const totalRequests = targetRequests + sourceRequests;
  target.avgDurationMs = mergeAverage(
    target.avgDurationMs,
    targetRequests,
    source.avgDurationMs,
    sourceRequests
  );
  target.avgFirstByteMs = mergeAverage(
    target.avgFirstByteMs,
    targetRequests,
    source.avgFirstByteMs,
    sourceRequests
  );
  target.requests = totalRequests;
  target.ok += source.ok;
  target.errors += source.errors;
  target.rateLimited += source.rateLimited;
  target.promptTokens += source.promptTokens;
  target.completionTokens += source.completionTokens;
  target.totalTokens += source.totalTokens;
  target.cachedPromptTokens += source.cachedPromptTokens;
  target.estimatedTokens += source.estimatedTokens;
  target.reasoningTokens += source.reasoningTokens;
  target.usageMissing += source.usageMissing;
  target.overRequestLimit += source.overRequestLimit;
  target.identityGuardHit += source.identityGuardHit;
  target.upstreamRuntime = mergeNullableDimension(target.upstreamRuntime, source.upstreamRuntime);
  target.upstreamModel = mergeNullableDimension(target.upstreamModel, source.upstreamModel);
  target.reasoningEffort = mergeNullableDimension(target.reasoningEffort ?? null, source.reasoningEffort ?? null);
  for (const [key, value] of Object.entries(source.rateLimitedBy)) {
    target.rateLimitedBy[key as keyof RequestUsageReportRow["rateLimitedBy"]] =
      (target.rateLimitedBy[key as keyof RequestUsageReportRow["rateLimitedBy"]] ?? 0) +
      (value ?? 0);
  }
}

function mergeAverage(
  left: number | null,
  leftWeight: number,
  right: number | null,
  rightWeight: number
): number | null {
  const weightedLeft = left === null || leftWeight === 0 ? null : left * leftWeight;
  const weightedRight = right === null || rightWeight === 0 ? null : right * rightWeight;
  if (weightedLeft === null && weightedRight === null) {
    return null;
  }
  const totalWeight =
    (weightedLeft === null ? 0 : leftWeight) + (weightedRight === null ? 0 : rightWeight);
  return totalWeight === 0
    ? null
    : ((weightedLeft ?? 0) + (weightedRight ?? 0)) / totalWeight;
}

function mergeNullableDimension<T extends string>(
  left: T | null,
  right: T | null
): T | null {
  if (left === right) {
    return left;
  }
  if (left === null) {
    return right;
  }
  if (right === null) {
    return left;
  }
  return null;
}

export function compareRequestUsageRows(
  first: RequestUsageReportRow,
  second: RequestUsageReportRow
): number {
  const dateCompare = second.date.localeCompare(first.date);
  if (dateCompare !== 0) {
    return dateCompare;
  }
  if (second.requests !== first.requests) {
    return second.requests - first.requests;
  }
  return requestUsageReportKey(first).localeCompare(requestUsageReportKey(second));
}
