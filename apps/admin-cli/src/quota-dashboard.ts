import { writeFileSync } from "node:fs";
import path from "node:path";
import {
  mergeEntitlementTokenPolicy,
  publicTokenPolicy,
  publicTokenUsage,
  type AccessCredentialRecord,
  type EntitlementAccessDecision,
  type Subject,
  type TokenLimitPolicy
} from "@codex-gateway/core";
import {
  createSqliteTokenBudgetLimiter,
  type SqliteGatewayStore
} from "@codex-gateway/store-sqlite";
import {
  credentialStatus,
  publicCredential,
  publicEntitlement,
  publicPlan,
  publicSubject
} from "./serializers.js";

type PublicTokenPolicy = ReturnType<typeof publicTokenPolicy>;
type PublicTokenUsage = ReturnType<typeof publicTokenUsage>;

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
  internal_reserve_tokens_per_request: number | null;
  internal_missing_usage_charge: TokenLimitPolicy["missingUsageCharge"] | null;
  warnings: string[];
}

interface DashboardData {
  generated_at: string;
  include_inactive: boolean;
  summary: {
    users: number;
    active_entitlements: number;
    legacy_users: number;
    inactive_or_expired_entitlements: number;
    users_without_quota: number;
    exhausted_users: number;
  };
  users: DashboardUser[];
}

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

async function buildQuotaDashboardData(
  store: SqliteGatewayStore,
  options: QuotaDashboardOptions
): Promise<DashboardData> {
  const now = options.now ?? new Date();
  const subjects = store
    .listSubjects({ includeArchived: true })
    .filter((subject) => options.includeInactive || subject.state === "active")
    .sort((a, b) => a.id.localeCompare(b.id));
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
    const resolved = resolveQuotaPolicy(store, subject, access, selectedCredential);
    const tokenUsage = resolved.policy
      ? publicTokenUsage(
          await limiter.getCurrentUsage({
            subjectId: subject.id,
            entitlementId: resolved.entitlement?.id ?? null,
            policy: resolved.policy,
            now
          })
        )
      : null;

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
      internal_reserve_tokens_per_request: resolved.policy?.reserveTokensPerRequest ?? null,
      internal_missing_usage_charge: resolved.policy?.missingUsageCharge ?? null,
      warnings: dashboardWarnings(subject, access, activeCredentials, resolved.policy, tokenUsage)
    });
  }

  const summary = {
    users: users.length,
    active_entitlements: users.filter((user) => user.access_status === "active").length,
    legacy_users: users.filter((user) => user.access_status === "legacy").length,
    inactive_or_expired_entitlements: users.filter(
      (user) => user.access_status === "expired" || user.access_status === "inactive"
    ).length,
    users_without_quota: users.filter((user) => !user.effective_token).length,
    exhausted_users: users.filter((user) => hasExhaustedWindow(user.token_usage)).length
  };

  return {
    generated_at: now.toISOString(),
    include_inactive: Boolean(options.includeInactive),
    summary,
    users
  };
}

function resolveQuotaPolicy(
  store: SqliteGatewayStore,
  subject: Subject,
  access: EntitlementAccessDecision,
  selectedCredential: AccessCredentialRecord | null
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
    selectedCredential?.rate.token ? selectedCredential : firstActiveTokenCredential(store, subject);
  return {
    plan: null,
    entitlement: null,
    planPolicy: null,
    policy: legacyTokenCredential?.rate.token ?? null
  };
}

function firstActiveTokenCredential(
  store: SqliteGatewayStore,
  subject: Subject
): AccessCredentialRecord | null {
  const now = new Date();
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
    warnings.push("No active API key");
  }
  if (access.status === "legacy") {
    warnings.push("Legacy user without active entitlement");
  }
  if (access.status === "expired") {
    warnings.push("Entitlement expired");
  }
  if (access.status === "inactive") {
    warnings.push(`Entitlement inactive: ${access.reason}`);
  }
  if (!subject.name || !subject.phoneNumber) {
    warnings.push("Missing contact metadata");
  }
  if (!policy) {
    warnings.push("No token quota policy");
  }
  if (policy?.tokensPerMinute !== null && policy && policy.reserveTokensPerRequest >= policy.tokensPerMinute) {
    warnings.push("Reserve tokens can exhaust minute quota");
  }
  if (hasExhaustedWindow(usage)) {
    warnings.push("Quota window exhausted");
  }
  return warnings;
}

function hasExhaustedWindow(usage: PublicTokenUsage | null): boolean {
  if (!usage) {
    return false;
  }
  return [usage.minute, usage.day, usage.month].some((window) => window.remaining === 0);
}

function renderQuotaDashboardHtml(data: DashboardData): string {
  const json = JSON.stringify(data).replaceAll("<", "\\u003c");
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Quota Dashboard</title>
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
      --ok: #0f8a5f;
      --warn: #b45309;
      --bad: #b91c1c;
      --neutral: #64748b;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font-family: Inter, "Segoe UI", Arial, sans-serif;
      font-size: 14px;
      line-height: 1.45;
    }
    header {
      padding: 20px 24px 14px;
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
    .summary {
      display: grid;
      grid-template-columns: repeat(6, minmax(128px, 1fr));
      gap: 1px;
      background: var(--line);
      border-bottom: 1px solid var(--line);
    }
    .metric {
      min-height: 78px;
      background: var(--surface);
      padding: 12px 14px;
    }
    .metric .label { color: var(--muted); font-size: 12px; }
    .metric .value { margin-top: 5px; font-size: 25px; font-weight: 700; letter-spacing: 0; }
    .toolbar {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 12px 24px;
      background: var(--surface);
      border-bottom: 1px solid var(--line);
      flex-wrap: wrap;
    }
    input[type="search"] {
      width: min(360px, 100%);
      min-height: 36px;
      padding: 7px 10px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: #fff;
      color: var(--text);
    }
    .segment {
      display: inline-flex;
      border: 1px solid var(--line);
      border-radius: 6px;
      overflow: hidden;
      background: #fff;
    }
    button {
      min-height: 34px;
      padding: 7px 10px;
      border: 0;
      border-right: 1px solid var(--line);
      background: #fff;
      color: var(--text);
      cursor: pointer;
      font: inherit;
    }
    button:last-child { border-right: 0; }
    button.active { background: var(--accent); color: #fff; }
    main { padding: 0 24px 24px; }
    .table-wrap {
      width: 100%;
      overflow: auto;
      border: 1px solid var(--line);
      border-top: 0;
      background: var(--surface);
    }
    table {
      width: 100%;
      min-width: 1180px;
      border-collapse: collapse;
      table-layout: fixed;
    }
    th, td {
      padding: 10px 11px;
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
    .quota-stack { display: grid; gap: 7px; }
    .quota-line {
      display: grid;
      grid-template-columns: 50px 1fr 154px;
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
    .fill {
      height: 100%;
      width: 0%;
      background: var(--ok);
    }
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
    @media (max-width: 900px) {
      header, .toolbar, main { padding-left: 14px; padding-right: 14px; }
      .summary { grid-template-columns: repeat(2, minmax(128px, 1fr)); }
      .toolbar { align-items: stretch; }
      .segment { width: 100%; overflow-x: auto; }
      button { white-space: nowrap; }
    }
  </style>
</head>
<body>
  <header>
    <h1>用户 Plan / Quota Dashboard</h1>
    <div class="meta">
      <span id="generatedAt"></span>
      <span id="scopeNote"></span>
    </div>
  </header>
  <section class="summary" aria-label="summary" id="summary"></section>
  <section class="toolbar" aria-label="filters">
    <input id="search" type="search" placeholder="搜索用户、姓名、plan、API key prefix">
    <div class="segment" role="group" aria-label="status filters">
      <button type="button" class="active" data-filter="all">全部</button>
      <button type="button" data-filter="active">Active entitlement</button>
      <button type="button" data-filter="legacy">Legacy</button>
      <button type="button" data-filter="warning">需要处理</button>
      <button type="button" data-filter="exhausted">额度用尽</button>
    </div>
  </section>
  <main>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th style="width: 210px;">用户</th>
            <th style="width: 210px;">Plan / Entitlement</th>
            <th style="width: 130px;">API key</th>
            <th style="width: 390px;">Quota / Usage</th>
            <th style="width: 170px;">请求限制</th>
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
    const data = JSON.parse(document.getElementById("dashboardData").textContent);
    const rowsEl = document.getElementById("rows");
    const emptyEl = document.getElementById("empty");
    const searchEl = document.getElementById("search");
    let filter = "all";

    document.getElementById("generatedAt").textContent = "Generated: " + formatDate(data.generated_at);
    document.getElementById("scopeNote").textContent = data.include_inactive ? "Including inactive users" : "Active users only";
    renderSummary();
    renderRows();

    searchEl.addEventListener("input", renderRows);
    document.querySelectorAll("button[data-filter]").forEach((button) => {
      button.addEventListener("click", () => {
        document.querySelectorAll("button[data-filter]").forEach((item) => item.classList.remove("active"));
        button.classList.add("active");
        filter = button.dataset.filter;
        renderRows();
      });
    });

    function renderSummary() {
      const metrics = [
        ["Users", data.summary.users],
        ["Active entitlement", data.summary.active_entitlements],
        ["Legacy", data.summary.legacy_users],
        ["Inactive / expired", data.summary.inactive_or_expired_entitlements],
        ["No quota policy", data.summary.users_without_quota],
        ["Quota exhausted", data.summary.exhausted_users]
      ];
      document.getElementById("summary").innerHTML = metrics.map(([label, value]) =>
        '<div class="metric"><div class="label">' + escapeHtml(label) + '</div><div class="value">' + value + '</div></div>'
      ).join("");
    }

    function renderRows() {
      const term = searchEl.value.trim().toLowerCase();
      const visible = data.users.filter((user) => matchesFilter(user, filter) && matchesSearch(user, term));
      rowsEl.innerHTML = visible.map(renderUserRow).join("");
      emptyEl.hidden = visible.length > 0;
    }

    function matchesFilter(user, currentFilter) {
      if (currentFilter === "active") return user.access_status === "active";
      if (currentFilter === "legacy") return user.access_status === "legacy";
      if (currentFilter === "warning") return user.warnings.length > 0;
      if (currentFilter === "exhausted") return hasExhaustedWindow(user.token_usage);
      return true;
    }

    function matchesSearch(user, term) {
      if (!term) return true;
      return JSON.stringify({
        id: user.user.id,
        label: user.user.label,
        name: user.user.name,
        plan: user.plan?.display_name,
        plan_id: user.plan?.id,
        credentials: user.credentials.map((credential) => credential.prefix)
      }).toLowerCase().includes(term);
    }

    function renderUserRow(user) {
      const severity = hasExhaustedWindow(user.token_usage) || user.access_status === "expired" ? "bad" : user.warnings.length ? "warn" : "ok";
      return '<tr data-severity="' + severity + '">' +
        '<td>' + renderUser(user) + '</td>' +
        '<td>' + renderPlan(user) + '</td>' +
        '<td>' + renderCredentials(user) + '</td>' +
        '<td>' + renderQuota(user) + '</td>' +
        '<td>' + renderLimits(user) + '</td>' +
        '<td>' + renderStatus(user) + '</td>' +
        '</tr>';
    }

    function renderUser(user) {
      return '<strong>' + escapeHtml(user.user.label || user.user.id) + '</strong>' +
        '<div class="subtle mono">' + escapeHtml(user.user.id) + '</div>' +
        '<div class="subtle">' + escapeHtml(user.user.name || "No name") + '</div>' +
        '<div class="subtle">' + escapeHtml(user.user.phone_number || "No phone") + '</div>';
    }

    function renderPlan(user) {
      if (!user.plan && !user.entitlement) {
        return '<span class="badge warn">legacy / no plan</span>';
      }
      const planName = user.plan?.display_name || user.entitlement?.plan_id || "Unknown plan";
      return '<strong>' + escapeHtml(planName) + '</strong>' +
        '<div class="subtle mono">' + escapeHtml(user.entitlement?.plan_id || "") + '</div>' +
        '<div>' + badge(user.access_status, user.access_status === "active" ? "ok" : "warn") + '</div>' +
        '<div class="subtle">' + formatPeriod(user.entitlement) + '</div>';
    }

    function renderCredentials(user) {
      if (user.credentials.length === 0) {
        return '<span class="badge bad">none</span>';
      }
      return user.credentials.map((credential) => {
        const kind = credential.status === "active" ? "ok" : "warn";
        return '<div><span class="badge ' + kind + '">' + escapeHtml(credential.status) + '</span>' +
          '<span class="mono">' + escapeHtml(credential.prefix) + '</span></div>';
      }).join("");
    }

    function renderQuota(user) {
      if (!user.effective_token || !user.token_usage) {
        return '<span class="badge warn">No token quota</span>';
      }
      return '<div class="quota-stack">' +
        renderWindow("Minute", user.token_usage.minute) +
        renderWindow("Day", user.token_usage.day) +
        renderWindow("Month", user.token_usage.month) +
        '</div>' +
        '<div class="subtle">Reserve/request: ' + formatNumber(user.internal_reserve_tokens_per_request) +
        ' · missing usage: ' + escapeHtml(user.internal_missing_usage_charge || "n/a") + '</div>';
    }

    function renderWindow(label, window) {
      if (window.limit === null) {
        return '<div class="quota-line"><span>' + label + '</span><div class="bar"><div class="fill" style="width:0%"></div></div><span class="subtle">Unlimited</span></div>';
      }
      const consumed = window.used + window.reserved;
      const pct = Math.max(0, Math.min(100, Math.round(consumed / window.limit * 100)));
      const level = pct >= 90 ? "high" : pct >= 70 ? "mid" : "";
      return '<div class="quota-line">' +
        '<span>' + label + '</span>' +
        '<div class="bar"><div class="fill ' + level + '" style="width:' + pct + '%"></div></div>' +
        '<span class="subtle">' + formatNumber(consumed) + ' / ' + formatNumber(window.limit) + ' · left ' + formatNumber(window.remaining) + '</span>' +
        '</div>';
    }

    function renderLimits(user) {
      const selected = user.credentials.find((credential) => credential.prefix === user.selected_credential_prefix) || user.credentials[0];
      if (!selected) return '<span class="subtle">No active key</span>';
      return '<div>RPM ' + formatNumber(selected.rate.requestsPerMinute) + '</div>' +
        '<div>RPD ' + formatNullable(selected.rate.requestsPerDay) + '</div>' +
        '<div>Concurrent ' + formatNullable(selected.rate.concurrentRequests) + '</div>' +
        '<div class="subtle mono">' + escapeHtml(selected.prefix) + '</div>';
    }

    function renderStatus(user) {
      const statusClass = user.access_status === "active" ? "ok" : user.access_status === "expired" ? "bad" : "warn";
      const warnings = user.warnings.length
        ? '<div>' + user.warnings.map((warning) => badge(warning, warning.includes("exhaust") || warning.includes("expired") ? "bad" : "warn")).join("") + '</div>'
        : '<span class="badge ok">ok</span>';
      return badge(user.user.state, user.user.state === "active" ? "ok" : "warn") +
        badge(user.access_reason || user.access_status, statusClass) +
        warnings;
    }

    function badge(text, kind) {
      return '<span class="badge ' + kind + '">' + escapeHtml(text) + '</span>';
    }

    function formatPeriod(entitlement) {
      if (!entitlement) return "";
      const end = entitlement.period_end ? formatDate(entitlement.period_end) : "No end";
      return entitlement.period_kind + " · " + formatDate(entitlement.period_start) + " - " + end;
    }

    function hasExhaustedWindow(usage) {
      return Boolean(usage && [usage.minute, usage.day, usage.month].some((window) => window.remaining === 0));
    }

    function formatNumber(value) {
      if (value === null || value === undefined) return "n/a";
      return Number(value).toLocaleString("en-US");
    }

    function formatNullable(value) {
      return value === null || value === undefined ? "none" : formatNumber(value);
    }

    function formatDate(value) {
      if (!value) return "n/a";
      return new Date(value).toLocaleString("zh-CN", { hour12: false });
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
</html>
`;
}
