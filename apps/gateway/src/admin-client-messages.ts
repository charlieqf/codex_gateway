import { timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type {
  AccessCredentialRecord,
  ClientMessageEventRecord,
  ClientMessageEventStore,
  CredentialAuthStore,
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
  include_text?: string;
  preview_chars?: string;
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
  query: AdminClientMessagesQuery;
}) {
  const limit = parseInteger(input.query.limit, 100, 1, 1000);
  const previewChars = parseInteger(input.query.preview_chars, 240, 40, 2000);
  const includeText = parseBoolean(input.query.include_text);
  const allSubjects = input.credentialStore.listSubjects({ includeArchived: false });
  const hiddenSubjectIds = new Set(
    allSubjects.filter((subject) => isSmokeTestSubject(subject)).map((subject) => subject.id)
  );
  const subjects = allSubjects.filter((subject) => !hiddenSubjectIds.has(subject.id));
  const credentials = input.credentialStore
    .listAccessCredentials({ includeRevoked: false })
    .filter((credential) => !hiddenSubjectIds.has(credential.subjectId));
  const subjectById = new Map(subjects.map((subject) => [subject.id, subject]));
  const credentialById = new Map(credentials.map((credential) => [credential.id, credential]));
  const credentialByPrefix = new Map(credentials.map((credential) => [credential.prefix, credential]));
  const subjectFilter = resolveSubjectFilter({
    query: input.query,
    subjects,
    credentialByPrefix
  });
  const since = parseSince(input.query);
  const until = parseDate(input.query.until);
  const rawMessages = input.clientEventsStore.listClientMessageEvents({
    ...(subjectFilter.kind === "single" ? { subjectId: subjectFilter.subjectId } : {}),
    ...(input.query.credential_prefix && credentialByPrefix.get(input.query.credential_prefix)
      ? { credentialId: credentialByPrefix.get(input.query.credential_prefix)?.id }
      : {}),
    ...(input.query.session_id ? { sessionId: input.query.session_id } : {}),
    ...(input.query.message_id ? { messageId: input.query.message_id } : {}),
    ...(since ? { since } : {}),
    ...(until ? { until } : {}),
    limit:
      subjectFilter.kind === "multi" || input.query.q || hiddenSubjectIds.size > 0
        ? Math.max(limit, 1000)
        : limit
  });
  const search = normalizeSearch(input.query.q);
  const allowedSubjectIds =
    subjectFilter.kind === "multi" ? new Set(subjectFilter.subjectIds) : null;
  const messages = rawMessages
    .filter((message) => !hiddenSubjectIds.has(message.subjectId))
    .filter((message) => !allowedSubjectIds || allowedSubjectIds.has(message.subjectId))
    .filter((message) =>
      search ? messageMatchesSearch(message, subjectById.get(message.subjectId), search) : true
    )
    .slice(0, limit)
    .map((message) =>
      publicClientMessage(message, {
        subject: subjectById.get(message.subjectId),
        credential: credentialById.get(message.credentialId),
        includeText,
        previewChars
      })
    );

  return {
    generated_at: new Date().toISOString(),
    query: {
      limit,
      preview_chars: previewChars,
      include_text: includeText,
      since: since?.toISOString() ?? null,
      until: until?.toISOString() ?? null,
      user: input.query.user ?? null,
      q: input.query.q ?? null,
      subject_id: input.query.subject_id ?? null,
      credential_prefix: input.query.credential_prefix ?? null,
      session_id: input.query.session_id ?? null,
      message_id: input.query.message_id ?? null
    },
    subjects: subjects.map(publicSubject),
    messages
  };
}

export function renderAdminClientMessagesPage(input: { authRequired?: boolean } = {}): string {
  const authRequired = input.authRequired ?? true;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Gateway Client Messages</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f7f8fa;
      --panel: #ffffff;
      --line: #d8dde6;
      --line-strong: #b9c2d0;
      --text: #121722;
      --muted: #5d6675;
      --accent: #1464d2;
      --accent-dark: #0e4ea8;
      --bad: #b42318;
      --ok: #027a48;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background: var(--bg);
      color: var(--text);
    }
    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 18px 24px;
      border-bottom: 1px solid var(--line);
      background: var(--panel);
      position: sticky;
      top: 0;
      z-index: 5;
    }
    h1 {
      margin: 0;
      font-size: 20px;
      font-weight: 650;
      letter-spacing: 0;
    }
    main {
      width: min(1600px, 100%);
      margin: 0 auto;
      padding: 18px 24px 28px;
    }
    .toolbar {
      display: grid;
      grid-template-columns: 220px minmax(180px, 1fr) 120px 110px 130px auto auto;
      gap: 10px;
      align-items: end;
      padding: 14px;
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
    }
    label {
      display: grid;
      gap: 5px;
      color: var(--muted);
      font-size: 12px;
      font-weight: 600;
    }
    input, select, button {
      height: 36px;
      border: 1px solid var(--line-strong);
      border-radius: 6px;
      background: #fff;
      color: var(--text);
      font: inherit;
      font-size: 14px;
      letter-spacing: 0;
    }
    input, select { padding: 0 10px; min-width: 0; }
    button {
      padding: 0 14px;
      border-color: var(--accent);
      background: var(--accent);
      color: #fff;
      font-weight: 650;
      cursor: pointer;
    }
    button:hover { background: var(--accent-dark); }
    button:disabled {
      cursor: progress;
      opacity: 0.72;
    }
    .token {
      width: 280px;
    }
    .open-access {
      align-self: end;
      height: 36px;
      display: flex;
      align-items: center;
      padding: 0 10px;
      border: 1px solid var(--line);
      border-radius: 6px;
      color: var(--muted);
      font-size: 13px;
      background: #f7f8fa;
    }
    .check {
      display: flex;
      align-items: center;
      height: 36px;
      gap: 7px;
      color: var(--text);
      font-size: 14px;
      font-weight: 500;
    }
    .check input {
      width: 16px;
      height: 16px;
      padding: 0;
    }
    .combo {
      position: relative;
      min-width: 0;
    }
    .combo input {
      width: 100%;
      padding-right: 66px;
    }
    .combo-clear {
      position: absolute;
      top: 4px;
      right: 4px;
      height: 28px;
      min-width: 54px;
      padding: 0 8px;
      border-color: var(--line-strong);
      background: #f7f8fa;
      color: var(--muted);
      font-size: 12px;
      font-weight: 650;
    }
    .combo-clear:hover {
      background: #edf1f6;
      color: var(--text);
    }
    .combo-list {
      position: absolute;
      top: calc(100% + 4px);
      left: 0;
      right: 0;
      z-index: 20;
      max-height: 280px;
      overflow: auto;
      border: 1px solid var(--line-strong);
      border-radius: 6px;
      background: #fff;
      box-shadow: 0 8px 24px rgb(18 23 34 / 16%);
    }
    .combo-option {
      width: 100%;
      height: auto;
      min-height: 44px;
      padding: 8px 10px;
      border: 0;
      border-radius: 0;
      background: #fff;
      color: var(--text);
      text-align: left;
      cursor: pointer;
    }
    .combo-option:hover,
    .combo-option.active {
      background: #eaf2ff;
    }
    .combo-name {
      display: block;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 13px;
      font-weight: 650;
    }
    .combo-meta {
      display: block;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--muted);
      font-size: 11px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
    }
    .meta {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      padding: 12px 2px;
      color: var(--muted);
      font-size: 13px;
    }
    .meta strong { color: var(--text); }
    .status-ok { color: var(--ok); }
    .status-bad { color: var(--bad); }
    .notice {
      margin: 0 0 12px;
      padding: 10px 12px;
      border: 1px solid #f0c36d;
      border-radius: 6px;
      background: #fff8e6;
      color: #6f4e00;
      font-size: 14px;
    }
    .notice.bad {
      border-color: #f3b5af;
      background: #fff2f0;
      color: var(--bad);
    }
    .table-wrap {
      overflow: auto;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel);
    }
    table {
      width: 100%;
      min-width: 1180px;
      border-collapse: collapse;
      table-layout: fixed;
    }
    th, td {
      padding: 10px 12px;
      border-bottom: 1px solid var(--line);
      vertical-align: top;
      text-align: left;
      font-size: 13px;
    }
    th {
      position: sticky;
      top: 0;
      background: #f1f4f8;
      color: #384253;
      z-index: 1;
      font-size: 12px;
      font-weight: 700;
    }
    tbody tr:hover { background: #f7fbff; }
    .time { width: 150px; }
    .user { width: 160px; }
    .agent { width: 140px; }
    .ids { width: 250px; }
    .text { width: auto; }
    .mono {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
      font-size: 12px;
      word-break: break-all;
    }
    .prompt {
      white-space: pre-wrap;
      word-break: break-word;
      line-height: 1.4;
      max-height: 220px;
      overflow: auto;
    }
    .muted { color: var(--muted); }
    @media (max-width: 980px) {
      header { align-items: stretch; flex-direction: column; }
      .token { width: 100%; }
      .toolbar { grid-template-columns: 1fr 1fr; }
      main { padding: 12px; }
    }
  </style>
</head>
<body>
  <header>
    <h1>Gateway Client Messages</h1>
    ${authRequired ? `<label>Admin token
      <input class="token" id="token" type="password" autocomplete="off" placeholder="Paste admin token">
    </label>` : `<div class="open-access">Open access</div>`}
  </header>
  <main>
    <section class="toolbar">
      <label>User
        <div class="combo" id="userCombo">
          <input id="userSearch" type="search" autocomplete="off" placeholder="All users">
          <button id="userClear" class="combo-clear" type="button">Clear</button>
          <div id="userList" class="combo-list" role="listbox" hidden></div>
        </div>
      </label>
      <label>Search
        <input id="q" placeholder="message / session / request">
      </label>
      <label>Hours
        <input id="hours" type="number" min="1" max="720" value="48">
      </label>
      <label>Limit
        <input id="limit" type="number" min="1" max="1000" value="100">
      </label>
      <label>Preview
        <input id="preview" type="number" min="40" max="2000" value="240">
      </label>
      <label class="check"><input id="includeText" type="checkbox">Full text</label>
      <label class="check"><input id="auto" type="checkbox" checked>Auto</label>
      <button id="refresh" type="button">Refresh</button>
    </section>
    <div class="meta">
      <span>Status: <strong id="status">idle</strong></span>
      <span>Messages: <strong id="count">0</strong></span>
      <span>Generated: <strong id="generated">-</strong></span>
    </div>
    <div class="notice" id="notice" hidden></div>
    <section class="table-wrap">
      <table>
        <thead>
          <tr>
            <th class="time">Received</th>
            <th class="user">User</th>
            <th class="agent">Agent</th>
            <th class="ids">Session / message</th>
            <th class="text">Message</th>
          </tr>
        </thead>
        <tbody id="rows"></tbody>
      </table>
    </section>
  </main>
  <script>
    const authRequired = ${JSON.stringify(authRequired)};
    const els = {
      token: document.getElementById("token"),
      userCombo: document.getElementById("userCombo"),
      userSearch: document.getElementById("userSearch"),
      userClear: document.getElementById("userClear"),
      userList: document.getElementById("userList"),
      q: document.getElementById("q"),
      hours: document.getElementById("hours"),
      limit: document.getElementById("limit"),
      preview: document.getElementById("preview"),
      includeText: document.getElementById("includeText"),
      auto: document.getElementById("auto"),
      refresh: document.getElementById("refresh"),
      status: document.getElementById("status"),
      count: document.getElementById("count"),
      generated: document.getElementById("generated"),
      notice: document.getElementById("notice"),
      rows: document.getElementById("rows")
    };
    const state = {
      subjects: [],
      selectedSubjectId: "",
      activeUserIndex: -1
    };
    if (els.token) {
      els.token.value = sessionStorage.getItem("gatewayAdminMessagesToken") || "";
      els.token.addEventListener("input", () => sessionStorage.setItem("gatewayAdminMessagesToken", els.token.value));
    }
    els.refresh.addEventListener("click", () => load());
    for (const id of ["q", "hours", "limit", "preview", "includeText"]) {
      els[id].addEventListener("change", () => load());
    }
    els.userSearch.addEventListener("focus", () => openUserList());
    els.userSearch.addEventListener("input", () => {
      state.selectedSubjectId = "";
      state.activeUserIndex = -1;
      renderUserOptions();
      openUserList();
    });
    els.userSearch.addEventListener("keydown", (event) => {
      const options = currentUserOptions();
      if (event.key === "ArrowDown") {
        event.preventDefault();
        state.activeUserIndex = Math.min(options.length - 1, state.activeUserIndex + 1);
        renderUserOptions();
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        state.activeUserIndex = Math.max(0, state.activeUserIndex - 1);
        renderUserOptions();
      } else if (event.key === "Enter") {
        event.preventDefault();
        if (state.activeUserIndex >= 0 && options[state.activeUserIndex]) {
          selectUser(options[state.activeUserIndex]);
        } else {
          closeUserList();
          load();
        }
      } else if (event.key === "Escape") {
        closeUserList();
      }
    });
    els.userClear.addEventListener("click", () => {
      state.selectedSubjectId = "";
      state.activeUserIndex = -1;
      els.userSearch.value = "";
      closeUserList();
      load();
    });
    document.addEventListener("click", (event) => {
      if (!els.userCombo.contains(event.target)) closeUserList();
    });
    els.q.addEventListener("keydown", (event) => {
      if (event.key === "Enter") load();
    });
    setInterval(() => {
      if (els.auto.checked) load();
    }, 10000);
    if (!authRequired || els.token?.value) load();

    async function load() {
      const token = els.token ? els.token.value.trim() : "";
      if (authRequired && !token) {
        setStatus("missing token", false);
        showNotice("Admin token required. Paste the token, then click Refresh.", false);
        els.token?.focus();
        return;
      }
      const params = new URLSearchParams();
      if (state.selectedSubjectId) {
        params.set("subject_id", state.selectedSubjectId);
      } else {
        setParam(params, "user", els.userSearch.value);
      }
      setParam(params, "q", els.q.value);
      setParam(params, "hours", els.hours.value);
      setParam(params, "limit", els.limit.value);
      setParam(params, "preview_chars", els.preview.value);
      if (els.includeText.checked) params.set("include_text", "1");
      setStatus("loading", true);
      showNotice("", true);
      els.refresh.disabled = true;
      els.refresh.textContent = "Loading";
      try {
        const headers = token ? { authorization: "Bearer " + token } : {};
        const response = await fetch("/gateway/admin/client-messages.json?" + params.toString(), {
          headers,
          cache: "no-store"
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error?.message || "request failed");
        render(payload);
        setStatus("ok", true);
        showNotice("", true);
      } catch (error) {
        setStatus(error.message || String(error), false);
        showNotice(error.message || String(error), false);
      } finally {
        els.refresh.disabled = false;
        els.refresh.textContent = "Refresh";
      }
    }

    function render(payload) {
      els.count.textContent = String(payload.messages.length);
      els.generated.textContent = formatTime(payload.generated_at);
      state.subjects = Array.isArray(payload.subjects) ? payload.subjects : [];
      if (state.selectedSubjectId && !state.subjects.some((subject) => subject.id === state.selectedSubjectId)) {
        state.selectedSubjectId = "";
      }
      renderUserOptions();
      els.rows.innerHTML = payload.messages.length > 0
        ? payload.messages.map(renderRow).join("")
        : "<tr><td colspan=\\"5\\" class=\\"muted\\">No messages match the current filters.</td></tr>";
    }

    function renderRow(message) {
      const subject = message.subject || {};
      const user = subject.name || subject.label || subject.id || "-";
      const phone = subject.phone_number ? "<div class=\\"muted\\">" + escapeHtml(subject.phone_number) + "</div>" : "";
      const agent = [message.agent, message.provider_id, message.model_id, message.engine].filter(Boolean).map(escapeHtml).join("<br>");
      const ids = [
        ["s", message.session_id],
        ["m", message.message_id],
        ["r", message.request_id]
      ].map(([label, value]) => "<div><span class=\\"muted\\">" + label + "</span> <span class=\\"mono\\">" + escapeHtml(value || "-") + "</span></div>").join("");
      return "<tr>" +
        "<td class=\\"time\\">" + escapeHtml(formatTime(message.received_at)) + "<div class=\\"muted\\">" + escapeHtml(formatTime(message.created_at)) + "</div></td>" +
        "<td class=\\"user\\">" + escapeHtml(user) + phone + "<div class=\\"mono muted\\">" + escapeHtml(message.credential?.prefix || "") + "</div></td>" +
        "<td class=\\"agent\\">" + agent + "</td>" +
        "<td class=\\"ids\\">" + ids + "</td>" +
        "<td class=\\"text\\"><div class=\\"prompt\\">" + escapeHtml(message.text || message.text_preview || "") + "</div></td>" +
      "</tr>";
    }

    function openUserList() {
      renderUserOptions();
      els.userList.hidden = false;
    }

    function closeUserList() {
      els.userList.hidden = true;
    }

    function currentUserOptions() {
      const search = normalizeText(els.userSearch.value);
      const subjects = state.subjects.slice().sort((left, right) =>
        subjectDisplay(left).localeCompare(subjectDisplay(right))
      );
      if (!search) return subjects.slice(0, 80);
      return subjects.filter((subject) =>
        [
          subjectDisplay(subject),
          subject.label,
          subject.phone_number,
          subject.id,
          subject.state
        ].filter(Boolean).some((value) => normalizeText(value).includes(search))
      ).slice(0, 80);
    }

    function renderUserOptions() {
      const options = currentUserOptions();
      if (state.activeUserIndex >= options.length) {
        state.activeUserIndex = options.length - 1;
      }
      els.userList.innerHTML = options.length > 0
        ? options.map((subject, index) => renderUserOption(subject, index)).join("")
        : "<div class=\\"combo-option muted\\">No matching users</div>";
      for (const option of els.userList.querySelectorAll("[data-subject-id]")) {
        option.addEventListener("mousedown", (event) => {
          event.preventDefault();
          const subject = state.subjects.find((item) => item.id === option.getAttribute("data-subject-id"));
          if (subject) selectUser(subject);
        });
      }
    }

    function renderUserOption(subject, index) {
      const active = index === state.activeUserIndex ? " active" : "";
      const meta = [
        subject.phone_number,
        subject.label && subject.label !== subjectDisplay(subject) ? subject.label : "",
        subject.id
      ].filter(Boolean).join(" / ");
      return "<button class=\\"combo-option" + active + "\\" type=\\"button\\" role=\\"option\\" data-subject-id=\\"" + escapeAttr(subject.id) + "\\">" +
        "<span class=\\"combo-name\\">" + escapeHtml(subjectDisplay(subject)) + "</span>" +
        "<span class=\\"combo-meta\\">" + escapeHtml(meta) + "</span>" +
      "</button>";
    }

    function selectUser(subject) {
      state.selectedSubjectId = subject.id;
      state.activeUserIndex = -1;
      els.userSearch.value = subjectDisplay(subject);
      closeUserList();
      load();
    }

    function subjectDisplay(subject) {
      return subject.name || subject.label || subject.id || "-";
    }

    function normalizeText(value) {
      return String(value || "").trim().toLowerCase();
    }

    function setParam(params, name, value) {
      const trimmed = String(value || "").trim();
      if (trimmed) params.set(name, trimmed);
    }

    function setStatus(text, ok) {
      els.status.textContent = text;
      els.status.className = ok ? "status-ok" : "status-bad";
    }

    function showNotice(text, ok) {
      if (!text) {
        els.notice.hidden = true;
        els.notice.textContent = "";
        return;
      }
      els.notice.hidden = false;
      els.notice.className = ok ? "notice" : "notice bad";
      els.notice.textContent = text;
    }

    function formatTime(value) {
      if (!value) return "-";
      return new Intl.DateTimeFormat(undefined, {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false
      }).format(new Date(value));
    }

    function escapeHtml(value) {
      return String(value).replace(/[&<>"']/g, (char) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        "\\"": "&quot;",
        "'": "&#39;"
      }[char]));
    }

    function escapeAttr(value) {
      return escapeHtml(value).replace(/\\n/g, " ");
    }
  </script>
</body>
</html>`;
}

function publicClientMessage(
  message: ClientMessageEventRecord,
  input: {
    subject?: Subject;
    credential?: AccessCredentialRecord;
    includeText: boolean;
    previewChars: number;
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
    received_at: message.receivedAt.toISOString()
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
    return { kind: "single", subjectId: input.query.subject_id };
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

function messageMatchesSearch(
  message: ClientMessageEventRecord,
  subject: Subject | undefined,
  search: string
): boolean {
  return [
    message.text,
    message.sessionId,
    message.messageId,
    message.requestId,
    message.agent,
    message.providerId,
    message.modelId,
    message.engine,
    subject?.id,
    subject?.label,
    subject?.name,
    subject?.phoneNumber
  ]
    .filter(Boolean)
    .some((value) => normalizeSearch(value)?.includes(search));
}

function parseSince(query: AdminClientMessagesQuery): Date | undefined {
  const explicit = parseDate(query.since);
  if (explicit) {
    return explicit;
  }

  const hours = parseInteger(query.hours, 48, 1, 24 * 90);
  return new Date(Date.now() - hours * 60 * 60 * 1000);
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
