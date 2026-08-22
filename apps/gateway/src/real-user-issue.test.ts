import { describe, expect, it } from "vitest";
import {
  defaultExternalUserId,
  publicKeyPrefix,
  publicRealUserIssueJob,
  redactIssueMessage,
  RealUserIssueJobStore,
  runRealUserIssueJob,
  type CreatedSubject,
  type CurrentCredential,
  type RealUserIssueInput,
  type RealUserIssueRunnerDeps,
  type ResolvedUnifiedKey
} from "./real-user-issue.js";

const publicBaseUrl = "https://goldencode.example.com:1443";
const subjectId = "subj_test_0001";
const opaqueKey = "cgu_live_abcdefghijklmnopqrstuvwxyz";
const codexStoredPrefix = "p-abcdef123456";
const codexPublicPrefix = `cgw.${codexStoredPrefix}`;
const codexApiKey = `${codexPublicPrefix}.runtime-key-value`;

function issueInput(overrides: Partial<RealUserIssueInput> = {}): RealUserIssueInput {
  const expiry = new Date("2026-11-20T00:00:00Z");
  return {
    name: "张三",
    phone: "13800138000",
    externalUserId: "phone_13800138000",
    provider: "manual_trial",
    planId: "plan_internal_high_quota_image_v1",
    scope: "code",
    rate: { requestsPerMinute: 10, requestsPerDay: 200, concurrentRequests: 4 },
    entitlementEnd: expiry,
    keyExpiresAt: expiry,
    requireImageCapability: true,
    ...overrides
  };
}

interface DepCalls {
  disabled: { subjectId: string; reason: string }[];
  subjectMetadata: { subjectId: string; label: string; name: string; phoneNumber: string }[];
  credentials: { prefix: string; label: string; rpm: number }[];
}

function buildDeps(
  overrides: Partial<RealUserIssueRunnerDeps> = {}
): { deps: RealUserIssueRunnerDeps; calls: DepCalls } {
  const calls: DepCalls = { disabled: [], subjectMetadata: [], credentials: [] };
  const deps: RealUserIssueRunnerDeps = {
    publicBaseUrl,
    now: () => new Date("2026-08-20T00:00:00Z"),
    async createSubject(): Promise<CreatedSubject> {
      return { subjectId, opaqueKey, created: true, idempotentReplay: false };
    },
    async grantEntitlement() {
      return { applied: true, entitlementState: "active" };
    },
    async resolveUnifiedKey(): Promise<ResolvedUnifiedKey> {
      return {
        valid: true,
        subjectId,
        codexApiKey,
        codexKeyPrefix: codexPublicPrefix,
        medevidenceApiKey: "mev2_live_runtime",
        medevidencePrefix: "mev2_live_pre",
        endpointBaseUrl: `${publicBaseUrl}/v1`,
        credentialValidationUrl: `${publicBaseUrl}/gateway/credentials/current`
      };
    },
    updateSubjectMetadata(id, input) {
      calls.subjectMetadata.push({ subjectId: id, ...input });
    },
    updateCredential(prefix, input) {
      calls.credentials.push({ prefix, label: input.label, rpm: input.rate.requestsPerMinute });
    },
    async currentCredential(): Promise<CurrentCredential> {
      return {
        valid: true,
        subjectId,
        entitlementState: "active",
        capabilities: ["chat", "tools", "image_generation"]
      };
    },
    async disableSubject(id, reason) {
      calls.disabled.push({ subjectId: id, reason });
    },
    ...overrides
  };
  return { deps, calls };
}

async function runJob(
  store: RealUserIssueJobStore,
  deps: RealUserIssueRunnerDeps,
  input = issueInput()
): Promise<string> {
  const job = store.create({
    externalUserId: input.externalUserId,
    displayName: input.name,
    phone: input.phone,
    actorTokenPrefix: "bat_test_abcdefgh"
  });
  await runRealUserIssueJob(store, job.id, deps, input);
  return job.id;
}

describe("real user issuance job", () => {
  it("completes every step and exposes the key once", async () => {
    const store = new RealUserIssueJobStore();
    const { deps, calls } = buildDeps();

    const jobId = await runJob(store, deps);
    const job = store.get(jobId);

    expect(job?.state).toBe("succeeded");
    expect(job?.steps.map((step) => step.state)).toEqual(["ok", "ok", "ok", "ok", "ok"]);
    expect(job?.result?.subjectId).toBe(subjectId);
    expect(job?.result?.capabilities).toContain("image_generation");
    expect(job?.result?.keyPrefix).toBe(publicKeyPrefix(opaqueKey));
    expect(job?.unifiedKey).toBe(opaqueKey);
    expect(calls.disabled).toHaveLength(0);

    // Contact metadata and the capped rate must both be written.
    expect(calls.subjectMetadata).toEqual([
      { subjectId, label: "张三", name: "张三", phoneNumber: "13800138000" }
    ]);
    expect(calls.credentials[0]?.rpm).toBe(10);
    expect(calls.credentials[0]?.prefix).toBe(codexStoredPrefix);
    expect(job?.result?.codexGatewayPrefix).toBe(codexPublicPrefix);
  });

  it("hides the full key from other admin tokens", async () => {
    const store = new RealUserIssueJobStore();
    const { deps } = buildDeps();
    const jobId = await runJob(store, deps);
    const job = store.get(jobId)!;

    expect(publicRealUserIssueJob(job, { includeKey: true }).unified_key).toBe(opaqueKey);
    expect(publicRealUserIssueJob(job, { includeKey: false }).unified_key).toBeUndefined();
    expect(publicRealUserIssueJob(job, { includeKey: false }).key_available).toBe(true);
  });

  it("drops the full key once the reveal window closes", async () => {
    let clock = new Date("2026-08-20T00:00:00Z");
    const store = new RealUserIssueJobStore({ keyTtlMs: 60_000, now: () => clock });
    const { deps } = buildDeps();
    const jobId = await runJob(store, deps);

    expect(store.get(jobId)?.unifiedKey).toBe(opaqueKey);
    clock = new Date("2026-08-20T00:02:00Z");
    expect(store.get(jobId)?.unifiedKey).toBeNull();
    expect(store.get(jobId)?.result?.subjectId).toBe(subjectId);
  });

  it("rejects a second concurrent issuance for the same phone", () => {
    const store = new RealUserIssueJobStore();
    const create = () =>
      store.create({
        externalUserId: "phone_13800138000",
        displayName: "张三",
        phone: "13800138000",
        actorTokenPrefix: null
      });
    create();
    expect(create).toThrowError(/already running/i);
  });

  it("fails and disables the subject when the entitlement does not activate", async () => {
    const store = new RealUserIssueJobStore();
    const { deps, calls } = buildDeps({
      async grantEntitlement() {
        return { applied: true, entitlementState: "pending" };
      }
    });

    const jobId = await runJob(store, deps);
    const job = store.get(jobId);

    expect(job?.state).toBe("failed");
    expect(job?.error?.code).toBe("entitlement_not_active");
    expect(job?.steps[1]?.state).toBe("failed");
    expect(job?.steps[2]?.state).toBe("pending");
    expect(job?.unifiedKey).toBeNull();
    expect(calls.disabled).toEqual([
      { subjectId, reason: "real_user_issue_failed:entitlement_not_active" }
    ]);
  });

  it("fails when resolve returns a different subject", async () => {
    const store = new RealUserIssueJobStore();
    const { deps } = buildDeps({
      async resolveUnifiedKey() {
        return {
          valid: true,
          subjectId: "subj_other",
          codexApiKey,
          codexKeyPrefix: codexPublicPrefix,
          medevidenceApiKey: "mev2_live_runtime",
          medevidencePrefix: "mev2_live_pre",
          endpointBaseUrl: `${publicBaseUrl}/v1`,
          credentialValidationUrl: `${publicBaseUrl}/gateway/credentials/current`
        };
      }
    });

    const jobId = await runJob(store, deps);
    expect(store.get(jobId)?.error?.code).toBe("resolve_failed");
  });

  it("fails when the plan does not deliver the required image capability", async () => {
    const store = new RealUserIssueJobStore();
    const { deps } = buildDeps({
      async currentCredential() {
        return { valid: true, subjectId, entitlementState: "active", capabilities: ["chat", "tools"] };
      }
    });

    const jobId = await runJob(store, deps);
    expect(store.get(jobId)?.error?.code).toBe("missing_image_capability");
  });

  it("succeeds without image capability when the plan does not grant it", async () => {
    const store = new RealUserIssueJobStore();
    const { deps } = buildDeps({
      async currentCredential() {
        return { valid: true, subjectId, entitlementState: "active", capabilities: ["chat", "tools"] };
      }
    });

    const jobId = await runJob(store, deps, issueInput({ requireImageCapability: false }));
    const job = store.get(jobId);
    expect(job?.state).toBe("succeeded");
    expect(job?.result?.imageGeneration).toBe(false);
  });

  it("refuses an idempotent replay that cannot return the key", async () => {
    const store = new RealUserIssueJobStore();
    const { deps, calls } = buildDeps({
      async createSubject() {
        return { subjectId, opaqueKey: null, created: false, idempotentReplay: true };
      }
    });

    const jobId = await runJob(store, deps);
    const job = store.get(jobId);
    expect(job?.error?.code).toBe("idempotent_replay_without_key");
    // The subject was not created by this run, so it must not be disabled.
    expect(calls.disabled).toHaveLength(0);
  });

  it("rejects a resolve response pointing at an unexpected endpoint", async () => {
    const store = new RealUserIssueJobStore();
    const { deps } = buildDeps({
      async resolveUnifiedKey() {
        return {
          valid: true,
          subjectId,
          codexApiKey,
          codexKeyPrefix: codexPublicPrefix,
          medevidenceApiKey: "mev2_live_runtime",
          medevidencePrefix: "mev2_live_pre",
          endpointBaseUrl: "https://gw.instmarket.com.au/v1",
          credentialValidationUrl: `${publicBaseUrl}/gateway/credentials/current`
        };
      }
    });

    const jobId = await runJob(store, deps);
    expect(store.get(jobId)?.error?.code).toBe("unexpected_endpoint");
  });

  it("keeps credential-shaped values out of stored failure messages", () => {
    const message = redactIssueMessage(
      `failed for cgu_live_secretvalue and cgw.runtimesecret and mev2_live_x1 and bat_test_abc.def`
    );
    expect(message).not.toContain("secretvalue");
    expect(message).not.toContain("runtimesecret");
    expect(message).toContain("cgu_live_<redacted>");
    expect(message).toContain("bat_test_<redacted>");
  });

  it("derives a stable external user id from the phone number", () => {
    expect(defaultExternalUserId("138 0013-8000")).toBe("phone_13800138000");
  });
});
