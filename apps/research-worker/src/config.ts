import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import type { ResearchRunBudgetLimits } from "@codex-gateway/core";
import type {
  DoctorResearchWorkflowPolicy,
  LiveResearchAdapterOptions
} from "@codex-gateway/research-agent";

export interface ResearchWorkerConfig {
  databasePath: string;
  artifactRoot: string;
  backupRoot: string;
  workerId: string;
  processVersion: string;
  pollIntervalMs: number;
  drainTimeoutMs: number;
  leaseSeconds: number;
  leaseRenewSeconds: number;
  heartbeatSeconds: number;
  reconcileIntervalSeconds: number;
  cleanupIntervalSeconds: number;
  backupIntervalSeconds: number;
  backupMaxAgeMs: number;
  backupRetentionCount: number;
  embeddedMaintenanceEnabled: boolean;
  reconcileBatchSize: number;
  cleanupBatchSize: number;
  orphanGraceMs: number;
  storagePolicy: {
    maximumResearchBytes: number;
    minimumFreeBytes: number;
    minimumFreePercent: number;
  };
  ncbiApiKeyFile: string | null;
  webSearchApiKeyFile: string | null;
  adapterOptions: Omit<LiveResearchAdapterOptions, "orcid">;
  orcid:
    | { mode: "disabled" }
    | { mode: "anonymous" }
    | { mode: "bearer_file"; bearerTokenFile: string }
    | {
        mode: "client_credentials";
        clientIdFile: string;
        clientSecretFile: string;
      };
  llm: {
    baseUrl: string;
    allowedHosts: string[];
    model: string;
    reasoningEffort: "none" | "low" | "medium" | "high";
    bearerTokenFile: string;
    timeoutMs: number;
    maximumResponseBytes: number;
  };
  workflowPolicy: DoctorResearchWorkflowPolicy;
  admissionLimits: {
    dailyRunsPerSubject: number;
    uniqueDoctors30dPerSubject: number;
    globalActiveRuns: number;
    needsInputPerSubject: number;
  };
  store: {
    idempotencyReplaySeconds: number;
    idempotencyTombstoneSeconds: number;
    resultTtlSeconds: number;
    runRetentionSeconds: number;
    needsInputTtlSeconds: number;
    maximumCheckpointBytes: number;
    maximumResultBytes: number;
  };
}

export function loadResearchWorkerConfig(
  env: NodeJS.ProcessEnv
): ResearchWorkerConfig | null {
  if (!parseBoolean(env.RESEARCH_WORKER_ENABLED, false, "RESEARCH_WORKER_ENABLED")) {
    return null;
  }
  for (const name of [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy"
  ]) {
    if (env[name]?.trim()) {
      throw new Error(
        "Research Worker does not support outbound HTTP proxy configuration."
      );
    }
  }
  const concurrency = requiredPositiveInteger(
    env.RESEARCH_WORKER_CONCURRENCY,
    "RESEARCH_WORKER_CONCURRENCY"
  );
  if (concurrency !== 1) {
    throw new Error("RESEARCH_WORKER_CONCURRENCY must be exactly 1.");
  }
  const leaseSeconds = requiredSafeSeconds(
    env.RESEARCH_LEASE_SECONDS,
    "RESEARCH_LEASE_SECONDS"
  );
  const leaseRenewSeconds = requiredTimerSeconds(
    env.RESEARCH_LEASE_RENEW_SECONDS,
    "RESEARCH_LEASE_RENEW_SECONDS"
  );
  if (leaseRenewSeconds > Math.floor(leaseSeconds / 3)) {
    throw new Error(
      "RESEARCH_LEASE_RENEW_SECONDS must not exceed one third of the lease."
    );
  }
  const resultTtlSeconds = requiredSafeSeconds(
    env.RESEARCH_RESULT_TTL_SECONDS,
    "RESEARCH_RESULT_TTL_SECONDS"
  );
  const maximumArtifactBytes = boundedInteger(
    env.RESEARCH_MAX_ARTIFACT_BYTES,
    "RESEARCH_MAX_ARTIFACT_BYTES",
    10 * 1_024 * 1_024
  );
  const maximumRunArtifactBytes = boundedInteger(
    env.RESEARCH_MAX_ARTIFACT_BYTES_PER_RUN,
    "RESEARCH_MAX_ARTIFACT_BYTES_PER_RUN",
    40 * 1_024 * 1_024
  );
  if (maximumArtifactBytes > maximumRunArtifactBytes) {
    throw new Error(
      "RESEARCH_MAX_ARTIFACT_BYTES must not exceed RESEARCH_MAX_ARTIFACT_BYTES_PER_RUN."
    );
  }
  const artifactTtlSeconds = requiredSafeSeconds(
    env.RESEARCH_ARTIFACT_TTL_SECONDS,
    "RESEARCH_ARTIFACT_TTL_SECONDS"
  );
  if (artifactTtlSeconds !== resultTtlSeconds) {
    throw new Error(
      "RESEARCH_ARTIFACT_TTL_SECONDS must equal RESEARCH_RESULT_TTL_SECONDS."
    );
  }
  const budgets: ResearchRunBudgetLimits = {
    externalRequests: boundedInteger(
      env.RESEARCH_MAX_EXTERNAL_REQUESTS_PER_RUN,
      "RESEARCH_MAX_EXTERNAL_REQUESTS_PER_RUN",
      1_000
    ),
    externalResponseBytes: boundedInteger(
      env.RESEARCH_MAX_EXTERNAL_BYTES_PER_RUN,
      "RESEARCH_MAX_EXTERNAL_BYTES_PER_RUN",
      2_000_000_000
    ),
    llmCalls: boundedInteger(
      env.RESEARCH_MAX_LLM_CALLS_PER_RUN,
      "RESEARCH_MAX_LLM_CALLS_PER_RUN",
      3
    ),
    inputTokens: boundedInteger(
      env.RESEARCH_MAX_INPUT_TOKENS_PER_RUN,
      "RESEARCH_MAX_INPUT_TOKENS_PER_RUN",
      1_000_000
    ),
    outputTokens: boundedInteger(
      env.RESEARCH_MAX_OUTPUT_TOKENS_PER_RUN,
      "RESEARCH_MAX_OUTPUT_TOKENS_PER_RUN",
      300_000
    )
  };
  const orcidBearerTokenFile = optionalString(
    env.RESEARCH_ORCID_BEARER_TOKEN_FILE
  );
  const orcidClientIdFile = optionalString(
    env.RESEARCH_ORCID_CLIENT_ID_FILE
  );
  const orcidClientSecretFile = optionalString(
    env.RESEARCH_ORCID_CLIENT_SECRET_FILE
  );
  const orcidMode =
    optionalString(env.RESEARCH_ORCID_MODE) ??
    (orcidBearerTokenFile ? "bearer_file" : "client_credentials");
  const orcid =
    orcidMode === "disabled"
      ? ({ mode: "disabled" } as const)
      : orcidMode === "anonymous"
      ? ({ mode: "anonymous" } as const)
      : orcidMode === "bearer_file"
        ? ({
            mode: "bearer_file",
            bearerTokenFile: requiredString(
              orcidBearerTokenFile ?? undefined,
              "RESEARCH_ORCID_BEARER_TOKEN_FILE"
            )
          } as const)
        : orcidMode === "client_credentials"
          ? ({
              mode: "client_credentials",
              clientIdFile: requiredString(
                orcidClientIdFile ?? undefined,
                "RESEARCH_ORCID_CLIENT_ID_FILE"
              ),
              clientSecretFile: requiredString(
                orcidClientSecretFile ?? undefined,
                "RESEARCH_ORCID_CLIENT_SECRET_FILE"
              )
            } as const)
          : null;
  if (!orcid) {
    throw new Error(
      "RESEARCH_ORCID_MODE must be disabled, anonymous, bearer_file or client_credentials."
    );
  }
  if (
    orcid.mode === "disabled" &&
    (orcidBearerTokenFile ||
      orcidClientIdFile ||
      orcidClientSecretFile)
  ) {
    throw new Error(
      "Disabled ORCID mode must not configure credential files."
    );
  }
  if (
    orcid.mode === "anonymous" &&
    (orcidBearerTokenFile ||
      orcidClientIdFile ||
      orcidClientSecretFile)
  ) {
    throw new Error(
      "Anonymous ORCID mode must not configure credential files."
    );
  }
  const orcidAnonymousUseApproved = parseBoolean(
    env.RESEARCH_ORCID_ANONYMOUS_USE_APPROVED,
    false,
    "RESEARCH_ORCID_ANONYMOUS_USE_APPROVED"
  );
  if (
    orcid.mode === "anonymous" &&
    env.NODE_ENV?.trim().toLowerCase() === "production" &&
    !orcidAnonymousUseApproved
  ) {
    throw new Error(
      "RESEARCH_ORCID_ANONYMOUS_USE_APPROVED=true is required for anonymous ORCID use in production."
    );
  }
  const webProvider = requiredString(
    env.RESEARCH_WEB_SEARCH_PROVIDER,
    "RESEARCH_WEB_SEARCH_PROVIDER"
  );
  if (webProvider !== "brave" && webProvider !== "direct") {
    throw new Error(
      "RESEARCH_WEB_SEARCH_PROVIDER must be brave or direct."
    );
  }
  const webSearchApiKeyFile = optionalString(
    env.RESEARCH_WEB_SEARCH_API_KEY_FILE
  );
  if (webProvider === "brave" && !webSearchApiKeyFile) {
    throw new Error(
      "RESEARCH_WEB_SEARCH_API_KEY_FILE is required for Brave search."
    );
  }
  if (webProvider === "direct" && webSearchApiKeyFile) {
    throw new Error(
      "Direct official web retrieval must not configure a search API key file."
    );
  }
  const allowedDomains = parseCsv(
    env.RESEARCH_OFFICIAL_WEB_ALLOWED_DOMAINS,
    "RESEARCH_OFFICIAL_WEB_ALLOWED_DOMAINS",
    10
  );
  const forbiddenOutputFragments = parseCsv(
    env.RESEARCH_FORBIDDEN_OUTPUT_FRAGMENTS,
    "RESEARCH_FORBIDDEN_OUTPUT_FRAGMENTS",
    100
  );
  const ncbiEmail = optionalString(env.RESEARCH_NCBI_EMAIL);
  const crossrefMailto = optionalString(env.RESEARCH_CROSSREF_MAILTO);
  const externalUserAgent = requiredString(
    env.RESEARCH_EXTERNAL_USER_AGENT,
    "RESEARCH_EXTERNAL_USER_AGENT"
  );
  if (
    [ncbiEmail, crossrefMailto, externalUserAgent].some((value) =>
      value ? /replace-with/iu.test(value) : false
    ) ||
    (["staging", "production"].includes(
      env.NODE_ENV?.trim().toLowerCase() ?? ""
    ) &&
      allowedDomains.some((domain) => domain.endsWith(".example")))
  ) {
    throw new Error(
      "Research external contact and official-domain placeholders must be replaced."
    );
  }
  if (
    env.NODE_ENV?.trim().toLowerCase() === "production" &&
    (!ncbiEmail || !crossrefMailto)
  ) {
    throw new Error(
      "RESEARCH_NCBI_EMAIL and RESEARCH_CROSSREF_MAILTO are required in production."
    );
  }
  const databasePath = requiredString(
    env.RESEARCH_DB_PATH,
    "RESEARCH_DB_PATH"
  );
  if (databasePath === ":memory:") {
    throw new Error("Research Worker requires a persistent database path.");
  }
  const artifactRoot = requiredString(
    env.RESEARCH_ARTIFACT_ROOT,
    "RESEARCH_ARTIFACT_ROOT"
  );
  const backupRoot = requiredString(
    env.RESEARCH_BACKUP_ROOT,
    "RESEARCH_BACKUP_ROOT"
  );
  assertSeparateConfiguredPaths(databasePath, artifactRoot, backupRoot);
  const heartbeatSeconds = requiredTimerSeconds(
    env.RESEARCH_HEARTBEAT_SECONDS,
    "RESEARCH_HEARTBEAT_SECONDS"
  );
  const heartbeatStaleSeconds = requiredSafeSeconds(
    env.RESEARCH_HEARTBEAT_STALE_SECONDS,
    "RESEARCH_HEARTBEAT_STALE_SECONDS"
  );
  if (heartbeatStaleSeconds < heartbeatSeconds * 3) {
    throw new Error(
      "RESEARCH_HEARTBEAT_STALE_SECONDS must be at least three heartbeat intervals."
    );
  }
  const backupIntervalSeconds = requiredTimerSeconds(
    env.RESEARCH_BACKUP_INTERVAL_SECONDS,
    "RESEARCH_BACKUP_INTERVAL_SECONDS"
  );
  const backupMaxAgeSeconds = requiredSafeSeconds(
    env.RESEARCH_BACKUP_MAX_AGE_SECONDS,
    "RESEARCH_BACKUP_MAX_AGE_SECONDS"
  );
  if (backupMaxAgeSeconds < backupIntervalSeconds * 2) {
    throw new Error(
      "RESEARCH_BACKUP_MAX_AGE_SECONDS must be at least two backup intervals."
    );
  }
  const replaySeconds = requiredSafeSeconds(
    env.RESEARCH_IDEMPOTENCY_REPLAY_SECONDS,
    "RESEARCH_IDEMPOTENCY_REPLAY_SECONDS"
  );
  const tombstoneSeconds = requiredSafeSeconds(
    env.RESEARCH_IDEMPOTENCY_TOMBSTONE_SECONDS,
    "RESEARCH_IDEMPOTENCY_TOMBSTONE_SECONDS"
  );
  if (tombstoneSeconds <= replaySeconds) {
    throw new Error(
      "RESEARCH_IDEMPOTENCY_TOMBSTONE_SECONDS must exceed RESEARCH_IDEMPOTENCY_REPLAY_SECONDS."
    );
  }
  const runRetentionSeconds = requiredSafeSeconds(
    env.RESEARCH_RUN_RETENTION_SECONDS,
    "RESEARCH_RUN_RETENTION_SECONDS"
  );
  if (runRetentionSeconds < resultTtlSeconds) {
    throw new Error(
      "RESEARCH_RUN_RETENTION_SECONDS must not be shorter than result and artifact TTL."
    );
  }
  const maximumPublications = boundedInteger(
    env.RESEARCH_MAX_PUBLICATIONS,
    "RESEARCH_MAX_PUBLICATIONS",
    50
  );
  const minimumReferences = boundedInteger(
    env.RESEARCH_MIN_REFERENCES,
    "RESEARCH_MIN_REFERENCES",
    50
  );
  if (minimumReferences > maximumPublications) {
    throw new Error(
      "RESEARCH_MIN_REFERENCES must not exceed RESEARCH_MAX_PUBLICATIONS."
    );
  }
  const maximumOfficialResults = boundedInteger(
    env.RESEARCH_MAX_OFFICIAL_RESULTS,
    "RESEARCH_MAX_OFFICIAL_RESULTS",
    10
  );
  const maximumAdapterJsonBytes = boundedInteger(
    env.RESEARCH_MAX_ADAPTER_JSON_BYTES,
    "RESEARCH_MAX_ADAPTER_JSON_BYTES",
    10_000_000
  );
  const maximumSourceBytes = boundedInteger(
    env.RESEARCH_MAX_SOURCE_BYTES,
    "RESEARCH_MAX_SOURCE_BYTES",
    5_000_000
  );
  const maximumExternalResponseBytesPerCall = boundedInteger(
    env.RESEARCH_MAX_EXTERNAL_RESPONSE_BYTES_PER_CALL,
    "RESEARCH_MAX_EXTERNAL_RESPONSE_BYTES_PER_CALL",
    10_000_000
  );
  if (
    maximumExternalResponseBytesPerCall < maximumAdapterJsonBytes ||
    maximumExternalResponseBytesPerCall < maximumSourceBytes
  ) {
    throw new Error(
      "RESEARCH_MAX_EXTERNAL_RESPONSE_BYTES_PER_CALL must cover every adapter response byte limit."
    );
  }
  const singleAttemptExternalRequestUnits =
    6 +
    (webProvider === "brave" ? allowedDomains.length * 2 : 0) +
    maximumOfficialResults * 8 +
    3 +
    Math.min(maximumPublications, 5) * 9 +
    maximumPublications * 9;
  const reservedExternalRequestUnits =
    singleAttemptExternalRequestUnits * 2;
  if (
    budgets.externalRequests < reservedExternalRequestUnits ||
    !Number.isSafeInteger(
      reservedExternalRequestUnits * maximumExternalResponseBytesPerCall
    ) ||
    budgets.externalResponseBytes <
      reservedExternalRequestUnits * maximumExternalResponseBytesPerCall
  ) {
    throw new Error(
      "Research external budgets must reserve two full workflow attempts at the configured worst-case adapter limits."
    );
  }
  const minimumAnswerContent = requiredPositiveInteger(
    env.RESEARCH_MIN_ANSWER_CONTENT,
    "RESEARCH_MIN_ANSWER_CONTENT"
  );
  const maximumAnswerContent = requiredPositiveInteger(
    env.RESEARCH_MAX_ANSWER_CONTENT,
    "RESEARCH_MAX_ANSWER_CONTENT"
  );
  if (minimumAnswerContent > maximumAnswerContent) {
    throw new Error(
      "RESEARCH_MIN_ANSWER_CONTENT must not exceed RESEARCH_MAX_ANSWER_CONTENT."
    );
  }
  const maximumOutputTokensPerCall = boundedInteger(
    env.RESEARCH_MAX_OUTPUT_TOKENS_PER_CALL,
    "RESEARCH_MAX_OUTPUT_TOKENS_PER_CALL",
    50_000
  );
  const maximumInputTokensPerCall = boundedInteger(
    env.RESEARCH_MAX_INPUT_TOKENS_PER_CALL,
    "RESEARCH_MAX_INPUT_TOKENS_PER_CALL",
    500_000
  );
  if (
    budgets.llmCalls !== 3 ||
    !Number.isSafeInteger(
      maximumOutputTokensPerCall * budgets.llmCalls
    ) ||
    maximumOutputTokensPerCall * budgets.llmCalls >
      budgets.outputTokens ||
    !Number.isSafeInteger(
      maximumInputTokensPerCall * budgets.llmCalls
    ) ||
    maximumInputTokensPerCall * budgets.llmCalls >
      budgets.inputTokens
  ) {
    throw new Error(
      "Research LLM budgets must cover two run attempts plus one bounded repair."
    );
  }
  const minimumFreePercent = requiredPositiveInteger(
    env.RESEARCH_MIN_FREE_PERCENT,
    "RESEARCH_MIN_FREE_PERCENT"
  );
  if (minimumFreePercent > 100) {
    throw new Error("RESEARCH_MIN_FREE_PERCENT must not exceed 100.");
  }
  if (
    env.NODE_ENV?.trim().toLowerCase() === "production" &&
    env.RESEARCH_BACKUP_TARGET_ENCRYPTION_CONFIRMED !== "true"
  ) {
    throw new Error(
      "RESEARCH_BACKUP_TARGET_ENCRYPTION_CONFIRMED=true is required in production."
    );
  }
  return {
    databasePath: path.resolve(databasePath),
    artifactRoot: path.resolve(artifactRoot),
    backupRoot: path.resolve(backupRoot),
    workerId: requiredIdentifier(
      env.RESEARCH_WORKER_ID,
      "RESEARCH_WORKER_ID"
    ),
    processVersion: requiredIdentifier(
      env.RESEARCH_WORKER_VERSION,
      "RESEARCH_WORKER_VERSION"
    ),
    pollIntervalMs: requiredTimerMilliseconds(
      env.RESEARCH_POLL_INTERVAL_MS,
      "RESEARCH_POLL_INTERVAL_MS"
    ),
    drainTimeoutMs: requiredTimerMillisecondsFromSeconds(
      env.RESEARCH_DRAIN_TIMEOUT_SECONDS,
      "RESEARCH_DRAIN_TIMEOUT_SECONDS"
    ),
    leaseSeconds,
    leaseRenewSeconds,
    heartbeatSeconds,
    reconcileIntervalSeconds: requiredTimerSeconds(
      env.RESEARCH_RECONCILE_INTERVAL_SECONDS,
      "RESEARCH_RECONCILE_INTERVAL_SECONDS"
    ),
    cleanupIntervalSeconds: requiredTimerSeconds(
      env.RESEARCH_CLEANUP_INTERVAL_SECONDS,
      "RESEARCH_CLEANUP_INTERVAL_SECONDS"
    ),
    backupIntervalSeconds,
    backupMaxAgeMs: requiredSafeMillisecondsFromSeconds(
      env.RESEARCH_BACKUP_MAX_AGE_SECONDS,
      "RESEARCH_BACKUP_MAX_AGE_SECONDS"
    ),
    backupRetentionCount: boundedInteger(
      env.RESEARCH_BACKUP_RETENTION_COUNT,
      "RESEARCH_BACKUP_RETENTION_COUNT",
      100
    ),
    embeddedMaintenanceEnabled: parseBoolean(
      env.RESEARCH_EMBEDDED_MAINTENANCE_ENABLED,
      false,
      "RESEARCH_EMBEDDED_MAINTENANCE_ENABLED"
    ),
    reconcileBatchSize: boundedInteger(
      env.RESEARCH_RECONCILE_BATCH_SIZE,
      "RESEARCH_RECONCILE_BATCH_SIZE",
      100
    ),
    cleanupBatchSize: boundedInteger(
      env.RESEARCH_CLEANUP_BATCH_SIZE,
      "RESEARCH_CLEANUP_BATCH_SIZE",
      100
    ),
    orphanGraceMs: requiredSafeMillisecondsFromSeconds(
      env.RESEARCH_ORPHAN_GRACE_SECONDS,
      "RESEARCH_ORPHAN_GRACE_SECONDS"
    ),
    storagePolicy: {
      maximumResearchBytes: requiredPositiveInteger(
        env.RESEARCH_MAX_STORAGE_BYTES,
        "RESEARCH_MAX_STORAGE_BYTES"
      ),
      minimumFreeBytes: requiredPositiveInteger(
        env.RESEARCH_MIN_FREE_BYTES,
        "RESEARCH_MIN_FREE_BYTES"
      ),
      minimumFreePercent
    },
    ncbiApiKeyFile: optionalString(env.RESEARCH_NCBI_API_KEY_FILE),
    webSearchApiKeyFile,
    adapterOptions: {
      ncbi: {
        ...(ncbiEmail ? { email: ncbiEmail } : {}),
        tool: "codex_gateway_doctor_research",
        apiKey: undefined,
        maximumResults: maximumPublications
      },
      crossref: {
        ...(crossrefMailto ? { mailto: crossrefMailto } : {})
      },
      officialWeb: {
        provider: webProvider,
        ...(webProvider === "brave"
          ? { apiKey: "__loaded_from_file__" }
          : {}),
        allowedDomains,
        maximumResults: maximumOfficialResults
      },
      timeoutMs: requiredTimerMilliseconds(
        env.RESEARCH_ADAPTER_TIMEOUT_MS,
        "RESEARCH_ADAPTER_TIMEOUT_MS"
      ),
      maximumJsonBytes: maximumAdapterJsonBytes,
      maximumSourceBytes,
      userAgent: externalUserAgent
    },
    orcid,
    llm: {
      baseUrl: requiredString(
        env.RESEARCH_LLM_BASE_URL,
        "RESEARCH_LLM_BASE_URL"
      ),
      allowedHosts: parseHostCsv(
        env.RESEARCH_LLM_ALLOWED_HOSTS,
        "RESEARCH_LLM_ALLOWED_HOSTS"
      ),
      model: requiredIdentifier(
        env.RESEARCH_LLM_MODEL,
        "RESEARCH_LLM_MODEL"
      ),
      reasoningEffort: requiredReasoningEffort(
        env.RESEARCH_LLM_REASONING_EFFORT
      ),
      bearerTokenFile: requiredString(
        env.RESEARCH_LLM_BEARER_TOKEN_FILE,
        "RESEARCH_LLM_BEARER_TOKEN_FILE"
      ),
      timeoutMs: requiredTimerMilliseconds(
        env.RESEARCH_LLM_TIMEOUT_MS,
        "RESEARCH_LLM_TIMEOUT_MS"
      ),
      maximumResponseBytes: boundedInteger(
        env.RESEARCH_MAX_LLM_RESPONSE_BYTES,
        "RESEARCH_MAX_LLM_RESPONSE_BYTES",
        5_000_000
      )
    },
    workflowPolicy: {
      resultTtlSeconds,
      maximumArtifactBytes,
      maximumRunArtifactBytes,
      maximumExternalResponseBytesPerCall,
      maximumSourceTextCharacters: boundedInteger(
        env.RESEARCH_MAX_SOURCE_TEXT_CHARACTERS,
        "RESEARCH_MAX_SOURCE_TEXT_CHARACTERS",
        500_000
      ),
      maximumPublications,
      minimumReferences,
      minimumReviewContent: requiredPositiveInteger(
        env.RESEARCH_MIN_REVIEW_CONTENT,
        "RESEARCH_MIN_REVIEW_CONTENT"
      ),
      maximumQuestionContent: requiredPositiveInteger(
        env.RESEARCH_MAX_QUESTION_CONTENT,
        "RESEARCH_MAX_QUESTION_CONTENT"
      ),
      minimumAnswerContent,
      maximumAnswerContent,
      maximumInputTokensPerCall,
      maximumOutputTokensPerCall,
      hardDeadlineMs: requiredTimerMillisecondsFromSeconds(
        env.RESEARCH_HARD_DEADLINE_SECONDS,
        "RESEARCH_HARD_DEADLINE_SECONDS"
      ),
      budgets,
      forbiddenOutputFragments
    },
    admissionLimits: {
      dailyRunsPerSubject: requiredPositiveInteger(
        env.RESEARCH_MAX_DAILY_RUNS_PER_SUBJECT,
        "RESEARCH_MAX_DAILY_RUNS_PER_SUBJECT"
      ),
      uniqueDoctors30dPerSubject: requiredPositiveInteger(
        env.RESEARCH_MAX_UNIQUE_DOCTORS_PER_SUBJECT_30D,
        "RESEARCH_MAX_UNIQUE_DOCTORS_PER_SUBJECT_30D"
      ),
      globalActiveRuns: requiredPositiveInteger(
        env.RESEARCH_MAX_QUEUED_RUNS,
        "RESEARCH_MAX_QUEUED_RUNS"
      ),
      needsInputPerSubject: requiredPositiveInteger(
        env.RESEARCH_MAX_NEEDS_INPUT_PER_SUBJECT,
        "RESEARCH_MAX_NEEDS_INPUT_PER_SUBJECT"
      )
    },
    store: {
      idempotencyReplaySeconds: replaySeconds,
      idempotencyTombstoneSeconds: tombstoneSeconds,
      resultTtlSeconds,
      runRetentionSeconds,
      needsInputTtlSeconds: requiredSafeSeconds(
        env.RESEARCH_NEEDS_INPUT_TTL_SECONDS,
        "RESEARCH_NEEDS_INPUT_TTL_SECONDS"
      ),
      maximumCheckpointBytes: boundedInteger(
        env.RESEARCH_MAX_CHECKPOINT_BYTES,
        "RESEARCH_MAX_CHECKPOINT_BYTES",
        10 * 1_024 * 1_024
      ),
      maximumResultBytes: boundedInteger(
        env.RESEARCH_MAX_RESULT_BYTES,
        "RESEARCH_MAX_RESULT_BYTES",
        10 * 1_024 * 1_024
      )
    }
  };
}

export async function readSecretFile(
  filename: string,
  description: string
): Promise<string> {
  const resolved = path.resolve(filename);
  const canonical = await realpath(resolved);
  if (canonical !== resolved && process.platform !== "win32") {
    throw new Error(`${description} secret file path is not canonical.`);
  }
  const flags =
    constants.O_RDONLY |
    (process.platform === "win32" ? 0 : constants.O_NOFOLLOW);
  const handle = await open(resolved, flags);
  try {
    const fileStat = await handle.stat();
    if (!fileStat.isFile() || fileStat.size > 16_384) {
      throw new Error(`${description} secret file is invalid.`);
    }
    if (process.platform !== "win32" && (fileStat.mode & 0o077) !== 0) {
      throw new Error(`${description} secret file permissions are too broad.`);
    }
    if (
      process.platform === "linux" &&
      (await realpath(`/proc/self/fd/${handle.fd}`)) !== resolved
    ) {
      throw new Error(`${description} secret file handle is not canonical.`);
    }
    const value = (await handle.readFile("utf8")).trim();
    if (
      value.length < 8 ||
      value.length > 8_192 ||
      /[\r\n\u0000]/u.test(value)
    ) {
      throw new Error(`${description} secret file is empty or invalid.`);
    }
    return value;
  } finally {
    await handle.close();
  }
}

function parseBoolean(
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

function requiredPositiveInteger(
  value: string | undefined,
  name: string
): number {
  if (!value || !/^[1-9][0-9]*$/u.test(value.trim())) {
    throw new Error(`${name} must be a positive integer.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${name} exceeds the safe integer range.`);
  }
  return parsed;
}

const maximumTimerMilliseconds = 2_147_483_647;

function requiredSafeSeconds(
  value: string | undefined,
  name: string
): number {
  const seconds = requiredPositiveInteger(value, name);
  if (!Number.isSafeInteger(seconds * 1_000)) {
    throw new Error(`${name} exceeds the safe millisecond range.`);
  }
  return seconds;
}

function requiredTimerSeconds(
  value: string | undefined,
  name: string
): number {
  const seconds = requiredSafeSeconds(value, name);
  if (seconds * 1_000 > maximumTimerMilliseconds) {
    throw new Error(`${name} exceeds the supported timer range.`);
  }
  return seconds;
}

function requiredTimerMilliseconds(
  value: string | undefined,
  name: string
): number {
  const milliseconds = requiredPositiveInteger(value, name);
  if (milliseconds > maximumTimerMilliseconds) {
    throw new Error(`${name} exceeds the supported timer range.`);
  }
  return milliseconds;
}

function requiredSafeMillisecondsFromSeconds(
  value: string | undefined,
  name: string
): number {
  return requiredSafeSeconds(value, name) * 1_000;
}

function requiredTimerMillisecondsFromSeconds(
  value: string | undefined,
  name: string
): number {
  return requiredTimerSeconds(value, name) * 1_000;
}

function boundedInteger(
  value: string | undefined,
  name: string,
  maximum: number
): number {
  const parsed = requiredPositiveInteger(value, name);
  if (parsed > maximum) {
    throw new Error(`${name} cannot exceed ${maximum}.`);
  }
  return parsed;
}

function requiredString(value: string | undefined, name: string): string {
  const normalized = value?.trim();
  if (!normalized || normalized.length > 8_192) {
    throw new Error(`${name} is required and must be bounded.`);
  }
  return normalized;
}

function optionalString(value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function requiredIdentifier(value: string | undefined, name: string): string {
  const normalized = requiredString(value, name);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/u.test(normalized)) {
    throw new Error(`${name} is invalid.`);
  }
  return normalized;
}

function requiredReasoningEffort(
  value: string | undefined
): "none" | "low" | "medium" | "high" {
  const normalized = requiredString(
    value,
    "RESEARCH_LLM_REASONING_EFFORT"
  ).toLowerCase();
  if (
    normalized !== "none" &&
    normalized !== "low" &&
    normalized !== "medium" &&
    normalized !== "high"
  ) {
    throw new Error(
      "RESEARCH_LLM_REASONING_EFFORT must be none, low, medium, or high."
    );
  }
  return normalized;
}

function parseCsv(
  value: string | undefined,
  name: string,
  maximumItems: number
): string[] {
  const items = requiredString(value, name)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (
    items.length === 0 ||
    items.length > maximumItems ||
    new Set(items).size !== items.length
  ) {
    throw new Error(`${name} must contain unique comma-separated values.`);
  }
  return items;
}

function parseHostCsv(value: string | undefined, name: string): string[] {
  const hosts = parseCsv(value, name, 20);
  if (
    hosts.some(
      (host) =>
        host !== host.toLowerCase() ||
        host.endsWith(".") ||
        !/^[a-z0-9[\]:.-]{1,253}$/u.test(host)
    )
  ) {
    throw new Error(`${name} contains an invalid hostname.`);
  }
  return hosts;
}

function assertSeparateConfiguredPaths(
  databasePath: string,
  artifactRoot: string,
  backupRoot: string
): void {
  const database = path.resolve(databasePath);
  const databaseDirectory = path.dirname(database);
  const artifacts = path.resolve(artifactRoot);
  const backup = path.resolve(backupRoot);
  const artifactRelative = path.relative(databaseDirectory, artifacts);
  const backupRelative = path.relative(databaseDirectory, backup);
  if (
    database === artifacts ||
    database === backup ||
    artifacts === backup ||
    databaseDirectory === backup ||
    databaseDirectory.startsWith(`${backup}${path.sep}`) ||
    backup.startsWith(`${artifacts}${path.sep}`) ||
    artifacts.startsWith(`${backup}${path.sep}`) ||
    artifactRelative === "" ||
    artifactRelative === ".." ||
    artifactRelative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(artifactRelative) ||
    (backupRelative !== ".." &&
      !backupRelative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(backupRelative))
  ) {
    throw new Error(
      "Research artifacts must share the database volume and backups must use a separate path."
    );
  }
}
