// Authorized release smoke: synthetic account, public HTTPS, no tool execution.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { issueAccessCredential, validateFeaturePolicy } from "@codex-gateway/core";
import { createSqliteStore } from "@codex-gateway/store-sqlite";
import { hrwAccountForKey } from "../../apps/gateway/dist/test-support.js";

const origin = "https://goldencode.instmarket.com.au:1443";
const visionSmoke = process.argv.includes("--vision");
const run = "deepseek_release_smoke_" + randomUUID(), subject = "subj_" + run, plan = "plan_" + run;
const store = createSqliteStore({ path: process.env.GATEWAY_SQLITE_PATH }), db = store.database;
const registry = JSON.parse(process.env.MEDCODE_PUBLIC_MODELS_JSON);
const modelIds = ["goldencode", "goldencode-d", "goldencode-local"];
const report = { at: new Date().toISOString(), run, subject_id: subject, checks: [] };
const persist = () => writeFileSync("/tmp/goldencode-d-public-smoke.json", JSON.stringify(report, null, 2), { mode: 0o600 });
const headers = () => ({ authorization: "Bearer " + issued.token, "content-type": "application/json",
  "x-medevidence-client-version": "2.0.0-beta.112" });
const members = model => registry[model].pool.members.filter(m => m.enabled !== false);
function runtimeFor(model, session) {
  return members(model).find(m => m.id === hrwAccountForKey("client_session:" + session, members(model).map(m => m.id))).runtime;
}
function sessionFor(model, runtime) {
  for (let i = 0; i < 10000; i++) { const session = run + "_" + i; if (runtimeFor(model, session) === runtime) return session; }
  throw new Error("No provider session found");
}
let issued, entitlement, failure;
async function call(api, payload, session, label, vision = false) {
  const started = Date.now(), callId = Date.now() + "_" + randomUUID();
  const response = await fetch(origin + "/v1/" + api, { method: "POST", redirect: "error",
    headers: { ...headers(), "x-medcode-client-session-id": session, "x-medcode-call-id": callId,
      "x-medcode-request-timeout-ms": "90000" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(100000) });
  const body = await response.text(), requestId = response.headers.get("x-request-id");
  const item = { label, model: payload.model, api, stream: payload.stream === true, http: response.status,
    request_id: requestId, call_id: callId, session_id: session, duration_ms: Date.now() - started };
  report.checks.push(item); persist();
  assert.equal(response.status, 200, "Public request HTTP failure");
  const frames = payload.stream ? body.split("\n").filter(line => line.startsWith("data: ") && line !== "data: [DONE]")
    .map(line => JSON.parse(line.slice(6))) : [JSON.parse(body)];
  assert(!frames.some(frame => frame.error || frame.type === "response.failed"), "Public error frame");
  let text = "", calls = [];
  if (api === "responses") {
    const terminal = payload.stream ? frames.find(f => f.type === "response.completed")?.response : frames[0];
    assert(terminal, "Missing Responses completion");
    calls = terminal.output.filter(i => i.type === "function_call").map(i => ({ id: i.call_id, name: i.name, arguments: i.arguments }));
    text = terminal.output.filter(i => i.type === "message").flatMap(i => i.content).filter(i => i.type === "output_text").map(i => i.text).join("");
  } else if (!payload.stream) {
    const message = frames[0].choices[0].message;
    text = message.content ?? ""; calls = (message.tool_calls ?? []).map(i => ({ id: i.id, ...i.function }));
  } else {
    assert(body.includes("data: [DONE]"), "Missing Chat terminator");
    text = frames.map(f => f.choices?.[0]?.delta?.content ?? "").join("");
  }
  let event;
  for (let i = 0; i < 30; i++) { event = store.listRequestEvents({ requestId })[0]; if (event) break; await sleep(100); }
  assert.equal(event?.status, "ok"); assert.equal(event.upstreamRuntime, vision ? "xai" : runtimeFor(payload.model, session));
  assert.equal(event.publicModelId, payload.model);
  if (vision) {
    assert.equal(event.upstreamModel, registry[payload.model].vision.upstreamModel);
    assert.equal(event.requestedReasoningEffort, payload.model === "goldencode-d" ? "max" : "high");
    assert.equal(event.effectiveReasoningEffort, "high");
  }
  assert(event.totalTokens > 0);
  const ledger = db.prepare("SELECT final_total_tokens,finalized_at FROM token_reservations WHERE subject_id=? AND request_id=?").get(subject, requestId);
  assert(ledger?.finalized_at); assert.equal(ledger.final_total_tokens, event.totalTokens);
  Object.assign(item, { passed: true, runtime: event.upstreamRuntime, upstream_model: event.upstreamModel,
    total_tokens: event.totalTokens, ledger_finalized: true, reasoning_effort: event.effectiveReasoningEffort });
  if (label === "same-session-switch") {
    const receipt = await fetch(origin + "/gateway/model-calls/" + callId,
      { headers: headers(), signal: AbortSignal.timeout(10000) });
    assert.equal(receipt.status, 200); assert.equal((await receipt.json()).state, "completed");
    const count = () => db.prepare("SELECT count(*) n FROM token_reservations WHERE subject_id=?").get(subject).n;
    const before = count();
    const replayHeaders = { ...headers(), "x-medcode-client-session-id": session,
      "x-medcode-call-id": callId, "x-medcode-request-timeout-ms": "90000" };
    const replay = await fetch(origin + "/v1/" + api, { method: "POST", headers: replayHeaders,
      body: JSON.stringify(payload), signal: AbortSignal.timeout(10000) });
    assert.equal(replay.status, 200); assert.equal(await replay.text(), body);
    const conflict = await fetch(origin + "/v1/" + api, { method: "POST", headers: replayHeaders,
      body: JSON.stringify({ ...payload, model: payload.model === "goldencode" ? "goldencode-d" : "goldencode" }),
      signal: AbortSignal.timeout(10000) });
    assert.equal(conflict.status, 409); assert.equal((await conflict.json()).error.code, "model_call_conflict");
    assert.equal(count(), before); item.receipt_replay_no_extra_charge = true; item.reused_id_model_change_rejected = true;
  }
  persist(); console.log(JSON.stringify({ public_check: item }));
  return { text, calls };
}
const prompt = "Call probe_marker with value 深度测试. After the tool result, return only its exact marker.";
const tool = { name: "probe_marker", description: "Synthetic marker lookup; never actually executed.", parameters: {
  type: "object", properties: { value: { type: "string", enum: ["深度测试"] } }, required: ["value"], additionalProperties: false } };
try {
  assert.equal(db.prepare("SELECT max(version) AS v FROM schema_migrations").get().v, 44);
  assert.deepEqual(members("goldencode-d").map(m => m.runtime).sort(), ["tencent", "tiankuan"]);
  const now = new Date(); assert.equal(store.getSubject(subject), null);
  store.upsertSubject({ id: subject, label: "Gateway DeepSeek release smoke", state: "active", createdAt: now,
    externalProvider: "release_smoke", externalUserId: run });
  issued = issueAccessCredential({ subjectId: subject, label: run, scope: "code", credentialClass: "desktop", now,
    expiresAt: new Date(Date.now() + 3600000), allowedPublicModels: modelIds, knownPublicModelIds: modelIds,
    rate: { requestsPerMinute: 30, concurrentRequests: 1 } });
  store.insertAccessCredential(issued.record);
  store.createPlan({ id: plan, displayName: "Synthetic DeepSeek release smoke", scopeAllowlist: ["code"], now,
    policy: { tokensPerMinute: null, tokensPerDay: 100000, tokensPerMonth: 1000000, tokensTotal: null,
      maxPromptTokensPerRequest: 8192, maxTotalTokensPerRequest: 8192, reserveTokensPerRequest: 0, missingUsageCharge: "estimate" },
    featurePolicy: validateFeaturePolicy({ capabilities: ["chat", "tools"], medcode_models: { allowed: modelIds } }) });
  entitlement = store.grantEntitlement({ subjectId: subject, planId: plan, periodKind: "unlimited", now }); persist();
  const models = await fetch(origin + "/v1/models", { headers: headers(), signal: AbortSignal.timeout(10000) });
  assert.equal(models.status, 200); report.models = (await models.json()).data;
  for (const id of modelIds) assert(report.models.some(m => m.id === id)); persist();
  if (visionSmoke) {
    const { default: sharp } = await import("sharp");
    const segments = [[12, 0, 66, 12], [78, 12, 12, 66], [78, 90, 12, 66],
      [12, 156, 66, 12], [0, 90, 12, 66], [0, 12, 12, 66], [12, 78, 66, 12]];
    const digits = ["abc", "abcdg", "bc", "abcdfg"].map((enabled, index) => [...enabled].map(letter => {
      const [x, y, width, height] = segments[letter.charCodeAt(0) - 97];
      return `<rect x="${60 + index * 130 + x}" y="${150 + y}" width="${width}" height="${height}" fill="black"/>`;
    }).join("")).join("");
    const png = await sharp(Buffer.from(`<svg width="640" height="480" xmlns="http://www.w3.org/2000/svg"><rect width="640" height="480" fill="white"/>${digits}</svg>`)).png().toBuffer();
    const image = `data:image/png;base64,${png.toString("base64")}`;
    const prompt = "Read the four-digit number shown in this image. Answer with only those four digits.";
    for (const [model, api, stream] of [
      ["goldencode-d", "chat/completions", false], ["goldencode-d", "chat/completions", true],
      ["goldencode-d", "responses", false], ["goldencode-d", "responses", true],
      ["goldencode", "chat/completions", false]
    ]) {
      const effort = model === "goldencode-d" ? "max" : "high";
      const payload = api === "responses"
        ? { model, stream, reasoning: { effort }, max_output_tokens: 1024, input: [{ type: "message", role: "user", content: [
            { type: "input_text", text: prompt }, { type: "input_image", image_url: image }] }] }
        : { model, stream, reasoning_effort: effort, max_tokens: 1024, messages: [{ role: "user", content: [
            { type: "text", text: prompt }, { type: "image_url", image_url: { url: image } }] }] };
      const result = await call(api, payload, run + "_vision", "vision-" + model + "-" + api + "-" + stream, true);
      const item = report.checks.at(-1);
      item.synthetic_answer = result.text.slice(0, 80);
      item.content_matched = /7319/.test(result.text);
      item.passed = item.content_matched;
      persist();
    }
    const result = await call("chat/completions", { model: "goldencode-d", reasoning_effort: "max", max_tokens: 1024,
      messages: [{ role: "user", content: "Reply with only PREFLIGHT_OK" }] }, run + "_vision", "deepseek-text-after-vision");
    assert(result.text.includes("PREFLIGHT_OK"));
    assert.equal(report.checks.at(-1).reasoning_effort, "max");
    assert(report.checks.filter(item => item.label.startsWith("vision-")).every(item => item.content_matched),
      "Synthetic image answer mismatch");
  } else {
  for (const runtime of ["tencent", "tiankuan"]) {
    const first = await call("chat/completions", { model: "goldencode-d", reasoning_effort: "low", max_tokens: 1024,
      messages: [{ role: "user", content: prompt }], tools: [{ type: "function", function: tool }], tool_choice: "required" },
    sessionFor("goldencode-d", runtime), "native-tool-" + runtime);
    assert.equal(first.calls.length, 1); const tc = first.calls[0];
    assert.equal(tc.name, tool.name); assert.deepEqual(JSON.parse(tc.arguments), { value: "深度测试" });
    const nextRuntime = runtime === "tencent" ? "tiankuan" : "tencent";
    const second = await call("responses", { model: "goldencode-d", reasoning: { effort: "low" }, max_output_tokens: 1024,
      input: [{ type: "message", role: "user", content: prompt }, { type: "function_call", call_id: tc.id, name: tc.name, arguments: tc.arguments },
        { type: "function_call_output", call_id: tc.id, output: "PREFLIGHT_OK" }], tools: [{ type: "function", ...tool }], tool_choice: "auto" },
    sessionFor("goldencode-d", nextRuntime), "cross-provider-tool-result-" + nextRuntime);
    assert(second.text.includes("PREFLIGHT_OK"));
    for (const api of ["chat/completions", "responses"]) {
      const result = await call(api, api === "responses"
        ? { model: "goldencode-d", input: "Reply with only PREFLIGHT_OK", stream: true, reasoning: { effort: "max" }, max_output_tokens: 1024 }
        : { model: "goldencode-d", messages: [{ role: "user", content: "Reply with only PREFLIGHT_OK" }], stream: true, reasoning_effort: "high", max_tokens: 1024 },
      sessionFor("goldencode-d", runtime), "stream-" + runtime);
      assert(result.text.includes("PREFLIGHT_OK"));
    }
  }
  for (const runtime of ["tencent", "tiankuan", "tokenswitch"]) {
    const result = await call("chat/completions", { model: "goldencode", reasoning_effort: "low", max_tokens: 512,
      messages: [{ role: "user", content: "Reply with only PREFLIGHT_OK" }] }, sessionFor("goldencode", runtime), "glm-regression-" + runtime);
    assert(result.text.includes("PREFLIGHT_OK"));
  }
  const switchSession = run + "_switch", history = [{ role: "user", content: "Remember marker SWITCH_739. Reply with exactly SWITCH_739." }];
  for (const model of ["goldencode", "goldencode-d", "goldencode"]) {
    const result = await call("chat/completions", { model, reasoning_effort: "low", max_tokens: 512, messages: history }, switchSession, "same-session-switch");
    assert(result.text.includes("SWITCH_739")); history.push({ role: "assistant", content: result.text }, { role: "user", content: "Repeat the remembered marker only." });
  }
  }
} catch (error) {
  failure = { name: error.name, code: error.code ?? null, message: "Public smoke assertion or transport failed",
    stack_location: error.stack?.split("\n").find(line => line.includes("goldencode-d-public-smoke.mjs"))?.trim() };
} finally {
  assert(subject.startsWith("subj_deepseek_release_smoke_"));
  if (issued) store.revokeAccessCredentialByPrefix(issued.record.prefix);
  if (entitlement) store.cancelEntitlement({ id: entitlement.id, now: new Date(), reason: run + " cleanup" });
  if (store.getPlan(plan)) store.deprecatePlan(plan);
  if (store.getSubject(subject)) store.setSubjectState(subject, "disabled");
  let pending;
  for (let i = 0; i < 30; i++) { pending = db.prepare("SELECT count(*) n FROM token_reservations WHERE subject_id=? AND finalized_at IS NULL").get(subject).n; if (!pending) break; await sleep(1000); }
  const active = db.prepare("SELECT count(*) n FROM access_credentials WHERE subject_id=? AND revoked_at IS NULL").get(subject).n;
  let revokedStatus = null;
  if (issued) { const response = await fetch(origin + "/v1/models", { headers: headers(), signal: AbortSignal.timeout(5000) }); revokedStatus = response.status; await response.body?.cancel(); }
  report.cleanup = { subject_state: store.getSubject(subject)?.state, active_credentials: active, pending_reservations: pending,
    revoked_public_status: revokedStatus, plan_deprecated: store.getPlan(plan)?.state === "deprecated" };
  if (active || pending || revokedStatus !== 401 || report.cleanup.subject_state !== "disabled") failure ??= { message: "Cleanup verification failed" };
  store.close();
}
report.status = failure ? "failed" : "passed"; if (failure) report.failure = failure; persist();
console.log(JSON.stringify({ status: report.status, checks: report.checks.length, cleanup: report.cleanup, failure }));
if (failure) process.exitCode = 1;
