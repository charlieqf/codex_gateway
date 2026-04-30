import type { RequestUsageReportRow } from "@codex-gateway/core";

export interface TokenUsageAggregateRow {
  date: string;
  credential_id: string | null;
  subject_id: string | null;
  scope: RequestUsageReportRow["scope"];
  upstream_account_id: string | null;
  provider: RequestUsageReportRow["provider"];
  entitlement_id: string | null;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cached_prompt_tokens: number;
  estimated_tokens: number;
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
  entitlementId?: string | null;
}): RequestUsageReportRow {
  return {
    date: input.date,
    credentialId: input.credentialId,
    subjectId: input.subjectId,
    scope: input.scope,
    upstreamAccountId: input.upstreamAccountId,
    provider: input.provider,
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
    row.provider ?? ""
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
    row.provider ?? ""
  ].join("\u0000");
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
