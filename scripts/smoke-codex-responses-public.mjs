#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const workspace = resolve(process.cwd());
const keyFile = argumentValue("--key-file");
if (!keyFile) {
  throw new Error("Usage: node scripts/smoke-codex-responses-public.mjs --key-file <handoff.json>");
}

const handoff = JSON.parse(await readFile(resolve(keyFile), "utf8"));
const key = typeof handoff.key === "string" ? handoff.key : "";
if (!/^cgu_live_[A-Za-z0-9]{64}$/.test(key)) {
  throw new Error("The handoff file does not contain a valid cgu_live key.");
}
const baseUrl = normalizeBaseUrl(
  typeof handoff.openai_compatible_base_url === "string"
    ? handoff.openai_compatible_base_url
    : "https://gw.instmarket.com.au/v1"
);
const keyPrefix = typeof handoff.key_prefix === "string"
  ? handoff.key_prefix
  : `cgu_live_${key.slice("cgu_live_".length, "cgu_live_".length + 16)}`;
const codexBin = resolve(workspace, "node_modules", "@openai", "codex", "bin", "codex.js");
const home = await mkdtemp(join(tmpdir(), "codex-gateway-public-responses-smoke-"));

let stdout = "";
let stderr = "";
let timedOut = false;
try {
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
      `base_url = "${baseUrl}"`,
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
      "Use shell_command exactly once to run Write-Output codex-gateway-public-tool-ok. After seeing its result, reply exactly: codex-gateway-public-responses-ok"
    ],
    {
      cwd: workspace,
      env: {
        ...process.env,
        CODEX_HOME: home,
        GOLDENCODE_API_KEY: key
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
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, 600_000);
  timeout.unref?.();
  const exitCode = await new Promise((resolveExit) => child.once("close", resolveExit));
  clearTimeout(timeout);

  if (timedOut) {
    throw new Error("Codex Responses public smoke timed out after 600 seconds.");
  }
  if (exitCode !== 0) {
    throw new Error(`Codex exited ${exitCode}: ${redact(stderr).slice(0, 2000)}`);
  }
  if (!stdout.includes("codex-gateway-public-responses-ok")) {
    throw new Error(`Codex final response was not observed: ${redact(stdout).slice(0, 1200)}`);
  }
  if (!stderr.includes("codex-gateway-public-tool-ok")) {
    throw new Error("Codex did not report the expected shell_command result.");
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        key_file: basename(keyFile),
        key_prefix: keyPrefix,
        base_url: baseUrl,
        model: "goldencode",
        reasoning_effort: "medium",
        tool_follow_up: true,
        codex_exit_code: exitCode
      },
      null,
      2
    )}\n`
  );
} finally {
  await rm(home, { recursive: true, force: true });
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function normalizeBaseUrl(value) {
  return value.trim().replace(/\/+$/, "");
}

function redact(value) {
  return value
    .replace(/cgu_live_[A-Za-z0-9]{64}/g, "cgu_live_<redacted>")
    .replace(/Bearer\s+[A-Za-z0-9._=-]+/gi, "Bearer <redacted>");
}
