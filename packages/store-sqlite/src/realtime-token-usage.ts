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
  models: RealtimeTokenUsageModelSummary[];
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
  models: RealtimeTokenUsageSeriesModelPoint[];
}

export interface RealtimeTokenUsageModelSummary {
  public_model_id: string;
  model_display_name: string;
  upstream_runtime: string | null;
  upstream_model: string | null;
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
  share_total_tokens: number;
}

export interface RealtimeTokenUsageSeriesModelPoint {
  public_model_id: string;
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
const defaultPublicModelIds = ["max", "specialist", "expert", "pro", "standard"];
const publicModelDisplayNames: Record<string, string> = {
  max: "Max",
  specialist: "Specialist",
  expert: "Expert",
  pro: "Pro",
  standard: "Standard",
  unknown: "Unknown"
};
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
  const statEvents = listRealtimeRequestEvents(store, since, now);
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
  const allStatRequests = statEvents.map((event) =>
    publicRealtimeRequest(event, {
      subject: null,
      credential: null,
      message: null
    })
  );
  const statRequests = includeAuthNoise
    ? allStatRequests
    : allStatRequests.filter((request) => !isAuthNoiseRequest(request));
  const summary = summarizeRequests(statRequests);
  const models = summarizeModels(statRequests);

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
    models,
    privacy: {
      user_identifiers: "stable_hash_alias",
      messages: "hash_and_length_only",
      raw_message_text_included: false,
      raw_user_fields_included: false
    },
    series: buildSeries(statRequests, since, now, bucketSeconds, models.map((model) => model.public_model_id)),
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
    .legend .model-dot { background: var(--accent); }
    .model-grid {
      display: grid;
      grid-template-columns: repeat(5, minmax(150px, 1fr));
      gap: 1px;
      background: var(--line);
    }
    .model-card {
      display: grid;
      gap: 7px;
      min-height: 126px;
      padding: 12px;
      border: 0;
      border-left: 4px solid var(--accent);
      border-radius: 0;
      background: var(--surface);
      text-align: left;
      cursor: pointer;
      white-space: normal;
      align-items: stretch;
      justify-content: stretch;
      min-width: 0;
    }
    .model-card * { min-width: 0; }
    .model-card:hover { background: #f7fbff; }
    .model-card.selected { outline: 2px solid var(--accent); outline-offset: -2px; }
    .model-card .title {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      align-items: baseline;
      color: var(--text);
      font-weight: 700;
    }
    .model-card .stats {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 6px 10px;
      color: var(--muted);
      font-size: 12px;
      font-variant-numeric: tabular-nums;
    }
    .model-card .stats strong {
      display: block;
      color: var(--text);
      font-size: 15px;
      letter-spacing: 0;
    }
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
      width: 1455px;
      min-width: 1455px;
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
      .model-grid { grid-template-columns: repeat(2, minmax(128px, 1fr)); }
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
      <label class="field">Model
        <select id="modelFilter">
          <option value="all" selected>All models</option>
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
    <section class="panel" aria-label="model traffic summary">
      <div class="panel-header">
        <div>
          <h2>Model traffic</h2>
          <div class="subtle" id="modelSubtitle">Public model breakdown for the current window</div>
        </div>
      </div>
      <div class="model-grid" id="modelSummary"></div>
    </section>
    <section class="panel" aria-label="token usage bucket chart">
      <div class="panel-header">
        <div>
          <h2>Token 用量趋势</h2>
          <div class="subtle" id="chartSubtitle">-</div>
        </div>
        <div class="legend" aria-label="token usage legend" id="chartLegend">
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
              <th style="width: 135px;">Model</th>
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
    const modelFilterEl = document.getElementById("modelFilter");
    const autoEl = document.getElementById("autoRefresh");
    const refreshEl = document.getElementById("refresh");
    const noticeEl = document.getElementById("notice");
    const summaryEl = document.getElementById("summary");
    const rowsEl = document.getElementById("rows");
    const chartEl = document.getElementById("tokenBucketChart");
    const chartLegendEl = document.getElementById("chartLegend");
    const modelSummaryEl = document.getElementById("modelSummary");
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
    modelFilterEl.addEventListener("change", () => {
      if (data) render();
    });
    includeAuthNoiseEl.addEventListener("change", () => load());
    autoEl.addEventListener("change", resetTimer);
    refreshEl.addEventListener("click", () => load());
    document.addEventListener("visibilitychange", resetTimer);

    rowsEl.innerHTML = '<tr><td colspan="11" class="subtle">等待数据</td></tr>';
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
      renderModelOptions();
      renderSummary();
      renderModelSummary();
      renderBucketChart();
      renderRows();
    }

    function renderModelOptions() {
      const selected = modelFilterEl.value || "all";
      const models = data.models || [];
      modelFilterEl.innerHTML = '<option value="all">All models</option>' + models.map((model) =>
        '<option value="' + escapeHtml(model.public_model_id) + '">' + escapeHtml(model.model_display_name) + '</option>'
      ).join("");
      modelFilterEl.value = selected === "all" || models.some((model) => model.public_model_id === selected)
        ? selected
        : "all";
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

    function renderModelSummary() {
      const selectedModel = modelFilterEl.value || "all";
      const models = data.models || [];
      modelSummaryEl.innerHTML = models.map((model) => {
        const selectedClass = selectedModel === model.public_model_id ? " selected" : "";
        const color = modelColor(model.public_model_id);
        const share = Math.round((Number(model.share_total_tokens) || 0) * 1000) / 10;
        return '<button type="button" class="model-card' + selectedClass + '" data-model="' + escapeHtml(model.public_model_id) + '" style="border-left-color:' + color + '">' +
          '<div class="title"><span>' + escapeHtml(model.model_display_name) + '</span><span class="mono">' + escapeHtml(model.public_model_id) + '</span></div>' +
          '<div class="subtle">' + escapeHtml(model.upstream_runtime || "-") + (model.upstream_model ? " / " + escapeHtml(model.upstream_model) : "") + '</div>' +
          '<div class="stats">' +
            '<span><strong>' + formatNumber(model.requests) + '</strong>requests</span>' +
            '<span><strong>' + formatNumber(model.total_tokens) + '</strong>total tokens</span>' +
            '<span><strong>' + formatNumber(model.provider_total_tokens) + '</strong>provider</span>' +
            '<span><strong>' + formatNumber(model.estimated_tokens) + '</strong>estimated</span>' +
            '<span><strong>' + formatNumber(model.rate_limited) + '</strong>rate limited</span>' +
            '<span><strong>' + share.toLocaleString("en-US") + '%</strong>share</span>' +
          '</div>' +
        '</button>';
      }).join("");
      modelSummaryEl.querySelectorAll("[data-model]").forEach((button) => {
        button.addEventListener("click", () => {
          modelFilterEl.value = button.getAttribute("data-model") || "all";
          render();
        });
      });
    }

    function renderBucketChart() {
      const series = data.series || [];
      const selectedModel = modelFilterEl.value || "all";
      const selectedModelSummary = modelSummary(selectedModel);
      const width = 760;
      const height = 250;
      const left = 54;
      const right = 18;
      const top = 18;
      const bottom = 35;
      const plotWidth = width - left - right;
      const plotHeight = height - top - bottom;
      const modelIds = chartModelIds();
      const maxValue = niceChartMax(Math.max(1, ...series.map((point) =>
        selectedModel === "all"
          ? Number(point.total_tokens) || 0
          : Math.max(
              Number(seriesModel(point, selectedModel)?.total_tokens) || 0,
              Number(seriesModel(point, selectedModel)?.estimated_tokens) || 0
            )
      )));
      const bars = selectedModel === "all"
        ? stackedModelBarsFor(series, modelIds, maxValue, left, top, plotWidth, plotHeight)
        : selectedModelBarsFor(series, selectedModel, maxValue, left, top, plotWidth, plotHeight);
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
      chartLegendEl.innerHTML = selectedModel === "all"
        ? modelIds.map((modelId) => '<span><i class="model-dot" style="background:' + modelColor(modelId) + '"></i>' + escapeHtml(modelLabel(modelId)) + '</span>').join("")
        : '<span><i class="model-dot" style="background:' + modelColor(selectedModel) + '"></i>' + escapeHtml(selectedModelSummary?.model_display_name || selectedModel) + ' total tokens</span><span><i class="estimated"></i>estimated tokens</span>';
    }

    function stackedModelBarsFor(series, modelIds, maxValue, left, top, plotWidth, plotHeight) {
      if (series.length === 0) return "";
      const slotWidth = plotWidth / series.length;
      const barWidth = Math.max(3, Math.min(18, slotWidth * 0.62));
      return series.map((point, index) => {
        const slotStart = left + index * slotWidth;
        const x = slotStart + Math.max(0, (slotWidth - barWidth) / 2);
        let y = top + plotHeight;
        return modelIds.map((modelId) => {
          const value = Number(seriesModel(point, modelId)?.total_tokens) || 0;
          if (value <= 0) return "";
          const height = Math.max(1, value / maxValue * plotHeight);
          y -= height;
          const title = point.label + " " + modelLabel(modelId) + " total_tokens " + formatNumber(value);
          return '<rect x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + barWidth.toFixed(1) + '" height="' + height.toFixed(1) + '" fill="' + modelColor(modelId) + '"><title>' + escapeHtml(title) + '</title></rect>';
        }).join("");
      }).join(" ");
    }

    function selectedModelBarsFor(series, modelId, maxValue, left, top, plotWidth, plotHeight) {
      if (series.length === 0) return "";
      const slotWidth = plotWidth / series.length;
      const gap = Math.min(3, Math.max(1, slotWidth * 0.08));
      const barWidth = Math.max(3, Math.min(16, (slotWidth - gap * 3) / 2));
      return series.map((point, index) => {
        const slotStart = left + index * slotWidth;
        const groupWidth = barWidth * 2 + gap;
        const x = slotStart + Math.max(0, (slotWidth - groupWidth) / 2);
        const model = seriesModel(point, modelId);
        return barForValue(point, modelId, "total_tokens", Number(model?.total_tokens) || 0, modelColor(modelId), x, barWidth, maxValue, top, plotHeight) +
          barForValue(point, modelId, "estimated_tokens", Number(model?.estimated_tokens) || 0, "#d97706", x + barWidth + gap, barWidth, maxValue, top, plotHeight);
      }).join(" ");
    }

    function barForValue(point, modelId, key, value, color, x, width, maxValue, top, plotHeight) {
      const height = value > 0 ? Math.max(1, value / maxValue * plotHeight) : 0;
      const y = top + plotHeight - height;
      const title = point.label + " " + modelLabel(modelId) + " " + key + " " + formatNumber(value);
      return '<rect x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + width.toFixed(1) + '" height="' + height.toFixed(1) + '" fill="' + color + '"><title>' + escapeHtml(title) + '</title></rect>';
    }

    function chartModelIds() {
      return (data.models || []).map((model) => model.public_model_id);
    }

    function modelSummary(modelId) {
      return (data.models || []).find((model) => model.public_model_id === modelId) || null;
    }

    function seriesModel(point, modelId) {
      return (point.models || []).find((model) => model.public_model_id === modelId) || null;
    }

    function modelLabel(modelId) {
      return modelSummary(modelId)?.model_display_name || modelId || "-";
    }

    function modelColor(modelId) {
      const colors = {
        max: "#2563eb",
        specialist: "#059669",
        expert: "#7c3aed",
        pro: "#d97706",
        standard: "#dc2626",
        unknown: "#64748b"
      };
      return colors[modelId] || "#475569";
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
      const selectedModel = modelFilterEl.value || "all";
      const requests = selectedModel === "all"
        ? data.requests || []
        : (data.requests || []).filter((request) => request.public_model_id === selectedModel);
      requestCountEl.textContent = "显示 " + formatNumber(requests.length) + " 条";
      rowsEl.innerHTML = requests.length > 0
        ? requests.map(renderRow).join("")
        : '<tr><td colspan="11" class="empty">暂无实时请求</td></tr>';
    }

    function renderRow(row) {
      const usage = row.token_usage || {};
      const statusKind = row.status === "ok" ? "ok" : row.rate_limited ? "warn" : "bad";
      return '<tr data-status="' + escapeHtml(row.status) + '">' +
        '<td>' + escapeHtml(formatDateTime(row.started_at)) + '<div class="subtle">' + escapeHtml(row.provider || "") + '</div></td>' +
        '<td><strong>' + escapeHtml(row.user.alias) + '</strong><div class="subtle mono">' + escapeHtml(row.credential.alias) + '</div></td>' +
        '<td><strong>' + escapeHtml(row.message.alias) + '</strong><div class="subtle">' + escapeHtml(row.message.preview) + '</div></td>' +
        '<td><strong>' + escapeHtml(modelLabel(row.public_model_id)) + '</strong><div class="subtle mono">' + escapeHtml(row.public_model_id || "-") + '</div><div class="subtle">' + escapeHtml(row.upstream_runtime || "") + '</div></td>' +
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
  limit?: number
): RequestEventRecord[] {
  const params: Array<string | number> = [since.toISOString(), until.toISOString()];
  if (limit !== undefined) {
    params.push(limit);
  }
  return store.database
    .prepare(
      `SELECT ${requestEventColumns}
       FROM request_events
       WHERE started_at >= ? AND started_at <= ?
       ORDER BY started_at DESC${limit === undefined ? "" : " LIMIT ?"}`
    )
    .all(...params)
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
    public_model_id: canonicalPublicModelId(event.publicModelId),
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

function summarizeModels(requests: RealtimeTokenUsageRequest[]): RealtimeTokenUsageModelSummary[] {
  const byModel = new Map<string, RealtimeTokenUsageModelSummary>();
  for (const modelId of defaultPublicModelIds) {
    byModel.set(modelId, emptyModelSummary(modelId));
  }

  for (const request of requests) {
    const modelId = modelIdForAggregation(request.public_model_id);
    let summary = byModel.get(modelId);
    if (!summary) {
      summary = emptyModelSummary(modelId);
      byModel.set(modelId, summary);
    }
    addRequestToModelSummary(summary, request);
  }

  const totalTokens = Array.from(byModel.values()).reduce(
    (sum, model) => sum + model.total_tokens,
    0
  );
  for (const summary of byModel.values()) {
    summary.share_total_tokens =
      totalTokens > 0 ? Number((summary.total_tokens / totalTokens).toFixed(6)) : 0;
  }

  const modelOrder = new Map(defaultPublicModelIds.map((id, index) => [id, index]));
  return Array.from(byModel.values()).sort((left, right) => {
    const leftOrder = modelOrder.get(left.public_model_id);
    const rightOrder = modelOrder.get(right.public_model_id);
    if (leftOrder !== undefined || rightOrder !== undefined) {
      return (leftOrder ?? Number.MAX_SAFE_INTEGER) - (rightOrder ?? Number.MAX_SAFE_INTEGER);
    }
    return right.total_tokens - left.total_tokens || left.public_model_id.localeCompare(right.public_model_id);
  });
}

function addRequestToModelSummary(
  summary: RealtimeTokenUsageModelSummary,
  request: RealtimeTokenUsageRequest
): void {
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
  if (!summary.upstream_runtime && request.upstream_runtime) {
    summary.upstream_runtime = request.upstream_runtime;
  }
  if (!summary.upstream_model && request.upstream_model) {
    summary.upstream_model = request.upstream_model;
  }
}

function emptyModelSummary(modelId: string): RealtimeTokenUsageModelSummary {
  return {
    public_model_id: modelId,
    model_display_name: publicModelDisplayNames[modelId] ?? modelId,
    upstream_runtime: null,
    upstream_model: null,
    requests: 0,
    ok: 0,
    errors: 0,
    rate_limited: 0,
    total_tokens: 0,
    provider_total_tokens: 0,
    estimated_tokens: 0,
    prompt_tokens: 0,
    completion_tokens: 0,
    cached_prompt_tokens: 0,
    share_total_tokens: 0
  };
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
  bucketSeconds: number,
  modelIds: string[]
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
      estimated_tokens: 0,
      models: modelIds.map(emptySeriesModelPoint)
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
    const modelId = modelIdForAggregation(request.public_model_id);
    let model = bucket.models.find((item) => item.public_model_id === modelId);
    if (!model) {
      model = emptySeriesModelPoint(modelId);
      bucket.models.push(model);
    }
    model.requests += 1;
    model.total_tokens += request.token_usage.total_tokens;
    model.provider_total_tokens += request.token_usage.provider_total_tokens;
    model.estimated_tokens += request.token_usage.estimated_tokens;
  }

  return buckets;
}

function emptySeriesModelPoint(modelId: string): RealtimeTokenUsageSeriesModelPoint {
  return {
    public_model_id: modelId,
    requests: 0,
    total_tokens: 0,
    provider_total_tokens: 0,
    estimated_tokens: 0
  };
}

function modelIdForAggregation(modelId: string | null | undefined): string {
  return canonicalPublicModelId(modelId) ?? "unknown";
}

function canonicalPublicModelId(modelId: string | null | undefined): string | null {
  const normalized = modelId?.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  return normalized === "medcode" ? "max" : normalized;
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
