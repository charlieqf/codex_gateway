import { afterEach, describe, expect, it } from "vitest";
import { issueAccessCredential, type ClientMessageEventRecord, type RequestEventRecord } from "@codex-gateway/core";
import { createSqliteClientEventsStore, createSqliteStore } from "@codex-gateway/store-sqlite";
import { buildAdminClientMessagesPayload, renderAdminClientMessagesPage } from "./admin-client-messages.js";

const now = new Date("2026-09-14T03:31:17Z");
const cleanups: Array<() => void> = [];
afterEach(() => { for (const close of cleanups.splice(0)) close(); });

function fixture() {
  const store = createSqliteStore({ path: ":memory:" });
  const messages = createSqliteClientEventsStore({ path: ":memory:" });
  cleanups.push(() => { messages.close(); store.close(); });
  for (const id of ["login", "model"]) store.upsertSubject({ id, label: id, state: "active", createdAt: now });
  const credential = issueAccessCredential({ subjectId: "login", label: "Message credential", scope: "code", expiresAt: new Date("2030-01-01Z"), now });
  store.insertAccessCredential(credential.record);
  const message = (overrides: Partial<ClientMessageEventRecord> = {}) => messages.insertClientMessageEvent({
    id: "message-row", eventId: "message-event", requestId: "upload", credentialId: credential.record.id, subjectId: "login", scope: "code",
    sessionId: "session", messageId: "message", appName: "Desktop", appVersion: "beta.70.fixture", agent: null, providerId: null,
    modelId: null, engine: null, text: "fixture text", textSha256: "fixture-hash", attachmentsJson: "[]", createdAt: now, receivedAt: now, ...overrides
  });
  const request = (overrides: Partial<RequestEventRecord> = {}) => store.insertRequestEvent({
    requestId: "model-request", credentialId: "model-credential", subjectId: "model", scope: "code", sessionId: null,
    clientSessionId: "session", clientMessageId: "message", clientAppVersion: "beta.70.fixture", upstreamAccountId: null, provider: "openai-codex",
    startedAt: now, durationMs: 1000, firstByteMs: 100, status: "ok", errorCode: null, rateLimited: false,
    totalTokens: 4000, promptTokens: 3990, completionTokens: 10, usageSource: "provider", ...overrides
  });
  const payload = (available = true) => buildAdminClientMessagesPayload({ clientEventsStore: messages, credentialStore: store,
    observationStore: available ? store : undefined,
    query: { subject_id: "login", since: "2026-09-14T00:00:00Z", until: "2026-09-15T00:00:00Z" } });
  return { store, messages, message, request, payload };
}

describe("admin cross-Subject message diagnostics", () => {
  it("shows another credential's requests alongside an empty owner ledger without attributing their usage to the owner", () => {
    const f = fixture(); f.message(); f.request();
    const response = f.payload();
    expect(response.messages).toHaveLength(1);
    expect(response.messages[0]).toMatchObject({
      subject: { id: "login" }, gateway_requests: [], gateway_request_total: 0,
      request_summary: { outcome: "no_request", token_usage: { total_tokens: 0 } },
      identity_mismatch: { status: "possible_mismatch", message_subject_id: "login", request_subject_ids: ["model"], gateway_request_total: 1,
        gateway_requests: [{ request_id: "model-request", subject_id: "model", credential_id: "model-credential", token_usage: { provider_total_tokens: 4000 } }] }
    });
    expect(response.users.find(user => user.subject.id === "login")?.token_usage.total_tokens).toBe(0);
    expect(f.store.listRequestEvents()[0]?.subjectId).toBe("model");
  });

  it("keeps same-account calls in the normal summary and requires the exact session, message and version for other accounts", () => {
    const f = fixture(); f.message();
    f.request({ requestId: "own", subjectId: "login", totalTokens: 10 });
    f.request({ requestId: "different-session", clientSessionId: "elsewhere" });
    f.request({ requestId: "different-version", clientAppVersion: "beta.71" });
    f.request({ requestId: "different-message", clientMessageId: "elsewhere" });
    f.request({ requestId: "missing-version", clientAppVersion: null });
    f.request({ requestId: "unknown-subject", subjectId: null });
    f.request({ requestId: "own-elsewhere", subjectId: "login", clientSessionId: "elsewhere" });
    const message = f.payload().messages[0]!;
    expect(message.identity_mismatch).toBeNull();
    expect(message.gateway_requests.map(r => r.request_id)).toEqual(["own"]);
    expect(message.request_summary.token_usage.total_tokens).toBe(10);
  });

  it("handles legitimate account switching in one session without locking the session to its first Subject", () => {
    const f = fixture(); f.message();
    f.message({ id: "new-message-row", eventId: "new-message-event", messageId: "new-message" });
    f.request();
    f.request({ requestId: "new-account-call", subjectId: "login", clientMessageId: "new-message" });
    const response = f.payload();
    expect(response.messages.find(m => m.message_id === "new-message")).toMatchObject({
      identity_mismatch: null, gateway_request_total: 1, gateway_requests: [{ request_id: "new-account-call" }]
    });
    expect(response.messages.find(m => m.message_id === "message")?.identity_mismatch?.gateway_request_total).toBe(1);
  });

  it("separates rows with a reused message ID in different sessions", () => {
    const f = fixture(); f.message();
    f.message({ id: "other-row", eventId: "other-event", sessionId: "second-session" });
    f.request();
    const response = f.payload();
    expect(response.messages.find(m => m.session_id === "session")?.identity_mismatch?.gateway_request_total).toBe(1);
    expect(response.messages.find(m => m.session_id === "second-session")?.identity_mismatch).toBeNull();
  });

  it("bounds diagnostic request detail while preserving the total", () => {
    const f = fixture(); f.message();
    for (let i = 0; i < 101; i++) f.request({ requestId: `related-${i}`, startedAt: new Date(now.getTime() + i) });
    const mismatch = f.payload().messages[0]!.identity_mismatch!;
    expect(mismatch.gateway_request_total).toBe(101);
    expect(mismatch.gateway_requests_truncated).toBe(true);
    expect(mismatch.gateway_requests).toHaveLength(100);
    expect(mismatch.gateway_requests[0]?.request_id).toBe("related-1");
  });

  it("does not infer mismatches when telemetry version or observation data is unavailable", () => {
    const f = fixture(); f.message({ appVersion: null }); f.request({ clientAppVersion: null });
    expect(f.payload().messages[0]?.identity_mismatch).toBeNull();
    expect(f.payload(false)).toMatchObject({ request_usage_available: false, messages: [{ identity_mismatch: null }] });
  });

  it("renders the warning and the actual model Subject using the generated page functions", () => {
    const f = fixture(); f.message(); f.request();
    const script = renderAdminClientMessagesPage().match(/<script>([\s\S]*?)<\/script>/)![1]!;
    expect(() => new Function(script)).not.toThrow();
    const renderers = script.slice(script.indexOf("function renderMessage("), script.indexOf("function applyPreset("));
    const utilities = script.slice(script.indexOf("function subjectName("));
    const render = new Function("message", `${renderers}\n${utilities}\nreturn renderMessage(message);`);
    const html = render(f.payload().messages[0]);
    expect(html).toContain("账号可能不一致");
    expect(html).toContain("这些请求未计入本账号统计");
    expect(html).toContain("subject model");
    expect(html).toContain("model-request");
  });
});
