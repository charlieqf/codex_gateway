import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  link,
  mkdir,
  open,
  readdir,
  realpath,
  rm
} from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

const maximumJsonBytes = 5_000_000;
const maximumArtifactBytes = 1_048_576;
const maximumWaitSeconds = 7_200;
const requiredKinds = ["profile", "review", "questions", "answers"];
const outputFilenames = {
  profile: "profile.md",
  review: "frontier-review.md",
  questions: "predicted-questions.txt",
  answers: "questions-and-answers.md"
};

try {
  const baseUrl = validatedLoopbackBaseUrl(
    process.env.RESEARCH_SMOKE_BASE_URL ?? "http://127.0.0.1:18788"
  );
  const token = await readSecret(
    requiredEnv("RESEARCH_SMOKE_USER_TOKEN_FILE")
  );
  const payload = await readPayload(
    requiredEnv("RESEARCH_SMOKE_REQUEST_FILE")
  );
  const outputDirectory = path.resolve(
    requiredEnv("RESEARCH_SMOKE_OUTPUT_DIR")
  );
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  const outputMetadata = await lstat(outputDirectory);
  if (
    !outputMetadata.isDirectory() ||
    outputMetadata.isSymbolicLink() ||
    (process.platform !== "win32" &&
      (await realpath(outputDirectory)) !== outputDirectory) ||
    (await readdir(outputDirectory)).length !== 0
  ) {
    throw new Error(
      "Research smoke output directory must be a canonical empty directory."
    );
  }
  if (process.platform !== "win32") {
    await chmod(outputDirectory, 0o700);
  }
  const idempotencyKey = `research:smoke:${randomUUID()}`;
  const run = await requestJson(
    new URL("/gateway/research/v1/doctor-runs", baseUrl),
    token,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": idempotencyKey
      },
      body: JSON.stringify(payload)
    }
  );
  const runId = requiredId(run.run_id, /^drr_[a-f0-9]{32}$/u, "run ID");
  const deadline =
    Date.now() +
    boundedPositiveInteger(
      process.env.RESEARCH_SMOKE_MAX_WAIT_SECONDS ?? "1800",
      "RESEARCH_SMOKE_MAX_WAIT_SECONDS",
      maximumWaitSeconds
    ) *
      1_000;
  let status;
  for (;;) {
    const snapshot = await requestJson(
      new URL(`/gateway/research/v1/doctor-runs/${runId}`, baseUrl),
      token
    );
    status = snapshot.status;
    if (
      status === "succeeded" ||
      status === "failed" ||
      status === "cancelled" ||
      status === "expired" ||
      status === "needs_input"
    ) {
      break;
    }
    if (status !== "queued" && status !== "running") {
      throw new Error("Research smoke received an unknown run status.");
    }
    if (Date.now() >= deadline) {
      throw new Error("Research smoke exceeded its bounded wait time.");
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  if (status !== "succeeded") {
    throw new Error(`Research smoke reached non-success terminal status: ${status}.`);
  }
  const result = await requestJson(
    new URL(`/gateway/research/v1/doctor-runs/${runId}/result`, baseUrl),
    token
  );
  if (
    result.schema_version !== "doctor_research_result.v1" ||
    result.run_id !== runId
  ) {
    throw new Error("Research smoke result identity is invalid.");
  }
  if (!Array.isArray(result.artifacts) || result.artifacts.length !== 4) {
    throw new Error("Research smoke result did not contain exactly four artifacts.");
  }
  const artifacts = new Map();
  for (const artifact of result.artifacts) {
    if (!isRecord(artifact) || typeof artifact.kind !== "string") {
      throw new Error("Research smoke artifact manifest is invalid.");
    }
    if (artifacts.has(artifact.kind) || !requiredKinds.includes(artifact.kind)) {
      throw new Error("Research smoke artifact kinds are invalid or duplicated.");
    }
    artifacts.set(artifact.kind, artifact);
  }
  if (requiredKinds.some((kind) => !artifacts.has(kind))) {
    throw new Error("Research smoke artifact set is incomplete.");
  }

  const verified = [];
  for (const kind of requiredKinds) {
    const artifact = artifacts.get(kind);
    const artifactId = requiredId(
      artifact.artifact_id,
      /^dra_[a-f0-9]{32}$/u,
      "artifact ID"
    );
    const expectedHash = requiredId(
      artifact.sha256,
      /^[a-f0-9]{64}$/u,
      "artifact hash"
    );
    const expectedSize = safeNonNegativeInteger(
      artifact.size_bytes,
      "artifact size"
    );
    if (expectedSize > maximumArtifactBytes) {
      throw new Error("Research smoke artifact exceeds the smoke byte bound.");
    }
    const response = await fetch(
      new URL(
        `/gateway/research/v1/artifacts/${artifactId}/download`,
        baseUrl
      ),
      {
        headers: {
          accept: kind === "questions" ? "text/plain" : "text/markdown",
          authorization: `Bearer ${token}`
        },
        redirect: "error",
        signal: AbortSignal.timeout(30_000)
      }
    );
    if (!response.ok) {
      throw new Error(
        `Research smoke artifact download failed with HTTP ${response.status}.`
      );
    }
    const expectedContentType =
      kind === "questions"
        ? "text/plain; charset=utf-8"
        : "text/markdown; charset=utf-8";
    if (
      response.headers.get("content-type") !== expectedContentType ||
      response.headers.get("x-content-type-options") !== "nosniff" ||
      response.headers.get("cache-control") !== "private, no-store" ||
      response.headers.get("content-length") !== String(expectedSize)
    ) {
      throw new Error(
        "Research smoke artifact response headers are invalid."
      );
    }
    const bytes = await readBounded(response, maximumArtifactBytes);
    const actualHash = createHash("sha256").update(bytes).digest("hex");
    if (bytes.length !== expectedSize || actualHash !== expectedHash) {
      throw new Error("Research smoke artifact integrity check failed.");
    }
    const filename = outputFilenames[kind];
    await atomicExclusiveWrite(outputDirectory, filename, bytes);
    verified.push({ kind, size_bytes: bytes.length, sha256: actualHash });
  }
  const writtenFilenames = (await readdir(outputDirectory)).sort();
  const expectedFilenames = Object.values(outputFilenames).sort();
  if (
    writtenFilenames.length !== expectedFilenames.length ||
    writtenFilenames.some(
      (filename, index) => filename !== expectedFilenames[index]
    )
  ) {
    throw new Error(
      "Research smoke output directory does not contain exactly four artifacts."
    );
  }
  process.stdout.write(
    `${JSON.stringify({
      outcome: "succeeded",
      run_id: runId,
      artifacts: verified
    })}\n`
  );
} catch (error) {
  process.stderr.write(
    `${JSON.stringify({
      outcome: "failed",
      error_type: error instanceof Error ? error.name : "unknown",
      message:
        error instanceof Error
          ? sanitizeError(error.message)
          : "Research smoke failed."
    })}\n`
  );
  process.exitCode = 1;
}

async function requestJson(url, token, init = {}) {
  const response = await fetch(url, {
    ...init,
    headers: {
      accept: "application/json",
      authorization: `Bearer ${token}`,
      ...(init.headers ?? {})
    },
    redirect: "error",
    signal: AbortSignal.timeout(30_000)
  });
  const bytes = await readBounded(response, maximumJsonBytes);
  if (!response.ok) {
    throw new Error(`Research smoke request failed with HTTP ${response.status}.`);
  }
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("Research smoke received invalid JSON.");
  }
  if (!isRecord(value)) {
    throw new Error("Research smoke received a non-object JSON response.");
  }
  return value;
}

async function readBounded(response, maximumBytes) {
  if (!response.body) {
    return Buffer.alloc(0);
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) {
        return Buffer.concat(chunks, size);
      }
      const chunk = Buffer.from(item.value);
      size += chunk.length;
      if (size > maximumBytes) {
        await reader.cancel("response byte limit exceeded");
        throw new Error("Research smoke response exceeded its byte bound.");
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
}

async function readSecret(filename) {
  const resolved = path.resolve(filename);
  const canonical = await realpath(resolved);
  if (process.platform !== "win32" && canonical !== resolved) {
    throw new Error("Research smoke token path is not canonical.");
  }
  const handle = await open(
    resolved,
    constants.O_RDONLY |
      (process.platform === "win32" ? 0 : constants.O_NOFOLLOW)
  );
  try {
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      metadata.size < 8 ||
      metadata.size > 16_384 ||
      (process.platform !== "win32" && (metadata.mode & 0o077) !== 0)
    ) {
      throw new Error("Research smoke token file is invalid.");
    }
    await assertCanonicalOpenHandle(handle.fd, resolved);
    const value = (await handle.readFile("utf8")).trim();
    if (
      value.length < 8 ||
      value.length > 8_192 ||
      /[\r\n\u0000]/u.test(value)
    ) {
      throw new Error("Research smoke token is invalid.");
    }
    return value;
  } finally {
    await handle.close();
  }
}

async function readPayload(filename) {
  const resolved = path.resolve(filename);
  const canonical = await realpath(resolved);
  if (process.platform !== "win32" && canonical !== resolved) {
    throw new Error("Research smoke request path is not canonical.");
  }
  const handle = await open(
    resolved,
    constants.O_RDONLY |
      (process.platform === "win32" ? 0 : constants.O_NOFOLLOW)
  );
  try {
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      metadata.size > 64_000 ||
      (process.platform !== "win32" && (metadata.mode & 0o077) !== 0)
    ) {
      throw new Error("Research smoke request file is invalid.");
    }
    await assertCanonicalOpenHandle(handle.fd, resolved);
    const value = JSON.parse(await handle.readFile("utf8"));
    if (!isRecord(value)) {
      throw new Error("Research smoke request must be a JSON object.");
    }
    return value;
  } finally {
    await handle.close();
  }
}

async function assertCanonicalOpenHandle(fileDescriptor, resolved) {
  if (
    process.platform === "linux" &&
    (await realpath(`/proc/self/fd/${fileDescriptor}`)) !== resolved
  ) {
    throw new Error("Research smoke input handle is not canonical.");
  }
}

async function atomicExclusiveWrite(root, filename, bytes) {
  const destination = path.resolve(root, filename);
  if (path.dirname(destination) !== root) {
    throw new Error("Research smoke output path escaped its root.");
  }
  const temporary = path.resolve(root, `.${filename}.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(temporary, destination);
    await rm(temporary);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function validatedLoopbackBaseUrl(value) {
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "Research smoke base URL must use an unauthenticated literal HTTP loopback address."
    );
  }
  return url;
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function positiveInteger(value, name) {
  if (!/^[1-9][0-9]*$/u.test(value)) {
    throw new Error(`${name} must be a positive integer.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${name} exceeds the safe integer range.`);
  }
  return parsed;
}

function boundedPositiveInteger(value, name, maximum) {
  const parsed = positiveInteger(value, name);
  if (parsed > maximum) {
    throw new Error(`${name} cannot exceed ${maximum}.`);
  }
  return parsed;
}

function safeNonNegativeInteger(value, description) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Research smoke ${description} is invalid.`);
  }
  return value;
}

function requiredId(value, pattern, description) {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`Research smoke ${description} is invalid.`);
  }
  return value;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeError(value) {
  return value
    .replace(/Bearer\s+\S+/giu, "Bearer [redacted]")
    .replace(
      /((?:api[_-]?key|access[_-]?token|client[_-]?secret|authorization)\s*[=:]\s*)[^\s&]+/giu,
      "$1[redacted]"
    )
    .replace(/cgu_live_[A-Za-z0-9_-]+/gu, "cgu_live_[redacted]")
    .slice(0, 500);
}
