import { timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type {
  AccessCredentialRecord,
  ClientMessageEventRecord,
  ClientMessageEventStore,
  CredentialAuthStore,
  ListClientMessageEventsInput,
  ObservationStore,
  RequestEventRecord,
  RequestUsageReportRow,
  Subject
} from "@codex-gateway/core";

export const adminMessagesTokenEnvName = "GATEWAY_ADMIN_MESSAGES_TOKEN";
export const adminMessagesAuthEnvName = "GATEWAY_ADMIN_MESSAGES_AUTH";
export type AdminMessagesAuthMode = "token" | "open";

export interface AdminMessagesAccess {
  mode: AdminMessagesAuthMode;
  token: string | null;
}

export interface AdminClientMessagesQuery {
  user?: string;
  subject_id?: string;
  credential_prefix?: string;
  session_id?: string;
  message_id?: string;
  q?: string;
  since?: string;
  until?: string;
  hours?: string;
  limit?: string;
  offset?: string;
  include_text?: string;
  preview_chars?: string;
  sort_by?: string;
  sort_order?: string;
}

type AdminUserSortBy =
  | "requests"
  | "tokens"
  | "errors"
  | "rate_limited"
  | "avg_duration"
  | "name";
type AdminSortOrder = "asc" | "desc";
type MessageRequestOutcome = "success" | "partial" | "failed" | "no_request";

interface MessageRequestSummary {
  outcome: MessageRequestOutcome;
  success: boolean | null;
  request_count: number;
  success_count: number;
  error_count: number;
  rate_limited_count: number;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  summed_request_duration_ms: number;
  error_codes: string[];
  token_usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    estimated_tokens: number;
    effective_tokens: number;
    cached_prompt_tokens: number;
    usage_missing_count: number;
  };
}

export function resolveAdminMessagesAccess(input: {
  token?: string;
  authMode?: string;
}): AdminMessagesAccess | null {
  const authMode = input.authMode?.trim().toLowerCase();
  if (authMode === "open") {
    return { mode: "open", token: null };
  }
  if (authMode && authMode !== "token") {
    throw new Error(`${adminMessagesAuthEnvName} must be token or open.`);
  }

  const token = input.token?.trim();
  if (!token) {
    return null;
  }
  if (token.length < 24) {
    throw new Error(`${adminMessagesTokenEnvName} must be at least 24 characters.`);
  }
  return { mode: "token", token };
}

export function authenticateAdminMessagesRequest(
  request: FastifyRequest,
  token: string
): boolean {
  const authorization = request.headers.authorization;
  if (!authorization) {
    return false;
  }

  const [scheme, received] = authorization.split(/\s+/, 2);
  return scheme?.toLowerCase() === "bearer" && safeEqual(received ?? "", token);
}

export function sendAdminMessagesUnavailable(reply: FastifyReply) {
  reply.code(404).send({
    error: {
      code: "not_found",
      message: "Not found."
    }
  });
}

export function sendAdminMessagesUnauthorized(reply: FastifyReply) {
  reply
    .code(401)
    .header("www-authenticate", 'Bearer realm="codex-gateway-admin-messages"')
    .send({
      error: {
        code: "unauthorized",
        message: "Admin messages token is required."
      }
    });
}

export function adminMessagesSecurityHeaders(reply: FastifyReply): FastifyReply {
  return reply
    .header("cache-control", "no-store")
    .header("x-robots-tag", "noindex, nofollow")
    .header("x-content-type-options", "nosniff")
    .header("content-security-policy", [
      "default-src 'none'",
      "style-src 'unsafe-inline'",
      "script-src 'unsafe-inline'",
      "connect-src 'self'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'"
    ].join("; "));
}

export function buildAdminClientMessagesPayload(input: {
  clientEventsStore: ClientMessageEventStore;
  credentialStore: CredentialAuthStore;
  observationStore?: ObservationStore;
  query: AdminClientMessagesQuery;
}) {
  const limit = parseInteger(input.query.limit, 100, 1, 500);
  const offset = parseInteger(input.query.offset, 0, 0, 10_000_000);
  const previewChars = parseInteger(input.query.preview_chars, 240, 40, 2000);
  const includeText = parseBoolean(input.query.include_text);
  const until = parseDate(input.query.until) ?? new Date();
  let since = parseSince(input.query, until);
  if (since.getTime() >= until.getTime()) {
    since = new Date(until.getTime() - 48 * 60 * 60 * 1000);
  }
  const sortBy = parseUserSortBy(input.query.sort_by);
  const sortOrder = parseSortOrder(input.query.sort_order, sortBy);
  const allSubjects = input.credentialStore.listSubjects({ includeArchived: true });
  const hiddenSubjectIds = new Set(
    allSubjects.filter((subject) => isSmokeTestSubject(subject)).map((subject) => subject.id)
  );
  const subjects = allSubjects.filter((subject) => !hiddenSubjectIds.has(subject.id));
  const credentials = input.credentialStore
    .listAccessCredentials({ includeRevoked: true })
    .filter((credential) => !hiddenSubjectIds.has(credential.subjectId));
  const subjectById = new Map(subjects.map((subject) => [subject.id, subject]));
  const credentialById = new Map(credentials.map((credential) => [credential.id, credential]));
  const credentialByPrefix = new Map(credentials.map((credential) => [credential.prefix, credential]));
  const subjectFilter = resolveSubjectFilter({
    query: input.query,
    subjects,
    credentialByPrefix
  });
  const visibleSubjectIds =
    subjectFilter.kind === "single"
      ? [subjectFilter.subjectId]
      : subjectFilter.kind === "multi"
        ? subjectFilter.subjectIds
        : subjects.map((subject) => subject.id);
  const selectedCredential = input.query.credential_prefix
    ? credentialByPrefix.get(input.query.credential_prefix)
    : undefined;
  const messageQuery: ListClientMessageEventsInput = {
    subjectIds: visibleSubjectIds,
    ...(selectedCredential ? { credentialId: selectedCredential.id } : {}),
    ...(input.query.session_id ? { sessionId: input.query.session_id } : {}),
    ...(input.query.message_id ? { messageId: input.query.message_id } : {}),
    ...(normalizeSearch(input.query.q) ? { search: input.query.q?.trim() } : {}),
    since,
    until,
    limit,
    offset
  };
  const totalMessages = input.clientEventsStore.countClientMessageEvents(messageQuery);
  const rawMessages = input.clientEventsStore.listClientMessageEvents(messageQuery);
  const requestSummaries = buildMessageRequestSummaries(input.observationStore, rawMessages);
  const messages = rawMessages
    .map((message) =>
      publicClientMessage(message, {
        subject: subjectById.get(message.subjectId),
        credential: credentialById.get(message.credentialId),
        includeText,
        previewChars,
        requestSummary:
          requestSummaries.summaries.get(messageRequestKey(message.subjectId, message.messageId)) ??
          emptyMessageRequestSummary()
      })
    );

  const usageRows = input.observationStore
    ? input.observationStore.reportRequestUsage({ since, until, groupBy: "default" })
    : [];
  const users = buildAdminUserRows(subjects, usageRows, sortBy, sortOrder);
  const summary = summarizeAdminUsers(users, totalMessages);

  return {
    generated_at: new Date().toISOString(),
    summary,
    query: {
      limit,
      offset,
      preview_chars: previewChars,
      include_text: includeText,
      since: since.toISOString(),
      until: until.toISOString(),
      user: input.query.user ?? null,
      q: input.query.q ?? null,
      subject_id: input.query.subject_id ?? null,
      credential_prefix: input.query.credential_prefix ?? null,
      session_id: input.query.session_id ?? null,
      message_id: input.query.message_id ?? null,
      sort_by: sortBy,
      sort_order: sortOrder
    },
    pagination: {
      offset,
      limit,
      returned: messages.length,
      total: totalMessages,
      has_more: offset + messages.length < totalMessages
    },
    request_usage_available: Boolean(input.observationStore),
    request_correlation_truncated: requestSummaries.truncated,
    subjects: subjects.map(publicSubject),
    users,
    messages
  };
}

export function renderAdminClientMessagesPage(input: { authRequired?: boolean } = {}): string {
  const authRequired = input.authRequired ?? true;
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Gateway Client Messages</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f4f6f8;
      --panel: #ffffff;
      --line: #d7dde5;
      --line-strong: #b7c0cd;
      --text: #17202d;
      --muted: #687386;
      --accent: #1b64c8;
      --accent-soft: #eaf2ff;
      --ok: #087a4b;
      --ok-soft: #e7f7ef;
      --warn: #a15c00;
      --warn-soft: #fff4dc;
      --bad: #b42318;
      --bad-soft: #ffebe9;
      --quiet: #667085;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; background: var(--bg); color: var(--text); }
    button, input, select { font: inherit; }
    button { cursor: pointer; }
    header {
      position: sticky; top: 0; z-index: 10; display: flex; align-items: center;
      justify-content: space-between; gap: 18px; padding: 16px 22px;
      border-bottom: 1px solid var(--line); background: rgba(255,255,255,.97);
    }
    h1 { margin: 0; font-size: 20px; font-weight: 720; }
    .subtitle { margin-top: 3px; color: var(--muted); font-size: 12px; }
    .auth { display: flex; align-items: center; gap: 9px; }
    .auth input { width: min(360px, 38vw); }
    .pill { border-radius: 999px; padding: 5px 9px; background: #eef1f5; color: var(--muted); font-size: 12px; }
    .pill.ok { background: var(--ok-soft); color: var(--ok); }
    .pill.bad { background: var(--bad-soft); color: var(--bad); }
    main { width: min(1800px, 100%); margin: 0 auto; padding: 16px 20px 28px; }
    .panel { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; }
    .toolbar {
      display: grid; grid-template-columns: 140px minmax(190px, 1fr) minmax(190px, 1fr) minmax(220px, 1.4fr) 110px auto auto;
      gap: 10px; align-items: end; padding: 13px;
    }
    label { display: grid; gap: 5px; color: var(--muted); font-size: 12px; font-weight: 650; }
    input, select, .btn {
      height: 36px; min-width: 0; border: 1px solid var(--line-strong); border-radius: 7px;
      background: #fff; color: var(--text); padding: 0 10px;
    }
    .btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; font-weight: 680; }
    .btn.primary { border-color: var(--accent); background: var(--accent); color: #fff; }
    .btn.ghost { background: #fff; color: var(--text); }
    .btn:disabled { opacity: .55; cursor: default; }
    .check { display: flex; align-items: center; gap: 7px; height: 36px; white-space: nowrap; color: var(--text); }
    .check input { width: 16px; height: 16px; }
    .notice { margin-top: 10px; padding: 10px 12px; border-radius: 8px; background: var(--bad-soft); color: var(--bad); }
    .summary { display: grid; grid-template-columns: repeat(6, minmax(120px, 1fr)); gap: 10px; margin: 12px 0; }
    .metric { padding: 12px 13px; }
    .metric .label { color: var(--muted); font-size: 12px; }
    .metric .value { margin-top: 5px; font-size: 22px; font-variant-numeric: tabular-nums; font-weight: 730; }
    .metric .detail { margin-top: 2px; color: var(--muted); font-size: 11px; }
    .workspace { display: grid; grid-template-columns: minmax(330px, 410px) minmax(0, 1fr); gap: 12px; align-items: start; }
    .users { position: sticky; top: 86px; max-height: calc(100vh - 104px); display: flex; flex-direction: column; overflow: hidden; }
    .panel-head { padding: 12px; border-bottom: 1px solid var(--line); }
    .panel-title { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-weight: 700; }
    .user-controls { display: grid; grid-template-columns: minmax(0,1fr) 112px 78px; gap: 7px; margin-top: 9px; }
    #userList { overflow: auto; padding: 6px; }
    .user-row {
      display: grid; width: 100%; gap: 7px; margin: 0 0 5px; padding: 10px;
      border: 1px solid transparent; border-radius: 8px; background: transparent; color: inherit; text-align: left;
    }
    .user-row:hover { background: #f7f9fc; border-color: var(--line); }
    .user-row.selected { background: var(--accent-soft); border-color: #93b9ef; }
    .user-name { font-weight: 710; overflow-wrap: anywhere; }
    .user-meta { color: var(--muted); font-size: 11px; overflow-wrap: anywhere; }
    .user-stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 5px; }
    .user-stat { padding: 5px 6px; border-radius: 5px; background: #f0f3f7; }
    .user-stat span { display: block; color: var(--muted); font-size: 10px; }
    .user-stat strong { font-size: 12px; font-variant-numeric: tabular-nums; }
    .messages { min-width: 0; }
    .messages-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 12px; border-bottom: 1px solid var(--line); }
    .pager { display: flex; align-items: center; gap: 7px; color: var(--muted); font-size: 12px; }
    .pager .btn { height: 30px; padding: 0 10px; }
    #rows { padding: 8px; }
    .message-card { border: 1px solid var(--line); border-radius: 9px; margin-bottom: 8px; overflow: hidden; }
    .message-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 10px 11px; background: #fafbfc; border-bottom: 1px solid #e7eaf0; }
    .message-owner { font-weight: 700; }
    .message-time, .mono { color: var(--muted); font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 11px; }
    .badge { display: inline-flex; align-items: center; border-radius: 999px; padding: 4px 8px; font-size: 12px; font-weight: 730; white-space: nowrap; }
    .badge.success { background: var(--ok-soft); color: var(--ok); }
    .badge.partial { background: var(--warn-soft); color: var(--warn); }
    .badge.failed { background: var(--bad-soft); color: var(--bad); }
    .badge.no_request { background: #edf0f4; color: var(--quiet); }
    .request-grid { display: grid; grid-template-columns: repeat(4, minmax(105px, 1fr)); gap: 8px; padding: 9px 11px; border-bottom: 1px solid #edf0f3; }
    .request-metric { min-width: 0; }
    .request-metric span { display: block; color: var(--muted); font-size: 10px; }
    .request-metric strong { display: block; margin-top: 2px; font-size: 13px; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
    .message-text { margin: 0; padding: 12px; white-space: pre-wrap; overflow-wrap: anywhere; font: 13px/1.55 ui-monospace, SFMono-Regular, Consolas, monospace; max-height: 420px; overflow: auto; }
    details { padding: 0 11px 10px; color: var(--muted); font-size: 11px; }
    details summary { cursor: pointer; }
    .empty { padding: 52px 18px; text-align: center; color: var(--muted); }
    @media (max-width: 1150px) {
      .toolbar { grid-template-columns: repeat(3, minmax(0, 1fr)); }
      .summary { grid-template-columns: repeat(3, minmax(120px, 1fr)); }
      .workspace { grid-template-columns: 340px minmax(0, 1fr); }
      .request-grid { grid-template-columns: repeat(2, minmax(105px, 1fr)); }
    }
    @media (max-width: 820px) {
      header { position: static; align-items: flex-start; flex-direction: column; }
      .auth, .auth input { width: 100%; }
      .toolbar { grid-template-columns: 1fr; }
      .summary { grid-template-columns: repeat(2, minmax(120px, 1fr)); }
      .workspace { grid-template-columns: 1fr; }
      .users { position: static; max-height: 520px; }
    }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>客户端消息与用量</h1>
      <div class="subtitle">逐条消息状态、耗时、token，以及指定时段的用户请求统计 · Gateway Client Messages</div>
    </div>
    <div class="auth">
      ${authRequired
        ? '<input id="token" type="password" autocomplete="off" placeholder="Admin token"><span class="pill">Admin token required</span>'
        : '<span class="pill ok">Open access</span>'}
      <span id="status" class="pill">ready</span>
    </div>
  </header>
  <main>
    <section class="panel toolbar">
      <label>时间范围
        <select id="rangePreset">
          <option value="1">最近 1 小时</option>
          <option value="24">最近 24 小时</option>
          <option value="48" selected>最近 48 小时</option>
          <option value="168">最近 7 天</option>
          <option value="720">最近 30 天</option>
          <option value="custom">自定义</option>
        </select>
      </label>
      <label>开始时间<input id="since" type="datetime-local" step="1"></label>
      <label>结束时间<input id="until" type="datetime-local" step="1"></label>
      <label>消息正文 / 会话 / ID<input id="q" type="search" placeholder="例如：客户消息.txt"></label>
      <label>每页消息
        <select id="limit"><option>50</option><option selected>100</option><option>200</option><option>500</option></select>
      </label>
      <label class="check"><input id="includeText" type="checkbox" checked>完整正文</label>
      <div style="display:flex; gap:7px">
        <button id="refresh" class="btn primary" type="button">查询</button>
        <label class="check"><input id="auto" type="checkbox">自动</label>
      </div>
    </section>
    <div id="notice" class="notice" hidden></div>
    <section class="summary">
      <div class="panel metric"><div class="label">时段内活跃用户</div><div id="sumUsers" class="value">-</div><div id="sumUsersDetail" class="detail">-</div></div>
      <div class="panel metric"><div class="label">请求次数</div><div id="sumRequests" class="value">-</div><div id="sumSuccess" class="detail">-</div></div>
      <div class="panel metric"><div class="label">Token 用量</div><div id="sumTokens" class="value">-</div><div id="sumTokenDetail" class="detail">-</div></div>
      <div class="panel metric"><div class="label">失败请求</div><div id="sumErrors" class="value">-</div><div class="detail">包含部分失败消息中的调用</div></div>
      <div class="panel metric"><div class="label">限流请求</div><div id="sumLimited" class="value">-</div><div class="detail">按 Gateway 请求事件统计</div></div>
      <div class="panel metric"><div class="label">匹配消息</div><div id="sumMessages" class="value">-</div><div id="generated" class="detail">-</div></div>
    </section>
    <div class="workspace">
      <aside class="panel users">
        <div class="panel-head">
          <div class="panel-title"><span>用户列表</span><button id="allUsers" class="btn ghost" type="button" style="height:30px">所有用户</button></div>
          <div class="user-controls">
            <input id="userSearch" type="search" placeholder="搜索姓名/手机号/subject">
            <select id="sortBy" aria-label="排序字段">
              <option value="requests">按请求次数</option>
              <option value="tokens">按 Token</option>
              <option value="errors">按失败数</option>
              <option value="rate_limited">按限流数</option>
              <option value="avg_duration">按平均耗时</option>
              <option value="name">按姓名</option>
            </select>
            <select id="sortOrder" aria-label="排序方向"><option value="desc">降序</option><option value="asc">升序</option></select>
          </div>
        </div>
        <div id="userList" role="listbox"></div>
      </aside>
      <section class="panel messages">
        <div class="messages-head">
          <div><strong id="messageTitle">所有用户的消息</strong><div id="messageCount" class="subtitle">-</div></div>
          <div class="pager"><button id="prev" class="btn ghost" type="button">上一页</button><span id="pageLabel">-</span><button id="next" class="btn ghost" type="button">下一页</button></div>
        </div>
        <div id="rows"><div class="empty">等待查询</div></div>
      </section>
    </div>
  </main>
  <script>
    const authRequired = ${JSON.stringify(authRequired)};
    const els = Object.fromEntries([
      "token", "status", "rangePreset", "since", "until", "q", "limit", "includeText", "auto", "refresh",
      "notice", "sumUsers", "sumUsersDetail", "sumRequests", "sumSuccess", "sumTokens", "sumTokenDetail",
      "sumErrors", "sumLimited", "sumMessages", "generated", "allUsers", "userSearch", "sortBy", "sortOrder",
      "userList", "messageTitle", "messageCount", "prev", "pageLabel", "next", "rows"
    ].map((id) => [id, document.getElementById(id)]));
    const state = { selectedSubjectId: "", offset: 0, users: [], payload: null, loading: false };
    if (els.token) {
      els.token.value = sessionStorage.getItem("gatewayAdminMessagesToken") || "";
      els.token.addEventListener("change", () => sessionStorage.setItem("gatewayAdminMessagesToken", els.token.value.trim()));
      els.token.addEventListener("keydown", (event) => { if (event.key === "Enter") load(true); });
    }
    applyPreset();
    els.refresh.addEventListener("click", () => load(true));
    els.rangePreset.addEventListener("change", () => { applyPreset(); load(true); });
    els.since.addEventListener("change", () => { els.rangePreset.value = "custom"; });
    els.until.addEventListener("change", () => { els.rangePreset.value = "custom"; });
    els.q.addEventListener("keydown", (event) => { if (event.key === "Enter") load(true); });
    els.limit.addEventListener("change", () => load(true));
    els.includeText.addEventListener("change", () => load(true));
    els.sortBy.addEventListener("change", () => {
      els.sortOrder.value = els.sortBy.value === "name" ? "asc" : "desc";
      load(false);
    });
    els.sortOrder.addEventListener("change", () => load(false));
    els.userSearch.addEventListener("input", renderUsers);
    els.allUsers.addEventListener("click", () => {
      state.selectedSubjectId = "";
      state.offset = 0;
      els.userSearch.value = "";
      load(true);
    });
    els.prev.addEventListener("click", () => {
      state.offset = Math.max(0, state.offset - Number(els.limit.value));
      load(false);
    });
    els.next.addEventListener("click", () => {
      state.offset += Number(els.limit.value);
      load(false);
    });
    setInterval(() => {
      if (!els.auto.checked || state.loading) return;
      if (els.rangePreset.value !== "custom") applyPreset();
      load(false);
    }, 10000);
    if (!authRequired || (els.token && els.token.value)) load(true);

    async function load(resetOffset) {
      if (state.loading) return;
      const token = els.token ? els.token.value.trim() : "";
      if (authRequired && !token) {
        setStatus("missing token", false);
        showNotice("Admin token required. Paste the token, then click 查询.");
        els.token.focus();
        return;
      }
      if (resetOffset) state.offset = 0;
      if (els.rangePreset.value !== "custom") applyPreset();
      const params = new URLSearchParams();
      if (state.selectedSubjectId) params.set("subject_id", state.selectedSubjectId);
      setParam(params, "q", els.q.value);
      const since = dateTimeToIso(els.since.value);
      const until = dateTimeToIso(els.until.value);
      if (since) params.set("since", since);
      if (until) params.set("until", until);
      params.set("limit", els.limit.value);
      params.set("offset", String(state.offset));
      params.set("preview_chars", "1000");
      params.set("sort_by", els.sortBy.value);
      params.set("sort_order", els.sortOrder.value);
      if (els.includeText.checked) params.set("include_text", "1");
      state.loading = true;
      els.refresh.disabled = true;
      els.refresh.textContent = "查询中";
      setStatus("loading", true);
      showNotice("");
      try {
        const headers = token ? { authorization: "Bearer " + token } : {};
        const response = await fetch("/gateway/admin/client-messages.json?" + params.toString(), { headers, cache: "no-store" });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error && payload.error.message ? payload.error.message : "request failed");
        state.payload = payload;
        state.users = Array.isArray(payload.users) ? payload.users : [];
        render(payload);
        setStatus("ok", true);
      } catch (error) {
        setStatus("error", false);
        showNotice(error && error.message ? error.message : String(error));
      } finally {
        state.loading = false;
        els.refresh.disabled = false;
        els.refresh.textContent = "查询";
      }
    }

    function render(payload) {
      const summary = payload.summary || {};
      const tokenUsage = summary.token_usage || {};
      els.sumUsers.textContent = formatNumber(summary.active_user_count || 0);
      els.sumUsersDetail.textContent = "共 " + formatNumber(summary.user_count || 0) + " 个主体";
      els.sumRequests.textContent = formatNumber(summary.request_count || 0);
      els.sumSuccess.textContent = "成功 " + formatNumber(summary.success_count || 0) + " · 平均 " + formatDuration(summary.avg_duration_ms);
      els.sumTokens.textContent = formatCompact(tokenUsage.effective_tokens || 0);
      els.sumTokenDetail.textContent = "实际 " + formatNumber(tokenUsage.total_tokens || 0) + (tokenUsage.estimated_tokens ? " · 估算 " + formatNumber(tokenUsage.estimated_tokens) : "");
      els.sumErrors.textContent = formatNumber(summary.error_count || 0);
      els.sumLimited.textContent = formatNumber(summary.rate_limited_count || 0);
      els.sumMessages.textContent = formatNumber(summary.message_count || 0);
      els.generated.textContent = "更新于 " + formatTime(payload.generated_at);
      renderUsers();
      renderMessages(payload);
      if (payload.request_correlation_truncated) showNotice("请求事件过多，当前页的消息关联结果已截断。请缩短查询时段。");
    }

    function renderUsers() {
      const search = normalize(els.userSearch.value);
      const users = state.users.filter((user) => {
        if (!search) return true;
        const subject = user.subject || {};
        return [subject.name, subject.label, subject.phone_number, subject.id]
          .filter(Boolean).some((value) => normalize(value).includes(search));
      });
      els.userList.innerHTML = users.length ? users.map(renderUserRow).join("") : '<div class="empty">没有匹配用户</div>';
      for (const row of els.userList.querySelectorAll("[data-subject-id]")) {
        row.addEventListener("click", () => {
          state.selectedSubjectId = row.getAttribute("data-subject-id") || "";
          state.offset = 0;
          const selected = state.users.find((user) => user.subject && user.subject.id === state.selectedSubjectId);
          els.userSearch.value = selected ? subjectName(selected.subject) : "";
          load(true);
        });
      }
    }

    function renderUserRow(user) {
      const subject = user.subject || {};
      const selected = subject.id === state.selectedSubjectId ? " selected" : "";
      const tokenUsage = user.token_usage || {};
      const meta = [subject.phone_number, subject.label !== subjectName(subject) ? subject.label : "", subject.id].filter(Boolean).join(" · ");
      return '<button type="button" class="user-row' + selected + '" role="option" data-subject-id="' + escapeAttr(subject.id || "") + '">' +
        '<span class="user-name">' + escapeHtml(subjectName(subject)) + '</span>' +
        '<span class="user-meta">' + escapeHtml(meta) + '</span>' +
        '<span class="user-stats">' +
          userStat("请求", user.request_count || 0) +
          userStat("Token", formatCompact(tokenUsage.effective_tokens || 0)) +
          userStat("失败", user.error_count || 0) +
          userStat("限流", user.rate_limited_count || 0) +
        '</span>' +
      '</button>';
    }

    function userStat(label, value) {
      const display = typeof value === "number" ? formatNumber(value) : String(value);
      return '<span class="user-stat"><span>' + escapeHtml(label) + '</span><strong>' + escapeHtml(display) + '</strong></span>';
    }

    function renderMessages(payload) {
      const pagination = payload.pagination || { offset: 0, limit: Number(els.limit.value), returned: 0, total: 0, has_more: false };
      state.offset = pagination.offset || 0;
      const selected = state.users.find((user) => user.subject && user.subject.id === state.selectedSubjectId);
      els.messageTitle.textContent = selected ? subjectName(selected.subject) + " 的所有消息" : "所有用户的消息";
      els.messageCount.textContent = "指定时段内共 " + formatNumber(pagination.total || 0) + " 条；本页 " + formatNumber(pagination.returned || 0) + " 条";
      const first = pagination.total ? pagination.offset + 1 : 0;
      const last = pagination.offset + pagination.returned;
      els.pageLabel.textContent = formatNumber(first) + "–" + formatNumber(last) + " / " + formatNumber(pagination.total || 0);
      els.prev.disabled = pagination.offset <= 0;
      els.next.disabled = !pagination.has_more;
      const messages = Array.isArray(payload.messages) ? payload.messages : [];
      els.rows.innerHTML = messages.length ? messages.map(renderMessage).join("") : '<div class="empty">当前条件下没有消息</div>';
    }

    function renderMessage(message) {
      const subject = message.subject || {};
      const request = message.request_summary || {};
      const tokens = request.token_usage || {};
      const outcome = request.outcome || "no_request";
      const errors = Array.isArray(request.error_codes) && request.error_codes.length ? '<div class="user-meta">错误：' + escapeHtml(request.error_codes.join(", ")) + '</div>' : "";
      const app = [message.app_name, message.app_version].filter(Boolean).join(" ");
      const text = message.text || message.text_preview || "";
      return '<article class="message-card">' +
        '<div class="message-top"><div><div class="message-owner">' + escapeHtml(subjectName(subject)) + '</div>' +
          '<div class="message-time">接收 ' + escapeHtml(formatTime(message.received_at)) + ' · 客户端 ' + escapeHtml(formatTime(message.created_at)) + (app ? ' · ' + escapeHtml(app) : '') + '</div></div>' +
          '<span class="badge ' + escapeAttr(outcome) + '">' + escapeHtml(outcomeLabel(outcome)) + '</span></div>' +
        '<div class="request-grid">' +
          requestMetric("请求", formatNumber(request.request_count || 0) + " 次", "成功 " + formatNumber(request.success_count || 0) + " / 失败 " + formatNumber(request.error_count || 0)) +
          requestMetric("端到端耗时", formatDuration(request.duration_ms), request.request_count > 1 ? "调用耗时合计 " + formatDuration(request.summed_request_duration_ms) : "") +
          requestMetric("Token", formatNumber(tokens.effective_tokens || 0), "输入 " + formatNumber(tokens.prompt_tokens || 0) + " / 输出 " + formatNumber(tokens.completion_tokens || 0)) +
          requestMetric("限流", formatNumber(request.rate_limited_count || 0) + " 次", tokens.estimated_tokens ? "含估算 token " + formatNumber(tokens.estimated_tokens) : "") +
        '</div>' + errors +
        '<pre class="message-text">' + escapeHtml(text) + '</pre>' +
        '<details><summary>消息与请求标识</summary><div class="mono">subject ' + escapeHtml(subject.id || "-") + '<br>credential ' + escapeHtml(message.credential && message.credential.prefix ? message.credential.prefix : "-") + '<br>session ' + escapeHtml(message.session_id || "-") + '<br>message ' + escapeHtml(message.message_id || "-") + '<br>upload request ' + escapeHtml(message.request_id || "-") + '</div></details>' +
      '</article>';
    }

    function requestMetric(label, value, detail) {
      return '<div class="request-metric"><span>' + escapeHtml(label) + '</span><strong>' + escapeHtml(value) + '</strong>' + (detail ? '<span>' + escapeHtml(detail) + '</span>' : '') + '</div>';
    }

    function applyPreset() {
      const hours = Number(els.rangePreset.value);
      if (!Number.isFinite(hours)) return;
      const end = new Date();
      const start = new Date(end.getTime() - hours * 60 * 60 * 1000);
      els.since.value = toLocalDateTime(start);
      els.until.value = toLocalDateTime(end);
    }

    function toLocalDateTime(date) {
      const shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
      return shifted.toISOString().slice(0, 19);
    }

    function dateTimeToIso(value) {
      if (!value) return "";
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? "" : date.toISOString();
    }

    function subjectName(subject) { return subject.name || subject.label || subject.id || "-"; }
    function outcomeLabel(value) { return ({ success: "成功", partial: "部分失败", failed: "失败", no_request: "无请求记录" })[value] || value; }
    function normalize(value) { return String(value || "").trim().toLowerCase(); }
    function setParam(params, name, value) { const text = String(value || "").trim(); if (text) params.set(name, text); }
    function setStatus(text, ok) { els.status.textContent = text; els.status.className = "pill " + (ok ? "ok" : "bad"); }
    function showNotice(text) { els.notice.hidden = !text; els.notice.textContent = text || ""; }
    function formatNumber(value) { return Number(value || 0).toLocaleString("zh-CN"); }
    function formatCompact(value) { return new Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: 1 }).format(Number(value || 0)); }
    function formatDuration(value) {
      if (value === null || value === undefined || !Number.isFinite(Number(value))) return "-";
      const ms = Number(value);
      if (ms < 1000) return Math.round(ms) + " ms";
      if (ms < 60000) return (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + " s";
      return (ms / 60000).toFixed(1) + " min";
    }
    function formatTime(value) {
      if (!value) return "-";
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return String(value);
      return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(date);
    }
    function escapeHtml(value) {
      return String(value === null || value === undefined ? "" : value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
    }
    function escapeAttr(value) { return escapeHtml(value).replace(/\\n/g, " "); }
  </script>
</body>
</html>`;
}

interface AdminUserUsageRow {
  subject: ReturnType<typeof publicSubject>;
  request_count: number;
  success_count: number;
  error_count: number;
  rate_limited_count: number;
  avg_duration_ms: number | null;
  token_usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    estimated_tokens: number;
    effective_tokens: number;
    cached_prompt_tokens: number;
    reasoning_tokens: number;
    usage_missing_count: number;
  };
}

function buildMessageRequestSummaries(
  store: ObservationStore | undefined,
  messages: ClientMessageEventRecord[]
): { summaries: Map<string, MessageRequestSummary>; truncated: boolean } {
  const summaries = new Map<string, MessageRequestSummary>();
  if (!store || messages.length === 0) {
    return { summaries, truncated: false };
  }

  const messageIdsBySubject = new Map<string, Set<string>>();
  for (const message of messages) {
    const ids = messageIdsBySubject.get(message.subjectId) ?? new Set<string>();
    ids.add(message.messageId);
    messageIdsBySubject.set(message.subjectId, ids);
  }

  const eventsByMessage = new Map<string, RequestEventRecord[]>();
  let truncated = false;
  const batchSize = 400;
  const maxEventsPerBatch = 50_000;
  for (const [subjectId, messageIds] of messageIdsBySubject) {
    const ids = Array.from(messageIds);
    for (let start = 0; start < ids.length; start += batchSize) {
      const batch = ids.slice(start, start + batchSize);
      const events = store.listRequestEvents({
        subjectId,
        clientMessageIds: batch,
        limit: maxEventsPerBatch + 1
      });
      if (events.length > maxEventsPerBatch) {
        truncated = true;
        events.length = maxEventsPerBatch;
      }
      for (const event of events) {
        if (!event.clientMessageId) {
          continue;
        }
        const key = messageRequestKey(subjectId, event.clientMessageId);
        const grouped = eventsByMessage.get(key) ?? [];
        grouped.push(event);
        eventsByMessage.set(key, grouped);
      }
    }
  }

  for (const message of messages) {
    const key = messageRequestKey(message.subjectId, message.messageId);
    summaries.set(key, summarizeMessageRequests(eventsByMessage.get(key) ?? []));
  }
  return { summaries, truncated };
}

function summarizeMessageRequests(events: RequestEventRecord[]): MessageRequestSummary {
  if (events.length === 0) {
    return emptyMessageRequestSummary();
  }

  let successCount = 0;
  let errorCount = 0;
  let rateLimitedCount = 0;
  let earliestStartedAt = Number.POSITIVE_INFINITY;
  let latestFinishedAt = Number.NEGATIVE_INFINITY;
  let summedRequestDurationMs = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;
  let estimatedTokens = 0;
  let cachedPromptTokens = 0;
  let usageMissingCount = 0;
  const errorCodes = new Set<string>();

  for (const event of events) {
    if (event.status === "ok") {
      successCount += 1;
    } else {
      errorCount += 1;
    }
    if (event.rateLimited) {
      rateLimitedCount += 1;
    }
    if (event.errorCode) {
      errorCodes.add(event.errorCode);
    }

    const startedAt = event.startedAt.getTime();
    const requestDurationMs = nonNegativeNumber(event.durationMs);
    earliestStartedAt = Math.min(earliestStartedAt, startedAt);
    latestFinishedAt = Math.max(latestFinishedAt, startedAt + requestDurationMs);
    summedRequestDurationMs += requestDurationMs;

    const eventPromptTokens = nonNegativeNumber(event.promptTokens);
    const eventCompletionTokens = nonNegativeNumber(event.completionTokens);
    const explicitTotalTokens = nonNegativeNumberOrNull(event.totalTokens);
    const fallbackTotalTokens = eventPromptTokens + eventCompletionTokens;
    const eventEstimatedTokens = nonNegativeNumber(event.estimatedTokens);
    promptTokens += eventPromptTokens;
    completionTokens += eventCompletionTokens;
    cachedPromptTokens += nonNegativeNumber(event.cachedPromptTokens);
    if (explicitTotalTokens !== null) {
      totalTokens += explicitTotalTokens;
      if (explicitTotalTokens === 0 && eventEstimatedTokens > 0 && event.usageSource !== "provider") {
        estimatedTokens += eventEstimatedTokens;
      }
    } else if (fallbackTotalTokens > 0) {
      totalTokens += fallbackTotalTokens;
    } else if (eventEstimatedTokens > 0) {
      estimatedTokens += eventEstimatedTokens;
    } else {
      usageMissingCount += 1;
    }
  }

  const outcome: MessageRequestOutcome =
    errorCount === 0 ? "success" : successCount === 0 ? "failed" : "partial";
  return {
    outcome,
    success: outcome === "success",
    request_count: events.length,
    success_count: successCount,
    error_count: errorCount,
    rate_limited_count: rateLimitedCount,
    started_at: new Date(earliestStartedAt).toISOString(),
    finished_at: new Date(latestFinishedAt).toISOString(),
    duration_ms: Math.max(0, latestFinishedAt - earliestStartedAt),
    summed_request_duration_ms: summedRequestDurationMs,
    error_codes: Array.from(errorCodes).sort(),
    token_usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: totalTokens,
      estimated_tokens: estimatedTokens,
      effective_tokens: totalTokens + estimatedTokens,
      cached_prompt_tokens: cachedPromptTokens,
      usage_missing_count: usageMissingCount
    }
  };
}

function emptyMessageRequestSummary(): MessageRequestSummary {
  return {
    outcome: "no_request",
    success: null,
    request_count: 0,
    success_count: 0,
    error_count: 0,
    rate_limited_count: 0,
    started_at: null,
    finished_at: null,
    duration_ms: null,
    summed_request_duration_ms: 0,
    error_codes: [],
    token_usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      estimated_tokens: 0,
      effective_tokens: 0,
      cached_prompt_tokens: 0,
      usage_missing_count: 0
    }
  };
}

function messageRequestKey(subjectId: string, messageId: string): string {
  return `${subjectId}\u0000${messageId}`;
}

function buildAdminUserRows(
  subjects: Subject[],
  usageRows: RequestUsageReportRow[],
  sortBy: AdminUserSortBy,
  sortOrder: AdminSortOrder
): AdminUserUsageRow[] {
  const rowsBySubject = new Map<string, AdminUserUsageRow>();
  const durationWeights = new Map<string, { total: number; requests: number }>();
  for (const subject of subjects) {
    rowsBySubject.set(subject.id, {
      subject: publicSubject(subject),
      request_count: 0,
      success_count: 0,
      error_count: 0,
      rate_limited_count: 0,
      avg_duration_ms: null,
      token_usage: {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
        estimated_tokens: 0,
        effective_tokens: 0,
        cached_prompt_tokens: 0,
        reasoning_tokens: 0,
        usage_missing_count: 0
      }
    });
  }

  for (const usage of usageRows) {
    if (!usage.subjectId) {
      continue;
    }
    const row = rowsBySubject.get(usage.subjectId);
    if (!row) {
      continue;
    }
    row.request_count += usage.requests;
    row.success_count += usage.ok;
    row.error_count += usage.errors;
    row.rate_limited_count += usage.rateLimited;
    row.token_usage.prompt_tokens += usage.promptTokens;
    row.token_usage.completion_tokens += usage.completionTokens;
    row.token_usage.total_tokens += usage.totalTokens;
    row.token_usage.estimated_tokens += usage.estimatedTokens;
    row.token_usage.cached_prompt_tokens += usage.cachedPromptTokens;
    row.token_usage.reasoning_tokens += usage.reasoningTokens;
    row.token_usage.usage_missing_count += usage.usageMissing;
    if (usage.avgDurationMs !== null) {
      const weight = durationWeights.get(usage.subjectId) ?? { total: 0, requests: 0 };
      weight.total += usage.avgDurationMs * usage.requests;
      weight.requests += usage.requests;
      durationWeights.set(usage.subjectId, weight);
    }
  }

  for (const [subjectId, row] of rowsBySubject) {
    row.token_usage.effective_tokens =
      row.token_usage.total_tokens + row.token_usage.estimated_tokens;
    const duration = durationWeights.get(subjectId);
    row.avg_duration_ms = duration?.requests
      ? Math.round(duration.total / duration.requests)
      : null;
  }

  const rows = Array.from(rowsBySubject.values());
  rows.sort((left, right) => compareAdminUsers(left, right, sortBy, sortOrder));
  return rows;
}

function summarizeAdminUsers(users: AdminUserUsageRow[], messageCount: number) {
  const summary = {
    user_count: users.length,
    active_user_count: 0,
    message_count: messageCount,
    request_count: 0,
    success_count: 0,
    error_count: 0,
    rate_limited_count: 0,
    avg_duration_ms: null as number | null,
    token_usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      estimated_tokens: 0,
      effective_tokens: 0,
      cached_prompt_tokens: 0,
      reasoning_tokens: 0,
      usage_missing_count: 0
    }
  };
  let weightedDuration = 0;
  let durationRequests = 0;
  for (const user of users) {
    if (user.request_count > 0) {
      summary.active_user_count += 1;
    }
    summary.request_count += user.request_count;
    summary.success_count += user.success_count;
    summary.error_count += user.error_count;
    summary.rate_limited_count += user.rate_limited_count;
    summary.token_usage.prompt_tokens += user.token_usage.prompt_tokens;
    summary.token_usage.completion_tokens += user.token_usage.completion_tokens;
    summary.token_usage.total_tokens += user.token_usage.total_tokens;
    summary.token_usage.estimated_tokens += user.token_usage.estimated_tokens;
    summary.token_usage.effective_tokens += user.token_usage.effective_tokens;
    summary.token_usage.cached_prompt_tokens += user.token_usage.cached_prompt_tokens;
    summary.token_usage.reasoning_tokens += user.token_usage.reasoning_tokens;
    summary.token_usage.usage_missing_count += user.token_usage.usage_missing_count;
    if (user.avg_duration_ms !== null) {
      weightedDuration += user.avg_duration_ms * user.request_count;
      durationRequests += user.request_count;
    }
  }
  summary.avg_duration_ms = durationRequests
    ? Math.round(weightedDuration / durationRequests)
    : null;
  return summary;
}

function compareAdminUsers(
  left: AdminUserUsageRow,
  right: AdminUserUsageRow,
  sortBy: AdminUserSortBy,
  sortOrder: AdminSortOrder
): number {
  const direction = sortOrder === "asc" ? 1 : -1;
  const numeric = (row: AdminUserUsageRow): number => {
    switch (sortBy) {
      case "tokens":
        return row.token_usage.effective_tokens;
      case "errors":
        return row.error_count;
      case "rate_limited":
        return row.rate_limited_count;
      case "avg_duration":
        return row.avg_duration_ms ?? -1;
      case "requests":
        return row.request_count;
      default:
        return 0;
    }
  };
  if (sortBy !== "name") {
    const difference = numeric(left) - numeric(right);
    if (difference !== 0) {
      return difference * direction;
    }
  }
  return adminUserName(left).localeCompare(adminUserName(right), "zh-CN") *
    (sortBy === "name" ? direction : 1);
}

function adminUserName(row: AdminUserUsageRow): string {
  return row.subject.name || row.subject.label || row.subject.id;
}

function parseUserSortBy(value: string | undefined): AdminUserSortBy {
  const normalized = value?.trim().toLowerCase();
  return normalized === "tokens" ||
    normalized === "errors" ||
    normalized === "rate_limited" ||
    normalized === "avg_duration" ||
    normalized === "name"
    ? normalized
    : "requests";
}

function parseSortOrder(
  value: string | undefined,
  sortBy: AdminUserSortBy
): AdminSortOrder {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "asc" || normalized === "desc") {
    return normalized;
  }
  return sortBy === "name" ? "asc" : "desc";
}

function nonNegativeNumber(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function nonNegativeNumberOrNull(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function publicClientMessage(
  message: ClientMessageEventRecord,
  input: {
    subject?: Subject;
    credential?: AccessCredentialRecord;
    includeText: boolean;
    previewChars: number;
    requestSummary: MessageRequestSummary;
  }
) {
  return {
    event_id: message.eventId,
    request_id: message.requestId,
    subject: input.subject ? publicSubject(input.subject) : { id: message.subjectId },
    credential: input.credential
      ? {
          id: input.credential.id,
          prefix: input.credential.prefix,
          label: input.credential.label,
          scope: input.credential.scope,
          expires_at: input.credential.expiresAt.toISOString(),
          revoked_at: input.credential.revokedAt?.toISOString() ?? null
        }
      : { id: message.credentialId },
    scope: message.scope,
    session_id: message.sessionId,
    message_id: message.messageId,
    agent: message.agent,
    provider_id: message.providerId,
    model_id: message.modelId,
    engine: message.engine,
    text_preview: previewText(message.text, input.previewChars),
    ...(input.includeText ? { text: message.text } : {}),
    text_sha256: message.textSha256,
    attachments_count: attachmentCount(message.attachmentsJson),
    app_name: message.appName,
    app_version: message.appVersion,
    created_at: message.createdAt.toISOString(),
    received_at: message.receivedAt.toISOString(),
    request_summary: input.requestSummary
  };
}

function publicSubject(subject: Subject) {
  return {
    id: subject.id,
    label: subject.label,
    name: subject.name ?? null,
    phone_number: subject.phoneNumber ?? null,
    state: subject.state
  };
}

function isSmokeTestSubject(subject: Subject): boolean {
  return [subject.id, subject.label, subject.name]
    .filter(Boolean)
    .some((value) => /\bsmoke\b|smoke[-_]/i.test(String(value)) || String(value).toLowerCase().includes("-smoke"));
}

function resolveSubjectFilter(input: {
  query: AdminClientMessagesQuery;
  subjects: Subject[];
  credentialByPrefix: Map<string, AccessCredentialRecord>;
}): { kind: "all" } | { kind: "single"; subjectId: string } | { kind: "multi"; subjectIds: string[] } {
  if (input.query.subject_id) {
    return input.subjects.some((subject) => subject.id === input.query.subject_id)
      ? { kind: "single", subjectId: input.query.subject_id }
      : { kind: "multi", subjectIds: [] };
  }

  if (input.query.credential_prefix) {
    const credential = input.credentialByPrefix.get(input.query.credential_prefix);
    return credential ? { kind: "single", subjectId: credential.subjectId } : { kind: "multi", subjectIds: [] };
  }

  const user = normalizeSearch(input.query.user);
  if (!user) {
    return { kind: "all" };
  }

  const matches = input.subjects
    .filter((subject) =>
      [subject.id, subject.label, subject.name, subject.phoneNumber]
        .filter(Boolean)
        .some((value) => normalizeSearch(value)?.includes(user))
    )
    .map((subject) => subject.id);

  if (matches.length === 1) {
    return { kind: "single", subjectId: matches[0] };
  }
  return { kind: "multi", subjectIds: matches };
}

function parseSince(query: AdminClientMessagesQuery, until: Date): Date {
  const explicit = parseDate(query.since);
  if (explicit) {
    return explicit;
  }

  const hours = parseInteger(query.hours, 48, 1, 24 * 90);
  return new Date(until.getTime() - hours * 60 * 60 * 1000);
}

function parseDate(value: string | undefined): Date | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function parseInteger(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number
): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isInteger(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, parsed));
}

function parseBoolean(value: string | undefined): boolean {
  return value === "1" || value === "true" || value === "yes";
}

function normalizeSearch(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : undefined;
}

function previewText(text: string, chars: number): string {
  if (text.length <= chars) {
    return text;
  }
  return `${text.slice(0, chars)}...`;
}

function attachmentCount(json: string): number {
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

function safeEqual(received: string, expected: string): boolean {
  const receivedBuffer = Buffer.from(received);
  const expectedBuffer = Buffer.from(expected);
  if (receivedBuffer.length !== expectedBuffer.length) {
    return false;
  }
  return timingSafeEqual(receivedBuffer, expectedBuffer);
}
