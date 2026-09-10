import { Script, runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { renderQuotaDashboardPage } from "./quota-dashboard.js";

describe("quota dashboard browser rendering", () => {
  it.each([false, true])("shows independent Free and paid usage, including an uncapped annual plan (%s)", (annual) => {
    const html = renderQuotaDashboardPage();
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    if (!script) throw new Error("Dashboard script missing");
    expect(() => new Script(script)).not.toThrow();
    const renderers = script.slice(script.indexOf("function renderQuota("), script.indexOf("function renderLimits("));
    const formatter = script.slice(script.indexOf("function formatNumber("), script.indexOf("function formatNullable("));
    const window = { limit: 10_000, used: 1_000, reserved: 0, remaining: 9_000 };
    const user = { effective_token: {}, token_usage: { minute: window, day: window,
      month: { ...window, limit: annual ? null : 50_000_000, used: 25_000, remaining: annual ? null : 49_975_000 },
      free_allowance: { day: window } }, internal_reserve_tokens_per_request: 0, internal_missing_usage_charge: "none" };
    const rendered = runInNewContext(`${renderers}\n${formatter}\nrenderQuota(user)`, { user, escapeHtml: (x: string) => x });
    expect(rendered).toContain("免费日");
    expect(rendered).toContain("付费周期");
    expect(rendered).toContain("25,000");
    if (annual) expect(rendered).toContain("不限；已用");
  });
});
