import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  GatewayError,
  issueAccessCredential,
  type ProviderAdapter
} from "@codex-gateway/core";
import type { DoctorResearchResult } from "@codex-gateway/research-agent";
import {
  createResearchSqliteStore,
  createSqliteStore,
  type ResearchSqliteStore,
  type SqliteGatewayStore
} from "@codex-gateway/store-sqlite";
import { buildGateway } from "./index.js";
import { parseDoctorResearchRunRequest } from "./research-routes.js";

const provider: ProviderAdapter = {
  kind: "research-route-test",
  async health() {
    return {
      state: "healthy",
      checkedAt: new Date("2026-07-17T00:00:00Z")
    };
  },
  async *message() {
    yield { type: "completed" };
  }
};

const cleanupDirectories: string[] = [];
const researchLlmReadinessQuery =
  "?maximum_prompt_tokens_per_call=180000" +
  "&maximum_output_tokens_per_call=12000" +
  "&calls_per_run=5" +
  "&concurrent_calls=3" +
  "&maximum_tokens_per_run=576000";

afterEach(() => {
  for (const directory of cleanupDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Doctor Research control-plane routes", () => {
  it("fails startup when Research is enabled without its separate database path", async () => {
    await withTemporaryEnv(
      {
        RESEARCH_API_ENABLED: "true",
        RESEARCH_DB_PATH: undefined
      },
      async () => {
        const gateway = createSqliteStore({ path: ":memory:" });
        try {
          expect(() =>
            buildGateway({
              provider,
              sessionStore: gateway,
              logger: false
            })
          ).toThrow(
            "RESEARCH_DB_PATH is required when Research API is enabled."
          );
        } finally {
          gateway.close();
        }
      }
    );
  });

  it("rejects an in-memory production database and database path reuse", async () => {
    await withTemporaryEnv(
      {
        NODE_ENV: "production",
        RESEARCH_API_ENABLED: "true",
        RESEARCH_DB_PATH: ":memory:"
      },
      async () => {
        const gateway = createSqliteStore({ path: ":memory:" });
        try {
          expect(() =>
            buildGateway({
              authMode: "credential",
              provider,
              sessionStore: gateway,
              logger: false
            })
          ).toThrow("RESEARCH_DB_PATH cannot be :memory: in production.");
        } finally {
          gateway.close();
        }
      }
    );
    const sharedDatabase = path.join(
      temporaryArtifactDirectory(),
      "shared.db"
    );
    await withTemporaryEnv(
      {
        NODE_ENV: "test",
        RESEARCH_API_ENABLED: "true",
        RESEARCH_DB_PATH: sharedDatabase,
        GATEWAY_SQLITE_PATH: sharedDatabase
      },
      async () => {
        const gateway = createSqliteStore({ path: ":memory:" });
        try {
          expect(() =>
            buildGateway({
              provider,
              sessionStore: gateway,
              logger: false
            })
          ).toThrow("RESEARCH_DB_PATH must not reuse GATEWAY_SQLITE_PATH.");
        } finally {
          gateway.close();
        }
      }
    );
  });

  it("assembles the Research store and refuses admission until a Worker is ready", async () => {
    await withTemporaryEnv(
      {
        RESEARCH_API_ENABLED: "true",
        RESEARCH_DB_PATH: ":memory:",
        RESEARCH_ARTIFACT_ROOT: ".research-test-artifacts",
        RESEARCH_WEB_SEARCH_PROVIDER: "brave",
        RESEARCH_OFFICIAL_WEB_ALLOWED_DOMAINS: "hospital.example",
        RESEARCH_ACCEPT_WHEN_WORKER_UNAVAILABLE: "false",
        RESEARCH_CONTROL_READ_RPM: "20",
        RESEARCH_CONTROL_MUTATION_RPM: "10",
        RESEARCH_MAX_DAILY_RUNS_PER_SUBJECT: "10",
        RESEARCH_MAX_UNIQUE_DOCTORS_PER_SUBJECT_30D: "10",
        RESEARCH_MAX_QUEUED_RUNS: "100",
        RESEARCH_MAX_NEEDS_INPUT_PER_SUBJECT: "10",
        RESEARCH_MAX_CHECKPOINT_BYTES: "1048576",
        RESEARCH_MAX_RESULT_BYTES: "4194304",
        RESEARCH_MAX_ARTIFACT_BYTES: "1048576",
        RESEARCH_HEARTBEAT_STALE_SECONDS: "45",
        RESEARCH_MAX_STORAGE_BYTES: "1073741824",
        RESEARCH_MIN_FREE_BYTES: "1",
        RESEARCH_MIN_FREE_PERCENT: "1",
        RESEARCH_BACKUP_MAX_AGE_SECONDS: "3600",
        RESEARCH_IDEMPOTENCY_REPLAY_SECONDS: "604800",
        RESEARCH_IDEMPOTENCY_TOMBSTONE_SECONDS: "2592000",
        RESEARCH_RESULT_TTL_SECONDS: "2592000",
        RESEARCH_RUN_RETENTION_SECONDS: "7776000",
        RESEARCH_NEEDS_INPUT_TTL_SECONDS: "259200"
      },
      async () => {
        const gateway = createSqliteStore({ path: ":memory:" });
        const issued = addSubject(gateway, "subj_env_research");
        gateway.createPlan({
          id: "plan_env_research_v1",
          displayName: "Environment Research",
          policy: unrestrictedTokenPolicy(),
          featurePolicy: {
            capabilities: ["chat", "doctor_research"],
            imageGeneration: null,
            medcodeModels: null
          },
          scopeAllowlist: ["code"],
          now: new Date("2026-07-17T00:00:00Z")
        });
        gateway.grantEntitlement({
          subjectId: "subj_env_research",
          planId: "plan_env_research_v1",
          periodKind: "unlimited",
          now: new Date("2026-07-17T00:00:00Z")
        });
        const app = buildGateway({
          authMode: "credential",
          provider,
          sessionStore: gateway,
          now: () => new Date("2026-07-17T01:30:00Z"),
          logger: false
        });
        const response = await app.inject({
          method: "POST",
          url: "/gateway/research/v1/doctor-runs",
          headers: {
            authorization: `Bearer ${issued.token}`,
            "idempotency-key": "research:env-assembled"
          },
          payload: validRequest("Environment Doctor")
        });

        expect(response.statusCode).toBe(503);
        expect(response.json().error.code).toBe(
          "research_worker_unavailable"
        );
        await app.close();
      }
    );
  });

  it("uses the Research auth envelope before route handlers", async () => {
    const fixture = createFixture({ capability: true });
    const response = await fixture.app.inject({
      method: "POST",
      url: "/gateway/research/v1/doctor-runs",
      payload: validRequest("Doctor One")
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      schema_version: "doctor_research_error.v1",
      error: {
        code: "missing_credential",
        message: "Missing access credential."
      }
    });
    await fixture.app.close();
  });

  it("uses the Research envelope for unmatched Research paths", async () => {
    const fixture = createFixture({ capability: true });
    const unauthenticated = await fixture.app.inject({
      method: "GET",
      url: "/gateway/research/v1/not-a-route"
    });
    const authenticated = await fixture.app.inject({
      method: "GET",
      url: "/gateway/research/v1/not-a-route",
      headers: { authorization: `Bearer ${fixture.token}` }
    });

    expect(unauthenticated.statusCode).toBe(401);
    expect(unauthenticated.json()).toMatchObject({
      schema_version: "doctor_research_error.v1",
      error: { code: "missing_credential" }
    });
    expect(authenticated.statusCode).toBe(404);
    expect(authenticated.json()).toMatchObject({
      schema_version: "doctor_research_error.v1",
      error: { code: "run_not_found" }
    });
    await fixture.app.close();
  });

  it("preflights the Worker LLM credential, exact model, and entitlement without generating", async () => {
    const fixture = createFixture({
      capability: true,
      allowedPublicModels: ["medcode"],
      featureCapabilities: ["chat"],
      boundedServicePolicy: true
    });
    const response = await fixture.app.inject({
      method: "GET",
      url:
        "/gateway/research/v1/worker/llm-readiness/medcode" +
        researchLlmReadinessQuery,
      headers: { authorization: `Bearer ${fixture.token}` }
    });
    const missing = await fixture.app.inject({
      method: "GET",
      url:
        "/gateway/research/v1/worker/llm-readiness/not-a-model" +
        researchLlmReadinessQuery,
      headers: { authorization: `Bearer ${fixture.token}` }
    });
    const missingRequirements = await fixture.app.inject({
      method: "GET",
      url: "/gateway/research/v1/worker/llm-readiness/medcode",
      headers: { authorization: `Bearer ${fixture.token}` }
    });
    const insufficientPolicy = await fixture.app.inject({
      method: "GET",
      url:
        "/gateway/research/v1/worker/llm-readiness/medcode" +
        "?maximum_prompt_tokens_per_call=200000" +
        "&maximum_output_tokens_per_call=50000" +
        "&calls_per_run=3" +
        "&maximum_tokens_per_run=250000",
      headers: { authorization: `Bearer ${fixture.token}` }
    });
    const overContext = await fixture.app.inject({
      method: "GET",
      url:
        "/gateway/research/v1/worker/llm-readiness/medcode" +
        "?maximum_prompt_tokens_per_call=400000" +
        "&maximum_output_tokens_per_call=12000" +
        "&calls_per_run=3" +
        "&maximum_tokens_per_run=412000",
      headers: { authorization: `Bearer ${fixture.token}` }
    });
    const overCallBound = await fixture.app.inject({
      method: "GET",
      url:
        "/gateway/research/v1/worker/llm-readiness/medcode" +
        "?maximum_prompt_tokens_per_call=180000" +
        "&maximum_output_tokens_per_call=12000" +
        "&calls_per_run=6" +
        "&maximum_tokens_per_run=576000",
      headers: { authorization: `Bearer ${fixture.token}` }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      schema_version: "research_llm_readiness.v1",
      model: "medcode",
      authorized: true
    });
    expect(missing.statusCode).toBe(404);
    expect(missingRequirements.statusCode).toBe(400);
    expect(insufficientPolicy.statusCode).toBe(403);
    expect(insufficientPolicy.json().error.code).toBe(
      "plan_capability_required"
    );
    expect(overContext.statusCode).toBe(400);
    expect(overContext.json().error.code).toBe("context_length_exceeded");
    expect(overCallBound.statusCode).toBe(400);
    expect(overCallBound.json().error.code).toBe("invalid_request");
    await fixture.app.close();

    const overbroad = createFixture({
      capability: true,
      allowedPublicModels: ["medcode", "max"],
      featureCapabilities: ["chat"],
      boundedServicePolicy: true
    });
    const rejected = await overbroad.app.inject({
      method: "GET",
      url:
        "/gateway/research/v1/worker/llm-readiness/medcode" +
        researchLlmReadinessQuery,
      headers: { authorization: `Bearer ${overbroad.token}` }
    });
    expect(rejected.statusCode).toBe(403);
    expect(rejected.json().error.code).toBe(
      "model_not_allowed_for_credential"
    );
    await overbroad.app.close();

    const overcapable = createFixture({
      capability: true,
      allowedPublicModels: ["medcode"],
      featureCapabilities: ["chat", "doctor_research"],
      boundedServicePolicy: true
    });
    const capabilityRejected = await overcapable.app.inject({
      method: "GET",
      url:
        "/gateway/research/v1/worker/llm-readiness/medcode" +
        researchLlmReadinessQuery,
      headers: { authorization: `Bearer ${overcapable.token}` }
    });
    expect(capabilityRejected.statusCode).toBe(403);
    expect(capabilityRejected.json().error.code).toBe(
      "plan_capability_required"
    );
    await overcapable.app.close();

    const unbounded = createFixture({
      capability: true,
      allowedPublicModels: ["medcode"],
      featureCapabilities: ["chat"]
    });
    const policyRejected = await unbounded.app.inject({
      method: "GET",
      url:
        "/gateway/research/v1/worker/llm-readiness/medcode" +
        researchLlmReadinessQuery,
      headers: { authorization: `Bearer ${unbounded.token}` }
    });
    expect(policyRejected.statusCode).toBe(403);
    expect(policyRejected.json().error.code).toBe(
      "plan_capability_required"
    );
    await unbounded.app.close();
  });

  it("fails closed before admission when no healthy Worker is available", async () => {
    const fixture = createFixture({
      capability: true,
      acceptWhenWorkerUnavailable: false
    });
    const response = await fixture.app.inject({
      method: "POST",
      url: "/gateway/research/v1/doctor-runs",
      headers: {
        authorization: `Bearer ${fixture.token}`,
        "idempotency-key": "research:no-worker"
      },
      payload: validRequest("Doctor No Worker")
    });

    expect(response.statusCode).toBe(503);
    expect(response.headers["retry-after"]).toBe("15");
    expect(response.json()).toMatchObject({
      schema_version: "doctor_research_error.v1",
      error: {
        code: "research_worker_unavailable",
        retry_after_seconds: 15
      }
    });
    expect(
      fixture.research.database
        .prepare("SELECT COUNT(*) AS count FROM research_runs")
        .get()
    ).toEqual({ count: 0 });
    const parsed = parseDoctorResearchRunRequest(
      validRequest("Doctor Awaiting Selection")
    );
    const seeded = fixture.research.createRun({
      subjectId: "subj_research",
      credentialId: null,
      requestId: "req_seed_no_worker",
      idempotencyKey: "research:seed-no-worker",
      requestHash: parsed.requestHash,
      identityFingerprint: parsed.identityFingerprint,
      input: parsed.input,
      now: new Date("2026-07-17T01:30:00Z")
    });
    if (seeded.outcome !== "created") {
      throw new Error("Expected a seeded Research run.");
    }
    const lease = fixture.research.acquireLease({
      workerId: "worker-that-stopped",
      leaseSeconds: 120,
      now: new Date("2026-07-17T01:30:00Z")
    });
    if (!lease) {
      throw new Error("Expected a seeded Research lease.");
    }
    fixture.research.pauseForIdentity({
      token: lease.token,
      candidates: routeIdentityCandidates(),
      now: new Date("2026-07-17T01:30:01Z")
    });
    const resume = await fixture.app.inject({
      method: "POST",
      url:
        `/gateway/research/v1/doctor-runs/${seeded.run.runId}` +
        "/identity-selection",
      headers: {
        authorization: `Bearer ${fixture.token}`,
        "idempotency-key": "research:resume-no-worker"
      },
      payload: {
        candidate_id: routeIdentityCandidates()[0]!.candidateId
      }
    });
    expect(resume.statusCode).toBe(503);
    expect(resume.json().error.code).toBe("research_worker_unavailable");
    expect(
      fixture.research.getRunForSubject(
        seeded.run.runId,
        "subj_research"
      )?.status
    ).toBe("needs_input");
    await fixture.app.close();
  });

  it("runs the storage and backup admission guard before creating a run", async () => {
    const fixture = createFixture({
      capability: true,
      admissionGuard: async () =>
        new GatewayError({
          code: "research_storage_unavailable",
          message: "Research storage is unavailable.",
          httpStatus: 503,
          retryAfterSeconds: 60
        })
    });
    const response = await fixture.app.inject({
      method: "POST",
      url: "/gateway/research/v1/doctor-runs",
      headers: {
        authorization: `Bearer ${fixture.token}`,
        "idempotency-key": "research:storage-guard"
      },
      payload: validRequest("Doctor Storage Guard")
    });

    expect(response.statusCode).toBe(503);
    expect(response.headers["retry-after"]).toBe("60");
    expect(response.json().error.code).toBe("research_storage_unavailable");
    expect(
      fixture.research.database
        .prepare("SELECT COUNT(*) AS count FROM research_runs")
        .get()
    ).toEqual({ count: 0 });
    await fixture.app.close();
  });

  it("replays and rejects conflicting create keys before a later admission outage", async () => {
    let admissionUnavailable = false;
    const fixture = createFixture({
      capability: true,
      admissionGuard: async () =>
        admissionUnavailable
          ? new GatewayError({
              code: "research_storage_unavailable",
              message: "Research storage is unavailable.",
              httpStatus: 503
            })
          : null
    });
    const headers = {
      authorization: `Bearer ${fixture.token}`,
      "idempotency-key": "research:replay-during-outage"
    };
    const payload = validRequest("Doctor Replay During Outage");
    const created = await fixture.app.inject({
      method: "POST",
      url: "/gateway/research/v1/doctor-runs",
      headers,
      payload
    });
    admissionUnavailable = true;
    const replayed = await fixture.app.inject({
      method: "POST",
      url: "/gateway/research/v1/doctor-runs",
      headers,
      payload
    });
    const conflict = await fixture.app.inject({
      method: "POST",
      url: "/gateway/research/v1/doctor-runs",
      headers,
      payload: validRequest("Different Doctor During Outage")
    });
    const newRequest = await fixture.app.inject({
      method: "POST",
      url: "/gateway/research/v1/doctor-runs",
      headers: {
        ...headers,
        "idempotency-key": "research:new-during-outage"
      },
      payload: validRequest("New Doctor During Outage")
    });

    expect(created.statusCode).toBe(202);
    expect(replayed.statusCode).toBe(202);
    expect(replayed.json()).toEqual(created.json());
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe("idempotency_conflict");
    expect(newRequest.statusCode).toBe(503);
    expect(
      fixture.research.database
        .prepare("SELECT COUNT(*) AS count FROM research_runs")
        .get()
    ).toEqual({ count: 1 });
    await fixture.app.close();
  });

  it("requires an entitlement capability and does not accept it from the body", async () => {
    const fixture = createFixture({ capability: false });
    const response = await fixture.app.inject({
      method: "POST",
      url: "/gateway/research/v1/doctor-runs",
      headers: {
        authorization: `Bearer ${fixture.token}`,
        "idempotency-key": "research:no-capability"
      },
      payload: {
        ...validRequest("Doctor One"),
        doctor_research: true
      }
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      schema_version: "doctor_research_error.v1",
      error: {
        code: "research_capability_required"
      }
    });
    expect(
      fixture.research.database
        .prepare("SELECT COUNT(*) AS count FROM research_runs")
        .get()
    ).toEqual({ count: 0 });
    await fixture.app.close();
  });

  it("applies the control limiter before capability checks", async () => {
    const fixture = createFixture({
      capability: false,
      mutationRpm: 1
    });
    const request = (key: string) =>
      fixture.app.inject({
        method: "POST",
        url: "/gateway/research/v1/doctor-runs",
        headers: {
          authorization: `Bearer ${fixture.token}`,
          "idempotency-key": key
        },
        payload: validRequest("Doctor Capability Probe")
      });
    const first = await request("research:capability-probe-1");
    const second = await request("research:capability-probe-2");

    expect(first.statusCode).toBe(403);
    expect(second.statusCode).toBe(429);
    expect(second.headers["x-gateway-limit-kind"]).toBe(
      "research_control_mutation_minute"
    );
    expect(
      fixture.research.database
        .prepare("SELECT COUNT(*) AS count FROM research_runs")
        .get()
    ).toEqual({ count: 0 });
    await fixture.app.close();
  });

  it("shares the subject control bucket across different credentials", async () => {
    const fixture = createFixture({
      capability: true,
      readRpm: 1,
      secondCredentialSameSubject: true
    });
    const first = await fixture.app.inject({
      method: "GET",
      url: "/gateway/research/v1/doctor-runs",
      headers: { authorization: `Bearer ${fixture.token}` }
    });
    const second = await fixture.app.inject({
      method: "GET",
      url: "/gateway/research/v1/doctor-runs",
      headers: {
        authorization: `Bearer ${fixture.secondCredentialToken}`
      }
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(429);
    expect(second.headers["x-gateway-limit-kind"]).toBe(
      "research_control_read_minute"
    );
    await fixture.app.close();
  });

  it("creates, replays, lists, and retrieves a subject-owned run", async () => {
    const fixture = createFixture({ capability: true });
    const headers = {
      authorization: `Bearer ${fixture.token}`,
      "idempotency-key": "research:create-one"
    };
    const payload = validRequest("Ma\u0301");
    const created = await fixture.app.inject({
      method: "POST",
      url: "/gateway/research/v1/doctor-runs",
      headers,
      payload
    });
    const replayed = await fixture.app.inject({
      method: "POST",
      url: "/gateway/research/v1/doctor-runs",
      headers,
      payload
    });
    const conflict = await fixture.app.inject({
      method: "POST",
      url: "/gateway/research/v1/doctor-runs",
      headers,
      payload: validRequest("Different Doctor")
    });
    const runId = created.json().run_id as string;
    const listed = await fixture.app.inject({
      method: "GET",
      url: "/gateway/research/v1/doctor-runs?limit=20&status=queued",
      headers: { authorization: `Bearer ${fixture.token}` }
    });
    const fetched = await fixture.app.inject({
      method: "GET",
      url: `/gateway/research/v1/doctor-runs/${runId}`,
      headers: { authorization: `Bearer ${fixture.token}` }
    });
    const current = await fixture.app.inject({
      method: "GET",
      url: "/gateway/credentials/current",
      headers: { authorization: `Bearer ${fixture.token}` }
    });

    expect(created.statusCode).toBe(202);
    expect(created.json()).toMatchObject({
      schema_version: "doctor_research_run.v1",
      run_id: expect.stringMatching(/^drr_[a-f0-9]{32}$/),
      status: "queued",
      stage: "validate_input",
      mode: "brief",
      skill: {
        name: "doctor-research-query",
        version: "1.6.23"
      }
    });
    expect(replayed.statusCode).toBe(202);
    expect(replayed.json().run_id).toBe(runId);
    expect(replayed.json()).toEqual(created.json());
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe("idempotency_conflict");
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({
      schema_version: "doctor_research_run_list.v1",
      items: [
        {
          run_id: runId,
          status: "queued",
          doctor: {
            name: "Má",
            hospital: "Example Hospital",
            department: "Cardiology"
          }
        }
      ],
      next_cursor: null
    });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json()).toMatchObject({
      run_id: runId,
      progress: {
        completed_stages: 0,
        total_stages: 15,
        percent: 0
      }
    });
    expect(fetched.json()).not.toHaveProperty("statistics");
    expect(current.json().entitlement.feature_policy.capabilities).toEqual([
      "chat",
      "tools",
      "doctor_research"
    ]);
    expect(
      fixture.research.getRunForSubject(runId, "subj_research")?.input.doctor
        .name
    ).toBe("Má");
    await fixture.app.close();
  });

  it("cancels a subject-owned run with exact replay and Research errors", async () => {
    const fixture = createFixture({ capability: true, secondSubject: true });
    const created = await fixture.app.inject({
      method: "POST",
      url: "/gateway/research/v1/doctor-runs",
      headers: {
        authorization: `Bearer ${fixture.token}`,
        "idempotency-key": "research:create-for-cancel"
      },
      payload: validRequest("Doctor Cancel")
    });
    const runId = created.json().run_id as string;
    const cancelHeaders = {
      authorization: `Bearer ${fixture.token}`,
      "idempotency-key": "research:cancel-one"
    };
    const cancelled = await fixture.app.inject({
      method: "POST",
      url: `/gateway/research/v1/doctor-runs/${runId}/cancel`,
      headers: cancelHeaders
    });
    const replayed = await fixture.app.inject({
      method: "POST",
      url: `/gateway/research/v1/doctor-runs/${runId}/cancel`,
      headers: cancelHeaders
    });
    const fetched = await fixture.app.inject({
      method: "GET",
      url: `/gateway/research/v1/doctor-runs/${runId}`,
      headers: { authorization: `Bearer ${fixture.token}` }
    });
    const hidden = await fixture.app.inject({
      method: "POST",
      url: `/gateway/research/v1/doctor-runs/${runId}/cancel`,
      headers: {
        authorization: `Bearer ${fixture.secondToken}`,
        "idempotency-key": "research:cancel-other-subject"
      }
    });
    const invalidBody = await fixture.app.inject({
      method: "POST",
      url: `/gateway/research/v1/doctor-runs/${runId}/cancel`,
      headers: {
        authorization: `Bearer ${fixture.token}`,
        "idempotency-key": "research:cancel-invalid-body"
      },
      payload: { reason: "arbitrary user text is not accepted" }
    });

    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json()).toMatchObject({
      schema_version: "doctor_research_run.v1",
      run_id: runId,
      status: "cancelled",
      cancel_requested: false,
      terminal_reason: "cancelled_by_user"
    });
    expect(replayed.statusCode).toBe(200);
    expect(replayed.json()).toEqual(cancelled.json());
    expect(fetched.json()).toMatchObject({
      status: "cancelled",
      terminal_reason: "cancelled_by_user"
    });
    expect(hidden.statusCode).toBe(404);
    expect(hidden.json().error.code).toBe("run_not_found");
    expect(invalidBody.statusCode).toBe(400);
    expect(invalidBody.json().error.code).toBe("invalid_request");
    await fixture.app.close();
  });

  it("returns frozen identity candidates and resumes through an idempotent selection", async () => {
    const fixture = createFixture({ capability: true, secondSubject: true });
    const created = await fixture.app.inject({
      method: "POST",
      url: "/gateway/research/v1/doctor-runs",
      headers: {
        authorization: `Bearer ${fixture.token}`,
        "idempotency-key": "research:create-identity"
      },
      payload: validRequest("Common Doctor")
    });
    const runId = created.json().run_id as string;
    const lease = fixture.research.acquireLease({
      workerId: "worker-route-identity",
      leaseSeconds: 120,
      now: new Date("2026-07-17T01:30:00Z")
    });
    if (!lease) {
      throw new Error("Expected a Research lease.");
    }
    fixture.research.pauseForIdentity({
      token: lease.token,
      candidates: routeIdentityCandidates(),
      now: new Date("2026-07-17T01:30:00Z")
    });

    const status = await fixture.app.inject({
      method: "GET",
      url: `/gateway/research/v1/doctor-runs/${runId}`,
      headers: { authorization: `Bearer ${fixture.token}` }
    });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({
      status: "needs_input",
      stage: "resolve_identity",
      needs_input_expires_at: "2026-07-20T01:30:00.000Z",
      input_required: {
        type: "identity_selection",
        candidates: [
          {
            candidate_id: `dc_${"1".repeat(16)}`,
            hospital: "Example Hospital",
            department: "Cardiology"
          },
          {
            candidate_id: `dc_${"2".repeat(16)}`,
            hospital: "Second Hospital",
            department: "Neurology"
          }
        ]
      }
    });
    expect(JSON.stringify(status.json())).not.toContain(
      "canonicalIdentityId"
    );
    expect(JSON.stringify(status.json())).not.toContain("score");

    const selectionHeaders = {
      authorization: `Bearer ${fixture.token}`,
      "idempotency-key": "research:select-identity"
    };
    const selectionPayload = {
      candidate_id: `dc_${"1".repeat(16)}`
    };
    const selected = await fixture.app.inject({
      method: "POST",
      url: `/gateway/research/v1/doctor-runs/${runId}/identity-selection`,
      headers: selectionHeaders,
      payload: selectionPayload
    });
    const replayed = await fixture.app.inject({
      method: "POST",
      url: `/gateway/research/v1/doctor-runs/${runId}/identity-selection`,
      headers: selectionHeaders,
      payload: selectionPayload
    });
    const unexpected = await fixture.app.inject({
      method: "POST",
      url: `/gateway/research/v1/doctor-runs/${runId}/identity-selection`,
      headers: {
        authorization: `Bearer ${fixture.token}`,
        "idempotency-key": "research:select-identity-again"
      },
      payload: selectionPayload
    });
    const hidden = await fixture.app.inject({
      method: "POST",
      url: `/gateway/research/v1/doctor-runs/${runId}/identity-selection`,
      headers: {
        authorization: `Bearer ${fixture.secondToken}`,
        "idempotency-key": "research:select-identity-other"
      },
      payload: selectionPayload
    });

    expect(selected.statusCode).toBe(200);
    expect(selected.json()).toMatchObject({
      schema_version: "doctor_research_run.v1",
      run_id: runId,
      status: "queued",
      stage: "collect_profile_evidence",
      canonical_identity_id: "dci_route001"
    });
    expect(replayed.json()).toEqual(selected.json());
    expect(unexpected.statusCode).toBe(409);
    expect(unexpected.json().error.code).toBe(
      "identity_selection_not_expected"
    );
    expect(hidden.statusCode).toBe(404);
    expect(hidden.json().error.code).toBe("run_not_found");
    await fixture.app.close();
  });

  it("returns quota metadata without creating a partial second run", async () => {
    const fixture = createFixture({ capability: true });
    const auth = { authorization: `Bearer ${fixture.token}` };
    const first = await fixture.app.inject({
      method: "POST",
      url: "/gateway/research/v1/doctor-runs",
      headers: {
        ...auth,
        "idempotency-key": "research:first"
      },
      payload: validRequest("Doctor One")
    });
    const second = await fixture.app.inject({
      method: "POST",
      url: "/gateway/research/v1/doctor-runs",
      headers: {
        ...auth,
        "idempotency-key": "research:second"
      },
      payload: validRequest("Doctor Two")
    });

    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(429);
    expect(second.headers["retry-after"]).toBe("30");
    expect(second.headers["x-gateway-limit-kind"]).toBe(
      "research_active_brief"
    );
    expect(second.json()).toMatchObject({
      schema_version: "doctor_research_error.v1",
      error: {
        code: "rate_limited",
        research_code: "research_quota_exceeded",
        rate_limit_contract_version: 1,
        limit_kind: "research_active_brief",
        rate_limit_origin: "gateway",
        retry_after_seconds: 30
      }
    });
    expect(
      fixture.research.database
        .prepare("SELECT COUNT(*) AS count FROM research_runs")
        .get()
    ).toEqual({ count: 1 });
    expect(
      fixture.research.database
        .prepare("SELECT COUNT(*) AS count FROM research_idempotency_keys")
        .get()
    ).toEqual({ count: 1 });
    expect(
      fixture.research.database
        .prepare(
          `SELECT action, outcome, params_json
           FROM research_audit_events
           WHERE action = 'admission_quota'`
        )
        .get()
    ).toMatchObject({
      action: "admission_quota",
      outcome: "rejected",
      params_json: expect.stringContaining("research_active_brief")
    });
    await fixture.app.close();
  });

  it("rate limits Research reads and mutations before Store transactions with dedicated limit kinds", async () => {
    const fixture = createFixture({
      capability: true,
      readRpm: 1,
      mutationRpm: 1
    });
    const auth = { authorization: `Bearer ${fixture.token}` };
    const created = await fixture.app.inject({
      method: "POST",
      url: "/gateway/research/v1/doctor-runs",
      headers: {
        ...auth,
        "idempotency-key": "research:control-first"
      },
      payload: validRequest("Doctor Control One")
    });
    const rejectedMutation = await fixture.app.inject({
      method: "POST",
      url: "/gateway/research/v1/doctor-runs",
      headers: {
        ...auth,
        "idempotency-key": "research:control-second"
      },
      payload: validRequest("Doctor Control Two")
    });
    const firstRead = await fixture.app.inject({
      method: "GET",
      url: "/gateway/research/v1/doctor-runs",
      headers: auth
    });
    const rejectedRead = await fixture.app.inject({
      method: "GET",
      url: "/gateway/research/v1/doctor-runs",
      headers: auth
    });

    expect(created.statusCode).toBe(202);
    expect(rejectedMutation.statusCode).toBe(429);
    expect(rejectedMutation.headers["x-gateway-limit-kind"]).toBe(
      "research_control_mutation_minute"
    );
    expect(rejectedMutation.json().error).toMatchObject({
      code: "rate_limited",
      research_code: "research_quota_exceeded",
      limit_kind: "research_control_mutation_minute"
    });
    expect(firstRead.statusCode).toBe(200);
    expect(rejectedRead.statusCode).toBe(429);
    expect(rejectedRead.headers["x-gateway-limit-kind"]).toBe(
      "research_control_read_minute"
    );
    expect(
      fixture.research.database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM research_audit_events
           WHERE action = 'admission_quota'`
        )
        .get()
    ).toEqual({ count: 0 });
    expect(
      fixture.research.database
        .prepare("SELECT COUNT(*) AS count FROM research_idempotency_keys")
        .get()
    ).toEqual({ count: 1 });
    await fixture.app.close();
  });

  it("serves a subject-owned successful result and rejects incomplete results", async () => {
    const fixture = createFixture({ capability: true });
    const auth = { authorization: `Bearer ${fixture.token}` };
    const created = await fixture.app.inject({
      method: "POST",
      url: "/gateway/research/v1/doctor-runs",
      headers: {
        ...auth,
        "idempotency-key": "research:create-result"
      },
      payload: validRequest("Doctor Result")
    });
    const runId = created.json().run_id as string;
    const resultUrl = created.json().result_url as string;
    const incomplete = await fixture.app.inject({
      method: "GET",
      url: resultUrl,
      headers: auth
    });
    const lease = fixture.research.acquireLease({
      workerId: "worker-route-result",
      leaseSeconds: 120,
      now: new Date("2026-07-17T01:30:00Z")
    });
    if (!lease) {
      throw new Error("Expected a Research lease.");
    }
    const completedAt = new Date("2026-07-17T01:30:30Z");
    const artifacts = routeCommitArtifacts(runId);
    expect(
      fixture.research.completeSuccessfulRun({
        token: lease.token,
        resultSchemaVersion: "doctor_research_result.v1",
        result: routeSuccessfulResult(runId, completedAt, artifacts),
        artifacts,
        now: completedAt
      })
    ).toMatchObject({ outcome: "succeeded" });
    const completed = await fixture.app.inject({
      method: "GET",
      url: resultUrl,
      headers: auth
    });

    expect(incomplete.statusCode).toBe(409);
    expect(incomplete.json().error.code).toBe("run_not_complete");
    expect(completed.statusCode).toBe(200);
    expect(completed.json()).toMatchObject({
      schema_version: "doctor_research_result.v1",
      request_id: expect.stringMatching(/^req-/),
      run_id: runId,
      doctor: { name: "Doctor Result" }
    });
    await fixture.app.close();
  });

  it("downloads only subject-owned, unexpired artifacts with verified bytes", async () => {
    const artifactRoot = temporaryArtifactDirectory();
    const fixture = createFixture({
      capability: true,
      secondSubject: true,
      artifactRoot
    });
    const auth = { authorization: `Bearer ${fixture.token}` };
    const created = await fixture.app.inject({
      method: "POST",
      url: "/gateway/research/v1/doctor-runs",
      headers: {
        ...auth,
        "idempotency-key": "research:create-download"
      },
      payload: validRequest("Doctor Download")
    });
    const runId = created.json().run_id as string;
    const lease = fixture.research.acquireLease({
      workerId: "worker-route-download",
      leaseSeconds: 120,
      now: new Date("2026-07-17T01:30:00Z")
    });
    if (!lease) {
      throw new Error("Expected a Research lease.");
    }
    const artifacts = materializeRouteArtifacts(artifactRoot, runId);
    const completedAt = new Date("2026-07-17T01:30:30Z");
    expect(
      fixture.research.completeSuccessfulRun({
        token: lease.token,
        resultSchemaVersion: "doctor_research_result.v1",
        result: routeSuccessfulResult(runId, completedAt, artifacts),
        artifacts,
        now: completedAt
      })
    ).toMatchObject({ outcome: "succeeded" });
    const artifact = artifacts[0]!;
    const url =
      `/gateway/research/v1/artifacts/${artifact.artifactId}/download`;

    const downloaded = await fixture.app.inject({
      method: "GET",
      url,
      headers: auth
    });
    const hidden = await fixture.app.inject({
      method: "GET",
      url,
      headers: {
        authorization: `Bearer ${fixture.secondToken}`
      }
    });
    fixture.research.database
      .prepare(
        `UPDATE research_artifacts
         SET expires_at = '2026-07-17T01:29:59.000Z'
         WHERE artifact_id = ?`
      )
      .run(artifact.artifactId);
    const expired = await fixture.app.inject({
      method: "GET",
      url,
      headers: auth
    });

    expect(downloaded.statusCode).toBe(200);
    expect(downloaded.rawPayload).toEqual(Buffer.from("profile123"));
    expect(downloaded.headers["content-type"]).toBe(
      "text/markdown; charset=utf-8"
    );
    expect(downloaded.headers["cache-control"]).toBe("private, no-store");
    expect(downloaded.headers["content-disposition"]).toContain(
      "filename*=UTF-8''"
    );
    expect(hidden.statusCode).toBe(404);
    expect(hidden.json().error.code).toBe("artifact_not_found");
    expect(expired.statusCode).toBe(410);
    expect(expired.json().error.code).toBe("artifact_expired");
    await fixture.app.close();
  });

  it("hides another subject's run as not found", async () => {
    const fixture = createFixture({ capability: true, secondSubject: true });
    const created = await fixture.app.inject({
      method: "POST",
      url: "/gateway/research/v1/doctor-runs",
      headers: {
        authorization: `Bearer ${fixture.token}`,
        "idempotency-key": "research:owned"
      },
      payload: validRequest("Doctor One")
    });
    const response = await fixture.app.inject({
      method: "GET",
      url: `/gateway/research/v1/doctor-runs/${created.json().run_id}`,
      headers: {
        authorization: `Bearer ${fixture.secondToken}`
      }
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      schema_version: "doctor_research_error.v1",
      error: {
        code: "run_not_found"
      }
    });
    await fixture.app.close();
  });

  it("uses subject-scoped keyset cursors without duplicates", async () => {
    const fixture = createFixture({ capability: true });
    const auth = { authorization: `Bearer ${fixture.token}` };
    const runIds: string[] = [];
    for (const index of [1, 2, 3]) {
      const created = await fixture.app.inject({
        method: "POST",
        url: "/gateway/research/v1/doctor-runs",
        headers: {
          ...auth,
          "idempotency-key": `research:page-${index}`
        },
        payload: validRequest(`Doctor ${index}`)
      });
      expect(created.statusCode).toBe(202);
      const runId = created.json().run_id as string;
      runIds.push(runId);
      fixture.research.database
        .prepare(
          `UPDATE research_runs
           SET status = 'cancelled',
               completed_at = ?,
               expires_at = ?,
               purge_after = ?
           WHERE run_id = ?`
        )
        .run(
          "2026-07-17T01:30:00.000Z",
          "2026-08-16T01:30:00.000Z",
          "2026-10-15T01:30:00.000Z",
          runId
        );
    }

    const firstPage = await fixture.app.inject({
      method: "GET",
      url: "/gateway/research/v1/doctor-runs?limit=2",
      headers: auth
    });
    const cursor = firstPage.json().next_cursor as string;
    const secondPage = await fixture.app.inject({
      method: "GET",
      url: `/gateway/research/v1/doctor-runs?limit=2&cursor=${encodeURIComponent(
        cursor
      )}`,
      headers: auth
    });
    const pagedIds = [
      ...firstPage.json().items,
      ...secondPage.json().items
    ].map((item: { run_id: string }) => item.run_id);

    expect(firstPage.statusCode).toBe(200);
    expect(firstPage.json().items).toHaveLength(2);
    expect(cursor).toEqual(expect.any(String));
    expect(secondPage.statusCode).toBe(200);
    expect(secondPage.json().items).toHaveLength(1);
    expect(secondPage.json().next_cursor).toBeNull();
    expect(new Set(pagedIds)).toEqual(new Set(runIds));
    expect(pagedIds).toHaveLength(3);
    await fixture.app.close();
  });

  it("fails closed for delayed logical TTL reconciliation", async () => {
    const fixture = createFixture({ capability: true });
    const auth = { authorization: `Bearer ${fixture.token}` };
    const created = await fixture.app.inject({
      method: "POST",
      url: "/gateway/research/v1/doctor-runs",
      headers: {
        ...auth,
        "idempotency-key": "research:logical-ttl"
      },
      payload: validRequest("Doctor TTL")
    });
    const runId = created.json().run_id as string;
    fixture.research.database
      .prepare(
        `UPDATE research_runs
         SET status = 'needs_input',
             needs_input_started_at = '2026-07-16T22:00:00.000Z',
             needs_input_expires_at = '2026-07-17T01:00:00.000Z'
         WHERE run_id = ?`
      )
      .run(runId);

    const point = await fixture.app.inject({
      method: "GET",
      url: `/gateway/research/v1/doctor-runs/${runId}`,
      headers: auth
    });
    const cancelled = await fixture.app.inject({
      method: "GET",
      url: "/gateway/research/v1/doctor-runs?status=cancelled",
      headers: auth
    });
    const needsInput = await fixture.app.inject({
      method: "GET",
      url: "/gateway/research/v1/doctor-runs?status=needs_input",
      headers: auth
    });
    const timeoutCancel = await fixture.app.inject({
      method: "POST",
      url: `/gateway/research/v1/doctor-runs/${runId}/cancel`,
      headers: {
        ...auth,
        "idempotency-key": "research:cancel-logically-expired-needs-input"
      }
    });

    expect(point.statusCode).toBe(200);
    expect(point.json()).toMatchObject({
      status: "cancelled",
      terminal_reason: "identity_selection_timeout",
      terminal_detail_public: "Identity selection timed out."
    });
    expect(cancelled.json().items).toEqual([
      expect.objectContaining({ run_id: runId, status: "cancelled" })
    ]);
    expect(needsInput.json().items).toEqual([]);
    expect(timeoutCancel.statusCode).toBe(200);
    expect(timeoutCancel.json()).toMatchObject({
      status: "cancelled",
      cancel_requested: false,
      terminal_reason: "identity_selection_timeout"
    });
    expect(
      fixture.research.getRunForSubject(runId, "subj_research")
    ).toMatchObject({
      status: "cancelled",
      terminalReason: "identity_selection_timeout",
      cancelRequestedAt: null
    });
    expect(
      (
        fixture.research.database
          .prepare(
            `SELECT COUNT(*) AS count
             FROM research_audit_events
             WHERE run_id = ?
               AND action = 'ttl_needs_input_timeout'`
          )
          .get(runId) as { count: number }
      ).count
    ).toBe(1);

    fixture.research.database
      .prepare(
        `UPDATE research_runs
         SET status = 'failed',
             terminal_reason = 'quality_gate_failed',
             terminal_detail_public = 'Research quality gates did not pass.',
             completed_at = '2026-06-17T01:00:00.000Z',
             expires_at = '2026-07-17T01:00:00.000Z',
             purge_after = '2026-09-15T01:00:00.000Z'
         WHERE run_id = ?`
      )
      .run(runId);
    const expiredPoint = await fixture.app.inject({
      method: "GET",
      url: `/gateway/research/v1/doctor-runs/${runId}`,
      headers: auth
    });
    const expiredList = await fixture.app.inject({
      method: "GET",
      url: "/gateway/research/v1/doctor-runs?status=expired",
      headers: auth
    });
    const failedList = await fixture.app.inject({
      method: "GET",
      url: "/gateway/research/v1/doctor-runs?status=failed",
      headers: auth
    });

    expect(expiredPoint.statusCode).toBe(410);
    expect(expiredPoint.json()).toMatchObject({
      schema_version: "doctor_research_error.v1",
      error: { code: "run_expired" }
    });
    expect(expiredList.json().items).toEqual([
      expect.objectContaining({ run_id: runId, status: "expired" })
    ]);
    expect(failedList.json().items).toEqual([]);
    await fixture.app.close();
  });

  it("rejects unsafe request fields and invalid cursors", async () => {
    const fixture = createFixture({ capability: true });
    const auth = { authorization: `Bearer ${fixture.token}` };
    const unsafe = await fixture.app.inject({
      method: "POST",
      url: "/gateway/research/v1/doctor-runs",
      headers: {
        ...auth,
        "idempotency-key": "research:unsafe"
      },
      payload: {
        ...validRequest("Doctor One"),
        model: "max"
      }
    });
    const missingKey = await fixture.app.inject({
      method: "POST",
      url: "/gateway/research/v1/doctor-runs",
      headers: auth,
      payload: validRequest("Doctor One")
    });
    const cursor = await fixture.app.inject({
      method: "GET",
      url: "/gateway/research/v1/doctor-runs?cursor=not-a-cursor",
      headers: auth
    });
    const forgedLongLivedCursor = Buffer.from(
      JSON.stringify({
        v: 1,
        status: null,
        created_at: "2026-07-17T01:00:00.000Z",
        run_id: `drr_${"a".repeat(32)}`,
        expires_at: "2030-01-01T00:00:00.000Z"
      })
    ).toString("base64url");
    const longLivedCursor = await fixture.app.inject({
      method: "GET",
      url:
        "/gateway/research/v1/doctor-runs?cursor=" +
        forgedLongLivedCursor,
      headers: auth
    });
    const weakIdentity = await fixture.app.inject({
      method: "POST",
      url: "/gateway/research/v1/doctor-runs",
      headers: {
        ...auth,
        "idempotency-key": "research:weak-identity"
      },
      payload: {
        ...validRequest("Doctor With Weak Identity"),
        doctor: {
          name: "Doctor With Weak Identity",
          hospital: "Example Hospital",
          department: null,
          title: null,
          city: "Sydney",
          orcid: null
        }
      }
    });
    const oversizedIdentitySearch = await fixture.app.inject({
      method: "POST",
      url: "/gateway/research/v1/doctor-runs",
      headers: {
        ...auth,
        "idempotency-key": "research:oversized-identity-search"
      },
      payload: {
        ...validRequest("Doctor With Oversized Anchors"),
        doctor: {
          name: "Doctor With Oversized Anchors",
          hospital: "H".repeat(190),
          department: "D".repeat(190),
          title: null,
          city: null,
          orcid: null
        }
      }
    });

    expect(unsafe.statusCode).toBe(400);
    expect(unsafe.json().error.code).toBe("invalid_request");
    expect(missingKey.statusCode).toBe(400);
    expect(missingKey.json().error.code).toBe("invalid_request");
    expect(cursor.statusCode).toBe(400);
    expect(cursor.json().error.code).toBe("invalid_request");
    expect(longLivedCursor.statusCode).toBe(400);
    expect(longLivedCursor.json().error.code).toBe("invalid_request");
    expect(weakIdentity.statusCode).toBe(400);
    expect(weakIdentity.json()).toMatchObject({
      error: {
        code: "invalid_request",
        message: expect.stringContaining("both hospital and department")
      }
    });
    expect(oversizedIdentitySearch.statusCode).toBe(400);
    expect(oversizedIdentitySearch.json()).toMatchObject({
      error: {
        code: "invalid_request",
        message: expect.stringContaining("too long")
      }
    });
    expect(() =>
      parseDoctorResearchRunRequest(validRequest("A\ud800"))
    ).toThrow("doctor.name is invalid");
    const identityA = parseDoctorResearchRunRequest({
      ...validRequest("Example  Doctor"),
      doctor: {
        ...validRequest("Example Doctor").doctor,
        name: "Example  Doctor",
        hospital: "EXAMPLE HOSPITAL",
        title: "Professor",
        city: "Sydney"
      }
    });
    const identityB = parseDoctorResearchRunRequest({
      ...validRequest("example doctor"),
      doctor: {
        ...validRequest("example doctor").doctor,
        name: "example doctor",
        hospital: "example hospital",
        title: null,
        city: null
      }
    });
    expect(identityA.identityFingerprint).toBe(
      identityB.identityFingerprint
    );
    await fixture.app.close();
  });

  it("admits direct official profile URLs only from the configured HTTPS allowlist", () => {
    const request = validRequest("Guang Ning");
    request.doctor.official_profile_urls = [
      "https://www.shsmu.edu.cn/english/info/1354/4134.htm"
    ];
    const parsed = parseDoctorResearchRunRequest(request, {
      officialSourceMode: "direct",
      officialWebAllowedDomains: ["shsmu.edu.cn"]
    });
    expect(parsed.input.doctor.officialProfileUrls).toEqual([
      "https://www.shsmu.edu.cn/english/info/1354/4134.htm"
    ]);

    expect(() =>
      parseDoctorResearchRunRequest(validRequest("Guang Ning"), {
        officialSourceMode: "direct",
        officialWebAllowedDomains: ["shsmu.edu.cn"]
      })
    ).toThrow("requires at least one allowlisted");

    const blocked = validRequest("Guang Ning");
    blocked.doctor.official_profile_urls = [
      "https://unapproved.example/profile"
    ];
    expect(() =>
      parseDoctorResearchRunRequest(blocked, {
        officialSourceMode: "direct",
        officialWebAllowedDomains: ["shsmu.edu.cn"]
      })
    ).toThrow("not allowed");

    const unsafe = validRequest("Guang Ning");
    unsafe.doctor.official_profile_urls = [
      "https://www.shsmu.edu.cn/profile#fragment"
    ];
    expect(() =>
      parseDoctorResearchRunRequest(unsafe, {
        officialSourceMode: "direct",
        officialWebAllowedDomains: ["shsmu.edu.cn"]
      })
    ).toThrow("not allowed");
  });

  it("accepts only a complete, bounded literature identity", () => {
    const request = validRequest("陆清声");
    request.doctor.literature_identity = {
      name: "Lu Qingsheng",
      hospital: "Changhai Hospital",
      department: "Vascular Surgery"
    };
    const parsed = parseDoctorResearchRunRequest(request);
    expect(parsed.input.doctor.literatureIdentity).toEqual({
      name: "Lu Qingsheng",
      hospital: "Changhai Hospital",
      department: "Vascular Surgery"
    });

    const partial = validRequest("陆清声");
    partial.doctor.literature_identity = {
      name: "Lu Qingsheng"
    } as typeof partial.doctor.literature_identity;
    expect(() => parseDoctorResearchRunRequest(partial)).toThrow(
      "requires only name, hospital, and department"
    );

    const unexpected = validRequest("陆清声");
    unexpected.doctor.literature_identity = {
      name: "Lu Qingsheng",
      hospital: "Changhai Hospital",
      department: "Vascular Surgery",
      query: "Lu Q"
    } as typeof unexpected.doctor.literature_identity;
    expect(() => parseDoctorResearchRunRequest(unexpected)).toThrow(
      "Invalid Doctor Research request"
    );
  });
});

function createFixture(input: {
  capability: boolean;
  secondSubject?: boolean;
  secondCredentialSameSubject?: boolean;
  readRpm?: number;
  mutationRpm?: number;
  acceptWhenWorkerUnavailable?: boolean;
  artifactRoot?: string;
  admissionGuard?: (
    now: Date
  ) => Promise<GatewayError | null>;
  allowedPublicModels?: string[];
  featureCapabilities?: string[];
  boundedServicePolicy?: boolean;
}): {
  app: ReturnType<typeof buildGateway>;
  gateway: SqliteGatewayStore;
  research: ResearchSqliteStore;
  token: string;
  secondToken?: string;
  secondCredentialToken?: string;
} {
  const gateway = createSqliteStore({ path: ":memory:" });
  const research = createResearchSqliteStore({
    path: ":memory:",
    limits: {
      dailyRunsPerSubject: 10,
      uniqueDoctors30dPerSubject: 10,
      globalActiveRuns: 100,
      needsInputPerSubject: 10
    }
  });
  const issued = addSubject(
    gateway,
    "subj_research",
    input.allowedPublicModels,
    input.boundedServicePolicy
  );
  gateway.createPlan({
    id: "plan_research_fixture_v1",
    displayName: "Research fixture",
    policy: input.boundedServicePolicy
      ? boundedServiceTokenPolicy()
      : unrestrictedTokenPolicy(),
    featurePolicy: {
      capabilities: input.capability
        ? input.featureCapabilities ??
          ["chat", "tools", "doctor_research"]
        : input.featureCapabilities ?? ["chat", "tools"],
      imageGeneration: null,
      medcodeModels: null
    },
    scopeAllowlist: ["code"],
    now: new Date("2026-07-17T00:00:00Z")
  });
  gateway.grantEntitlement({
    subjectId: "subj_research",
    planId: "plan_research_fixture_v1",
    periodKind: "unlimited",
    now: new Date("2026-07-17T00:00:00Z")
  });

  let secondToken: string | undefined;
  if (input.secondSubject) {
    const second = addSubject(gateway, "subj_second");
    secondToken = second.token;
    gateway.grantEntitlement({
      subjectId: "subj_second",
      planId: "plan_research_fixture_v1",
      periodKind: "unlimited",
      now: new Date("2026-07-17T00:00:00Z")
    });
  }
  let secondCredentialToken: string | undefined;
  if (input.secondCredentialSameSubject) {
    const secondCredential = issueAccessCredential({
      subjectId: "subj_research",
      label: "subj_research second credential",
      scope: "code",
      expiresAt: new Date("2030-01-01T00:00:00Z"),
      now: new Date("2026-07-17T00:00:00Z")
    });
    gateway.insertAccessCredential(secondCredential.record);
    secondCredentialToken = secondCredential.token;
  }
  const app = buildGateway({
    authMode: "credential",
    provider,
    sessionStore: gateway,
    researchStore: research,
    researchAcceptWhenWorkerUnavailable:
      input.acceptWhenWorkerUnavailable ?? true,
    researchAdmissionGuard: input.admissionGuard,
    ...(input.artifactRoot
      ? {
          researchArtifactRoot: input.artifactRoot,
          researchMaximumArtifactBytes: 1_000_000
        }
      : {}),
    ...(input.readRpm
      ? {
          researchReadRatePolicy: {
            requestsPerMinute: input.readRpm,
            requestsPerDay: null,
            concurrentRequests: null
          }
        }
      : {}),
    ...(input.mutationRpm
      ? {
          researchMutationRatePolicy: {
            requestsPerMinute: input.mutationRpm,
            requestsPerDay: null,
            concurrentRequests: null
          }
        }
      : {}),
    now: () => new Date("2026-07-17T01:30:00Z"),
    logger: false
  });
  return {
    app,
    gateway,
    research,
    token: issued.token,
    ...(secondToken ? { secondToken } : {}),
    ...(secondCredentialToken
      ? { secondCredentialToken }
      : {})
  };
}

function routeCommitArtifacts(runId: string) {
  return ([
    ["1", "profile", "text/markdown; charset=utf-8"],
    ["2", "review", "text/markdown; charset=utf-8"],
    ["3", "questions", "text/plain; charset=utf-8"],
    ["4", "answers", "text/markdown; charset=utf-8"]
  ] as const).map(([suffix, kind, contentType]) => {
    const artifactId = `dra_${suffix.repeat(32)}`;
    return {
      artifactId,
      kind,
      filenameAscii: `${kind}.txt`,
      filenameUtf8: `${kind}.txt`,
      contentType,
      storageRelativePath: `${runId}/${artifactId}.v1`,
      storageVersion: 1,
      sha256: suffix.repeat(64),
      sizeBytes: 10
    };
  });
}

function materializeRouteArtifacts(root: string, runId: string) {
  const contents = {
    profile: Buffer.from("profile123"),
    review: Buffer.from("review1234"),
    questions: Buffer.from("questions?"),
    answers: Buffer.from("answers123")
  } as const;
  const runDirectory = path.join(root, runId);
  mkdirSync(runDirectory, { recursive: true });
  return (
    [
      ["1", "profile", "text/markdown; charset=utf-8"],
      ["2", "review", "text/markdown; charset=utf-8"],
      ["3", "questions", "text/plain; charset=utf-8"],
      ["4", "answers", "text/markdown; charset=utf-8"]
    ] as const
  ).map(([suffix, kind, contentType]) => {
    const artifactId = `dra_${suffix.repeat(32)}`;
    const storageRelativePath = `${runId}/${artifactId}.v1`;
    const bytes = contents[kind];
    writeFileSync(path.join(root, ...storageRelativePath.split("/")), bytes);
    return {
      artifactId,
      kind,
      filenameAscii: `${kind}.txt`,
      filenameUtf8: `${kind}-研究.txt`,
      contentType,
      storageRelativePath,
      storageVersion: 1,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      sizeBytes: bytes.length
    };
  });
}

function temporaryArtifactDirectory(): string {
  const directory = mkdtempSync(
    path.join(tmpdir(), "codex-research-route-artifacts-")
  );
  cleanupDirectories.push(directory);
  return directory;
}

function routeSuccessfulResult(
  runId: string,
  completedAt: Date,
  artifacts: ReturnType<typeof routeCommitArtifacts>
): DoctorResearchResult {
  const expiresAt = new Date(
    completedAt.getTime() + 30 * 24 * 60 * 60 * 1_000
  ).toISOString();
  return {
    schema_version: "doctor_research_result.v1",
    request_id: "req_route_result",
    run_id: runId,
    doctor: {
      name: "Doctor Result",
      hospital: "Example Hospital",
      department: "Cardiology"
    },
    identity_resolution: {
      status: "verified",
      confidence: "high",
      canonical_identity_id: "dci_example01",
      matched_by: ["institution", "department"]
    },
    sources: [
      {
        source_id: "src_official_1",
        source_type: "official_web",
        title: "Example Hospital Profile",
        url: "https://example.org/doctor",
        accessed_at: "2026-07-17T01:00:00.000Z",
        content_sha256: "a".repeat(64)
      },
      {
        source_id: "src_pubmed_1",
        source_type: "pubmed",
        title: "Example Publication",
        url: "https://pubmed.ncbi.nlm.nih.gov/1001/",
        accessed_at: "2026-07-17T01:00:00.000Z",
        content_sha256: "b".repeat(64)
      }
    ],
    profile: {
      positions: ["Consultant"],
      expertise: ["Evidence synthesis"],
      education_and_career: [],
      research_directions: ["Clinical evidence"],
      representative_outputs: ["Example Publication"],
      claims: [
        {
          claim_id: "clm_position_1",
          claim_type: "position",
          text: "Doctor Result is a consultant.",
          source_ids: ["src_official_1"],
          verification_status: "verified"
        }
      ],
      primary_public_source_ids: ["src_official_1"]
    },
    review: {
      title: "Example Evidence Review",
      abstract: "A validated example review.",
      keywords: ["evidence"],
      markdown: "Validated evidence [1].",
      core_evidence: [
        {
          reference_id: "ref_example",
          study_type: "cohort",
          sample_and_source: "Example cohort",
          methods: "Validated method",
          key_results: "Validated result",
          limitations: "Example fixture"
        }
      ],
      references: [
        {
          reference_id: "ref_example",
          title: "Example Publication",
          journal: "Example Journal",
          publication_year: 2025,
          pmid: "1001",
          doi: null,
          verification_status: "verified"
        }
      ],
      search_report: {
        databases: ["pubmed"],
        searched_at: "2026-07-17T01:00:00.000Z",
        queries: ["example query"],
        included_count: 1
      }
    },
    source_coverage: {
      literature_sources: ["pubmed"],
      profile_sources: ["official_web"],
      cutoff_date: "2026-07-17",
      warnings: []
    },
    predicted_questions: [
      "Question one?",
      "Question two?",
      "Question three?",
      "Question four?",
      "Question five?"
    ],
    answers: [1, 2, 3, 4, 5].map((questionIndex) => ({
      question_index: questionIndex,
      answer: `Answer ${questionIndex}.`,
      source_ids: ["src_pubmed_1"]
    })),
    quality: {
      status: "passed",
      checks: ["schema"],
      warnings: []
    },
    artifacts: artifacts.map((artifact) => ({
      artifact_id: artifact.artifactId,
      kind: artifact.kind,
      filename: artifact.filenameUtf8,
      content_type: artifact.contentType,
      size_bytes: artifact.sizeBytes,
      sha256: artifact.sha256,
      expires_at: expiresAt,
      download_url:
        `/gateway/research/v1/artifacts/${artifact.artifactId}/download`
    }))
  };
}

async function withTemporaryEnv(
  values: Record<string, string | undefined>,
  run: () => Promise<void>
): Promise<void> {
  const previous = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(values)) {
    previous.set(name, process.env[name]);
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  try {
    await run();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
}

function addSubject(
  store: SqliteGatewayStore,
  subjectId: string,
  allowedPublicModels?: string[],
  boundedServicePolicy = false
) {
  const issued = issueAccessCredential({
    subjectId,
    label: `${subjectId} credential`,
    scope: "code",
    expiresAt: new Date("2030-01-01T00:00:00Z"),
    now: new Date("2026-07-17T00:00:00Z"),
    ...(allowedPublicModels
      ? {
          allowedPublicModels,
          knownPublicModelIds: ["medcode", "max"]
        }
      : {}),
    ...(boundedServicePolicy
      ? {
          rate: {
            requestsPerMinute: 5,
            requestsPerDay: 100,
            concurrentRequests: 3
          }
        }
      : {})
  });
  store.upsertSubject({
    id: subjectId,
    label: subjectId,
    state: "active",
    createdAt: new Date("2026-07-17T00:00:00Z")
  });
  store.insertAccessCredential(issued.record);
  return issued;
}

function validRequest(name: string) {
  return {
    doctor: {
      name,
      hospital: "Example Hospital",
      department: "Cardiology",
      title: null,
      city: "Sydney",
      orcid: null,
      official_profile_urls: undefined as string[] | undefined,
      literature_identity: undefined as
        | {
            name: string;
            hospital: string;
            department: string;
          }
        | undefined
    },
    mode: "brief",
    language: "en",
    options: {
      publication_years: 5,
      citation_style: "vancouver"
    },
    client_reference: "client-reference"
  };
}

function routeIdentityCandidates() {
  return [
    {
      candidateId: `dc_${"1".repeat(16)}`,
      canonicalIdentityId: "dci_route001",
      name: "Common Doctor",
      hospital: "Example Hospital",
      department: "Cardiology",
      city: "Sydney",
      sources: [
        {
          title: "Example Hospital Profile",
          url: "https://example.org/doctors/route-1"
        }
      ],
      evidenceTypes: ["institution", "department"] as const,
      score: 0.9
    },
    {
      candidateId: `dc_${"2".repeat(16)}`,
      canonicalIdentityId: "dci_route002",
      name: "Common Doctor",
      hospital: "Second Hospital",
      department: "Neurology",
      city: "Melbourne",
      sources: [
        {
          title: "Second Hospital Profile",
          url: "https://example.org/doctors/route-2"
        }
      ],
      evidenceTypes: ["institution", "research_topic"] as const,
      score: 0.8
    }
  ];
}

function unrestrictedTokenPolicy() {
  return {
    tokensPerMinute: null,
    tokensPerDay: null,
    tokensPerMonth: null,
    maxPromptTokensPerRequest: null,
    maxTotalTokensPerRequest: null,
    reserveTokensPerRequest: 0,
    missingUsageCharge: "none" as const
  };
}

function boundedServiceTokenPolicy() {
  return {
    tokensPerMinute: 700_000,
    tokensPerDay: 5_000_000,
    tokensPerMonth: 20_000_000,
    maxPromptTokensPerRequest: 180_000,
    maxTotalTokensPerRequest: 192_000,
    reserveTokensPerRequest: 12_000,
    missingUsageCharge: "reserve" as const
  };
}
