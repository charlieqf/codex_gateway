// Pinned-image fault injection: network=none, in-memory state, no production env/mounts.
import assert from "node:assert/strict";
import http from "node:http";
import { buildGateway } from "../../apps/gateway/dist/index.js";
import { goldencodePoolConfig } from "../../apps/gateway/dist/test-support.js";
import { createSqliteStore } from "../../packages/store-sqlite/dist/index.js";
import { issueAccessCredential } from "../../packages/core/dist/index.js";

assert.equal(process.env.GATEWAY_SQLITE_PATH, ":memory:");
assert(!process.env.MEDCODE_PUBLIC_MODELS_JSON);
let calls = 0;
let mode;
const upstream = http.createServer(async (request, response) => {
  for await (const _chunk of request) { /* Consume the synthetic input. */ }
  calls++;
  response.writeHead(200, { "content-type": "text/event-stream" });
  if (mode.partial) response.write('data: {"choices":[{"delta":{"content":"previous text"}}]}\n\n');
  response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "withheld_sentinel" }, finish_reason: mode.reason }],
    usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } })}\n\n`);
  response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "withheld_sentinel" } }],
    ...(mode.role ? { content_filter: [{ role: mode.role, level: 0, text: "private_sentinel" }] } : {}) })}\n\n`);
  if (!mode.timeout) response.end("data: [DONE]\n\n");
});
await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${upstream.address().port}/v1`;
const config = goldencodePoolConfig();
config.pool.members = config.pool.members.filter(member => ["tencent", "tiankuan"].includes(member.runtime));
Object.assign(process.env, {
  MEDCODE_PUBLIC_MODELS_JSON: JSON.stringify({ goldencode: config }),
  MEDCODE_TENCENT_TOKENHUB_API_KEY: "synthetic", MEDCODE_TENCENT_TOKENHUB_BASE_URL: baseUrl,
  MEDCODE_TIANKUAN_API_KEY: "synthetic", MEDCODE_TIANKUAN_BASE_URL: baseUrl,
  GATEWAY_GOLDENCODE_NATIVE_FAILOVER_MODE: "enforce",
  GATEWAY_GOLDENCODE_FAILOVER_SUBJECT_IDS: "subj_content_filter_smoke"
});
const store = createSqliteStore({ path: ":memory:" });
const subjectId = "subj_content_filter_smoke";
store.upsertSubject({ id: subjectId, label: "Synthetic", state: "active", createdAt: new Date() });
const issued = issueAccessCredential({ subjectId, label: "Synthetic", scope: "code", now: new Date(), expiresAt: new Date(Date.now() + 300000) });
store.insertAccessCredential(issued.record);
const app = buildGateway({ authMode: "credential", sessionStore: store, observationStore: store, logger: false,
  provider: { kind: "fake", async health() { return { state: "healthy", checkedAt: new Date() }; },
    async *message() { throw new Error("Unexpected provider"); } } });
const cases = [];
let report;
const tool = { name: "lookup", description: "Synthetic", parameters: { type: "object", properties: {} } };
function publicError(body) {
  assert(!body.includes("[DONE]") && !body.includes("response.completed"));
  if (body.startsWith("{")) return JSON.parse(body).error;
  const errors = body.split("\n").filter(line => line.startsWith("data: ")).flatMap(line => {
    const frame = JSON.parse(line.slice(6));
    return frame.error ? [frame.error] : frame.response?.error ? [frame.response.error] : [];
  });
  assert.equal(errors.length, 1);
  return errors[0];
}
try {
  for (const api of ["chat/completions", "responses"]) for (const stream of [false, true]) {
    for (const variant of [
      { reason: "sensitive" }, { reason: "content_filter", role: "user" },
      { reason: "sensitive", role: "history" }, { reason: "sensitive", role: "assistant", partial: true },
      { reason: "sensitive", role: "history", timeout: true }
    ]) {
      mode = variant; calls = 0;
      const payload = api === "responses"
        ? { model: "goldencode", stream, input: "Synthetic task", tools: [{ type: "function", ...tool }], tool_choice: "auto" }
        : { model: "goldencode", stream, messages: [{ role: "user", content: "Synthetic task" }],
          tools: [{ type: "function", function: tool }], tool_choice: "auto" };
      const response = await app.inject({ method: "POST", url: "/v1/" + api, payload,
        headers: { authorization: "Bearer " + issued.token, "x-medcode-request-timeout-ms": mode.timeout ? "200" : "5000" } });
      const error = publicError(response.body);
      assert.equal(error.code, "content_policy_violation");
      assert.equal(error.message, "模型服务触发内容过滤");
      assert.equal(error.retryable, false); assert.equal(error.automatic_retry_allowed, false);
      assert.equal(error.upstream_finish_reason, mode.reason);
      assert.equal(error.content_filter_stage, ({ user: "input", history: "history", assistant: "output" })[mode.role] ?? "unknown");
      assert.deepEqual(error.content_filter, mode.role ? [{ role: mode.role, level: 0 }] : []);
      assert.equal(error.request_id, response.headers["x-request-id"]);
      assert.equal(calls, 1);
      assert(!response.body.includes("withheld_sentinel") && !response.body.includes("private_sentinel"));
      const event = store.listRequestEvents({ requestId: error.request_id })[0];
      assert.equal(event.errorCode, "content_policy_violation"); assert.equal(event.upstreamAttemptCount, 1);
      assert.equal(event.totalTokens, 12);
      assert.equal(event.upstreamFinishReason, mode.reason);
      if (mode.role) assert.deepEqual(event.upstreamAttempts[0].contentFilter, [{ role: mode.role, level: 0 }]);
      cases.push({ api, stream, ...variant, passed: true, calls });
    }
  }
  assert.equal(store.database.prepare("SELECT count(*) n FROM token_reservations WHERE finalized_at IS NULL").get().n, 0);
  report = { status: "passed", checks: cases.length, external_calls: 0, production_mounts: 0, pending_reservations: 0, cases };
} finally {
  await app.close();
  upstream.closeAllConnections();
  await new Promise(resolve => upstream.close(resolve));
}
console.log(JSON.stringify(report));
