// Run only in an isolated candidate image with provider env supplied privately.
// Uses an in-memory Gateway/ledger; never opens a production database or executes tools.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { buildGateway } from "../../apps/gateway/dist/index.js";
import { issueAccessCredential, validateFeaturePolicy } from "@codex-gateway/core";
import { createSqliteStore, createSqliteTokenBudgetLimiter } from "@codex-gateway/store-sqlite";

const example = JSON.parse(readFileSync(new URL("../../config/gateway.goldencode.three-provider.example.json", import.meta.url)));
const existing = JSON.parse(process.env.MEDCODE_PUBLIC_MODELS_JSON || JSON.stringify(example));
process.env.MEDCODE_PUBLIC_MODELS_JSON = JSON.stringify({ ...existing, "goldencode-d": example["goldencode-d"] });
process.env.MEDCODE_PUBLIC_MODEL_ID = "goldencode";
process.env.GATEWAY_GOLDENCODE_NATIVE_FAILOVER_MODE = "enforce";
process.env.GATEWAY_GOLDENCODE_FAILOVER_SUBJECT_IDS = "";
const store = createSqliteStore({ path: ":memory:" });
const now = new Date();
store.upsertSubject({ id: "deepseek-preflight", label: "Isolated DeepSeek preflight", state: "active", createdAt: now });
const key = issueAccessCredential({ subjectId: "deepseek-preflight", label: "Synthetic", scope: "code", now,
  expiresAt: new Date(now.getTime() + 3600000), rate: { requestsPerMinute: 120, concurrentRequests: 2 } });
store.insertAccessCredential(key.record);
store.createPlan({ id: "preflight", displayName: "Synthetic", scopeAllowlist: ["code"], now,
  policy: { tokensPerMinute: null, tokensPerDay: null, tokensPerMonth: null, tokensTotal: null,
    maxPromptTokensPerRequest: null, maxTotalTokensPerRequest: null, reserveTokensPerRequest: 0, missingUsageCharge: "none" },
  featurePolicy: validateFeaturePolicy({ capabilities: ["chat", "tools"] }) });
store.grantEntitlement({ subjectId: "deepseek-preflight", planId: "preflight", periodKind: "unlimited", now });
const provider = { kind: "codex", health: async () => ({ state: "healthy", checkedAt: new Date() }),
  async *message() { throw new Error("Unexpected default provider"); } };
const app = buildGateway({ authMode: "credential", logger: false, provider, sessionStore: store, observationStore: store,
  tokenBudgetLimiter: createSqliteTokenBudgetLimiter({ db: store.database }) });
const checks = [];
const score = (key, id) => createHash("sha256").update(key).update("\0").update(id).digest("hex");
function session(model, runtime) {
  const ids = example[model].pool.members.map(member => member.id);
  for (let i = 0; i < 10000; i++) {
    const value = `deepseek-preflight-${runtime}-${i}`;
    const selected = ids.reduce((best, id) => score(`client_session:${value}`, id) > score(`client_session:${value}`, best) ? id : best);
    if (selected === `${model}-${runtime}`) return value;
  }
  throw new Error("No matching session");
}
async function call(api, payload, runtime) {
  const response = await app.inject({ method: "POST", url: `/v1/${api}`,
    headers: { authorization: `Bearer ${key.token}`, "x-medcode-client-session-id": session(payload.model, runtime) }, payload });
  const event = store.listRequestEvents({ limit: 1 })[0];
  const result = { api, model: payload.model, runtime, stream: payload.stream === true, http: response.statusCode,
    request_id: response.headers["x-request-id"], upstream_model: event?.upstreamModel,
    actual_runtime: event?.upstreamRuntime, status: event?.status, tokens: event?.totalTokens,
    ...(response.statusCode >= 400 ? { error_code: response.json().error?.code } : {}) };
  checks.push(result);
  console.log(JSON.stringify(result));
  assert.equal(response.statusCode, 200, `Request failed: ${api}/${runtime}`);
  assert.equal(event?.upstreamRuntime, runtime, "Must exercise the requested provider, not a fallback");
  const frames = payload.stream ? response.body.split("\n")
    .filter(line => line.startsWith("data: ") && line !== "data: [DONE]").map(line => JSON.parse(line.slice(6)))
    : [response.json()];
  assert.ok(!frames.some(frame => frame.error || frame.type === "response.failed"), "Unexpected error frame");
  return response;
}
const tool = { name: "probe_marker", description: "Look up the requested marker.", parameters: {
  type: "object", properties: { value: { type: "string", enum: ["深度测试"] } }, required: ["value"], additionalProperties: false } };
try {
  const models = await app.inject({ method: "GET", url: "/v1/models", headers: { authorization: `Bearer ${key.token}` } });
  const ids = models.json().data.map(x => x.id);
  assert.ok(ids.includes("goldencode") && ids.includes("goldencode-d"));
  if (existing["goldencode-local"]) assert.ok(ids.includes("goldencode-local"));
  console.log(JSON.stringify({ model_ids: ids }));
  for (const runtime of ["tencent", "tiankuan"]) {
    const first = await call("chat/completions", { model: "goldencode-d", reasoning_effort: "low", max_tokens: 1024,
      messages: [{ role: "user", content: "Call probe_marker with value 深度测试. After the tool result, return only its exact marker." }],
      tools: [{ type: "function", function: tool }], tool_choice: "required" }, runtime);
    const tc = first.json().choices[0].message.tool_calls?.[0];
    assert.equal(tc?.function.name, tool.name);
    assert.deepEqual(JSON.parse(tc.function.arguments), { value: "深度测试" });
    const second = await call("responses", { model: "goldencode-d", reasoning: { effort: "low" }, max_output_tokens: 1024,
      input: [{ type: "message", role: "user", content: "Call probe_marker with value 深度测试. After the tool result, return only its exact marker." },
        { type: "function_call", call_id: tc.id, name: tc.function.name, arguments: tc.function.arguments },
        { type: "function_call_output", call_id: tc.id, output: "PREFLIGHT_OK" }],
      tools: [{ type: "function", ...tool }], tool_choice: "auto" }, runtime === "tencent" ? "tiankuan" : "tencent");
    assert.ok(second.body.includes("PREFLIGHT_OK"));
    for (const api of ["chat/completions", "responses"]) {
      const common = { model: "goldencode-d", stream: true };
      const response = await call(api, api === "responses"
        ? { ...common, input: "Reply with only PREFLIGHT_OK", reasoning: { effort: "max" }, max_output_tokens: 1024 }
        : { ...common, messages: [{ role: "user", content: "Reply with only PREFLIGHT_OK" }], reasoning_effort: "high", max_tokens: 1024 }, runtime);
      assert.ok(response.body.includes(api === "responses" ? "response.completed" : "[DONE]"));
    }
  }
  for (const runtime of ["tencent", "tiankuan", "tokenswitch"]) {
    const response = await call("chat/completions", { model: "goldencode", reasoning_effort: "low", max_tokens: 256,
      messages: [{ role: "user", content: "Reply with only PREFLIGHT_OK" }] }, runtime);
    assert.ok(response.body.includes("PREFLIGHT_OK"));
  }
  assert.equal(store.database.prepare("SELECT count(*) AS n FROM token_reservations WHERE finalized_at IS NULL").get().n, 0);
  console.log(JSON.stringify({ passed: checks.length, schema: store.database.prepare("SELECT max(version) AS v FROM schema_migrations").get().v }));
} finally {
  await app.close();
}
