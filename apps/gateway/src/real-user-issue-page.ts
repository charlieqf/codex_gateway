/**
 * Server-rendered operator page for real-user key issuance.
 *
 * The page shell carries no secrets: every call it makes is authenticated with
 * a Billing Admin token the operator pastes in, exactly like the billing usage
 * page. Client script avoids template literals so it can live inside this
 * template literal without escaping.
 */
export function renderRealUserIssuePage(input: {
  defaultPlanId: string;
  defaultValidityDays: number;
  minValidityDays: number;
  defaultRate: { requestsPerMinute: number; requestsPerDay: number | null; concurrentRequests: number | null };
  pollIntervalMs: number;
}): string {
  const config = JSON.stringify({
    defaultPlanId: input.defaultPlanId,
    defaultValidityDays: input.defaultValidityDays,
    minValidityDays: input.minValidityDays,
    defaultRate: input.defaultRate,
    pollIntervalMs: input.pollIntervalMs
  }).replace(/</g, "\\u003c");

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>发放用户 Key</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f7f9;
      --panel: #ffffff;
      --line: #d9dee7;
      --line-strong: #aeb8c8;
      --text: #141821;
      --muted: #5b6574;
      --accent: #1459b8;
      --accent-dark: #0e438c;
      --ok: #067647;
      --bad: #b42318;
      --run: #b54708;
      --warn-bg: #fff6df;
      --warn-line: #edc967;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; background: var(--bg); color: var(--text); }
    header {
      display: flex; align-items: center; justify-content: space-between; gap: 16px;
      padding: 16px 22px; border-bottom: 1px solid var(--line); background: var(--panel);
      position: sticky; top: 0; z-index: 10;
    }
    h1 { margin: 0; font-size: 20px; line-height: 1.2; font-weight: 700; }
    .sub { margin: 4px 0 0; font-size: 12px; color: var(--muted); }
    main { max-width: 960px; margin: 0 auto; padding: 22px; display: grid; gap: 18px; }
    .panel { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 18px; }
    .panel h2 { margin: 0 0 14px; font-size: 15px; font-weight: 650; }
    .grid { display: grid; gap: 14px; grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .grid.three { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    @media (max-width: 720px) { .grid, .grid.three { grid-template-columns: minmax(0, 1fr); } }
    label { display: block; font-size: 12px; font-weight: 600; color: var(--muted); margin-bottom: 5px; }
    input, select {
      width: 100%; padding: 8px 10px; font: inherit; font-size: 13px;
      border: 1px solid var(--line-strong); border-radius: 6px; background: #fff; color: var(--text);
    }
    input:focus, select:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
    .hint { margin-top: 5px; font-size: 11px; color: var(--muted); }
    .row-actions { display: flex; align-items: center; gap: 12px; margin-top: 16px; flex-wrap: wrap; }
    button {
      font: inherit; font-size: 13px; font-weight: 600; padding: 9px 18px; border-radius: 6px;
      border: 1px solid var(--accent); background: var(--accent); color: #fff; cursor: pointer;
    }
    button:hover:not(:disabled) { background: var(--accent-dark); border-color: var(--accent-dark); }
    button:disabled { opacity: 0.55; cursor: not-allowed; }
    button.ghost { background: #fff; color: var(--accent); }
    .notice { padding: 10px 12px; border-radius: 6px; font-size: 13px; margin-top: 14px; display: none; }
    .notice.show { display: block; }
    .notice.err { background: #fef3f2; border: 1px solid #f5b5ae; color: var(--bad); }
    .notice.warn { background: var(--warn-bg); border: 1px solid var(--warn-line); color: #7a4c00; }
    ol.steps { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
    ol.steps li {
      display: grid; grid-template-columns: 22px 1fr auto; gap: 10px; align-items: baseline;
      padding: 9px 11px; border: 1px solid var(--line); border-radius: 7px; font-size: 13px;
    }
    .dot { font-size: 14px; line-height: 1.4; }
    .st-pending { color: var(--muted); }
    .st-running { color: var(--run); font-weight: 600; }
    .st-ok { color: var(--ok); }
    .st-failed { color: var(--bad); font-weight: 600; }
    .detail { font-size: 11px; color: var(--muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    dl.kv { margin: 0; display: grid; grid-template-columns: max-content 1fr; gap: 7px 16px; font-size: 13px; }
    dl.kv dt { color: var(--muted); }
    dl.kv dd { margin: 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; word-break: break-all; }
    .keybox {
      margin-top: 14px; padding: 13px; border: 1px solid var(--warn-line); background: var(--warn-bg);
      border-radius: 8px;
    }
    .keybox code {
      display: block; margin: 8px 0; padding: 10px; background: #fff; border: 1px solid var(--line);
      border-radius: 6px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px;
      word-break: break-all; user-select: all;
    }
    .badge {
      display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 600;
      background: #eef2f8; color: var(--accent-dark); margin: 0 5px 5px 0;
    }
    .plan-info { margin-top: 12px; font-size: 12px; color: var(--muted); }
    table.jobs { width: 100%; border-collapse: collapse; font-size: 12px; }
    table.jobs th, table.jobs td { text-align: left; padding: 7px 9px; border-bottom: 1px solid var(--line); }
    table.jobs th { color: var(--muted); font-weight: 600; }
    .hidden { display: none; }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>发放用户 Key</h1>
      <p class="sub">R760 权威签发（不同步 Azure 兼容栈）· 完整 key 只显示一次</p>
    </div>
    <div class="sub" id="status">未开始</div>
  </header>
  <main>
    <section class="panel">
      <h2>管理员令牌</h2>
      <label for="token">Billing Admin Token</label>
      <input id="token" type="password" placeholder="bat_test_... / bat_live_..." autocomplete="off" spellcheck="false">
      <p class="hint">只存在本标签页的 sessionStorage，关闭即失效。每人一个独立令牌，审计可追溯到发放人。</p>
      <div class="row-actions">
        <button id="loadPlans" class="ghost" type="button">载入 Plan 列表</button>
      </div>
      <div id="tokenNotice" class="notice err"></div>
    </section>

    <section class="panel">
      <h2>用户与套餐</h2>
      <div class="grid">
        <div>
          <label for="name">姓名</label>
          <input id="name" type="text" placeholder="张三" autocomplete="off">
        </div>
        <div>
          <label for="phone">手机号</label>
          <input id="phone" type="text" placeholder="13800138000" autocomplete="off" inputmode="numeric">
          <p class="hint">用于生成 external_user_id（phone_&lt;数字&gt;），同号重复发放会被拒绝。</p>
        </div>
      </div>
      <div class="grid three" style="margin-top:14px">
        <div>
          <label for="plan">Token Plan</label>
          <select id="plan"><option value="">先载入 Plan 列表</option></select>
        </div>
        <div>
          <label for="scope">Scope</label>
          <select id="scope"><option value="code">code</option><option value="medical">medical</option></select>
        </div>
        <div>
          <label for="validity">有效期</label>
          <select id="validity">
            <option value="92">92 天（默认）</option>
            <option value="180">180 天</option>
            <option value="365">365 天</option>
            <option value="custom">自定义…</option>
          </select>
        </div>
      </div>
      <div class="grid three" style="margin-top:14px">
        <div>
          <label for="ratePreset">请求限额档位</label>
          <select id="ratePreset">
            <option value="standard">标准 10/分 · 200/日 · 4 并发</option>
            <option value="high">加强 30/分 · 600/日 · 8 并发</option>
            <option value="custom">自定义…</option>
          </select>
        </div>
        <div id="validityCustomWrap" class="hidden">
          <label for="validityDays">自定义天数</label>
          <input id="validityDays" type="number" min="90" step="1" value="92">
        </div>
      </div>
      <div id="rateCustomWrap" class="grid three hidden" style="margin-top:14px">
        <div><label for="rpm">每分钟请求</label><input id="rpm" type="number" min="1" step="1" value="10"></div>
        <div><label for="rpd">每日请求</label><input id="rpd" type="number" min="1" step="1" value="200"></div>
        <div><label for="concurrent">并发</label><input id="concurrent" type="number" min="1" step="1" value="4"></div>
      </div>
      <div id="planInfo" class="plan-info"></div>
      <div class="row-actions">
        <button id="submit" type="button" disabled>发放 Key</button>
        <span class="sub" id="submitHint">载入 Plan 列表后可发放</span>
      </div>
      <div id="formNotice" class="notice err"></div>
    </section>

    <section class="panel" id="progressPanel" style="display:none">
      <h2>发放进度</h2>
      <ol class="steps" id="steps"></ol>
      <div id="jobNotice" class="notice err"></div>
      <div id="resultWrap" style="display:none">
        <div class="keybox">
          <strong>完整 Key（仅显示一次，请立即复制并通过约定私密渠道交付）</strong>
          <code id="fullKey"></code>
          <button id="copyKey" type="button">复制</button>
          <span class="sub" id="keyCountdown"></span>
        </div>
        <dl class="kv" style="margin-top:14px" id="resultKv"></dl>
      </div>
    </section>

    <section class="panel">
      <h2>最近发放</h2>
      <table class="jobs">
        <thead><tr><th>时间</th><th>用户</th><th>状态</th><th>Key 前缀</th></tr></thead>
        <tbody id="jobRows"><tr><td colspan="4" class="sub">暂无记录</td></tr></tbody>
      </table>
    </section>
  </main>
  <script>
    var CONFIG = ${config};
    var BASE = "/gateway/admin/billing/v1";
    var plans = [];
    var pollTimer = null;
    var countdownTimer = null;
    var currentJobId = null;

    var els = {};
    ["token","loadPlans","tokenNotice","name","phone","plan","scope","validity","validityCustomWrap",
     "validityDays","ratePreset","rateCustomWrap","rpm","rpd","concurrent","planInfo","submit","submitHint",
     "formNotice","progressPanel","steps","jobNotice","resultWrap","fullKey","copyKey","keyCountdown",
     "resultKv","jobRows","status"].forEach(function (id) { els[id] = document.getElementById(id); });

    init();

    function init() {
      els.token.value = sessionStorage.getItem("gatewayBillingAdminToken") || "";
      els.token.addEventListener("input", function () {
        sessionStorage.setItem("gatewayBillingAdminToken", els.token.value);
      });
      els.loadPlans.addEventListener("click", loadPlans);
      els.plan.addEventListener("change", renderPlanInfo);
      els.validity.addEventListener("change", function () {
        toggle(els.validityCustomWrap, els.validity.value === "custom");
      });
      els.ratePreset.addEventListener("change", function () {
        toggle(els.rateCustomWrap, els.ratePreset.value === "custom");
      });
      els.submit.addEventListener("click", submit);
      els.copyKey.addEventListener("click", copyKey);
      if (els.token.value) { loadPlans(); }
      refreshJobs();
    }

    function toggle(node, visible) { node.classList.toggle("hidden", !visible); }

    function authHeaders() {
      var token = els.token.value.trim();
      if (!token) { throw new Error("请先填写 Billing Admin Token。"); }
      return { authorization: "Bearer " + token };
    }

    async function loadPlans() {
      notice(els.tokenNotice, "", "err");
      try {
        var response = await fetch(BASE + "/plans", { headers: authHeaders(), cache: "no-store" });
        var payload = await response.json();
        if (!response.ok) { throw new Error(errorMessage(payload)); }
        plans = Array.isArray(payload.plans) ? payload.plans : [];
        renderPlanOptions();
        setStatus("已载入 " + plans.length + " 个 Plan");
        els.submit.disabled = plans.length === 0;
        els.submitHint.textContent = plans.length ? "" : "没有可用的 active Plan";
        refreshJobs();
      } catch (error) {
        plans = [];
        renderPlanOptions();
        els.submit.disabled = true;
        notice(els.tokenNotice, error.message || String(error), "err");
        setStatus("载入失败");
      }
    }

    function renderPlanOptions() {
      if (!plans.length) {
        els.plan.innerHTML = "<option value=\\"\\">先载入 Plan 列表</option>";
        els.planInfo.textContent = "";
        return;
      }
      els.plan.innerHTML = plans.map(function (plan) {
        var name = plan.display_name && plan.display_name !== plan.id
          ? plan.display_name + " (" + plan.id + ")"
          : plan.id;
        return "<option value=\\"" + escapeAttr(plan.id) + "\\">" + escapeHtml(name) + "</option>";
      }).join("");
      var preferred = plans.filter(function (plan) { return plan.id === CONFIG.defaultPlanId; })[0];
      els.plan.value = preferred ? preferred.id : plans[0].id;
      renderPlanInfo();
    }

    function selectedPlan() {
      return plans.filter(function (plan) { return plan.id === els.plan.value; })[0] || null;
    }

    function renderPlanInfo() {
      var plan = selectedPlan();
      if (!plan) { els.planInfo.textContent = ""; return; }
      var scopes = plan.scope_allowlist || [];
      els.scope.innerHTML = (scopes.length ? scopes : ["code"]).map(function (scope) {
        return "<option value=\\"" + escapeAttr(scope) + "\\">" + escapeHtml(scope) + "</option>";
      }).join("");
      var capabilities = (plan.feature_policy && plan.feature_policy.capabilities) || [];
      var badges = capabilities.map(function (capability) {
        return "<span class=\\"badge\\">" + escapeHtml(capability) + "</span>";
      }).join("");
      var policy = plan.token_policy || {};
      var limits = [
        ["每分钟 tokens", policy.tokens_per_minute],
        ["每日 tokens", policy.tokens_per_day],
        ["每月 tokens", policy.tokens_per_month],
        ["单次最大 prompt", policy.max_prompt_tokens_per_request],
        ["单次最大总量", policy.max_total_tokens_per_request]
      ].filter(function (pair) { return pair[1] !== null && pair[1] !== undefined; })
       .map(function (pair) { return pair[0] + " " + Number(pair[1]).toLocaleString(); })
       .join(" · ");
      els.planInfo.innerHTML = "<div>" + badges + "</div>" +
        (limits ? "<div style=\\"margin-top:6px\\">Token 配额：" + escapeHtml(limits) + "</div>"
                : "<div style=\\"margin-top:6px\\">Token 配额：未设置上限</div>");
    }

    function readRate() {
      if (els.ratePreset.value === "standard") { return { rpm: 10, rpd: 200, concurrent: 4 }; }
      if (els.ratePreset.value === "high") { return { rpm: 30, rpd: 600, concurrent: 8 }; }
      return {
        rpm: Number(els.rpm.value),
        rpd: Number(els.rpd.value),
        concurrent: Number(els.concurrent.value)
      };
    }

    function readValidityDays() {
      return els.validity.value === "custom" ? Number(els.validityDays.value) : Number(els.validity.value);
    }

    async function submit() {
      notice(els.formNotice, "", "err");
      var name = els.name.value.trim();
      var phone = els.phone.value.trim();
      if (!name) { return notice(els.formNotice, "请填写姓名。", "err"); }
      if (!/^[0-9+\\-\\s]{6,20}$/.test(phone)) { return notice(els.formNotice, "手机号格式不正确。", "err"); }
      var plan = selectedPlan();
      if (!plan) { return notice(els.formNotice, "请选择 Token Plan。", "err"); }
      var days = readValidityDays();
      if (!Number.isFinite(days) || days < CONFIG.minValidityDays) {
        return notice(els.formNotice, "有效期不能少于 " + CONFIG.minValidityDays + " 天。", "err");
      }
      var rate = readRate();
      if (!Number.isFinite(rate.rpm) || rate.rpm < 1 || !Number.isFinite(rate.rpd) || rate.rpd < 1 ||
          !Number.isFinite(rate.concurrent) || rate.concurrent < 1) {
        return notice(els.formNotice, "限额必须是正整数。", "err");
      }

      els.submit.disabled = true;
      els.submit.textContent = "发放中…";
      setStatus("提交中");
      try {
        var response = await fetch(BASE + "/real-user-issue", {
          method: "POST",
          headers: Object.assign({ "content-type": "application/json" }, authHeaders()),
          body: JSON.stringify({
            name: name, phone: phone, plan_id: plan.id, scope: els.scope.value,
            validity_days: days, rpm: rate.rpm, rpd: rate.rpd, concurrent: rate.concurrent
          }),
          cache: "no-store"
        });
        var payload = await response.json();
        if (!response.ok) { throw new Error(errorMessage(payload)); }
        currentJobId = payload.job_id;
        els.progressPanel.style.display = "";
        els.resultWrap.style.display = "none";
        notice(els.jobNotice, "", "err");
        renderJob(payload);
        poll();
      } catch (error) {
        notice(els.formNotice, error.message || String(error), "err");
        resetSubmit();
        setStatus("提交失败");
      }
    }

    function poll() {
      if (pollTimer) { clearTimeout(pollTimer); }
      pollTimer = setTimeout(async function () {
        if (!currentJobId) { return; }
        try {
          var response = await fetch(BASE + "/real-user-issue/" + encodeURIComponent(currentJobId), {
            headers: authHeaders(), cache: "no-store"
          });
          var payload = await response.json();
          if (!response.ok) { throw new Error(errorMessage(payload)); }
          renderJob(payload);
          if (payload.state === "queued" || payload.state === "running") { poll(); return; }
          resetSubmit();
          refreshJobs();
          if (payload.state === "succeeded") {
            setStatus("发放成功");
            renderResult(payload);
          } else {
            setStatus("发放失败");
            notice(els.jobNotice, (payload.error && payload.error.message) || "发放失败。", "err");
          }
        } catch (error) {
          notice(els.jobNotice, error.message || String(error), "err");
          resetSubmit();
          setStatus("轮询失败");
        }
      }, CONFIG.pollIntervalMs);
    }

    function renderJob(job) {
      var steps = job.steps || [];
      els.steps.innerHTML = steps.map(function (step) {
        return "<li><span class=\\"dot st-" + escapeAttr(step.state) + "\\">" + stepIcon(step.state) + "</span>" +
          "<span class=\\"st-" + escapeAttr(step.state) + "\\">" + escapeHtml(step.label) + "</span>" +
          "<span class=\\"detail\\">" + escapeHtml(step.detail || "") + "</span></li>";
      }).join("");
    }

    function stepIcon(state) {
      if (state === "ok") { return "✓"; }
      if (state === "failed") { return "✕"; }
      if (state === "running") { return "◐"; }
      return "○";
    }

    function renderResult(job) {
      var result = job.result || {};
      els.resultWrap.style.display = "";
      if (job.unified_key) {
        els.fullKey.textContent = job.unified_key;
        startCountdown(job.key_expires_at);
      } else {
        els.fullKey.textContent = "（完整 key 已过可见窗口，请让管理员 reveal 或轮换）";
        els.keyCountdown.textContent = "";
      }
      var rate = result.rate || {};
      var rows = [
        ["subject_id", result.subject_id],
        ["key 前缀", result.key_prefix],
        ["Gateway 前缀", result.codex_gateway_prefix],
        ["MedEvidence 前缀", result.medevidence_prefix],
        ["Plan", result.plan_id],
        ["能力", (result.capabilities || []).join(", ")],
        ["限额", rate.requestsPerMinute + "/分 · " + rate.requestsPerDay + "/日 · " + rate.concurrentRequests + " 并发"],
        ["key 到期", formatTime(result.backing_key_expires_at)],
        ["权益到期", formatTime(result.entitlement_end)],
        ["Base URL", result.endpoint_base_url]
      ];
      els.resultKv.innerHTML = rows.filter(function (row) { return row[1]; }).map(function (row) {
        return "<dt>" + escapeHtml(row[0]) + "</dt><dd>" + escapeHtml(String(row[1])) + "</dd>";
      }).join("");
    }

    function startCountdown(expiresAt) {
      if (countdownTimer) { clearInterval(countdownTimer); }
      if (!expiresAt) { els.keyCountdown.textContent = ""; return; }
      var deadline = new Date(expiresAt).getTime();
      var tick = function () {
        var left = Math.max(0, Math.floor((deadline - Date.now()) / 1000));
        els.keyCountdown.textContent = left > 0
          ? "可见剩余 " + Math.floor(left / 60) + " 分 " + (left % 60) + " 秒"
          : "已过可见窗口";
        if (left <= 0) { clearInterval(countdownTimer); }
      };
      tick();
      countdownTimer = setInterval(tick, 1000);
    }

    async function copyKey() {
      try {
        await navigator.clipboard.writeText(els.fullKey.textContent || "");
        els.copyKey.textContent = "已复制";
        setTimeout(function () { els.copyKey.textContent = "复制"; }, 1500);
      } catch (error) {
        els.copyKey.textContent = "请手动选择复制";
      }
    }

    async function refreshJobs() {
      if (!els.token.value.trim()) { return; }
      try {
        var response = await fetch(BASE + "/real-user-issues", { headers: authHeaders(), cache: "no-store" });
        if (!response.ok) { return; }
        var payload = await response.json();
        var jobs = payload.jobs || [];
        els.jobRows.innerHTML = jobs.length
          ? jobs.map(function (job) {
              return "<tr><td>" + escapeHtml(formatTime(job.created_at)) + "</td>" +
                "<td>" + escapeHtml(job.display_name + " ****" + job.phone_tail) + "</td>" +
                "<td class=\\"st-" + escapeAttr(job.state === "succeeded" ? "ok" : job.state === "failed" ? "failed" : "running") + "\\">" +
                escapeHtml(stateLabel(job.state)) + "</td>" +
                "<td class=\\"detail\\">" + escapeHtml((job.result && job.result.key_prefix) || "") + "</td></tr>";
            }).join("")
          : "<tr><td colspan=\\"4\\" class=\\"sub\\">暂无记录</td></tr>";
      } catch (error) {
        // Listing is advisory; failures must not disturb an in-flight issuance.
      }
    }

    function stateLabel(state) {
      if (state === "succeeded") { return "成功"; }
      if (state === "failed") { return "失败"; }
      if (state === "running") { return "进行中"; }
      return "排队中";
    }

    function resetSubmit() {
      els.submit.disabled = plans.length === 0;
      els.submit.textContent = "发放 Key";
    }

    function setStatus(text) { els.status.textContent = text; }

    function notice(node, message, kind) {
      node.className = "notice " + kind + (message ? " show" : "");
      node.textContent = message;
    }

    function errorMessage(payload) {
      if (payload && payload.error && payload.error.message) { return payload.error.message; }
      return "请求失败";
    }

    function formatTime(value) {
      if (!value) { return ""; }
      var date = new Date(value);
      return isNaN(date.getTime()) ? String(value) : date.toLocaleString();
    }

    function escapeHtml(value) {
      return String(value).replace(/[&<>"']/g, function (char) {
        return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char];
      });
    }

    function escapeAttr(value) { return escapeHtml(value); }
  </script>
</body>
</html>`;
}
