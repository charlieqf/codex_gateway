// Run: node --import tsx docs/outbox/r760-medcode-timeout-repro-2026-09-08.mjs
// Post-fix assertions; pre-fix results are retained in the investigation report.
// Synthetic streams only: no network requests, credentials, or production writes.
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// --runtime-root=/app loads the deployed JavaScript without tsx/dev dependencies.
// This also supports piping this script into `node --input-type=module -`.
const runtimeRoot = process.argv.find((arg) => arg.startsWith("--runtime-root="))?.slice("--runtime-root=".length);
const moduleUrl = (name) => runtimeRoot
  ? pathToFileURL(resolve(runtimeRoot, "apps/gateway/dist/services", `${name}.js`)).href
  : new URL(`../../apps/gateway/src/services/${name}.ts`, import.meta.url).href;
const { OpenAICompatibleProviderAdapter } = await import(moduleUrl("openai-compatible-provider"));
const { createChatRequestDeadline } = await import(moduleUrl("chat-request-deadline"));
const { ProviderStreamSummaryCollector } = await import(moduleUrl("provider-stream"));

async function runScenario(mode) {
  const started = performance.now();
  const wire = { frames: 0, bytes: 0, firstMs: null, lastMs: null };
  const events = [];
  const timers = new Set();
  let removeAbort = () => {};
  const now = () => Math.round(performance.now() - started);
  const deadline = createChatRequestDeadline({ timeoutMs: 350 });
  const collector = new ProviderStreamSummaryCollector();
  const adapter = new OpenAICompatibleProviderAdapter({
    providerKind: "tencent",
    apiKey: "",
    apiKeyEnv: "SYNTHETIC_UNUSED",
    apiKeyRequired: false,
    baseUrl: "https://synthetic.invalid/v1",
    upstreamModel: "synthetic",
    timeoutMs: 2_000,
    reasoningParameterStyle: "effort_field",
    fetchImpl: async (_url, init) => {
      const encoder = new TextEncoder();
      const body = new ReadableStream({
        start(controller) {
          let ended = false;
          const stop = () => {
            ended = true;
            for (const timer of timers) clearInterval(timer);
            timers.clear();
          };
          const abort = () => {
            if (ended) return;
            stop();
            controller.error(init.signal.reason);
          };
          init.signal.addEventListener("abort", abort, { once: true });
          removeAbort = () => init.signal.removeEventListener("abort", abort);
          const emit = (data) => {
            const encoded = encoder.encode(`data: ${JSON.stringify(data)}\n\n`);
            wire.frames += 1;
            wire.bytes += encoded.byteLength;
            wire.firstMs ??= now();
            wire.lastMs = now();
            controller.enqueue(encoded);
          };
          let step = 0;
          const timer = setInterval(() => {
            if (ended) return;
            step += 1;
            if (step === 1) {
              emit({ choices: [{ delta: { reasoning_content: "synthetic reasoning" } }] });
            } else if (step === 2) {
              emit({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_synthetic", function: { name: "write", arguments: '{"content":"' } }] } }] });
            } else if (mode === "completed" && step === 5) {
              emit({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"}' } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } });
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              stop();
              controller.close();
            } else if (mode === "body_timeout" && step === 5) {
              stop();
              const cause = Object.assign(new Error("Synthetic body timeout"), { code: "UND_ERR_BODY_TIMEOUT" });
              controller.error(new TypeError("terminated", { cause }));
            } else {
              emit({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "synthetic fragment " } }] } }] });
            }
          }, 25);
          timers.add(timer);
        }
      });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream", "x-request-id": "synthetic-upstream-id" } });
    }
  });
  try {
    for await (const event of adapter.message({
      message: "Synthetic diagnostic task",
      scope: "code",
      signal: deadline.signal,
      reasoningEffort: "high",
      maximumOutputTokens: 64000,
      clientTools: [{ type: "function", function: { name: "write", parameters: { type: "object", properties: { content: { type: "string" } } } } }],
      clientToolChoice: "auto"
    })) {
      collector.record(event);
      events.push({ type: event.type, atMs: now(), code: event.code ?? null, hasResponseSummary: Boolean(event.responseSummary) });
    }
  } finally {
    deadline.cleanup();
    removeAbort();
    for (const timer of timers) clearInterval(timer);
  }
  const summary = collector.snapshot();
  const result = { mode, wire, events, summary: Object.fromEntries(Object.entries(summary).filter(([key]) => ["errorCode", "failure", "contentChars", "semanticOutputChars", "toolCallCount", "upstreamHttpStatus", "upstreamRequestId", "rawResponseChars", "maxToolArgumentBytes", "terminationKind", "streamIncomplete", "streamProgress"].includes(key))) };
  assert.ok(wire.frames >= 3);
  assert.equal(summary.upstreamHttpStatus, 200);
  assert.equal(summary.upstreamRequestId, "synthetic-upstream-id");
  assert.equal(summary.streamProgress.observedToolCallCount, 1);
  assert.ok(summary.streamProgress.toolArgumentBytes > 0);
  assert.ok(summary.streamProgress.reasoningChars > 0);
  assert.equal(summary.streamProgress.sseDataEvents, wire.frames);
  assert.equal(summary.streamProgress.responseBytes, wire.bytes + (mode === "completed" ? Buffer.byteLength("data: [DONE]\n\n") : 0));
  if (mode === "completed") {
    assert.equal(summary.toolCallCount, 1);
    assert.equal(summary.upstreamHttpStatus, 200);
    assert.equal(summary.upstreamRequestId, "synthetic-upstream-id");
    assert.equal(events[0].type, "tool_call");
    assert.ok(events[0].atMs >= wire.lastMs);
  } else {
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "error");
    assert.equal(summary.toolCallCount, 0);
    assert.equal(events[0].hasResponseSummary, true);
    assert.equal(summary.terminationKind, "error");
    if (mode === "deadline") {
      assert.equal(summary.errorCode, "upstream_timeout");
      assert.equal(summary.failure.kind, "deadline_exceeded");
      assert.ok(summary.rawResponseChars > 67);
    } else {
      assert.equal(summary.errorCode, "upstream_timeout");
      assert.equal(summary.failure.transportCode, "UND_ERR_BODY_TIMEOUT");
      assert.equal(summary.failure.kind, "body_timeout");
    }
  }
  return result;
}

const results = [];
for (const mode of ["deadline", "completed", "body_timeout"]) results.push(await runScenario(mode));
console.log(JSON.stringify({ synthetic: true, assertions: "passed", results }, null, 2));
