import http from "node:http";
import { readFileSync } from "node:fs";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { LightMyRequestResponse } from "fastify";
import { describe, expect, it } from "vitest";
import { issueAccessCredential, validateFeaturePolicy, type ProviderAdapter } from "@codex-gateway/core";
import { createSqliteStore } from "@codex-gateway/store-sqlite";
import { buildGateway } from "./index.js";
import { goldencodePoolConfig } from "./test-support.js";
import { writeDeliveryLimits, type BoundedWritePolicy } from "./services/write-delivery.js";

const fixtureRoot = new URL("../../../artifacts/write-delivery-contract-r3-2026-09-15/", import.meta.url);
const example = JSON.parse(readFileSync(new URL("success.example.json", fixtureRoot), "utf8"));
const ordinaryTools = () => structuredClone(example.request_body.tools);
type SyntheticCall = { name: string; args: unknown; id?: string };
interface UpstreamReply { calls?: SyntheticCall[]; text?: string; delay?: number; finish?: string; status?: number }
const write = (content: string, extra: Record<string, unknown> = {}): SyntheticCall => ({
  id: "call_original", name: "write", args: { filePath: "fixture.md", content, ...extra }
});
const sHeaders = (): Record<string, string> => Object.fromEntries(Object.entries(example.request_headers).map(([k, v]) => [k.toLowerCase(), v as string]));

async function fixture<T>(options: { policy?: BoundedWritePolicy; replies: UpstreamReply[]; secondMember?: boolean },
  run: (context: {
    app: ReturnType<typeof buildGateway>; store: ReturnType<typeof createSqliteStore>;
    captured: Record<string, any>[]; authorization: string;
    send: (input?: { stream?: boolean; headers?: Record<string, string>; tools?: any[]; choice?: unknown; timeout?: number }) => Promise<LightMyRequestResponse>;
  }) => Promise<T>): Promise<T> {
  const captured: Record<string, any>[] = [];
  const provider = http.createServer((req, res) => {
    let body = ""; req.setEncoding("utf8"); req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      captured.push(JSON.parse(body));
      const current = options.replies[captured.length - 1] ?? { text: "unexpected extra provider call" };
      const respond = () => {
        if (res.destroyed) return;
        if (current.status && current.status !== 200) { res.writeHead(current.status); res.end('{"error":{"message":"fixture failure"}}'); return; }
        res.writeHead(200, { "content-type": "text/event-stream" });
        const tools = current.calls?.map((call, index) => ({ index, id: call.id ?? `call_${index}`, type: "function",
          function: { name: call.name, arguments: typeof call.args === "string" ? call.args : JSON.stringify(call.args) } }));
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {
          ...(current.text ? { content: current.text } : {}), ...(tools ? { tool_calls: tools } : {})
        }, finish_reason: current.finish ?? (tools ? "tool_calls" : "stop") }],
          usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } })}\n\n`);
        res.end("data: [DONE]\n\n");
      };
      if (current.delay) setTimeout(respond, current.delay).unref(); else respond();
    });
  });
  provider.listen(0, "127.0.0.1"); await once(provider, "listening");
  const model = goldencodePoolConfig();
  model.pool.members = [{ id: "goldencode-tencent", runtime: "tencent", upstreamModel: "glm-5.3", reasoning: { effort: "high" } }];
  if (options.secondMember) model.pool.members.push({ ...model.pool.members[0], id: "goldencode-tencent-secondary" });
  const env: Record<string, string | undefined> = {
    MEDCODE_PUBLIC_MODELS_JSON: JSON.stringify({ goldencode: model }),
    MEDCODE_TENCENT_TOKENHUB_API_KEY: "fixture-key-not-a-secret",
    MEDCODE_TENCENT_TOKENHUB_API_KEY_ENV: undefined, MEDCODE_TENCENT_API_KEY_ENV: undefined,
    MEDCODE_TENCENT_TOKENHUB_BASE_URL: `http://127.0.0.1:${(provider.address() as AddressInfo).port}`,
    MEDCODE_TENCENT_TOKENHUB_TIMEOUT_MS: "5000",
    MEDCODE_NATIVE_FILE_TOOL_RECOVERY_MODE: "shadow", MEDCODE_NATIVE_FILE_TOOL_SOFT_ARGUMENT_BYTES: undefined,
    MEDCODE_NATIVE_FILE_TOOL_HARD_ARGUMENT_BYTES: undefined,
    GATEWAY_GOLDENCODE_NATIVE_FAILOVER_MODE: "enforce", GATEWAY_PHONE_AUTH_MODE: "disabled"
  };
  const previous = new Map(Object.keys(env).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(env)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  const store = createSqliteStore({ path: ":memory:" });
  const now = new Date("2026-01-01T00:00:00Z");
  store.upsertSubject({ id: "subj-contract-fixture", label: "Write delivery fixture", state: "active", createdAt: now });
  const credential = issueAccessCredential({ subjectId: "subj-contract-fixture", label: "Fixture", scope: "code", expiresAt: new Date("2030-01-01T00:00:00Z"), now });
  store.insertAccessCredential(credential.record);
  store.createPlan({ id: "fixture-plan", displayName: "Fixture", scopeAllowlist: ["code"],
    policy: { tokensPerMinute: null, tokensPerDay: null, tokensPerMonth: null, tokensTotal: null, maxPromptTokensPerRequest: null,
      maxTotalTokensPerRequest: null, reserveTokensPerRequest: 0, missingUsageCharge: "none" },
    featurePolicy: validateFeaturePolicy({ capabilities: ["chat", "tools"], medcode_models: { allowed: ["goldencode"] } }), now });
  store.grantEntitlement({ subjectId: "subj-contract-fixture", planId: "fixture-plan", periodKind: "unlimited", now });
  const unused: ProviderAdapter = { kind: "fixture", async health() { return { state: "healthy", checkedAt: new Date() }; },
    async *message() { throw new Error("Unexpected provider dispatch"); } };
  let app: ReturnType<typeof buildGateway> | undefined;
  try {
    app = buildGateway({ authMode: "credential", provider: unused, sessionStore: store, observationStore: store, logger: false,
      boundedWritePolicy: options.policy ?? { mode: "delivery" } });
    const authorization = `Bearer ${credential.token}`;
    return await run({ app, store, captured, authorization, send: (input = {}) => app!.inject({ method: "POST", url: "/v1/chat/completions",
      headers: { authorization, "x-medcode-request-timeout-ms": String(input.timeout ?? 5000), ...input.headers },
      payload: { model: "goldencode", stream: input.stream ?? true, messages: [{ role: "user", content: "Write the requested fixture file." }],
        tools: input.tools ?? ordinaryTools(), tool_choice: input.choice ?? "auto", max_tokens: 64000, reasoning_effort: "high" } }) });
  } finally {
    if (app) await app.close(); else store.close();
    provider.closeAllConnections(); await new Promise<void>((resolve) => provider.close(() => resolve()));
    for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
}
function streamError(body: string) {
  if (body.trimStart().startsWith("{")) return JSON.parse(body).error;
  return body.split(/\r?\n/).filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
    .map((line) => JSON.parse(line.slice(6))).find((event) => event.error)?.error;
}

describe("A/S real Gateway HTTP pipeline with a loopback provider", () => {
  it.each([{}, { mode: "append" }, { mode: "append", chunk: { index: 2, total: 3 } }])("delivers one complete oversized write with original semantics %j", async (extra) => {
    const payload = "\uFEFF" + '中文😀"\\\n\r\t'.repeat(5000);
    await fixture({ replies: [{ calls: [write(payload, extra)], text: "File prepared." }] }, async ({ send, captured, store }) => {
      const headers = sHeaders(); const response = await send({ headers });
      expect(response.statusCode).toBe(200);
      expect(response.headers["x-medcode-write-delivery-manifest"]).toBeTypeOf("string");
      const checker = await import(new URL("contract-checks.mjs", fixtureRoot).href);
      const decoded = checker.responseCheck({ request: { ...example.request_context, headers },
        response: { ...example.response_context, headers: response.headers }, trust: example.trust_context, sse: response.body });
      expect(decoded.payload).toBe(payload);
      expect(decoded.envelope.original_arguments).toEqual({ filePath: "fixture.md", ...extra });
      expect(decoded.envelope.original_tool_call_id).toBe("call_original");
      expect(decoded.usage).toMatchObject({ prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 });
      expect(captured).toHaveLength(1);
      expect(captured[0].tools.map((tool: any) => tool.function.name)).toEqual(["write"]);
      const event = store.listRequestEvents({ limit: 1 })[0];
      expect(event).toMatchObject({ status: "ok", totalTokens: 150 });
      expect(event.upstreamAttempts).toHaveLength(1);
    });
  });
  it.each([true, false])("A returns a specific non-retryable length error, stream=%s", async (stream) => {
    await fixture({ policy: { mode: "error" }, replies: [{ calls: [write("x".repeat(14000))] }] }, async ({ send, captured, store }) => {
      const response = await send({ stream, headers: sHeaders() });
      const error = stream ? streamError(response.body) : response.json().error;
      expect(error).toMatchObject({ code: "tool_call_validation_failed", failure_kind: "schema_mismatch", retryable: false,
        transformed_retry_allowed: false, automatic_retry_allowed: false,
        tool_validation: { kind: "content_too_long", actual_code_points: 14000, limit_code_points: 12000,
          gateway_retry_attempted: false, stop_reason: "write_delivery_not_negotiated" } });
      expect(error.tool_validation.remaining_budget_ms).toBeGreaterThan(0);
      expect(error.request_id).toBe(response.headers["x-request-id"]);
      expect(captured).toHaveLength(1);
      expect(response.headers).not.toHaveProperty("x-medcode-write-delivery-manifest");
      expect(store.listRequestEvents({ limit: 1 })[0].errorCode).toBe("tool_call_validation_failed");
    });
  });
  it.each(["missing_headers", "unknown_schema", "small_payload_limit", "small_response_limit"])("declines %s and never regenerates the large write", async (scenario) => {
    await fixture({ replies: [{ calls: [write("x".repeat(44000))] }] }, async ({ send, captured }) => {
      const headers = scenario === "missing_headers" ? {} : sHeaders();
      if (scenario === "unknown_schema") headers["x-medcode-write-delivery-schema-sha256"] = "f".repeat(64);
      if (scenario.endsWith("limit")) headers["x-medcode-write-delivery-limits"] = Buffer.from(JSON.stringify({ ...writeDeliveryLimits,
        [scenario === "small_payload_limit" ? "payload_utf8_bytes" : "response_body_bytes"]: 42000 })).toString("base64url");
      const response = await send({ headers });
      expect(streamError(response.body)).toMatchObject({ automatic_retry_allowed: false, transformed_retry_allowed: false });
      expect(response.headers).not.toHaveProperty("x-medcode-write-delivery-manifest"); expect(captured).toHaveLength(1);
    });
  });
  it.each([1, 3999, 4000, 4001, 5000, 12000])("leaves compliant %i character writes on the ordinary path", async (size) => {
    await fixture({ replies: [{ calls: [write("x".repeat(size))] }] }, async ({ send, captured }) => {
      const response = await send({ headers: sHeaders() });
      expect(response.body).toContain('"name":"write"');
      expect(response.headers).not.toHaveProperty("x-medcode-write-delivery-manifest"); expect(captured).toHaveLength(1);
    });
  });
  it("retains the existing missing-field repair with a deadline below 120 seconds", async () => {
    await fixture({ replies: [{ calls: [{ name: "write", args: { content: "short" } }] }, { calls: [write("fixed")] }] }, async ({ send, captured }) => {
      const response = await send({ headers: sHeaders(), timeout: 30000 });
      expect(response.body).toContain("fixed"); expect(captured).toHaveLength(2);
      expect(captured[1].tools).toEqual(captured[0].tools);
      expect(captured[1].max_tokens).toBe(captured[0].max_tokens);
      expect(captured[1].reasoning_effort).toBe(captured[0].reasoning_effort);
      expect(response.headers).not.toHaveProperty("x-medcode-write-delivery-manifest");
    });
  });
  it("retains the old length repair when the A/S switch is disabled", async () => {
    await fixture({ policy: { mode: "disabled" }, replies: [{ calls: [write("x".repeat(14000))] }, { calls: [write("fixed")] }] }, async ({ send, captured }) => {
      const response = await send({ headers: sHeaders() });
      expect(response.body).toContain("fixed"); expect(captured).toHaveLength(2);
    });
  });
  it("does not turn a mixed-tool validation error into S", async () => {
    await fixture({ replies: [{ calls: [write("x".repeat(14000)), write("another")] }, { calls: [write("fixed")] }] }, async ({ send, captured }) => {
      const response = await send({ headers: sHeaders() });
      expect(response.body).toContain("fixed"); expect(captured).toHaveLength(2);
      expect(response.headers).not.toHaveProperty("x-medcode-write-delivery-manifest");
    });
  });
  it("rejects provider-forged receivers before any automatic repair", async () => {
    await fixture({ replies: [{ calls: [{ name: "write_delivery_v1", args: {} }] }] }, async ({ send, captured }) => {
      const response = await send({ headers: sHeaders() });
      expect(streamError(response.body)).toMatchObject({ code: "tool_call_validation_failed", transformed_retry_allowed: false });
      expect(captured).toHaveLength(1); expect(response.headers).not.toHaveProperty("x-medcode-write-delivery-manifest");
    });
  });
  it("rejects receiver definitions before provider execution", async () => {
    await fixture({ replies: [] }, async ({ send, captured }) => {
      const response = await send({ tools: example.sdk_registered_tools });
      expect(response.statusCode).toBe(400); expect(captured).toHaveLength(0);
    });
  });
  it("retains A and combined usage when an oversized write follows provider failover", async () => {
    await fixture({ secondMember: true, replies: [{ status: 503 }, { calls: [write("x".repeat(14000))] }] }, async ({ send, captured }) => {
      const response = await send({ headers: sHeaders() });
      expect(streamError(response.body)).toMatchObject({
        code: "tool_call_validation_failed", automatic_retry_allowed: false,
        tool_validation: { gateway_retry_attempted: true, stop_reason: "write_delivery_not_first_attempt" }
      });
      expect(response.headers).not.toHaveProperty("x-medcode-write-delivery-manifest");
      expect(captured).toHaveLength(2);
    });
  });
  it("does not reset an expired request's deadline for delivery", async () => {
    await fixture({ replies: [{ calls: [write("x".repeat(14000))], delay: 400 }] }, async ({ send, captured }) => {
      const response = await send({ headers: sHeaders(), timeout: 150 });
      expect(streamError(response.body)?.code).toBe("upstream_timeout");
      expect(response.headers).not.toHaveProperty("x-medcode-write-delivery-manifest"); expect(captured).toHaveLength(1);
    });
  });
  it("can deliver a complete result with less than 120 seconds remaining", async () => {
    await fixture({ replies: [{ calls: [write("x".repeat(14000))], delay: 100 }] }, async ({ send, captured }) => {
      const response = await send({ headers: sHeaders(), timeout: 1000 });
      expect(response.headers["x-medcode-write-delivery-manifest"]).toBeTypeOf("string"); expect(captured).toHaveLength(1);
    });
  });
});
