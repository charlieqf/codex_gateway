// Exact candidate preflight (in memory), or authorized public release smoke.
// Only synthetic images/data; never print keys, images, raw errors or signed URLs.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { issueAccessCredential, validateFeaturePolicy } from "@codex-gateway/core";
import { createSqliteStore, createSqliteTokenBudgetLimiter } from "@codex-gateway/store-sqlite";
import { isolatedProviderEnv, smokeImage, smokeText } from "./vision-smoke-helpers.mjs";

const publicMode = process.argv.includes("--public");
const registry = JSON.parse(process.env.MEDCODE_PUBLIC_MODELS_JSON);
const models = ["goldencode", "goldencode-d"];
for (const model of models) {
  assert.equal(registry[model].vision.runtime, "tiankuan");
  assert.equal(registry[model].vision.upstreamModel, "deepseek-v4.1-flash");
  assert.notEqual(registry[model].vision.enabled, false);
}
const dbPath = publicMode ? process.env.GATEWAY_SQLITE_PATH : ":memory:";
if (!publicMode) {
  const env = isolatedProviderEnv(process.env);
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, env, { MEDCODE_PUBLIC_MODELS_JSON: JSON.stringify(registry), MEDCODE_PUBLIC_MODEL_ID: "goldencode" });
}
const run = "tiankuan_vision_smoke_" + randomUUID(), subject = "subj_" + run, plan = "plan_" + run;
const store = createSqliteStore({ path: dbPath }), db = store.database;
const report = { run, public: publicMode, at: new Date().toISOString(), checks: [] };
const persist = () => { if (publicMode) writeFileSync("/tmp/tiankuan-vision-public-smoke.json", JSON.stringify(report, null, 2), { mode: 0o600 }); };
let app, issued, entitlement, failure;
const headers = () => ({ authorization: "Bearer " + issued.token, "content-type": "application/json",
  "x-medevidence-client-version": "2.0.0-beta.126", "x-medcode-client-session-id": run,
  "x-medcode-request-timeout-ms": "90000", "x-medcode-vision-recovery-contract": "1" });
async function call(api, payload, label, vision = true) {
  const started = Date.now();
  let status, body, requestId;
  if (publicMode) {
    const response = await fetch("https://goldencode.instmarket.com.au:1443/v1/" + api, {
      method: "POST", headers: headers(), body: JSON.stringify(payload), redirect: "error", signal: AbortSignal.timeout(100000) });
    status = response.status; body = await response.text(); requestId = response.headers.get("x-request-id");
  } else {
    const response = await app.inject({ method: "POST", url: "/v1/" + api, headers: headers(), payload });
    status = response.statusCode; body = response.body; requestId = response.headers["x-request-id"];
  }
  const item = { label, model: payload.model, api, stream: !!payload.stream, http: status, request_id: requestId, duration_ms: Date.now() - started };
  report.checks.push(item); persist();
  assert.equal(status, 200);
  const frames = payload.stream ? body.split("\n").filter(line => line.startsWith("data:") && line.slice(5).trim() !== "[DONE]").map(line => JSON.parse(line.slice(5))) : [JSON.parse(body)];
  assert(!frames.some(f => f.error || f.type === "response.failed"));
  let calls;
  if (api === "responses") {
    const terminal = payload.stream ? frames.find(f => f.type === "response.completed")?.response : frames[0];
    assert.equal(terminal?.status, "completed");
    calls = terminal.output.filter(i => i.type === "function_call").map(i => ({ id: i.call_id, name: i.name, arguments: i.arguments }));
  } else {
    if (payload.stream) {
      assert(body.includes("data: [DONE]"));
      assert(frames.some(f => f.choices?.[0]?.finish_reason === "stop"));
      calls = [];
    } else calls = (frames[0].choices[0].message.tool_calls ?? []).map(i => ({ id: i.id, ...i.function }));
  }
  let event;
  for (let i = 0; i < 50; i++) { event = store.listRequestEvents({ requestId })[0]; if (event) break; await sleep(100); }
  assert.equal(event?.status, "ok");
  assert.equal(event.publicModelId, payload.model);
  if (vision) {
    assert.equal(event.upstreamRuntime, "tiankuan"); assert.equal(event.provider, "tiankuan");
    assert.equal(event.upstreamModel, "deepseek-v4.1-flash");
  }
  assert(event.totalTokens > 0);
  const ledger = db.prepare("SELECT final_total_tokens,finalized_at FROM token_reservations WHERE subject_id=? AND request_id=?").get(subject, requestId);
  assert(ledger?.finalized_at); assert.equal(ledger.final_total_tokens, event.totalTokens);
  Object.assign(item, { runtime: event.upstreamRuntime, upstream_model: event.upstreamModel, total_tokens: event.totalTokens,
    reasoning_effort: event.effectiveReasoningEffort, ledger_finalized: true });
  return { text: smokeText(api, !!payload.stream, frames), calls, item };
}
function passed(result, expected) {
  assert.equal(result.text.trim(), expected);
  result.item.passed = true; result.item.synthetic_answer = result.text.trim(); persist();
  console.log(JSON.stringify(result.item));
}
try {
  const now = new Date();
  store.upsertSubject({ id: subject, label: "Synthetic TianKuan vision validation", state: "active", createdAt: now,
    externalProvider: "release_smoke", externalUserId: run });
  issued = issueAccessCredential({ subjectId: subject, label: run, scope: "code", credentialClass: "desktop", now,
    expiresAt: new Date(Date.now() + 3600000), allowedPublicModels: models, knownPublicModelIds: models,
    rate: { requestsPerMinute: 60, concurrentRequests: 1 } });
  store.insertAccessCredential(issued.record);
  store.createPlan({ id: plan, displayName: "Synthetic vision validation", scopeAllowlist: ["code"], now,
    policy: { tokensPerMinute: null, tokensPerDay: 200000, tokensPerMonth: 1000000, tokensTotal: null,
      maxPromptTokensPerRequest: 16384, maxTotalTokensPerRequest: 32768, reserveTokensPerRequest: 0, missingUsageCharge: "estimate" },
    featurePolicy: validateFeaturePolicy({ capabilities: ["chat", "tools"], medcode_models: { allowed: models } }) });
  entitlement = store.grantEntitlement({ subjectId: subject, planId: plan, periodKind: "unlimited", now });
  if (!publicMode) {
    const { buildGateway } = await import("../../apps/gateway/dist/index.js");
    app = buildGateway({ authMode: "credential", logger: false,
      provider: { kind: "codex", health: async () => ({ state: "healthy", checkedAt: now }), async *message() { throw new Error("Unexpected default provider"); } },
      sessionStore: store, observationStore: store, tokenBudgetLimiter: createSqliteTokenBudgetLimiter({ db }),
      clientEventsStore: null, phoneAuthService: null, visionAssetService: null, imagingService: null,
      aipalService: null, panechoService: null, echonetService: null, echonextService: null, alphafold3Service: null });
  }
  const image = await smokeImage("8264");
  const prompt = "Read the four-digit number shown in the image. Reply with only those four digits.";
  const chatContent = text => [{ type: "text", text }, { type: "image_url", image_url: { url: image, detail: "high" } }];
  const responseInput = text => [{ type: "message", role: "user", content: [{ type: "input_text", text }, { type: "input_image", image_url: image, detail: "high" }] }];
  const tool = { name: "record_digits", description: "Record the four digits read from the image.", parameters: {
    type: "object", properties: { digits: { type: "string", pattern: "^[0-9]{4}$" } }, required: ["digits"], additionalProperties: false } };
  for (const model of models) {
    let index = 0;
    for (const api of ["chat/completions", "responses"]) for (const stream of [false, true]) {
      const effort = ["none", "low", "high", "max"][index++];
      const payload = api === "responses" ? { model, stream, reasoning: { effort }, max_output_tokens: 2048, input: responseInput(prompt) }
        : { model, stream, reasoning_effort: effort, max_tokens: 2048, messages: [{ role: "user", content: chatContent(prompt) }] };
      const result = await call(api, payload, "image-" + effort);
      assert.equal(result.item.reasoning_effort, effort === "max" ? "high" : effort === "none" ? "low" : effort);
      passed(result, "8264");
    }
    const history = [{ role: "user", content: chatContent(prompt) }, { role: "assistant", content: "8264" },
      { role: "user", content: "Read the earlier image again and return its digits in reverse order. Answer with only four digits." }];
    passed(await call("chat/completions", { model, messages: history, reasoning_effort: "high", max_tokens: 2048 }, "historical-image-followup"), "4628");
    const toolPrompt = "Read the image and call record_digits with the digits. When its tool result is present, reply with only the exact receipt from that result and do not call again.";
    const first = await call("chat/completions", { model, messages: [{ role: "user", content: chatContent(toolPrompt) }],
      tools: [{ type: "function", function: tool }], tool_choice: "required", reasoning_effort: "high", max_tokens: 2048 }, "image-tool-call");
    assert.equal(first.calls.length, 1); const tc = first.calls[0];
    assert.equal(tc.name, tool.name); assert.deepEqual(JSON.parse(tc.arguments), { digits: "8264" });
    first.item.passed = true; first.item.tool_arguments = JSON.parse(tc.arguments); persist(); console.log(JSON.stringify(first.item));
    const receipt = "RECEIPT_" + randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase();
    passed(await call("responses", { model, stream: true, reasoning: { effort: "high" }, max_output_tokens: 2048,
      input: [...responseInput(toolPrompt), { type: "function_call", call_id: tc.id, name: tc.name, arguments: tc.arguments },
        { type: "function_call_output", call_id: tc.id, output: JSON.stringify({ accepted: true, receipt }) }],
      tools: [{ type: "function", ...tool }], tool_choice: "auto" }, "image-tool-result-continuation"), receipt);
    passed(await call("chat/completions", { model, messages: [{ role: "user", content: "Reply with only TEXT_OK." }],
      reasoning_effort: "low", max_tokens: 1024 }, "text-control", false), "TEXT_OK");
  }
  assert.equal(report.checks.length, 16);
  assert(report.checks.every(item => item.passed));
} catch (error) {
  failure = { name: error.name, code: error.code ?? null,
    location: error.stack?.split("\n").find(line => line.includes("tiankuan-vision-smoke.mjs:"))?.trim() };
} finally {
  if (issued) store.revokeAccessCredentialByPrefix(issued.record.prefix);
  if (entitlement) store.cancelEntitlement({ id: entitlement.id, now: new Date(), reason: run + " cleanup" });
  if (store.getPlan(plan)) store.deprecatePlan(plan);
  if (store.getSubject(subject)) store.setSubjectState(subject, "disabled");
  let pending;
  for (let i = 0; i < 30; i++) { pending = db.prepare("SELECT count(*) n FROM token_reservations WHERE subject_id=? AND finalized_at IS NULL").get(subject).n; if (!pending) break; await sleep(1000); }
  let revokedStatus = null;
  if (publicMode && issued) {
    const response = await fetch("https://goldencode.instmarket.com.au:1443/v1/models", { headers: headers(), signal: AbortSignal.timeout(5000) });
    revokedStatus = response.status; await response.body?.cancel();
  }
  report.cleanup = { subject_state: store.getSubject(subject)?.state, active_credentials: db.prepare("SELECT count(*) n FROM access_credentials WHERE subject_id=? AND revoked_at IS NULL").get(subject).n,
    pending_reservations: pending, plan_deprecated: store.getPlan(plan)?.state === "deprecated", revoked_public_status: revokedStatus };
  if (pending || report.cleanup.active_credentials || !report.cleanup.plan_deprecated || report.cleanup.subject_state !== "disabled" || publicMode && revokedStatus !== 401) failure ??= { name: "CleanupFailure" };
  if (app) await app.close(); else store.close();
}
report.status = failure ? "failed" : "passed"; if (failure) report.failure = failure; persist();
console.log(JSON.stringify({ status: report.status, checks: report.checks.length, cleanup: report.cleanup, failure }));
if (failure) process.exitCode = 1;
