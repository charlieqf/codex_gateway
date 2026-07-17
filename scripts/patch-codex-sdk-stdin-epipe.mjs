import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SUPPORTED_SDK_VERSION = "0.144.1";
const ORIGINAL_SOURCE_SHA256 =
  "3e5f6e013cf5d0bf9a93072a6c45d23d9eac05b282ceb9bca97ca157bb04ab92";
const PATCHED_SOURCE_SHA256 =
  "3c8fab41ac16cb4a0808ae410b97d9ed5f4b3d248d01cb4dfe551088edd4f56a";

const STDIN_WRITE_BEFORE = `    let spawnError = null;
    child.once("error", (err) => spawnError = err);
    if (!child.stdin) {
      child.kill();
      throw new Error("Child process has no stdin");
    }
    child.stdin.write(args.input);
    child.stdin.end();`;

const STDIN_WRITE_AFTER = `    let spawnError = null;
    let stdinError = null;
    child.once("error", (err) => spawnError = err);
    if (!child.stdin) {
      child.kill();
      throw new Error("Child process has no stdin");
    }
    child.stdin.on("error", (err) => {
      stdinError ??= err;
    });
    child.stdin.write(args.input);
    child.stdin.end();`;

const EXIT_CHECK_BEFORE = `      if (spawnError) throw spawnError;
      const { code, signal } = await exitPromise;
      if (code !== 0 || signal) {`;

const EXIT_CHECK_AFTER = `      if (spawnError) throw spawnError;
      const { code, signal } = await exitPromise;
      if (stdinError && !args.signal?.aborted) throw stdinError;
      if (code !== 0 || signal) {`;

export function patchCodexSdkSource(source) {
  const hasPatchedWrite = source.includes(STDIN_WRITE_AFTER);
  const hasPatchedExit = source.includes(EXIT_CHECK_AFTER);
  if (hasPatchedWrite && hasPatchedExit) {
    return { source, status: "already-patched" };
  }

  if (
    hasPatchedWrite ||
    hasPatchedExit ||
    occurrences(source, STDIN_WRITE_BEFORE) !== 1 ||
    occurrences(source, EXIT_CHECK_BEFORE) !== 1
  ) {
    throw new Error(
      "Codex SDK stdin patch did not find the exact expected vulnerable source."
    );
  }

  return {
    source: source
      .replace(STDIN_WRITE_BEFORE, STDIN_WRITE_AFTER)
      .replace(EXIT_CHECK_BEFORE, EXIT_CHECK_AFTER),
    status: "patched"
  };
}

export async function patchCodexSdkStdinEpipe(options = {}) {
  const repositoryRoot = options.repositoryRoot ?? repositoryRootFromScript();
  const sdkRoot =
    options.sdkRoot ??
    join(repositoryRoot, "node_modules", "@openai", "codex-sdk");
  const packageJsonPath = join(sdkRoot, "package.json");
  const sourcePath = join(sdkRoot, "dist", "index.js");

  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
  if (packageJson.version !== SUPPORTED_SDK_VERSION) {
    throw new Error(
      `Refusing to patch @openai/codex-sdk ${String(
        packageJson.version
      )}; expected ${SUPPORTED_SDK_VERSION}. Review and remove or update the patch before upgrading.`
    );
  }

  const source = await readFile(sourcePath, "utf8");
  const sourceHash = sha256(source);
  if (
    sourceHash !== ORIGINAL_SOURCE_SHA256 &&
    sourceHash !== PATCHED_SOURCE_SHA256
  ) {
    throw new Error(
      `Refusing to patch unexpected @openai/codex-sdk source (sha256 ${sourceHash}).`
    );
  }

  const result = patchCodexSdkSource(source);
  const resultHash = sha256(result.source);
  if (resultHash !== PATCHED_SOURCE_SHA256) {
    throw new Error(
      `Patched @openai/codex-sdk source has unexpected sha256 ${resultHash}.`
    );
  }

  if (result.status === "patched") {
    await writeFile(sourcePath, result.source, "utf8");
  }
  return result.status;
}

function repositoryRootFromScript() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function occurrences(source, fragment) {
  return source.split(fragment).length - 1;
}

function isMainModule() {
  return process.argv[1]
    ? resolve(process.argv[1]) === fileURLToPath(import.meta.url)
    : false;
}

if (isMainModule()) {
  const status = await patchCodexSdkStdinEpipe();
  console.log(`@openai/codex-sdk stdin EPIPE patch: ${status}`);
}
