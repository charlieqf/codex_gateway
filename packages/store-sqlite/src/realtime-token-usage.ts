import { createHash } from "node:crypto";
import type {
  AccessCredentialRecord,
  ClientMessageEventRecord,
  ClientMessageEventStore,
  RequestEventRecord,
  RequestTokenUsageSource,
  Subject
} from "@codex-gateway/core";
import { requestEventColumns } from "./columns.js";
import type { SqliteGatewayStore } from "./index.js";
import { rowToRequestEvent } from "./row-mappers.js";

export interface RealtimeTokenUsageOptions {
  clientEventsStore?: ClientMessageEventStore | null;
  now?: Date;
  windowSeconds?: number;
  bucketSeconds?: number;
  limit?: number;
  includeAuthNoise?: boolean;
}

export interface RealtimeTokenUsagePageOptions {
  authRequired?: boolean;
  dataEndpoint?: string;
}

export interface RealtimeTokenUsageData {
  generated_at: string;
  refresh_interval_ms: number;
  window: {
    since: string;
    until: string;
    seconds: number;
    bucket_seconds: number;
  };
  summary: {
    requests: number;
    ok: number;
    errors: number;
    rate_limited: number;
    total_tokens: number;
    provider_total_tokens: number;
    estimated_tokens: number;
    prompt_tokens: number;
    completion_tokens: number;
    cached_prompt_tokens: number;
  };
  privacy: {
    user_identifiers: "stable_hash_alias";
    messages: "hash_and_length_only";
    raw_message_text_included: false;
    raw_user_fields_included: false;
  };
  series: RealtimeTokenUsageSeriesPoint[];
  requests: RealtimeTokenUsageRequest[];
}

export interface RealtimeTokenUsageSeriesPoint {
  bucket_start: string;
  bucket_end: string;
  label: string;
  requests: number;
  total_tokens: number;
  provider_total_tokens: number;
  estimated_tokens: number;
}

export interface RealtimeTokenUsageRequest {
  request_id: string;
  started_at: string;
  user: {
    alias: string;
  };
  credential: {
    alias: string;
  };
  message: {
    available: boolean;
    alias: string;
    preview: string;
    char_count: number | null;
    attachments_count: number | null;
  };
  scope: string | null;
  provider: string | null;
  upstream_account_id: string | null;
  public_model_id: string | null;
  upstream_runtime: string | null;
  upstream_model: string | null;
  session_alias: string | null;
  status: RequestEventRecord["status"];
  error_code: string | null;
  rate_limited: boolean;
  limit_kind: string | null;
  duration_ms: number | null;
  first_byte_ms: number | null;
  token_usage: PublicRequestTokenUsage;
}

interface PublicRequestTokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cached_prompt_tokens: number;
  estimated_tokens: number;
  provider_total_tokens: number;
  source: RequestTokenUsageSource | null;
}

const defaultRefreshIntervalMs = 2_000;
const defaultWindowSeconds = 5 * 60;
const defaultBucketSeconds = 10;
const defaultRequestLimit = 100;
const maxRequestLimit = 500;
const maxClientMessageLookup = 1_000;
const messageLookupSkewMs = 60_000;
const authNoiseErrorCodes = new Set(["missing_credential", "invalid_credential"]);
const chartTimeFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Shanghai",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
  hourCycle: "h23"
});

export async function buildRealtimeTokenUsageData(
  store: SqliteGatewayStore,
  options: RealtimeTokenUsageOptions = {}
): Promise<RealtimeTokenUsageData> {
  const now = options.now ?? new Date();
  const windowSeconds = clampInteger(
    options.windowSeconds,
    defaultWindowSeconds,
    60,
    60 * 60
  );
  const bucketSeconds = clampInteger(options.bucketSeconds, defaultBucketSeconds, 2, 5 * 60);
  const limit = clampInteger(options.limit, defaultRequestLimit, 1, maxRequestLimit);
  const includeAuthNoise = options.includeAuthNoise ?? false;
  const eventLimit = includeAuthNoise
    ? limit
    : Math.min(maxRequestLimit, Math.max(limit * 3, limit + 50));
  const since = alignedWindowStart(now, windowSeconds, bucketSeconds);
  const events = listRealtimeRequestEvents(store, since, now, eventLimit);
  const messagesByRequestId = await clientMessagesByRequestId(options.clientEventsStore, since, now);
  const subjectsById = new Map(store.listSubjects({ includeArchived: true }).map((item) => [item.id, item]));
  const credentialsById = new Map(
    store.listAccessCredentials({ includeRevoked: true }).map((item) => [item.id, item])
  );

  const allRequests = events.map((event) =>
    publicRealtimeRequest(event, {
      subject: event.subjectId ? subjectsById.get(event.subjectId) ?? null : null,
      credential: event.credentialId ? credentialsById.get(event.credentialId) ?? null : null,
      message: messagesByRequestId.get(event.requestId) ?? null
    })
  );
  const requests = (includeAuthNoise
    ? allRequests
    : allRequests.filter((request) => !isAuthNoiseRequest(request))
  ).slice(0, limit);
  const summary = summarizeRequests(requests);

  return {
    generated_at: now.toISOString(),
    refresh_interval_ms: defaultRefreshIntervalMs,
    window: {
      since: since.toISOString(),
      until: now.toISOString(),
      seconds: windowSeconds,
      bucket_seconds: bucketSeconds
    },
    summary,
    privacy: {
      user_identifiers: "stable_hash_alias",
      messages: "hash_and_length_only",
      raw_message_text_included: false,
      raw_user_fields_included: false
    },
    series: buildSeries(requests, since, now, bucketSeconds),
    requests
  };
}

export function renderRealtimeTokenUsagePage(
  options: RealtimeTokenUsagePageOptions = {}
): string {
  const authRequired = options.authRequired ?? true;
  const dataEndpoint =
    options.dataEndpoint ?? "/gateway/admin/quota-dashboard/realtime-token-usage.json";

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>实时 Token 用量监控</title>
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
      --estimated: #d97706;
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
    h2 {
      margin: 0;
      font-size: 15px;
      font-weight: 700;
      letter-spacing: 0;
    }
    .meta { color: var(--muted); display: flex; gap: 14px; flex-wrap: wrap; }
    .controls {
      display: flex;
      align-items: end;
      gap: 10px;
      flex-wrap: wrap;
      justify-content: flex-end;
    }
    label { color: var(--muted); font-size: 12px; font-weight: 650; }
    .field {
      display: grid;
      gap: 5px;
    }
    input[type="password"], select {
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
    button, .nav-link {
      min-height: 34px;
      padding: 7px 10px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: #fff;
      color: var(--text);
      cursor: pointer;
      font: inherit;
      letter-spacing: 0;
      text-decoration: none;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      white-space: nowrap;
    }
    button.primary {
      border-color: var(--accent);
      background: var(--accent);
      color: #fff;
    }
    button.primary:hover { background: var(--accent-dark); }
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
    main {
      display: grid;
      gap: 12px;
      max-width: 100vw;
      overflow: hidden;
      padding: 12px 22px 24px;
    }
    .panel {
      border: 1px solid var(--line);
      border-radius: 6px;
      background: var(--surface);
      overflow: hidden;
    }
    .panel-header {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: center;
      padding: 12px 14px;
      border-bottom: 1px solid var(--line);
      background: #fbfcfe;
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
    .legend .total { background: var(--accent); }
    .legend .estimated { background: var(--estimated); }
    .chart-wrap {
      height: 292px;
      padding: 12px 14px 10px;
    }
    svg {
      display: block;
      width: 100%;
      height: 100%;
      overflow: visible;
    }
    .axis { stroke: #cbd5e1; stroke-width: 1; }
    .grid { stroke: #e5eaf2; stroke-width: 1; }
    .bar-total { fill: var(--accent); opacity: 0.88; }
    .bar-estimated { fill: var(--estimated); opacity: 0.86; }
    .axis-label {
      fill: var(--muted);
      font-size: 11px;
      font-variant-numeric: tabular-nums;
    }
    .notice {
      padding: 10px 12px;
      border: 1px solid #f3b5af;
      border-radius: 6px;
      background: #fff2f0;
      color: var(--bad);
    }
    .table-wrap {
      width: 100%;
      max-width: 100%;
      max-height: calc(100vh - 435px);
      min-height: 220px;
      overflow: auto;
      scrollbar-gutter: stable both-edges;
    }
    table {
      width: 1320px;
      min-width: 1320px;
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
    tbody tr:hover { background: #f7fbff; }
    tr[data-status="error"] { background: #fff7f7; }
    .num {
      text-align: center;
      vertical-align: middle;
      font-variant-numeric: tabular-nums;
    }
    .subtle { color: var(--muted); font-size: 12px; }
    .mono {
      font-family: "Cascadia Mono", Consolas, monospace;
      font-size: 12px;
    }
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
    .empty {
      padding: 32px;
      text-align: center;
      color: var(--muted);
    }
    @media (max-width: 960px) {
      header { align-items: stretch; flex-direction: column; }
      .controls { justify-content: flex-start; }
      header, main { padding-left: 14px; padding-right: 14px; }
      .summary { grid-template-columns: repeat(2, minmax(128px, 1fr)); }
      .panel-header { align-items: flex-start; flex-direction: column; }
      input[type="password"] { width: min(100%, 320px); }
      .table-wrap { max-height: calc(100vh - 520px); }
    }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>实时 Token 用量监控</h1>
      <div class="meta">
        <span id="generatedAt">刷新时间：-</span>
        <span id="windowMeta">窗口：-</span>
        <span id="privacyMeta">脱敏：-</span>
      </div>
    </div>
    <div class="controls">
      <a class="nav-link" href="/gateway/admin/quota-dashboard">Quota Dashboard</a>
      <label class="field"${authRequired ? "" : " hidden"}>Admin token
        <input id="token" type="password" autocomplete="off" placeholder="输入 admin token">
      </label>
      <label class="field">窗口
        <select id="windowSeconds">
          <option value="300" selected>5 分钟</option>
          <option value="900">15 分钟</option>
          <option value="3600">60 分钟</option>
        </select>
      </label>
      <label class="check"><input id="includeAuthNoise" type="checkbox">显示认证噪音</label>
      <label class="check"><input id="autoRefresh" type="checkbox" checked>2s 自动刷新</label>
      <button id="refresh" class="primary" type="button">刷新</button>
    </div>
  </header>
  <section class="summary" aria-label="summary" id="summary"></section>
  <main>
    <div class="notice" id="notice" hidden></div>
    <section class="panel" aria-label="token usage bucket chart">
      <div class="panel-header">
        <div>
          <h2>Token 用量趋势</h2>
          <div class="subtle" id="chartSubtitle">-</div>
        </div>
        <div class="legend" aria-label="token usage legend">
          <span><i class="total"></i>total tokens</span>
          <span><i class="estimated"></i>estimated tokens</span>
        </div>
      </div>
      <div class="chart-wrap" id="chartWrap">
        <svg id="tokenBucketChart" viewBox="0 0 760 250" role="img" aria-label="token usage bucket chart"></svg>
      </div>
    </section>
    <section class="panel" aria-label="realtime request list">
      <div class="panel-header">
        <h2>实时请求列表</h2>
        <div class="subtle" id="requestCount">-</div>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th style="width: 150px;">时间</th>
              <th style="width: 130px;">用户</th>
              <th style="width: 235px;">消息</th>
              <th class="num" style="width: 90px;">Total</th>
              <th class="num" style="width: 90px;">Prompt</th>
              <th class="num" style="width: 95px;">Completion</th>
              <th class="num" style="width: 95px;">Estimated</th>
              <th style="width: 130px;">状态</th>
              <th class="num" style="width: 95px;">耗时</th>
              <th>Request</th>
            </tr>
          </thead>
          <tbody id="rows"></tbody>
        </table>
      </div>
    </section>
  </main>
  <script>
    const authRequired = ${JSON.stringify(authRequired)};
    const dataEndpoint = ${JSON.stringify(dataEndpoint)};
    const tokenEl = document.getElementById("token");
    const windowEl = document.getElementById("windowSeconds");
    const autoEl = document.getElementById("autoRefresh");
    const refreshEl = document.getElementById("refresh");
    const noticeEl = document.getElementById("notice");
    const summaryEl = document.getElementById("summary");
    const rowsEl = document.getElementById("rows");
    const chartEl = document.getElementById("tokenBucketChart");
    const requestCountEl = document.getElementById("requestCount");
    const includeAuthNoiseEl = document.getElementById("includeAuthNoise");
    let data = null;
    let loading = false;
    let timer = null;

    if (tokenEl) {
      tokenEl.value = sessionStorage.getItem("gatewayAdminMessagesToken") || "";
      tokenEl.addEventListener("input", () => sessionStorage.setItem("gatewayAdminMessagesToken", tokenEl.value));
    }
    windowEl.addEventListener("change", () => load());
    includeAuthNoiseEl.addEventListener("change", () => load());
    autoEl.addEventListener("change", resetTimer);
    refreshEl.addEventListener("click", () => load());
    document.addEventListener("visibilitychange", resetTimer);

    rowsEl.innerHTML = '<tr><td colspan="10" class="subtle">等待数据</td></tr>';
    load();
    resetTimer();

    function resetTimer() {
      if (timer) window.clearInterval(timer);
      timer = null;
      if (autoEl.checked && !document.hidden) {
        timer = window.setInterval(() => {
          if (!loading) load();
        }, 2000);
      }
    }

    async function load() {
      const token = tokenEl ? tokenEl.value.trim() : "";
      if (authRequired && !token) {
        showNotice("需要 admin token。");
        tokenEl?.focus();
        return;
      }
      const params = new URLSearchParams();
      params.set("window_seconds", windowEl.value);
      params.set("bucket_seconds", String(bucketSecondsForWindow(Number(windowEl.value))));
      params.set("limit", "120");
      if (includeAuthNoiseEl.checked) params.set("include_auth_noise", "1");
      loading = true;
      refreshEl.disabled = true;
      refreshEl.textContent = "加载中";
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
        render();
      } catch (error) {
        showNotice(error.message || String(error));
      } finally {
        loading = false;
        refreshEl.disabled = false;
        refreshEl.textContent = "刷新";
      }
    }

    function render() {
      document.getElementById("generatedAt").textContent = "刷新时间：" + formatDateTime(data.generated_at);
      document.getElementById("windowMeta").textContent = "窗口：" + Math.round(data.window.seconds / 60) + " 分钟，bucket " + data.window.bucket_seconds + "s";
      document.getElementById("privacyMeta").textContent = "脱敏：用户别名，消息指纹/长度";
      document.getElementById("chartSubtitle").textContent = formatDateTime(data.window.since) + " - " + formatDateTime(data.window.until);
      renderSummary();
      renderBucketChart();
      renderRows();
    }

    function renderSummary() {
      const metrics = [
        ["请求", data.summary.requests],
        ["成功", data.summary.ok],
        ["错误", data.summary.errors],
        ["限流", data.summary.rate_limited],
        ["total tokens", data.summary.total_tokens],
        ["provider tokens", data.summary.provider_total_tokens],
        ["estimated tokens", data.summary.estimated_tokens],
        ["cached prompt", data.summary.cached_prompt_tokens]
      ];
      summaryEl.innerHTML = metrics.map(([label, value]) =>
        '<div class="metric"><div class="label">' + escapeHtml(label) + '</div><div class="value">' + formatNumber(value) + '</div></div>'
      ).join("");
    }

    function renderBucketChart() {
      const series = data.series || [];
      const width = 760;
      const height = 250;
      const left = 54;
      const right = 18;
      const top = 18;
      const bottom = 35;
      const plotWidth = width - left - right;
      const plotHeight = height - top - bottom;
      const maxValue = niceChartMax(Math.max(1, ...series.map((point) => Math.max(Number(point.total_tokens) || 0, Number(point.estimated_tokens) || 0))));
      const bars = barsFor(series, maxValue, left, top, plotWidth, plotHeight);
      const gridValues = [0, 0.25, 0.5, 0.75, 1];
      const grid = gridValues.map((ratio) => {
        const y = top + plotHeight - ratio * plotHeight;
        const value = Math.round(maxValue * ratio);
        return '<line class="grid" x1="' + left + '" y1="' + y + '" x2="' + (width - right) + '" y2="' + y + '"></line>' +
          '<text class="axis-label" x="8" y="' + (y + 4) + '">' + formatCompact(value) + '</text>';
      }).join("");
      const xLabels = xAxisLabels(series, left, top, plotWidth, plotHeight);
      chartEl.innerHTML =
        grid +
        '<line class="axis" x1="' + left + '" y1="' + (top + plotHeight) + '" x2="' + (width - right) + '" y2="' + (top + plotHeight) + '"></line>' +
        '<line class="axis" x1="' + left + '" y1="' + top + '" x2="' + left + '" y2="' + (top + plotHeight) + '"></line>' +
        bars +
        xLabels;
    }

    function barsFor(series, maxValue, left, top, plotWidth, plotHeight) {
      if (series.length === 0) return "";
      const slotWidth = plotWidth / series.length;
      const gap = Math.min(3, Math.max(1, slotWidth * 0.08));
      const barWidth = Math.max(3, Math.min(16, (slotWidth - gap * 3) / 2));
      return series.map((point, index) => {
        const slotStart = left + index * slotWidth;
        const groupWidth = barWidth * 2 + gap;
        const x = slotStart + Math.max(0, (slotWidth - groupWidth) / 2);
        return barFor(point, "total_tokens", "bar-total", x, barWidth, maxValue, top, plotHeight) +
          barFor(point, "estimated_tokens", "bar-estimated", x + barWidth + gap, barWidth, maxValue, top, plotHeight);
      }).join(" ");
    }

    function barFor(point, key, className, x, width, maxValue, top, plotHeight) {
      const value = Number(point[key]) || 0;
      const height = value > 0 ? Math.max(1, value / maxValue * plotHeight) : 0;
      const y = top + plotHeight - height;
      const title = point.label + " " + key + " " + formatNumber(value);
      return '<rect class="' + className + '" x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + width.toFixed(1) + '" height="' + height.toFixed(1) + '"><title>' + escapeHtml(title) + '</title></rect>';
    }

    function xAxisLabels(series, left, top, plotWidth, plotHeight) {
      if (series.length === 0) return "";
      const indexes = Array.from(new Set([0, Math.floor(series.length / 2), series.length - 1]));
      return indexes.map((index) => {
        const x = left + (index + 0.5) * (plotWidth / series.length);
        return '<text class="axis-label" text-anchor="middle" x="' + x.toFixed(1) + '" y="' + (top + plotHeight + 24) + '">' + escapeHtml(series[index].label) + '</text>';
      }).join("");
    }

    function niceChartMax(value) {
      const safeValue = Math.max(1, Number(value) || 1);
      const magnitude = Math.pow(10, Math.floor(Math.log10(safeValue)));
      const normalized = safeValue / magnitude;
      const nice = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
      return nice * magnitude;
    }

    function renderRows() {
      const requests = data.requests || [];
      requestCountEl.textContent = "显示 " + formatNumber(requests.length) + " 条";
      rowsEl.innerHTML = requests.length > 0
        ? requests.map(renderRow).join("")
        : '<tr><td colspan="10" class="empty">暂无实时请求</td></tr>';
    }

    function renderRow(row) {
      const usage = row.token_usage || {};
      const statusKind = row.status === "ok" ? "ok" : row.rate_limited ? "warn" : "bad";
      return '<tr data-status="' + escapeHtml(row.status) + '">' +
        '<td>' + escapeHtml(formatDateTime(row.started_at)) + '<div class="subtle">' + escapeHtml(row.provider || "") + '</div></td>' +
        '<td><strong>' + escapeHtml(row.user.alias) + '</strong><div class="subtle mono">' + escapeHtml(row.credential.alias) + '</div></td>' +
        '<td><strong>' + escapeHtml(row.message.alias) + '</strong><div class="subtle">' + escapeHtml(row.message.preview) + '</div></td>' +
        '<td class="num">' + formatNumber(usage.total_tokens) + '</td>' +
        '<td class="num">' + formatNumber(usage.prompt_tokens) + '</td>' +
        '<td class="num">' + formatNumber(usage.completion_tokens) + '</td>' +
        '<td class="num">' + formatNumber(usage.estimated_tokens) + '</td>' +
        '<td>' + badge(row.status, statusKind) + (row.error_code ? '<div class="subtle">' + escapeHtml(row.error_code) + '</div>' : '') + (row.limit_kind ? '<div class="subtle">' + escapeHtml(row.limit_kind) + '</div>' : '') + '</td>' +
        '<td class="num">' + formatNumber(row.duration_ms) + ' ms<div class="subtle">fb ' + formatNumber(row.first_byte_ms) + '</div></td>' +
        '<td><span class="mono">' + escapeHtml(row.request_id) + '</span><div class="subtle mono">' + escapeHtml(row.session_alias || "") + '</div></td>' +
      '</tr>';
    }

    function bucketSecondsForWindow(seconds) {
      if (seconds <= 300) return 10;
      if (seconds <= 900) return 30;
      return 120;
    }

    function badge(text, kind) {
      return '<span class="badge ' + kind + '">' + escapeHtml(text) + '</span>';
    }

    function formatNumber(value) {
      if (value === null || value === undefined) return "n/a";
      return Number(value).toLocaleString("en-US");
    }

    function formatCompact(value) {
      return Number(value).toLocaleString("en-US", { notation: "compact", maximumFractionDigits: 1 });
    }

    function formatDateTime(value) {
      if (!value) return "n/a";
      return new Date(value).toLocaleString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" });
    }

    function showNotice(text) {
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

function listRealtimeRequestEvents(
  store: SqliteGatewayStore,
  since: Date,
  until: Date,
  limit: number
): RequestEventRecord[] {
  return store.database
    .prepare(
      `SELECT ${requestEventColumns}
       FROM request_events
       WHERE started_at >= ? AND started_at <= ?
       ORDER BY started_at DESC
       LIMIT ?`
    )
    .all(since.toISOString(), until.toISOString(), limit)
    .map(rowToRequestEvent);
}

async function clientMessagesByRequestId(
  store: ClientMessageEventStore | null | undefined,
  since: Date,
  until: Date
): Promise<Map<string, ClientMessageEventRecord>> {
  const byRequestId = new Map<string, ClientMessageEventRecord>();
  if (!store) {
    return byRequestId;
  }
  const messages = store.listClientMessageEvents({
    since: new Date(since.getTime() - messageLookupSkewMs),
    until,
    limit: maxClientMessageLookup
  });
  for (const message of messages) {
    const existing = byRequestId.get(message.requestId);
    if (!existing || message.createdAt.getTime() > existing.createdAt.getTime()) {
      byRequestId.set(message.requestId, message);
    }
  }
  return byRequestId;
}

function publicRealtimeRequest(
  event: RequestEventRecord,
  input: {
    subject: Subject | null;
    credential: AccessCredentialRecord | null;
    message: ClientMessageEventRecord | null;
  }
): RealtimeTokenUsageRequest {
  const stableUserId =
    event.subjectId ?? input.message?.subjectId ?? input.credential?.subjectId ?? event.requestId;
  const stableCredentialId = event.credentialId ?? input.message?.credentialId ?? event.requestId;
  return {
    request_id: event.requestId,
    started_at: event.startedAt.toISOString(),
    user: {
      alias: stableAlias("user", stableUserId)
    },
    credential: {
      alias: stableAlias("key", stableCredentialId)
    },
    message: publicAnonymizedMessage(input.message),
    scope: event.scope,
    provider: event.provider,
    upstream_account_id: event.upstreamAccountId,
    public_model_id: event.publicModelId ?? null,
    upstream_runtime: event.upstreamRuntime ?? null,
    upstream_model: event.upstreamModel ?? null,
    session_alias: event.sessionId ? stableAlias("session", event.sessionId) : null,
    status: event.status,
    error_code: event.errorCode,
    rate_limited: event.rateLimited,
    limit_kind: event.limitKind ?? null,
    duration_ms: event.durationMs,
    first_byte_ms: event.firstByteMs,
    token_usage: publicTokenUsage(event)
  };
}

function publicAnonymizedMessage(
  message: ClientMessageEventRecord | null
): RealtimeTokenUsageRequest["message"] {
  if (!message) {
    return {
      available: false,
      alias: "msg-unavailable",
      preview: "未收到客户端消息",
      char_count: null,
      attachments_count: null
    };
  }
  const charCount = Array.from(message.text).length;
  const attachmentsCount = attachmentCount(message.attachmentsJson);
  return {
    available: true,
    alias: stableAlias("msg", `${message.subjectId}:${message.messageId}:${message.textSha256}`),
    preview:
      "消息指纹 " +
      stableHash(`${message.textSha256}:${message.eventId}`).slice(0, 10) +
      " · " +
      charCount.toLocaleString("en-US") +
      " chars" +
      (attachmentsCount === null ? "" : " · " + attachmentsCount.toLocaleString("en-US") + " attachments"),
    char_count: charCount,
    attachments_count: attachmentsCount
  };
}

function publicTokenUsage(event: RequestEventRecord): PublicRequestTokenUsage {
  const promptTokens = nonNegativeInteger(event.promptTokens);
  const completionTokens = nonNegativeInteger(event.completionTokens);
  const cachedPromptTokens = nonNegativeInteger(event.cachedPromptTokens);
  const estimatedTokens = nonNegativeInteger(event.estimatedTokens);
  const explicitTotalTokens = nonNegativeIntegerOrNull(event.totalTokens);
  const fallbackTotalTokens = promptTokens + completionTokens || estimatedTokens;
  const totalTokens = explicitTotalTokens ?? fallbackTotalTokens;
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: totalTokens,
    cached_prompt_tokens: cachedPromptTokens,
    estimated_tokens: estimatedTokens,
    provider_total_tokens: Math.max(0, totalTokens - estimatedTokens),
    source: event.usageSource ?? null
  };
}

function summarizeRequests(
  requests: RealtimeTokenUsageRequest[]
): RealtimeTokenUsageData["summary"] {
  return requests.reduce(
    (summary, request) => {
      summary.requests += 1;
      if (request.status === "ok") {
        summary.ok += 1;
      } else {
        summary.errors += 1;
      }
      if (request.rate_limited) {
        summary.rate_limited += 1;
      }
      summary.total_tokens += request.token_usage.total_tokens;
      summary.provider_total_tokens += request.token_usage.provider_total_tokens;
      summary.estimated_tokens += request.token_usage.estimated_tokens;
      summary.prompt_tokens += request.token_usage.prompt_tokens;
      summary.completion_tokens += request.token_usage.completion_tokens;
      summary.cached_prompt_tokens += request.token_usage.cached_prompt_tokens;
      return summary;
    },
    {
      requests: 0,
      ok: 0,
      errors: 0,
      rate_limited: 0,
      total_tokens: 0,
      provider_total_tokens: 0,
      estimated_tokens: 0,
      prompt_tokens: 0,
      completion_tokens: 0,
      cached_prompt_tokens: 0
    }
  );
}

function isAuthNoiseRequest(request: RealtimeTokenUsageRequest): boolean {
  return (
    request.status === "error" &&
    authNoiseErrorCodes.has(request.error_code ?? "") &&
    request.token_usage.total_tokens === 0 &&
    request.token_usage.estimated_tokens === 0
  );
}

function buildSeries(
  requests: RealtimeTokenUsageRequest[],
  since: Date,
  until: Date,
  bucketSeconds: number
): RealtimeTokenUsageSeriesPoint[] {
  const bucketMs = bucketSeconds * 1000;
  const bucketCount = Math.max(1, Math.floor((until.getTime() - since.getTime()) / bucketMs) + 1);
  const buckets = Array.from({ length: bucketCount }, (_value, index) => {
    const bucketStart = new Date(since.getTime() + index * bucketMs);
    const bucketEnd = new Date(Math.min(bucketStart.getTime() + bucketMs, until.getTime()));
    return {
      bucket_start: bucketStart.toISOString(),
      bucket_end: bucketEnd.toISOString(),
      label: chartTimeFormatter.format(bucketStart),
      requests: 0,
      total_tokens: 0,
      provider_total_tokens: 0,
      estimated_tokens: 0
    };
  });

  for (const request of requests) {
    const startedMs = new Date(request.started_at).getTime();
    const index = Math.min(
      buckets.length - 1,
      Math.max(0, Math.floor((startedMs - since.getTime()) / bucketMs))
    );
    const bucket = buckets[index];
    bucket.requests += 1;
    bucket.total_tokens += request.token_usage.total_tokens;
    bucket.provider_total_tokens += request.token_usage.provider_total_tokens;
    bucket.estimated_tokens += request.token_usage.estimated_tokens;
  }

  return buckets;
}

function alignedWindowStart(now: Date, windowSeconds: number, bucketSeconds: number): Date {
  const bucketMs = bucketSeconds * 1000;
  const activeBucketStartMs = Math.floor(now.getTime() / bucketMs) * bucketMs;
  return new Date(activeBucketStartMs - windowSeconds * 1000);
}

function nonNegativeInteger(value: number | null | undefined): number {
  return nonNegativeIntegerOrNull(value) ?? 0;
}

function nonNegativeIntegerOrNull(value: number | null | undefined): number | null {
  if (!Number.isFinite(value)) {
    return null;
  }
  return Math.max(0, Math.trunc(Number(value)));
}

function attachmentCount(json: string): number | null {
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? parsed.length : null;
  } catch {
    return null;
  }
}

function stableAlias(prefix: string, value: string): string {
  return `${prefix}-${stableHash(value).slice(0, 8)}`;
}

function stableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function clampInteger(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number
): number {
  if (!Number.isInteger(value) || value === undefined) {
    return fallback;
  }
  return Math.max(min, Math.min(max, value));
}
