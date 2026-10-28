// Run from the release root, with provider credentials supplied privately.
// All Gateway state is in memory. Makes four bounded real provider calls
// (or two symmetric Responses controls with --responses-control);
// does not change the live configuration, open production databases or listen.
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isolatedProviderEnv, smokeImage, smokePayload, smokeText } from "./vision-smoke-helpers.mjs";

const registry = JSON.parse(process.env.MEDCODE_PUBLIC_MODELS_JSON || "{}");
assert.ok(!process.env.MEDCODE_PUBLIC_MODELS_JSON_FILE, "A file-backed registry needs separate preflight preparation");
assert.equal(registry.goldencode?.vision?.runtime, "xai");
assert.notEqual(registry.goldencode.vision.enabled, false);
assert.ok(registry["goldencode-d"]);
assert.notEqual(registry["goldencode-d"].enabled, false);
// The caller must supply the exact prepared candidate via --env-file. Never
// reconstruct or modify the registry here; deployment compares these same bytes.
assert.deepEqual(registry["goldencode-d"].vision, registry.goldencode.vision,
  "Supply the prepared candidate environment with matching cloud vision routes");
// Do not inherit database paths, snapshots, side services or background jobs.
const providerEnv = isolatedProviderEnv(process.env);
for (const name of Object.keys(process.env)) delete process.env[name];
Object.assign(process.env, providerEnv);
process.env.MEDCODE_PUBLIC_MODELS_JSON = JSON.stringify(registry);
process.env.MEDCODE_PUBLIC_MODEL_ID = "goldencode";
process.env.MEDCODE_VISION_XAI_TIMEOUT_MS = "60000";
const { buildGateway } = await import(pathToFileURL(path.resolve("apps/gateway/dist/index.js")));
const { issueAccessCredential, validateFeaturePolicy } = await import("@codex-gateway/core");
const { createSqliteStore, createSqliteTokenBudgetLimiter } = await import("@codex-gateway/store-sqlite");
const store = createSqliteStore({ path: ":memory:" });
const now = new Date();
const subject = "deepseek-vision-preflight";
store.upsertSubject({ id: subject, label: "In-memory vision preflight", state: "active", createdAt: now });
const key = issueAccessCredential({ subjectId: subject, label: "In-memory only", scope: "code", now,
  expiresAt: new Date(now.getTime() + 600000) });
store.insertAccessCredential(key.record);
store.createPlan({ id: "preflight", displayName: "In-memory only", scopeAllowlist: ["code"], now,
  policy: { tokensPerMinute: null, tokensPerDay: null, tokensPerMonth: null, tokensTotal: null,
    maxPromptTokensPerRequest: null, maxTotalTokensPerRequest: null, reserveTokensPerRequest: 0, missingUsageCharge: "none" },
  featurePolicy: validateFeaturePolicy({ capabilities: ["chat", "tools"] }) });
store.grantEntitlement({ subjectId: subject, planId: "preflight", periodKind: "unlimited", now });
const provider = { kind: "codex", health: async () => ({ state: "healthy", checkedAt: now }),
  async *message() { throw new Error("Unexpected default provider"); } };
const app = buildGateway({ authMode: "credential", logger: false, provider,
  sessionStore: store, observationStore: store,
  tokenBudgetLimiter: createSqliteTokenBudgetLimiter({ db: store.database }),
  clientEventsStore: null, phoneAuthService: null, visionAssetService: null,
  imagingService: null, aipalService: null, panechoService: null, echonetService: null,
  echonextService: null, alphafold3Service: null });
const image = await smokeImage();
let routingPassed = 0;
const contentChecks = [];
const failures = [];
const checks = process.argv.includes("--responses-control") ? [
  ["goldencode-d", "responses", true, true],
  ["goldencode", "responses", true, true]
] : [
  ["goldencode-d", "chat/completions", true, false],
  ["goldencode-d", "responses", true, true],
  ["goldencode", "chat/completions", true, false],
  ["goldencode-d", "chat/completions", false, false]
];
try {
  for (const [model, api, vision, stream] of checks) {
    try {
      const effort = "max";
      const payload = smokePayload({ model, api, vision, stream, effort }, image);
      const response = await app.inject({ method: "POST", url: `/v1/${api}`, payload,
        headers: { authorization: `Bearer ${key.token}`, "x-medcode-client-session-id": "vision-preflight",
          "x-medcode-request-timeout-ms": "60000" } });
      const event = store.listRequestEvents({ limit: 1 })[0];
      console.log(JSON.stringify({ model, api, vision, stream, http: response.statusCode,
        request_id: response.headers["x-request-id"], status: event?.status, error_code: event?.errorCode,
        provider: event?.provider, upstream_model: event?.upstreamModel, tokens: event?.totalTokens }));
      assert.equal(response.statusCode, 200, "Provider HTTP failure");
      assert.equal(event?.status, "ok");
      assert.equal(event?.publicModelId, model);
      assert.equal(event?.requestedReasoningEffort, effort);
      assert.equal(event?.effectiveReasoningEffort, vision ? "high" : effort);
      if (vision) assert.equal(event?.provider, "xai");
      else assert.match(event?.upstreamModel ?? "", /deepseek/i);
      const frames = stream ? response.body.split("\n").filter(line => line.startsWith("data: ") && line !== "data: [DONE]")
        .map(line => JSON.parse(line.slice(6))) : [response.json()];
      assert.ok(!frames.some(frame => frame.error || frame.type === "response.failed"));
      const text = smokeText(api, stream, frames);
      const contentMatched = (vision ? /7319/ : /TEXT_OK/).test(text ?? "");
      contentChecks.push(contentMatched);
      console.log(JSON.stringify({ model, api, content_matched: contentMatched,
        synthetic_answer: (text ?? "").slice(0, 80), probe_timeout_ms: 60000 }));
      const ledger = store.database.prepare("SELECT final_total_tokens, finalized_at FROM token_reservations WHERE request_id=?")
        .get(event.requestId);
      assert.ok(ledger?.finalized_at);
      assert.equal(ledger.final_total_tokens, event.totalTokens);
      routingPassed++;
    } catch (error) {
      const failure = { model, api, vision, stream, error: error.code ?? error.name,
        location: error.stack?.split("\n").find(line => line.includes("deepseek-vision-preflight.mjs:"))?.trim() };
      failures.push(failure);
      console.log(JSON.stringify({ ...failure, passed: false }));
    }
  }
  assert.equal(store.database.prepare("SELECT count(*) AS n FROM token_reservations WHERE finalized_at IS NULL").get().n, 0);
  console.log(JSON.stringify({ routing_passed: routingPassed,
    content_passed: contentChecks.filter(Boolean).length, expected_checks: checks.length,
    failures, production_config_changed: false, state: "in-memory" }));
  assert.equal(failures.length, 0, "One or more provider checks failed");
  assert.ok(contentChecks.every(Boolean), "One or more synthetic answers did not match; routing success alone is not content verification");
} finally { await app.close(); }
