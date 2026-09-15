import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import {
  GatewayError,
  type RateLimitPolicy,
  type ResearchStore,
  type ResearchWorkerStore
} from "@codex-gateway/core";
import { probeResearchStorageAdmission } from "@codex-gateway/research-agent";
import { createResearchSqliteStore } from "@codex-gateway/store-sqlite";
import { parseDoctorResearchRunRequest, type ResearchIdentityRegistryEntry } from "../research-routes.js";
import { parseRequiredNonNegativeIntegerEnv, parseRequiredPositiveIntegerEnv } from "./env.js";

function parseRequiredResearchSecondsEnv(
  value: string | undefined,
  name: string
): number {
  const seconds = parseRequiredPositiveIntegerEnv(value, name);
  if (!Number.isSafeInteger(seconds * 1_000)) {
    throw new Error(`${name} exceeds the safe millisecond range.`);
  }
  return seconds;
}

export interface ResearchLlmReadinessRequirements {
  maximumPromptTokensPerCall: number;
  maximumOutputTokensPerCall: number;
  callsPerRun: number;
  concurrentCalls: number;
  maximumTokensPerRun: number;
}

export function parseResearchLlmReadinessRequirements(input: {
  maximum_prompt_tokens_per_call?: string;
  maximum_output_tokens_per_call?: string;
  calls_per_run?: string;
  concurrent_calls?: string;
  maximum_tokens_per_run?: string;
}): ResearchLlmReadinessRequirements {
  const maximumPromptTokensPerCall = boundedReadinessInteger(
    input.maximum_prompt_tokens_per_call,
    "maximum_prompt_tokens_per_call",
    1_000_000
  );
  const maximumOutputTokensPerCall = boundedReadinessInteger(
    input.maximum_output_tokens_per_call,
    "maximum_output_tokens_per_call",
    100_000
  );
  const callsPerRun = boundedReadinessInteger(
    input.calls_per_run,
    "calls_per_run",
    32
  );
  const concurrentCalls =
    input.concurrent_calls === undefined
      ? 1
      : boundedReadinessInteger(
          input.concurrent_calls,
          "concurrent_calls",
          4
        );
  const maximumTokensPerRun = boundedReadinessInteger(
    input.maximum_tokens_per_run,
    "maximum_tokens_per_run",
    1_100_000
  );
  if (
    concurrentCalls > callsPerRun ||
    maximumTokensPerRun <
      maximumPromptTokensPerCall + maximumOutputTokensPerCall
  ) {
    throw researchReadinessInvalidRequest(
      "Research LLM readiness concurrency or token requirements are inconsistent."
    );
  }
  return {
    maximumPromptTokensPerCall,
    maximumOutputTokensPerCall,
    callsPerRun,
    concurrentCalls,
    maximumTokensPerRun
  };
}

function boundedReadinessInteger(
  value: string | undefined,
  name: string,
  maximum: number
): number {
  const normalized = value?.trim();
  if (!normalized || !/^[1-9][0-9]*$/u.test(normalized)) {
    throw researchReadinessInvalidRequest(
      `${name} must be a positive integer.`
    );
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed > maximum) {
    throw researchReadinessInvalidRequest(
      `${name} exceeds its controlled-beta bound.`
    );
  }
  return parsed;
}

export function researchReadinessInvalidRequest(message: string): GatewayError {
  return new GatewayError({
    code: "invalid_request",
    message,
    httpStatus: 400
  });
}

export function createDefaultResearchRuntime(
  env: NodeJS.ProcessEnv,
  logger: { info(message: string): void }
): {
  store: ResearchStore;
  workerHealthStore: Pick<ResearchWorkerStore, "listWorkerHeartbeats">;
  readRatePolicy: RateLimitPolicy;
  mutationRatePolicy: RateLimitPolicy;
  acceptWhenWorkerUnavailable: boolean;
  workerStaleAfterSeconds: number;
  artifactRoot: string;
  maximumArtifactBytes: number;
  admissionGuard: (now: Date) => Promise<GatewayError | null>;
  officialSourceMode: "brave" | "serpapi" | "direct";
  officialWebAllowedDomains: string[];
  officialIdentityRegistry: ResearchIdentityRegistryEntry[];
  identityAgentEnabled: boolean;
} | null {
  if (!parseResearchEnabled(env.RESEARCH_API_ENABLED)) {
    return null;
  }
  const databasePath = env.RESEARCH_DB_PATH?.trim();
  if (!databasePath) {
    throw new Error(
      "RESEARCH_DB_PATH is required when Research API is enabled."
    );
  }
  assertDedicatedResearchDatabasePath(databasePath, env);
  const artifactRoot = env.RESEARCH_ARTIFACT_ROOT?.trim();
  if (!artifactRoot) {
    throw new Error(
      "RESEARCH_ARTIFACT_ROOT is required when Research API is enabled."
    );
  }
  const officialSourceMode = parseResearchOfficialSourceMode(
    env.RESEARCH_WEB_SEARCH_PROVIDER
  );
  if (
    env.NODE_ENV?.trim().toLowerCase() === "production" &&
    officialSourceMode === "direct"
  ) {
    throw new Error(
      "Production Doctor Research requires general identity search; direct mode is staging-only."
    );
  }
  const officialWebAllowedDomains =
    parseResearchOfficialWebAllowedDomains(
      env.RESEARCH_OFFICIAL_WEB_ALLOWED_DOMAINS,
      env.NODE_ENV
    );
  const identityAgentEnabled = parseResearchBoolean(env.RESEARCH_IDENTITY_AGENT_ENABLED, false, "RESEARCH_IDENTITY_AGENT_ENABLED");
  const officialIdentityRegistry = identityAgentEnabled ? [] : loadResearchOfficialIdentityRegistry(
    env,
    officialWebAllowedDomains
  );
  const readRpm = parseRequiredPositiveIntegerEnv(
    env.RESEARCH_CONTROL_READ_RPM,
    "RESEARCH_CONTROL_READ_RPM"
  );
  const mutationRpm = parseRequiredPositiveIntegerEnv(
    env.RESEARCH_CONTROL_MUTATION_RPM,
    "RESEARCH_CONTROL_MUTATION_RPM"
  );
  const maximumCheckpointBytes = parseRequiredPositiveIntegerEnv(
    env.RESEARCH_MAX_CHECKPOINT_BYTES,
    "RESEARCH_MAX_CHECKPOINT_BYTES"
  );
  const maximumResultBytes = parseRequiredPositiveIntegerEnv(
    env.RESEARCH_MAX_RESULT_BYTES,
    "RESEARCH_MAX_RESULT_BYTES"
  );
  const maximumArtifactBytes = parseRequiredPositiveIntegerEnv(
    env.RESEARCH_MAX_ARTIFACT_BYTES,
    "RESEARCH_MAX_ARTIFACT_BYTES"
  );
  if (
    maximumCheckpointBytes > 10 * 1_024 * 1_024 ||
    maximumResultBytes > 10 * 1_024 * 1_024 ||
    maximumArtifactBytes > 10 * 1_024 * 1_024
  ) {
    throw new Error(
      "Research checkpoint, result, and artifact byte limits must not exceed 10 MiB."
    );
  }
  const acceptWhenWorkerUnavailable = parseResearchBoolean(
    env.RESEARCH_ACCEPT_WHEN_WORKER_UNAVAILABLE,
    false,
    "RESEARCH_ACCEPT_WHEN_WORKER_UNAVAILABLE"
  );
  if (acceptWhenWorkerUnavailable) {
    throw new Error(
      "RESEARCH_ACCEPT_WHEN_WORKER_UNAVAILABLE must remain false for the controlled beta."
    );
  }
  const workerStaleAfterSeconds = parseRequiredResearchSecondsEnv(
    env.RESEARCH_HEARTBEAT_STALE_SECONDS,
    "RESEARCH_HEARTBEAT_STALE_SECONDS"
  );
  const maximumStorageBytes = parseRequiredPositiveIntegerEnv(
    env.RESEARCH_MAX_STORAGE_BYTES,
    "RESEARCH_MAX_STORAGE_BYTES"
  );
  const minimumFreeBytes = parseRequiredPositiveIntegerEnv(
    env.RESEARCH_MIN_FREE_BYTES,
    "RESEARCH_MIN_FREE_BYTES"
  );
  const minimumFreePercent = parseRequiredPositiveIntegerEnv(
    env.RESEARCH_MIN_FREE_PERCENT,
    "RESEARCH_MIN_FREE_PERCENT"
  );
  if (minimumFreePercent > 100) {
    throw new Error("RESEARCH_MIN_FREE_PERCENT must not exceed 100.");
  }
  const backupMaxAgeSeconds = parseRequiredResearchSecondsEnv(
    env.RESEARCH_BACKUP_MAX_AGE_SECONDS,
    "RESEARCH_BACKUP_MAX_AGE_SECONDS"
  );
  const resolvedArtifactRoot = path.resolve(artifactRoot);
  const researchStorageRoot =
    databasePath === ":memory:"
      ? resolvedArtifactRoot
      : assertResearchStorageLayout(databasePath, resolvedArtifactRoot);
  const store = createResearchSqliteStore({
    path: databasePath,
    limits: {
      dailyRunsPerSubject: parseRequiredPositiveIntegerEnv(
        env.RESEARCH_MAX_DAILY_RUNS_PER_SUBJECT,
        "RESEARCH_MAX_DAILY_RUNS_PER_SUBJECT"
      ),
      uniqueDoctors30dPerSubject: parseRequiredNonNegativeIntegerEnv(
        env.RESEARCH_MAX_UNIQUE_DOCTORS_PER_SUBJECT_30D,
        "RESEARCH_MAX_UNIQUE_DOCTORS_PER_SUBJECT_30D"
      ),
      globalActiveRuns: parseRequiredPositiveIntegerEnv(
        env.RESEARCH_MAX_QUEUED_RUNS,
        "RESEARCH_MAX_QUEUED_RUNS"
      ),
      needsInputPerSubject: parseRequiredPositiveIntegerEnv(
        env.RESEARCH_MAX_NEEDS_INPUT_PER_SUBJECT,
        "RESEARCH_MAX_NEEDS_INPUT_PER_SUBJECT"
      )
    },
    idempotencyReplaySeconds: parseRequiredResearchSecondsEnv(
      env.RESEARCH_IDEMPOTENCY_REPLAY_SECONDS,
      "RESEARCH_IDEMPOTENCY_REPLAY_SECONDS"
    ),
    idempotencyTombstoneSeconds: parseRequiredResearchSecondsEnv(
      env.RESEARCH_IDEMPOTENCY_TOMBSTONE_SECONDS,
      "RESEARCH_IDEMPOTENCY_TOMBSTONE_SECONDS"
    ),
    resultTtlSeconds: parseRequiredResearchSecondsEnv(
      env.RESEARCH_RESULT_TTL_SECONDS,
      "RESEARCH_RESULT_TTL_SECONDS"
    ),
    runRetentionSeconds: parseRequiredResearchSecondsEnv(
      env.RESEARCH_RUN_RETENTION_SECONDS,
      "RESEARCH_RUN_RETENTION_SECONDS"
    ),
    needsInputTtlSeconds: parseRequiredResearchSecondsEnv(
      env.RESEARCH_NEEDS_INPUT_TTL_SECONDS,
      "RESEARCH_NEEDS_INPUT_TTL_SECONDS"
    ),
    maximumCheckpointBytes,
    maximumResultBytes,
    logger
  });
  return {
    store,
    workerHealthStore: store,
    readRatePolicy: researchControlRatePolicy(readRpm),
    mutationRatePolicy: researchControlRatePolicy(mutationRpm),
    acceptWhenWorkerUnavailable,
    workerStaleAfterSeconds,
    artifactRoot: resolvedArtifactRoot,
    maximumArtifactBytes,
    officialSourceMode,
    officialWebAllowedDomains,
    officialIdentityRegistry,
    identityAgentEnabled,
    admissionGuard: async (now) => {
      const latestBackup = store.latestSuccessfulBackupAt();
      if (
        latestBackup === null ||
        now.getTime() - latestBackup.getTime() >
          backupMaxAgeSeconds * 1_000
      ) {
        return new GatewayError({
          code: "research_backup_stale",
          message: "Research backups are stale.",
          httpStatus: 503,
          retryAfterSeconds: 60
        });
      }
      const report = await probeResearchStorageAdmission({
        filesystemPath: resolvedArtifactRoot,
        researchRoot: researchStorageRoot,
        policy: {
          minimumFreeBytes,
          minimumFreePercent,
          maximumResearchBytes: maximumStorageBytes
        }
      });
      return report.available
        ? null
        : new GatewayError({
            code: "research_storage_unavailable",
            message: "Research storage is unavailable.",
            httpStatus: 503,
            retryAfterSeconds: 60
          });
    }
  };
}

function assertResearchStorageLayout(
  databasePath: string,
  artifactRoot: string
): string {
  const databaseDirectory = path.dirname(path.resolve(databasePath));
  const relativeArtifactPath = path.relative(databaseDirectory, artifactRoot);
  if (
    relativeArtifactPath === "" ||
    relativeArtifactPath === ".." ||
    relativeArtifactPath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeArtifactPath)
  ) {
    throw new Error(
      "RESEARCH_ARTIFACT_ROOT must be a child of the Research database directory."
    );
  }
  return databaseDirectory;
}

function parseResearchEnabled(value: string | undefined): boolean {
  if (value === undefined || value.trim() === "") {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1") {
    return true;
  }
  if (normalized === "false" || normalized === "0") {
    return false;
  }
  throw new Error("RESEARCH_API_ENABLED must be true/false or 1/0.");
}

function parseResearchBoolean(
  value: string | undefined,
  fallback: boolean,
  name: string
): boolean {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1") {
    return true;
  }
  if (normalized === "false" || normalized === "0") {
    return false;
  }
  throw new Error(`${name} must be true/false or 1/0.`);
}

function parseResearchOfficialSourceMode(
  value: string | undefined
): "brave" | "serpapi" | "direct" {
  const normalized = value?.trim().toLowerCase();
  if (
    normalized === "brave" ||
    normalized === "serpapi" ||
    normalized === "direct"
  ) {
    return normalized;
  }
  throw new Error(
    "RESEARCH_WEB_SEARCH_PROVIDER must be brave, serpapi, or direct when Research API is enabled."
  );
}

function parseResearchOfficialWebAllowedDomains(
  value: string | undefined,
  nodeEnvironment: string | undefined
): string[] {
  const domains = (value ?? "")
    .split(",")
    .map((domain) => domain.trim().toLowerCase().replace(/^\./u, ""))
    .filter(Boolean);
  if (
    domains.length === 0 ||
    domains.length > 10 ||
    new Set(domains).size !== domains.length ||
    domains.reduce((total, domain) => total + domain.length + 7, 0) >
      1_600 ||
    domains.some(
      (domain) =>
        domain.length > 100 ||
        !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u.test(
          domain
        )
    )
  ) {
    throw new Error(
      "RESEARCH_OFFICIAL_WEB_ALLOWED_DOMAINS must contain unique valid DNS domains."
    );
  }
  if (
    ["staging", "production"].includes(
      nodeEnvironment?.trim().toLowerCase() ?? ""
    ) &&
    domains.some((domain) => domain.endsWith(".example"))
  ) {
    throw new Error(
      "RESEARCH_OFFICIAL_WEB_ALLOWED_DOMAINS placeholders must be replaced."
    );
  }
  return domains;
}

function loadResearchOfficialIdentityRegistry(
  env: NodeJS.ProcessEnv,
  allowedDomains: readonly string[]
): ResearchIdentityRegistryEntry[] {
  const inlineRegistry = parseResearchOfficialIdentityRegistry(
    env.RESEARCH_OFFICIAL_PROFILE_REGISTRY_JSON,
    allowedDomains
  );
  const configuredPath =
    env.RESEARCH_OFFICIAL_PROFILE_REGISTRY_PATH?.trim();
  if (!configuredPath) {
    return inlineRegistry;
  }
  if (
    configuredPath.length > 4_096 ||
    configuredPath.includes("\0") ||
    !path.isAbsolute(configuredPath)
  ) {
    throw new Error(
      "RESEARCH_OFFICIAL_PROFILE_REGISTRY_PATH must be an absolute file path."
    );
  }
  let raw: string;
  try {
    raw = readFileSync(configuredPath, "utf8");
  } catch {
    throw new Error(
      "RESEARCH_OFFICIAL_PROFILE_REGISTRY_PATH could not be read."
    );
  }
  if (Buffer.byteLength(raw, "utf8") > 65_536) {
    throw new Error(
      "RESEARCH_OFFICIAL_PROFILE_REGISTRY_PATH exceeds 65536 bytes."
    );
  }
  let document: unknown;
  try {
    document = JSON.parse(raw);
  } catch {
    throw new Error(
      "RESEARCH_OFFICIAL_PROFILE_REGISTRY_PATH must contain valid JSON."
    );
  }
  if (
    typeof document !== "object" ||
    document === null ||
    Array.isArray(document) ||
    Object.keys(document).some(
      (key) => !["schema_version", "entries"].includes(key)
    ) ||
    (document as { schema_version?: unknown }).schema_version !==
      "doctor_research_official_identity_registry.v1" ||
    !Array.isArray((document as { entries?: unknown }).entries)
  ) {
    throw new Error(
      "RESEARCH_OFFICIAL_PROFILE_REGISTRY_PATH has an invalid registry document."
    );
  }
  const fileRegistry = parseResearchOfficialIdentityRegistry(
    JSON.stringify((document as { entries: unknown[] }).entries),
    allowedDomains
  );
  if (fileRegistry.length === 0) {
    throw new Error(
      "RESEARCH_OFFICIAL_PROFILE_REGISTRY_PATH must contain at least one entry."
    );
  }
  if (
    inlineRegistry.length > 0 &&
    JSON.stringify(inlineRegistry) !== JSON.stringify(fileRegistry)
  ) {
    throw new Error(
      "RESEARCH_OFFICIAL_PROFILE_REGISTRY_JSON must match the versioned registry file."
    );
  }
  return fileRegistry;
}

function parseResearchOfficialIdentityRegistry(
  value: string | undefined,
  allowedDomains: readonly string[]
): ResearchIdentityRegistryEntry[] {
  const raw = value?.trim();
  if (!raw) {
    return [];
  }
  if (raw.length > 65_536) {
    throw new Error(
      "RESEARCH_OFFICIAL_PROFILE_REGISTRY_JSON exceeds 65536 characters."
    );
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    throw new Error(
      "RESEARCH_OFFICIAL_PROFILE_REGISTRY_JSON must be valid JSON."
    );
  }
  if (!Array.isArray(decoded) || decoded.length > 100) {
    throw new Error(
      "RESEARCH_OFFICIAL_PROFILE_REGISTRY_JSON must be an array of at most 100 entries."
    );
  }
  const entries = decoded.map((doctor, index) => {
    try {
      const parsed = parseDoctorResearchRunRequest(
        {
          doctor,
          mode: "brief",
          language: "zh-CN",
          options: {
            publication_years: 5,
            citation_style: "vancouver"
          }
        },
        {
          officialSourceMode: "direct",
          officialWebAllowedDomains: allowedDomains
        }
      );
      const officialProfileUrls =
        parsed.input.doctor.officialProfileUrls ?? [];
      if (officialProfileUrls.length === 0) {
        throw new Error("official_profile_urls is required");
      }
      return {
        identityFingerprint: parsed.identityFingerprint,
        officialProfileUrls,
        ...(parsed.input.doctor.literatureIdentity
          ? {
              literatureIdentity:
                parsed.input.doctor.literatureIdentity
            }
          : {})
      } satisfies ResearchIdentityRegistryEntry;
    } catch {
      throw new Error(
        `RESEARCH_OFFICIAL_PROFILE_REGISTRY_JSON entry ${index + 1} is invalid.`
      );
    }
  });
  if (
    new Set(entries.map((entry) => entry.identityFingerprint)).size !==
    entries.length
  ) {
    throw new Error(
      "RESEARCH_OFFICIAL_PROFILE_REGISTRY_JSON contains duplicate doctor identity anchors."
    );
  }
  return entries;
}

function assertDedicatedResearchDatabasePath(
  databasePath: string,
  env: NodeJS.ProcessEnv
): void {
  if (
    databasePath === ":memory:" &&
    env.NODE_ENV?.trim().toLowerCase() === "production"
  ) {
    throw new Error("RESEARCH_DB_PATH cannot be :memory: in production.");
  }
  if (databasePath === ":memory:") {
    return;
  }
  const researchPath = comparableFilesystemPath(databasePath);
  for (const [name, configuredPath] of [
    ["GATEWAY_SQLITE_PATH", env.GATEWAY_SQLITE_PATH],
    [
      "GATEWAY_CLIENT_EVENTS_SQLITE_PATH",
      env.GATEWAY_CLIENT_EVENTS_SQLITE_PATH
    ]
  ] as const) {
    if (
      configuredPath &&
      configuredPath !== ":memory:" &&
      comparableFilesystemPath(configuredPath) === researchPath
    ) {
      throw new Error(`RESEARCH_DB_PATH must not reuse ${name}.`);
    }
  }
}

function comparableFilesystemPath(value: string): string {
  const resolved = path.resolve(value.trim());
  let canonical = resolved;
  try {
    canonical = realpathSync.native(resolved);
  } catch {
    try {
      canonical = path.join(
        realpathSync.native(path.dirname(resolved)),
        path.basename(resolved)
      );
    } catch {
      canonical = resolved;
    }
  }
  return process.platform === "win32"
    ? canonical.toLowerCase()
    : canonical;
}

export function isResearchWorkerHealthStore(
  value: ResearchStore | undefined
): value is ResearchStore &
  Pick<ResearchWorkerStore, "listWorkerHeartbeats"> {
  return (
    value !== undefined &&
    typeof (value as Partial<ResearchWorkerStore>).listWorkerHeartbeats ===
      "function"
  );
}

export function researchControlRatePolicy(
  requestsPerMinute: number
): RateLimitPolicy {
  return {
    requestsPerMinute,
    requestsPerDay: null,
    concurrentRequests: null
  };
}
