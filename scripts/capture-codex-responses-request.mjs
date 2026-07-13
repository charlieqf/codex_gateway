#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const workspace = resolve(process.cwd());
const codexBin = resolve(
  workspace,
  "node_modules",
  "@openai",
  "codex",
  "bin",
  "codex.js"
);
const home = await mkdtemp(join(tmpdir(), "codex-gateway-capture-"));
await mkdir(home, { recursive: true });

const captured = [];
const captureMode = process.env.CAPTURE_MODE ?? "error";
let responseSequence = 0;

function baseResponse(id, status, output, usage = null) {
  const now = Math.floor(Date.now() / 1000);
  return {
    id,
    object: "response",
    created_at: now,
    completed_at: status === "completed" ? now : null,
    status,
    error: null,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: null,
    model: "goldencode",
    output,
    parallel_tool_calls: false,
    previous_response_id: null,
    reasoning: { effort: null, summary: null },
    store: false,
    temperature: null,
    text: { format: { type: "text" } },
    tool_choice: "auto",
    tools: [],
    top_p: null,
    truncation: "disabled",
    usage,
    user: null,
    metadata: {}
  };
}

function writeEvent(response, type, payload) {
  response.write(`event: ${type}\n`);
  response.write(`data: ${JSON.stringify({ type, ...payload })}\n\n`);
}

function sendTextResponse(response, text) {
  const suffix = `${Date.now()}_${responseSequence++}`;
  const responseId = `resp_capture_${suffix}`;
  const messageId = `msg_capture_${suffix}`;
  const message = {
    id: messageId,
    type: "message",
    status: "completed",
    role: "assistant",
    content: [{ type: "output_text", text, annotations: [] }]
  };
  response.writeHead(200, { "content-type": "text/event-stream" });
  writeEvent(response, "response.created", {
    response: baseResponse(responseId, "in_progress", [])
  });
  writeEvent(response, "response.output_item.added", {
    output_index: 0,
    item: { ...message, status: "in_progress", content: [] }
  });
  writeEvent(response, "response.content_part.added", {
    item_id: messageId,
    output_index: 0,
    content_index: 0,
    part: { type: "output_text", text: "", annotations: [] }
  });
  writeEvent(response, "response.output_text.delta", {
    item_id: messageId,
    output_index: 0,
    content_index: 0,
    delta: text
  });
  writeEvent(response, "response.output_text.done", {
    item_id: messageId,
    output_index: 0,
    content_index: 0,
    text
  });
  writeEvent(response, "response.content_part.done", {
    item_id: messageId,
    output_index: 0,
    content_index: 0,
    part: message.content[0]
  });
  writeEvent(response, "response.output_item.done", { output_index: 0, item: message });
  writeEvent(response, "response.completed", {
    response: baseResponse(responseId, "completed", [message], {
      input_tokens: 1,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 1,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 2
    })
  });
  response.end();
}

function sendFunctionCallResponse(response) {
  const suffix = `${Date.now()}_${responseSequence++}`;
  const responseId = `resp_capture_${suffix}`;
  const itemId = `fc_capture_${suffix}`;
  const callId = `call_capture_${suffix}`;
  const name = "shell_command";
  const argumentsJson = JSON.stringify({ command: "Get-Location", timeout_ms: 10000 });
  const item = {
    id: itemId,
    type: "function_call",
    status: "completed",
    call_id: callId,
    name,
    arguments: argumentsJson
  };
  response.writeHead(200, { "content-type": "text/event-stream" });
  writeEvent(response, "response.created", {
    response: baseResponse(responseId, "in_progress", [])
  });
  writeEvent(response, "response.output_item.added", {
    output_index: 0,
    item: { ...item, status: "in_progress", arguments: "" }
  });
  writeEvent(response, "response.function_call_arguments.delta", {
    item_id: itemId,
    output_index: 0,
    delta: argumentsJson
  });
  writeEvent(response, "response.function_call_arguments.done", {
    item_id: itemId,
    output_index: 0,
    arguments: argumentsJson
  });
  writeEvent(response, "response.output_item.done", { output_index: 0, item });
  writeEvent(response, "response.completed", {
    response: baseResponse(responseId, "completed", [item], {
      input_tokens: 1,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 1,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 2
    })
  });
  response.end();
}
const server = createServer(async (request, response) => {
  let raw = "";
  for await (const chunk of request) {
    raw += chunk;
  }
  let body = null;
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch {
    body = { parse_error: true, raw_preview: raw.slice(0, 500) };
  }
  captured.push({
    method: request.method,
    url: request.url,
    headers: Object.fromEntries(
      Object.entries(request.headers).map(([key, value]) => [
        key,
        key === "authorization" ? "Bearer <redacted>" : value
      ])
    ),
    body
  });
  if (captureMode === "text") {
    sendTextResponse(response, "capture-ok");
    return;
  }
  if (captureMode === "tool") {
    if (captured.length === 1) {
      sendFunctionCallResponse(response);
    } else {
      sendTextResponse(response, "capture-tool-ok");
    }
    return;
  }
  response.writeHead(400, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: { type: "invalid_request_error", code: "capture_complete", message: "Capture complete." } }));
});

await new Promise((resolveListen, rejectListen) => {
  server.once("error", rejectListen);
  server.listen(0, "127.0.0.1", resolveListen);
});
const address = server.address();
if (!address || typeof address === "string") {
  throw new Error("Capture server did not bind to a TCP port.");
}

const config = `
model = "goldencode"
model_provider = "medevidence_capture"
model_reasoning_effort = "medium"

[model_providers.medevidence_capture]
name = "MedEvidence Capture"
base_url = "http://127.0.0.1:${address.port}/v1"
env_key = "GOLDENCODE_API_KEY"
wire_api = "responses"
`;
await writeFile(join(home, "config.toml"), config, "utf8");

const child = spawn(
  process.execPath,
  [codexBin, "exec", "--skip-git-repo-check", "Reply with exactly: capture-ok"],
  {
    cwd: workspace,
    env: {
      ...process.env,
      CODEX_HOME: home,
      GOLDENCODE_API_KEY: "cgu_live_capture_dummy"
    },
    stdio: ["ignore", "pipe", "pipe"]
  }
);

let stdout = "";
let stderr = "";
child.stdout.on("data", (chunk) => {
  stdout += chunk;
});
child.stderr.on("data", (chunk) => {
  stderr += chunk;
});
const exitCode = await new Promise((resolveExit) => child.once("close", resolveExit));
await new Promise((resolveClose) => server.close(resolveClose));

try {
  if (captured.length === 0) {
    throw new Error(`Codex made no request. exit=${exitCode} stderr=${stderr.slice(0, 1000)}`);
  }
  const requestSummaries = captured.map((capture) => {
    const body = capture.body ?? {};
    return {
      method: capture.method,
      url: capture.url,
      header_names: Object.keys(capture.headers).sort(),
      authorization: capture.headers.authorization,
      body_keys: Object.keys(body),
      model: body.model,
      stream: body.stream,
      store: body.store,
      include: body.include,
      reasoning: body.reasoning,
      text: body.text,
      parallel_tool_calls: body.parallel_tool_calls,
      prompt_cache_key: body.prompt_cache_key,
      instructions_preview:
        typeof body.instructions === "string" ? body.instructions.slice(0, 500) : body.instructions,
      input: Array.isArray(body.input)
        ? body.input.map((item) => ({
            type: item?.type,
            role: item?.role,
            call_id: item?.call_id,
            name: item?.name,
            arguments_preview:
              typeof item?.arguments === "string" ? item.arguments.slice(0, 300) : undefined,
            output_preview: typeof item?.output === "string" ? item.output.slice(0, 300) : undefined,
            keys: item && typeof item === "object" ? Object.keys(item) : [],
            content: Array.isArray(item?.content)
              ? item.content.map((part) => ({
                  type: part?.type,
                  keys: part && typeof part === "object" ? Object.keys(part) : [],
                  text_preview: typeof part?.text === "string" ? part.text.slice(0, 200) : undefined
                }))
              : undefined
          }))
        : body.input,
      tools: Array.isArray(body.tools)
        ? body.tools.map((tool) => ({
            type: tool?.type,
            name: tool?.name,
            keys: tool && typeof tool === "object" ? Object.keys(tool) : [],
            parameters_keys:
              tool?.parameters && typeof tool.parameters === "object"
                ? Object.keys(tool.parameters)
                : undefined
          }))
        : body.tools
    };
  });
  const summary = {
    capture_mode: captureMode,
    exit_code: exitCode,
    requests: requestSummaries,
    stderr_preview: stderr.slice(0, 1000),
    stdout_preview: stdout.slice(0, 500)
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
} finally {
  await rm(home, { recursive: true, force: true });
}
