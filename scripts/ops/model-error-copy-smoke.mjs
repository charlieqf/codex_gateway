// Run against built code. Faults use an injected fetch; production upstreams,
// credentials and user accounts are never modified or invoked by this smoke.
import assert from "node:assert/strict";
import { OpenAICompatibleProviderAdapter } from "../../apps/gateway/dist/services/openai-compatible-provider.js";
import { openAIErrorPayload } from "../../apps/gateway/dist/openai-compat.js";

const results = [];
for (const vision of [false, true]) {
  const provider = new OpenAICompatibleProviderAdapter({
    providerKind: vision ? "xai" : "tencent",
    baseUrl: "https://synthetic.invalid/v1", apiKey: "", apiKeyEnv: "SYNTHETIC_UNUSED",
    apiKeyRequired: false, upstreamModel: "synthetic", timeoutMs: 1000,
    fetchImpl: async () => new Response('{"error":"private-provider-detail"}', { status: 500 })
  });
  const events = [];
  for await (const event of provider.message({
    upstreamAccount: { id: "synthetic" }, subject: { id: "synthetic" },
    session: { id: "synthetic" }, scope: "code", message: "Synthetic error copy check",
    images: vision ? [{ imageUrl: "data:image/png;base64,aGVsbG8=" }] : undefined
  })) events.push(event);
  assert.equal(events.length, 1);
  const event = events[0];
  assert.equal(event.code, "upstream_unavailable");
  assert.equal(event.gatewayError.httpStatus, 503);
  assert.equal(event.providerFailure.kind, "http_server");
  const payload = openAIErrorPayload(event.gatewayError, { requestId: "req-error-copy-smoke" });
  assert.equal(payload.error.code, "upstream_unavailable");
  assert.equal(payload.error.request_id, "req-error-copy-smoke");
  assert.match(payload.error.message, vision ? /^图片分析时发生处理错误/ : /^模型处理时发生处理错误/);
  assert.match(payload.error.message, /请稍后在当前对话中重试/);
  assert.doesNotMatch(JSON.stringify(payload), /temporarily unavailable|private-provider-detail/);
  results.push({ vision, code: payload.error.code, message: payload.error.message });
}
const response = await fetch("https://goldencode.instmarket.com.au:1443/gateway/health", {
  signal: AbortSignal.timeout(20000)
});
assert.equal(response.status, 200);
assert.equal((await response.json()).state, "ready");
console.log(JSON.stringify({ assertions: "passed", public_health: "ready",
  synthetic_faults: results, cleanup: [], production_accounts_created: 0 }));
