import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

const expectedFixture = {
  task: {
    fileName: "长任务.txt",
    bytes: 5_978,
    sha256: "a31d10e15104a608a193f9ad12e320e7e3590c422c67e06e4ab64420401d1019"
  },
  source: {
    fileName: "教授_科研方向检索.md",
    bytes: 43_479,
    sha256: "b454e08debbf2aaccf68bdb6d53f744cb58bc12635d2d0319e80dd25afddd5c4"
  }
};

const argumentsByName = parseArguments(process.argv.slice(2));
const baseUrl = requiredArgument(argumentsByName, "base-url").replace(/\/+$/, "");
const fixtureDir = requiredArgument(argumentsByName, "fixture-dir");
const task = readPinnedFixture(fixtureDir, expectedFixture.task);
const source = readPinnedFixture(fixtureDir, expectedFixture.source);
const tools = incidentTools();
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 30_000);

try {
  const response = await fetch(`${baseUrl}/tokenize`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "qwen3.8-27b-fp8",
      messages: [
        {
          role: "system",
          content:
            "Use the supplied research context, preserve source traceability, and do not disclose personal or institution identifiers from the source."
        },
        {
          role: "user",
          content: [
            "<research_source>",
            source.content,
            "</research_source>",
            "",
            "<research_task>",
            task.content,
            "</research_task>"
          ].join("\n")
        }
      ],
      tools,
      return_token_strs: false
    }),
    signal: controller.signal
  });
  if (!response.ok) {
    throw new Error(`Tokenizer returned HTTP ${response.status}.`);
  }
  const payload = await response.json();
  const promptTokens = positiveSafeInteger(payload?.count, "count");
  const maxModelLength = positiveSafeInteger(payload?.max_model_len, "max_model_len");
  const requestedOutputTokens = 8_192;
  const totalTokens = promptTokens + requestedOutputTokens;
  process.stdout.write(
    `${JSON.stringify(
      {
        fixture_task_bytes: task.bytes,
        fixture_task_sha256: task.sha256,
        fixture_source_bytes: source.bytes,
        fixture_source_sha256: source.sha256,
        replay_profile: "duheng_fixture_plus_synthetic_client_overhead_v1",
        tool_count: tools.length,
        prompt_tokens: promptTokens,
        max_model_len: maxModelLength,
        requested_output_tokens: requestedOutputTokens,
        total_tokens: totalTokens,
        overflow_tokens: Math.max(0, totalTokens - maxModelLength)
      },
      null,
      2
    )}\n`
  );
} catch (error) {
  const message = error instanceof Error ? error.message : "Unknown tokenizer failure.";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
} finally {
  clearTimeout(timeout);
}

function parseArguments(values) {
  const result = new Map();
  for (let index = 0; index < values.length; index += 2) {
    const name = values[index];
    const value = values[index + 1];
    if (!name?.startsWith("--") || !value) {
      throw new Error("Expected --base-url and --fixture-dir arguments.");
    }
    result.set(name.slice(2), value);
  }
  return result;
}

function requiredArgument(values, name) {
  const value = values.get(name)?.trim();
  if (!value) {
    throw new Error(`Missing --${name}.`);
  }
  return value;
}

function readPinnedFixture(fixtureDir, expected) {
  const content = readFileSync(path.join(fixtureDir, expected.fileName));
  const sha256 = createHash("sha256").update(content).digest("hex");
  if (content.byteLength !== expected.bytes || sha256 !== expected.sha256) {
    throw new Error(`${expected.fileName} does not match the pinned fixture identity.`);
  }
  return {
    bytes: content.byteLength,
    sha256,
    content: content.toString("utf8")
  };
}

function incidentTools() {
  // The original event retained the real tool count and tokenizer result, but
  // not private schema/history bodies. The repeated deterministic text fills
  // that measured gap at the same payload location without retaining private
  // tool arguments. vLLM remains the authority for the resulting count.
  return Array.from({ length: 57 }, (_, index) => ({
    type: "function",
    function: {
      name: `incident_tool_${String(index + 1).padStart(2, "0")}`,
      description:
        "A deterministic synthetic tool definition preserving the reported request shape without retaining private tool arguments." +
        " context".repeat(64 + (index < 2 ? 1 : 0)),
      parameters: {
        type: "object",
        properties: {
          operation: { type: "string", enum: ["inspect", "search", "write"] },
          target: { type: "string" },
          options: { type: "object", additionalProperties: true }
        },
        required: ["operation", "target"],
        additionalProperties: false
      }
    }
  }));
}

function positiveSafeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Tokenizer response ${name} is invalid.`);
  }
  return value;
}
