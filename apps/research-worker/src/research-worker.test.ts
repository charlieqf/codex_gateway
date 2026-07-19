import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  GatewayError,
  issueAccessCredential,
  type DoctorResearchRunInput,
  type ProviderAdapter
} from "@codex-gateway/core";
import { buildGateway } from "@codex-gateway/gateway";
import {
  executeDoctorResearchWorkflow,
  parseAndValidateDoctorResearchModelOutput,
  readVerifiedResearchArtifact,
  type DoctorResearchModelOutput,
  type ResearchAdapterBundle,
  ResearchHttpError,
  ResearchModelClientError,
  type ResearchModelClient
} from "@codex-gateway/research-agent";
import {
  createResearchSqliteStore,
  createSqliteStore
} from "@codex-gateway/store-sqlite";
import {
  runResearchMaintenance,
  runResearchWorker
} from "./runtime.js";
import type { ResearchWorkerConfig } from "./config.js";

const cleanupDirectories: string[] = [];
const cleanupStores: Array<{ close(): void }> = [];

const provider: ProviderAdapter = {
  kind: "research-controlled-beta-e2e",
  async health() {
    return {
      state: "healthy",
      checkedAt: new Date()
    };
  },
  async *message() {
    yield { type: "completed" };
  }
};

afterEach(() => {
  for (const store of cleanupStores.splice(0)) {
    try {
      store.close();
    } catch {
      // A successful test closes its store before cleanup.
    }
  }
  for (const directory of cleanupDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Research Worker controlled-beta workflow", () => {
  it("uses an independent maintenance lifecycle to create the backup required for Worker readiness", async () => {
    const root = temporaryDirectory();
    const config = {
      ...workerConfig(root),
      embeddedMaintenanceEnabled: false
    };
    const observer = createResearchSqliteStore({
      path: config.databasePath,
      limits: config.admissionLimits,
      ...config.store
    });
    cleanupStores.push(observer);
    const maintenanceController = new AbortController();
    const maintenanceEvents: string[] = [];
    const maintenance = runResearchMaintenance({
      config,
      signal: maintenanceController.signal,
      logger: {
        info(event) {
          maintenanceEvents.push(event);
        },
        error() {}
      }
    });
    await waitFor(
      () =>
        observer.latestSuccessfulBackupAt() !== null &&
        maintenanceEvents.includes("research_maintenance_ready"),
      5_000
    );
    maintenanceController.abort(
      new Error("Independent maintenance lifecycle test drain.")
    );
    await maintenance;

    const workerController = new AbortController();
    const worker = runResearchWorker({
      config,
      signal: workerController.signal,
      logger: {
        info() {},
        error() {}
      },
      dependencies: {
        adapters: {
          ...adapters(),
          async assertAvailable() {}
        },
        modelClient: {
          model: "test-model",
          async assertModelAvailable() {},
          async generate() {
            throw new Error("No run should be leased in this test.");
          }
        }
      }
    });
    await waitFor(
      () =>
        observer
          .listWorkerHeartbeats({ staleAfterSeconds: 45 })
          .some(
            (heartbeat) =>
              heartbeat.workerId === config.workerId &&
              heartbeat.state === "ready"
          ),
      5_000
    );
    workerController.abort(new Error("Independent Worker test drain."));
    await worker;
    expect(maintenanceEvents).toEqual(
      expect.arrayContaining([
        "research_backup_succeeded",
        "research_maintenance_ready",
        "research_maintenance_stopped"
      ])
    );
    observer.close();
  });

  it("refuses Worker readiness when independent maintenance has no fresh backup", async () => {
    const root = temporaryDirectory();
    const config = {
      ...workerConfig(root),
      embeddedMaintenanceEnabled: false
    };
    await expect(
      runResearchWorker({
        config,
        signal: new AbortController().signal,
        logger: {
          info() {},
          error() {}
        },
        dependencies: {
          adapters: {
            ...adapters(),
            async assertAvailable() {}
          },
          modelClient: {
            model: "test-model",
            async assertModelAvailable() {},
            async generate() {
              throw new Error("Model must not run.");
            }
          }
        }
      })
    ).rejects.toThrow("requires a fresh verified maintenance backup");
  });

  it("leases a queued run, closes evidence, commits success, and publishes exactly four verified artifacts", async () => {
    const root = temporaryDirectory();
    const artifactRoot = path.join(root, "artifacts");
    const store = createResearchSqliteStore({
      path: path.join(root, "research.db"),
      limits: {
        dailyRunsPerSubject: 2,
        uniqueDoctors30dPerSubject: 2,
        globalActiveRuns: 2,
        needsInputPerSubject: 2
      },
      resultTtlSeconds: 2_592_000,
      runRetentionSeconds: 7_776_000
    });
    cleanupStores.push(store);
    const now = new Date("2026-07-18T03:00:00.000Z");
    const created = store.createRun({
      subjectId: "subj_worker_e2e",
      credentialId: "cred_worker_e2e",
      requestId: "req_worker_e2e",
      idempotencyKey: "research:worker-e2e",
      requestHash: "request-hash-e2e",
      identityFingerprint: "identity-fingerprint-e2e",
      input: runInput(),
      now
    });
    expect(created.outcome).toBe("created");
    if (created.outcome !== "created") {
      throw new Error("Research test run was not created.");
    }
    const lease = store.acquireLease({
      workerId: "worker_test_1",
      leaseSeconds: 120,
      now
    });
    expect(lease).not.toBeNull();
    if (!lease) {
      throw new Error("Research test lease was not acquired.");
    }
    const modelValidation = parseAndValidateDoctorResearchModelOutput(
      JSON.stringify(modelOutput())
    );
    expect(
      modelValidation.ok,
      modelValidation.ok ? "" : JSON.stringify(modelValidation.errors)
    ).toBe(true);
    const closableOutput = modelOutput();
    closableOutput.profile.expertise = ["Invented unsupported specialty"];
    closableOutput.profile.claims = [{
      claim_id: "clm_unsupported_extra",
      claim_type: "expertise",
      text: "Invented unsupported specialty",
      source_ids: ["src_official_1"],
      verification_status: "verified"
    }];

    let observedPrompt = "";
    const modelClient: ResearchModelClient = {
      model: "test-model",
      async generate(input) {
        observedPrompt = input.prompt;
        return {
          text: JSON.stringify(closableOutput),
          gatewayRequestId: "req_model_test",
          usage: {
            promptTokens: 100,
            completionTokens: 3_500,
            reasoningTokens: 2_000,
            totalTokens: 3_600
          }
        };
      }
    };
    const validationErrors: string[][] = [];
    const outcome = await executeDoctorResearchWorkflow({
      lease,
      store,
      adapters: adapters(0),
      modelClient,
      artifactRoot,
      policy: workflowPolicy(),
      signal: new AbortController().signal,
      onValidationFailure(event) {
        validationErrors.push([...event.errorCodes]);
      },
      now: () => now
    });

    expect(outcome, JSON.stringify(validationErrors)).toEqual({
      outcome: "succeeded"
    });
    expect(observedPrompt).toContain("untrusted_publication_abstracts");
    expect(observedPrompt).toContain("allowed_numeric_contexts");
    expect(observedPrompt).toContain("year 2025");
    expect(observedPrompt).toContain(
      "untrusted_publication_abstracts[].abstract"
    );
    expect(observedPrompt).toContain("Randomized evidence from the retrieved abstract");
    const run = store.getRunForSubject(created.receipt.run_id, "subj_worker_e2e");
    expect(run?.status).toBe("succeeded");
    const stored = store.getRunResultForSubject(
      created.receipt.run_id,
      "subj_worker_e2e"
    );
    expect(stored?.result.request_id).toBe(
      `req_research_worker_${created.receipt.run_id.slice(4)}`
    );
    const result = stored?.result as unknown as {
      profile: {
        expertise: string[];
        research_directions: string[];
        claims: Array<{ claim_type: string; text: string }>;
      };
      artifacts: Array<{
        artifact_id: string;
        kind: string;
        sha256: string;
        size_bytes: number;
      }>;
    };
    expect(result.profile.research_directions).toEqual([
      "research area cardiology"
    ]);
    expect(result.profile.expertise).toEqual([]);
    expect(JSON.stringify(result.profile)).not.toContain(
      "Invented unsupported specialty"
    );
    expect(result.profile.claims).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ claim_type: "identity" }),
        expect.objectContaining({
          claim_type: "research_direction",
          text: "research area cardiology"
        })
      ])
    );
    expect(
      store.database
        .prepare(
          `SELECT stage, attempt, gateway_request_id, prompt_tokens,
                  completion_tokens, error_code
           FROM research_stage_runs
           WHERE run_id = ?`
        )
        .all(created.receipt.run_id)
    ).toEqual([
      {
        stage: "synthesize_review",
        attempt: 1,
        gateway_request_id: "req_model_test",
        prompt_tokens: 100,
        completion_tokens: 3_500,
        error_code: null
      }
    ]);
    expect(result.artifacts).toHaveLength(4);
    expect(new Set(result.artifacts.map((artifact) => artifact.kind))).toEqual(
      new Set(["profile", "review", "questions", "answers"])
    );
    for (const manifest of result.artifacts) {
      const record = store.getArtifactForSubject(
        manifest.artifact_id,
        "subj_worker_e2e"
      );
      expect(record).not.toBeNull();
      if (!record) {
        throw new Error("Committed artifact metadata is missing.");
      }
      const bytes = await readVerifiedResearchArtifact({
        root: artifactRoot,
        artifact: {
          artifactId: record.artifactId,
          storageRelativePath: record.storageRelativePath,
          sha256: record.sha256,
          sizeBytes: record.sizeBytes
        },
        maximumArtifactBytes: 200_000
      });
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(
        manifest.sha256
      );
    }
    const questions = result.artifacts.find(
      (artifact) => artifact.kind === "questions"
    );
    if (!questions) {
      throw new Error("Questions artifact is missing.");
    }
    const questionRecord = store.getArtifactForSubject(
      questions.artifact_id,
      "subj_worker_e2e"
    );
    if (!questionRecord) {
      throw new Error("Questions artifact metadata is missing.");
    }
    const questionBytes = await readVerifiedResearchArtifact({
      root: artifactRoot,
      artifact: {
        artifactId: questionRecord.artifactId,
        storageRelativePath: questionRecord.storageRelativePath,
        sha256: questionRecord.sha256,
        sizeBytes: questionRecord.sizeBytes
      },
      maximumArtifactBytes: 200_000
    });
    expect(questionBytes.toString("utf8").trim().split("\n")).toHaveLength(5);
    store.close();
  });

  it("redacts a transposed numeric claim after repairing unsafe markup", async () => {
    const root = temporaryDirectory();
    const artifactRoot = path.join(root, "artifacts");
    const store = createResearchSqliteStore({
      path: path.join(root, "research.db"),
      limits: {
        dailyRunsPerSubject: 2,
        uniqueDoctors30dPerSubject: 2,
        globalActiveRuns: 2,
        needsInputPerSubject: 2
      },
      resultTtlSeconds: 2_592_000,
      runRetentionSeconds: 7_776_000
    });
    cleanupStores.push(store);
    const now = new Date("2026-07-18T03:00:00.000Z");
    const created = store.createRun({
      subjectId: "subj_profile_closure",
      credentialId: "cred_profile_closure",
      requestId: "req_profile_closure",
      idempotencyKey: "research:profile-closure",
      requestHash: "request-hash-profile-closure",
      identityFingerprint: "identity-fingerprint-profile-closure",
      input: runInput(),
      now
    });
    expect(created.outcome).toBe("created");
    const lease = store.acquireLease({
      workerId: "worker_profile_closure",
      leaseSeconds: 120,
      now
    });
    if (!lease) {
      throw new Error("Research test lease was not acquired.");
    }
    const hallucinated = modelOutput();
    hallucinated.profile.research_directions = [
      "Invented oncology program"
    ];
    hallucinated.profile.claims = [
      {
        claim_id: "clm_research_direction_invented",
        claim_type: "research_direction",
        text: "Invented oncology program",
        source_ids: ["src_official_1"],
        verification_status: "verified"
      }
    ];
    hallucinated.review.markdown =
      "The retrieved publication enrolled 2025 patients, but an unsafe [external link](https://attacker.invalid/) must not reach an artifact [1].";
    const numericHallucinated = modelOutput();
    numericHallucinated.review.markdown =
      "The retrieved publication enrolled 2025 patients and established a precise effect, repurposing the publication year as an unsupported sample size [1].";
    let modelCalls = 0;
    const validationEvents: Array<{
      stage: string;
      attempt: number;
      errorCodes: readonly string[];
    }> = [];
    let repairPrompt = "";
    const outcome = await executeDoctorResearchWorkflow({
      lease,
      store,
      adapters: adapters(),
      modelClient: {
        model: "test-model",
        async generate(input) {
          modelCalls += 1;
          if (modelCalls === 2) {
            repairPrompt = input.prompt;
          }
          return {
            text: JSON.stringify(
              modelCalls === 1 ? hallucinated : numericHallucinated
            ),
            gatewayRequestId: `req_model_profile_${modelCalls}`,
            usage: {
              promptTokens: 100,
              completionTokens: 100,
              totalTokens: 200
            }
          };
        }
      },
      artifactRoot,
      policy: workflowPolicy(),
      signal: new AbortController().signal,
      onValidationFailure(event) {
        validationEvents.push(event);
      },
      now: () => now
    });

    expect(outcome).toEqual({ outcome: "succeeded" });
    expect(modelCalls).toBe(2);
    expect(repairPrompt).toContain("Preserve every required field");
    expect(repairPrompt).toContain("Schema:");
    expect(repairPrompt).toContain("untrusted_official_sources");
    expect(repairPrompt).toContain("Invented oncology program");
    expect(repairPrompt).toContain(
      "remove every unsupported number from all narrative fields"
    );
    expect(validationEvents).toEqual([
      expect.objectContaining({
        stage: "synthesize_review",
        attempt: 1,
        errorCodes: expect.arrayContaining([
          "unsafe_model_markup",
          "numeric_evidence_closure"
        ])
      })
    ]);
    expect(JSON.stringify(validationEvents)).not.toContain(
      "clm_research_direction_invented"
    );
    expect(JSON.stringify(validationEvents)).not.toContain(
      "Invented oncology program"
    );
    const stored = store.getRunResultForSubject(
      lease.run.runId,
      "subj_profile_closure"
    );
    const storedResult = stored?.result as unknown as {
      quality: { warnings: string[] };
      review: {
        markdown: string;
        references: Array<{ publication_year: number }>;
      };
    };
    expect(storedResult.quality.warnings).toContain(
      "unsupported_numeric_claims_redacted"
    );
    expect(storedResult.review.markdown).not.toContain("2025 patients");
    expect(storedResult.review.markdown).toContain("unverified patients");
    expect(storedResult.review.markdown).toContain("[1]");
    expect(storedResult.review.references[0]?.publication_year).toBe(2025);
    expect(existsSync(artifactRoot)).toBe(true);
    store.close();
  });

  it("does not apply free-narrative numeric rules to exact official profile claims", async () => {
    const fixture = createLeasedWorkflowFixture(
      "official_numeric_profile_claim"
    );
    const numericProfileAdapters = adapters();
    numericProfileAdapters.fetchApprovedSource = async () => ({
      sourceId: "src_official_1",
      url: "https://hospital.example/doctor/example",
      title: "Example Hospital Doctor Profile",
      accessedAt: "2026-07-18T03:00:00.000Z",
      contentSha256: "a".repeat(64),
      untrustedText:
        "Example Doctor works in Cardiology at Example Hospital. " +
        "research3dprogram"
    });
    const output = modelOutput();
    output.profile.research_directions = ["research3dprogram"];
    output.profile.claims = [
      {
        claim_id: "clm_research_direction_numeric_official",
        claim_type: "research_direction",
        text: "research3dprogram",
        source_ids: ["src_official_1"],
        verification_status: "verified"
      }
    ];
    let modelCalls = 0;
    const validationCodes: string[][] = [];
    const outcome = await executeDoctorResearchWorkflow({
      lease: fixture.lease,
      store: fixture.store,
      adapters: numericProfileAdapters,
      modelClient: {
        model: "test-model",
        async generate() {
          modelCalls += 1;
          return {
            text: JSON.stringify(output),
            gatewayRequestId: `req_model_official_numeric_${modelCalls}`,
            usage: {
              promptTokens: 100,
              completionTokens: 100,
              totalTokens: 200
            }
          };
        }
      },
      artifactRoot: fixture.artifactRoot,
      policy: workflowPolicy(),
      signal: new AbortController().signal,
      onValidationFailure(event) {
        validationCodes.push([...event.errorCodes]);
      },
      now: () => fixture.now
    });

    expect(outcome).toEqual({ outcome: "succeeded" });
    expect(modelCalls).toBe(1);
    expect(validationCodes).toEqual([]);
    expect(
      fixture.store.getRunResultForSubject(
        fixture.lease.run.runId,
        fixture.lease.run.subjectId
      )
    ).toMatchObject({
      result: {
        profile: {
          research_directions: ["research3dprogram"]
        }
      }
    });
    fixture.store.close();
  });

  it("does not use numeric redaction to mask another output violation", async () => {
    const fixture = createLeasedWorkflowFixture(
      "numeric_redaction_contract"
    );
    const invalidAfterRedaction = modelOutput();
    invalidAfterRedaction.answers[0]!.answer = "Evidence 2025";
    invalidAfterRedaction.review.markdown =
      "The retrieved publication enrolled 2025 patients, but an unsafe [external link](https://attacker.invalid/) must not reach an artifact [1].";
    let modelCalls = 0;
    const validationCodes: string[][] = [];
    const outcome = await executeDoctorResearchWorkflow({
      lease: fixture.lease,
      store: fixture.store,
      adapters: adapters(),
      modelClient: {
        model: "test-model",
        async generate() {
          modelCalls += 1;
          return {
            text: JSON.stringify(invalidAfterRedaction),
            gatewayRequestId: `req_model_numeric_contract_${modelCalls}`,
            usage: {
              promptTokens: 100,
              completionTokens: 100,
              totalTokens: 200
            }
          };
        }
      },
      artifactRoot: fixture.artifactRoot,
      policy: workflowPolicy(),
      signal: new AbortController().signal,
      onValidationFailure(event) {
        validationCodes.push([...event.errorCodes]);
      },
      now: () => fixture.now
    });

    expect(outcome).toEqual({
      outcome: "failed",
      reason: "model_contract_error"
    });
    expect(modelCalls).toBe(2);
    expect(validationCodes).toEqual([
      ["unsafe_model_markup", "numeric_evidence_closure"],
      ["unsafe_model_markup", "numeric_evidence_closure"]
    ]);
    expect(existsSync(fixture.artifactRoot)).toBe(false);
    fixture.store.close();
  });

  it("does not infer a missing research direction without an explicit official label", async () => {
    const fixture = createLeasedWorkflowFixture(
      "explicit_research_direction_required"
    );
    const explicitOnlyAdapters = adapters();
    explicitOnlyAdapters.fetchApprovedSource = async () => ({
      sourceId: "src_official_1",
      url: "https://hospital.example/doctor/example",
      title: "Example Hospital Doctor Profile",
      accessedAt: "2026-07-18T03:00:00.000Z",
      contentSha256: "a".repeat(64),
      untrustedText:
        "Example Doctor works in Cardiology at Example Hospital."
    });
    const unsupported = modelOutput();
    unsupported.profile.research_directions = [
      "Invented oncology program"
    ];
    unsupported.profile.claims = [
      {
        claim_id: "clm_research_direction_invented",
        claim_type: "research_direction",
        text: "Invented oncology program",
        source_ids: ["src_official_1"],
        verification_status: "verified"
      }
    ];
    let modelCalls = 0;
    const validationCodes: string[][] = [];
    const outcome = await executeDoctorResearchWorkflow({
      lease: fixture.lease,
      store: fixture.store,
      adapters: explicitOnlyAdapters,
      modelClient: {
        model: "test-model",
        async generate() {
          modelCalls += 1;
          return {
            text: JSON.stringify(unsupported),
            gatewayRequestId: `req_model_explicit_only_${modelCalls}`,
            usage: {
              promptTokens: 100,
              completionTokens: 100,
              totalTokens: 200
            }
          };
        }
      },
      artifactRoot: fixture.artifactRoot,
      policy: workflowPolicy(),
      signal: new AbortController().signal,
      onValidationFailure(event) {
        validationCodes.push([...event.errorCodes]);
      },
      now: () => fixture.now
    });

    expect(outcome).toEqual({
      outcome: "failed",
      reason: "model_contract_error"
    });
    expect(modelCalls).toBe(2);
    expect(validationCodes).toEqual([
      ["verified_research_direction_required"],
      ["verified_research_direction_required"]
    ]);
    expect(existsSync(fixture.artifactRoot)).toBe(false);
    fixture.store.close();
  });

  it("rejects model-controlled links on both the initial and repair attempts", async () => {
    const fixture = createLeasedWorkflowFixture("unsafe_markup");
    const linked = modelOutput();
    linked.review.markdown =
      "The retrieved publication supports cautious synthesis, but an unsafe [external link](https://attacker.invalid/) must never reach an artifact [1].";
    let modelCalls = 0;
    const outcome = await executeDoctorResearchWorkflow({
      lease: fixture.lease,
      store: fixture.store,
      adapters: adapters(),
      modelClient: {
        model: "test-model",
        async generate() {
          modelCalls += 1;
          return {
            text: JSON.stringify(linked),
            gatewayRequestId: `req_model_unsafe_markup_${modelCalls}`,
            usage: {
              promptTokens: 100,
              completionTokens: 100,
              totalTokens: 200
            }
          };
        }
      },
      artifactRoot: fixture.artifactRoot,
      policy: workflowPolicy(),
      signal: new AbortController().signal,
      now: () => fixture.now
    });

    expect(outcome).toEqual({
      outcome: "failed",
      reason: "model_contract_error"
    });
    expect(modelCalls).toBe(2);
    expect(existsSync(fixture.artifactRoot)).toBe(false);
    fixture.store.close();
  });

  it.each([
    ["unsafe_uri_scheme", "file:///etc/passwd"],
    ["unsafe_html_entity", "&#x3c;script&#x3e;"],
    ["unsafe_bidi_control", "evidence\u202Etxt.exe"]
  ])("rejects model narrative control case %s", async (caseId, injection) => {
    const fixture = createLeasedWorkflowFixture(caseId);
    const linked = modelOutput();
    linked.review.abstract =
      `The retrieved evidence must not contain ${injection}.`;
    let modelCalls = 0;
    const outcome = await executeDoctorResearchWorkflow({
      lease: fixture.lease,
      store: fixture.store,
      adapters: adapters(),
      modelClient: {
        model: "test-model",
        async generate() {
          modelCalls += 1;
          return {
            text: JSON.stringify(linked),
            gatewayRequestId: `req_model_${caseId}_${modelCalls}`,
            usage: {
              promptTokens: 100,
              completionTokens: 100,
              totalTokens: 200
            }
          };
        }
      },
      artifactRoot: fixture.artifactRoot,
      policy: workflowPolicy(),
      signal: new AbortController().signal,
      now: () => fixture.now
    });

    expect(outcome).toEqual({
      outcome: "failed",
      reason: "model_contract_error"
    });
    expect(modelCalls).toBe(2);
    expect(existsSync(fixture.artifactRoot)).toBe(false);
    fixture.store.close();
  });

  it("marks only an initial model transport failure as safe for one run replay", async () => {
    const fixture = createLeasedWorkflowFixture("initial_model_transport");
    const outcome = await executeDoctorResearchWorkflow({
      lease: fixture.lease,
      store: fixture.store,
      adapters: adapters(),
      modelClient: {
        model: "test-model",
        async generate() {
          throw new ResearchModelClientError(
            "upstream_error",
            503,
            "req_initial_model_transport"
          );
        }
      },
      artifactRoot: fixture.artifactRoot,
      policy: workflowPolicy(),
      signal: new AbortController().signal,
      now: () => fixture.now
    });

    expect(outcome).toEqual({
      outcome: "failed",
      reason: "upstream_unavailable",
      retryable: true
    });
    fixture.store.close();
  });

  it.each([
    ["invalid_response", 200],
    ["empty_response", 200],
    ["upstream_error", 401]
  ] as const)(
    "does not replay a non-transient initial model failure (%s/%i)",
    async (code, statusCode) => {
      const fixture = createLeasedWorkflowFixture(
        `non_transient_model_${code}_${statusCode}`
      );
      const outcome = await executeDoctorResearchWorkflow({
        lease: fixture.lease,
        store: fixture.store,
        adapters: adapters(),
        modelClient: {
          model: "test-model",
          async generate() {
            throw new ResearchModelClientError(
              code,
              statusCode,
              `req_non_transient_${code}`
            );
          }
        },
        artifactRoot: fixture.artifactRoot,
        policy: workflowPolicy(),
        signal: new AbortController().signal,
        now: () => fixture.now
      });

      expect(outcome).toEqual({
        outcome: "failed",
        reason: "upstream_unavailable",
        retryable: false
      });
      fixture.store.close();
    }
  );

  it("does not replay a full run after a repair-call transport failure", async () => {
    const fixture = createLeasedWorkflowFixture("repair_model_transport");
    let calls = 0;
    const outcome = await executeDoctorResearchWorkflow({
      lease: fixture.lease,
      store: fixture.store,
      adapters: adapters(),
      modelClient: {
        model: "test-model",
        async generate() {
          calls += 1;
          if (calls === 1) {
            return {
              text: "not-json",
              gatewayRequestId: "req_repair_transport_initial",
              usage: {
                promptTokens: 100,
                completionTokens: 10,
                totalTokens: 110
              }
            };
          }
          throw new ResearchModelClientError(
            "upstream_error",
            503,
            "req_repair_transport_failure"
          );
        }
      },
      artifactRoot: fixture.artifactRoot,
      policy: workflowPolicy(),
      signal: new AbortController().signal,
      now: () => fixture.now
    });

    expect(calls).toBe(2);
    expect(outcome).toEqual({
      outcome: "failed",
      reason: "upstream_unavailable",
      retryable: false
    });
    fixture.store.close();
  });

  it("does not replay all adapters after an adapter exhausts its own retries", async () => {
    const fixture = createLeasedWorkflowFixture("adapter_transport");
    const unavailableAdapters = adapters();
    unavailableAdapters.searchOfficialSources = async () => {
      throw new ResearchHttpError(503, null);
    };
    let modelCalls = 0;
    const outcome = await executeDoctorResearchWorkflow({
      lease: fixture.lease,
      store: fixture.store,
      adapters: unavailableAdapters,
      modelClient: {
        model: "test-model",
        async generate() {
          modelCalls += 1;
          throw new Error("Model must not run after adapter failure.");
        }
      },
      artifactRoot: fixture.artifactRoot,
      policy: workflowPolicy(),
      signal: new AbortController().signal,
      now: () => fixture.now
    });

    expect(modelCalls).toBe(0);
    expect(outcome).toEqual({
      outcome: "failed",
      reason: "upstream_unavailable",
      retryable: false
    });
    fixture.store.close();
  });

  it("bridges a Chinese display identity to verified PubMed metadata without changing localized artifacts", async () => {
    const input = runInput();
    input.language = "zh-CN";
    input.doctor = {
      name: "陆清声",
      hospital: "海军军医大学第一附属医院",
      department: "血管外科",
      title: "教授、主任医师",
      city: "上海",
      orcid: null,
      literatureIdentity: {
        name: "Lu Qingsheng",
        hospital: "Changhai Hospital",
        department: "Vascular Surgery"
      }
    };
    const fixture = createLeasedWorkflowFixture(
      "verified_literature_identity",
      input
    );
    const bilingualAdapters = adapters(0);
    let observedQuery = "";
    bilingualAdapters.searchPubMed = async (query) => {
      observedQuery = query;
      return ["1001"];
    };
    bilingualAdapters.fetchApprovedSource = async () => ({
      sourceId: "src_official_1",
      url: "https://hospital.example/doctor/lu",
      title: "陆清声",
      accessedAt: "2026-07-18T03:00:00.000Z",
      contentSha256: "a".repeat(64),
      untrustedText:
        "陆清声 海军军医大学第一附属医院 血管外科。LU Qingsheng。" +
        "研究方向为血管外科临床证据。"
    });
    bilingualAdapters.getPubMedMetadata = async () => ({
      referenceId: "ref_pubmed_1001",
      pmid: "1001",
      doi: null,
      title: "Retrieved Clinical Evidence",
      journal: "Evidence Journal",
      publicationYear: 2025,
      authors: ["Lu Q"],
      authorAffiliations: [
        {
          author: "Qingsheng Lu",
          affiliations: [
            "Department of Vascular Surgery, Changhai Hospital, Naval Medical University, Shanghai, China."
          ]
        }
      ],
      abstractText:
        "Randomized evidence from the retrieved abstract supports cautious synthesis.",
      sourceUrl: "https://pubmed.ncbi.nlm.nih.gov/1001/",
      accessedAt: "2026-07-18T03:00:00.000Z",
      contentSha256: "b".repeat(64)
    });
    const localizedOutput = modelOutput();
    localizedOutput.profile.research_directions = [
      "研究方向为血管外科临床证据"
    ];
    localizedOutput.profile.claims = [
      {
        claim_id: "clm_research_direction_1",
        claim_type: "research_direction",
        text: "研究方向为血管外科临床证据",
        source_ids: ["src_official_1"],
        verification_status: "verified"
      }
    ];
    localizedOutput.review.title = "公开证据综述";
    localizedOutput.review.abstract = "基于已核验公开资料进行谨慎综合。";
    localizedOutput.review.keywords = ["血管外科", "公开证据"];
    localizedOutput.review.markdown =
      "检索到的公开文献支持谨慎综合现有证据，同时仍需明确研究方法与公开资料本身存在的局限性，并避免超出来源范围推断结论。[1]";
    localizedOutput.review.core_evidence = [
      {
        reference_id: "ref_pmid_1001",
        study_type: "公开文献",
        sample_and_source: "公开摘要",
        methods: "根据已检索摘要概括研究方法。",
        key_results: "公开摘要支持谨慎综合证据。",
        limitations: "仅使用公开元数据与摘要证据。"
      }
    ];
    localizedOutput.predicted_questions = [
      "检索到了哪些公开证据？",
      "医生身份是怎样核验的？",
      "现有证据还存在哪些局限？",
      "哪些来源支持这份综述？",
      "应当怎样谨慎理解这些结果？"
    ];
    localizedOutput.answers = localizedOutput.answers.map(
      (answer, index) => ({
        ...answer,
        question_index: index + 1,
        answer: "回答严格限于已经检索并核验的公开证据。"
      })
    );
    const validationErrors: string[][] = [];
    const outcome = await executeDoctorResearchWorkflow({
      lease: fixture.lease,
      store: fixture.store,
      adapters: bilingualAdapters,
      modelClient: {
        model: "test-model",
        async generate() {
          return {
            text: JSON.stringify(localizedOutput),
            gatewayRequestId: "req_model_literature_identity",
            usage: {
              promptTokens: 100,
              completionTokens: 1_000,
              totalTokens: 1_100
            }
          };
        }
      },
      artifactRoot: fixture.artifactRoot,
      policy: workflowPolicy(),
      signal: new AbortController().signal,
      onValidationFailure(event) {
        validationErrors.push([...event.errorCodes]);
      },
      now: () => fixture.now
    });

    expect(outcome, JSON.stringify(validationErrors)).toEqual({
      outcome: "succeeded"
    });
    expect(observedQuery).toBe(
      '("Lu Qingsheng"[Author] AND "Changhai Hospital"[Affiliation] AND "Vascular Surgery"[Affiliation]) AND (2022:2026[Date - Publication])'
    );
    const stored = fixture.store.getRunResultForSubject(
      fixture.lease.run.runId,
      "subj_verified_literature_identity"
    );
    const filenames = (
      stored?.result as unknown as {
        artifacts: Array<{ filename: string }>;
      }
    ).artifacts.map((artifact) => artifact.filename);
    expect(filenames).toEqual([
      "陆清声_基础信息与研究方向.md",
      "陆清声_相关领域前沿综述.md",
      "陆清声_医生可能问机器人问题.txt",
      "陆清声_问题与答案.md"
    ]);
    fixture.store.close();
  });

  it("rejects a PubMed identity alias that is not co-located with the display identity on an official source", async () => {
    const input = runInput();
    input.doctor = {
      ...input.doctor,
      name: "陆清声",
      hospital: "海军军医大学第一附属医院",
      department: "血管外科",
      literatureIdentity: {
        name: "Lu Qingsheng",
        hospital: "Changhai Hospital",
        department: "Vascular Surgery"
      }
    };
    const fixture = createLeasedWorkflowFixture(
      "unbridged_literature_identity",
      input
    );
    const unbridgedAdapters = adapters(0);
    unbridgedAdapters.fetchApprovedSource = async () => ({
      sourceId: "src_official_1",
      url: "https://hospital.example/doctor/lu",
      title: "陆清声",
      accessedAt: "2026-07-18T03:00:00.000Z",
      contentSha256: "a".repeat(64),
      untrustedText:
        "陆清声 海军军医大学第一附属医院 血管外科。Clinical evidence is the listed research direction."
    });
    let modelCalls = 0;
    const outcome = await executeDoctorResearchWorkflow({
      lease: fixture.lease,
      store: fixture.store,
      adapters: unbridgedAdapters,
      modelClient: {
        model: "test-model",
        async generate() {
          modelCalls += 1;
          throw new Error("Model must not run for an unbridged identity.");
        }
      },
      artifactRoot: fixture.artifactRoot,
      policy: workflowPolicy(),
      signal: new AbortController().signal,
      now: () => fixture.now
    });

    expect(outcome).toEqual({
      outcome: "failed",
      reason: "identity_not_resolved"
    });
    expect(modelCalls).toBe(0);
    expect(existsSync(fixture.artifactRoot)).toBe(false);
    fixture.store.close();
  });

  it("rejects a publication when only another department is attributed to the target author", async () => {
    const fixture = createLeasedWorkflowFixture("wrong_department");
    const mismatchedAdapters = adapters();
    mismatchedAdapters.getPubMedMetadata = async () => ({
      referenceId: "ref_pubmed_1001",
      pmid: "1001",
      doi: null,
      title: "Retrieved Clinical Evidence",
      journal: "Evidence Journal",
      publicationYear: 2025,
      authors: ["Example Doctor"],
      authorAffiliations: [
        {
          author: "Example Doctor",
          affiliations: ["Oncology, Example Hospital."]
        }
      ],
      abstractText:
        "Randomized evidence from the retrieved abstract supports cautious synthesis.",
      sourceUrl: "https://pubmed.ncbi.nlm.nih.gov/1001/",
      accessedAt: "2026-07-18T03:00:00.000Z",
      contentSha256: "b".repeat(64)
    });
    let modelCalls = 0;
    const outcome = await executeDoctorResearchWorkflow({
      lease: fixture.lease,
      store: fixture.store,
      adapters: mismatchedAdapters,
      modelClient: {
        model: "test-model",
        async generate() {
          modelCalls += 1;
          throw new Error("Model must not run without attributed literature.");
        }
      },
      artifactRoot: fixture.artifactRoot,
      policy: workflowPolicy(),
      signal: new AbortController().signal,
      now: () => fixture.now
    });

    expect(outcome).toEqual({
      outcome: "failed",
      reason: "insufficient_research_evidence"
    });
    expect(modelCalls).toBe(0);
    expect(existsSync(fixture.artifactRoot)).toBe(false);
    fixture.store.close();
  });

  it("does not combine a target author's separate publication affiliations", async () => {
    const fixture = createLeasedWorkflowFixture("split_affiliations");
    const splitAffiliationAdapters = adapters();
    splitAffiliationAdapters.getPubMedMetadata = async () => ({
      referenceId: "ref_pubmed_1001",
      pmid: "1001",
      doi: null,
      title: "Retrieved Clinical Evidence",
      journal: "Evidence Journal",
      publicationYear: 2025,
      authors: ["Example Doctor"],
      authorAffiliations: [
        {
          author: "Example Doctor",
          affiliations: [
            "Oncology, Example Hospital.",
            "Cardiology, Different Hospital."
          ]
        }
      ],
      abstractText:
        "Randomized evidence from the retrieved abstract supports cautious synthesis.",
      sourceUrl: "https://pubmed.ncbi.nlm.nih.gov/1001/",
      accessedAt: "2026-07-18T03:00:00.000Z",
      contentSha256: "b".repeat(64)
    });
    let modelCalls = 0;
    const outcome = await executeDoctorResearchWorkflow({
      lease: fixture.lease,
      store: fixture.store,
      adapters: splitAffiliationAdapters,
      modelClient: {
        model: "test-model",
        async generate() {
          modelCalls += 1;
          throw new Error("Model must not run for split affiliations.");
        }
      },
      artifactRoot: fixture.artifactRoot,
      policy: workflowPolicy(),
      signal: new AbortController().signal,
      now: () => fixture.now
    });

    expect(outcome).toEqual({
      outcome: "failed",
      reason: "insufficient_research_evidence"
    });
    expect(modelCalls).toBe(0);
    fixture.store.close();
  });

  it("does not combine distant website text into one verified doctor identity", async () => {
    const fixture = createLeasedWorkflowFixture("distant_identity");
    const distantIdentityAdapters = adapters();
    distantIdentityAdapters.fetchApprovedSource = async () => ({
      sourceId: "src_official_1",
      url: "https://hospital.example/doctor/directory",
      title: "Example Hospital Directory",
      accessedAt: "2026-07-18T03:00:00.000Z",
      contentSha256: "a".repeat(64),
      untrustedText:
        `Example Doctor ${"unrelated directory text ".repeat(300)}` +
        "Cardiology at Example Hospital"
    });
    let modelCalls = 0;
    const outcome = await executeDoctorResearchWorkflow({
      lease: fixture.lease,
      store: fixture.store,
      adapters: distantIdentityAdapters,
      modelClient: {
        model: "test-model",
        async generate() {
          modelCalls += 1;
          throw new Error("Model must not run for an unclosed identity.");
        }
      },
      artifactRoot: fixture.artifactRoot,
      policy: workflowPolicy(),
      signal: new AbortController().signal,
      now: () => fixture.now
    });

    expect(outcome).toEqual({
      outcome: "failed",
      reason: "identity_not_resolved"
    });
    expect(modelCalls).toBe(0);
    expect(existsSync(fixture.artifactRoot)).toBe(false);
    fixture.store.close();
  });

  it("does not treat an English name embedded in a longer name as the same identity", async () => {
    const input = runInput();
    input.doctor.name = "Ann Lee";
    const fixture = createLeasedWorkflowFixture(
      "embedded_identity_name",
      input
    );
    const embeddedNameAdapters = adapters();
    embeddedNameAdapters.fetchApprovedSource = async () => ({
      sourceId: "src_official_1",
      url: "https://hospital.example/doctor/joann-lee",
      title: "Example Hospital Doctor Profile",
      accessedAt: "2026-07-18T03:00:00.000Z",
      contentSha256: "a".repeat(64),
      untrustedText:
        "Joann Lee works in Cardiology at Example Hospital. Clinical research is listed."
    });
    let modelCalls = 0;
    const outcome = await executeDoctorResearchWorkflow({
      lease: fixture.lease,
      store: fixture.store,
      adapters: embeddedNameAdapters,
      modelClient: {
        model: "test-model",
        async generate() {
          modelCalls += 1;
          throw new Error("Model must not run for an embedded-name match.");
        }
      },
      artifactRoot: fixture.artifactRoot,
      policy: workflowPolicy(),
      signal: new AbortController().signal,
      now: () => fixture.now
    });

    expect(outcome).toEqual({
      outcome: "failed",
      reason: "identity_not_resolved"
    });
    expect(modelCalls).toBe(0);
    fixture.store.close();
  });

  it("matches the requested ORCID anchors against one later employment record", async () => {
    const input = runInput();
    input.doctor.orcid = "0000-0002-1825-0097";
    const fixture = createLeasedWorkflowFixture(
      "orcid_later_employment",
      input
    );
    const orcidAdapters = adapters();
    orcidAdapters.lookupOrcid = async () => ({
      canonicalIdentityId: "dci_orcid0000000218250097",
      name: "Example Doctor",
      institution: "Previous Hospital",
      department: "Oncology",
      affiliations: [
        {
          institution: "Previous Hospital",
          department: "Oncology"
        },
        {
          institution: "Example Hospital",
          department: "Cardiology"
        }
      ],
      orcid: "0000-0002-1825-0097",
      sourceUrl: "https://orcid.org/0000-0002-1825-0097",
      accessedAt: "2026-07-18T03:00:00.000Z",
      contentSha256: "c".repeat(64)
    });
    const outcome = await executeDoctorResearchWorkflow({
      lease: fixture.lease,
      store: fixture.store,
      adapters: orcidAdapters,
      modelClient: {
        model: "test-model",
        async generate() {
          return {
            text: JSON.stringify(modelOutput()),
            gatewayRequestId: "req_model_orcid_later_employment",
            usage: {
              promptTokens: 100,
              completionTokens: 100,
              totalTokens: 200
            }
          };
        }
      },
      artifactRoot: fixture.artifactRoot,
      policy: workflowPolicy(),
      signal: new AbortController().signal,
      now: () => fixture.now
    });

    expect(outcome).toEqual({ outcome: "succeeded" });
    expect(
      fixture.store.getRunResultForSubject(
        fixture.lease.run.runId,
        fixture.lease.run.subjectId
      )
    ).toMatchObject({
      result: {
        identity_resolution: {
          canonical_identity_id: "dci_orcid0000000218250097",
          matched_by: expect.arrayContaining([
            "orcid",
            "institution",
            "department"
          ])
        }
      }
    });
    fixture.store.close();
  });

  it("starts the real Worker loop, becomes ready after backup, leases one run, and drains cleanly", async () => {
    const root = temporaryDirectory();
    const config = workerConfig(root);
    const observer = createResearchSqliteStore({
      path: config.databasePath,
      limits: config.admissionLimits,
      ...config.store
    });
    cleanupStores.push(observer);
    const created = observer.createRun({
      subjectId: "subj_worker_runtime",
      credentialId: "cred_worker_runtime",
      requestId: "req_worker_runtime",
      idempotencyKey: "research:worker-runtime",
      requestHash: "request-hash-runtime",
      identityFingerprint: "identity-fingerprint-runtime",
      input: runInput()
    });
    if (created.outcome !== "created") {
      throw new Error("Research runtime test run was not created.");
    }
    const controller = new AbortController();
    const events: string[] = [];
    const runtime = runResearchWorker({
      config,
      signal: controller.signal,
      logger: {
        info(event) {
          events.push(event);
        },
        error(event) {
          events.push(event);
        }
      },
      dependencies: {
        adapters: {
          ...adapters(),
          async assertAvailable() {}
        },
        modelClient: {
          model: "test-model",
          async assertModelAvailable() {},
          async generate() {
            return {
              text: JSON.stringify(modelOutput()),
              gatewayRequestId: "req_model_runtime",
              usage: {
                promptTokens: 100,
                completionTokens: 100,
                totalTokens: 200
              }
            };
          }
        }
      }
    });

    await waitFor(
      () =>
        observer.getRunForSubject(
          created.run.runId,
          "subj_worker_runtime"
        )?.status === "succeeded",
      5_000
    );
    controller.abort(new Error("Runtime test drain."));
    await runtime;

    expect(events).toContain("research_worker_ready");
    expect(events).toContain("research_lease_acquired");
    expect(events).toContain("research_worker_stopped");
    expect(JSON.stringify(events)).not.toContain("Example Doctor");
    expect(observer.latestSuccessfulBackupAt()).not.toBeNull();
    expect(
      observer.database
        .prepare(
          "SELECT COUNT(*) AS count FROM research_artifacts WHERE run_id = ?"
        )
        .get(created.run.runId)
    ).toEqual({ count: 4 });
    expect(
      readdirSync(path.join(config.artifactRoot, created.run.runId))
    ).toHaveLength(4);
    expect(
      observer
        .listWorkerHeartbeats({
          staleAfterSeconds: 45
        })
        .find((heartbeat) => heartbeat.workerId === config.workerId)?.state
    ).toBe("draining");
    observer.close();
  });

  it("withdraws its ready heartbeat and exits after a dependency fails both run attempts", async () => {
    const root = temporaryDirectory();
    const config = workerConfig(root);
    const observer = createResearchSqliteStore({
      path: config.databasePath,
      limits: config.admissionLimits,
      ...config.store
    });
    cleanupStores.push(observer);
    const created = observer.createRun({
      subjectId: "subj_worker_dependency_failure",
      credentialId: "cred_worker_dependency_failure",
      requestId: "req_worker_dependency_failure",
      idempotencyKey: "research:worker-dependency-failure",
      requestHash: "request-hash-worker-dependency-failure",
      identityFingerprint: "identity-fingerprint-worker-dependency-failure",
      input: runInput()
    });
    if (created.outcome !== "created") {
      throw new Error("Research dependency-failure test run was not created.");
    }
    const changingAdapters = adapters();
    const originalFetchApprovedSource =
      changingAdapters.fetchApprovedSource.bind(changingAdapters);
    let officialFetches = 0;
    changingAdapters.fetchApprovedSource = async (sourceId, signal) => {
      officialFetches += 1;
      const source = await originalFetchApprovedSource(sourceId, signal);
      return source
        ? {
            ...source,
            accessedAt:
              officialFetches === 1
                ? "2026-07-18T03:00:00.000Z"
                : "2026-07-18T03:00:01.000Z"
          }
        : null;
    };
    let modelCalls = 0;
    const runtime = runResearchWorker({
      config,
      signal: new AbortController().signal,
      logger: {
        info() {},
        error() {}
      },
      dependencies: {
        adapters: {
          ...changingAdapters,
          async assertAvailable() {}
        },
        modelClient: {
          model: "test-model",
          async assertModelAvailable() {},
          async generate() {
            modelCalls += 1;
            throw new ResearchModelClientError(
              "upstream_error",
              503,
              `req_model_dependency_failure_${modelCalls}`
            );
          }
        }
      }
    });

    await expect(runtime).rejects.toThrow(
      "dependencies remained unavailable"
    );
    expect(modelCalls).toBe(2);
    expect(
      observer.getRunForSubject(
        created.run.runId,
        "subj_worker_dependency_failure"
      )
    ).toMatchObject({
      status: "failed",
      terminalReason: "upstream_unavailable",
      attemptCount: 2
    });
    expect(
      observer
        .listWorkerHeartbeats({ staleAfterSeconds: 45 })
        .find((heartbeat) => heartbeat.workerId === config.workerId)?.state
    ).toBe("draining");
    observer.close();
  });

  it("runs authenticated POST through Worker success, GET result, and four verified downloads", async () => {
    const root = temporaryDirectory();
    const config = workerConfig(root);
    const gatewayStore = createSqliteStore({ path: ":memory:" });
    const researchGatewayStore = createResearchSqliteStore({
      path: config.databasePath,
      limits: config.admissionLimits,
      ...config.store
    });
    cleanupStores.push(gatewayStore, researchGatewayStore);
    const subjectId = "subj_controlled_beta_e2e";
    const issued = issueAccessCredential({
      subjectId,
      label: "Controlled beta E2E",
      scope: "code",
      expiresAt: new Date("2030-01-01T00:00:00.000Z"),
      now: new Date()
    });
    gatewayStore.upsertSubject({
      id: subjectId,
      label: "Controlled beta E2E",
      state: "active",
      createdAt: new Date()
    });
    gatewayStore.insertAccessCredential(issued.record);
    gatewayStore.createPlan({
      id: "plan_controlled_beta_e2e_v1",
      displayName: "Controlled beta E2E",
      policy: {
        tokensPerMinute: null,
        tokensPerDay: null,
        tokensPerMonth: null,
        maxPromptTokensPerRequest: null,
        maxTotalTokensPerRequest: null,
        reserveTokensPerRequest: 0,
        missingUsageCharge: "none"
      },
      featurePolicy: {
        capabilities: ["doctor_research"],
        imageGeneration: null,
        medcodeModels: null
      },
      scopeAllowlist: ["code"],
      now: new Date()
    });
    gatewayStore.grantEntitlement({
      subjectId,
      planId: "plan_controlled_beta_e2e_v1",
      periodKind: "unlimited",
      now: new Date()
    });
    const app = buildGateway({
      authMode: "credential",
      provider,
      sessionStore: gatewayStore,
      researchStore: researchGatewayStore,
      researchWorkerHealthStore: researchGatewayStore,
      researchAcceptWhenWorkerUnavailable: false,
      researchWorkerStaleAfterSeconds: 45,
      researchArtifactRoot: config.artifactRoot,
      researchMaximumArtifactBytes: 200_000,
      researchAdmissionGuard: async () =>
        researchGatewayStore.latestSuccessfulBackupAt()
          ? null
          : new GatewayError({
              code: "research_backup_stale",
              message: "Research backups are stale.",
              httpStatus: 503,
              retryAfterSeconds: 60
            }),
      logger: false
    });
    const controller = new AbortController();
    const runtime = runResearchWorker({
      config,
      signal: controller.signal,
      logger: {
        info() {},
        error() {}
      },
      dependencies: {
        adapters: {
          ...adapters(),
          async assertAvailable() {}
        },
        modelClient: {
          model: "test-model",
          async assertModelAvailable() {},
          async generate() {
            return {
              text: JSON.stringify(modelOutput()),
              gatewayRequestId: "req_model_http_e2e",
              usage: {
                promptTokens: 100,
                completionTokens: 100,
                totalTokens: 200
              }
            };
          }
        }
      }
    });
    try {
      await waitFor(
        () =>
          researchGatewayStore
            .listWorkerHeartbeats({ staleAfterSeconds: 45 })
            .some((heartbeat) => heartbeat.state === "ready"),
        5_000
      );
      const authorization = `Bearer ${issued.token}`;
      const created = await app.inject({
        method: "POST",
        url: "/gateway/research/v1/doctor-runs",
        headers: {
          authorization,
          "idempotency-key": "research:http-controlled-beta-e2e"
        },
        payload: {
          doctor: {
            name: "Example Doctor",
            hospital: "Example Hospital",
            department: "Cardiology",
            title: null,
            city: "Sydney",
            orcid: null
          },
          mode: "brief",
          language: "en",
          options: {
            publication_years: 5,
            citation_style: "vancouver"
          },
          client_reference: "controlled-beta-e2e"
        }
      });
      expect(created.statusCode).toBe(202);
      const runId = created.json().run_id as string;
      expect(runId).toMatch(/^drr_[a-f0-9]{32}$/u);
      const initialStatus = await app.inject({
        method: "GET",
        url: `/gateway/research/v1/doctor-runs/${runId}`,
        headers: { authorization }
      });
      expect(initialStatus.statusCode).toBe(200);
      expect(["queued", "running", "succeeded"]).toContain(
        initialStatus.json().status
      );
      await waitFor(
        () =>
          researchGatewayStore.getRunForSubject(runId, subjectId)?.status ===
          "succeeded",
        5_000
      );
      const finalStatus = await app.inject({
        method: "GET",
        url: `/gateway/research/v1/doctor-runs/${runId}`,
        headers: { authorization }
      });
      expect(finalStatus.json()).toMatchObject({
        status: "succeeded",
        stage: "complete",
        progress: { percent: 100 }
      });
      const resultResponse = await app.inject({
        method: "GET",
        url: `/gateway/research/v1/doctor-runs/${runId}/result`,
        headers: { authorization }
      });
      expect(resultResponse.statusCode).toBe(200);
      const result = resultResponse.json() as {
        artifacts: Array<{
          artifact_id: string;
          kind: string;
          size_bytes: number;
          sha256: string;
          download_url: string;
        }>;
      };
      expect(result.artifacts).toHaveLength(4);
      expect(new Set(result.artifacts.map((artifact) => artifact.kind))).toEqual(
        new Set(["profile", "review", "questions", "answers"])
      );
      for (const artifact of result.artifacts) {
        const downloaded = await app.inject({
          method: "GET",
          url: artifact.download_url,
          headers: { authorization }
        });
        expect(downloaded.statusCode).toBe(200);
        expect(downloaded.rawPayload.length).toBe(artifact.size_bytes);
        expect(
          createHash("sha256")
            .update(downloaded.rawPayload)
            .digest("hex")
        ).toBe(artifact.sha256);
      }
      expect(
        researchGatewayStore.database
          .prepare(
            `SELECT
               (SELECT COUNT(*) FROM research_sources WHERE run_id = ?) AS sources,
               (SELECT COUNT(*) FROM research_claims WHERE run_id = ?) AS claims,
               (SELECT COUNT(*) FROM research_references WHERE run_id = ?) AS refs,
               (SELECT COUNT(*) FROM research_artifacts WHERE run_id = ?) AS artifacts`
          )
          .get(runId, runId, runId, runId)
      ).toEqual({ sources: 2, claims: 2, refs: 1, artifacts: 4 });
    } finally {
      controller.abort(new Error("HTTP controlled-beta E2E drain."));
      await Promise.allSettled([runtime]);
      await app.close();
    }
  });

  it("converges a cancellation requested after the last lease renewal and before terminal commit", async () => {
    const root = temporaryDirectory();
    const config = workerConfig(root);
    const observer = createResearchSqliteStore({
      path: config.databasePath,
      limits: config.admissionLimits,
      ...config.store
    });
    cleanupStores.push(observer);
    const created = observer.createRun({
      subjectId: "subj_cancel_race",
      credentialId: "cred_cancel_race",
      requestId: "req_cancel_race_create",
      idempotencyKey: "research:cancel-race-create",
      requestHash: "request-hash-cancel-race",
      identityFingerprint: "identity-fingerprint-cancel-race",
      input: runInput()
    });
    if (created.outcome !== "created") {
      throw new Error("Research cancellation-race run was not created.");
    }
    const controller = new AbortController();
    let cancellationRequested = false;
    const runtime = runResearchWorker({
      config,
      signal: controller.signal,
      logger: {
        info() {},
        error() {}
      },
      dependencies: {
        adapters: {
          ...adapters(),
          async assertAvailable() {}
        },
        modelClient: {
          model: "test-model",
          async assertModelAvailable() {},
          async generate() {
            const cancelled = observer.requestCancel({
              runId: created.run.runId,
              subjectId: "subj_cancel_race",
              credentialId: "cred_cancel_race",
              requestId: "req_cancel_race_request",
              idempotencyKey: "research:cancel-race-request",
              requestHash: "request-hash-cancel-race-request"
            });
            expect(cancelled.outcome).toBe("accepted");
            cancellationRequested = true;
            return {
              text: JSON.stringify(modelOutput()),
              gatewayRequestId: "req_model_cancel_race",
              usage: {
                promptTokens: 100,
                completionTokens: 100,
                totalTokens: 200
              }
            };
          }
        }
      }
    });

    await waitFor(
      () =>
        observer.getRunForSubject(
          created.run.runId,
          "subj_cancel_race"
        )?.status === "cancelled",
      5_000
    );
    controller.abort(new Error("Cancellation race test drain."));
    await runtime;

    expect(cancellationRequested).toBe(true);
    expect(
      observer.getRunForSubject(created.run.runId, "subj_cancel_race")
    ).toMatchObject({
      status: "cancelled",
      terminalReason: "cancelled_by_user",
      leaseOwner: null,
      leaseUntil: null
    });
    expect(
      observer.database
        .prepare(
          "SELECT COUNT(*) AS count FROM research_artifacts WHERE run_id = ?"
        )
        .get(created.run.runId)
    ).toEqual({ count: 0 });
    expect(existsSync(path.join(config.artifactRoot, created.run.runId))).toBe(
      false
    );
    observer.close();
  });
});

function adapters(
  officialSearchRequestUnits?: number
): ResearchAdapterBundle {
  return {
    ...(officialSearchRequestUnits === undefined
      ? {}
      : {
          budgetHints: {
            officialSearchRequestUnits
          }
        }),
    async searchPubMed() {
      return ["1001"];
    },
    async getPubMedMetadata() {
      return {
        referenceId: "ref_pubmed_1001",
        pmid: "1001",
        doi: null,
        title: "Retrieved Clinical Evidence",
        journal: "Evidence Journal",
        publicationYear: 2025,
        authors: ["Example Doctor"],
        authorAffiliations: [
          {
            author: "Example Doctor",
            affiliations: ["Cardiology, Example Hospital."]
          }
        ],
        abstractText:
          "Randomized evidence from the retrieved abstract supports cautious synthesis.",
        sourceUrl: "https://pubmed.ncbi.nlm.nih.gov/1001/",
        accessedAt: "2026-07-18T03:00:00.000Z",
        contentSha256: "b".repeat(64)
      };
    },
    async getCrossrefMetadata() {
      return null;
    },
    async lookupOrcid() {
      return null;
    },
    async searchOfficialSources() {
      return ["src_official_1"];
    },
    async fetchApprovedSource() {
      return {
        sourceId: "src_official_1",
        url: "https://hospital.example/doctor/example",
        title: "Example Hospital Doctor Profile",
        accessedAt: "2026-07-18T03:00:00.000Z",
        contentSha256: "a".repeat(64),
        untrustedText:
          "Example Doctor works in Cardiology at Example Hospital. Research area: Cardiology. Email: doctor@example.test. Clinical evidence is the listed research direction."
      };
    }
  };
}

function runInput(): DoctorResearchRunInput {
  return {
    doctor: {
      name: "Example Doctor",
      hospital: "Example Hospital",
      department: "Cardiology",
      title: null,
      city: "Sydney",
      orcid: null
    },
    mode: "brief",
    language: "en",
    options: {
      publicationYears: 5,
      citationStyle: "vancouver"
    },
    clientReference: null
  };
}

function modelOutput(): DoctorResearchModelOutput {
  return {
    schema_version: "doctor_research_model_output.v1",
    doctor: {
      name: "Example Doctor",
      hospital: "Example Hospital",
      department: "Cardiology"
    },
    identity_resolution: {
      status: "verified",
      confidence: "medium",
      canonical_identity_id: "dci_example01",
      matched_by: ["institution", "department"]
    },
    sources: [
      {
        source_id: "src_official_1",
        source_type: "official_web",
        title: "Example Hospital Doctor Profile",
        url: "https://hospital.example/doctor/example",
        accessed_at: "2026-07-18T03:00:00.000Z",
        content_sha256: "a".repeat(64)
      },
      {
        source_id: "src_pubmed_1001",
        source_type: "pubmed",
        title: "Retrieved Clinical Evidence",
        url: "https://pubmed.ncbi.nlm.nih.gov/1001/",
        accessed_at: "2026-07-18T03:00:00.000Z",
        content_sha256: "b".repeat(64)
      }
    ],
    profile: {
      positions: [],
      expertise: [],
      education_and_career: [],
      research_directions: [
        "Clinical evidence is the listed research direction"
      ],
      representative_outputs: [],
      claims: [
        {
          claim_id: "clm_research_direction_1",
          claim_type: "research_direction",
          text: "Clinical evidence is the listed research direction",
          source_ids: ["src_official_1"],
          verification_status: "verified"
        }
      ],
      primary_public_source_ids: ["src_official_1"]
    },
    review: {
      title: "Retrieved Evidence Review",
      abstract: "A cautious synthesis of the retrieved public evidence.",
      keywords: ["evidence"],
      markdown:
        "The retrieved publication supports a cautious evidence synthesis while its limits remain explicit [1].",
      core_evidence: [
        {
          reference_id: "ref_pmid_1001",
          study_type: "retrieved publication",
          sample_and_source: "PubMed abstract",
          methods: "Methods were summarized from the retrieved abstract.",
          key_results: "The abstract supports cautious synthesis.",
          limitations: "Only public metadata and abstract evidence were retrieved."
        }
      ],
      references: [
        {
          reference_id: "ref_pmid_1001",
          title: "Retrieved Clinical Evidence",
          journal: "Evidence Journal",
          publication_year: 2025,
          pmid: "1001",
          doi: null,
          verification_status: "verified"
        }
      ],
      search_report: {
        databases: ["pubmed"],
        searched_at: "2026-07-18T03:00:00.000Z",
        queries: ["retrieved evidence"],
        included_count: 1
      }
    },
    source_coverage: {
      literature_sources: ["pubmed"],
      profile_sources: ["official_web"],
      cutoff_date: "2026-07-18",
      warnings: []
    },
    predicted_questions: [
      "What evidence was retrieved?",
      "How was identity checked?",
      "What limits remain?",
      "Which source supports the review?",
      "How should the result be interpreted?"
    ],
    answers: [1, 2, 3, 4, 5].map((questionIndex) => ({
      question_index: questionIndex,
      answer: "The answer is limited to the retrieved public evidence.",
      source_ids: ["src_pubmed_1001"]
    })),
    quality: {
      status: "passed",
      checks: ["schema"],
      warnings: []
    }
  };
}

function workflowPolicy(): ResearchWorkerConfig["workflowPolicy"] {
  return {
    resultTtlSeconds: 2_592_000,
    maximumArtifactBytes: 200_000,
    maximumRunArtifactBytes: 800_000,
    maximumExternalResponseBytesPerCall: 2_000_000,
    maximumSourceTextCharacters: 20_000,
    maximumPublications: 1,
    minimumReferences: 1,
    minimumReviewContent: 10,
    maximumQuestionContent: 100,
    minimumAnswerContent: 2,
    maximumAnswerContent: 100,
    maximumInputTokensPerCall: 100_000,
    maximumOutputTokensPerCall: 2_000,
    hardDeadlineMs: 600_000,
    budgets: {
      externalRequests: 40,
      externalResponseBytes: 80_000_000,
      llmCalls: 3,
      inputTokens: 300_000,
      outputTokens: 6_000
    },
    forbiddenOutputFragments: ["ignore all prior instructions"]
  };
}

function createLeasedWorkflowFixture(
  suffix: string,
  input: DoctorResearchRunInput = runInput()
): {
  artifactRoot: string;
  lease: NonNullable<ReturnType<ReturnType<typeof createResearchSqliteStore>["acquireLease"]>>;
  now: Date;
  store: ReturnType<typeof createResearchSqliteStore>;
} {
  const root = temporaryDirectory();
  const store = createResearchSqliteStore({
    path: path.join(root, "research.db"),
    limits: {
      dailyRunsPerSubject: 2,
      uniqueDoctors30dPerSubject: 2,
      globalActiveRuns: 2,
      needsInputPerSubject: 2
    },
    resultTtlSeconds: 2_592_000,
    runRetentionSeconds: 7_776_000
  });
  cleanupStores.push(store);
  const now = new Date("2026-07-18T03:00:00.000Z");
  const created = store.createRun({
    subjectId: `subj_${suffix}`,
    credentialId: `cred_${suffix}`,
    requestId: `req_${suffix}`,
    idempotencyKey: `research:${suffix.replaceAll("_", "-")}`,
    requestHash: `request-hash-${suffix}`,
    identityFingerprint: `identity-fingerprint-${suffix}`,
    input,
    now
  });
  if (created.outcome !== "created") {
    throw new Error(`Research ${suffix} test run was not created.`);
  }
  const lease = store.acquireLease({
    workerId: `worker_${suffix}`,
    leaseSeconds: 120,
    now
  });
  if (!lease) {
    throw new Error(`Research ${suffix} test lease was not acquired.`);
  }
  return {
    artifactRoot: path.join(root, "artifacts"),
    lease,
    now,
    store
  };
}

function workerConfig(root: string): ResearchWorkerConfig {
  const state = path.join(root, "state");
  return {
    databasePath: path.join(state, "research.db"),
    artifactRoot: path.join(state, "artifacts"),
    backupRoot: path.join(root, "backups"),
    workerId: "research-runtime-test-worker",
    processVersion: "test.1",
    pollIntervalMs: 5,
    drainTimeoutMs: 1_000,
    leaseSeconds: 120,
    leaseRenewSeconds: 30,
    heartbeatSeconds: 15,
    reconcileIntervalSeconds: 60,
    cleanupIntervalSeconds: 3_600,
    backupIntervalSeconds: 3_600,
    backupMaxAgeMs: 7_200_000,
    backupRetentionCount: 2,
    embeddedMaintenanceEnabled: true,
    reconcileBatchSize: 100,
    cleanupBatchSize: 100,
    orphanGraceMs: 3_600_000,
    storagePolicy: {
      maximumResearchBytes: 1_000_000_000,
      minimumFreeBytes: 1,
      minimumFreePercent: 1
    },
    ncbiApiKeyFile: null,
    webSearchApiKeyFile: path.join(root, "unused-web-secret"),
    adapterOptions: {
      ncbi: {
        email: "operator@example.org",
        tool: "codex_gateway_doctor_research",
        maximumResults: 1
      },
      crossref: { mailto: "operator@example.org" },
      officialWeb: {
        provider: "brave",
        apiKey: "__loaded_from_file__",
        allowedDomains: ["hospital.example"],
        maximumResults: 1
      },
      timeoutMs: 1_000,
      maximumJsonBytes: 100_000,
      maximumSourceBytes: 100_000,
      userAgent: "codex-gateway-research-test/1.0"
    },
    orcid: {
      mode: "bearer_file",
      bearerTokenFile: path.join(root, "unused-orcid-secret")
    },
    llm: {
      baseUrl: "http://gateway:8787",
      allowedHosts: ["gateway"],
      model: "test-model",
      reasoningEffort: "low",
      bearerTokenFile: path.join(root, "unused-llm-secret"),
      timeoutMs: 1_000,
      maximumResponseBytes: 100_000
    },
    workflowPolicy: workflowPolicy(),
    admissionLimits: {
      dailyRunsPerSubject: 2,
      uniqueDoctors30dPerSubject: 2,
      globalActiveRuns: 2,
      needsInputPerSubject: 2
    },
    store: {
      idempotencyReplaySeconds: 604_800,
      idempotencyTombstoneSeconds: 2_592_000,
      resultTtlSeconds: 2_592_000,
      runRetentionSeconds: 7_776_000,
      needsInputTtlSeconds: 259_200,
      maximumCheckpointBytes: 1_000_000,
      maximumResultBytes: 4_000_000
    }
  };
}

async function waitFor(
  condition: () => boolean,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for Research Worker runtime.");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function temporaryDirectory(): string {
  const directory = mkdtempSync(
    path.join(tmpdir(), "codex-research-worker-e2e-")
  );
  cleanupDirectories.push(directory);
  return directory;
}
