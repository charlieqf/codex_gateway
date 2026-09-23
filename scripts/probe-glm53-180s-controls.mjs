import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";

const CONTEXT_PLACEHOLDER = "{{SYNTHETIC_CONTEXT}}";
const MARKER = "CONTROL_180S_OK";
const TIMEOUT_MS = 210_000;
const SYSTEM_MESSAGE =
  "Perform the configured reasoning internally, check the synthetic records, and return only the marker.";
const USER_TEMPLATE =
  `${CONTEXT_PLACEHOLDER}\nCheck every synthetic record for consistency, then return the transport marker exactly. Expose no reasoning.`;
const FACT =
  `All synthetic records are internally consistent and the transport marker is ${MARKER}.`;
const ALIGNMENT_MARKER = "REASONING_ALIGNMENT_OK";
const ALIGNMENT_SYSTEM_MESSAGE =
  "Check the synthetic records and return only the requested shared marker.";
const ALIGNMENT_USER_TEMPLATE =
  `${CONTEXT_PLACEHOLDER}\nReturn the shared marker exactly, with no explanation.`;
const ALIGNMENT_FACT =
  `Every synthetic record uses the shared marker ${ALIGNMENT_MARKER}.`;

if (!process.argv.includes("--execute")) {
  throw new Error("Refusing to contact paid providers without --execute.");
}

const suite = process.argv.includes("--reasoning-alignment")
  ? "reasoning_alignment"
  : "180s_causal_controls";
const controls = suite === "reasoning_alignment"
  ? reasoningAlignmentControls()
  : [
      {
        id: "C01",
        name: "short_high_stream",
        promptChars: 2_048,
        effort: "high",
        stream: true,
        maxTokens: 8_192,
        profile: "180s"
      },
      {
        id: "C02",
        name: "long_low_stream",
        promptChars: 61_578,
        effort: "low",
        stream: true,
        maxTokens: 8_192,
        profile: "180s"
      },
      {
        id: "C04",
        name: "long_high_nonstream",
        promptChars: 61_578,
        effort: "high",
        stream: false,
        maxTokens: 8_192,
        profile: "180s"
      },
      {
        id: "C03",
        name: "long_high_stream",
        promptChars: 61_578,
        effort: "high",
        stream: true,
        maxTokens: 8_192,
        profile: "180s"
      }
    ];

const providers = [
  {
    id: "tencent",
    model: "glm-5.3",
    baseUrl: process.env.MEDCODE_TENCENT_TOKENHUB_BASE_URL ??
      "https://tokenhub.tencentmaas.com/plan/v3",
    apiKey: resolveApiKey(
      "MEDCODE_TENCENT_TOKENHUB_API_KEY",
      process.env.MEDCODE_TENCENT_TOKENHUB_API_KEY_ENV ??
        process.env.MEDCODE_TENCENT_API_KEY_ENV
    )
  },
  {
    id: "tiankuan",
    model: "official/glm-5.3",
    baseUrl: process.env.MEDCODE_TIANKUAN_BASE_URL ?? "https://tokens.tiankuan.com/v1",
    apiKey: resolveApiKey("MEDCODE_TIANKUAN_API_KEY", process.env.MEDCODE_TIANKUAN_API_KEY_ENV)
  }
];

for (const provider of providers) {
  if (!provider.apiKey) {
    throw new Error(`Missing configured API key for ${provider.id}.`);
  }
}

const runStartedAt = new Date().toISOString();
const results = [];
for (const control of controls) {
  const paired = await Promise.all(providers.map((provider) => runControl(provider, control)));
  results.push(...paired);
  for (const result of paired) {
    process.stdout.write(`${JSON.stringify({ type: "case_result", ...result })}\n`);
  }
  const tiankuan = paired.find((result) => result.provider === "tiankuan");
  if (!tiankuan?.success) {
    process.stdout.write(`${JSON.stringify({
      type: "early_stop",
      after_case: control.id,
      reason: "tiankuan_transport_or_provider_failure"
    })}\n`);
    break;
  }
}

process.stdout.write(`${JSON.stringify({
  type: "run_summary",
  suite,
  started_at: runStartedAt,
  completed_at: new Date().toISOString(),
  planned_requests: controls.length * providers.length,
  completed_requests: results.length,
  failed_requests: results.filter((result) => !result.success).length
})}\n`);

async function runControl(provider, control) {
  const { messages, marker } = materializedMessages(control);
  const started = performance.now();
  const observation = {
    provider: provider.id,
    model: provider.model,
    case_id: control.id,
    case_name: control.name,
    prompt_chars: promptCharacterCount(messages),
    reasoning_effort: control.effort,
    stream: control.stream,
    max_tokens: control.maxTokens,
    http_status: null,
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
    marker_expected: marker,
    marker_exact: false,
    finish_reason: null,
    done_seen: false,
    normal_terminal_seen: false,
    usage: null,
    response_sha256: null,
    error_kind: null,
    success: false
  };

  const hash = createHash("sha256");
  try {
    const response = await fetch(chatCompletionsUrl(provider.baseUrl), {
      method: "POST",
      headers: {
        authorization: `Bearer ${provider.apiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: provider.model,
        messages,
        stream: control.stream,
        reasoning_effort: control.effort,
        max_tokens: control.maxTokens
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    observation.headers_ms = elapsed(started);
    observation.http_status = response.status;
    if (!response.body) {
      observation.error_kind = "missing_response_body";
      return finishObservation(observation, started, hash);
    }
    if (control.stream) {
      await observeSseResponse(response, observation, started, hash);
    } else {
      await observeJsonResponse(response, observation, started, hash);
    }
    if (!response.ok && !observation.error_kind) {
      observation.error_kind = `http_${response.status}`;
    }
  } catch (error) {
    observation.error_kind = error?.name === "TimeoutError" ? "client_probe_timeout" : "transport_error";
  }
  return finishObservation(observation, started, hash);
}

async function observeSseResponse(response, observation, started, hash) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let visibleContent = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const now = elapsed(started);
    observation.raw_first_event_ms ??= now;
    observation.last_raw_event_ms = now;
    const raw = decoder.decode(value, { stream: true });
    hash.update(raw, "utf8");
    observation.raw_response_chars += raw.length;
    pending += raw.replace(/\r\n/gu, "\n");
    let boundary;
    while ((boundary = pending.indexOf("\n\n")) >= 0) {
      const eventBlock = pending.slice(0, boundary);
      pending = pending.slice(boundary + 2);
      const data = eventBlock
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n")
        .trim();
      if (!data) continue;
      observation.parsed_first_event_ms ??= now;
      if (data === "[DONE]") {
        observation.done_seen = true;
        continue;
      }
      let payload;
      try {
        payload = JSON.parse(data);
      } catch {
        observation.error_kind ??= "invalid_sse_json";
        continue;
      }
      if (payload?.error) {
        observation.error_kind ??= "provider_error_frame";
      }
      for (const choice of payload?.choices ?? []) {
        const delta = choice?.delta ?? {};
        const reasoning = textValue(
          delta.reasoning_content ?? delta.reasoningContent ?? delta.reasoning
        );
        if (reasoning.length > 0) {
          observation.reasoning_first_event_ms ??= now;
          observation.reasoning_chars += reasoning.length;
        }
        const content = textValue(delta.content);
        if (content.length > 0) {
          observation.visible_first_content_ms ??= now;
          observation.visible_content_chars += content.length;
          visibleContent += content;
        }
        if (choice?.finish_reason != null) {
          observation.finish_reason = choice.finish_reason;
        }
      }
      observation.usage ??= sanitizeUsage(payload?.usage);
    }
  }
  const trailer = decoder.decode();
  if (trailer) {
    hash.update(trailer, "utf8");
    observation.raw_response_chars += trailer.length;
  }
  observation.marker_exact = visibleContent.trim() === observation.marker_expected;
  observation.normal_terminal_seen = observation.done_seen || observation.finish_reason != null;
  if (!observation.normal_terminal_seen && !observation.error_kind) {
    observation.error_kind = "eof_before_terminal";
  }
}

async function observeJsonResponse(response, observation, started, hash) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let raw = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const now = elapsed(started);
    observation.raw_first_event_ms ??= now;
    observation.last_raw_event_ms = now;
    const text = decoder.decode(value, { stream: true });
    raw += text;
    hash.update(text, "utf8");
    observation.raw_response_chars += text.length;
  }
  const trailer = decoder.decode();
  raw += trailer;
  if (trailer) {
    hash.update(trailer, "utf8");
    observation.raw_response_chars += trailer.length;
  }
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    observation.error_kind = "invalid_json";
    return;
  }
  if (payload?.error) {
    observation.error_kind = "provider_error_body";
  }
  const choice = payload?.choices?.[0];
  const message = choice?.message ?? {};
  const reasoning = textValue(
    message.reasoning_content ?? message.reasoningContent ?? message.reasoning
  );
  const content = textValue(message.content);
  observation.reasoning_chars = reasoning.length;
  observation.reasoning_first_event_ms = reasoning.length > 0 ? observation.raw_first_event_ms : null;
  observation.visible_content_chars = content.length;
  observation.visible_first_content_ms = content.length > 0 ? observation.raw_first_event_ms : null;
  observation.marker_exact = content.trim() === observation.marker_expected;
  observation.finish_reason = choice?.finish_reason ?? null;
  observation.normal_terminal_seen = observation.finish_reason != null;
  observation.usage = sanitizeUsage(payload?.usage);
}

function finishObservation(observation, started, hash) {
  observation.total_duration_ms = elapsed(started);
  observation.response_sha256 = observation.raw_response_chars > 0 ? hash.digest("hex") : null;
  observation.success =
    observation.http_status === 200 &&
    observation.error_kind === null &&
    observation.normal_terminal_seen &&
    observation.marker_exact;
  return observation;
}

function materializedMessages(control) {
  const alignment = control.profile === "alignment";
  const systemMessage = alignment ? ALIGNMENT_SYSTEM_MESSAGE : SYSTEM_MESSAGE;
  const userTemplate = alignment ? ALIGNMENT_USER_TEMPLATE : USER_TEMPLATE;
  const fact = alignment ? ALIGNMENT_FACT : FACT;
  const seed = alignment ? "REASONING_ALIGNMENT" : "CONTROL_180S";
  const marker = alignment ? ALIGNMENT_MARKER : MARKER;
  const fixedCharacters =
    systemMessage.length + userTemplate.length - CONTEXT_PLACEHOLDER.length;
  const context = syntheticContext(control.promptChars - fixedCharacters, fact, seed);
  const messages = [
    { role: "system", content: systemMessage },
    { role: "user", content: userTemplate.replace(CONTEXT_PLACEHOLDER, context) }
  ];
  if (promptCharacterCount(messages) !== control.promptChars) {
    throw new Error(`Failed to construct exact ${control.promptChars}-character prompt.`);
  }
  return { messages, marker };
}

function syntheticContext(length, fact, seed) {
  const factLine = `\n[SYNTHETIC_FACT_1] ${fact}\n`;
  const totalFiller = length - factLine.length;
  if (totalFiller < 2) throw new Error("Synthetic context target is too small.");
  const leftLength = Math.ceil(totalFiller / 2);
  const rightLength = totalFiller - leftLength;
  return syntheticFiller(seed, 0, leftLength) + factLine + syntheticFiller(seed, 1, rightLength);
}

function syntheticFiller(seed, section, length) {
  const unit = `[SYNTHETIC_${seed}_${section}] This record is generated test padding with no user data. `;
  return unit.repeat(Math.ceil(length / unit.length)).slice(0, length);
}

function reasoningAlignmentControls() {
  const balancedOrder = ["low", "high", "high", "low", "low", "high", "high", "low", "low", "high"];
  const counters = { low: 0, high: 0 };
  return balancedOrder.map((effort, index) => {
    counters[effort] += 1;
    return {
      id: `R${String(index + 1).padStart(2, "0")}`,
      name: `alignment_${effort}_${counters[effort]}`,
      promptChars: 1_024,
      effort,
      stream: true,
      maxTokens: effort === "low" ? 256 : 1_024,
      profile: "alignment",
      repetition: counters[effort]
    };
  });
}

function resolveApiKey(defaultName, configuredName) {
  const name = configuredName?.trim() || defaultName;
  return process.env[name]?.trim() ?? "";
}

function chatCompletionsUrl(baseUrl) {
  return `${baseUrl.replace(/\/+$/u, "")}/chat/completions`;
}

function promptCharacterCount(messages) {
  return messages.reduce((sum, message) => sum + message.content.length, 0);
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

function elapsed(started) {
  return Math.round(performance.now() - started);
}
