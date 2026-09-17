// Authorized R760 release smoke. Credentials remain in a private mode-0600 volume file.
// This verifies Gateway transport, not the Desktop file transaction or journal.
import assert from "node:assert/strict";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const origin = "https://goldencode.instmarket.com.au:1443";
const clientVersion = process.env.MEDEVIDENCE_SMOKE_CLIENT_VERSION ?? "2.0.0-beta.76";
const fixturePath = "/var/lib/codex-gateway/bounded-write-smoke-20260915.json";
const command = process.env.BOUNDED_WRITE_SMOKE_COMMAND ?? "smoke";
const admin = process.env.GATEWAY_BILLING_ADMIN_TOKEN;
const provider = process.env.GATEWAY_BILLING_IDENTITY_PROVIDER;
assert.ok(admin && provider, "Billing configuration required");
const report = { checked_at: new Date().toISOString(), command, checks: [] };
let fixture = existsSync(fixturePath) ? JSON.parse(readFileSync(fixturePath, "utf8")) : null;
const save = () => writeFileSync(fixturePath, JSON.stringify(fixture), { mode: 0o600 });
async function api(path, { token = admin, body, method = body ? "POST" : "GET", status = 200, event } = {}) {
  const response = await fetch(origin + path, { method, redirect: "error", headers: {
    authorization: `Bearer ${token}`, "content-type": "application/json", "x-medevidence-client-version": clientVersion,
    ...(event ? { "idempotency-key": event } : {})
  }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(45000) });
  const json = response.status === 204 ? {} : await response.json();
  report.checks.push({ path, status: response.status, request_id: response.headers.get("x-request-id") });
  assert.ok(response.status === status, `Unexpected HTTP status for ${path}: ${response.status}`);
  return json;
}
function readonly() {
  const db = new DatabaseSync(process.env.GATEWAY_SQLITE_PATH, { readOnly: true });
  db.exec("PRAGMA query_only=ON"); return db;
}
try {
  if (command === "prepare") {
    assert.ok(!fixture, "A smoke account already exists; resume or clean it first");
    fixture = { run: `bounded_write_smoke_${Date.now()}` }; save();
    const created = await api("/gateway/admin/billing/v1/subjects", { event: `${fixture.run}:create`, body: {
      provider, external_user_id: fixture.run, scope_allowlist: ["code"]
    } });
    fixture.subjectId = created.subject.id; fixture.key = created.credential.key; save();
    const start = new Date(Date.now() - 60000);
    await api("/gateway/admin/billing/v1/entitlement-events", { event: `${fixture.run}:purchase`, body: {
      event_type: "purchase", apply_mode: "apply", provider, external_order_id: `${fixture.run}:order`,
      external_event_id: `${fixture.run}:purchase`, subject_id: fixture.subjectId, plan_id: "plan_paid_monthly_v1",
      period_kind: "monthly", period_start: start.toISOString(), period_end: new Date(start.getTime() + 30 * 86400000).toISOString()
    } });
    const resolved = await api("/gateway/unified-keys/resolve", { token: fixture.key, body: {} });
    fixture.apiKey = resolved.codex_gateway.api_key; save();
    report.subject_id = fixture.subjectId;
  } else if (command === "cleanup") {
    assert.ok(fixture, "No smoke account to clean");
    const db = readonly();
    try {
      fixture.subjectId ??= db.prepare("SELECT id FROM subjects WHERE external_provider=? AND external_user_id=?").get(provider, fixture.run)?.id;
      if (fixture.subjectId) {
        await api(`/gateway/admin/billing/v1/subjects/${fixture.subjectId}/disable`, { event: `${fixture.run}:disable`, body: { reason: "bounded_write_release_smoke_cleanup" } });
        const active = db.prepare("SELECT COUNT(*) n FROM access_credentials WHERE subject_id=? AND revoked_at IS NULL").get(fixture.subjectId).n;
        const pending = db.prepare("SELECT COUNT(*) n FROM token_reservations WHERE subject_id=? AND finalized_at IS NULL").get(fixture.subjectId).n;
        assert.ok(active === 0 && pending === 0, "Smoke credential/reservation cleanup incomplete");
        report.cleanup = [{ subject_id: fixture.subjectId, disabled: true, active_credentials: active, unfinished_reservations: pending }];
      }
      unlinkSync(fixturePath);
    } finally { db.close(); }
  } else {
    assert.ok(command === "smoke" && fixture?.apiKey, "Prepared smoke account required");
    assert.ok(process.env.GATEWAY_BOUNDED_WRITE_MODE === "delivery" &&
      process.env.GATEWAY_BOUNDED_WRITE_SUBJECT_IDS === fixture.subjectId, "Expected single-account A/S canary configuration");
    const { responseCheck } = await import("/app/artifacts/write-delivery-contract-r3-2026-09-15/contract-checks.mjs");
    const example = JSON.parse(readFileSync("/app/artifacts/write-delivery-contract-r3-2026-09-15/success.example.json", "utf8"));
    const allCases = ["ordinary", "S_overwrite", "S_append", "A_legacy", "A_unknown_schema"];
    const selectedCases = process.env.BOUNDED_WRITE_SMOKE_CASES?.split(",");
    assert.ok(!selectedCases || selectedCases.every(value => allCases.includes(value)), "Unknown smoke case");
    if (!selectedCases) {
    assert.equal((await api("/gateway/health")).state, "ready");
    const models = await api("/v1/models", { token: fixture.apiKey });
    assert.ok(models.data.some(model => model.id === "goldencode"), "GoldenCode model missing");
    await api("/gateway/credentials/current", { token: fixture.apiKey });
    await api("/gateway/vision/capabilities", { token: fixture.apiKey });
    await api("/gateway/images/generations", { token: fixture.apiKey, status: 400, body: { model: "medcode-image-default", prompt: "" } });
    const answer = await api("/v1/chat/completions", { token: fixture.apiKey, body: {
      model: "goldencode", messages: [{ role: "user", content: "Reply only OK." }], max_tokens: 256, stream: false
    } });
    assert.ok(answer.choices?.[0]?.message?.content?.length, "Short answer missing");
    const responses = await api("/v1/responses", { token: fixture.apiKey, body: {
      model: "goldencode", input: "Reply only OK.", max_output_tokens: 256, stream: false
    } });
    assert.equal(responses.status, "completed");
    }
    const payload = Array.from({ length: 20 }, (_, i) => `Smoke row ${i + 1}: Unicode 中文 😀 and an ordinary text file.\n`).join("");
    report.deliveries = [];
    for (const kind of selectedCases ?? allCases) {
      const turn = randomUUID(), session = `ses-${fixture.run}`;
      const ordinary = kind === "ordinary";
      const content = ordinary ? "hello smoke" : payload;
      const schema = { type: "object", additionalProperties: false, required: ["filePath", "content"], properties: {
        filePath: { type: "string" }, content: { type: "string", maxLength: ordinary ? 12000 : 512 }
      } };
      if (kind === "S_append") { schema.properties.mode = { enum: ["append"] }; schema.required.push("mode"); }
      const headers = { ...example.request_headers,
        "X-MedCode-Write-Delivery-Nonce": randomBytes(24).toString("base64url"),
        "X-MedCode-Client-Session-Id": session, "X-MedCode-Client-Turn-Id": turn,
        "X-MedCode-Write-Delivery-Limits": Buffer.from(JSON.stringify({ ...example.limits, chunk_utf16_units: 128 })).toString("base64url")
      };
      if (kind === "A_legacy") for (const key of Object.keys(headers)) if (key.includes("Write-Delivery") || key.includes("Capabilities")) delete headers[key];
      if (kind === "A_unknown_schema") headers["X-MedCode-Write-Delivery-Schema-SHA256"] = "0".repeat(64);
      const body = { model: "goldencode", stream: true, max_tokens: 4096,
        tools: [{ type: "function", function: { name: "write", description: "Write supplied text verbatim to a file.", parameters: schema } }],
        tool_choice: { type: "function", function: { name: "write" } },
        messages: [
          { role: "system", content: "Use the write tool as your first and only response. Return a tool call without explanatory text. Preserve the supplied content exactly; the caller handles size validation." },
          { role: "user", content: `Call write exactly once for smoke.txt. Copy the entire text below into content without summaries or omissions. ${kind === "S_append" ? 'Set mode to append.' : 'Use only filePath and content.'}\n<text>\n${content}</text>` }
        ]
      };
      const started = performance.now();
      const response = await fetch(origin + "/v1/chat/completions", { method: "POST", redirect: "error", headers: {
        ...headers, authorization: `Bearer ${fixture.apiKey}`, "content-type": "application/json"
      }, body: JSON.stringify(body), signal: AbortSignal.timeout(180000) });
      const wire = await response.text();
      const record = { kind, status: response.status, request_id: response.headers.get("x-request-id"), elapsed_ms: Math.round(performance.now() - started), response_bytes: Buffer.byteLength(wire) };
      report.deliveries.push(record);
      if (kind.startsWith("S_")) {
        const checked = responseCheck({ request: { url: origin + "/v1/chat/completions", subject_id: fixture.subjectId, headers },
          response: { url: response.url, status: response.status, headers: Object.fromEntries(response.headers) },
          trust: { origin, subject_id: fixture.subjectId, client_session_id: session, client_turn_id: turn }, sse: wire });
        assert.ok(checked.kind === "delivery", "Expected a verified S delivery");
        const envelope = checked.envelope;
        assert.ok(envelope.chunks.length > 1, "Expected multiple transport chunks");
        const text = envelope.chunks.map(chunk => chunk.content).join("");
        record.payload_bytes = Buffer.byteLength(text); record.payload_sha256 = createHash("sha256").update(text).digest("hex");
        record.chunk_count = envelope.chunks.length; record.delivery_id = envelope.delivery_id;
        record.source_text_equal = text.trimEnd() === content.trimEnd();
        assert.ok(record.source_text_equal, "Model did not preserve the supplied smoke text");
        assert.equal(envelope.original_arguments.mode, kind === "S_append" ? "append" : undefined);
        record.usage = checked.usage;
      } else if (ordinary) {
        assert.equal(response.status, 200); assert.ok(!response.headers.has("x-medcode-write-delivery-manifest"));
        assert.ok(wire.includes('"name":"write"') && wire.includes("hello smoke"), "Ordinary write missing");
      } else {
        const error = wire.trimStart().startsWith("{") ? JSON.parse(wire).error : wire.split(/\r?\n/).filter(line => line.startsWith("data: ") && !line.includes("[DONE]")).map(line => JSON.parse(line.slice(6))).find(item => item.error)?.error;
        assert.ok(error?.tool_validation?.kind === "content_too_long", "Expected explicit A content length error");
        assert.equal(error.automatic_retry_allowed, false); assert.equal(error.transformed_retry_allowed, false);
        assert.equal(error.tool_validation.gateway_retry_attempted, false);
        record.error_code = error.code; record.validation = error.tool_validation;
        assert.ok(!response.headers.has("x-medcode-write-delivery-manifest"));
      }
    }
    report.subject_id = fixture.subjectId;
    report.desktop_file_commit_verified = false;
  }
  report.assertions = "passed";
} catch (error) {
  // Only literal assertions and status summaries are emitted; never response bodies.
  report.assertions = "failed"; report.error_type = error.name;
  if (/^[A-Z0-9_]+$/.test(error.code ?? "")) report.error_code = error.code;
  if (/^[A-Z0-9_]+$/.test(error.cause?.code ?? "")) report.cause_code = error.cause.code;
  report.error = error.code === "ERR_ASSERTION" ? error.message.split("\n")[0] : "Smoke operation failed; inspect protected diagnostics";
  process.exitCode = 1;
}
console.log(JSON.stringify(report));
