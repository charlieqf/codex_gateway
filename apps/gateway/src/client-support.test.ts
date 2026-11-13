import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewayError } from "@codex-gateway/core";
import { createSqliteClientEventsStore, createSqliteStore } from "@codex-gateway/store-sqlite";
import { parseSupportReport, supportAutomaticBytes, supportManualBytes } from "./client-support.js";
import { ClientSupportStore, supportDetailsRetentionMs, supportSummaryRetentionMs } from "./client-support-store.js";
import { registerClientSupportRoutes } from "./client-support-routes.js";
import type { PhoneAuthService } from "./services/phone-auth-service.js";

const examples = JSON.parse(readFileSync(new URL("../../../docs/coordination/desktop-support-reporting-v1.examples.json", import.meta.url), "utf8"));
const adminToken = "support-test-admin-token-32-characters";
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); vi.restoreAllMocks(); });
function report(manual = false) { return structuredClone({ ...(manual ? examples.manual_authenticated : examples.automatic_anonymous), report_id: randomUUID() }); }
function fixture(limits?: { rows: number; bytes: number }, accessMode: "token" | "open" = "token") {
  const directory = mkdtempSync(join(tmpdir(), "gateway-support-"));
  const events = createSqliteClientEventsStore({ path: join(directory, "client-events.db") });
  const gateway = createSqliteStore({ path: ":memory:" });
  const store = new ClientSupportStore(events.database, join(directory, "client-support"), limits);
  const clock = { time: new Date("2026-11-13T11:42:00.000Z").getTime() };
  const phoneAuth = {
    authenticateAccessToken: vi.fn((token: string) => {
      if (!["account-a", "account-b"].includes(token)) throw new GatewayError({ code: "access_token_invalid", message: "invalid", httpStatus: 401 });
      return { subjectId: token === "account-a" ? "subj_example" : "subj_other" };
    }),
    phoneHash: vi.fn(() => "test-phone-hash")
  };
  const app = Fastify();
  registerClientSupportRoutes(app, { store, clientEvents: events, gatewayStore: gateway, phoneAuth: phoneAuth as unknown as PhoneAuthService,
    phoneStore: gateway, adminAuditStore: gateway, observationStore: gateway,
    access: { mode: accessMode, token: accessMode === "token" ? adminToken : null }, now: () => new Date(clock.time) });
  cleanup.push(async () => { await app.close(); events.close(); gateway.close(); rmSync(directory, { recursive: true, force: true }); });
  const post = (payload: unknown, token?: string) => app.inject({ method: "POST", url: "/gateway/client-events/support", payload: payload as object,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) } });
  const query = (payload: object, token = adminToken) => app.inject({ method: "POST", url: "/gateway/admin/client-support/query", payload, headers: { authorization: `Bearer ${token}` } });
  return { app, store, events, gateway, clock, post, query, phoneAuth };
}

describe("desktop support contract", () => {
  it("accepts both published examples and rejects unknown fields instead of stripping them", () => {
    expect(parseSupportReport(examples.automatic_anonymous)).not.toBeNull();
    expect(parseSupportReport(examples.manual_authenticated)).not.toBeNull();
    for (const extra of [{ message: "private prompt" }, { token: "secret" }, { diagnostics: [] }, { report_id: "../../secret" }])
      expect(parseSupportReport({ ...report(), ...extra })).toBeNull();
  });
  it.each([
    { error_code: "cgu_live_privatecredential" }, { request_id: "req-18655194255" },
    { error_code: "failed C:\\private\\file" }, { transport: { error_codes: ["raw error text"] } },
    { transport: { duration_ms: -1 } }, { transport: {} }, { occurred_at: "2026-02-30T01:00:00Z" },
    { app_version: "2.0.0\nprivate" }
  ])("rejects unsafe or invalid values: %j", extra => expect(parseSupportReport({ ...report(), ...extra })).toBeNull());
  it("enforces account and ten-minute diagnostic boundaries", () => {
    const input = report(true);
    input.diagnostics[0].account_subject_id = "subj_other";
    expect(parseSupportReport(input)).toBeNull();
    delete input.diagnostics[0].account_subject_id;
    expect(parseSupportReport(input)).toBeNull();
    input.diagnostics[0] = { occurred_at: input.occurred_at, process: "main", operation: "startup", operation_id: randomUUID(), event: "error" };
    expect(parseSupportReport(input)).not.toBeNull();
    input.diagnostics[0].occurred_at = "2026-11-13T11:20:00Z";
    expect(parseSupportReport(input)).toBeNull();
  });
  it("makes immutable ACKs across authenticated/anonymous retries and never upgrades initial ownership", async () => {
    const f = fixture(); const body = report(true);
    const first = await f.post(body, "account-a"); expect(first.statusCode).toBe(201);
    f.clock.time += 1000;
    for (const token of ["account-a", "account-b", undefined]) {
      const retry = await f.post(Object.fromEntries(Object.entries(body).reverse()), token);
      expect(retry.statusCode).toBe(200); expect(retry.json()).toEqual({ ...first.json(), duplicate: true });
    }
    expect(f.store.get(body.report_id)?.subject_id).toBe("subj_example");
    expect((await f.post({ ...body, error_code: "different" })).statusCode).toBe(409);
    const anonymous = report(true);
    expect((await f.post(anonymous)).statusCode).toBe(201);
    expect((await f.post(anonymous, "account-a")).statusCode).toBe(200);
    expect(f.store.get(anonymous.report_id)?.subject_id).toBeNull();
  });
  it("rejects invalid credentials and new cross-account reports while allowing exact anonymous fallback", async () => {
    const f = fixture(); const body = report(true);
    expect((await f.post(body, "bad-key")).statusCode).toBe(401);
    expect((await f.post(body, "account-b")).statusCode).toBe(403);
    expect((await f.post(body)).statusCode).toBe(201);
    expect((await f.post(report(), "account-a")).statusCode).toBe(403);
    expect(f.gateway.listRequestEvents()).toHaveLength(0);
  });
  it("counts encoded bytes including whitespace, rejects malformed JSON, and limits manual bodies", async () => {
    const f = fixture();
    const body = JSON.stringify(report());
    expect((await f.post(body + " ".repeat(supportAutomaticBytes - Buffer.byteLength(body)))).statusCode).toBe(201);
    expect((await f.post(JSON.stringify(report()) + " ".repeat(supportAutomaticBytes))).statusCode).toBe(413);
    expect((await f.post(JSON.stringify(report(true)) + " ".repeat(supportManualBytes))).statusCode).toBe(413);
    expect((await f.post('{"schema_version":')).statusCode).toBe(400);
  });
  it("survives lost ACKs, DB write failures and missing files without reporting false storage success", async () => {
    const f = fixture(); const body = report(true);
    f.events.database.exec("CREATE TRIGGER support_fail BEFORE INSERT ON client_support_reports BEGIN SELECT RAISE(ABORT, 'test failure'); END");
    expect((await f.post(body, "account-a")).statusCode).toBe(503);
    expect(f.store.get(body.report_id)).toBeUndefined();
    expect(readdirSync(f.store.directory)).toHaveLength(1);
    f.events.database.exec("DROP TRIGGER support_fail");
    expect((await f.post(body, "account-a")).statusCode).toBe(201);
    const received = f.store.get(body.report_id)?.received_at;
    unlinkSync(join(f.store.directory, readdirSync(f.store.directory)[0]));
    expect((await f.post(body)).statusCode).toBe(200);
    expect(f.store.get(body.report_id)?.received_at).toBe(received);
    expect(readdirSync(f.store.directory)).toHaveLength(1);
  });
  it("enforces capacity and independent rate limits", async () => {
    const full = fixture({ rows: 1, bytes: 1 });
    expect((await full.post(report(true))).statusCode).toBe(503);
    expect((await full.post(report())).statusCode).toBe(201);
    expect((await full.post(report())).statusCode).toBe(503);
    const f = fixture(); const body = report();
    for (let i = 0; i < 30; i++) expect((await f.post(body)).statusCode).toBe(i ? 200 : 201);
    const limited = await f.post(body); expect(limited.statusCode).toBe(429); expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
  });
  it("keeps summaries 30 days, details 7 days and cleans orphan files", async () => {
    const f = fixture(); const body = report(true); await f.post(body);
    const file = join(f.store.directory, readdirSync(f.store.directory)[0]);
    // mtime from a retry must not extend the retention of an indexed report.
    utimesSync(file, new Date(f.clock.time + supportDetailsRetentionMs), new Date(f.clock.time + supportDetailsRetentionMs));
    f.clock.time += supportDetailsRetentionMs;
    expect((await f.post(body)).statusCode).toBe(410);
    f.store.prune(f.clock.time); expect(readdirSync(f.store.directory)).toHaveLength(0); expect(f.store.get(body.report_id)).toBeDefined();
    f.clock.time += supportSummaryRetentionMs;
    f.store.prune(f.clock.time); expect(f.store.get(body.report_id)).toBeUndefined();
    const orphan = report(true);
    f.events.database.exec("CREATE TRIGGER support_fail BEFORE INSERT ON client_support_reports BEGIN SELECT RAISE(ABORT, 'test failure'); END");
    await f.post(orphan);
    const orphanFile = join(f.store.directory, readdirSync(f.store.directory)[0]);
    utimesSync(orphanFile, new Date(0), new Date(0)); f.store.prune(f.clock.time);
    expect(readdirSync(f.store.directory)).toHaveLength(0);
  });
  it("protects management data and downloads, audits reads, and never correlates anonymous claims", async () => {
    const f = fixture(); const body = report(true); await f.post(body);
    expect((await f.query({}, "wrong-admin-token")).statusCode).toBe(401);
    const result = await f.query({ report_id: body.report_id }); expect(result.statusCode).toBe(200);
    const row = result.json().reports[0]; expect(row.identity).toBe("anonymous"); expect(row.correlation.status).toBe("anonymous");
    const url = `/gateway/admin/client-support/${body.report_id}/diagnostics`;
    expect((await f.app.inject(url)).statusCode).toBe(401);
    const download = await f.app.inject({ url, headers: { authorization: `Bearer ${adminToken}` } });
    expect(download.statusCode).toBe(200); expect(download.json()).toEqual(body);
    expect(download.headers["cache-control"]).toBe("no-store"); expect(download.headers["content-disposition"]).toContain("attachment");
    expect(f.gateway.listAdminAuditEvents().map(item => item.action).sort()).toEqual(["client-support-download", "client-support-query"]);
    expect(JSON.stringify(f.gateway.listAdminAuditEvents())).not.toContain(adminToken);
    const open = fixture(undefined, "open"); expect((await open.query({})).statusCode).toBe(404);
  });
});
