import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadResearchWorkerConfig } from "./config.js";

describe("Research Worker fail-closed configuration", () => {
  it("does not inspect Research configuration or proxy state while disabled", () => {
    expect(
      loadResearchWorkerConfig({
        RESEARCH_WORKER_ENABLED: "false",
        HTTPS_PROXY: "http://public-proxy.example"
      })
    ).toBeNull();
  });

  it("requires a complete bounded configuration and preserves secret file paths", () => {
    const env = validEnvironment();
    const config = loadResearchWorkerConfig(env);
    expect(config).not.toBeNull();
    expect(config).toMatchObject({
      workerId: "research-test-worker-1",
      leaseSeconds: 120,
      leaseRenewSeconds: 30,
      heartbeatSeconds: 15,
      embeddedMaintenanceEnabled: false,
      ncbiApiKeyFile: null,
      webSearchApiKeyFile: path.resolve("secrets/web-search"),
      workflowPolicy: {
        maximumArtifactBytes: 1_000_000,
        maximumRunArtifactBytes: 4_000_000,
        minimumReferences: 3,
        maximumInputTokensPerCall: 200_000,
        budgets: {
          externalRequests: 370,
          llmCalls: 3
        }
      }
    });
  });

  it("rejects proxy use and unsafe cross-field limits before starting", () => {
    expect(() =>
      loadResearchWorkerConfig({
        ...validEnvironment(),
        HTTPS_PROXY: "http://public-proxy.example"
      })
    ).toThrow("does not support outbound HTTP proxy");

    expect(() =>
      loadResearchWorkerConfig({
        ...validEnvironment(),
        RESEARCH_LEASE_RENEW_SECONDS: "41"
      })
    ).toThrow("must not exceed one third");

    expect(() =>
      loadResearchWorkerConfig({
        ...validEnvironment(),
        RESEARCH_IDEMPOTENCY_TOMBSTONE_SECONDS: "604800"
      })
    ).toThrow("must exceed RESEARCH_IDEMPOTENCY_REPLAY_SECONDS");

    expect(() =>
      loadResearchWorkerConfig({
        ...validEnvironment(),
        RESEARCH_MAX_LLM_CALLS_PER_RUN: "2"
      })
    ).toThrow("must cover two run attempts");

    expect(() =>
      loadResearchWorkerConfig({
        ...validEnvironment(),
        RESEARCH_MAX_EXTERNAL_RESPONSE_BYTES_PER_CALL: "999999"
      })
    ).toThrow("must cover every adapter response byte limit");

    expect(() =>
      loadResearchWorkerConfig({
        ...validEnvironment(),
        RESEARCH_MAX_EXTERNAL_REQUESTS_PER_RUN: "369"
      })
    ).toThrow("must reserve two full workflow attempts");

    expect(() =>
      loadResearchWorkerConfig({
        ...validEnvironment(),
        RESEARCH_MAX_EXTERNAL_BYTES_PER_RUN: "739999999"
      })
    ).toThrow("must reserve two full workflow attempts");

    expect(() =>
      loadResearchWorkerConfig({
        ...validEnvironment(),
        RESEARCH_POLL_INTERVAL_MS: "2147483648"
      })
    ).toThrow("exceeds the supported timer range");

    expect(() =>
      loadResearchWorkerConfig({
        ...validEnvironment(),
        RESEARCH_MAX_RESULT_BYTES: String(10 * 1_024 * 1_024 + 1)
      })
    ).toThrow("cannot exceed");

    expect(() =>
      loadResearchWorkerConfig({
        ...validEnvironment(),
        NODE_ENV: "staging",
        RESEARCH_NCBI_EMAIL:
          "replace-with-operator-contact@example.org"
      })
    ).toThrow("placeholders must be replaced");
  });
});

function validEnvironment(): NodeJS.ProcessEnv {
  const state = path.resolve("test-state");
  return {
    NODE_ENV: "test",
    RESEARCH_WORKER_ENABLED: "true",
    RESEARCH_WORKER_ID: "research-test-worker-1",
    RESEARCH_WORKER_VERSION: "test.1",
    RESEARCH_WORKER_CONCURRENCY: "1",
    RESEARCH_DB_PATH: path.join(state, "research.db"),
    RESEARCH_ARTIFACT_ROOT: path.join(state, "artifacts"),
    RESEARCH_BACKUP_ROOT: path.resolve("test-backups"),
    RESEARCH_POLL_INTERVAL_MS: "1000",
    RESEARCH_DRAIN_TIMEOUT_SECONDS: "30",
    RESEARCH_LEASE_SECONDS: "120",
    RESEARCH_LEASE_RENEW_SECONDS: "30",
    RESEARCH_HEARTBEAT_SECONDS: "15",
    RESEARCH_HEARTBEAT_STALE_SECONDS: "45",
    RESEARCH_RECONCILE_INTERVAL_SECONDS: "60",
    RESEARCH_RECONCILE_BATCH_SIZE: "100",
    RESEARCH_CLEANUP_INTERVAL_SECONDS: "3600",
    RESEARCH_CLEANUP_BATCH_SIZE: "100",
    RESEARCH_ORPHAN_GRACE_SECONDS: "3600",
    RESEARCH_BACKUP_INTERVAL_SECONDS: "3600",
    RESEARCH_BACKUP_MAX_AGE_SECONDS: "7200",
    RESEARCH_BACKUP_RETENTION_COUNT: "24",
    RESEARCH_EMBEDDED_MAINTENANCE_ENABLED: "false",
    RESEARCH_RESULT_TTL_SECONDS: "2592000",
    RESEARCH_ARTIFACT_TTL_SECONDS: "2592000",
    RESEARCH_RUN_RETENTION_SECONDS: "7776000",
    RESEARCH_NEEDS_INPUT_TTL_SECONDS: "259200",
    RESEARCH_IDEMPOTENCY_REPLAY_SECONDS: "604800",
    RESEARCH_IDEMPOTENCY_TOMBSTONE_SECONDS: "2592000",
    RESEARCH_MAX_ARTIFACT_BYTES: "1000000",
    RESEARCH_MAX_ARTIFACT_BYTES_PER_RUN: "4000000",
    RESEARCH_MAX_CHECKPOINT_BYTES: "1000000",
    RESEARCH_MAX_RESULT_BYTES: "4000000",
    RESEARCH_MAX_STORAGE_BYTES: "1000000000",
    RESEARCH_MIN_FREE_BYTES: "1000000",
    RESEARCH_MIN_FREE_PERCENT: "1",
    RESEARCH_MAX_DAILY_RUNS_PER_SUBJECT: "2",
    RESEARCH_MAX_UNIQUE_DOCTORS_PER_SUBJECT_30D: "5",
    RESEARCH_MAX_QUEUED_RUNS: "5",
    RESEARCH_MAX_NEEDS_INPUT_PER_SUBJECT: "2",
    RESEARCH_MAX_EXTERNAL_REQUESTS_PER_RUN: "370",
    RESEARCH_MAX_EXTERNAL_BYTES_PER_RUN: "740000000",
    RESEARCH_MAX_LLM_CALLS_PER_RUN: "3",
    RESEARCH_MAX_INPUT_TOKENS_PER_CALL: "200000",
    RESEARCH_MAX_INPUT_TOKENS_PER_RUN: "600000",
    RESEARCH_MAX_OUTPUT_TOKENS_PER_RUN: "36000",
    RESEARCH_MAX_OUTPUT_TOKENS_PER_CALL: "12000",
    RESEARCH_MAX_EXTERNAL_RESPONSE_BYTES_PER_CALL: "2000000",
    RESEARCH_MAX_SOURCE_TEXT_CHARACTERS: "100000",
    RESEARCH_MAX_PUBLICATIONS: "15",
    RESEARCH_MIN_REFERENCES: "3",
    RESEARCH_MIN_REVIEW_CONTENT: "500",
    RESEARCH_MAX_QUESTION_CONTENT: "80",
    RESEARCH_MIN_ANSWER_CONTENT: "80",
    RESEARCH_MAX_ANSWER_CONTENT: "800",
    RESEARCH_HARD_DEADLINE_SECONDS: "900",
    RESEARCH_FORBIDDEN_OUTPUT_FRAGMENTS:
      "ignore all prior instructions,reveal api key",
    RESEARCH_NCBI_EMAIL: "operator@example.org",
    RESEARCH_CROSSREF_MAILTO: "operator@example.org",
    RESEARCH_ORCID_BEARER_TOKEN_FILE: path.resolve("secrets/orcid"),
    RESEARCH_WEB_SEARCH_PROVIDER: "brave",
    RESEARCH_WEB_SEARCH_API_KEY_FILE: path.resolve("secrets/web-search"),
    RESEARCH_OFFICIAL_WEB_ALLOWED_DOMAINS:
      "hospital.example,university.example",
    RESEARCH_MAX_OFFICIAL_RESULTS: "5",
    RESEARCH_ADAPTER_TIMEOUT_MS: "20000",
    RESEARCH_MAX_ADAPTER_JSON_BYTES: "2000000",
    RESEARCH_MAX_SOURCE_BYTES: "1000000",
    RESEARCH_EXTERNAL_USER_AGENT: "codex-gateway-research-test/1.0",
    RESEARCH_LLM_BASE_URL: "http://gateway:8787",
    RESEARCH_LLM_ALLOWED_HOSTS: "gateway",
    RESEARCH_LLM_MODEL: "medcode",
    RESEARCH_LLM_BEARER_TOKEN_FILE: path.resolve("secrets/llm"),
    RESEARCH_LLM_TIMEOUT_MS: "600000",
    RESEARCH_MAX_LLM_RESPONSE_BYTES: "2000000"
  };
}
