#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  issueAccessCredential,
  issueUnifiedClientKey
} from "../packages/core/dist/index.js";
import { createSqliteStore } from "../packages/store-sqlite/dist/index.js";
import { buildGateway } from "../apps/gateway/dist/index.js";
import { goldencodePoolConfig } from "../apps/gateway/dist/test-support.js";

const workspace = resolve(process.cwd());
const codexBin = resolve(workspace, "node_modules", "@openai", "codex", "bin", "codex.js");
const home = await mkdtemp(join(tmpdir(), "codex-gateway-responses-smoke-"));
const upstreamRequests = [];
const previousEnv = new Map();

class UnusedProvider {
  kind = "smoke-unused";

  async health() {
    return { state: "healthy", checkedAt: new Date() };
  }

  async *message() {
    throw new Error("The GoldenCode pool should not call the fallback provider.");
  }
}

function setEnv(name, value) {
  previousEnv.set(name, process.env[name]);
  process.env[name] = value;
}

async function startUpstream(runtime) {
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) {
      raw += chunk;
    }
    const body = JSON.parse(raw);
    const prompt = Array.isArray(body.messages)
      ? body.messages
          .map((message) => (typeof message?.content === "string" ? message.content : ""))
          .join("\n")
      : "";
    const followUp = prompt.includes("[tool tool_call_id=");
    upstreamRequests.push({ runtime, followUp, model: body.model });
    response.writeHead(200, {
      "content-type": "text/event-stream",
      [`x-${runtime}-request-id`]: `${runtime}-responses-smoke`
    });
    if (followUp) {
      response.write(
        `data: ${JSON.stringify({
          choices: [{ delta: { content: "codex-gateway-responses-ok" } }]
        })}\n\n`
      );
    } else {
      response.write(
        `data: ${JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_codex_responses_smoke",
                    type: "function",
                    function: {
                      name: "shell_command",
                      arguments: JSON.stringify({
                        command: "Write-Output codex-gateway-tool-ok",
                        timeout_ms: 10000
                      })
                    }
                  }
                ]
              }
            }
          ]
        })}\n\n`
      );
    }
    response.write(
      `data: ${JSON.stringify({
        choices: [],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }
      })}\n\n`
    );
    response.end("data: [DONE]\n\n");
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error(`${runtime} mock did not bind to a TCP port.`);
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolveClose) => server.close(resolveClose))
  };
}

const upstreams = {
  qianfan: await startUpstream("qianfan"),
  tencent: await startUpstream("tencent"),
  aliyun: await startUpstream("aliyun"),
  openrouter: await startUpstream("openrouter")
};

setEnv("MEDCODE_QIANFAN_API_KEY", "bce-v3/local-smoke-redacted");
setEnv("MEDCODE_QIANFAN_BASE_URL", upstreams.qianfan.baseUrl);
setEnv("MEDCODE_TENCENT_TOKENHUB_API_KEY", "local-smoke-redacted");
setEnv("MEDCODE_TENCENT_TOKENHUB_BASE_URL", upstreams.tencent.baseUrl);
setEnv("MEDCODE_ALIYUN_DASHSCOPE_API_KEY", "local-smoke-redacted");
setEnv("MEDCODE_ALIYUN_TOKEN_PLAN_BASE_URL", upstreams.aliyun.baseUrl);
setEnv("MEDCODE_OPENROUTER_API_KEY", "sk-local-smoke-redacted");
setEnv("MEDCODE_OPENROUTER_BASE_URL", upstreams.openrouter.baseUrl);
setEnv(
  "MEDCODE_PUBLIC_MODELS_JSON",
  JSON.stringify({
    max: {
      displayName: "Max",
      runtime: "codex",
      upstreamModel: "gpt-5.6-sol",
      contextWindow: 400000,
      upstreamContextWindow: 400000,
      maxOutputTokens: 128000,
      enabled: true
    },
    goldencode: goldencodePoolConfig()
  })
);
setEnv("GATEWAY_REQUIRE_ENTITLEMENT", "0");

const store = createSqliteStore({ path: ":memory:" });
const issued = issueAccessCredential({
  subjectId: "subj_codex_responses_smoke",
  label: "Codex Responses local smoke backing key",
  scope: "code",
  expiresAt: new Date("2030-01-01T00:00:00Z")
});
store.upsertSubject({
  id: issued.record.subjectId,
  label: "Codex Responses Local Smoke",
  state: "active",
  createdAt: new Date()
});
store.insertAccessCredential(issued.record);
const unified = issueUnifiedClientKey({
  subjectId: issued.record.subjectId,
  label: "Codex Responses local smoke",
  expiresAt: issued.record.expiresAt,
  codexCredentialId: issued.record.id,
  codexCredentialPrefix: issued.record.prefix,
  codexKeyCiphertext: "not-used-by-direct-auth",
  medevidenceKeyCiphertext: "not-used-by-direct-auth"
});
store.insertUnifiedClientKey(unified.record);

const app = buildGateway({
  authMode: "credential",
  provider: new UnusedProvider(),
  sessionStore: store,
  observationStore: store,
  logger: false
});

let exitCode = null;
let stdout = "";
let stderr = "";
try {
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  await mkdir(home, { recursive: true });
  await writeFile(
    join(home, "config.toml"),
    [
      'model = "goldencode"',
      'model_provider = "medevidence_goldencode"',
      'model_reasoning_effort = "medium"',
      "",
      "[model_providers.medevidence_goldencode]",
      'name = "MedEvidence GoldenCode"',
      `base_url = "${address}/v1"`,
      'env_key = "GOLDENCODE_API_KEY"',
      'wire_api = "responses"',
      ""
    ].join("\n"),
    "utf8"
  );

  const child = spawn(
    process.execPath,
    [
      codexBin,
      "exec",
      "--skip-git-repo-check",
      "Use shell_command once, then reply exactly: codex-gateway-responses-ok"
    ],
    {
      cwd: workspace,
      env: {
        ...process.env,
        CODEX_HOME: home,
        GOLDENCODE_API_KEY: unified.token
      },
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  exitCode = await new Promise((resolveExit) => child.once("close", resolveExit));

  if (exitCode !== 0) {
    throw new Error(`Codex exited ${exitCode}: ${stderr.slice(0, 1500)}`);
  }
  if (!stdout.includes("codex-gateway-responses-ok")) {
    throw new Error(`Codex final response was not observed: ${stdout.slice(0, 1000)}`);
  }
  if (upstreamRequests.length !== 2 || !upstreamRequests[1]?.followUp) {
    throw new Error(`Expected a two-turn tool loop, got ${JSON.stringify(upstreamRequests)}`);
  }
  if (upstreamRequests[0].runtime !== upstreamRequests[1].runtime) {
    throw new Error(`GoldenCode affinity changed within one Codex session.`);
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        key_prefix: `cgu_live_${unified.record.prefix}`,
        gateway_requests: 2,
        selected_runtime: upstreamRequests[0].runtime,
        tool_follow_up: true,
        codex_exit_code: exitCode
      },
      null,
      2
    )}\n`
  );
} finally {
  await app.close();
  await Promise.all(Object.values(upstreams).map((upstream) => upstream.close()));
  await rm(home, { recursive: true, force: true });
  for (const [name, value] of previousEnv) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
}
