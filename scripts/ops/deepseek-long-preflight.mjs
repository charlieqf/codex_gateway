// Execute inside the deployed image with a protected candidate env and no production DB mounts.
// LONG_MODEL_FRAGMENT_JSON contains only config/gateway.goldencode-d-long.json.
import assert from "node:assert/strict";
import { resolvePublicModelRegistry, openAIModelObject } from "/app/apps/gateway/dist/services/public-model-registry.js";
import { resolveChatRequestTimeoutMs, parseChatRequestTimeoutPolicy } from "/app/apps/gateway/dist/services/chat-request-deadline.js";
import { issueAccessCredential, validateFeaturePolicy } from "@codex-gateway/core";
import { createSqliteStore, createSqliteTokenBudgetLimiter } from "@codex-gateway/store-sqlite";
import { hrwAccountForKey } from "/app/apps/gateway/dist/test-support.js";
import { isolatedProviderEnv } from "./vision-smoke-helpers.mjs";

const id = "goldencode-d-long";
// Reuse a recorded near-window result only when image, provider version and
// candidate config are unchanged; this flag repeats the smaller protocol checks.
const skipLong = process.argv.includes("--skip-long");
const original = resolvePublicModelRegistry(process.env);
const before = original.models.filter(model => model.id !== id).map(openAIModelObject);
const fragment = JSON.parse(process.env.LONG_MODEL_FRAGMENT_JSON);
const registry = JSON.parse(process.env.MEDCODE_PUBLIC_MODELS_JSON);
assert.deepEqual(registry[id], fragment[id]);
const timeouts = process.env.MEDCODE_CHAT_REQUEST_TIMEOUTS_JSON;
const failover = process.env.GATEWAY_GOLDENCODE_NATIVE_FAILOVER_MODE;
const env = isolatedProviderEnv(process.env);
for (const name of Object.keys(process.env)) delete process.env[name];
Object.assign(process.env, env, { MEDCODE_PUBLIC_MODELS_JSON: JSON.stringify(registry),
  MEDCODE_PUBLIC_MODEL_ID: "goldencode", MEDCODE_CHAT_REQUEST_TIMEOUTS_JSON: timeouts,
  GATEWAY_GOLDENCODE_NATIVE_FAILOVER_MODE: failover ?? "disabled" });
const resolved = resolvePublicModelRegistry(process.env);
assert.deepEqual(resolved.models.filter(model => model.id !== id).map(openAIModelObject), before);
assert.equal(resolveChatRequestTimeoutMs(parseChatRequestTimeoutPolicy(process.env), id, "tencent"), 1800000);
assert.equal(resolved.get(id).runtime, "pool");
assert.deepEqual(registry[id].pool.members.map(m => m.runtime).sort(), ["tencent", "tiankuan"]);
assert(registry[id].pool.members.every(m => m.upstreamModel === "deepseek-v4.1-flash-1017"));
assert.equal(resolved.get(id).vision, undefined);
const store = createSqliteStore({ path: ":memory:" });
const now = new Date();
store.upsertSubject({ id: "long-preflight", label: "Isolated long-document preflight", state: "active", createdAt: now });
const issued = issueAccessCredential({ subjectId: "long-preflight", label: "Synthetic", scope: "code", now,
  expiresAt: new Date(now.getTime() + 3600000), rate: { requestsPerMinute: 120, concurrentRequests: 2 } });
store.insertAccessCredential(issued.record);
store.createPlan({ id: "long-preflight", displayName: "Synthetic", scopeAllowlist: ["code"], now,
  policy: { tokensPerMinute: null, tokensPerDay: null, tokensPerMonth: null, tokensTotal: null,
    maxPromptTokensPerRequest: null, maxTotalTokensPerRequest: null, reserveTokensPerRequest: 0, missingUsageCharge: "none" },
  featurePolicy: validateFeaturePolicy({ capabilities: ["chat", "tools"] }) });
store.grantEntitlement({ subjectId: "long-preflight", planId: "long-preflight", periodKind: "unlimited", now });
const provider = { kind: "codex", health: async () => ({ state: "healthy", checkedAt: new Date() }),
  async *message() { throw new Error("Unexpected default provider"); } };
const { buildGateway } = await import("/app/apps/gateway/dist/index.js");
const app = buildGateway({ authMode: "credential", logger: false, provider, sessionStore: store, observationStore: store,
  tokenBudgetLimiter: createSqliteTokenBudgetLimiter({ db: store.database }),
  clientEventsStore: null, phoneAuthService: null, visionAssetService: null,
  imagingService: null, aipalService: null, panechoService: null, echonetService: null,
  echonextService: null, alphafold3Service: null });
const headers = { authorization: `Bearer ${issued.token}` };
function session(model, runtime) {
  const members = registry[model].pool.members;
  for (let i = 0; i < 10000; i++) {
    const value = `long-preflight-${runtime}-${i}`;
    const selected = hrwAccountForKey(`client_session:${value}`, members.map(m => m.id));
    if (members.find(m => m.id === selected).runtime === runtime) return value;
  }
  throw new Error("No matching session");
}
async function call(api, payload, expected = 200, runtime = "tencent") {
  const model = payload.model ?? id;
  const response = await app.inject({ method: "POST", url: `/v1/${api}`,
    headers: { ...headers, "x-medcode-client-session-id": session(model, runtime) }, payload: { model, ...payload } });
  const event = store.listRequestEvents({ limit: 1 })[0];
  console.log(JSON.stringify({ api, stream: payload.stream === true, http: response.statusCode,
    upstream_model: event?.upstreamModel, runtime: event?.upstreamRuntime, status: event?.status,
    prompt_tokens: event?.promptTokens, completion_tokens: event?.completionTokens,
    ...(response.statusCode >= 400 ? { error_code: response.json().error?.code, error_message: response.json().error?.message } : {}) }));
  assert.equal(response.statusCode, expected);
  if (expected === 200) {
    assert.equal(event?.upstreamRuntime, runtime);
    assert.equal(event?.upstreamModel, "deepseek-v4.1-flash-1017");
    const frames = payload.stream ? response.body.split("\n").filter(line => line.startsWith("data: ") && line !== "data: [DONE]")
      .map(line => JSON.parse(line.slice(6))) : [response.json()];
    assert.ok(!frames.some(frame => frame.error || frame.type === "response.failed"));
  }
  return { response, event };
}
try {
  const catalog = (await app.inject({ method: "GET", url: "/v1/models", headers })).json();
  assert.deepEqual(catalog.data.find(model => model.id === id), openAIModelObject(resolved.get(id)));
  for (const model of before.filter(model => model.id !== "goldencode-local")) {
    assert.deepEqual(catalog.data.find(item => item.id === model.id), model);
  }
  console.log(JSON.stringify({ catalog: catalog.data.map(model => ({ id: model.id, context: model.context_window, output: model.max_output_tokens })) }));
  await call("chat/completions", { messages: [{ role: "user", content: "Reply OK" }], max_tokens: 128001 }, 400);
  // Near the advertised input budget when reserving the full output budget.
  // Provider-reported input proves actual ingestion, not extraction accuracy.
  const document = Array.from({ length: 49500 }, (_, i) => `[page=${i + 1} line=1] record ${i + 1}: ordinary reference material.`).join("\n");
  const tool = { name: "probe_marker", description: "Read a synthetic marker.", parameters: {
    type: "object", properties: { value: { type: "string", enum: ["CHECK"] } }, required: ["value"], additionalProperties: false } };
  const prompt = "Call probe_marker with value CHECK. When the tool result is provided, return its marker only.";
  for (const runtime of ["tencent", "tiankuan"]) {
    const streamed = await call("chat/completions", { stream: true, reasoning_effort: "low", max_tokens: 1024,
      messages: [{ role: "user", content: "Reply only LONG_PREFLIGHT_OK." }] }, 200, runtime);
    assert.ok(streamed.response.body.includes("[DONE]"));
    assert.ok(streamed.response.body.includes('"finish_reason":"stop"'));
    if (!skipLong) {
    const result = await call("responses", { reasoning: { effort: "low" }, max_output_tokens: 128000,
      input: `Find the two boundary markers starting with FIRST_ANCHOR_ and LAST_ANCHOR_ in the document below. Return only those two complete markers.\nFIRST_ANCHOR_A17\n${document}\nLAST_ANCHOR_Z93` }, 200, runtime);
    assert.ok(result.event.promptTokens > 880000 && result.event.promptTokens + 128000 <= 1024000);
    assert.equal(result.response.json().status, "completed");
    assert.ok(result.response.body.includes("FIRST_ANCHOR_A17") && result.response.body.includes("LAST_ANCHOR_Z93"));
    }
    const first = await call("chat/completions", { reasoning_effort: "low", max_tokens: 4096,
      messages: [{ role: "user", content: prompt }], tools: [{ type: "function", function: tool }], tool_choice: "required" }, 200, runtime);
    const tc = first.response.json().choices[0].message.tool_calls?.[0];
    assert.equal(tc?.function.name, tool.name);assert.deepEqual(JSON.parse(tc.function.arguments), { value: "CHECK" });
    const next = runtime === "tencent" ? "tiankuan" : "tencent";
    const second = await call("responses", { stream: true, reasoning: { effort: "low" }, max_output_tokens: 1024,
      input: [{ type: "message", role: "user", content: prompt }, { type: "function_call", call_id: tc.id, name: tc.function.name, arguments: tc.function.arguments },
        { type: "function_call_output", call_id: tc.id, output: "LONG_PREFLIGHT_OK" }], tools: [{ type: "function", ...tool }] }, 200, next);
    assert.ok(second.response.body.includes("response.completed") && second.response.body.includes("LONG_PREFLIGHT_OK"));
    const old = await call("chat/completions", { model: "goldencode-d", reasoning_effort: "low", max_tokens: 1024,
      messages: [{ role: "user", content: "Reply only LONG_PREFLIGHT_OK." }] }, 200, runtime);
    assert.ok(old.response.body.includes("LONG_PREFLIGHT_OK"));
  }
  assert.equal(store.database.prepare("SELECT count(*) AS n FROM token_reservations WHERE finalized_at IS NULL").get().n, 0);
  console.log(JSON.stringify({ passed: true, existing_catalog_preserved: true, production_database_opened: false }));
} finally {
  await app.close();
}
