import { writeFileSync } from "node:fs";
import path from "node:path";
import {
  mergeEntitlementTokenPolicy,
  publicFeaturePolicy,
  publicTokenPolicy,
  publicTokenUsage,
  type AccessCredentialRecord,
  type Entitlement,
  type EntitlementAccessDecision,
  type Plan,
  type RequestUsageReportRow,
  type Subject,
  type TokenLimitPolicy
} from "@codex-gateway/core";
import { createSqliteTokenBudgetLimiter } from "./token-budget.js";
import type { SqliteGatewayStore } from "./index.js";

type PublicTokenPolicy = ReturnType<typeof publicTokenPolicy>;
type PublicTokenUsage = ReturnType<typeof publicTokenUsage>;

type CredentialStatus =
  | "active"
  | "revoked"
  | "expired"
  | "user_disabled"
  | "user_archived"
  | "user_missing";

type RateLimitKind = keyof RequestUsageReportRow["rateLimitedBy"];

interface QuotaDashboardOptions {
  outputPath: string;
  includeInactive?: boolean;
  now?: Date;
}

export interface QuotaDashboardResult {
  outputPath: string;
  generatedAt: string;
  users: number;
  activeEntitlements: number;
  legacyUsers: number;
  usersWithoutQuota: number;
}

export interface QuotaDashboardPageOptions {
  authRequired?: boolean;
  dataEndpoint?: string;
}

export interface UsageSummary {
  requests: number;
  ok: number;
  errors: number;
  rate_limited: number;
  provider_total_tokens: number;
  estimated_tokens: number;
  rate_limited_by: Partial<Record<RateLimitKind, number>>;
}

export interface PrimaryRateLimit {
  kind: RateLimitKind | null;
  count: number;
  window: "today" | "last_7d" | null;
  label: string;
}

export interface DailyTokenUsage {
  date: string;
  since: string;
  until: string;
  requests: number;
  provider_total_tokens: number;
  estimated_tokens: number;
  total_tokens: number;
}

interface DashboardUser {
  user: ReturnType<typeof publicSubject>;
  credentials: Array<ReturnType<typeof publicCredential>>;
  active_credential_count: number;
  selected_credential_prefix: string | null;
  access_status: EntitlementAccessDecision["status"];
  access_reason: string | null;
  plan: ReturnType<typeof publicPlan> | null;
  entitlement: ReturnType<typeof publicEntitlement> | null;
  plan_token: PublicTokenPolicy | null;
  effective_token: PublicTokenPolicy | null;
  token_usage: PublicTokenUsage | null;
  usage_today: UsageSummary;
  usage_7d: UsageSummary;
  daily_token_usage: DailyTokenUsage[];
  primary_rate_limit: PrimaryRateLimit;
  internal_reserve_tokens_per_request: number | null;
  internal_missing_usage_charge: TokenLimitPolicy["missingUsageCharge"] | null;
  warnings: string[];
}

export interface DashboardData {
  generated_at: string;
  include_inactive: boolean;
  report_timezone: "Asia/Shanghai";
  today_window: {
    since: string;
    until: string;
  };
  seven_day_window: {
    since: string;
    until: string;
  };
  daily_token_window: {
    since: string;
    until: string;
    days: number;
  };
  summary: {
    users: number;
    active_entitlements: number;
    legacy_users: number;
    inactive_or_expired_entitlements: number;
    users_without_quota: number;
    exhausted_users: number;
    today: UsageSummary;
    seven_day: UsageSummary;
    daily_token_usage: DailyTokenUsage[];
  };
  users: DashboardUser[];
}

const dailyTokenUsageDays = 30;
const dayMs = 24 * 60 * 60 * 1000;

export async function writeQuotaDashboard(
  store: SqliteGatewayStore,
  options: QuotaDashboardOptions
): Promise<QuotaDashboardResult> {
  const data = await buildQuotaDashboardData(store, options);
  const outputPath = path.resolve(options.outputPath);
  writeFileSync(outputPath, renderQuotaDashboardHtml(data), "utf8");
  return {
    outputPath,
    generatedAt: data.generated_at,
    users: data.summary.users,
    activeEntitlements: data.summary.active_entitlements,
    legacyUsers: data.summary.legacy_users,
    usersWithoutQuota: data.summary.users_without_quota
  };
}

export async function buildQuotaDashboardData(
  store: SqliteGatewayStore,
  options: Omit<QuotaDashboardOptions, "outputPath"> = {}
): Promise<DashboardData> {
  const now = options.now ?? new Date();
  const todayStart = startOfBeijingDayUtc(now);
  const sevenDayStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const dailyTokenDayStarts = beijingDayStarts(todayStart, dailyTokenUsageDays);
  const subjects = store
    .listSubjects({ includeArchived: true })
    .filter((subject) => options.includeInactive || subject.state === "active")
    .sort((a, b) => subjectDisplayName(a).localeCompare(subjectDisplayName(b), "zh-CN"));
  const credentials = store.listAccessCredentials({ includeRevoked: true });
  const credentialsBySubject = groupCredentialsBySubject(credentials);
  const limiter = createSqliteTokenBudgetLimiter({ db: store.database });
  const users: DashboardUser[] = [];

  for (const subject of subjects) {
    const userCredentials = credentialsBySubject.get(subject.id) ?? [];
    const activeCredentials = userCredentials.filter(
      (credential) => credentialStatus(credential, subject, now) === "active"
    );
    const selectedCredential = activeCredentials[0] ?? null;
    const access = store.entitlementAccessForSubject(subject.id, now);
    const resolved = resolveQuotaPolicy(store, subject, access, selectedCredential, now);
    const tokenUsage = resolved.policy
      ? publicTokenUsage(
          await limiter.getCurrentUsage({
            subjectId: subject.id,
            entitlementId: resolved.entitlement?.id ?? null,
            entitlementPeriodStart: resolved.entitlement?.periodStart ?? null,
            entitlementPeriodEnd: resolved.entitlement?.periodEnd ?? null,
            policy: resolved.policy,
            now
          })
        )
      : null;
    const todayUsage = summarizeUsageRows(
      store.reportRequestUsage({ subjectId: subject.id, since: todayStart, until: now })
    );
    const sevenDayUsage = summarizeUsageRows(
      store.reportRequestUsage({ subjectId: subject.id, since: sevenDayStart, until: now })
    );
    const dailyTokenUsage = buildDailyTokenUsage(store, subject.id, dailyTokenDayStarts, now);

    users.push({
      user: publicSubject(subject),
      credentials: userCredentials.map((credential) => publicCredential(credential, subject, now)),
      active_credential_count: activeCredentials.length,
      selected_credential_prefix: selectedCredential?.prefix ?? null,
      access_status: access.status,
      access_reason: "reason" in access ? access.reason : null,
      plan: resolved.plan ? publicPlan(resolved.plan, false) : null,
      entitlement: resolved.entitlement ? publicEntitlement(resolved.entitlement) : null,
      plan_token: resolved.planPolicy ? publicTokenPolicy(resolved.planPolicy) : null,
      effective_token: resolved.policy ? publicTokenPolicy(resolved.policy) : null,
      token_usage: tokenUsage,
      usage_today: todayUsage,
      usage_7d: sevenDayUsage,
      daily_token_usage: dailyTokenUsage,
      primary_rate_limit: primaryRateLimit(todayUsage, sevenDayUsage),
      internal_reserve_tokens_per_request: resolved.policy?.reserveTokensPerRequest ?? null,
      internal_missing_usage_charge: resolved.policy?.missingUsageCharge ?? null,
      warnings: dashboardWarnings(subject, access, activeCredentials, resolved.policy, tokenUsage)
    });
  }
  users.sort(compareDashboardUsers);

  const summary = {
    users: users.length,
    active_entitlements: users.filter((user) => user.access_status === "active").length,
    legacy_users: users.filter((user) => user.access_status === "legacy").length,
    inactive_or_expired_entitlements: users.filter(
      (user) => user.access_status === "expired" || user.access_status === "inactive"
    ).length,
    users_without_quota: users.filter((user) => !user.effective_token).length,
    exhausted_users: users.filter((user) => hasExhaustedWindow(user.token_usage)).length,
    today: sumUsage(users.map((user) => user.usage_today)),
    seven_day: sumUsage(users.map((user) => user.usage_7d)),
    daily_token_usage: sumDailyTokenUsage(
      users.map((user) => user.daily_token_usage),
      dailyTokenDayStarts,
      now
    )
  };

  return {
    generated_at: now.toISOString(),
    include_inactive: Boolean(options.includeInactive),
    report_timezone: "Asia/Shanghai",
    today_window: {
      since: todayStart.toISOString(),
      until: now.toISOString()
    },
    seven_day_window: {
      since: sevenDayStart.toISOString(),
      until: now.toISOString()
    },
    daily_token_window: {
      since: dailyTokenDayStarts[0]?.toISOString() ?? todayStart.toISOString(),
      until: now.toISOString(),
      days: dailyTokenDayStarts.length
    },
    summary,
    users
  };
}

function resolveQuotaPolicy(
  store: SqliteGatewayStore,
  subject: Subject,
  access: EntitlementAccessDecision,
  selectedCredential: AccessCredentialRecord | null,
  now: Date
): {
  plan: ReturnType<SqliteGatewayStore["getPlan"]>;
  entitlement: Extract<EntitlementAccessDecision, { entitlement: unknown }>["entitlement"] | null;
  planPolicy: TokenLimitPolicy | null;
  policy: TokenLimitPolicy | null;
} {
  if (access.status === "active") {
    return {
      plan: access.plan,
      entitlement: access.entitlement,
      planPolicy: access.entitlement.policySnapshot,
      policy: mergeEntitlementTokenPolicy(
        access.entitlement.policySnapshot,
        selectedCredential?.rate.token ?? null
      )
    };
  }

  if ("entitlement" in access && access.entitlement) {
    return {
      plan: store.getPlan(access.entitlement.planId),
      entitlement: access.entitlement,
      planPolicy: access.entitlement.policySnapshot,
      policy: null
    };
  }

  const legacyTokenCredential =
    selectedCredential?.rate.token
      ? selectedCredential
      : firstActiveTokenCredential(store, subject, now);
  return {
    plan: null,
    entitlement: null,
    planPolicy: null,
    policy: legacyTokenCredential?.rate.token ?? null
  };
}

function firstActiveTokenCredential(
  store: SqliteGatewayStore,
  subject: Subject,
  now: Date
): AccessCredentialRecord | null {
  return (
    store
      .listAccessCredentials({ subjectId: subject.id, includeRevoked: false })
      .find(
        (credential) =>
          credential.rate.token && credentialStatus(credential, subject, now) === "active"
      ) ?? null
  );
}

function groupCredentialsBySubject(
  credentials: AccessCredentialRecord[]
): Map<string, AccessCredentialRecord[]> {
  const grouped = new Map<string, AccessCredentialRecord[]>();
  for (const credential of credentials) {
    const existing = grouped.get(credential.subjectId) ?? [];
    existing.push(credential);
    grouped.set(credential.subjectId, existing);
  }
  for (const group of grouped.values()) {
    group.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }
  return grouped;
}

function dashboardWarnings(
  subject: Subject,
  access: EntitlementAccessDecision,
  activeCredentials: AccessCredentialRecord[],
  policy: TokenLimitPolicy | null,
  usage: PublicTokenUsage | null
): string[] {
  const warnings: string[] = [];
  if (activeCredentials.length === 0) {
    warnings.push("没有可用 API key");
  }
  if (access.status === "legacy") {
    warnings.push("未绑定有效套餐权益");
  }
  if (access.status === "expired") {
    warnings.push("套餐权益已过期");
  }
  if (access.status === "inactive") {
    warnings.push(`套餐权益不可用：${access.reason}`);
  }
  if (!subject.name || !subject.phoneNumber) {
    warnings.push("缺少姓名或手机号");
  }
  if (!policy) {
    warnings.push("没有 token quota policy");
  }
  if (policy && policy.tokensPerMinute !== null && policy.reserveTokensPerRequest >= policy.tokensPerMinute) {
    warnings.push("单请求预留量可能耗尽分钟额度");
  }
  if (hasExhaustedWindow(usage)) {
    warnings.push("当前 quota 窗口已用尽");
  }
  return warnings;
}

function hasExhaustedWindow(usage: PublicTokenUsage | null): boolean {
  if (!usage) {
    return false;
  }
  return [usage.minute, usage.day, usage.month].some((window) => window.remaining === 0);
}

function summarizeUsageRows(rows: RequestUsageReportRow[]): UsageSummary {
  const summary = emptyUsageSummary();
  for (const row of rows) {
    summary.requests += row.requests;
    summary.ok += row.ok;
    summary.errors += row.errors;
    summary.rate_limited += row.rateLimited;
    summary.provider_total_tokens += Math.max(0, row.totalTokens - row.estimatedTokens);
    summary.estimated_tokens += row.estimatedTokens;
    for (const [kind, rawCount] of Object.entries(row.rateLimitedBy)) {
      const count = Number(rawCount);
      if (count > 0) {
        summary.rate_limited_by[kind as RateLimitKind] =
          (summary.rate_limited_by[kind as RateLimitKind] ?? 0) + count;
      }
    }
  }
  return summary;
}

function sumUsage(items: UsageSummary[]): UsageSummary {
  const summary = emptyUsageSummary();
  for (const item of items) {
    summary.requests += item.requests;
    summary.ok += item.ok;
    summary.errors += item.errors;
    summary.rate_limited += item.rate_limited;
    summary.provider_total_tokens += item.provider_total_tokens;
    summary.estimated_tokens += item.estimated_tokens;
    for (const [kind, rawCount] of Object.entries(item.rate_limited_by)) {
      const count = Number(rawCount);
      if (count > 0) {
        summary.rate_limited_by[kind as RateLimitKind] =
          (summary.rate_limited_by[kind as RateLimitKind] ?? 0) + count;
      }
    }
  }
  return summary;
}

function buildDailyTokenUsage(
  store: SqliteGatewayStore,
  subjectId: string,
  dayStarts: Date[],
  now: Date
): DailyTokenUsage[] {
  return dayStarts.map((dayStart) => {
    const until = dailyWindowEnd(dayStart, now);
    const usage =
      until.getTime() > dayStart.getTime()
        ? summarizeUsageRows(
            store.reportRequestUsage({
              subjectId,
              since: dayStart,
              until
            })
          )
        : emptyUsageSummary();
    return dailyTokenUsageFromSummary(dayStart, until, usage);
  });
}

function sumDailyTokenUsage(
  userRows: DailyTokenUsage[][],
  dayStarts: Date[],
  now: Date
): DailyTokenUsage[] {
  const totals = new Map<string, DailyTokenUsage>();
  for (const dayStart of dayStarts) {
    const until = dailyWindowEnd(dayStart, now);
    const row = dailyTokenUsageFromSummary(dayStart, until, emptyUsageSummary());
    totals.set(row.date, row);
  }

  for (const rows of userRows) {
    for (const row of rows) {
      const total = totals.get(row.date);
      if (!total) {
        continue;
      }
      total.requests += row.requests;
      total.provider_total_tokens += row.provider_total_tokens;
      total.estimated_tokens += row.estimated_tokens;
      total.total_tokens += row.total_tokens;
    }
  }
  return Array.from(totals.values());
}

function dailyTokenUsageFromSummary(
  dayStart: Date,
  until: Date,
  usage: UsageSummary
): DailyTokenUsage {
  const providerTotalTokens = usage.provider_total_tokens;
  const estimatedTokens = usage.estimated_tokens;
  return {
    date: beijingDateKey(dayStart),
    since: dayStart.toISOString(),
    until: until.toISOString(),
    requests: usage.requests,
    provider_total_tokens: providerTotalTokens,
    estimated_tokens: estimatedTokens,
    total_tokens: providerTotalTokens + estimatedTokens
  };
}

function emptyUsageSummary(): UsageSummary {
  return {
    requests: 0,
    ok: 0,
    errors: 0,
    rate_limited: 0,
    provider_total_tokens: 0,
    estimated_tokens: 0,
    rate_limited_by: {}
  };
}

function primaryRateLimit(today: UsageSummary, sevenDay: UsageSummary): PrimaryRateLimit {
  const sevenDayTop = topRateLimit(sevenDay.rate_limited_by);
  if (sevenDayTop) {
    return {
      ...sevenDayTop,
      window: "last_7d",
      label: `近 7 天：${rateLimitLabel(sevenDayTop.kind)} ${sevenDayTop.count}`
    };
  }
  const todayTop = topRateLimit(today.rate_limited_by);
  if (todayTop) {
    return {
      ...todayTop,
      window: "today",
      label: `今日：${rateLimitLabel(todayTop.kind)} ${todayTop.count}`
    };
  }
  return {
    kind: null,
    count: 0,
    window: null,
    label: "无"
  };
}

function compareDashboardUsers(left: DashboardUser, right: DashboardUser): number {
  return (
    right.usage_7d.provider_total_tokens - left.usage_7d.provider_total_tokens ||
    right.usage_7d.estimated_tokens - left.usage_7d.estimated_tokens ||
    right.usage_7d.requests - left.usage_7d.requests ||
    subjectLabelForUser(left).localeCompare(subjectLabelForUser(right), "zh-CN")
  );
}

function subjectLabelForUser(user: DashboardUser): string {
  return user.user.name || user.user.label || user.user.id;
}

function topRateLimit(
  rateLimitedBy: Partial<Record<RateLimitKind, number>>
): { kind: RateLimitKind; count: number } | null {
  const sorted = Object.entries(rateLimitedBy)
    .map(([kind, count]) => ({ kind: kind as RateLimitKind, count: Number(count) }))
    .filter((item) => item.count > 0)
    .sort((a, b) => b.count - a.count || rateLimitLabel(a.kind).localeCompare(rateLimitLabel(b.kind)));
  return sorted[0] ?? null;
}

function rateLimitLabel(kind: RateLimitKind | null): string {
  if (!kind) {
    return "无";
  }
  const labels: Record<RateLimitKind, string> = {
    request_minute: "分钟请求数",
    request_day: "日请求数",
    concurrency: "并发",
    token_minute: "分钟 token",
    token_day: "日 token",
    token_month: "月 token",
    token_request_prompt: "单请求 prompt token",
    token_request_total: "单请求总 token"
  };
  return labels[kind] ?? kind;
}

function startOfBeijingDayUtc(now: Date): Date {
  const offsetMs = 8 * 60 * 60 * 1000;
  const shifted = new Date(now.getTime() + offsetMs);
  return new Date(
    Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - offsetMs
  );
}

function beijingDayStarts(todayStart: Date, days: number): Date[] {
  return Array.from({ length: days }, (_value, index) =>
    new Date(todayStart.getTime() - (days - 1 - index) * dayMs)
  );
}

function dailyWindowEnd(dayStart: Date, now: Date): Date {
  return new Date(Math.min(dayStart.getTime() + dayMs, now.getTime()));
}

function beijingDateKey(dayStart: Date): string {
  const offsetMs = 8 * 60 * 60 * 1000;
  return new Date(dayStart.getTime() + offsetMs).toISOString().slice(0, 10);
}

export function renderQuotaDashboardHtml(data: DashboardData): string {
  return renderQuotaDashboardDocument({
    embeddedData: data,
    authRequired: false,
    dataEndpoint: null
  });
}

export function renderQuotaDashboardPage(options: QuotaDashboardPageOptions = {}): string {
  return renderQuotaDashboardDocument({
    embeddedData: null,
    authRequired: options.authRequired ?? true,
    dataEndpoint: options.dataEndpoint ?? "/gateway/admin/quota-dashboard.json"
  });
}

function renderQuotaDashboardDocument(input: {
  embeddedData: DashboardData | null;
  authRequired: boolean;
  dataEndpoint: string | null;
}): string {
  const json = JSON.stringify(input.embeddedData).replaceAll("<", "\\u003c");
  const controls = input.dataEndpoint
    ? `<label class="token-control"${input.authRequired ? "" : " hidden"}>Admin token
        <input id="token" type="password" autocomplete="off" placeholder="输入 admin token">
      </label>
      <label class="check"><input id="includeInactive" type="checkbox" checked>包含停用/归档用户</label>
      <button id="refresh" type="button">刷新</button>`
    : "";

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>用户套餐与 Token 用量</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f7f9;
      --surface: #ffffff;
      --surface-alt: #eef2f7;
      --text: #18202b;
      --muted: #5f6b7a;
      --line: #d8dee8;
      --accent: #2563eb;
      --accent-dark: #1d4ed8;
      --ok: #0f8a5f;
      --warn: #b45309;
      --bad: #b91c1c;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      max-width: 100vw;
      overflow-x: hidden;
      background: var(--bg);
      color: var(--text);
      font-family: Inter, "Segoe UI", "Microsoft YaHei", Arial, sans-serif;
      font-size: 13px;
      line-height: 1.45;
    }
    header {
      display: flex;
      justify-content: space-between;
      gap: 16px;
      align-items: end;
      padding: 18px 22px 12px;
      background: var(--surface);
      border-bottom: 1px solid var(--line);
    }
    h1 {
      margin: 0 0 6px;
      font-size: 22px;
      font-weight: 700;
      letter-spacing: 0;
    }
    .meta { color: var(--muted); display: flex; gap: 14px; flex-wrap: wrap; }
    .header-controls {
      display: flex;
      align-items: end;
      gap: 10px;
      flex-wrap: wrap;
      justify-content: flex-end;
    }
    label { color: var(--muted); font-size: 12px; font-weight: 650; }
    .token-control {
      display: grid;
      gap: 5px;
    }
    input[type="password"], input[type="search"] {
      height: 34px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: #fff;
      color: var(--text);
      font: inherit;
      padding: 0 10px;
      letter-spacing: 0;
    }
    input[type="password"] { width: 280px; }
    .check {
      height: 34px;
      display: flex;
      align-items: center;
      gap: 7px;
      color: var(--text);
      font-size: 13px;
      font-weight: 500;
    }
    .check input { width: 15px; height: 15px; }
    button {
      min-height: 34px;
      padding: 7px 10px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: #fff;
      color: var(--text);
      cursor: pointer;
      font: inherit;
      letter-spacing: 0;
    }
    button.primary, button.active {
      border-color: var(--accent);
      background: var(--accent);
      color: #fff;
    }
    button.primary:hover, button.active:hover { background: var(--accent-dark); }
    button:disabled { cursor: progress; opacity: 0.7; }
    .summary {
      display: grid;
      grid-template-columns: repeat(8, minmax(118px, 1fr));
      gap: 1px;
      background: var(--line);
      border-bottom: 1px solid var(--line);
    }
    .metric {
      min-height: 76px;
      background: var(--surface);
      padding: 11px 13px;
    }
    .metric .label { color: var(--muted); font-size: 12px; font-weight: 600; }
    .metric .value { margin-top: 5px; font-size: 22px; font-weight: 700; letter-spacing: 0; }
    .daily-chart {
      margin: 12px 22px 0;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: var(--surface);
      overflow: hidden;
    }
    .chart-header {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: center;
      padding: 12px 14px;
      border-bottom: 1px solid var(--line);
      background: #fbfcfe;
    }
    h2 {
      margin: 0;
      font-size: 15px;
      font-weight: 700;
      letter-spacing: 0;
    }
    .chart-meta {
      margin-top: 3px;
      color: var(--muted);
      font-size: 12px;
    }
    .legend {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      color: var(--muted);
      font-size: 12px;
    }
    .legend span {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      white-space: nowrap;
    }
    .legend i {
      width: 10px;
      height: 10px;
      border-radius: 2px;
      display: inline-block;
    }
    .legend .provider { background: var(--accent); }
    .legend .estimated { background: #d97706; }
    .chart-body { padding: 12px 14px 14px; }
    .chart-stats {
      display: flex;
      gap: 14px;
      flex-wrap: wrap;
      margin-bottom: 10px;
      color: var(--muted);
      font-size: 12px;
    }
    .chart-bars {
      display: grid;
      grid-auto-flow: column;
      grid-auto-columns: minmax(58px, 1fr);
      gap: 8px;
      min-height: 214px;
      overflow-x: auto;
      padding: 2px 2px 0;
      scrollbar-gutter: stable;
    }
    .chart-day {
      min-width: 58px;
      display: grid;
      grid-template-rows: 166px 42px;
      gap: 6px;
    }
    .chart-slot {
      align-self: end;
      height: 166px;
      display: flex;
      align-items: end;
      border-bottom: 1px solid var(--line);
      background:
        linear-gradient(to top, transparent 0, transparent calc(25% - 1px), #eef2f7 25%, transparent calc(25% + 1px)),
        linear-gradient(to top, transparent 0, transparent calc(50% - 1px), #eef2f7 50%, transparent calc(50% + 1px)),
        linear-gradient(to top, transparent 0, transparent calc(75% - 1px), #eef2f7 75%, transparent calc(75% + 1px));
    }
    .chart-bar {
      width: 100%;
      min-height: 0;
      border-radius: 4px 4px 0 0;
      background: linear-gradient(to top, var(--accent) 0 var(--provider-share), #d97706 var(--provider-share) 100%);
    }
    .chart-date {
      color: var(--muted);
      font-size: 10px;
      line-height: 1.15;
      text-align: center;
      font-variant-numeric: tabular-nums;
      overflow-wrap: normal;
    }
    .toolbar {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 11px 22px;
      background: var(--surface);
      border-bottom: 1px solid var(--line);
      flex-wrap: wrap;
    }
    input[type="search"] { width: min(420px, 100%); }
    .segment {
      display: inline-flex;
      border: 1px solid var(--line);
      border-radius: 6px;
      overflow: hidden;
      background: #fff;
    }
    .segment button {
      border: 0;
      border-right: 1px solid var(--line);
      border-radius: 0;
      min-height: 34px;
    }
    .segment button:last-child { border-right: 0; }
    main {
      max-width: 100vw;
      overflow: hidden;
      padding: 0 22px 24px;
    }
    .notice {
      margin: 12px 0;
      padding: 10px 12px;
      border: 1px solid #f0c36d;
      border-radius: 6px;
      background: #fff8e6;
      color: #6f4e00;
    }
    .notice.bad {
      border-color: #f3b5af;
      background: #fff2f0;
      color: var(--bad);
    }
    .table-wrap {
      width: 100%;
      max-width: 100%;
      max-height: calc(100vh - 250px);
      overflow: auto;
      scrollbar-gutter: stable both-edges;
      border: 1px solid var(--line);
      border-top: 0;
      background: var(--surface);
    }
    table {
      width: 1780px;
      min-width: 1780px;
      border-collapse: collapse;
      table-layout: fixed;
    }
    th, td {
      padding: 9px 10px;
      border-bottom: 1px solid var(--line);
      text-align: left;
      vertical-align: top;
      overflow-wrap: anywhere;
    }
    th {
      position: sticky;
      top: 0;
      z-index: 1;
      background: var(--surface-alt);
      color: #334155;
      font-size: 12px;
      font-weight: 700;
    }
    tr[data-severity="bad"] { background: #fff7f7; }
    tr[data-severity="warn"] { background: #fffaf0; }
    tbody tr:hover { background: #f7fbff; }
    .num {
      text-align: center;
      vertical-align: middle;
      font-variant-numeric: tabular-nums;
    }
    .center { text-align: center; }
    .table-wrap::-webkit-scrollbar {
      width: 12px;
      height: 12px;
    }
    .table-wrap::-webkit-scrollbar-track {
      background: #edf1f6;
    }
    .table-wrap::-webkit-scrollbar-thumb {
      background: #aeb8c7;
      border: 2px solid #edf1f6;
      border-radius: 999px;
    }
    .subtle { color: var(--muted); font-size: 12px; }
    .badge {
      display: inline-flex;
      align-items: center;
      min-height: 22px;
      padding: 2px 7px;
      border-radius: 999px;
      border: 1px solid var(--line);
      background: #fff;
      color: var(--muted);
      font-size: 12px;
      white-space: nowrap;
      margin: 0 4px 4px 0;
    }
    .badge.ok { border-color: #9bd6bf; color: var(--ok); background: #effaf5; }
    .badge.warn { border-color: #f4ca8c; color: var(--warn); background: #fff8eb; }
    .badge.bad { border-color: #f3a5a5; color: var(--bad); background: #fff1f1; }
    .quota-stack { display: grid; gap: 7px; min-width: 330px; }
    .quota-line {
      display: grid;
      grid-template-columns: 44px 1fr 158px;
      gap: 8px;
      align-items: center;
      min-height: 24px;
    }
    .bar {
      height: 10px;
      border-radius: 999px;
      overflow: hidden;
      background: #e5e7eb;
    }
    .fill { height: 100%; width: 0%; background: var(--ok); }
    .fill.mid { background: var(--warn); }
    .fill.high { background: var(--bad); }
    .mono {
      font-family: "Cascadia Mono", Consolas, monospace;
      font-size: 12px;
    }
    .empty {
      padding: 32px;
      text-align: center;
      color: var(--muted);
    }
    @media (max-width: 960px) {
      header { align-items: stretch; flex-direction: column; }
      .header-controls { justify-content: flex-start; }
      header, .toolbar, main { padding-left: 14px; padding-right: 14px; }
      .daily-chart { margin-left: 14px; margin-right: 14px; }
      .chart-header { align-items: flex-start; flex-direction: column; }
      .summary { grid-template-columns: repeat(2, minmax(128px, 1fr)); }
      .segment { width: 100%; overflow-x: auto; }
      .segment button { white-space: nowrap; }
      input[type="password"] { width: min(100%, 320px); }
    }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>用户套餐与 Token 用量</h1>
      <div class="meta">
        <span id="generatedAt">生成时间：-</span>
        <span id="scopeNote">范围：-</span>
        <span id="windowNote">统计窗口：-</span>
      </div>
    </div>
    <div class="header-controls">${controls}</div>
  </header>
  <section class="summary" aria-label="summary" id="summary"></section>
  <section class="toolbar" aria-label="filters">
    <input id="search" type="search" placeholder="过滤用户、姓名、手机号、plan、API key prefix">
    <div class="segment" role="group" aria-label="status filters">
      <button type="button" class="active" data-filter="all">全部</button>
      <button type="button" data-filter="active">活跃权益</button>
      <button type="button" data-filter="legacy">未绑定套餐</button>
      <button type="button" data-filter="warning">需要处理</button>
      <button type="button" data-filter="limited">近 7 天限流</button>
      <button type="button" data-filter="exhausted">额度用尽</button>
    </div>
  </section>
  <section class="daily-chart" aria-label="daily token usage">
    <div class="chart-header">
      <div>
        <h2>每日 token 用量</h2>
        <div class="chart-meta" id="chartSubtitle">-</div>
      </div>
      <div class="legend" aria-label="token usage legend">
        <span><i class="provider"></i>provider tokens</span>
        <span><i class="estimated"></i>estimated tokens</span>
      </div>
    </div>
    <div class="chart-body">
      <div class="chart-stats" id="chartStats"></div>
      <div class="chart-bars" id="dailyTokenChart"></div>
    </div>
  </section>
  <main>
    <div class="notice bad" id="notice" hidden></div>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th style="width: 210px;">用户</th>
            <th style="width: 200px;">Plan / 权益</th>
            <th style="width: 145px;">API key</th>
            <th style="width: 370px;">当前额度窗口</th>
            <th class="center" style="width: 120px;">请求限制</th>
            <th class="num" style="width: 115px;">今日请求/限流</th>
            <th class="num" style="width: 135px;">今日 provider tokens</th>
            <th class="num" style="width: 100px;">今日估算</th>
            <th class="num" style="width: 125px;">近 7 天请求/限流</th>
            <th class="num" style="width: 145px;">近 7 天 provider tokens</th>
            <th class="num" style="width: 110px;">近 7 天估算</th>
            <th class="center" style="width: 150px;">主要限流</th>
            <th>状态</th>
          </tr>
        </thead>
        <tbody id="rows"></tbody>
      </table>
      <div class="empty" id="empty" hidden>没有匹配的用户</div>
    </div>
  </main>
  <script type="application/json" id="dashboardData">${json}</script>
  <script>
    const embeddedData = JSON.parse(document.getElementById("dashboardData").textContent);
    const authRequired = ${JSON.stringify(input.authRequired)};
    const dataEndpoint = ${JSON.stringify(input.dataEndpoint)};
    const rowsEl = document.getElementById("rows");
    const emptyEl = document.getElementById("empty");
    const searchEl = document.getElementById("search");
    const tokenEl = document.getElementById("token");
    const includeInactiveEl = document.getElementById("includeInactive");
    const refreshEl = document.getElementById("refresh");
    const noticeEl = document.getElementById("notice");
    const chartEl = document.getElementById("dailyTokenChart");
    const chartStatsEl = document.getElementById("chartStats");
    const chartSubtitleEl = document.getElementById("chartSubtitle");
    let filter = "all";
    let data = embeddedData;

    if (tokenEl) {
      tokenEl.value = sessionStorage.getItem("gatewayAdminMessagesToken") || "";
      tokenEl.addEventListener("input", () => sessionStorage.setItem("gatewayAdminMessagesToken", tokenEl.value));
    }
    if (includeInactiveEl) includeInactiveEl.addEventListener("change", () => load());
    if (refreshEl) refreshEl.addEventListener("click", () => load());
    searchEl.addEventListener("input", renderFilteredView);
    document.querySelectorAll("button[data-filter]").forEach((button) => {
      button.addEventListener("click", () => {
        document.querySelectorAll("button[data-filter]").forEach((item) => item.classList.remove("active"));
        button.classList.add("active");
        filter = button.dataset.filter;
        renderFilteredView();
      });
    });

    if (data) {
      renderDashboard();
    } else {
      document.getElementById("summary").innerHTML = "";
      if (chartSubtitleEl) chartSubtitleEl.textContent = "-";
      if (chartStatsEl) chartStatsEl.textContent = "";
      if (chartEl) chartEl.innerHTML = '<div class="empty">等待数据</div>';
      rowsEl.innerHTML = '<tr><td colspan="13" class="subtle">输入 admin token 后刷新</td></tr>';
      if (!authRequired || tokenEl?.value) load();
    }

    async function load() {
      if (!dataEndpoint) return;
      const token = tokenEl ? tokenEl.value.trim() : "";
      if (authRequired && !token) {
        showNotice("需要 admin token。");
        tokenEl?.focus();
        return;
      }
      const params = new URLSearchParams();
      if (includeInactiveEl?.checked) params.set("include_inactive", "1");
      if (refreshEl) {
        refreshEl.disabled = true;
        refreshEl.textContent = "加载中";
      }
      try {
        showNotice("");
        const headers = token ? { authorization: "Bearer " + token } : {};
        const response = await fetch(dataEndpoint + "?" + params.toString(), {
          headers,
          cache: "no-store"
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error?.message || "请求失败");
        data = payload;
        renderDashboard();
      } catch (error) {
        showNotice(error.message || String(error));
      } finally {
        if (refreshEl) {
          refreshEl.disabled = false;
          refreshEl.textContent = "刷新";
        }
      }
    }

    function renderDashboard() {
      document.getElementById("generatedAt").textContent = "生成时间：" + formatDateTime(data.generated_at);
      document.getElementById("scopeNote").textContent = data.include_inactive ? "范围：包含停用/归档用户" : "范围：仅活跃用户";
      document.getElementById("windowNote").textContent = "统计窗口：今日按北京时间，近 7 天为滚动 7 天";
      renderSummary();
      renderFilteredView();
    }

    function renderSummary() {
      const metrics = [
        ["用户", data.summary.users],
        ["活跃权益", data.summary.active_entitlements],
        ["需要处理", data.users.filter((user) => user.warnings.length > 0).length],
        ["今日请求", data.summary.today.requests],
        ["今日限流", data.summary.today.rate_limited],
        ["今日 provider tokens", data.summary.today.provider_total_tokens],
        ["近 7 天 provider tokens", data.summary.seven_day.provider_total_tokens],
        ["近 7 天限流", data.summary.seven_day.rate_limited]
      ];
      document.getElementById("summary").innerHTML = metrics.map(([label, value]) =>
        '<div class="metric"><div class="label">' + escapeHtml(label) + '</div><div class="value">' + formatNumber(value) + '</div></div>'
      ).join("");
    }

    function renderFilteredView() {
      renderDailyTokenChart();
      renderRows();
    }

    function filteredUsers() {
      const term = searchEl.value.trim().toLowerCase();
      return data.users
        .filter((user) => matchesFilter(user, filter) && matchesSearch(user, term))
        .sort(compareUsers);
    }

    function renderDailyTokenChart() {
      if (!data || !chartEl) return;
      const visible = filteredUsers();
      const rows = aggregateDailyTokenUsage(visible);
      const maxTotal = Math.max(0, ...rows.map((row) => Number(row.total_tokens) || 0));
      const totalTokens = rows.reduce((sum, row) => sum + (Number(row.total_tokens) || 0), 0);
      const providerTokens = rows.reduce((sum, row) => sum + (Number(row.provider_total_tokens) || 0), 0);
      const estimatedTokens = rows.reduce((sum, row) => sum + (Number(row.estimated_tokens) || 0), 0);

      if (chartSubtitleEl) {
        const window = data.daily_token_window;
        chartSubtitleEl.textContent = window
          ? formatDateOnly(window.since) + " - " + formatDateOnly(window.until)
          : "";
      }
      if (chartStatsEl) {
        chartStatsEl.innerHTML =
          '<span>用户 ' + formatNumber(visible.length) + ' / ' + formatNumber(data.users.length) + '</span>' +
          '<span>total ' + formatNumber(totalTokens) + '</span>' +
          '<span>provider ' + formatNumber(providerTokens) + '</span>' +
          '<span>estimated ' + formatNumber(estimatedTokens) + '</span>';
      }
      if (rows.length === 0) {
        chartEl.innerHTML = '<div class="empty">暂无每日 token 用量</div>';
        return;
      }

      chartEl.innerHTML = rows.map((row) => {
        const total = Number(row.total_tokens) || 0;
        const height = maxTotal > 0 && total > 0 ? Math.max(2, Math.round(total / maxTotal * 100)) : 0;
        const providerShare = total > 0
          ? Math.max(0, Math.min(100, Math.round((Number(row.provider_total_tokens) || 0) / total * 100)))
          : 100;
        const title = row.date +
          " total " + formatNumber(total) +
          " provider " + formatNumber(row.provider_total_tokens) +
          " estimated " + formatNumber(row.estimated_tokens);
        return '<div class="chart-day">' +
          '<div class="chart-slot">' +
            '<div class="chart-bar" title="' + escapeHtml(title) + '" aria-label="' + escapeHtml(title) + '" style="height:' + height + '%; --provider-share:' + providerShare + '%"></div>' +
          '</div>' +
          '<div class="chart-date">' + escapeHtml(row.date) + '</div>' +
        '</div>';
      }).join("");
    }

    function aggregateDailyTokenUsage(users) {
      const template = Array.isArray(data.summary?.daily_token_usage) ? data.summary.daily_token_usage : [];
      const rows = template.map((row) => ({
        date: row.date,
        since: row.since,
        until: row.until,
        requests: 0,
        provider_total_tokens: 0,
        estimated_tokens: 0,
        total_tokens: 0
      }));
      const byDate = new Map(rows.map((row) => [row.date, row]));
      for (const user of users) {
        for (const row of user.daily_token_usage || []) {
          const total = byDate.get(row.date);
          if (!total) continue;
          total.requests += Number(row.requests) || 0;
          total.provider_total_tokens += Number(row.provider_total_tokens) || 0;
          total.estimated_tokens += Number(row.estimated_tokens) || 0;
          total.total_tokens += Number(row.total_tokens) || 0;
        }
      }
      return rows;
    }

    function renderRows() {
      if (!data) return;
      const visible = filteredUsers();
      rowsEl.innerHTML = visible.map(renderUserRow).join("");
      emptyEl.hidden = visible.length > 0;
    }

    function matchesFilter(user, currentFilter) {
      if (currentFilter === "active") return user.access_status === "active";
      if (currentFilter === "legacy") return user.access_status === "legacy";
      if (currentFilter === "warning") return user.warnings.length > 0;
      if (currentFilter === "limited") return user.usage_7d.rate_limited > 0;
      if (currentFilter === "exhausted") return hasExhaustedWindow(user.token_usage);
      return true;
    }

    function matchesSearch(user, term) {
      if (!term) return true;
      return JSON.stringify({
        id: user.user.id,
        label: user.user.label,
        name: user.user.name,
        phone: user.user.phone_number,
        plan: user.plan?.display_name,
        plan_id: user.plan?.id,
        credentials: user.credentials.map((credential) => credential.prefix)
      }).toLowerCase().includes(term);
    }

    function compareUsers(left, right) {
      return (
        right.usage_7d.provider_total_tokens - left.usage_7d.provider_total_tokens ||
        right.usage_7d.estimated_tokens - left.usage_7d.estimated_tokens ||
        right.usage_7d.requests - left.usage_7d.requests ||
        subjectLabel(left).localeCompare(subjectLabel(right), "zh-CN")
      );
    }

    function subjectLabel(user) {
      return user.user.name || user.user.label || user.user.id;
    }

    function renderUserRow(user) {
      const severity = user.usage_7d.rate_limited > 0 || hasExhaustedWindow(user.token_usage) || user.access_status === "expired"
        ? "bad"
        : user.warnings.length ? "warn" : "ok";
      return '<tr data-severity="' + severity + '">' +
        '<td>' + renderUser(user) + '</td>' +
        '<td>' + renderPlan(user) + '</td>' +
        '<td>' + renderCredentials(user) + '</td>' +
        '<td>' + renderQuota(user) + '</td>' +
        '<td class="center">' + renderLimits(user) + '</td>' +
        '<td class="num">' + requestPair(user.usage_today) + '</td>' +
        '<td class="num">' + formatNumber(user.usage_today.provider_total_tokens) + '</td>' +
        '<td class="num">' + formatNumber(user.usage_today.estimated_tokens) + '</td>' +
        '<td class="num">' + requestPair(user.usage_7d) + '</td>' +
        '<td class="num">' + formatNumber(user.usage_7d.provider_total_tokens) + '</td>' +
        '<td class="num">' + formatNumber(user.usage_7d.estimated_tokens) + '</td>' +
        '<td>' + renderPrimaryLimit(user) + '</td>' +
        '<td>' + renderStatus(user) + '</td>' +
        '</tr>';
    }

    function renderUser(user) {
      return '<strong>' + escapeHtml(user.user.name || user.user.label || user.user.id) + '</strong>' +
        '<div class="subtle mono">' + escapeHtml(user.user.id) + '</div>' +
        '<div class="subtle">' + escapeHtml(user.user.phone_number || "无手机号") + '</div>';
    }

    function renderPlan(user) {
      if (!user.plan && !user.entitlement) {
        return '<span class="badge warn">未绑定套餐</span>';
      }
      const planName = user.plan?.display_name || user.entitlement?.plan_id || "未知套餐";
      return '<strong>' + escapeHtml(planName) + '</strong>' +
        '<div class="subtle mono">' + escapeHtml(user.entitlement?.plan_id || "") + '</div>' +
        '<div>' + badge(accessStatusLabel(user.access_status), user.access_status === "active" ? "ok" : "warn") + '</div>' +
        '<div class="subtle">' + formatPeriod(user.entitlement) + '</div>';
    }

    function renderCredentials(user) {
      if (user.credentials.length === 0) {
        return '<span class="badge bad">无 key</span>';
      }
      return user.credentials.map((credential) => {
        const kind = credential.status === "active" ? "ok" : "warn";
        return '<div><span class="badge ' + kind + '">' + escapeHtml(credentialStatusLabel(credential.status)) + '</span>' +
          '<span class="mono">' + escapeHtml(credential.prefix) + '</span></div>';
      }).join("");
    }

    function renderQuota(user) {
      if (!user.effective_token || !user.token_usage) {
        return '<span class="badge warn">无 token quota</span>';
      }
      return '<div class="quota-stack">' +
        renderWindow("分钟", user.token_usage.minute) +
        renderWindow("日", user.token_usage.day) +
        renderWindow("月", user.token_usage.month) +
        '</div>' +
        '<div class="subtle">单请求预留：' + formatNumber(user.internal_reserve_tokens_per_request) +
        '；缺失 usage：' + escapeHtml(user.internal_missing_usage_charge || "n/a") + '</div>';
    }

    function renderWindow(label, window) {
      if (window.limit === null) {
        return '<div class="quota-line"><span>' + label + '</span><div class="bar"><div class="fill" style="width:0%"></div></div><span class="subtle">不限</span></div>';
      }
      const consumed = window.used + window.reserved;
      const pct = Math.max(0, Math.min(100, Math.round(consumed / window.limit * 100)));
      const level = pct >= 90 ? "high" : pct >= 70 ? "mid" : "";
      return '<div class="quota-line">' +
        '<span>' + label + '</span>' +
        '<div class="bar"><div class="fill ' + level + '" style="width:' + pct + '%"></div></div>' +
        '<span class="subtle">' + formatNumber(consumed) + ' / ' + formatNumber(window.limit) + '；剩 ' + formatNumber(window.remaining) + '</span>' +
        '</div>';
    }

    function renderLimits(user) {
      const selected = user.credentials.find((credential) => credential.prefix === user.selected_credential_prefix) || user.credentials[0];
      if (!selected) return '<span class="subtle">无可用 key</span>';
      return '<div>RPM ' + formatNumber(selected.rate.requestsPerMinute) + '</div>' +
        '<div>RPD ' + formatNullable(selected.rate.requestsPerDay) + '</div>' +
        '<div>并发 ' + formatNullable(selected.rate.concurrentRequests) + '</div>' +
        '<div class="subtle mono">' + escapeHtml(selected.prefix) + '</div>';
    }

    function renderPrimaryLimit(user) {
      const primary = user.primary_rate_limit;
      const details = rateLimitDetails(user.usage_7d.rate_limited_by);
      const primaryHtml = primary.count > 0 ? badge(primary.label, "bad") : badge("无", "ok");
      return primaryHtml + (details ? '<div class="subtle">' + escapeHtml(details) + '</div>' : "");
    }

    function renderStatus(user) {
      const statusClass = user.access_status === "active" ? "ok" : user.access_status === "expired" ? "bad" : "warn";
      const warnings = user.warnings.length
        ? '<div>' + user.warnings.map((warning) => badge(warning, warning.includes("用尽") || warning.includes("过期") ? "bad" : "warn")).join("") + '</div>'
        : '<span class="badge ok">正常</span>';
      return badge(subjectStateLabel(user.user.state), user.user.state === "active" ? "ok" : "warn") +
        badge(user.access_reason || accessStatusLabel(user.access_status), statusClass) +
        warnings;
    }

    function requestPair(usage) {
      return formatNumber(usage.requests) + ' / ' + formatNumber(usage.rate_limited);
    }

    function rateLimitDetails(rateLimitedBy) {
      return Object.entries(rateLimitedBy || {})
        .filter(([, count]) => Number(count) > 0)
        .sort((left, right) => Number(right[1]) - Number(left[1]))
        .map(([kind, count]) => rateLimitLabel(kind) + ' ' + count)
        .join('，');
    }

    function rateLimitLabel(kind) {
      return ({
        request_minute: "分钟请求数",
        request_day: "日请求数",
        concurrency: "并发",
        token_minute: "分钟 token",
        token_day: "日 token",
        token_month: "月 token",
        token_request_prompt: "单请求 prompt token",
        token_request_total: "单请求总 token"
      })[kind] || kind;
    }

    function badge(text, kind) {
      return '<span class="badge ' + kind + '">' + escapeHtml(text) + '</span>';
    }

    function formatPeriod(entitlement) {
      if (!entitlement) return "";
      const end = entitlement.period_end ? formatDateTime(entitlement.period_end) : "无结束时间";
      return entitlement.period_kind + "；" + formatDateTime(entitlement.period_start) + " - " + end;
    }

    function hasExhaustedWindow(usage) {
      return Boolean(usage && [usage.minute, usage.day, usage.month].some((window) => window.remaining === 0));
    }

    function formatNumber(value) {
      if (value === null || value === undefined) return "n/a";
      return Number(value).toLocaleString("en-US");
    }

    function formatNullable(value) {
      return value === null || value === undefined ? "不限" : formatNumber(value);
    }

    function formatDateTime(value) {
      if (!value) return "n/a";
      return new Date(value).toLocaleString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" });
    }

    function formatDateOnly(value) {
      if (!value) return "n/a";
      return new Date(value).toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" });
    }

    function credentialStatusLabel(value) {
      return ({
        active: "有效",
        revoked: "已撤销",
        expired: "已过期",
        user_disabled: "用户停用",
        user_archived: "用户归档",
        user_missing: "用户缺失"
      })[value] || value;
    }

    function accessStatusLabel(value) {
      return ({
        active: "权益有效",
        legacy: "legacy",
        expired: "权益过期",
        inactive: "权益不可用",
        missing: "无权益"
      })[value] || value;
    }

    function subjectStateLabel(value) {
      return ({
        active: "用户有效",
        disabled: "用户停用",
        archived: "用户归档"
      })[value] || value;
    }

    function showNotice(text) {
      if (!noticeEl) return;
      if (!text) {
        noticeEl.hidden = true;
        noticeEl.textContent = "";
        return;
      }
      noticeEl.hidden = false;
      noticeEl.textContent = text;
    }

    function escapeHtml(value) {
      return String(value ?? "").replace(/[&<>"']/g, (char) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      })[char]);
    }
  </script>
</body>
</html>`;
}

function publicCredential(
  record: AccessCredentialRecord,
  subject?: Subject | null,
  now: Date = new Date(),
  revealedToken?: string | null
) {
  const status = credentialStatus(record, subject, now);
  const output: Record<string, unknown> = {
    id: record.id,
    prefix: record.prefix,
    user_id: record.subjectId,
    subject_id: record.subjectId,
    label: record.label,
    scope: record.scope,
    expires_at: record.expiresAt.toISOString(),
    revoked_at: record.revokedAt?.toISOString() ?? null,
    status,
    is_currently_valid: status === "active",
    token_available: Boolean(record.tokenCiphertext),
    token_unavailable_reason: record.tokenCiphertext ? null : "not_stored",
    rate: record.rate,
    created_at: record.createdAt.toISOString(),
    rotates_id: record.rotatesId,
    user: subject ? publicSubject(subject) : null
  };
  if (revealedToken !== undefined) {
    output.token = revealedToken;
  }
  return output;
}

function publicPlan(plan: Plan, includePolicy: boolean) {
  return {
    id: plan.id,
    display_name: plan.displayName,
    scope_allowlist: plan.scopeAllowlist,
    priority_class: plan.priorityClass,
    team_pool_id: plan.teamPoolId,
    state: plan.state,
    created_at: plan.createdAt.toISOString(),
    metadata: plan.metadata,
    feature_policy: publicFeaturePolicy(plan.featurePolicy),
    ...(includePolicy ? { policy: plan.policy } : {})
  };
}

function publicEntitlement(entitlement: Entitlement) {
  return {
    id: entitlement.id,
    user_id: entitlement.subjectId,
    subject_id: entitlement.subjectId,
    plan_id: entitlement.planId,
    policy_snapshot: entitlement.policySnapshot,
    feature_policy: publicFeaturePolicy(entitlement.featurePolicySnapshot),
    feature_policy_snapshot: publicFeaturePolicy(entitlement.featurePolicySnapshot),
    scope_allowlist: entitlement.scopeAllowlist,
    period_kind: entitlement.periodKind,
    period_start: entitlement.periodStart.toISOString(),
    period_end: entitlement.periodEnd?.toISOString() ?? null,
    state: entitlement.state,
    team_seat_id: entitlement.teamSeatId,
    created_at: entitlement.createdAt.toISOString(),
    cancelled_at: entitlement.cancelledAt?.toISOString() ?? null,
    cancelled_reason: entitlement.cancelledReason,
    notes: entitlement.notes
  };
}

function publicSubject(subject: Subject) {
  return {
    id: subject.id,
    label: subject.label,
    name: subject.name ?? null,
    phone_number: subject.phoneNumber ?? null,
    state: subject.state,
    created_at: subject.createdAt.toISOString()
  };
}

function credentialStatus(
  record: AccessCredentialRecord,
  subject: Subject | null | undefined,
  now: Date
): CredentialStatus {
  if (record.revokedAt) {
    return "revoked";
  }
  if (record.expiresAt.getTime() <= now.getTime()) {
    return "expired";
  }
  if (!subject) {
    return "user_missing";
  }
  if (subject.state === "disabled") {
    return "user_disabled";
  }
  if (subject.state === "archived") {
    return "user_archived";
  }
  return "active";
}

function subjectDisplayName(subject: Subject): string {
  return subject.name || subject.label || subject.id;
}
