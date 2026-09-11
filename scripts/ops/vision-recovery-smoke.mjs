// Run only in an isolated process/container with no production configuration or mounts.
// Uses compiled Gateway routes, an in-memory store and a loopback synthetic provider.
import assert from "node:assert/strict";
import http from "node:http";
import { buildGateway } from "../../apps/gateway/dist/index.js";
import { goldencodePoolConfig } from "../../apps/gateway/dist/test-support.js";
import { createSqliteStore } from "@codex-gateway/store-sqlite";
import { issueAccessCredential } from "@codex-gateway/core";

assert(!process.env.GATEWAY_DATABASE_PATH && !process.env.MEDCODE_PUBLIC_MODELS_JSON,
  "Use an isolated process with no production environment");
let calls = 0;
let failures = 1;
const upstream = http.createServer(async (request, response) => {
  for await (const _ of request) { /* drain synthetic request */ }
  calls++;
  if (calls <= failures) {
    response.writeHead(500, { "content-type": "application/json" });
    response.end('{"error":"synthetic-private-detail"}');
    return;
  }
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end('data: {"choices":[{"delta":{"content":"vision recovered"},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}\n\ndata: [DONE]\n\n');
});
await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${upstream.address().port}/v1`;
const config = goldencodePoolConfig();
config.pool.members = config.pool.members.filter((member) => member.runtime === "tencent");
process.env.MEDCODE_PUBLIC_MODELS_JSON = JSON.stringify({ goldencode: { ...config,
  vision: { runtime: "xai", upstreamModel: "grok-4.5", contextWindow: 200000, maxOutputTokens: 128000, enabled: true } } });
process.env.MEDCODE_TENCENT_TOKENHUB_API_KEY = "synthetic";
process.env.MEDCODE_TENCENT_TOKENHUB_BASE_URL = baseUrl;
process.env.MEDCODE_VISION_XAI_API_KEY = "synthetic";
process.env.MEDCODE_VISION_XAI_BASE_URL = baseUrl;
const store = createSqliteStore({ path: ":memory:" });
const issued = issueAccessCredential({ subjectId: "subj_smoke", label: "Synthetic", scope: "code",
  expiresAt: new Date(Date.now() + 60000), now: new Date() });
store.upsertSubject({ id: "subj_smoke", label: "Synthetic", state: "active", createdAt: new Date() });
store.insertAccessCredential(issued.record);
const app = buildGateway({ authMode: "credential", sessionStore: store, observationStore: store, logger: false,
  provider: { kind: "fake", async health() { return { state: "healthy", checkedAt: new Date() }; },
    async *message() { throw new Error("Unexpected text provider invocation"); } } });
const headers = { authorization: `Bearer ${issued.token}` };
const image = "data:image/png;base64,aGVsbG8=";
const cases = [];
try {
  const unauthorized = await app.inject({ method: "GET", url: "/gateway/vision/capabilities" });
  assert.equal(unauthorized.statusCode, 401);
  const capabilityResponse = await app.inject({ method: "GET", url: "/gateway/vision/capabilities", headers });
  assert.equal(capabilityResponse.statusCode, 200);
  assert.equal(capabilityResponse.headers["cache-control"], "no-store");
  assert.equal(capabilityResponse.json().limits.maximum_images_per_model_request, 8);
  for (const url of ["/v1/chat/completions", "/v1/responses"]) {
    for (const stream of [false, true]) {
      for (const mode of ["recover", "exhaust", "legacy", "limit"]) {
        calls = 0;
        failures = mode === "exhaust" ? 2 : 1;
        const count = mode === "limit" ? 12 : 4;
        const response = await app.inject({ method: "POST", url,
          headers: { ...headers, ...(mode !== "legacy" ? { "x-medcode-vision-recovery-contract": "1" } : {}) },
          payload: url === "/v1/responses"
            ? { model: "goldencode", stream, input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Inspect." },
                ...Array.from({ length: count }, () => ({ type: "input_image", image_url: image }))] }] }
            : { model: "goldencode", stream, messages: [{ role: "user", content: [{ type: "text", text: "Inspect." },
                ...Array.from({ length: count }, () => ({ type: "image_url", image_url: { url: image } }))] }] } });
        const requestId = response.headers["x-request-id"];
        assert(requestId);
        const events = store.listRequestEvents({ requestId });
        assert.equal(events.length, 1);
        if (mode === "recover") {
          assert.equal(calls, 2, response.body);
          assert.equal(response.statusCode, 200);
          assert(response.body.includes("vision recovered"));
          assert(!response.body.includes("automatic_retry_allowed"));
          assert.equal(events[0].upstreamAttemptCount, 2);
          assert.equal(events[0].totalTokens, 12);
          assert.equal(events[0].upstreamAttempts.at(-1).visionRecovery.callsUsed, 2);
        } else if (mode === "limit") {
          assert.equal(calls, 0);
          assert.equal(response.statusCode, 413);
          assert.deepEqual(response.json().error.image_limit, { kind: "image_count", actual: 12, maximum: 8 });
        } else {
          assert.equal(calls, mode === "exhaust" ? 2 : 1);
          assert(response.body.includes(String(requestId)));
          assert(!response.body.includes("[DONE]") && !response.body.includes("response.completed"));
          assert.equal(response.body.includes('"automatic_retry_allowed":false'), mode === "exhaust");
          assert.equal((response.body.match(/"code":"upstream_unavailable"/g) ?? []).length, 1);
        }
        assert(!response.body.includes("synthetic-private-detail"));
        cases.push({ url, stream, mode, calls, status: response.statusCode });
      }
    }
  }
  console.log(JSON.stringify({ assertions: "passed", compiled_routes: cases, capabilities: "passed",
    cleanup: [], production_accounts_created: 0, external_model_calls: 0 }));
} finally {
  await app.close();
  await new Promise((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
}
