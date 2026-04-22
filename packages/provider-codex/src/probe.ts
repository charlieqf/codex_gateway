import { spawn } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Codex, type ThreadEvent, type ThreadOptions } from "@openai/codex-sdk";

interface ProbeOptions {
  codexHome: string;
  workdir: string;
  codexPath?: string;
  model?: string;
  prompt: string;
  runSdk: boolean;
  stream: boolean;
  resumeThreadId?: string;
  timeoutMs: number;
  skipGitRepoCheck: boolean;
}

interface CommandResult {
  command: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

interface ProbeReport {
  generatedAt: string;
  options: Omit<ProbeOptions, "prompt"> & { promptPreview: string };
  environment: {
    platform: NodeJS.Platform;
    node: string;
    cwd: string;
    codexHomeExists: boolean;
    codexHomeFiles: string[];
  };
  codexCli: {
    version: CommandResult;
    loginStatus: CommandResult;
    appServerHelp: CommandResult;
  };
  sdk: {
    status: "skipped" | "ok" | "failed";
    threadId: string | null;
    resumed: boolean;
    eventCounts: Record<string, number>;
    finalResponsePreview: string | null;
    usage: unknown;
    error: string | null;
  };
  recommendation: string;
}

function parseArgs(argv: string[]): ProbeOptions {
  const baseDir = process.env.INIT_CWD ?? process.cwd();
  const defaults: ProbeOptions = {
    codexHome: path.resolve(baseDir, ".gateway-state", "codex-home"),
    workdir: baseDir,
    prompt: "Reply with exactly: codex-gateway-probe-ok",
    runSdk: false,
    stream: true,
    timeoutMs: 120_000,
    skipGitRepoCheck: false
  };

  const options = { ...defaults };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (!value) {
        throw new Error(`Missing value for ${arg}`);
      }
      i += 1;
      return value;
    };

    switch (arg) {
      case "--codex-home":
        options.codexHome = resolveFrom(baseDir, next());
        break;
      case "--workdir":
        options.workdir = resolveFrom(baseDir, next());
        break;
      case "--codex-path":
        options.codexPath = resolveFrom(baseDir, next());
        break;
      case "--model":
        options.model = next();
        break;
      case "--prompt":
        options.prompt = next();
        break;
      case "--run":
        options.runSdk = true;
        break;
      case "--no-stream":
        options.stream = false;
        break;
      case "--resume-thread-id":
        options.resumeThreadId = next();
        break;
      case "--timeout-ms":
        options.timeoutMs = Number.parseInt(next(), 10);
        if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
          throw new Error("--timeout-ms must be a positive integer");
        }
        break;
      case "--skip-git-repo-check":
        options.skipGitRepoCheck = true;
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function resolveFrom(baseDir: string, value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(baseDir, value);
}

function printHelp() {
  console.log(`Codex provider Phase 0 probe

Usage:
  npm run probe:codex -- [options]

Options:
  --codex-home <dir>       Isolated CODEX_HOME. Default: .gateway-state/codex-home
  --workdir <dir>          Working directory passed to Codex. Default: current directory
  --codex-path <path>      Optional codex binary override
  --model <model>          Optional model override
  --prompt <text>          Probe prompt
  --run                    Execute an SDK turn. Without this, only environment/auth checks run
  --no-stream              Use buffered SDK run() instead of runStreamed()
  --resume-thread-id <id>  Resume an existing Codex thread
  --timeout-ms <ms>        SDK turn timeout. Default: 120000
  --skip-git-repo-check    Allow workdir that is not a git repository
`);
}

function sanitize(value: string): string {
  return value
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "<email:redacted>")
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, "sk-<redacted>")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer <redacted>")
    .replace(/eyJ[A-Za-z0-9._-]{20,}/g, "<jwt:redacted>");
}

function preview(value: string, max = 600): string {
  const clean = sanitize(value.trim());
  if (clean.length <= max) {
    return clean;
  }
  return `${clean.slice(0, max)}...<truncated>`;
}

function commandEnv(codexHome: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CODEX_HOME: codexHome
  };
}

function runCommand(
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; cwd: string; timeoutMs?: number }
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const spec = spawnSpec(command, args);
    const child = spawn(spec.command, spec.args, {
      cwd: options.cwd,
      env: options.env
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timeout = options.timeoutMs
      ? setTimeout(() => {
          if (!settled) {
            child.kill("SIGTERM");
          }
        }, options.timeoutMs)
      : null;

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      settled = true;
      if (timeout) clearTimeout(timeout);
      resolve({
        command: [command, ...args].join(" "),
        exitCode: null,
        signal: null,
        stdout: "",
        stderr: sanitize(err.message)
      });
    });
    child.on("exit", (exitCode, signal) => {
      settled = true;
      if (timeout) clearTimeout(timeout);
      resolve({
        command: [command, ...args].join(" "),
        exitCode,
        signal,
        stdout: preview(stdout),
        stderr: preview(stderr)
      });
    });
  });
}

function spawnSpec(command: string, args: string[]): { command: string; args: string[] } {
  const resolvedCommand = process.platform === "win32" && command === "codex" ? "codex.cmd" : command;

  if (process.platform !== "win32") {
    return { command: resolvedCommand, args };
  }

  return {
    command: process.env.ComSpec ?? "cmd.exe",
    args: ["/d", "/s", "/c", [quoteCmdArg(resolvedCommand), ...args.map(quoteCmdArg)].join(" ")]
  };
}

function quoteCmdArg(value: string): string {
  if (/^[A-Za-z0-9_./:=+-]+$/.test(value)) {
    return value;
  }
  return `"${value.replace(/"/g, '\\"')}"`;
}

function listCodexHomeFiles(codexHome: string): string[] {
  if (!existsSync(codexHome)) {
    return [];
  }

  const names = ["auth.json", "config.toml", "sessions"];
  return names.filter((name) => existsSync(path.join(codexHome, name)));
}

async function runSdkProbe(options: ProbeOptions) {
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), options.timeoutMs);
  const eventCounts: Record<string, number> = {};
  let threadId: string | null = options.resumeThreadId ?? null;
  let finalResponse: string | null = null;
  let usage: unknown = null;
  let lastEventError: string | null = null;
  const env = commandEnv(options.codexHome) as Record<string, string>;

  const codex = new Codex({
    codexPathOverride: options.codexPath,
    env
  });

  const threadOptions: ThreadOptions = {
    workingDirectory: options.workdir,
    skipGitRepoCheck: options.skipGitRepoCheck,
    sandboxMode: "read-only",
    approvalPolicy: "never",
    networkAccessEnabled: false
  };

  if (options.model) {
    threadOptions.model = options.model;
  }

  const thread = options.resumeThreadId
    ? codex.resumeThread(options.resumeThreadId, threadOptions)
    : codex.startThread(threadOptions);

  try {
    if (options.stream) {
      const { events } = await thread.runStreamed(options.prompt, {
        signal: abort.signal
      });

      for await (const event of events) {
        eventCounts[event.type] = (eventCounts[event.type] ?? 0) + 1;
        const extracted = extractEventSummary(event);
        if (extracted.threadId) threadId = extracted.threadId;
        if (extracted.finalResponse) finalResponse = extracted.finalResponse;
        if (extracted.usage) usage = extracted.usage;
        if (extracted.error) lastEventError = extracted.error;
      }
    } else {
      const turn = await thread.run(options.prompt, {
        signal: abort.signal
      });
      threadId = thread.id;
      finalResponse = turn.finalResponse;
      usage = turn.usage;
      eventCounts["buffered.turn"] = 1;
    }

    return {
      status: "ok" as const,
      threadId,
      resumed: Boolean(options.resumeThreadId),
      eventCounts,
      finalResponsePreview: finalResponse ? preview(finalResponse) : null,
      usage,
      error: null
    };
  } catch (err) {
    return {
      status: "failed" as const,
      threadId,
      resumed: Boolean(options.resumeThreadId),
      eventCounts,
      finalResponsePreview: finalResponse ? preview(finalResponse) : null,
      usage,
      error: sanitize(
        [lastEventError, err instanceof Error ? err.message : String(err)]
          .filter(Boolean)
          .join("; thrown: ")
      )
    };
  } finally {
    clearTimeout(timeout);
  }
}

function extractEventSummary(event: ThreadEvent): {
  threadId?: string;
  finalResponse?: string;
  usage?: unknown;
  error?: string;
} {
  if (event.type === "thread.started") {
    return { threadId: event.thread_id };
  }
  if (event.type === "turn.completed") {
    return { usage: event.usage };
  }
  if (event.type === "turn.failed") {
    return { error: event.error.message };
  }
  if (event.type === "error") {
    return { error: event.message };
  }
  if (event.type === "item.completed" && event.item.type === "agent_message") {
    return { finalResponse: event.item.text };
  }
  return {};
}

function recommendation(report: Omit<ProbeReport, "recommendation">): string {
  if (report.sdk?.status === "ok") {
    return "Codex SDK run succeeded. Next: verify resume with --resume-thread-id and map streamed events into ProviderAdapter.message().";
  }

  if (report.sdk?.status === "failed") {
    return "Codex SDK run failed. Check whether CODEX_HOME is logged in, whether the selected model is available, and whether Codex can run non-interactively in this environment.";
  }

  if (report.codexCli.loginStatus.exitCode === 0) {
    return "Codex login status is available. Run again with --run to test SDK thread creation and streaming.";
  }

  return "CODEX_HOME is not logged in or Codex CLI could not read auth. Log in with the same CODEX_HOME, then rerun with --run.";
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  mkdirSync(options.codexHome, { recursive: true });
  if (!existsSync(options.workdir) || !statSync(options.workdir).isDirectory()) {
    throw new Error(`Workdir does not exist or is not a directory: ${options.workdir}`);
  }

  const env = commandEnv(options.codexHome);
  const command = options.codexPath ?? "codex";
  const [version, loginStatus, appServerHelp] = await Promise.all([
    runCommand(command, ["--version"], { cwd: options.workdir, env, timeoutMs: 15_000 }),
    runCommand(command, ["login", "status"], { cwd: options.workdir, env, timeoutMs: 15_000 }),
    runCommand(command, ["app-server", "--help"], { cwd: options.workdir, env, timeoutMs: 15_000 })
  ]);

  const { prompt: _prompt, ...safeOptions } = options;
  const skippedSdk = {
    status: "skipped" as const,
    threadId: null,
    resumed: false,
    eventCounts: {},
    finalResponsePreview: null,
    usage: null,
    error: null
  };

  const baseReport: Omit<ProbeReport, "recommendation"> = {
    generatedAt: new Date().toISOString(),
    options: {
      ...safeOptions,
      promptPreview: preview(options.prompt)
    },
    environment: {
      platform: process.platform,
      node: process.version,
      cwd: process.cwd(),
      codexHomeExists: existsSync(options.codexHome),
      codexHomeFiles: listCodexHomeFiles(options.codexHome)
    },
    codexCli: {
      version,
      loginStatus,
      appServerHelp
    },
    sdk: options.runSdk ? await runSdkProbe(options) : skippedSdk
  };

  const report: ProbeReport = {
    ...baseReport,
    recommendation: recommendation(baseReport)
  };

  console.log(JSON.stringify(report, null, 2));

  if (report.sdk?.status === "failed") {
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(sanitize(err instanceof Error ? err.message : String(err)));
    process.exitCode = 1;
  });
}
