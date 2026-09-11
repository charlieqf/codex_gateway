import { Script, runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { hasExhaustedWindow, renderQuotaDashboardPage } from "./quota-dashboard.js";

describe("quota dashboard browser rendering", () => {
  it.each([false, true])("shows independent Free and paid usage, including nullable period limits (%s)", (nullable) => {
    const html = renderQuotaDashboardPage();
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    if (!script) throw new Error("Dashboard script missing");
    expect(() => new Script(script)).not.toThrow();
    const renderers = script.slice(script.indexOf("function renderQuota("), script.indexOf("function renderLimits("));
    const formatter = script.slice(script.indexOf("function formatNumber("), script.indexOf("function formatNullable("));
    const window = { limit: 10_000, used: 1_000, reserved: 0, remaining: 9_000 };
    const user = { effective_token: {}, token_usage: { minute: window, day: window,
      month: { ...window, limit: nullable ? null : 50_000_000, used: 25_000, remaining: nullable ? null : 49_975_000 },
      free_allowance: { day: window } }, internal_reserve_tokens_per_request: 0, internal_missing_usage_charge: "none" };
    const rendered = runInNewContext(`${renderers}\n${formatter}\nrenderQuota(user)`, { user, escapeHtml: (x: string) => x });
    expect(rendered).toContain("免费日");
    expect(rendered).toContain("付费周期");
    expect(rendered).toContain("25,000");
    if (nullable) expect(rendered).toContain("不限；已用");
  });
});

describe("quota exhaustion classification", () => {
  const open = { limit: null, used: 0, reserved: 0, remaining: null, window_start: "2026-09-10T00:00:00.000Z", window_end: "2026-09-11T00:00:00.000Z" };
  const partial = { ...open, limit: 10_000, used: 1_000, remaining: 9_000 };
  const spent = { ...partial, used: 10_000, remaining: 0 };
  const minute = { ...partial };
  const freeOnce = (used: number, remaining: number) => ({
    entitlement_id: "e", plan_id: "plan_free_once_1m_v1", day: open, month: open,
    total: { ...open, limit: 1_000_000, used, remaining }
  });

  it("marks a pure one-off Free user exhausted once the lifetime allowance is spent", () => {
    const alive = { source: "entitlement" as const, minute, day: open, month: open,
      free_allowance: freeOnce(30_000, 970_000) };
    expect(hasExhaustedWindow(alive)).toBe(false);
    const drained = { ...alive, free_allowance: freeOnce(1_000_000, 0) };
    expect(hasExhaustedWindow(drained)).toBe(true);
  });

  it("keeps a paid user with a spent Free allowance but open paid windows out of the exhausted filter", () => {
    const usage = { source: "entitlement" as const, minute, day: partial, month: partial,
      free_allowance: freeOnce(1_000_000, 0) };
    expect(hasExhaustedWindow(usage)).toBe(false);
  });

  it("marks a paid user exhausted only when paid windows and the Free allowance are all spent", () => {
    const usage = { source: "entitlement" as const, minute, day: spent, month: spent,
      free_allowance: freeOnce(1_000_000, 0) };
    expect(hasExhaustedWindow(usage)).toBe(true);
  });
});
