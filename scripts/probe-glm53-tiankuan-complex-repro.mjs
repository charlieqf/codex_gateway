import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";

const TARGET_PROMPT_CHARS = 65_000;
const TIMEOUT_MS = positiveInteger(
  process.env.TIANKUAN_REPRO_TIMEOUT_MS,
  210_000
);
const PROGRESS_INTERVAL_MS = 15_000;
const MODEL = "official/glm-5.3";
const BASE_URL = process.env.MEDCODE_TIANKUAN_BASE_URL ?? "https://tokens.tiankuan.com/v1";
const execute = process.argv.includes("--execute");
const describeOnly = process.argv.includes("--describe");
const help = process.argv.includes("--help") || process.argv.includes("-h");

if (help) {
  process.stdout.write([
    "Usage:",
    "  node probe-glm53-tiankuan-complex-repro.mjs --describe",
    "  MEDCODE_TIANKUAN_API_KEY=<key> node probe-glm53-tiankuan-complex-repro.mjs --execute",
    "Optional: TIANKUAN_REPRO_TIMEOUT_MS=<milliseconds> (default: 210000)",
    "Requires Node.js 18 or newer."
  ].join("\n") + "\n");
  process.exit(0);
}

if (Number.parseInt(process.versions.node.split(".")[0], 10) < 18) {
  throw new Error("This probe requires Node.js 18 or newer.");
}

if (!execute && !describeOnly) {
  throw new Error("Use --describe for a free request description or --execute for a paid probe.");
}

const system = [
  "You are a senior distributed-systems verification engineer.",
  "Solve the supplied dependency-and-rollout optimization problem completely.",
  "Reason internally and verify every record before emitting any final content.",
  "Do not reveal chain-of-thought. Return only the requested final JSON report."
].join(" ");
const user = buildComplexPrompt(TARGET_PROMPT_CHARS - system.length);
const messages = [
  { role: "system", content: system },
  { role: "user", content: user }
];
const requestPayload = {
  model: MODEL,
  messages,
  stream: true,
  reasoning_effort: "high",
  max_tokens: 64_000
};
const requestBody = JSON.stringify(requestPayload);
const promptSha256 = createHash("sha256")
  .update(messages.map((message) => message.content).join(""), "utf8")
  .digest("hex");
const requestBodySha256 = createHash("sha256")
  .update(requestBody, "utf8")
  .digest("hex");

if (describeOnly) {
  process.stdout.write(`${JSON.stringify({
    type: "request_description",
    endpoint: `${BASE_URL.replace(/\/+$/u, "")}/chat/completions`,
    provider: "tiankuan",
    model: MODEL,
    prompt_chars: messages.reduce((sum, message) => sum + message.content.length, 0),
    reasoning_effort: requestPayload.reasoning_effort,
    stream: requestPayload.stream,
    max_tokens: requestPayload.max_tokens,
    prompt_sha256: promptSha256,
    request_body_sha256: requestBodySha256
  }, null, 2)}\n`);
  process.exit(0);
}

const apiKey = resolveApiKey(
  "MEDCODE_TIANKUAN_API_KEY",
  process.env.MEDCODE_TIANKUAN_API_KEY_ENV
);
if (!apiKey) throw new Error("Missing configured TianKuan API key.");

const startedAt = new Date().toISOString();
const started = performance.now();
let lastMilestone = "request_start";
process.stdout.write(`${JSON.stringify({
  type: "start",
  started_at: startedAt,
  provider: "tiankuan",
  model: MODEL,
  prompt_chars: messages.reduce((sum, message) => sum + message.content.length, 0),
  reasoning_effort: "high",
  stream: true,
  max_tokens: 64_000,
  timeout_ms: TIMEOUT_MS,
  prompt_sha256: promptSha256,
  request_body_sha256: requestBodySha256
})}\n`);

const progress = setInterval(() => {
  process.stdout.write(`${JSON.stringify({
    type: "progress",
    elapsed_ms: elapsed(started),
    milestone: lastMilestone
  })}\n`);
}, PROGRESS_INTERVAL_MS);
progress.unref();

const observation = {
  provider: "tiankuan",
  model: MODEL,
  started_at: startedAt,
  prompt_chars: TARGET_PROMPT_CHARS,
  reasoning_effort: "high",
  stream: true,
  max_tokens: 64_000,
  http_status: null,
  upstream_request_id: null,
  trace_headers: {},
  sse_response_id: null,
  response_model: null,
  headers_ms: null,
  raw_first_event_ms: null,
  parsed_first_event_ms: null,
  reasoning_first_event_ms: null,
  visible_first_content_ms: null,
  last_raw_event_ms: null,
  total_duration_ms: null,
  raw_response_chars: 0,
  reasoning_chars: 0,
  visible_content_chars: 0,
  finish_reason: null,
  done_seen: false,
  normal_terminal_seen: false,
  usage: null,
  response_sha256: null,
  error_kind: null,
  reproduced_180s_incomplete_stream_shape: false
};

const hash = createHash("sha256");
try {
  const response = await fetch(`${BASE_URL.replace(/\/+$/u, "")}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json"
    },
    body: requestBody,
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  observation.headers_ms = elapsed(started);
  observation.http_status = response.status;
  observation.trace_headers = selectedHeaders(response.headers, [
    "x-request-id",
    "request-id",
    "x-trace-id",
    "x-correlation-id",
    "x-litellm-call-id",
    "traceparent",
    "cf-ray",
    "x-envoy-upstream-service-time"
  ]);
  observation.upstream_request_id = firstHeader(response.headers, [
    "x-request-id",
    "request-id",
    "x-trace-id",
    "x-correlation-id",
    "x-litellm-call-id"
  ]);
  lastMilestone = "response_headers";
  process.stdout.write(`${JSON.stringify({
    type: "headers",
    elapsed_ms: observation.headers_ms,
    http_status: observation.http_status,
    upstream_request_id: observation.upstream_request_id,
    trace_headers: observation.trace_headers
  })}\n`);

  if (!response.body) {
    observation.error_kind = "missing_response_body";
  } else {
    await observeSse(response, observation, started, hash);
  }
  if (!response.ok && !observation.error_kind) {
    observation.error_kind = `http_${response.status}`;
  }
} catch (error) {
  observation.error_kind = error?.name === "TimeoutError"
    ? "client_probe_timeout"
    : `transport_error:${error?.code ?? error?.name ?? "unknown"}`;
} finally {
  clearInterval(progress);
}

observation.total_duration_ms = elapsed(started);
observation.response_sha256 = observation.raw_response_chars > 0
  ? hash.digest("hex")
  : null;
observation.normal_terminal_seen =
  observation.done_seen || observation.finish_reason != null;
if (
  observation.http_status === 200 &&
  observation.error_kind === null &&
  !observation.normal_terminal_seen
) {
  observation.error_kind = "eof_before_terminal";
}
observation.reproduced_180s_incomplete_stream_shape =
  observation.http_status === 200 &&
  observation.total_duration_ms >= 175_000 &&
  observation.total_duration_ms <= 195_000 &&
  observation.visible_content_chars === 0 &&
  !observation.normal_terminal_seen;

process.stdout.write(`${JSON.stringify({ type: "result", ...observation })}\n`);

async function observeSse(response, target, clockStarted, digest) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const now = elapsed(clockStarted);
    if (target.raw_first_event_ms == null) {
      target.raw_first_event_ms = now;
      lastMilestone = "first_raw_event";
      process.stdout.write(`${JSON.stringify({ type: "first_raw_event", elapsed_ms: now })}\n`);
    }
    target.last_raw_event_ms = now;
    const raw = decoder.decode(value, { stream: true });
    digest.update(raw, "utf8");
    target.raw_response_chars += raw.length;
    pending += raw.replace(/\r\n/gu, "\n");

    let boundary;
    while ((boundary = pending.indexOf("\n\n")) >= 0) {
      const block = pending.slice(0, boundary);
      pending = pending.slice(boundary + 2);
      const data = block
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n")
        .trim();
      if (!data) continue;
      target.parsed_first_event_ms ??= now;
      if (data === "[DONE]") {
        target.done_seen = true;
        lastMilestone = "done_seen";
        continue;
      }

      let payload;
      try {
        payload = JSON.parse(data);
      } catch {
        target.error_kind ??= "invalid_sse_json";
        continue;
      }
      if (payload?.error) target.error_kind ??= "provider_error_frame";
      target.sse_response_id ??= stringOrNull(payload?.id);
      target.response_model ??= stringOrNull(payload?.model);
      for (const choice of payload?.choices ?? []) {
        const delta = choice?.delta ?? {};
        const reasoning = textValue(
          delta.reasoning_content ?? delta.reasoningContent ?? delta.reasoning
        );
        if (reasoning.length > 0) {
          if (target.reasoning_first_event_ms == null) {
            target.reasoning_first_event_ms = now;
            lastMilestone = "first_reasoning_event";
          }
          target.reasoning_chars += reasoning.length;
        }
        const content = textValue(delta.content);
        if (content.length > 0) {
          if (target.visible_first_content_ms == null) {
            target.visible_first_content_ms = now;
            lastMilestone = "first_visible_content";
          }
          target.visible_content_chars += content.length;
        }
        if (choice?.finish_reason != null) {
          target.finish_reason = choice.finish_reason;
          lastMilestone = "finish_reason_seen";
        }
      }
      target.usage ??= sanitizeUsage(payload?.usage);
    }
  }
  const trailer = decoder.decode();
  if (trailer) {
    digest.update(trailer, "utf8");
    target.raw_response_chars += trailer.length;
  }
}

function buildComplexPrompt(targetLength) {
  const prefix = [
    "This is synthetic benchmark data; it contains no user or production information.",
    "Determine the globally optimal rollout schedule for every listed module.",
    "Constraints: dependencies must precede dependents; each wave has capacity 11; modules sharing a failure domain cannot be in the same wave; security-critical modules require two predecessor waves; frozen modules can move only after wave 9; and every listed exception must be reconciled.",
    "Find the minimum wave count and, among all optima, the lexicographically smallest schedule. Independently verify dependency closure, capacity, failure-domain separation, freeze rules, risk totals, and all checksums.",
    "Do not start the final response until the full audit and optimization are complete.",
    "Return one JSON object containing minimum_wave_count, ordered_waves for every module, violations, exception_resolution, risk_totals, checksum_verification, and an audit_summary of at least 3000 Chinese characters.",
    "BEGIN_SYNTHETIC_REPOSITORY"
  ].join("\n");
  const suffix = "\nEND_SYNTHETIC_REPOSITORY\nPerform the complete audit now.";
  const bodyLength = targetLength - prefix.length - suffix.length;
  if (bodyLength <= 0) throw new Error("Prompt target is too small.");

  const lines = [];
  for (let index = 1; ; index += 1) {
    const id = `M${String(index).padStart(4, "0")}`;
    const previous = `M${String(Math.max(1, index - 1)).padStart(4, "0")}`;
    const jump = `M${String(Math.max(1, index - ((index * 7) % 29 + 2))).padStart(4, "0")}`;
    const third = index % 47 === 0
      ? id
      : `M${String(Math.max(1, index - ((index * 11) % 41 + 3))).padStart(4, "0")}`;
    const future = `M${String(index + 13).padStart(4, "0")}`;
    const deps = index === 1
      ? "[]"
      : index % 53 === 0
        ? `[${previous},${future}]`
        : `[${previous},${jump},${third}]`;
    const line = [
      id,
      `domain=FD${(index * 17) % 31}`,
      `region=R${(index * 13) % 7}`,
      `owner=O${(index * 19) % 23}`,
      `risk=${(index * 37) % 101}`,
      `critical=${index % 17 === 0 || index % 41 === 0}`,
      `frozen=${index % 29 === 0}`,
      `depends=${deps}`,
      `exception=E${(index * 43) % 97}`,
      `checksum=${((index * 2654435761) >>> 0).toString(16).padStart(8, "0")}`,
      `rule=waveParity:${index % 2};riskBand:${Math.floor(((index * 37) % 101) / 10)};pair:P${(index * 5) % 67}`
    ].join(" ");
    const candidate = `${lines.length === 0 ? "\n" : ""}${line}\n`;
    const used = lines.reduce((sum, value) => sum + value.length, 0);
    if (used + candidate.length > bodyLength) break;
    lines.push(candidate);
  }
  const used = lines.reduce((sum, value) => sum + value.length, 0);
  const padding = "# deterministic audit padding ".repeat(
    Math.ceil((bodyLength - used) / 30)
  ).slice(0, bodyLength - used);
  const result = prefix + lines.join("") + padding + suffix;
  if (result.length !== targetLength) {
    throw new Error(`Prompt length mismatch: ${result.length} != ${targetLength}`);
  }
  return result;
}

function resolveApiKey(defaultName, configuredName) {
  const name = configuredName?.trim() || defaultName;
  return process.env[name]?.trim() ?? "";
}

function firstHeader(headers, names) {
  for (const name of names) {
    const value = headers.get(name)?.trim();
    if (value) return value;
  }
  return null;
}

function selectedHeaders(headers, names) {
  const selected = {};
  for (const name of names) {
    const value = headers.get(name)?.trim();
    if (value) selected[name] = value;
  }
  return selected;
}

function stringOrNull(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function textValue(value) {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((part) => typeof part === "string" ? part : part?.text ?? "").join("");
}

function sanitizeUsage(value) {
  if (!value || typeof value !== "object") return null;
  return {
    prompt_tokens: integerOrNull(value.prompt_tokens),
    completion_tokens: integerOrNull(value.completion_tokens),
    total_tokens: integerOrNull(value.total_tokens),
    reasoning_tokens: integerOrNull(
      value.reasoning_tokens ?? value.completion_tokens_details?.reasoning_tokens
    )
  };
}

function integerOrNull(value) {
  return Number.isSafeInteger(value) ? value : null;
}

function positiveInteger(value, fallback) {
  if (value == null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error("TIANKUAN_REPRO_TIMEOUT_MS must be a positive integer.");
  }
  return parsed;
}

function elapsed(clockStarted) {
  return Math.round(performance.now() - clockStarted);
}
